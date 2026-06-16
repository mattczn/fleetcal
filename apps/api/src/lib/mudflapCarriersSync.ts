/**
 * Mudflap Carriers API sync.
 *
 * Pulls fuel_purchases for an org and writes them to fuel_transactions.
 *
 * Asset matching: drivers enter the truck identifier at the pump,
 * Mudflap stores it as `vehicle_identifiers.vehicle_number`. Most
 * fleets line that up with the Motive ELD truck name, which lines
 * up with FleetCal's `assets.unit`. We try (in order):
 *
 *   1. vehicle_number exact → assets.unit
 *   2. vehicle_number first token → assets.unit
 *      (catches "2026 Rodrigo" — driver appended their name)
 *   3. vin → assets.vin
 *   4. license_plate + state → assets.license_plate + assets.license_state
 *
 * After the transaction is inserted, the existing applyAutoMatch
 * runs the driver-fuel-report side of matching — same code path
 * email-ingest already uses.
 *
 * Idempotency: relies on the unique constraint on
 * (org_id, provider, provider_transaction_id). 23505 = already seen,
 * skip and move on. So we can re-run a window without creating dupes.
 *
 * Token: read from MUDFLAP_CARRIERS_TOKEN env var. Single-org for now
 * (Curzon); per-org storage when we add a second customer.
 */

import { supabase } from "./supabase.js";
import { applyAutoMatch } from "./fuelMatcher.js";

const MUDFLAP_BASE =
  process.env.MUDFLAP_CARRIERS_BASE_URL ??
  "https://carriers-api.mudflapinc.com/v1";

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

