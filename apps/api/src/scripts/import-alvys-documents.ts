/**
 * Migrate historical Alvys documents to FleetCal.
 *
 * For every FleetCal load with imported_source='alvys', pull its
 * Alvys documents (`GET /loads/{alvysId}/documents`), download each
 * blob via the pre-signed Azure URL, upload to the matching Supabase
 * Storage bucket, and insert a `load_documents` row. Rate cons
 * additionally mirror to `loads.rate_con_pdf` so the dashboard's
 * Rate Con panel and the AI parser find them.
 *
 * Type mapping (Alvys → FleetCal `load_documents.kind`):
 *   "Customer Rate and Load Confirmation" → "rate_con"  (→ rate-cons bucket)
 *   "Invoice"                              → "invoice"
 *   "Bill of Lading" / "BOL"               → "bol"
 *   "Proof of Delivery" / "POD"            → "pod"
 *   "Scale" / "Scale Ticket"               → "scale"
 *   anything else                          → "other"
 *
 * Idempotency: storage_path is deterministic — `{orgId}/{loadId}/
 * alvys-{alvysDocId}.{ext}`. The UNIQUE constraint on
 * load_documents.storage_path + Supabase Storage's existence check
 * mean re-runs cheaply skip already-imported docs.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/import-alvys-documents.ts \
 *     --org=org_3Cgzom31hVxbq6WR3FjVTbL6K3t
 *   ... add --apply to actually upload + insert ...
 *
 * Optional flags:
 *   --skip-invoices       Don't import Invoice PDFs (saves ~50% storage)
 *   --concurrency=N       Parallel loads (default 4; doc download is heavy)
 *   --max-bytes=N         Stop after uploading N bytes (sanity cap)
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const APPLY            = process.argv.includes("--apply");
const SKIP_INVOICES    = process.argv.includes("--skip-invoices");
const ORG              = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const CONCURRENCY      = Number(process.argv.find(a => a.startsWith("--concurrency="))?.slice("--concurrency=".length) ?? "4");
const MAX_BYTES        = Number(process.argv.find(a => a.startsWith("--max-bytes="))?.slice("--max-bytes=".length) ?? Infinity);
if (!ORG) { console.error("Missing --org=ORG_ID"); process.exit(1); }

const FC_URL = process.env.SUPABASE_URL ?? "";
const FC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!FC_URL || !FC_KEY) { console.error("Missing SUPABASE_URL / SERVICE_ROLE_KEY"); process.exit(1); }

const ALVYS_AUTH_URL = "https://auth.alvys.com/oauth/token";
const ALVYS_API_BASE = "https://integrations.alvys.com/api/p/v1.0";
const ALVYS_AUDIENCE = "https://api.alvys.com/public/";
const ALVYS_CLIENT_ID     = process.env.ALVYS_CLIENT_ID ?? "";
const ALVYS_CLIENT_SECRET = process.env.ALVYS_CLIENT_SECRET ?? "";
if (!ALVYS_CLIENT_ID || !ALVYS_CLIENT_SECRET) { console.error("Missing ALVYS_CLIENT_ID / SECRET"); process.exit(1); }

const RATE_CON_BUCKET = "rate-cons";
const DOC_BUCKET      = "load-documents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(FC_URL, FC_KEY, { auth: { persistSession: false } });

function log(...xs: unknown[]): void { console.log(...xs); }

// ── Alvys token ─────────────────────────────────────────────────────
interface AlvysToken { token: string; expiresAt: number }
let cachedToken: AlvysToken | null = null;
async function alvysToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(ALVYS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: ALVYS_CLIENT_ID, client_secret: ALVYS_CLIENT_SECRET,
      audience: ALVYS_AUDIENCE,
    }),
  });
  if (!res.ok) throw new Error(`Alvys auth failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.token;
}

interface AlvysDoc {
  id?: string;
  AttachmentPath?: string;
  AttachmentType?: string;
  AttachmentSize?: number;
  UploadedAt?: string;
  ParentId?: string;
  DownloadUrl?: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Global throttle for /loads/{id}/documents calls. Cloudflare in front
 * of Alvys gates this endpoint hard — naive 4× parallel calls trip the
 * "Bot Detection" challenge after ~200 requests, returning an HTML
 * page instead of JSON. We serialize through a token-bucket-ish gate
 * with a minimum gap between requests, and back off on 4xx/5xx /
 * non-JSON responses.
 */
