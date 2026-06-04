/**
 * Shared helper for report-aggregation endpoints: which driver ids
 * should be excluded from KPI rollups?
 *
 * Owner-operators are dispatched normally (loads exist in calendar,
 * accounting, closeout) but their revenue isn't the carrier's own.
 * The Driver row's `exclude_from_reports` boolean flags them; this
 * helper returns the id set for filtering in any consumer endpoint.
 *
 * Used by:
 *   - /v1/reports/loads        (dashboard Total Revenue, loads report)
 *   - /v1/fleet/performance    (leaderboards)
 *   - /v1/payroll/*            (settlement generation)
 *
 * Returned as an array (cheaper to join in PostgREST filters than a
 * Set) and a Set for callers that need to filter in TS after fetch.
 */

import { supabase } from "./supabase.js";

export interface ExcludedDrivers {
  ids:    number[];
  idSet:  Set<number>;
  /** Names captured for legacy events where driver_id may be NULL but
   *  the older `driver_name` text column still matches. Modern writes
   *  set driver_id so the id filter is enough for current data — names
   *  are belt-and-braces for old rows. */
  names:  string[];
  nameSet: Set<string>;
}

export async function loadExcludedDrivers(orgId: string): Promise<ExcludedDrivers> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("drivers")
    .select("id, name")
    .eq("org_id", orgId)
    .eq("exclude_from_reports", true);
  if (error) {
    console.error("[reportExclusions] driver fetch failed:", error);
    return { ids: [], idSet: new Set(), names: [], nameSet: new Set() };
  }
  const rows = (data ?? []) as Array<{ id: number; name: string | null }>;
  const ids   = rows.map(r => r.id);
  const names = rows.map(r => (r.name ?? "").trim()).filter(n => n.length > 0);
  return {
    ids,
    idSet:   new Set(ids),
    names,
    nameSet: new Set(names),
  };
}

/**
 * Predicate for filtering an event row by the excluded set. Checks
 * driver_id first (modern path); falls back to driver_name for legacy
 * rows whose FK was never backfilled.
 */
export function isExcludedEvent(
  ex: ExcludedDrivers,
  ev: { driver_id?: number | null; driver_name?: string | null },
): boolean {
  if (ev.driver_id != null && ex.idSet.has(ev.driver_id)) return true;
  if (ev.driver_name && ex.nameSet.has(ev.driver_name.trim())) return true;
  return false;
}