// ── Fetch all pages ────────────────────────────────────────────────────
async function fetchAllPages(
  token: string,
  from: string,
  to: string,
): Promise<MudflapTransaction[]> {
  const all: MudflapTransaction[] = [];
  let page = 1;
  const PER_PAGE = 200;
  for (;;) {
    const url = new URL(`${MUDFLAP_BASE}/fuel_purchases`);
    url.searchParams.set("start_date", from);
    url.searchParams.set("end_date",   to);
    url.searchParams.set("page",       String(page));
    url.searchParams.set("per_page",   String(PER_PAGE));
    const res = await fetch(url, {
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept:         "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mudflap API ${res.status}: ${text}`);
    }
    const body = await res.json() as MudflapPage;
    all.push(...body.data);
    const totalPages = Number(body.total_pages);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
    page++;
  }
  return all;
}

// ── Asset lookup ───────────────────────────────────────────────────────
interface AssetForMatch {
  id:                  number;
  unit:                string | null;
  vin:                 string | null;
  license_plate:       string | null;
  license_state:       string | null;
  mudflap_card_last4:  string | null;
}

async function loadAssetsForMatch(orgId: string): Promise<AssetForMatch[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("assets")
    .select("id, unit, vin, license_plate, license_state, mudflap_card_last4")
    .eq("org_id", orgId);
  if (error) throw new Error(`assets fetch: ${error.message}`);
  return (data ?? []) as AssetForMatch[];
}

function matchAsset(
  tx: MudflapTransaction,
  assets: AssetForMatch[],
): { assetId: number | null; source: string | null } {
  // 0. card_last4 → mudflap_card_last4 — HIGHEST PRIORITY.
  // The card physically lives in one specific truck; this mapping
  // doesn't depend on the driver typing anything at the pump. Once
  // the dispatcher sets the card last-4 on each asset, this catches
  // every transaction.
  if (tx.card_last4) {
    const wanted = tx.card_last4.trim();
    const c = assets.find(a => a.mudflap_card_last4 && a.mudflap_card_last4.trim() === wanted);
    if (c) return { assetId: c.id, source: "card_last4" };
  }

  const vi = tx.vehicle_identifiers;
  if (!vi) return { assetId: null, source: null };

  // 1. vehicle_number exact → unit
  if (vi.vehicle_number) {
    const wanted = vi.vehicle_number.trim().toLowerCase();
    const exact = assets.find(a => a.unit && a.unit.trim().toLowerCase() === wanted);
    if (exact) return { assetId: exact.id, source: "vehicle_number" };

    // 2. first token → unit (driver appended their name: "2026 Rodrigo")
    const firstToken = wanted.split(/\s+/)[0];
    if (firstToken && firstToken !== wanted) {
      const tok = assets.find(a => a.unit && a.unit.trim().toLowerCase() === firstToken);
      if (tok) return { assetId: tok.id, source: "vehicle_number_token" };
    }
  }

  // 3. vin → vin
  if (vi.vin) {
    const wantedVin = vi.vin.trim().toUpperCase();
    const v = assets.find(a => a.vin && a.vin.trim().toUpperCase() === wantedVin);
    if (v) return { assetId: v.id, source: "vin" };
  }

  // 4. license_plate (normalized) + state → license_plate + license_state
  if (vi.license_plate) {
    const plate = vi.license_plate.trim().toUpperCase().replace(/[\s-]/g, "");
    const p = assets.find(a =>
      a.license_plate &&
      a.license_plate.trim().toUpperCase().replace(/[\s-]/g, "") === plate,
    );
    if (p) return { assetId: p.id, source: "license_plate" };
  }

  return { assetId: null, source: null };
}

// ── Map Mudflap → fuel_transactions insert row ─────────────────────────
type InsertRow = {
  org_id:                   string;
  provider:                 "mudflap_api";
  provider_transaction_id:  string;
  transaction_date:         string;
  driver_name:              string | null;
  location:                 string | null;
  matched_truck:            string | null;
  asset_id:                 number | null;
  diesel_gallons:           number | null;
  diesel_retail_price:      number | null;
  diesel_discount_price:    number | null;
  diesel_total:             number | null;
  def_gallons:              number | null;
  def_retail_price:         number | null;
  def_discount_price:       number | null;
  def_total:                number | null;
  total_charged:            number;
  total_saved:              number;
  payment_last4:            string | null;
};

function mapTransaction(
  orgId: string,
  tx: MudflapTransaction,
  assetId: number | null,
): InsertRow {
  // Mudflap reports cents; our schema stores dollars to 2 decimals.
  const dollars = (cents: number | null | undefined): number | null =>
    cents == null ? null : Math.round(cents) / 100;

  const merchant = [tx.merchant?.name, tx.merchant?.city, tx.merchant?.state]
    .filter(Boolean).join(", ") || null;

  // Distinguish DEF from diesel. fuel_type values per docs:
  // "Regular", "Regular Diesel 2", "Premium Diesel 2", "Def"
  const isDef = tx.fuel_type?.toLowerCase() === "def";

  return {
    org_id:                  orgId,
    // 'mudflap_api' distinguishes API-sourced from 'mudflap' (email).
    // Both providers coexist: email handles fuel-code transactions
    // Mudflap card API never sees, API handles card transactions
    // email never sees. No overlap, no dedup conflicts.
    provider:                "mudflap_api",
    provider_transaction_id: tx.transaction_id,
    // YYYY-MM-DD from purchased_at (UTC). transaction_date is a DATE
    // column in our schema; loss of time is intentional.
    transaction_date:        tx.purchased_at.slice(0, 10),
    // Mudflap doesn't carry a driver name field per Jan 2026 docs.
    // Sometimes drivers type their name into vehicle_number
    // ("2026 Rodrigo"); the matcher handles the truck side but we
    // surface the raw value so it's visible in the UI.
    driver_name:             null,
    location:                merchant,
    matched_truck:           tx.vehicle_identifiers?.vehicle_number ?? null,
    asset_id:                assetId,
    diesel_gallons:          isDef ? null : (tx.quantity ?? null),
    diesel_retail_price:     isDef ? null : dollars(tx.retail_price),
    diesel_discount_price:   isDef ? null : dollars(tx.mudflap_price),
    diesel_total:            isDef ? null : dollars(tx.fuel_total_amount),
    def_gallons:             isDef ? (tx.quantity ?? null) : null,
    def_retail_price:        isDef ? dollars(tx.retail_price) : null,
    def_discount_price:      isDef ? dollars(tx.mudflap_price) : null,
    def_total:               isDef ? dollars(tx.fuel_total_amount) : null,
    total_charged:           dollars(tx.total_cost) ?? 0,
    total_saved:             dollars(tx.amount_saved) ?? 0,
    payment_last4:           tx.card_last4 ?? null,
  };
}

// ── Sync result ────────────────────────────────────────────────────────
export interface MudflapSyncResult {
  fetched:      number;
  inserted:     number;
  duplicates:   number;
  failed:       number;
  assetLinked:  number;
  totalCharged: number;
  /** Reasons for failed rows, capped at 10 to avoid blowing the response. */
  failedSample: Array<{ providerTransactionId: string; error: string }>;
}

// ── Main entry point ───────────────────────────────────────────────────
export async function syncMudflapCarriers(
  orgId: string,
  from: string,
  to: string,
): Promise<MudflapSyncResult> {
  const token = process.env.MUDFLAP_CARRIERS_TOKEN;
  if (!token) {
    throw new Error("MUDFLAP_CARRIERS_TOKEN not set in env");
  }

  const transactions = await fetchAllPages(token, from, to);
  const assets       = await loadAssetsForMatch(orgId);

  let inserted    = 0;
  let duplicates  = 0;
  let failed      = 0;
  let assetLinked = 0;
  let totalCharged = 0;
  const failedSample: MudflapSyncResult["failedSample"] = [];

  for (const tx of transactions) {
    totalCharged += (tx.total_cost ?? 0) / 100;
    const { assetId } = matchAsset(tx, assets);
    if (assetId != null) assetLinked++;

    const row = mapTransaction(orgId, tx, assetId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted_row, error } = await (supabase as any)
      .from("fuel_transactions")
      .insert(row)
      .select("id, org_id, provider, provider_transaction_id, transaction_date, driver_name, location, matched_truck, driver_id, asset_id, diesel_gallons, diesel_retail_price, diesel_discount_price, diesel_total, def_gallons, def_retail_price, def_discount_price, def_total, total_charged, total_saved, payment_last4, fuel_report_id, match_status, match_confidence, match_notes, matched_at, matched_by, legacy_form_response_id, raw_email, created_at, updated_at")
      .single();

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        duplicates++;
        continue;
      }
      failed++;
      if (failedSample.length < 10) {
        failedSample.push({
          providerTransactionId: tx.transaction_id,
          error:                 error.message,
        });
      }
      continue;
    }

    inserted++;

    // Run the existing driver-fuel-report matcher. This is what links
    // a card transaction to a driver's app-submitted fuel report (so
    // payroll can verify per-driver). Same code path the email ingest
    // uses — no need to duplicate.
    try {
      await applyAutoMatch(orgId, inserted_row.id, inserted_row);
    } catch (e) {
      console.error("[mudflapSync] applyAutoMatch failed:", e);
    }
  }

  return {
    fetched:      transactions.length,
    inserted,
    duplicates,
    failed,
    assetLinked,
    totalCharged: Math.round(totalCharged * 100) / 100,
    failedSample,
  };
}