const REQUEST_GAP_MS = 250;
let nextSlot = 0;
async function throttledFetchDocs(token: string, alvysLoadId: string, attempt = 0): Promise<AlvysDoc[]> {
  const wait = nextSlot - Date.now();
  nextSlot = Math.max(Date.now(), nextSlot) + REQUEST_GAP_MS;
  if (wait > 0) await sleep(wait);

  const res = await fetch(`${ALVYS_API_BASE}/loads/${alvysLoadId}/documents`, {
    headers: { Authorization: `Bearer ${token}`, "Accept": "application/json" },
  });
  if (res.status === 404 || res.status === 405) return [];

  const text = await res.text();
  // Cloudflare challenge or other HTML → retry with backoff.
  if (!res.ok || text.trimStart().startsWith("<")) {
    if (attempt >= 5) throw new Error(`docs fetch giving up after ${attempt} retries (last status ${res.status})`);
    const backoff = Math.min(60_000, 1000 * Math.pow(2, attempt));
    await sleep(backoff);
    return throttledFetchDocs(token, alvysLoadId, attempt + 1);
  }
  try {
    const body = JSON.parse(text);
    return Array.isArray(body) ? body as AlvysDoc[] : [];
  } catch {
    if (attempt >= 5) throw new Error(`docs fetch non-JSON after ${attempt} retries`);
    await sleep(1000 * Math.pow(2, attempt));
    return throttledFetchDocs(token, alvysLoadId, attempt + 1);
  }
}

// ── Type mapping ────────────────────────────────────────────────────
function mapKind(alvysType: string | undefined): { kind: string; bucket: string } {
  const t = (alvysType ?? "").toLowerCase();
  if (t.includes("rate") && (t.includes("confirmation") || t.includes("conf"))) {
    return { kind: "rate_con", bucket: RATE_CON_BUCKET };
  }
  if (t.includes("invoice")) return { kind: "invoice", bucket: DOC_BUCKET };
  if (t.includes("bill of lading") || t === "bol") return { kind: "bol", bucket: DOC_BUCKET };
  if (t.includes("proof of delivery") || t === "pod") return { kind: "pod", bucket: DOC_BUCKET };
  if (t.includes("scale")) return { kind: "scale", bucket: DOC_BUCKET };
  return { kind: "other", bucket: DOC_BUCKET };
}

