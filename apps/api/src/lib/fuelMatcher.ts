/**
 * Fuel auto-matcher.
 *
 * Pairs a card-side fuel_transaction (ingested from Mudflap email)
 * with a driver-side fuel_report (submitted from the driver app)
 * so each fuel-up becomes one record. The card knows $ + gallons +
 * exact pump location; the driver report knows who/what truck/state.
 *
 * Two consumers:
 *   • routes/fuel-transactions.ts → POST /inbound-email
 *     Runs the matcher inline at ingest. The common case: driver
 *     fueled, filed report at the pump (instant), Mudflap email
 *     arrives 5–30 min later, matcher fires + links the pair.
 *
 *   • jobs/fuelAutoMatchSweep.ts (every 15 min)
 *     Periodically re-scans unmatched transactions from the past
 *     24h. Catches the cases the inline pass missed:
 *       - Driver filed AFTER the transaction was ingested (manual
 *         entry, late upload, dispatch entered on driver's behalf)
 *       - Inline match transiently failed (DB hiccup, timeout)
 *
 * Scoring (max ~100):
 *   • Driver name match (substring either direction):     +50
 *   • Asset / truck unit match:                           +30
 *   • Diesel gallons within ±5%:                          +15
 *   • Date proximity (same day = +5, ±1 = +3, ±2 = +1):   up to +5
 *
 * Threshold ≥70 → auto_matched. Lower → unmatched (dispatch decides
 * via the manual-match UI on Equipment → Fuel).
 *
 * Note: the name on a receipt may NOT be the driver who actually
 * fueled (e.g. an owner-operator swipes the card for the actual
 * driver). We don't have a clean way to detect that automatically,
 * so for the rare buy-on-behalf case dispatch manually links via
 * the UI.
 */

import type { FuelTransactionMatchStatus } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";

// fuel_transactions / fuel_reports schema isn't in generated types
// until migrations re-generate. Stay `any` here too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

// ── Types ─────────────────────────────────────────────────────────────

/** Minimal row shape the matcher needs. Mirrors the columns the
 *  matcher actually reads — keeps the lib decoupled from the route's
 *  full FuelTransactionRow. */
export interface FuelTxForMatch {
  id:               string;
  org_id:           string;
  transaction_date: string;
  driver_name:      string | null;
  matched_truck:    string | null;
  diesel_gallons:   number | null;
}

interface FuelReportCandidate {
  id:              string;
  reported_at:     string;
  driver_id:       number;
  asset_id:        number;
  diesel_gallons:  number;
  driver_name?:    string;   // joined
  asset_unit?:     string;   // joined
}

// ── Scoring ──────────────────────────────────────────────────────────

/** Day-difference between a date-only string ("YYYY-MM-DD") and a
 *  full ISO timestamp. Anchored to UTC to avoid TZ surprises. */
function dayDiff(txDate: string, reportedAt: string): number {
  const t = new Date(txDate).getTime();
  const r = new Date(reportedAt).getTime();
  if (isNaN(t) || isNaN(r)) return Number.POSITIVE_INFINITY;
  return Math.abs(t - r) / 86_400_000;
}

export function scoreMatch(tx: FuelTxForMatch, r: FuelReportCandidate): number {
  let score = 0;

  // Driver name (case-insensitive substring either direction)
  if (tx.driver_name && r.driver_name) {
    const txN = tx.driver_name.toLowerCase();
    const rN  = r.driver_name.toLowerCase();
    if (txN === rN || txN.includes(rN) || rN.includes(txN)) score += 50;
  }

  // Asset / truck unit
  if (tx.matched_truck && r.asset_unit && String(tx.matched_truck).trim() === String(r.asset_unit).trim()) {
    score += 30;
  }

  // Diesel gallons within ±5%
  if (tx.diesel_gallons != null && r.diesel_gallons > 0) {
    const diff = Math.abs(Number(tx.diesel_gallons) - r.diesel_gallons) / r.diesel_gallons;
    if (diff <= 0.05) score += 15;
  }

  // Date proximity (calendar days).
  const d = dayDiff(tx.transaction_date, r.reported_at);
  if      (d <= 1) score += 5;
  else if (d <= 2) score += 3;
  else if (d <= 3) score += 1;

  return score;
}

