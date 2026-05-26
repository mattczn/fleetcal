/**
 * One-time import: copy historical fuel_transactions from the old
 * my-calendar Supabase project into the FleetCal Supabase project.
 *
 * Reads from:
 *   https://vgglyebsbbgooqmguzmi.supabase.co (old)
 * Writes to:
 *   POST /v1/fuel-transactions/import  (FleetCal API)
 *
 * Idempotent — re-running is safe. The server upserts on
 * (org_id, provider, provider_transaction_id) and reports duplicates
 * in the response.
 *
 * Usage:
 *   FLEETCAL_API_URL=https://fleetcalapi-production.up.railway.app \
 *   FLEETCAL_CLERK_BEARER=<your clerk session token> \
 *   OLD_SUPA_URL=https://vgglyebsbbgooqmguzmi.supabase.co \
 *   OLD_SUPA_KEY=sb_publishable_M0RNyUH42gtaJXNG_jFNqg_VD4cc6mQ \
 *   npx tsx scripts/import-old-fuel-transactions.ts
 *
 * Why this needs a Clerk bearer rather than the API key path:
 *   /v1/fuel-transactions/import is gated by accounting/dispatch
 *   capabilities (it touches all of an org's data; bulk-imports
 *   are an admin-shaped operation). The api-key path is for
 *   incremental ingest only. Grab a bearer by:
 *
 *     1. Open https://fleetcal.app in your browser, sign in
 *     2. Open DevTools → Application → Cookies
 *     3. Copy the __session cookie value (it's a JWT)
 *     4. That value is the FLEETCAL_CLERK_BEARER for this script
 *
 *   The token is short-lived (~1h). The script runs in under 30s so
 *   that's fine, but if it expires re-grab and re-run — it picks up
 *   from where it left off via the dedup constraint.
 */

const OLD_SUPA_URL = process.env.OLD_SUPA_URL || "https://vgglyebsbbgooqmguzmi.supabase.co";
const OLD_SUPA_KEY = process.env.OLD_SUPA_KEY;
const FLEETCAL_API_URL = process.env.FLEETCAL_API_URL;
// Auth: either a Clerk session JWT (short-lived, fetched from the web
// app DevTools) OR a long-lived org API key with scope 'fuel.import'.
// API key wins when both are set — it's the saner path for one-off
// imports because Clerk tokens age out in 60s mid-script.
const FLEETCAL_API_KEY = process.env.FLEETCAL_API_KEY;
const FLEETCAL_CLERK_BEARER = process.env.FLEETCAL_CLERK_BEARER;

if (!OLD_SUPA_KEY) {
  console.error("OLD_SUPA_KEY required");
  process.exit(1);
}
if (!FLEETCAL_API_URL) {
  console.error("FLEETCAL_API_URL required");
  process.exit(1);
}
if (!FLEETCAL_API_KEY && !FLEETCAL_CLERK_BEARER) {
  console.error("Provide either FLEETCAL_API_KEY (preferred) or FLEETCAL_CLERK_BEARER.");
  process.exit(1);
}

interface OldRow {
  id:                       string;
  transaction_id:           string;
  transaction_date:         string;
  driver_name:              string | null;
  location:                 string | null;
  diesel_gallons:           number | null;
  diesel_retail_price:      number | null;
  diesel_mudflap_price:     number | null;
  diesel_total:             number | null;
  def_gallons:              number | null;
  def_retail_price:         number | null;
  def_mudflap_price:        number | null;
  def_total:                number | null;
  total_charged:            number;
  total_saved:              number | null;
  payment_last4:            string | null;
  matched_truck:            string | null;
  form_response_id:         number | null;
  // unused: match_status, match_confidence, raw_email, created_at, match_notes
}

interface ImportPayload {
  transactions: Array<{
    provider:              "mudflap";
    providerTransactionId: string;
    transactionDate:       string;
    driverName?:           string;
    location?:             string;
    matchedTruck?:         string;
    dieselGallons?:        number;
    dieselRetailPrice?:    number;
    dieselDiscountPrice?:  number;
    dieselTotal?:          number;
    defGallons?:           number;
    defRetailPrice?:       number;
    defDiscountPrice?:     number;
    defTotal?:             number;
    totalCharged:          number;
    totalSaved:            number;
    paymentLast4?:         string;
    legacyFormResponseId?: number;
  }>;
}

