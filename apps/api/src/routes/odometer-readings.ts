/**
 * /v1/odometer-readings — source-agnostic odometer storage surface.
 *
 * Reads ride on the same table the Motive cron writes to
 * (motive_odometer_readings — table name kept for backward compat
 * even though the data is no longer Motive-only after the 20260529
 * migration). New writers go through this route.
 *
 * Endpoints:
 *   POST /import   — bulk historical / one-off import. Auth: Clerk
 *                    OR X-Api-Key with scope 'odometer.import'.
 *                    See BulkImportOdometerReadingsRequest in the
 *                    @fleetcal/types api.ts for shape.
 *
 * Note: GET / READ paths live in routes/assets.ts (per-asset profile
 * chart) and routes/movements.ts (calendar movement rail). Those
 * already query the table directly.
 */

import { Hono } from "hono";
import type {
  BulkImportOdometerReadingsRequest,
  BulkImportOdometerReadingsResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// motive_odometer_readings.asset_id + source columns aren't in the
// generated Database types until after the migration applies. Cast
// through any so this file compiles in CI before that lands.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const odoApiKey = new Hono<{ Variables: AuthVariables }>();
const odoClerk  = new Hono<{ Variables: AuthVariables }>();

// ── Active-window helpers ──────────────────────────────────────────────

/** "YYYY-MM-DD" for a Date in UTC. The asset's activeFrom/activeTo
 *  are stored as date-only strings, so we compare via the same shape. */
function utcDateKey(iso: string): string {
  return iso.slice(0, 10);
}

function isWithinActiveWindow(
  activeFrom: string | null,
  activeTo:   string | null,
  capturedDateKey: string,
): boolean {
  const from = activeFrom ?? "0000-01-01";
  const to   = activeTo   ?? "9999-12-31";
  return from <= capturedDateKey && capturedDateKey <= to;
}

// ── Shared handler ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bulkImportHandler(c: any): Promise<Response> {
  const orgId = c.get("orgId");
  const body  = (await c.req.json().catch(() => null)) as BulkImportOdometerReadingsRequest | null;
  if (!body || !Array.isArray(body.readings) || body.readings.length === 0) {
    return c.json({ error: "bad_request", detail: "readings[] required" } satisfies ApiErrorResponse, 400);
  }
  if (body.readings.length > 2000) {
    return c.json({ error: "bad_request", detail: "batch limited to 2000 readings" } satisfies ApiErrorResponse, 400);
  }

  // Resolve asset_id for every row up-front. Two paths:
  //   • Row carries assetId → validate it belongs to this org + grab
  //     its active window in one batched lookup.
  //   • Row carries motiveVehicleId → look up the asset via
  //     assets.motive_vehicle_id (also a batched query) + use it.
  //
  // We do the lookups in two passes so a single 2000-row batch
  // doesn't fire 2000 queries.
  const wantedAssetIds  = new Set<number>();
  const wantedMotiveIds = new Set<string>();
  const wantedUnits     = new Set<string>();
  for (const r of body.readings) {
    if (r.assetId)              wantedAssetIds.add(r.assetId);
    else if (r.motiveVehicleId) wantedMotiveIds.add(String(r.motiveVehicleId));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    else if ((r as any).unit)   wantedUnits.add(String((r as any).unit));
  }

  type AssetInfo = {
    id:           number;
    motive_id:    string | null;
    unit:         string | null;
    active_from:  string | null;
    active_to:    string | null;
  };
  const assetById       = new Map<number, AssetInfo>();
  const assetByMotiveId = new Map<string, AssetInfo>();
  const assetByUnit     = new Map<string, AssetInfo>();

  function indexAsset(a: { id: number; motive_vehicle_id: string | null; unit: string | null; active_from: string | null; active_to: string | null }) {
    const info: AssetInfo = {
      id:          a.id,
      motive_id:   a.motive_vehicle_id,
      unit:        a.unit,
      active_from: a.active_from,
      active_to:   a.active_to,
    };
    assetById.set(a.id, info);
    if (a.motive_vehicle_id) assetByMotiveId.set(a.motive_vehicle_id, info);
    if (a.unit)              assetByUnit.set(a.unit, info);
  }

  if (wantedAssetIds.size > 0) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, motive_vehicle_id, unit, active_from, active_to")
      .eq("org_id", orgId)
      .in("id", Array.from(wantedAssetIds));
    if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    for (const a of (data ?? []) as Array<{ id: number; motive_vehicle_id: string | null; unit: string | null; active_from: string | null; active_to: string | null }>) {
      indexAsset(a);
    }
  }
  if (wantedMotiveIds.size > 0) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, motive_vehicle_id, unit, active_from, active_to")
      .eq("org_id", orgId)
      .in("motive_vehicle_id", Array.from(wantedMotiveIds));
    if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    for (const a of (data ?? []) as Array<{ id: number; motive_vehicle_id: string | null; unit: string | null; active_from: string | null; active_to: string | null }>) {
      indexAsset(a);
    }
  }
  if (wantedUnits.size > 0) {
    const { data, error } = await supabase
      .from("assets")
      .select("id, motive_vehicle_id, unit, active_from, active_to")
      .eq("org_id", orgId)
      .in("unit", Array.from(wantedUnits));
    if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    for (const a of (data ?? []) as Array<{ id: number; motive_vehicle_id: string | null; unit: string | null; active_from: string | null; active_to: string | null }>) {
      indexAsset(a);
    }
  }

  let inserted    = 0;
  let duplicates  = 0;
  let outOfWindow = 0;
  const failed: BulkImportOdometerReadingsResponse["failed"] = [];

  for (const r of body.readings) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unitVal = (r as any).unit ? String((r as any).unit) : null;
    const identifier = r.assetId
      ? `asset:${r.assetId}@${r.capturedAt}`
      : r.motiveVehicleId
        ? `motive:${r.motiveVehicleId}@${r.capturedAt}`
        : unitVal
          ? `unit:${unitVal}@${r.capturedAt}`
          : `(no id)@${r.capturedAt}`;

    // Resolve asset.
    let asset: AssetInfo | undefined;
    if (r.assetId)              asset = assetById.get(r.assetId);
    else if (r.motiveVehicleId) asset = assetByMotiveId.get(String(r.motiveVehicleId));
    else if (unitVal)           asset = assetByUnit.get(unitVal);

    if (!asset) {
      failed.push({ identifier, error: "asset not found in this org" });
      continue;
    }

    // Active-window check. Readings before the asset existed or
    // after retirement get skipped — they're noise, not signal.
    const capturedDay = utcDateKey(r.capturedAt);
    if (!isWithinActiveWindow(asset.active_from, asset.active_to, capturedDay)) {
      outOfWindow++;
      continue;
    }

    // Dedup probe — same asset, same calendar day in UTC.
    // The existing index (vehicle_id, captured_at DESC) covers Motive
    // sourced rows; for asset-keyed rows we lean on the new
    // (asset_id, captured_at) index added in 20260529.
    const dayStart = new Date(capturedDay + "T00:00:00.000Z").toISOString();
    const dayEnd   = new Date(capturedDay + "T23:59:59.999Z").toISOString();
    const { data: existing } = await supabase
      .from("motive_odometer_readings")
      .select("id")
      .eq("org_id", orgId)
      .eq("asset_id", asset.id)
      .gte("captured_at", dayStart)
      .lte("captured_at", dayEnd)
      .limit(1)
      .maybeSingle();
    if (existing) { duplicates++; continue; }

    const insertRow = {
      org_id:               orgId,
      asset_id:             asset.id,
      vehicle_id:           asset.motive_id ? Number(asset.motive_id) : (r.motiveVehicleId ?? null),
      vehicle_number:       r.vehicleNumber ?? asset.unit ?? null,
      odometer_miles:       r.odometerMiles,
      true_odometer_miles:  r.trueOdometerMiles ?? r.odometerMiles,
      located_at:           r.locatedAt ?? r.capturedAt,
      captured_at:          r.capturedAt,
      source:               "import",
    };

    const { error } = await supabase
      .from("motive_odometer_readings")
      .insert(insertRow);
    if (error) {
      failed.push({ identifier, error: error.message });
      continue;
    }
    inserted++;
  }

  const res: BulkImportOdometerReadingsResponse = { inserted, duplicates, outOfWindow, failed };
  return c.json(res);
}

// ── Mounted handlers ──────────────────────────────────────────────────

odoApiKey.post("/import", requireApiKey("odometer.import"), bulkImportHandler);

odoClerk.use("*", requireModule("fuel"), requireCapability("fuel.access"));
odoClerk.post("/import", bulkImportHandler);

export { odoApiKey, odoClerk };

const odometerReadings = odoClerk;
export default odometerReadings;
