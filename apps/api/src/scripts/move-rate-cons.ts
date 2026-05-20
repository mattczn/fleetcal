/**
 * One-shot migration: copy every kind='rate_con' blob currently sitting
 * in the `load-documents` bucket into the `rate-cons` bucket.
 *
 * Background
 * ----------
 * Phase 3.1 routed NEW rate-con uploads to `rate-cons`. Existing rows
 * (kind='rate_con' in load_documents) still have their blob in
 * `load-documents` from before the split. The read paths fall back
 * across buckets, so things keep working, but the storage layer is
 * inconsistent — and bucket-level policies can't lock rate cons down
 * until every blob actually lives in `rate-cons`.
 *
 * What it does (per row)
 * ----------------------
 *   1. Try to download the blob from `rate-cons` first.
 *      - If present: skip (already migrated).
 *      - If 404: continue.
 *   2. Download from `load-documents` at the row's storage_path.
 *      - If 404 in both buckets: log + skip (orphan row).
 *   3. Upload to `rate-cons` at the same storage_path.
 *   4. Delete the source from `load-documents` (only after step 3
 *      succeeds; on failure leave the original so we don't lose data).
 *
 * The `load_documents.storage_path` column is unchanged — the path is
 * the same in both buckets, only the bucket name differs.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/move-rate-cons.ts            # dry-run (default)
 *   npx tsx src/scripts/move-rate-cons.ts --apply    # actually do it
 *   npx tsx src/scripts/move-rate-cons.ts --apply --keep-source
 *       (don't delete from load-documents — useful for first prod run)
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (same as
 * the API server).
 */

import "dotenv/config";
import { supabase } from "../lib/supabase.js";
import { DOC_BUCKET, RATE_CON_BUCKET } from "../lib/docBuckets.js";

interface Row {
  id:           string;
  org_id:       string;
  load_id:      string | null;
  storage_path: string;
  file_name:    string;
}

const argv = new Set(process.argv.slice(2));
const APPLY       = argv.has("--apply");
const KEEP_SOURCE = argv.has("--keep-source");

async function listRateCons(): Promise<Row[]> {
  // Pull every rate_con row org-wide. Pagination via Supabase range
  // because the .select() default cap is 1000.
  const PAGE = 1000;
  let from = 0;
  const out: Row[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("load_documents")
      .select("id, org_id, load_id, storage_path, file_name")
      .eq("kind", "rate_con")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch rate_con rows: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function blobExists(bucket: string, path: string): Promise<boolean> {
  // createSignedUrl with 1-second TTL is the cheapest existence probe —
  // we don't actually need the URL, just the success/404.
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 1);
  return !!data;
}

async function copy(path: string): Promise<{ status: "moved" | "skipped" | "missing" | "error"; detail?: string }> {
  // Already in rate-cons? Skip.
  if (await blobExists(RATE_CON_BUCKET, path)) {
    // If keepSource, leave load-documents alone too. Otherwise, the
    // source-bucket cleanup happens at the end of the function.
    if (!KEEP_SOURCE && APPLY) {
      await supabase.storage.from(DOC_BUCKET).remove([path]);
    }
    return { status: "skipped", detail: "already in rate-cons" };
  }
  // Pull from load-documents.
  const { data: blob, error: dlErr } = await supabase.storage.from(DOC_BUCKET).download(path);
  if (dlErr || !blob) {
    return { status: "missing", detail: dlErr?.message ?? "not found" };
  }
  if (!APPLY) {
    return { status: "moved", detail: "(dry-run)" };
  }
  // Upload to rate-cons.
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const { error: upErr } = await supabase.storage
    .from(RATE_CON_BUCKET)
    .upload(path, buffer, {
      contentType: blob.type || "application/pdf",
      upsert: false,
    });
  if (upErr) {
    // upsert:false → conflict means it appeared between our check and
    // upload. Treat as success; the destination has the data we want.
    if (!upErr.message.toLowerCase().includes("duplicate")) {
      return { status: "error", detail: upErr.message };
    }
  }
  // Delete source unless explicitly told to keep it.
  if (!KEEP_SOURCE) {
    const { error: rmErr } = await supabase.storage.from(DOC_BUCKET).remove([path]);
    if (rmErr) {
      // Non-fatal — blob is now in both buckets. Log + continue.
      console.warn(`  warn: failed to remove from ${DOC_BUCKET}: ${rmErr.message}`);
    }
  }
  return { status: "moved" };
}

async function main(): Promise<void> {
  console.log(`move-rate-cons: ${APPLY ? "APPLY" : "dry-run"}${KEEP_SOURCE ? " (keep-source)" : ""}`);
  const rows = await listRateCons();
  console.log(`found ${rows.length} rate_con rows across all orgs`);

  const stats = { moved: 0, skipped: 0, missing: 0, error: 0 };
  for (const r of rows) {
    const result = await copy(r.storage_path);
    stats[result.status]++;
    const tag = result.status.toUpperCase().padEnd(8, " ");
    console.log(`  ${tag} ${r.org_id} ${r.id} ${r.storage_path}${result.detail ? `  (${result.detail})` : ""}`);
  }

  console.log("");
  console.log(`done.  moved=${stats.moved}  skipped=${stats.skipped}  missing=${stats.missing}  error=${stats.error}`);
  if (!APPLY) {
    console.log("(this was a DRY RUN — re-run with --apply to perform the migration.)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
