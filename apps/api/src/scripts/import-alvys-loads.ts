/**
 * Alvys → FleetCal historical load import.
 *
 * Stage 1 (default, runs unless --stage2-only):
 *   Pulls Alvys invoices in the [from, to] window, fetches the linked
 *   load detail for each, and upserts a FleetCal load + single event +
 *   stops. Uses Invoice.Total.Amount as the load price (so accessorials
 *   are baked in) and Load.CustomerMileage as loaded_miles. Drops loads
 *   onto an "Unassigned" pseudo-asset so they're visible in reports
 *   without polluting any specific truck's performance numbers.
 *
 * Stage 2 (runs after stage 1 unless --stage1-only):
 *   Reaches into the my-calendar Supabase project (where the user has
 *   the same loads keyed by alvys_load_id) and copies leg miles over
 *   to enrich the FleetCal events. Driver + asset matching is left for
 *   a future pass — that requires the rid→RESOURCES decoder which
 *   lives in the my-calendar JS bundle.
 *
 * Run
 * ---
 *   cd apps/api
 *   npx tsx src/scripts/import-alvys-loads.ts --org=ORG               # dry-run
 *   npx tsx src/scripts/import-alvys-loads.ts --org=ORG --apply       # write
 *   npx tsx src/scripts/import-alvys-loads.ts --org=ORG --from=2026-01-25 --to=2026-06-07
 *   npx tsx src/scripts/import-alvys-loads.ts --org=ORG --stage1-only
 *   npx tsx src/scripts/import-alvys-loads.ts --org=ORG --stage2-only
 *
 * Env required
 * ------------
 *   ALVYS_CLIENT_ID, ALVYS_CLIENT_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (FleetCal — same as the API)
 *   MYCAL_SUPABASE_URL, MYCAL_SUPABASE_SERVICE_KEY   (for stage 2 only)
 *
 * Defaults
 * --------
 *   --from defaults to 2026-01-25 (end of January — user's first
 *          Alvys-tracked load was around then)
 *   --to   defaults to today
 *   Stage 1 chunks the window into 1-month buckets to dodge Alvys's
 *   ~1071-record cap on /invoices/search.
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Args ────────────────────────────────────────────────────────────────

const APPLY        = process.argv.includes("--apply");
const STAGE1_ONLY  = process.argv.includes("--stage1-only");
const STAGE2_ONLY  = process.argv.includes("--stage2-only");
const AUTO_CREATE_CUSTOMERS = process.argv.includes("--auto-create-customers");
const ORG_ID       = arg("--org");
const FROM_DEFAULT = "2026-01-25";
const FROM         = arg("--from") ?? FROM_DEFAULT;
const TO           = arg("--to")   ?? new Date().toISOString().slice(0, 10);

function arg(name: string): string | undefined {
  const a = process.argv.find(s => s.startsWith(`${name}=`));
  return a?.slice(name.length + 1);
}

if (!ORG_ID) {
  console.error("Missing --org=ORG_ID");
  process.exit(1);
}

// ── Env ─────────────────────────────────────────────────────────────────

const ALVYS_CLIENT_ID     = process.env.ALVYS_CLIENT_ID     ?? "";
const ALVYS_CLIENT_SECRET = process.env.ALVYS_CLIENT_SECRET ?? "";
const ALVYS_AUTH_URL      = "https://auth.alvys.com/oauth/token";
const ALVYS_AUDIENCE      = "https://api.alvys.com/public/";
const ALVYS_API_BASE      = "https://integrations.alvys.com/api/p/v1.0";

const FC_URL = process.env.SUPABASE_URL ?? "";
const FC_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const MC_URL = process.env.MYCAL_SUPABASE_URL ?? "https://vgglyebsbbgooqmguzmi.supabase.co";
const MC_KEY = process.env.MYCAL_SUPABASE_SERVICE_KEY ?? "";

if (!FC_URL || !FC_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!STAGE2_ONLY && (!ALVYS_CLIENT_ID || !ALVYS_CLIENT_SECRET)) {
  console.error("Missing ALVYS_CLIENT_ID or ALVYS_CLIENT_SECRET (required for stage 1)");
  process.exit(1);
}
if (!STAGE1_ONLY && !MC_KEY) {
  console.error("Missing MYCAL_SUPABASE_SERVICE_KEY (required for stage 2 — use --stage1-only to skip)");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc: SupabaseClient<any> = createClient(FC_URL, FC_KEY, { auth: { persistSession: false } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mc: SupabaseClient<any> | null = (STAGE1_ONLY || !MC_KEY)
  ? null
  : createClient(MC_URL, MC_KEY, { auth: { persistSession: false } });

// ── Helpers ─────────────────────────────────────────────────────────────

function log(...xs: unknown[]): void { console.log(...xs); }

/** Sleep (ms) — Alvys is generous on rate limits but a small pause
 *  between detail calls keeps logs readable and respects backoff. */
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

