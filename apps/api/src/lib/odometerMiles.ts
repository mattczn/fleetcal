/**
 * Fleet odometer miles for a period — the one definition behind the
 * dashboard's Total Miles card (/v1/movements/odometer-summary), the
 * weekly target's actual miles / MPG / empty factor (lib/weeklyTarget)
 * and the Truck Profit grid (lib/truckProfit).
 *
 * Motive odometer readings arrive about once a day (≈6:50 pm Denver), so
 * a period is counted reading to reading: the steps between consecutive
 * readings that END inside the period, starting from the last reading
 * before it. Taking only the readings inside the period would drop a
 * day — a Sat–Fri week's readings run Sat evening → Fri evening, 6 steps.
 *
 * Each step must be physically possible (≤ 70 mph over the time between
 * readings): a Penske rental swap moves the ELD to another truck and the
 * odometer jumps tens of thousands of miles overnight. A truck whose
 * odometer froze (ELD lost the ECM) and reads ~0 while its GPS shows it
 * driving gets its GPS movement miles instead, marked 'movements'.
 *
 * Trucks counted: those with a Motive vehicle id, minus owner-operator
 * trucks (default driver excluded from reports) and trucks flagged
 * exclude_from_reports.
 */

import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { loadExcludedAssetIds, loadExcludedDrivers } from "./reportExclusions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const MAX_PLAUSIBLE_MPH = 70;
const MIN_WINDOW_HOURS = 1;
/** How far back to look for the reading the period starts from. */
const BASELINE_LOOKBACK_MS = 48 * 3_600_000;
const ODO_DEAD_THRESHOLD_MI = 1;
const MOVE_REAL_THRESHOLD_MI = 1;
const CHUNK = 150;

export interface FleetOdometerMiles {
  totalMiles: number;
  eldAssetCount: number;
  perAsset: Record<number, number>;
  perAssetSource: Record<number, "odometer" | "movements">;
  skippedJumps: Array<{ assetId: number; from: number; to: number; at: string }>;
}

