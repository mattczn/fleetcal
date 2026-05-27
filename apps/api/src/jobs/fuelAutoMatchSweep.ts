/**
 * Periodic fuel auto-match sweep.
 *
 * Re-attempts auto-matching for every unmatched fuel_transaction
 * within the past 24 hours, across all orgs. Catches the cases
 * where the inline matcher (at /inbound-email ingest time) missed:
 *
 *   • Driver hadn't filed a report yet when the card transaction
 *     arrived — Mudflap polls every ~30 min so the receipt lands
 *     in FleetCal up to 30 min after the actual fuel-up; the driver
 *     report might still be in flight.
 *
 *   • Driver filed AFTER the transaction was ingested (entered on
 *     a delay, or a dispatcher submitting on the driver's behalf).
 *
 *   • The inline match transiently failed (DB hiccup, candidate
 *     fetch error) — the sweep is a safety net.
 *
 * The job is idempotent: matched rows are filtered out by the
 * `match_status = 'unmatched'` predicate, so subsequent runs over
 * the same 24h window do no extra work for already-paired fuel-ups.
 *
 * Runs on a 15-minute interval (set up in apps/api/src/index.ts).
 * 15 min is half the Mudflap polling cadence, so a freshly-ingested
 * transaction is never more than ~15 min away from its second
 * matching attempt.
 *
 * Why not a database trigger: the matcher needs joined data
 * (drivers.name, assets.unit) and a scoring threshold — easier to
 * keep in TS than a stored proc, and easier to evolve the scoring
 * function without a migration.
 */

import { supabase as supabaseTyped } from "../lib/supabase.js";
import { applyAutoMatch, type FuelTxForMatch } from "../lib/fuelMatcher.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const LOOKBACK_HOURS = 24;

export interface FuelAutoMatchSweepResult {
  scanned: number;
  matched: number;
  /** Per-org breakdown for the log line. */
  byOrg:   Record<string, { scanned: number; matched: number }>;
}

export async function runFuelAutoMatchSweep(): Promise<FuelAutoMatchSweepResult> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  // Cross-org fetch (we use the service-role supabase client server-side,
  // RLS isn't relied on for org scoping in this app). Filter by:
  //   • unmatched only (auto/manual/no_match_needed already settled)
  //   • last 24h created_at (recent activity window)
  //   • soft-delete check (deleted_at is null)
  const { data, error } = await supabase
    .from("fuel_transactions")
    .select(
      "id, org_id, transaction_date, driver_name, matched_truck, diesel_gallons, created_at",
    )
    .eq("match_status", "unmatched")
    .is("deleted_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    console.error("[fuel auto-match sweep] candidate fetch failed:", error);
    return { scanned: 0, matched: 0, byOrg: {} };
  }

  const rows = (data ?? []) as FuelTxForMatch[];
  if (rows.length === 0) {
    return { scanned: 0, matched: 0, byOrg: {} };
  }

  const byOrg: Record<string, { scanned: number; matched: number }> = {};
  let matched = 0;

  // Process serially — the candidate-fetch query inside applyAutoMatch
  // is per-org per-transaction and isn't trivial. Running serial keeps
  // the DB load predictable. At 500 rows / 15 min that's ~33 transactions/
  // min in the worst case, well under any reasonable budget.
  for (const r of rows) {
    const bucket = (byOrg[r.org_id] ??= { scanned: 0, matched: 0 });
    bucket.scanned++;
    try {
      const result = await applyAutoMatch(r.org_id, r.id, r);
      if (result.status === "auto_matched") {
        bucket.matched++;
        matched++;
      }
    } catch (err) {
      console.warn(`[fuel auto-match sweep] org=${r.org_id} tx=${r.id} threw:`, err);
    }
  }

  return { scanned: rows.length, matched, byOrg };
}