interface AlvysToken { token: string; expiresAt: number }
let cachedToken: AlvysToken | null = null;
async function alvysToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(ALVYS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: ALVYS_CLIENT_ID,
      client_secret: ALVYS_CLIENT_SECRET,
      audience: ALVYS_AUDIENCE,
    }),
  });
  if (!res.ok) {
    throw new Error(`Alvys auth failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.token;
}

interface AlvysAddress { Street?: string; City?: string; State?: string; PostalCode?: string; Country?: string }
interface AlvysCoords  { Latitude?: number; Longitude?: number }
interface AlvysStop {
  StopType?: "Pickup" | "Delivery" | string;
  Address?: AlvysAddress;
  Coordinates?: AlvysCoords;
  // Appointment / window. Field names vary across Alvys responses —
  // accept the common ones.
  AppointmentStart?: string;
  AppointmentEnd?:   string;
  ScheduledDate?:    string;
}
interface AlvysLoad {
  Id?: string;
  LoadNumber?: string;
  Status?: string;
  Customer?: { Name?: string };
  CustomerRate?: { Amount?: number };
  CustomerMileage?: { Distance?: { Value?: number } };
  Stops?: AlvysStop[];
}
interface AlvysInvoice {
  Id?: string;
  Number?: string;
  InvoicedDate?: string;
  DueDate?: string;
  Status?: string;
  Customer?: { Name?: string };
  Total?: { Amount?: number };
  Loads?: Array<{ Id?: string; LoadNumber?: string; OrderNumber?: string }>;
  LineItems?: Array<{ LoadNumber?: string }>;
}

async function alvysSearchInvoices(token: string, page: number, dateFrom: string, dateTo: string): Promise<{ items: AlvysInvoice[]; total: number }> {
  const res = await fetch(`${ALVYS_API_BASE}/invoices/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      Page: page, PageSize: 100,
      Status: ["Draft", "AwaitingPayment", "Paid"],
      InvoicedDateRange: { From: dateFrom, To: dateTo },
    }),
  });
  if (!res.ok) throw new Error(`Alvys invoices/search failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { Items?: AlvysInvoice[]; Total?: number };
  return { items: body.Items ?? [], total: body.Total ?? 0 };
}

// Track 429 retries so the summary can surface "we backed off N times".
let totalRetries = 0;

async function alvysGetLoad(token: string, loadId: string): Promise<AlvysLoad | null> {
  // Cloudflare in front of Alvys throttles hard on /loads/{id}. Implement
  // exponential backoff on 429 / 5xx, capped at 6 retries (~63s of waits).
  // Respect Retry-After header when present; otherwise back off 1s, 2s,
  // 4s, 8s, 16s, 32s.
  const MAX_RETRIES = 6;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${ALVYS_API_BASE}/loads/${loadId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (res.ok) return await res.json() as AlvysLoad;
    // Retryable? 429 always. 5xx usually. Anything else → fail fast.
    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (!retryable || attempt === MAX_RETRIES) {
      const body = await res.text();
      throw new Error(`Alvys loads/${loadId} failed (${res.status}) after ${attempt} retries: ${body.slice(0, 200)}`);
    }
    // Honor Retry-After when present; otherwise exponential. Cloudflare
    // sometimes sends a seconds value, sometimes a date — handle both.
    const retryAfter = res.headers.get("retry-after");
    let waitMs = 1000 * Math.pow(2, attempt);
    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (Number.isFinite(asNum)) waitMs = Math.max(waitMs, asNum * 1000);
      else {
        const dateMs = Date.parse(retryAfter);
        if (Number.isFinite(dateMs)) waitMs = Math.max(waitMs, dateMs - Date.now());
      }
    }
    waitMs = Math.min(waitMs, 32_000);
    totalRetries++;
    await sleep(waitMs);
  }
  // Should be unreachable.
  throw new Error(`Alvys loads/${loadId} unreachable retry path`);
}

/** Map Alvys status + invoice status → FleetCal billing_status. */
function mapBillingStatus(loadStatus: string | undefined, invoiceStatus: string | undefined): "pending" | "verified" | "invoiced" | "paid" {
  const inv = (invoiceStatus ?? "").toLowerCase();
  if (inv === "paid") return "paid";
  if (inv === "awaitingpayment") return "invoiced";
  // Draft invoice or no invoice yet — treat as verified (ready to invoice).
  if ((loadStatus ?? "").toLowerCase() === "delivered") return "verified";
  return "pending";
}

/** Map Alvys load status → FleetCal event status. */
function mapEventStatus(loadStatus: string | undefined): string {
  const s = (loadStatus ?? "").toLowerCase();
  if (s === "delivered") return "delivered";
  if (s === "intransit" || s === "in_transit") return "in_transit";
  if (s === "cancelled") return "cancelled";
  return "scheduled";
}

/** Build a FleetCal stop record from an Alvys stop. */
interface FleetcalStop {
  event_id: string;
  sequence: number;
  type: "pickup" | "delivery" | "stop";
  facility_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  appt_start: string | null;
  appt_end: string | null;
}
function buildStop(s: AlvysStop, seq: number, eventId: string): FleetcalStop {
  const a = s.Address ?? {};
  const c = s.Coordinates ?? {};
  const city  = (a.City  ?? "").trim();
  const state = (a.State ?? "").trim().toUpperCase();
  const addrParts = [a.Street, city, state, a.PostalCode].filter(Boolean);
  const type = (s.StopType ?? "").toLowerCase();
  return {
    event_id:    eventId,
    sequence:    seq,
    type:        type === "pickup" ? "pickup" : type === "delivery" ? "delivery" : "stop",
    facility_name: null,
    address:     addrParts.length > 0 ? addrParts.join(", ") : null,
    city:        city || null,
    state:       state || null,
    lat:         typeof c.Latitude  === "number" ? c.Latitude  : null,
    lng:         typeof c.Longitude === "number" ? c.Longitude : null,
    appt_start:  s.AppointmentStart ?? s.ScheduledDate ?? null,
    appt_end:    s.AppointmentEnd ?? null,
  };
}

/** Convert an ISO-with-Z to "YYYY-MM-DDTHH:mm" naive in America/Denver. */
function toNaiveDenver(iso: string | null | undefined, fallbackTime: "09:00" | "12:00"): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    // Use Intl to format in America/Denver, then reassemble. avoids
    // pulling in date-fns-tz for one job.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Denver",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
    return `${date}T${time}`;
  } catch {
    // Fall back to date-only with default time.
    const dateOnly = String(iso).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? `${dateOnly}T${fallbackTime}` : null;
  }
}

/** Yield monthly [from, to] windows that cover [overallFrom, overallTo]. */
function* monthlyWindows(overallFrom: string, overallTo: string): Generator<[string, string]> {
  const [yF, mF] = overallFrom.split("-").map(Number);
  const [yT, mT] = overallTo.split("-").map(Number);
  let y = yF, m = mF;
  while (y < yT || (y === yT && m <= mT)) {
    const winFrom = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m here is 1-12 → end of month
    const winTo   = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    // Clamp to overall window
    const from = winFrom < overallFrom ? overallFrom : winFrom;
    const to   = winTo   > overallTo   ? overallTo   : winTo;
    yield [from, to];
    m++; if (m > 12) { m = 1; y++; }
  }
}

// ── Unassigned asset + customer lookup ──────────────────────────────────

async function getOrCreateUnassignedAssetId(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (fc as any).from("assets").select("id").eq("org_id", ORG_ID).eq("name", "Unassigned").maybeSingle();
  if (data?.id) return data.id;
  if (!APPLY) {
    log(`(dry-run) Would create Unassigned asset for org ${ORG_ID}`);
    return -1;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: created, error } = await (fc as any).from("assets").insert({
    org_id: ORG_ID,
    name: "Unassigned",
    unit: null,
    color: "#9ca3af",
    type: "Unassigned",
    hidden: false,
    sort_order: 9999,
  }).select("id").single();
  if (error || !created) throw new Error(`Create Unassigned asset failed: ${error?.message}`);
  log(`  ✓ Created Unassigned asset id=${created.id}`);
  return created.id;
}

interface CustomerLite { id: string; name: string; aliases: string[] | null }
let customersCache: CustomerLite[] | null = null;
async function getCustomers(): Promise<CustomerLite[]> {
  if (customersCache) return customersCache;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (fc as any).from("customers").select("id,name,aliases").eq("org_id", ORG_ID);
  if (error) throw new Error(`Customers fetch failed: ${error.message}`);
  customersCache = (data ?? []) as CustomerLite[];
  return customersCache!;
}

// ── Customer name matcher ─────────────────────────────────────────────
//
// Mirrors the frontend's apps/web/lib/customerMatch.ts. Stop-word
// normalisation + Jaccard over words. Same thresholds: ≥0.85 'auto',
// ≥0.5 'confirm', <0.35 'new'. We only bind on 'auto' here — anything
// fuzzier than that we'd rather leave NULL than risk a wrong FK.
//
// Why a private copy: this script is a one-shot CLI run from a Node
// context with no path to the web tsconfig. Easier to inline 30 lines
// than wire up the package resolution. If the web scorer ever changes
// materially, sync it here too.
const STOP_WORDS = new Set([
  "llc", "inc", "corp", "co", "company", "ltd", "limited", "group", "international",
  "freight", "logistics", "transport", "transportation", "trucking", "carriers",
  "carrier", "solutions", "services", "service", "systems", "global", "national",
  "express", "direct", "lines", "line", "usa", "us",
]);
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w)).join(" ").trim();
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}
function scoreAgainst(extracted: string, candidate: string): number {
  const ne = normName(extracted), nc = normName(candidate);
  const re = extracted.toLowerCase().trim(), rc = candidate.toLowerCase().trim();
  if (!ne || !nc) {
    if (re === rc) return 1.0;
    if (rc.includes(re) || re.includes(rc)) return 0.85;
    return 0;
  }
  if (ne === nc) return 1.0;
  if (nc.includes(ne) || ne.includes(nc)) return 0.9;
  return jaccard(new Set(ne.split(" ")), new Set(nc.split(" "))) * 0.95;
}
interface MatchResult {
  status: "auto" | "confirm" | "new" | "none";
  customer?: CustomerLite;
  score?: number;
}
function matchCustomer(extracted: string, customers: CustomerLite[]): MatchResult {
  if (!extracted.trim()) return { status: "none" };
  if (customers.length === 0) return { status: "new" };
  let best: { customer: CustomerLite; score: number } | null = null;
  for (const c of customers) {
    const candidates = [c.name, ...(c.aliases ?? [])];
    const score = Math.max(...candidates.map(a => scoreAgainst(extracted, a)));
    if (!best || score > best.score) best = { customer: c, score };
  }
  if (!best || best.score < 0.35) return { status: "new" };
  if (best.score >= 0.85)         return { status: "auto",    customer: best.customer, score: best.score };
  if (best.score >= 0.5)          return { status: "confirm", customer: best.customer, score: best.score };
  return { status: "new" };
}

// Track unmatched broker names + their best-guess suggestion, so the
// summary can surface a "needs review" CSV at the end. Map key is the
// raw Alvys name (preserves case for display); value is the highest
// fuzzy-but-not-auto match we found and the count of loads using it.
interface UnmatchedEntry {
  alvysName: string;
  occurrences: number;
  suggestionName?: string;
  suggestionScore?: number;
}
const unmatchedByName = new Map<string, UnmatchedEntry>();

async function resolveCustomer(name: string | undefined): Promise<{ id: string; name: string } | null> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return null;
  const customers = await getCustomers();
  const match = matchCustomer(trimmed, customers);
  if (match.status === "auto" && match.customer) {
    return { id: match.customer.id, name: match.customer.name };
  }
  // Below the auto threshold — leave customer_id NULL on the load and
  // log to the unmatched bucket for the post-run review report. The
  // broker text is still preserved on the load row, so the load shows
  // up in reports / accounting; only the FK is missing. The user can
  // either add aliases / create customers and re-run the existing
  // backfill-loads-customer-id.ts script, OR flip on
  // --auto-create-customers and re-run this script.
  const key = trimmed.toLowerCase();
  const existing = unmatchedByName.get(key);
  if (existing) {
    existing.occurrences++;
  } else {
    unmatchedByName.set(key, {
      alvysName: trimmed,
      occurrences: 1,
      suggestionName:  match.status === "confirm" ? match.customer?.name : undefined,
      suggestionScore: match.status === "confirm" ? match.score          : undefined,
    });
  }

  if (!AUTO_CREATE_CUSTOMERS) return null;

  // --auto-create-customers path. Same behavior the importer had by
  // default before — kept behind a flag for users who'd rather create
  // duplicate-prone customer rows now than do reconciliation later.
  if (!APPLY) {
    log(`  (dry-run) Would create customer "${trimmed}"`);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: created, error } = await (fc as any).from("customers").insert({
    org_id: ORG_ID,
    name: trimmed,
    invoice_method: "email",
    invoice_email: null,
  }).select("id,name").single();
  if (error || !created) {
    log(`  ✗ Create customer "${trimmed}" failed: ${error?.message}`);
    return null;
  }
  customersCache!.push({ id: created.id, name: created.name, aliases: [] });
  return { id: created.id, name: created.name };
}

// ── Stage 1: Alvys → FleetCal ───────────────────────────────────────────

const tally1 = {
  invoicesFetched: 0,
  loadsConsidered: 0,
  loadsImported:   0,
  loadsSkipped:    0,
  loadsErrored:    0,
  customersCreated: 0,
};
const skipped: Array<{ alvysLoadId: string; reason: string }> = [];

async function runStage1(): Promise<void> {
  log("");
  log("══ STAGE 1 — Alvys → FleetCal ════════════════════════════════════");
  log(`   org=${ORG_ID}  window=${FROM}→${TO}  mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  log("");

  const token = await alvysToken();
  const unassignedAssetId = await getOrCreateUnassignedAssetId();
  const customersBefore = (await getCustomers()).length;

  // Iterate by monthly window, paginate within each. Dedupe by Alvys
  // invoice Id across windows (overlap shouldn't happen but safe).
  const seenInvoiceIds = new Set<string>();
  const queue: Array<{ invoice: AlvysInvoice; loadId: string }> = [];

  for (const [winFrom, winTo] of monthlyWindows(FROM, TO)) {
    log(`▶  Window ${winFrom} → ${winTo}`);
    let page = 1;
    while (true) {
      const { items, total } = await alvysSearchInvoices(token, page, winFrom, winTo);
      const fresh = items.filter(i => i.Id && !seenInvoiceIds.has(String(i.Id)));
      for (const i of fresh) seenInvoiceIds.add(String(i.Id!));
      tally1.invoicesFetched += fresh.length;
      // Pair each invoice with its first Load (Alvys often has 1 Load per invoice;
      // for multi-load invoices, take the first — user said they don't need every
      // load to match, just the core financial data).
      for (const inv of fresh) {
        const loadId = inv.Loads?.[0]?.Id;
        if (!loadId) { skipped.push({ alvysLoadId: "(none)", reason: `invoice ${inv.Number} has no Loads[]` }); tally1.loadsSkipped++; continue; }
        queue.push({ invoice: inv, loadId: String(loadId) });
      }
      log(`   page ${page}: ${items.length} returned, ${fresh.length} new (running invoices=${tally1.invoicesFetched}, alvys total=${total})`);
      if (items.length < 100 || fresh.length === 0) break;
      page++;
    }
    await sleep(150);
  }

  log("");
  log(`Loaded ${queue.length} invoice→load pairs to import.`);
  log("");

  // Process each load with a small concurrency cap. 4 in flight is well
  // within Alvys's tolerance and keeps wall-clock low without bursting.
  // Concurrency: SEQUENTIAL (1 worker). Cloudflare sits in front of
  // Alvys's /loads/{id} endpoint and throttles aggressively — even 2
  // parallel workers get hit with 429 challenges. Run one-at-a-time
  // and rely on alvysGetLoad's exponential backoff for transient
  // failures. The 200ms inter-request sleep below paces us under the
  // sustained-rate threshold.
  // Diagnostic logging: in dry-run mode (or when not too many already
  // logged), print the first N distinct error messages immediately so
  // a "every load errored" run shows WHY in real time instead of just
  // a useless count at the end.
  // Invoice-only mode does no per-load Alvys calls, so we don't need
  // to throttle. The DB writes are the bottleneck — keep concurrency
  // modest to avoid hammering Supabase with parallel upserts.
  const CONCURRENCY = 4;
  const INTER_REQUEST_MS = 0;
  const queueCopy = queue.slice();
  const distinctErrors = new Map<string, number>();
  const ERROR_LOG_LIMIT = 5;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queueCopy.length > 0) {
        const job = queueCopy.shift();
        if (!job) break;
        tally1.loadsConsidered++;
        try {
          await processOneLoad(job.invoice, job.loadId, token, unassignedAssetId);
          // Pace requests to stay under Cloudflare's rate threshold.
          await sleep(INTER_REQUEST_MS);
        } catch (err) {
          tally1.loadsErrored++;
          const msg = (err as Error).message ?? String(err);
          const existing = distinctErrors.get(msg) ?? 0;
          distinctErrors.set(msg, existing + 1);
          if (existing < ERROR_LOG_LIMIT) {
            log(`  ✗ ${job.loadId}: ${msg.slice(0, 300)}`);
          }
          skipped.push({ alvysLoadId: job.loadId, reason: `error: ${msg}` });
        }
      }
    }),
  );

  // Distinct-error summary so the final report shows what failed and how often,
  // even when individual log lines were truncated by the per-message limit.
  if (distinctErrors.size > 0) {
    log("");
    log(`── Distinct errors (${distinctErrors.size} kinds across ${tally1.loadsErrored} loads) ──`);
    const sorted = Array.from(distinctErrors.entries()).sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted.slice(0, 10)) {
      log(`  ${count}× ${msg.slice(0, 250)}`);
    }
    if (sorted.length > 10) log(`  …${sorted.length - 10} more kinds suppressed`);
  }

  const customersAfter = (await getCustomers()).length;
  tally1.customersCreated = Math.max(0, customersAfter - customersBefore);
}