interface ImportResult {
  inserted:   number;
  duplicates: number;
  failed:     Array<{ providerTransactionId: string; error: string }>;
}

async function fetchAllOldRows(): Promise<OldRow[]> {
  const PAGE_SIZE = 500;
  const headers = {
    apikey:        OLD_SUPA_KEY as string,
    Authorization: `Bearer ${OLD_SUPA_KEY}`,
  };
  const all: OldRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url =
      `${OLD_SUPA_URL}/rest/v1/fuel_transactions` +
      `?select=*&order=transaction_date.asc&limit=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`old supabase fetch ${res.status}: ${await res.text()}`);
    }
    const page = (await res.json()) as OldRow[];
    all.push(...page);
    console.log(`  fetched ${all.length} rows (last page: ${page.length})`);
    if (page.length < PAGE_SIZE) break;
  }
  return all;
}

function toPayloadRow(r: OldRow): ImportPayload["transactions"][number] {
  return {
    provider:              "mudflap",
    providerTransactionId: r.transaction_id,
    transactionDate:       r.transaction_date,
    driverName:            r.driver_name ?? undefined,
    location:              r.location ?? undefined,
    matchedTruck:          r.matched_truck ?? undefined,
    dieselGallons:         r.diesel_gallons ?? undefined,
    dieselRetailPrice:     r.diesel_retail_price ?? undefined,
    dieselDiscountPrice:   r.diesel_mudflap_price ?? undefined,
    dieselTotal:           r.diesel_total ?? undefined,
    defGallons:            r.def_gallons ?? undefined,
    defRetailPrice:        r.def_retail_price ?? undefined,
    defDiscountPrice:      r.def_mudflap_price ?? undefined,
    defTotal:              r.def_total ?? undefined,
    totalCharged:          Number(r.total_charged),
    totalSaved:            r.total_saved == null ? 0 : Number(r.total_saved),
    paymentLast4:          r.payment_last4 ?? undefined,
    legacyFormResponseId:  r.form_response_id ?? undefined,
  };
}

async function postBatch(payload: ImportPayload): Promise<ImportResult> {
  // Prefer the API key when both are set — it doesn't expire mid-run.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (FLEETCAL_API_KEY) {
    headers["X-Api-Key"] = FLEETCAL_API_KEY;
  } else if (FLEETCAL_CLERK_BEARER) {
    headers["Authorization"] = `Bearer ${FLEETCAL_CLERK_BEARER}`;
  }

  const res = await fetch(`${FLEETCAL_API_URL}/v1/fuel-transactions/import`, {
    method: "POST",
    headers,
    body:   JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`fleetcal import ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as ImportResult;
}

async function main() {
  console.log("Fetching old fuel_transactions…");
  const rows = await fetchAllOldRows();
  console.log(`  total: ${rows.length}`);

  // Batch into 200-row chunks so a single Resend / timeout failure
  // doesn't wipe progress. The server caps at 1000 anyway.
  const BATCH_SIZE = 200;
  let inserted = 0;
  let duplicates = 0;
  const failed: Array<{ providerTransactionId: string; error: string }> = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const payload: ImportPayload = {
      transactions: slice.map(toPayloadRow),
    };
    process.stdout.write(`Posting batch ${Math.floor(i / BATCH_SIZE) + 1} (${slice.length} rows)… `);
    const result = await postBatch(payload);
    console.log(`+${result.inserted} new, ${result.duplicates} dup, ${result.failed.length} failed`);
    inserted   += result.inserted;
    duplicates += result.duplicates;
    failed.push(...result.failed);
  }

  console.log(`\nDone.\n  inserted:   ${inserted}\n  duplicates: ${duplicates}\n  failed:     ${failed.length}`);
  if (failed.length > 0) {
    console.log("\nFailed rows:");
    for (const f of failed.slice(0, 20)) {
      console.log(`  ${f.providerTransactionId}: ${f.error}`);
    }
    if (failed.length > 20) console.log(`  …and ${failed.length - 20} more`);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
