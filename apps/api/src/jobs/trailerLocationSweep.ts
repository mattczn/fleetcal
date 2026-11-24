/**
 * Trailer location sweep.
 *
 * Polls Motive's bulk asset-locations endpoint and appends one row per
 * distinct GPS fix to trailer_location_samples, for every org that has
 * a Motive key.
 *
 * WHY THIS EXISTS AT ALL. The trailer map already reads the same
 * endpoint live, so "where is this trailer now" needs no cron. What it
 * cannot answer is "how long has it been sitting there" — the question
 * behind a trailer going missing — because that needs yesterday's
 * position, and yesterday's position only exists if something wrote it
 * down yesterday. Nothing here can be backfilled.
 *
 * IDEMPOTENT BY CONSTRUCTION. The insert conflicts on
 * (trailer_id, located_at), which is Motive's timestamp for the fix
 * rather than ours for the request. A tracker that reports every four
 * hours therefore contributes one row per four hours no matter how
 * often this runs, so a double-fire from two replicas, a retry, or a
 * manual run is harmless. It also means the row count tracks real
 * fixes instead of our poll cadence.
 *
 * CADENCE IS SET BY THE GATEWAY, NOT BY US. Two snapshots of Curzon's
 * fleet 2.1 minutes apart (2026-11-23) showed 10 of 30 trailers had
 * already produced a new fix in that window — one of them 3,658 m
 * further along, about 68 mph — while the other 20 sat on fixes
 * 25–470 minutes old. A trailer gateway reports every 1–2 minutes
 * while rolling and powers down when parked. So the sweep runs every
 * 2 minutes (apps/api/src/index.ts) to match what a moving trailer
 * offers, and the dedupe key means a parked one still costs nothing.
 *
 * DO NOT TRUST last_location.moving. In that same sample every one of
 * the 30 assets reported moving=false, the 68 mph one included. The
 * flag is stored for reference; motion is derived from distance over
 * time between consecutive fixes instead.
 */

import { supabase } from "../lib/supabase.js";

// Supabase's generated types lag the migrations: trailer_location_samples
// does not exist in them until they're regenerated, and trailers.active_to
// is already missing from them. Both are cast at the point of use rather
// than by casting `supabase` for the whole file — a file-wide `as any`
// would also switch off the column-name checking that catches a typo in
// an INSERT payload, which is exactly the protection worth keeping here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const samplesTable = () => (supabase as any).from("trailer_location_samples");

interface DbTrailerRow {
  id:                number;
  motive_vehicle_id: string | null;
  active_to:         string | null;
}

/** Motive's row shape from /v1/asset_locations. Same nesting as the
 *  web route's reader — the GPS hangs off asset_gateway.last_location,
 *  and the address field is `address` or sometimes
 *  `formatted_address`, never `description`. */
interface MotiveAssetRow {
  asset: {
    id: number | string;
    asset_gateway?: {
      last_location?: {
        address?:           string | null;
        formatted_address?: string | null;
        lat?:               number | null;
        lon?:               number | null;
        located_at?:        string | null;
        moving?:            boolean;
      } | null;
    } | null;
  };
}

interface SampleRow {
  org_id:     string;
  trailer_id: number;
  lat:        number;
  lon:        number;
  address:    string | null;
  located_at: string;
  moving:     boolean | null;
}

export interface TrailerLocationOrgResult {
  orgId:      string;
  /** Assets Motive returned, across all pages. */
  fetched:    number;
  /** Of those, how many mapped to a live trailer in this org. */
  matched:    number;
  /** Rows the insert accepted — i.e. GPS fixes we had not seen. */
  inserted:   number;
  /** Rows rejected by the unique key: the tracker had not moved on. */
  duplicates: number;
  error?:     string;
}

export interface TrailerLocationSweepResult {
  orgs:    TrailerLocationOrgResult[];
  /** Samples deleted by the retention prune. */
  pruned:  number;
}

// Motive caps per_page at 100 on this endpoint and pages from 1. The
// web route asks for one page and stops, which is silently wrong for
// a fleet over 100 assets; a sweep that writes history cannot take
// that shortcut, so it follows pages until one comes back short.
const PER_PAGE = 100;
const MAX_PAGES = 25;

// Two years. Even at 2-minute resolution for the trailers that are
// actually rolling, this is well under 100 MB a year, so it's a
// ceiling rather than a budget — long enough that "where was this
// trailer last winter" is still a question with an answer.
const RETENTION_DAYS = Number(process.env.TRAILER_LOCATION_RETENTION_DAYS ?? 730);