async function processOneLoad(invoice: AlvysInvoice, alvysLoadId: string, token: string, unassignedAssetId: number): Promise<void> {
  // INVOICE-ONLY MODE.
  //
  // The /loads/{id} endpoint on Alvys's partner API returns 405 Method
  // Not Allowed regardless of GET / POST / etc. — either the endpoint
  // was retired or the partner tier doesn't get load detail at all.
  // Either way, hitting it for every invoice tanks the whole import.
  //
  // Pivot: build the FleetCal load row from the INVOICE response
  // alone. That gives us broker, revenue, load number, Alvys UUID,
  // and a date window. Miles come from the my-calendar bridge in
  // stage 2 (which has them already, keyed by alvys_load_id).
  // Stops are skipped — the user said they don't need perfect
  // matching, and dispatching is already done for these historical
  // loads anyway.
  //
  // Token + unassignedAssetId still params for parity with the
  // original signature; token is unused now, kept so future
  // /loads/{id} restoration is a smaller diff.
  void token;

  const invoiceLoadRef = invoice.Loads?.[0];

  // ── Customer / broker resolution ─────────────────────────────────────
  const brokerName = (invoice.Customer?.Name ?? "").trim();
  const customer = await resolveCustomer(brokerName);

  // ── Pricing — invoice total (user's call) ────────────────────────────
  const loadPrice = invoice.Total?.Amount ?? 0;

  // ── Dates — invoiced date is our anchor since we don't have stop
  // times. Use it as both start AND end so the load lands on the
  // calendar on a known day; stage 2 / manual edits can tighten later.
  const invoiceDateIso = invoice.InvoicedDate?.slice(0, 10);
  const dateKey = invoiceDateIso && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDateIso) ? invoiceDateIso : FROM;
  const start = `${dateKey}T09:00`;
  const end   = `${dateKey}T12:00`;

  // ── Status mapping ────────────────────────────────────────────────────
  // No load-level Status without /loads/{id}; rely on invoice status
  // entirely. mapBillingStatus already handles the "no load status"
  // case via the second arg, but invert: just pass invoice status
  // for both, and "delivered" → "verified" path falls through to
  // "pending" which we override below since these are historical
  // invoiced loads (anything in the invoice list is at least invoiced).
  let billingStatus: "pending" | "verified" | "invoiced" | "paid" = "verified";
  const invStatus = (invoice.Status ?? "").toLowerCase();
  if (invStatus === "paid") billingStatus = "paid";
  else if (invStatus === "awaitingpayment") billingStatus = "invoiced";
  else billingStatus = "verified"; // Draft → ready to send
  const eventStatus = "delivered"; // historical = delivered

  // ── Title ─────────────────────────────────────────────────────────────
  const loadNum = invoiceLoadRef?.LoadNumber ?? "";
  const title = brokerName
    ? `${brokerName}${loadNum ? ` :: ${loadNum}` : ""}`
    : `Alvys ${loadNum || alvysLoadId.slice(0, 8)}`;

  if (!APPLY) {
    log(`  → ${loadNum || alvysLoadId.slice(0, 8)} :: ${brokerName} :: $${loadPrice} :: ${billingStatus}`);
    tally1.loadsImported++;
    return;
  }

  // ── Upsert load ───────────────────────────────────────────────────────
  const loadRow = {
    org_id:          ORG_ID,
    load_num:        loadNum || null,
    broker:          brokerName || null,
    customer_id:     customer?.id ?? null,
    load_price:      loadPrice,
    billing_status:  billingStatus,
    alvys_load_id:   alvysLoadId,
    imported_source: "alvys",
    imported_at:     new Date().toISOString(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: upserted, error: upErr } = await (fc as any)
    .from("loads")
    .upsert(loadRow, { onConflict: "org_id,alvys_load_id" })
    .select("id")
    .single();
  if (upErr || !upserted) {
    // THROW so the worker's catch block surfaces this in the distinct-
    // errors diagnostic. Returning quietly here meant the user saw "2028
    // errored" with no idea why.
    throw new Error(`loads upsert failed: ${upErr?.message ?? "no data returned"}`);
  }
  const loadId = upserted.id as string;

  // ── Find existing event for this Alvys load or insert a new one ──────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingEvent } = await (fc as any)
    .from("events")
    .select("id")
    .eq("org_id", ORG_ID)
    .eq("alvys_load_id", alvysLoadId)
    .is("deleted_at", null)
    .maybeSingle();

  let eventId: string;
  if (existingEvent?.id) {
    eventId = existingEvent.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (fc as any).from("events").update({
      load_id: loadId,
      title,
      start, end: end,
      status: eventStatus,
      asset_id: unassignedAssetId,
      driver_id: null,
      driver_name: null,
      // loaded_miles deliberately NOT overwritten on update — stage 2
      // / my-calendar bridge owns this field. Don't trash a value
      // that's already there.
      event_kind: "revenue",
    }).eq("id", eventId);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: createdEv, error: evErr } = await (fc as any).from("events").insert({
      org_id: ORG_ID,
      load_id: loadId,
      title,
      start, end: end,
      status: eventStatus,
      asset_id: unassignedAssetId,
      driver_id: null,
      driver_name: null,
      loaded_miles: null, // stage 2 fills this in via my-calendar bridge
      event_kind: "revenue",
      alvys_load_id: alvysLoadId,
    }).select("id").single();
    if (evErr || !createdEv) {
      throw new Error(`events insert failed: ${evErr?.message ?? "no data returned"}`);
    }
    eventId = createdEv.id as string;
  }

  // Stops are intentionally skipped in invoice-only mode — Alvys's
  // /loads/{id} endpoint (the stops source) returns 405. The user's
  // stated goal is core financial + mileage data, both of which we
  // satisfy via invoice + my-calendar bridge. Stops can be added
  // later via a dedicated /loads/{id} restoration if Alvys publishes
  // the right method.

  tally1.loadsImported++;
  log(`  ✓ ${loadNum || alvysLoadId.slice(0, 8)} :: ${brokerName} :: $${loadPrice}`);
}

