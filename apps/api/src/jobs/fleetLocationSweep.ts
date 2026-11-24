/**
 * Fleet location sweep — trailer AND truck positions.
 *
 * Polls Motive's two bulk location endpoints and appends one row per
 * distinct GPS fix to trailer_location_samples and
 * vehicle_location_samples, for every org that has a Motive key.
 *
 * WHY THIS EXISTS. The live map already reads both endpoints, so
 * "where is it now" needs no cron. Two questions do:
 *
 *   How long has this trailer been sitting there? — the question
 *   behind a trailer going missing. A parked trailer pings exactly
 *   like a moving one; the only difference is yesterday's position.
 *
 *   Which trailer is this truck pulling? — dispatch records both
 *   sides on only 26% of loads (225 of 855 in the 30 days to
 *   2026-11-23), so for three loads in four nobody wrote it down. A
 *   truck and the trailer behind it hold the same position while
 *   moving, so the pairing is recoverable — but only from history,
 *   because co-location in a yard means nothing and a stale fix means
 *   less than nothing.
 *
 * Neither is backfillable. The hour we don't collect is gone.
 *
 * IDEMPOTENT BY CONSTRUCTION. Both inserts conflict on the owner plus
 * Motive's timestamp for the fix, not ours for the request. A tracker
 * reporting every 8 hours contributes one row per 8 hours however
 * often this runs, so a double-fire from a second replica, a retry or
 * a manual run writes nothing.
 *
 * CADENCE IS SET BY THE GATEWAY, NOT BY US. Two snapshots of Curzon's
 * fleet 2.1 minutes apart (2026-11-23) showed 10 of 30 trailers had
 * already produced a new fix in that window — one of them 3,658 m
 * further along, about 68 mph — while the other 20 sat on fixes
 * 25–470 minutes old. A trailer gateway reports every 1–2 minutes
 * while rolling and powers down when parked; its own check-in rate on
 * battery is 8 hours. The sweep runs every 5 minutes, which traces a
 * route to about 5 miles at highway speed and costs nothing for the
 * trailers that are standing still, since the dedupe key rejects
 * their repeats.
 *
 * DO NOT TRUST last_location.moving. In that same sample all 30
 * assets reported moving=false, the 68 mph one included. The flag is
 * stored for reference; motion is derived from distance over time
 * between consecutive fixes instead.
 */

import { supabase } from "../lib/supabase.js";

// Supabase's generated types lag the migrations, and trailers.active_to
// is already missing from them. Cast at the point of use rather than
// casting `supabase` for the whole file — a file-wide `as any` would
// also switch off the column-name checking that catches a typo in an
// INSERT payload, which is exactly the protection worth keeping here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trailerSamples = () => (supabase as any).from("trailer_location_samples");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vehicleSamples = () => (supabase as any).from("vehicle_location_samples");

interface DbTrailerRow { id: number; motive_vehicle_id: string | null; active_to: string | null }
interface DbAssetRow   { id: number; motive_vehicle_id: string | null; hidden: boolean | null }

/** /v1/asset_locations — GPS hangs off asset_gateway.last_location,
 *  and the address field is `address` or sometimes
 *  `formatted_address`, never `description`. */
interface MotiveAssetRow {
  asset: {
    id: number | string;
    asset_gateway?: {
      last_location?: {
        address?: string | null; formatted_address?: string | null;
        lat?: number | null; lon?: number | null;
        located_at?: string | null; moving?: boolean;
      } | null;
    } | null;
  };
}

/** /v1/vehicle_locations — a different shape again: the GPS is at
 *  vehicle.current_location and the label IS called `description`
 *  here. Matches the parser in routes/driver.ts. */
interface MotiveVehicleRow {
  vehicle: {
    id: number | string;
    current_location?: {
      description?: string | null;
      lat?: number | null; lon?: number | null;
      located_at?: string | null;
    } | null;
  };
}

export interface PassResult {
  /** Rows Motive returned, across all pages. */
  fetched:    number;
  /** Of those, how many mapped to a live record in this org. */
  matched:    number;
  /** Rows the insert accepted — fixes we had not seen. */
  inserted:   number;
  /** Rows the unique key rejected: the tracker had not moved on. */
  duplicates: number;
  error?:     string;
}

export interface FleetLocationOrgResult {
  orgId:    string;
  trailers: PassResult;
  vehicles: PassResult;
}

export interface FleetLocationSweepResult {
  orgs:   FleetLocationOrgResult[];
  pruned: number;
}

const empty = (): PassResult => ({ fetched: 0, matched: 0, inserted: 0, duplicates: 0 });

// Motive caps per_page at 100 on these endpoints and pages from 1. A
// sweep that writes history cannot take the one-page shortcut the
// live map routes take, so it follows pages until one comes back
// short.
const PER_PAGE = 100;
const MAX_PAGES = 25;

// Two years. At 5-minute resolution for the units actually rolling
// this stays well under a few hundred MB, so it's a ceiling rather
// than a budget — long enough that "where was this trailer last
// winter" is still a question with an answer.
const RETENTION_DAYS = Number(process.env.TRAILER_LOCATION_RETENTION_DAYS ?? 730);

// Retention is a slow-moving concern and the sweep runs every five
// minutes, so pruning on every pass would be 288 pointless deletes a
// day. Once an hour is plenty.
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

