/**
 * Mudflap Carriers API sandbox / comparison tool.
 *
 * Pulls fuel_purchases from the Mudflap API for a date range, maps
 * each row to the shape we'd insert into fuel_transactions, and
 * compares against existing FleetCal data so you can verify:
 *   - Are the transactions we already have from email parsing
 *     identifiable in the API response?
 *   - Do total_charged, gallons, etc. match?
 *   - Do vehicle_identifiers actually populate (Jan 12 2026 addition)?
 *   - How many transactions could we auto-link to assets via
 *     vehicle_number / license_plate / vin?
 *
 * No writes. Pure read + diff.
 *
 * Run
 * ---
 *   cd apps/api
 *   MUDFLAP_CARRIERS_TOKEN=xyz \
 *   MUDFLAP_CARRIERS_BASE_URL=https://carriers-api.sandbox.mudflapinc.com/v1 \
 *     npx tsx src/scripts/mudflap-sandbox.ts \
 *       --from=2026-05-01 --to=2026-06-15 \
 *       --org=org_3Ck09w6LuEjiX4WgxJEPyiyjuXN
 *
 * Defaults:
 *   --from = 7 days ago
 *   --to   = today
 *   --org  = Curzon prod
 *   base   = production carriers-api URL (override with env)
 *
 * Optional:
 *   --verbose      print every transaction, not just mismatches
 *   --json=path    dump the raw API responses to a file for offline
 *                  inspection (useful for sharing with Mudflap support)
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";

// ── Args ────────────────────────────────────────────────────────────────
const argFrom    = process.argv.find(a => a.startsWith("--from="))?.slice("--from=".length);
const argTo      = process.argv.find(a => a.startsWith("--to="))?.slice("--to=".length);
const argOrg     = process.argv.find(a => a.startsWith("--org="))?.slice("--org=".length);
const argVerbose = process.argv.includes("--verbose");
const argJson    = process.argv.find(a => a.startsWith("--json="))?.slice("--json=".length);

const DEFAULT_ORG_ID = "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN";

function pad(n: number): string { return String(n).padStart(2, "0"); }
function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function daysAgoUtc(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const FROM   = argFrom ?? daysAgoUtc(7);
const TO     = argTo   ?? todayUtc();
const ORG_ID = argOrg  ?? DEFAULT_ORG_ID;

// ── Env ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MUDFLAP_TOKEN = process.env.MUDFLAP_CARRIERS_TOKEN;
const MUDFLAP_BASE  = process.env.MUDFLAP_CARRIERS_BASE_URL
  ?? "https://carriers-api.mudflapinc.com/v1";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
if (!MUDFLAP_TOKEN) {
  console.error("Missing MUDFLAP_CARRIERS_TOKEN in env. Export it and re-run.");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const sb = createClient(SUPABASE_URL!, SERVICE_KEY!, { auth: { persistSession: false } });

// ── Mudflap response types (per Jan 12 2026 docs) ──────────────────────
interface MudflapMerchant {
  name?:     string;
  category?: string;
  city?:     string;
  state?:    string;
  zip?:      string;
}
interface MudflapVehicleIdentifiers {
  dot_number?:     string;
  license_plate?:  string;
  vehicle_number?: string;
  vin?:            string;
}
interface MudflapTransaction {
  transaction_id:        string;
  status:                string;
  purchased_at:          string;  // ISO8601
  posted_at:             string | null;
  fuel_type:             string;
  retail_price:          number;  // cents
  mudflap_price:         number;  // cents
  quantity:              number;  // gallons
  quantity_unit:         string;
  fuel_total_amount:     number;  // cents
  non_fuel_total_amount: number;  // cents
  total_cost:            number;  // cents
  amount_saved:          number;  // cents
  merchant?:             MudflapMerchant;
  card_id?:              string;
  card_last4?:           string;
  printed_card_id?:      string;
  vehicle_identifiers?:  MudflapVehicleIdentifiers | null;
}
interface MudflapPage {
  data:        MudflapTransaction[];
  page:        string | number;
  total_pages: string | number;
}

// ── Fetch all pages ─────────────────────────────────────────────────────
async function fetchAllPages(from: string, to: string): Promise<MudflapTransaction[]> {
  const all: MudflapTransaction[] = [];
  let page = 1;
  // Mudflap caps at 200 per page; use it.
  const PER_PAGE = 200;
  for (;;) {
    const url = new URL(`${MUDFLAP_BASE}/fuel_purchases`);
    url.searchParams.set("start_date", from);
    url.searchParams.set("end_date",   to);
    url.searchParams.set("page",       String(page));
    url.searchParams.set("per_page",   String(PER_PAGE));
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${MUDFLAP_TOKEN}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mudflap ${res.status}: ${text}`);
    }
    const body = await res.json() as MudflapPage;
    all.push(...body.data);
    const totalPages = Number(body.total_pages);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
    page++;
  }
  return all;
}

// ── FleetCal lookups ────────────────────────────────────────────────────
interface FleetcalAsset {
  id:                 number;
  name:               string;
  unit:               string | null;
  license_plate:      string | null;
  license_state:      string | null;
  vin:                string | null;
  motive_vehicle_id:  string | null;
}

async function loadAssets(): Promise<FleetcalAsset[]> {
  const { data, error } = await sb
    .from("assets")
    .select("id, name, unit, license_plate, license_state, vin, motive_vehicle_id")
    .eq("org_id", ORG_ID);
  if (error) throw new Error(`assets fetch: ${error.message}`);
  return (data ?? []) as FleetcalAsset[];
}

interface ExistingFuelTx {
  id:                       string;
  provider_transaction_id:  string;
  transaction_date:         string;
  total_charged:            number | null;
  diesel_gallons:           number | null;
  asset_id:                 number | null;
}

async function loadExistingByProviderIds(providerIds: string[]): Promise<Map<string, ExistingFuelTx>> {
  const map = new Map<string, ExistingFuelTx>();
  if (providerIds.length === 0) return map;
  // Supabase IN limited to a few thousand IDs — chunk to be safe.
  const CHUNK = 1000;
  for (let i = 0; i < providerIds.length; i += CHUNK) {
    const slice = providerIds.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from("fuel_transactions")
      .select("id, provider_transaction_id, transaction_date, total_charged, diesel_gallons, asset_id")
      .eq("org_id", ORG_ID)
      .eq("provider", "mudflap")
      .in("provider_transaction_id", slice);
    if (error) throw new Error(`fuel_transactions fetch: ${error.message}`);
    for (const row of (data ?? []) as ExistingFuelTx[]) {
      map.set(row.provider_transaction_id, row);
    }
  }
  return map;
}

// ── Asset matching: vehicle_number → unit, plate+state, vin ────────────
type MatchSource = "vehicle_number" | "license_plate" | "vin" | "none";
function matchAsset(
  vi: MudflapVehicleIdentifiers | null | undefined,
  assets: FleetcalAsset[],
): { asset: FleetcalAsset | null; source: MatchSource } {
  if (!vi) return { asset: null, source: "none" };
  if (vi.vehicle_number) {
    const a = assets.find(a => a.unit && a.unit.trim().toLowerCase() === vi.vehicle_number!.trim().toLowerCase());
    if (a) return { asset: a, source: "vehicle_number" };
  }
  if (vi.license_plate) {
    const plate = vi.license_plate.trim().toUpperCase().replace(/[\s-]/g, "");
    const a = assets.find(a => a.license_plate && a.license_plate.trim().toUpperCase().replace(/[\s-]/g, "") === plate);
    if (a) return { asset: a, source: "license_plate" };
  }
  if (vi.vin) {
    const vin = vi.vin.trim().toUpperCase();
    const a = assets.find(a => a.vin && a.vin.trim().toUpperCase() === vin);
    if (a) return { asset: a, source: "vin" };
  }
  return { asset: null, source: "none" };
}

// ── Money/format helpers ───────────────────────────────────────────────
function cents(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${(n / 100).toFixed(2)}`;
}
function dollars(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Mudflap sandbox`);
  console.log(`  base    : ${MUDFLAP_BASE}`);
  console.log(`  org     : ${ORG_ID}`);
  console.log(`  window  : ${FROM} → ${TO}`);
  console.log("");

  const transactions = await fetchAllPages(FROM, TO);
  console.log(`Fetched ${transactions.length} transactions from Mudflap.`);

  if (argJson) {
    writeFileSync(argJson, JSON.stringify(transactions, null, 2));
    console.log(`  → dumped raw API response to ${argJson}`);
  }
  if (transactions.length === 0) { console.log("Nothing to compare."); return; }

  const assets = await loadAssets();
  console.log(`Loaded ${assets.length} FleetCal assets for org.`);

  const providerIds = transactions.map(t => t.transaction_id);
  const existing = await loadExistingByProviderIds(providerIds);
  console.log(`Existing fuel_transactions matching provider IDs: ${existing.size} of ${providerIds.length}`);
  console.log("");

  let inDb = 0, notInDb = 0;
  let amountMatches = 0, amountMismatches = 0;
  let matchedByVeh = 0, matchedByPlate = 0, matchedByVin = 0, unmatched = 0;
  let withVehIds = 0;
  let mudflapTotalCents = 0;

  for (const tx of transactions) {
    mudflapTotalCents += tx.total_cost ?? 0;
    if (tx.vehicle_identifiers) withVehIds++;

    const exists = existing.get(tx.transaction_id) ?? null;
    if (exists) inDb++; else notInDb++;

    const amountMatch =
      exists && exists.total_charged != null
        && Math.abs(exists.total_charged - (tx.total_cost / 100)) < 0.01;
    if (exists) {
      if (amountMatch) amountMatches++; else amountMismatches++;
    }

    const { asset, source } = matchAsset(tx.vehicle_identifiers, assets);
    if (source === "vehicle_number") matchedByVeh++;
    else if (source === "license_plate") matchedByPlate++;
    else if (source === "vin") matchedByVin++;
    else unmatched++;

    const interesting = !exists || !amountMatch || (source === "none" && tx.vehicle_identifiers);
    if (argVerbose || interesting) {
      const merchant = [tx.merchant?.name, tx.merchant?.city, tx.merchant?.state].filter(Boolean).join(", ");
      const veh = tx.vehicle_identifiers
        ? `vehicle=${tx.vehicle_identifiers.vehicle_number ?? "—"} plate=${tx.vehicle_identifiers.license_plate ?? "—"} vin=${tx.vehicle_identifiers.vin ?? "—"}`
        : `vehicle_identifiers=null`;
      console.log(`${tx.transaction_id}  ${tx.purchased_at.slice(0,10)}  ${cents(tx.total_cost).padStart(10)}  ${merchant}`);
      console.log(`  ${veh}`);
      if (asset) {
        console.log(`  → asset MATCH: #${asset.unit ?? "?"} ${asset.name} (id=${asset.id}, by ${source})`);
      } else {
        console.log(`  → asset MATCH: NONE`);
      }
      if (exists) {
        if (amountMatch) {
          console.log(`  → existing DB row id=${exists.id} (${dollars(exists.total_charged)} ✓)`);
        } else {
          console.log(`  → existing DB row id=${exists.id} amount MISMATCH: db=${dollars(exists.total_charged)} api=${cents(tx.total_cost)}`);
        }
      } else {
        console.log(`  → existing DB row: NONE (would be a new insert)`);
      }
      console.log("");
    }
  }

  console.log("─────────────────────────── SUMMARY ───────────────────────────");
  console.log(`Total fetched : ${transactions.length}  (${cents(mudflapTotalCents)})`);
  console.log(`Already in DB : ${inDb}  (amount-match: ${amountMatches}, mismatch: ${amountMismatches})`);
  console.log(`Not in DB     : ${notInDb}  (would be new inserts)`);
  console.log("");
  console.log(`Vehicle ids present in payload : ${withVehIds} of ${transactions.length}`);
  console.log(`Asset-linkable                 :`);
  console.log(`    by vehicle_number          : ${matchedByVeh}`);
  console.log(`    by license_plate           : ${matchedByPlate}`);
  console.log(`    by vin                     : ${matchedByVin}`);
  console.log(`    total                      : ${matchedByVeh + matchedByPlate + matchedByVin}`);
  console.log(`Asset-unlinkable               : ${unmatched}  (no identifiers or no FleetCal match)`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