// Retention is a slow-moving concern and the sweep now runs every two
// minutes, so pruning on every pass would be 720 pointless deletes a
// day. Once an hour is plenty.
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

async function fetchMotiveAssets(apiKey: string): Promise<MotiveAssetRow[]> {
  const out: MotiveAssetRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.keeptruckin.com/v1/asset_locations?per_page=${PER_PAGE}&page_no=${page}`,
      { headers: { "X-Api-Key": apiKey, Accept: "application/json" } },
    );
    if (!res.ok) {
      throw new Error(`Motive asset_locations responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { assets?: MotiveAssetRow[] };
    const rows = json.assets ?? [];
    out.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return out;
}

async function sweepOrg(orgId: string, apiKey: string): Promise<TrailerLocationOrgResult> {
  const result: TrailerLocationOrgResult = {
    orgId, fetched: 0, matched: 0, inserted: 0, duplicates: 0,
  };

  // Motive asset id → FleetCal trailer id. Retired trailers (active_to
  // set) are skipped: their tracker may still report from wherever the
  // trailer was sold, and that is not history worth keeping.
  const { data: trailers, error: trailersErr } = await supabase
    .from("trailers")
    .select("id, motive_vehicle_id, active_to")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (trailersErr) {
    result.error = `trailers read failed: ${trailersErr.message}`;
    return result;
  }

  const byMotiveId = new Map<string, number>();
  for (const t of (trailers ?? []) as unknown as DbTrailerRow[]) {
    if (t.active_to) continue;
    if (t.motive_vehicle_id) byMotiveId.set(String(t.motive_vehicle_id), t.id);
  }
  if (byMotiveId.size === 0) return result;

  let assets: MotiveAssetRow[];
  try {
    assets = await fetchMotiveAssets(apiKey);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
  result.fetched = assets.length;

  const rows: SampleRow[] = [];
  for (const row of assets) {
    const trailerId = byMotiveId.get(String(row.asset.id));
    if (trailerId == null) continue;  // a Motive asset we don't track as a trailer
    result.matched++;
    const loc = row.asset.asset_gateway?.last_location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") continue;
    // No located_at means we cannot place the fix in time, and
    // substituting now() would invent a fix that never happened — the
    // exact lie that would make "parked since" wrong. Skip it.
    if (!loc.located_at) continue;
    rows.push({
      org_id:     orgId,
      trailer_id: trailerId,
      lat:        loc.lat,
      lon:        loc.lon,
      address:    loc.address ?? loc.formatted_address ?? null,
      located_at: loc.located_at,
      moving:     loc.moving ?? null,
    });
  }
  if (rows.length === 0) return result;

  // ignoreDuplicates leaves the first write of a fix alone rather than
  // overwriting it, so a re-poll can never rewrite history. The count
  // of what came back is how many fixes were actually new.
  const { data: insertedRows, error: insertErr } = await samplesTable()
    .upsert(rows, { onConflict: "trailer_id,located_at", ignoreDuplicates: true })
    .select("id");
  if (insertErr) {
    result.error = `insert failed: ${insertErr.message}`;
    return result;
  }
  result.inserted   = insertedRows?.length ?? 0;
  result.duplicates = rows.length - result.inserted;
  return result;
}

export async function runTrailerLocationSweep(): Promise<TrailerLocationSweepResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgs } = await (supabase as any)
    .from("org_settings")
    .select("org_id, motive_api_key")
    .not("motive_api_key", "is", null);

  const results: TrailerLocationOrgResult[] = [];
  for (const row of (orgs ?? []) as Array<{ org_id: string; motive_api_key: string | null }>) {
    if (!row.motive_api_key) continue;
    results.push(await sweepOrg(row.org_id, row.motive_api_key));
  }

  // Prune last, and globally rather than per-org: retention is a
  // property of the table, not of a tenant.
  let pruned = 0;
  if (Date.now() - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = Date.now();
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
    const { data: prunedRows, error: pruneErr } = await samplesTable()
      .delete()
      .lt("located_at", cutoff)
      .select("id");
    if (pruneErr) console.error("[trailer-locations] prune failed:", pruneErr.message);
    pruned = prunedRows?.length ?? 0;
  }

  return { orgs: results, pruned };
}