/** Threshold for auto_matched. Exported so the on-demand sweep can
 *  surface "we found N candidate matches under threshold" telemetry. */
export const AUTO_MATCH_THRESHOLD = 70;

// ── Candidate lookup + match application ─────────────────────────────

export async function tryAutoMatch(
  orgId: string,
  txRow: FuelTxForMatch,
): Promise<{ fuelReportId: string; confidence: number; driverId: number | null; assetId: number | null } | null> {
  // Pull candidate reports within ±3 days of the transaction date and
  // still in 'pending' match status. Small windows keep the candidate
  // pool tight even on a busy org.
  const from = new Date(txRow.transaction_date);
  from.setDate(from.getDate() - 3);
  const to = new Date(txRow.transaction_date);
  to.setDate(to.getDate() + 3);

  const { data, error } = await supabase
    .from("fuel_reports")
    .select("id, reported_at, driver_id, asset_id, diesel_gallons, drivers!inner(name), assets!inner(unit)")
    .eq("org_id", orgId)
    .eq("match_status", "pending")
    .gte("reported_at", from.toISOString())
    .lte("reported_at", to.toISOString())
    .limit(200);
  if (error) {
    console.warn("[fuel auto-match] candidate fetch failed:", error);
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: FuelReportCandidate[] = (data ?? []).map((r: any) => {
    const row = r;
    return {
      id:             row.id,
      reported_at:    row.reported_at,
      driver_id:      row.driver_id,
      asset_id:       row.asset_id,
      diesel_gallons: Number(row.diesel_gallons),
      driver_name:    row.drivers?.name ?? row.drivers?.[0]?.name,
      asset_unit:     row.assets?.unit  ?? row.assets?.[0]?.unit,
    };
  });

  let best: { c: FuelReportCandidate; score: number } | null = null;
  for (const c of candidates) {
    const s = scoreMatch(txRow, c);
    if (!best || s > best.score) best = { c, score: s };
  }
  if (!best || best.score < AUTO_MATCH_THRESHOLD) return null;
  return {
    fuelReportId: best.c.id,
    confidence:   best.score,
    driverId:     best.c.driver_id ?? null,
    assetId:      best.c.asset_id  ?? null,
  };
}

export async function applyAutoMatch(
  orgId: string,
  txId: string,
  txRow: FuelTxForMatch,
): Promise<{ status: FuelTransactionMatchStatus; confidence?: number }> {
  const matched = await tryAutoMatch(orgId, txRow);
  if (!matched) return { status: "unmatched" };

  // Two-sided update — flip both ends of the link in a single round
  // trip. If the report-side update fails we don't roll back; the
  // transaction-side link is still correct from the user's perspective.
  //
  // Mirror the matched report's driver_id + asset_id onto the
  // transaction so the unified panel's dropdowns reflect reality
  // without a join. Existing driver_id/asset_id on the transaction
  // (set via /assign or ingest auto-resolve) are preserved via
  // COALESCE — we don't overwrite a dispatcher's intentional pick.
  const { data: existing } = await supabase
    .from("fuel_transactions")
    .select("driver_id, asset_id")
    .eq("id", txId)
    .eq("org_id", orgId)
    .maybeSingle();
  const existingDriver = existing ? (existing as { driver_id: number | null }).driver_id : null;
  const existingAsset  = existing ? (existing as { asset_id:  number | null }).asset_id  : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase
    .from("fuel_transactions")
    .update({
      fuel_report_id:   matched.fuelReportId,
      match_status:     "auto_matched",
      match_confidence: matched.confidence,
      matched_at:       new Date().toISOString(),
      driver_id:        existingDriver ?? matched.driverId,
      asset_id:         existingAsset  ?? matched.assetId,
    } as any)
    .eq("id", txId)
    .eq("org_id", orgId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase
    .from("fuel_reports")
    .update({
      transaction_id: txId,
      match_status:   "matched",
    } as any)
    .eq("id", matched.fuelReportId)
    .eq("org_id", orgId);

  return { status: "auto_matched", confidence: matched.confidence };
}