// ── Helpers ─────────────────────────────────────────────────────────
function extOf(filename: string | undefined): string {
  if (!filename) return "pdf";
  const m = filename.match(/\.([a-zA-Z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "pdf";
}

const tally = {
  loadsScanned:         0,
  loadsWithDocs:        0,
  docsSeen:             0,
  docsSkippedExisting:  0,
  docsSkippedInvoice:   0,
  docsDownloaded:       0,
  docsUploaded:         0,
  docsInserted:         0,
  rateConsMirrored:     0,
  bytesTransferred:     0,
  errors:               0,
};

interface TargetLoad {
  load_id:        string;
  alvys_id:       string;
  primary_event:  string;     // event_id to attach docs to
  has_rate_con:   boolean;    // already has loads.rate_con_pdf set
}

async function main(): Promise<void> {
  log(APPLY ? "▶  apply mode" : "🔍 dry-run mode");
  log(`   org=${ORG}  concurrency=${CONCURRENCY}  skip-invoices=${SKIP_INVOICES}`);
  log("");

  // ── 1. Pull all imported loads with their primary event ──
  // For relays we want the pickup leg. Take the lowest-`start` event
  // per load_id.
  const targets: TargetLoad[] = [];
  {
    const PAGE = 1000;
    let off = 0;
    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (fc as any)
        .from("loads")
        .select("id, alvys_load_id, rate_con_pdf, events!inner(id, start)")
        .eq("org_id", ORG)
        .eq("imported_source", "alvys")
        .not("alvys_load_id", "is", null)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(off, off + PAGE - 1);
      if (error) { log(`loads fetch failed: ${error.message}`); process.exit(2); }
      const batch = (data ?? []) as Array<{
        id: string;
        alvys_load_id: string;
        rate_con_pdf: string | null;
        events: Array<{ id: string; start: string }>;
      }>;
      if (batch.length === 0) break;
      for (const l of batch) {
        if (!l.events?.length) continue;
        // Pick earliest event (pickup leg of relay or sole event of non-relay)
        const sorted = [...l.events].sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
        targets.push({
          load_id:       l.id,
          alvys_id:      l.alvys_load_id,
          primary_event: sorted[0].id,
          has_rate_con:  !!l.rate_con_pdf,
        });
      }
      if (batch.length < PAGE) break;
      off += batch.length;
    }
  }
  tally.loadsScanned = targets.length;
  log(`Target imported loads: ${targets.length}`);

  // ── 2. Pre-fetch existing storage paths so we can skip ──
  // load_documents.storage_path is UNIQUE; build a Set of paths we
  // already have for the org so we don't re-download/re-upload.
  const existingPaths = new Set<string>();
  {
    const PAGE = 1000;
    let off = 0;
    while (true) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (fc as any)
        .from("load_documents")
        .select("storage_path")
        .eq("org_id", ORG)
        .like("storage_path", "%/alvys-%")
        .range(off, off + PAGE - 1);
      if (!data?.length) break;
      for (const r of data as Array<{ storage_path: string }>) existingPaths.add(r.storage_path);
      if (data.length < PAGE) break;
      off += data.length;
    }
  }
  log(`Already-imported alvys docs in DB: ${existingPaths.size}`);
  log("");

  // ── 3. Auth Alvys ──
  const token = await alvysToken();

  // ── 4. Process loads in parallel batches ──
  let processed = 0;
  const logProgress = (): void => {
    if (processed % 25 === 0 || processed === targets.length) {
      log(`  progress: ${processed}/${targets.length}  ` +
          `(docs seen=${tally.docsSeen}, uploaded=${tally.docsUploaded}, ` +
          `skipped existing=${tally.docsSkippedExisting}, errors=${tally.errors}, ` +
          `MB transferred=${(tally.bytesTransferred / 1024 / 1024).toFixed(0)})`);
    }
  };

  async function processLoad(t: TargetLoad): Promise<void> {
    if (tally.bytesTransferred >= MAX_BYTES) return;
    let docs: AlvysDoc[];
    try {
      docs = await throttledFetchDocs(token, t.alvys_id);
    } catch (err) {
      tally.errors++;
      log(`  ✗ doc list ${t.alvys_id.slice(0,8)}: ${(err as Error).message}`);
      return;
    }
    if (docs.length === 0) return;
    tally.loadsWithDocs++;

    for (const doc of docs) {
      if (!doc.id || !doc.DownloadUrl) continue;
      tally.docsSeen++;

      const { kind, bucket } = mapKind(doc.AttachmentType);
      if (SKIP_INVOICES && kind === "invoice") { tally.docsSkippedInvoice++; continue; }

      const ext = extOf(doc.AttachmentPath);
      const storagePath = `${ORG}/${t.load_id}/alvys-${doc.id}.${ext}`;
      if (existingPaths.has(storagePath)) { tally.docsSkippedExisting++; continue; }

      if (!APPLY) {
        tally.docsUploaded++;
        tally.bytesTransferred += doc.AttachmentSize ?? 0;
        continue;
      }

      // Download from Alvys (Azure Blob pre-signed URL — no auth needed)
      let blob: ArrayBuffer;
      try {
        const dlRes = await fetch(doc.DownloadUrl);
        if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
        blob = await dlRes.arrayBuffer();
      } catch (err) {
        tally.errors++;
        log(`  ✗ download ${t.alvys_id.slice(0,8)} ${doc.id?.slice(0,8)}: ${(err as Error).message}`);
        continue;
      }
      tally.docsDownloaded++;
      tally.bytesTransferred += blob.byteLength;

      // Upload to Supabase Storage
      const { error: upErr } = await fc.storage.from(bucket).upload(storagePath, blob, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (upErr && !upErr.message.includes("already exists")) {
        tally.errors++;
        log(`  ✗ upload ${storagePath}: ${upErr.message}`);
        continue;
      }
      tally.docsUploaded++;

      // Insert metadata row
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: dbErr } = await (fc as any).from("load_documents").insert({
        event_id:     t.primary_event,
        load_id:      t.load_id,
        org_id:       ORG,
        storage_path: storagePath,
        file_name:    doc.AttachmentPath ?? `alvys-${doc.id}.${ext}`,
        mime_type:    "application/pdf",
        size_bytes:   doc.AttachmentSize ?? blob.byteLength,
        kind,
        notes:        `Imported from Alvys (${doc.AttachmentType ?? "unknown type"}, uploaded ${doc.UploadedAt ?? "?"})`,
      });
      if (dbErr) {
        // Race or conflict — try delete + retry once? For now, log.
        if (!dbErr.message.includes("duplicate")) {
          tally.errors++;
          log(`  ✗ insert ${storagePath}: ${dbErr.message}`);
        }
        continue;
      }
      tally.docsInserted++;
      existingPaths.add(storagePath);

      // Rate-con mirror: point loads.rate_con_pdf at this if it's empty
      if (kind === "rate_con" && !t.has_rate_con) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: mirErr } = await (fc as any)
          .from("loads")
          .update({ rate_con_pdf: storagePath })
          .eq("id", t.load_id)
          .is("rate_con_pdf", null);
        if (!mirErr) {
          tally.rateConsMirrored++;
          t.has_rate_con = true;
        }
      }
    }
  }

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    if (tally.bytesTransferred >= MAX_BYTES) {
      log(`  ⏹  max-bytes cap reached (${(tally.bytesTransferred / 1024 / 1024).toFixed(0)} MB), stopping`);
      break;
    }
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(t => processLoad(t)));
    processed += batch.length;
    logProgress();
  }

  // ── 5. Report ──
  log("");
  log("── Summary ──");
  log(`Loads scanned:              ${tally.loadsScanned}`);
  log(`Loads with docs in Alvys:   ${tally.loadsWithDocs}`);
  log(`Docs seen:                  ${tally.docsSeen}`);
  log(`Skipped (already imported): ${tally.docsSkippedExisting}`);
  log(`Skipped (--skip-invoices):  ${tally.docsSkippedInvoice}`);
  log(`Docs ${APPLY ? "uploaded" : "would upload"}: ${tally.docsUploaded}`);
  log(`Docs inserted:              ${tally.docsInserted}`);
  log(`Rate cons mirrored:         ${tally.rateConsMirrored}`);
  log(`Bytes transferred:          ${(tally.bytesTransferred / 1024 / 1024).toFixed(1)} MB`);
  log(`Errors:                     ${tally.errors}`);
  if (!APPLY) log("\n(dry-run — re-run with --apply to actually transfer)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