/** fromIso / toIso: real instants (UTC ISO) bounding the period. */
export async function fleetOdometerMiles(orgId: string, fromIso: string, toIso: string): Promise<FleetOdometerMiles> {
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);

  let eldAssets = await fetchAllRows<{ id: number; motive_vehicle_id: number | string | null }>("odometer assets", () =>
    supabase.from("assets").select("id, motive_vehicle_id").eq("org_id", orgId).not("motive_vehicle_id", "is", null));
  const excluded = await loadExcludedDrivers(orgId);
  if (excluded.ids.length > 0) {
    const { data: prefs } = await supabase.from("driver_asset_prefs").select("asset_id").eq("org_id", orgId).in("driver_id", excluded.ids);
    const ownerOp = new Set(((prefs ?? []) as Array<{ asset_id: number | null }>).map((p) => p.asset_id).filter((v): v is number => v != null));
    eldAssets = eldAssets.filter((a) => !ownerOp.has(a.id));
  }
  const flagged = await loadExcludedAssetIds(orgId);
  eldAssets = eldAssets.filter((a) => !flagged.has(a.id));
  const empty: FleetOdometerMiles = { totalMiles: 0, eldAssetCount: 0, perAsset: {}, perAssetSource: {}, skippedJumps: [] };
  if (!eldAssets.length) return empty;

  const assetIds = eldAssets.map((a) => a.id);
  const vehicleToAsset = new Map(eldAssets.map((a) => [String(a.motive_vehicle_id), a.id]));
  const vehicleIds = [...vehicleToAsset.keys()];
  const since = new Date(fromMs - BASELINE_LOOKBACK_MS).toISOString();

  // Readings by asset_id and by vehicle_id (older Motive rows have no
  // asset_id), deduped by row id.
  type Reading = { id: number; asset_id: number | null; vehicle_id: number | string | null; captured_at: string; odometer_miles: number | null; true_odometer_miles: number | null };
  const sel = "id, asset_id, vehicle_id, captured_at, odometer_miles, true_odometer_miles";
  const reads: Reading[] = [];
  for (let i = 0; i < assetIds.length; i += CHUNK) {
    reads.push(...await fetchAllRows<Reading>("odometer readings (asset)", () => supabase.from("motive_odometer_readings").select(sel)
      .eq("org_id", orgId).in("asset_id", assetIds.slice(i, i + CHUNK)).gte("captured_at", since).lte("captured_at", toIso)));
  }
  for (let i = 0; i < vehicleIds.length; i += CHUNK) {
    reads.push(...await fetchAllRows<Reading>("odometer readings (vehicle)", () => supabase.from("motive_odometer_readings").select(sel)
      .eq("org_id", orgId).in("vehicle_id", vehicleIds.slice(i, i + CHUNK)).gte("captured_at", since).lte("captured_at", toIso)));
  }
  const seen = new Set<number>();
  const points = new Map<number, Array<{ at: number; miles: number }>>();
  for (const r of reads) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const assetId = r.asset_id ?? (r.vehicle_id != null ? vehicleToAsset.get(String(r.vehicle_id)) : undefined);
    const miles = r.true_odometer_miles ?? r.odometer_miles;
    const at = Date.parse(r.captured_at);
    if (assetId == null || miles == null || !Number.isFinite(at)) continue;
    points.set(assetId, [...(points.get(assetId) ?? []), { at, miles: Number(miles) }]);
  }

  const perAsset: Record<number, number> = {};
  const perAssetSource: Record<number, "odometer" | "movements"> = {};
  const skippedJumps: FleetOdometerMiles["skippedJumps"] = [];
  for (const [assetId, pts] of points) {
    pts.sort((a, b) => a.at - b.at);
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      if (cur.at <= fromMs) continue; // step ends before the period
      const step = cur.miles - prev.miles;
      if (step <= 0) continue;
      const hours = Math.max(MIN_WINDOW_HOURS, (cur.at - prev.at) / 3_600_000);
      if (step > hours * MAX_PLAUSIBLE_MPH) {
        skippedJumps.push({ assetId, from: Math.round(prev.miles), to: Math.round(cur.miles), at: new Date(cur.at).toISOString() });
        continue;
      }
      total += step;
    }
    perAsset[assetId] = total;
    perAssetSource[assetId] = "odometer";
  }

  // Frozen odometer: ~0 miles while GPS shows driving → GPS miles.
  const moves: Array<{ id: string; asset_id: number | null; miles: number | null }> = [];
  for (let i = 0; i < assetIds.length; i += CHUNK) {
    moves.push(...await fetchAllRows<{ id: string; asset_id: number | null; miles: number | null }>("odometer fallback movements", () =>
      supabase.from("movements").select("id, asset_id, miles").eq("org_id", orgId).in("asset_id", assetIds.slice(i, i + CHUNK))
        .gte("start_time", fromIso).lte("start_time", toIso))
      .catch(() => []));
  }
  const moved = new Map<number, number>();
  for (const m of moves) if (m.asset_id != null && m.miles != null) moved.set(m.asset_id, (moved.get(m.asset_id) ?? 0) + Number(m.miles));
  for (const id of assetIds) {
    const gps = moved.get(id) ?? 0;
    if ((perAsset[id] ?? 0) <= ODO_DEAD_THRESHOLD_MI && gps > MOVE_REAL_THRESHOLD_MI) {
      perAsset[id] = gps;
      perAssetSource[id] = "movements";
    }
  }

  const totalMiles = Object.values(perAsset).reduce((s, v) => s + v, 0);
  return { totalMiles, eldAssetCount: eldAssets.length, perAsset, perAssetSource, skippedJumps };
}

/** The UTC ISO instant of local midnight starting `day` (YYYY-MM-DD) in tz. */
export function localDayStartIso(day: string, tz: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess))) parts[p.type] = p.value;
  const wallAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (wallAsUtc - guess)).toISOString();
}