async function fetchPaged<T>(url: string, apiKey: string, pick: (j: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page_no=${page}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`${url} responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const rows = pick(await res.json());
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

async function sweepTrailers(orgId: string, apiKey: string): Promise<PassResult> {
  const result = empty();

  // Retired trailers are skipped: their tracker may still report from
  // wherever the trailer was sold, and that is not history worth
  // keeping.
  const { data, error } = await supabase
    .from("trailers")
    .select("id, motive_vehicle_id, active_to")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (error) { result.error = `trailers read failed: ${error.message}`; return result; }

  const byMotiveId = new Map<string, number>();
  for (const t of (data ?? []) as unknown as DbTrailerRow[]) {
    if (t.active_to || !t.motive_vehicle_id) continue;
    byMotiveId.set(String(t.motive_vehicle_id), t.id);
  }
  if (byMotiveId.size === 0) return result;

  let assets: MotiveAssetRow[];
  try {
    assets = await fetchPaged<MotiveAssetRow>(
      "https://api.keeptruckin.com/v1/asset_locations", apiKey,
      j => (j as { assets?: MotiveAssetRow[] }).assets ?? [],
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  result.fetched = assets.length;

  const rows: Array<Record<string, unknown>> = [];
  for (const row of assets) {
    const trailerId = byMotiveId.get(String(row.asset.id));
    if (trailerId == null) continue;
    result.matched++;
    const loc = row.asset.asset_gateway?.last_location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") continue;
    // No located_at means we can't place the fix in time, and
    // substituting now() would invent a fix that never happened — the
    // exact lie that would make "parked since" wrong.
    if (!loc.located_at) continue;
    rows.push({
      org_id: orgId, trailer_id: trailerId,
      lat: loc.lat, lon: loc.lon,
      address: loc.address ?? loc.formatted_address ?? null,
      located_at: loc.located_at,
      moving: loc.moving ?? null,
    });
  }
  if (rows.length === 0) return result;

  const { data: ins, error: insErr } = await trailerSamples()
    .upsert(rows, { onConflict: "trailer_id,located_at", ignoreDuplicates: true })
    .select("id");
  if (insErr) { result.error = `trailer insert failed: ${insErr.message}`; return result; }
  result.inserted   = ins?.length ?? 0;
  result.duplicates = rows.length - result.inserted;
  return result;
}

async function sweepVehicles(orgId: string, apiKey: string): Promise<PassResult> {
  const result = empty();

  const { data, error } = await supabase
    .from("assets")
    .select("id, motive_vehicle_id, hidden")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (error) { result.error = `assets read failed: ${error.message}`; return result; }

  const byMotiveId = new Map<string, number>();
  for (const a of (data ?? []) as unknown as DbAssetRow[]) {
    if (a.hidden || !a.motive_vehicle_id) continue;
    byMotiveId.set(String(a.motive_vehicle_id), a.id);
  }
  if (byMotiveId.size === 0) return result;

  let vehicles: MotiveVehicleRow[];
  try {
    vehicles = await fetchPaged<MotiveVehicleRow>(
      "https://api.keeptruckin.com/v1/vehicle_locations", apiKey,
      j => (j as { vehicles?: MotiveVehicleRow[] }).vehicles ?? [],
    );
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  result.fetched = vehicles.length;

  const rows: Array<Record<string, unknown>> = [];
  for (const row of vehicles) {
    const assetId = byMotiveId.get(String(row.vehicle.id));
    if (assetId == null) continue;
    result.matched++;
    const loc = row.vehicle.current_location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") continue;
    if (!loc.located_at) continue;
    rows.push({
      org_id: orgId, asset_id: assetId,
      lat: loc.lat, lon: loc.lon,
      address: loc.description ?? null,
      located_at: loc.located_at,
    });
  }
  if (rows.length === 0) return result;

  const { data: ins, error: insErr } = await vehicleSamples()
    .upsert(rows, { onConflict: "asset_id,located_at", ignoreDuplicates: true })
    .select("id");
  if (insErr) { result.error = `vehicle insert failed: ${insErr.message}`; return result; }
  result.inserted   = ins?.length ?? 0;
  result.duplicates = rows.length - result.inserted;
  return result;
}

export async function runFleetLocationSweep(): Promise<FleetLocationSweepResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgs } = await (supabase as any)
    .from("org_settings")
    .select("org_id, motive_api_key")
    .not("motive_api_key", "is", null);

  const results: FleetLocationOrgResult[] = [];
  for (const row of (orgs ?? []) as Array<{ org_id: string; motive_api_key: string | null }>) {
    if (!row.motive_api_key) continue;
    // Sequential, not parallel: the two endpoints share one API key
    // and one rate limit, and nothing here is in a hurry.
    const trailers = await sweepTrailers(row.org_id, row.motive_api_key);
    const vehicles = await sweepVehicles(row.org_id, row.motive_api_key);
    results.push({ orgId: row.org_id, trailers, vehicles });
  }

  // Prune last, and globally rather than per-org: retention is a
  // property of the tables, not of a tenant.
  let pruned = 0;
  if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    for (const table of [trailerSamples, vehicleSamples]) {
      const { data: gone, error } = await table().delete().lt("located_at", cutoff).select("id");
      if (error) console.error("[fleet-locations] prune failed:", error.message);
      pruned += gone?.length ?? 0;
    }
  }

  return { orgs: results, pruned };
}