// ── Stage 2: my-calendar enrichment ─────────────────────────────────────

const tally2 = { scanned: 0, enriched: 0, noMatch: 0, alreadyHadMiles: 0, errors: 0 };

async function runStage2(): Promise<void> {
  if (!mc) {
    log("");
    log("(stage 2 skipped — no MYCAL_SUPABASE_SERVICE_KEY)");
    return;
  }
  log("");
  log("══ STAGE 2 — my-calendar → FleetCal miles enrichment ═════════════");
  log("");

  // Pull all imported loads + their event.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (fc as any)
    .from("loads")
    .select("id, alvys_load_id, events:events(id, loaded_miles, alvys_load_id)")
    .eq("org_id", ORG_ID)
    .not("alvys_load_id", "is", null);
  if (error) {
    log(`Stage 2 load fetch failed: ${error.message}`);
    return;
  }
  const importedLoads = (rows ?? []) as Array<{
    id: string;
    alvys_load_id: string;
    events: Array<{ id: string; loaded_miles: number | null; alvys_load_id: string | null }>;
  }>;
  log(`Found ${importedLoads.length} imported loads to consider for enrichment`);

  for (const load of importedLoads) {
    tally2.scanned++;
    const ev = load.events?.[0];
    if (!ev) continue;
    if (ev.loaded_miles != null && ev.loaded_miles > 0) {
      tally2.alreadyHadMiles++;
      continue;
    }
    // Look up the matching event in my-calendar.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: mcEvents, error: mcErr } = await (mc as any)
      .from("events")
      .select("leg_miles, alvys_miles")
      .eq("alvys_load_id", load.alvys_load_id)
      .is("deleted_at", null)
      .limit(1);
    if (mcErr) { tally2.errors++; continue; }
    const mcEv = (mcEvents ?? [])[0] as { leg_miles: number | null; alvys_miles: number | null } | undefined;
    if (!mcEv) { tally2.noMatch++; continue; }
    const miles = mcEv.leg_miles ?? mcEv.alvys_miles;
    if (miles == null) { tally2.noMatch++; continue; }
    if (APPLY) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (fc as any).from("events").update({ loaded_miles: miles }).eq("id", ev.id);
      if (upErr) { tally2.errors++; continue; }
    }
    tally2.enriched++;
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!STAGE2_ONLY) await runStage1();
  if (!STAGE1_ONLY) await runStage2();

  log("");
  log("── Summary ─────────────────────────────────────────────────────");
  if (!STAGE2_ONLY) {
    log(`Stage 1 (Alvys → FleetCal):`);
    log(`  Invoices fetched:        ${tally1.invoicesFetched}`);
    log(`  Loads considered:        ${tally1.loadsConsidered}`);
    log(`  ${APPLY ? "Loads imported" : "Would import"}: ${tally1.loadsImported}`);
    log(`  Loads skipped:           ${tally1.loadsSkipped}`);
    log(`  Loads errored:           ${tally1.loadsErrored}`);
    log(`  Customers created:       ${tally1.customersCreated}`);
    log(`  Backoff retries:         ${totalRetries}  (transient 429 / 5xx)`);
  }
  if (!STAGE1_ONLY) {
    log(`Stage 2 (my-calendar miles enrichment):`);
    log(`  Loads scanned:           ${tally2.scanned}`);
    log(`  ${APPLY ? "Enriched" : "Would enrich"}:    ${tally2.enriched}`);
    log(`  Already had miles:       ${tally2.alreadyHadMiles}`);
    log(`  No match in my-calendar: ${tally2.noMatch}`);
    log(`  Errors:                  ${tally2.errors}`);
  }
  if (skipped.length > 0 && skipped.length <= 50) {
    log("");
    log("── Skipped / errored (need manual review) ─────────────────────");
    log("alvysLoadId,reason");
    for (const s of skipped) {
      const esc = (x: string) => `"${x.replace(/"/g, '""')}"`;
      log(`${s.alvysLoadId},${esc(s.reason)}`);
    }
  } else if (skipped.length > 50) {
    log(`(${skipped.length} skipped/errored — too many to list)`);
  }

  if (unmatchedByName.size > 0) {
    log("");
    log("── Unmatched broker names (loads imported with customer_id=NULL) ──");
    log("Add an alias on an existing FleetCal customer, or create the customer,");
    log("then run: npx tsx src/scripts/backfill-loads-customer-id.ts --apply");
    log("to link these loads up. The fuzzy-match score-column shows where the");
    log("importer's best guess was — anything below the 0.85 auto threshold");
    log("was left alone rather than risk a wrong FK.");
    log("");
    const sorted = Array.from(unmatchedByName.values()).sort((a, b) => b.occurrences - a.occurrences);
    log("alvysName,occurrences,suggestion,suggestionScore");
    for (const u of sorted) {
      const esc = (x: string) => `"${x.replace(/"/g, '""')}"`;
      const sug = u.suggestionName ?? "";
      const sc  = u.suggestionScore != null ? u.suggestionScore.toFixed(2) : "";
      log(`${esc(u.alvysName)},${u.occurrences},${esc(sug)},${sc}`);
    }
  }

  log("");
  if (!APPLY) log("(dry-run — re-run with --apply to actually write)");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
