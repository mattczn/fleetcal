/**
 * Motive driving-periods ingestion.
 *
 * Two modes:
 *   - backfill:    pull a date range across all vehicles, paginate to end.
 *   - incremental: pull ?updated_after=<cursor>, advance the cursor.
 *
 * Read-only — Motive is the data source, we never push anything back.
 *
 * Authoritative behavior:
 *   - UPSERT on Motive's id so later edits (source=2 user edits in
 *     the Motive app, or source=3 unidentified-driver assumptions
 *     that get reassigned) overwrite our row instead of duplicating.
 *   - Pagination: loop page_no=1..N using pagination.total to decide
 *     when to stop. The docs don't pin a max per_page; we send the
 *     configured PER_PAGE and log a warning if a page comes back
 *     short in a way that suggests a server cap.
 *   - HTTP 429: exponential backoff with jitter, capped retries.
 *
 * Designed to be reused for /idle_events and /reefer_samples later:
 *   the pagination + backoff + cursor helpers are decoupled from the
 *   driving-periods row shape.
 */

import { supabase } from "./supabase.js";

// ── Config (env-tunable) ────────────────────────────────────────────────

/** Page size sent to Motive. Doc'd max is not specified — start at 100
 *  and log a warning if the API caps us lower. Override via env. */
const PER_PAGE = Math.max(1, Math.min(500, Number(process.env.MOTIVE_PER_PAGE ?? 100)));

/** Per-spec: only mirror movements above this distance threshold. */
const MIN_MOVEMENT_MILES = Number(process.env.MIN_MOVEMENT_MILES ?? 1.0);

/** Backoff bounds for 429 / 5xx retries. */
const BACKOFF_BASE_MS = Number(process.env.MOTIVE_BACKOFF_BASE_MS ?? 750);
const BACKOFF_MAX_MS  = Number(process.env.MOTIVE_BACKOFF_MAX_MS  ?? 15_000);
const MAX_RETRIES     = Number(process.env.MOTIVE_MAX_RETRIES     ?? 5);

const KM_TO_MI = 0.621371;

// ── Motive API shapes (just what we consume) ────────────────────────────

interface MotiveDrivingPeriodInner {
  id:                 number;
  start_time:         string | null;
  end_time:           string | null;
  duration:           number | null;
  start_kilometers:   number | null;
  end_kilometers:     number | null;
  distance:           string | null;
  origin:             string | null;
  destination:        string | null;
  origin_lat:         number | null;
  origin_lon:         number | null;
  destination_lat:    number | null;
  destination_lon:    number | null;
  type:               string | null;
  status:             string | null;
  source:             number | null;
  updated_at:         string | null;
  vehicle?: {
    id:     number | null;
    number: string | null;
  } | null;
  driver?: {
    id:         number | null;
    first_name: string | null;
    last_name:  string | null;
  } | null;
}

interface MotiveDrivingPeriodsPage {
  driving_periods?: Array<{ driving_period?: MotiveDrivingPeriodInner }>;
  pagination?: { per_page?: number; page_no?: number; total?: number };
}

// ── Auth ────────────────────────────────────────────────────────────────

/** Resolve the org's Motive key. Matches the pattern the existing
 *  /v1/vehicle_locations cache uses — keys live in org_settings so
 *  multi-org doesn't require a redeploy. */
export async function getOrgMotiveKey(orgId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[motiveIngest] org_settings lookup:", error);
    return null;
  }
  return (data as { motive_api_key: string | null } | null)?.motive_api_key ?? null;
}

// ── HTTP w/ retry ───────────────────────────────────────────────────────

function jitter(ms: number): number {
  // ±25% jitter so a thundering herd of retries doesn't pile up
  return ms + Math.floor((Math.random() - 0.5) * ms * 0.5);
}

async function motiveFetch(url: string, apiKey: string): Promise<unknown> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey, "Accept": "application/json" },
    });
    if (res.ok) return res.json();

    // 429 = explicit throttle. 5xx = transient server. Both retry.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      const wait = jitter(backoff);
      console.warn(`[motiveIngest] ${res.status} on ${url} — retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      continue;
    }

    // Anything else (4xx other than 429, or retries exhausted) is fatal.
    const body = await res.text().catch(() => "");
    throw new Error(`Motive ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ── Pagination loop ─────────────────────────────────────────────────────

/**
 * Walk every page of a Motive list endpoint via pagination.total.
 * Yields one page at a time so the caller can upsert as it goes
 * (avoids holding the entire result set in memory for big backfills).
 */
async function* paginate(
  baseUrl: string,
  apiKey: string,
): AsyncGenerator<MotiveDrivingPeriodsPage> {
  let pageNo = 1;
  let totalSeen = 0;

  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page_no",  String(pageNo));
    const body = await motiveFetch(url.toString(), apiKey) as MotiveDrivingPeriodsPage;

    const items = body.driving_periods ?? [];
    if (items.length < PER_PAGE && items.length > 0 && pageNo === 1) {
      // First page came short. Could be a real "fewer than per_page"
      // result OR the server capping per_page lower. Surface in logs
      // so we can adjust PER_PAGE once we see the actual behavior.
      console.warn(
        `[motiveIngest] page 1 returned ${items.length} items with per_page=${PER_PAGE} — ` +
        `server may be capping per_page. Set MOTIVE_PER_PAGE lower if this persists.`,
      );
    }

    yield body;

    totalSeen += items.length;
    const total = body.pagination?.total ?? totalSeen;
    if (totalSeen >= total || items.length === 0) return;
    pageNo++;

    // Hard ceiling to prevent infinite loops if the API misreports
    // pagination.total — 200 pages × 100 per_page = 20k records, way
    // more than a sane backfill window per org.
    if (pageNo > 200) {
      console.warn("[motiveIngest] pagination exceeded 200 pages; stopping defensively");
      return;
    }
  }
}

// ── Row mapping ─────────────────────────────────────────────────────────

interface DrivingPeriodRow {
  id:                  number;
  org_id:              string;
  vehicle_id:          number | null;
  vehicle_number:      string | null;
  driver_id:           number | null;
  driver_first_name:   string | null;
  driver_last_name:    string | null;
  start_time:          string;
  end_time:            string | null;
  duration:            number | null;
  start_kilometers:    number | null;
  end_kilometers:      number | null;
  distance:            string | null;
  origin:              string | null;
  destination:         string | null;
  origin_lat:          number | null;
  origin_lon:          number | null;
  destination_lat:     number | null;
  destination_lon:     number | null;
  type:                string | null;
  status:              string | null;
  source:              number | null;
  miles:               number | null;
  display_eligible:    boolean;
  motive_updated_at:   string | null;
}

/** Parse Motive's pre-formatted distance string ("206.8 mi", "12 km",
 *  "1,234.5 mi") into a number of miles. Returns null when unparseable.
 *  This is the most reliable source — Motive's start/end_kilometers
 *  fields are often null for unidentified driving even on long trips. */
function parseDistance(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^([\d,]+\.?\d*)\s*(mi|km)?$/i);
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] ?? "mi").toLowerCase();
  return unit === "km" ? value * KM_TO_MI : value;
}

function rowFromMotive(p: MotiveDrivingPeriodInner, orgId: string): DrivingPeriodRow | null {
  // Drop rows we can't anchor on the calendar — no start time means
  // nothing useful to render.
  if (!p.id || !p.start_time) return null;

  // Prefer the pre-formatted distance string when present — Motive
  // populates it consistently while leaving start/end_kilometers null
  // for unidentified driving. Fall back to the kilometer delta only
  // when the string isn't there.
  const milesFromDistance = parseDistance(p.distance);
  const milesFromKm =
    p.start_kilometers != null && p.end_kilometers != null
      ? (p.end_kilometers - p.start_kilometers) * KM_TO_MI
      : null;
  const miles = milesFromDistance ?? milesFromKm;

  return {
    id:                p.id,
    org_id:            orgId,
    vehicle_id:        p.vehicle?.id ?? null,
    vehicle_number:    p.vehicle?.number ?? null,
    driver_id:         p.driver?.id ?? null,
    driver_first_name: p.driver?.first_name ?? null,
    driver_last_name:  p.driver?.last_name  ?? null,
    start_time:        p.start_time,
    end_time:          p.end_time,
    // Motive occasionally returns fractional seconds for duration
    // (observed: 24208.393951508). Our column is `integer`, so without
    // a round the whole batch upsert crashes with `invalid input
    // syntax for type integer` and silently kills every subsequent
    // sync until manually retriggered.
    duration:          p.duration != null ? Math.round(p.duration) : null,
    start_kilometers:  p.start_kilometers,
    end_kilometers:    p.end_kilometers,
    distance:          p.distance,
    origin:            p.origin,
    destination:       p.destination,
    origin_lat:        p.origin_lat,
    origin_lon:        p.origin_lon,
    destination_lat:   p.destination_lat,
    destination_lon:   p.destination_lon,
    type:              p.type,
    status:            p.status,
    source:            p.source,
    miles,
    display_eligible:  miles != null && miles >= MIN_MOVEMENT_MILES,
    motive_updated_at: p.updated_at,
  };
}

// ── Upsert batch ────────────────────────────────────────────────────────

async function upsertBatch(rows: DrivingPeriodRow[]): Promise<{ count: number }> {
  if (rows.length === 0) return { count: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("motive_driving_periods")
    .upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("[motiveIngest] upsert failed:", error);
    throw new Error(`upsert failed: ${error.message}`);
  }
  return { count: rows.length };
}

// ── Sync state ──────────────────────────────────────────────────────────

const FEED = "driving_periods";

async function readCursor(orgId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("motive_sync_state")
    .select("last_cursor")
    .eq("org_id", orgId)
    .eq("feed", FEED)
    .maybeSingle();
  return (data as { last_cursor: string | null } | null)?.last_cursor ?? null;
}

async function writeSyncState(
  orgId: string,
  args: { cursor: string | null; status: "ok" | "error"; detail?: string },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any).from("motive_sync_state").upsert(
    {
      org_id:          orgId,
      feed:            FEED,
      last_cursor:     args.cursor,
      last_synced_at:  new Date().toISOString(),
      last_run_status: args.status,
      last_run_detail: args.detail ?? null,
    },
    { onConflict: "org_id,feed" },
  );
}

// ── Public sync entrypoints ─────────────────────────────────────────────

export interface SyncResult {
  orgId:          string;
  mode:           "backfill" | "incremental";
  pagesFetched:   number;
  rowsUpserted:   number;
  rowsSkipped:    number;
  /** New cursor written to motive_sync_state. */
  newCursor:      string | null;
  durationMs:     number;
}

export interface SyncOptions {
  /** Defaults to last 7 days. Use a Date for either bound. */
  startDate?: Date;
  endDate?:   Date;
}

/**
 * Backfill mode — pull a window across all vehicles configured at the
 * org level. Default window is 7 days ending now. Use this for the
 * initial pull or for catching up after a long outage.
 */
export async function syncBackfill(orgId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) throw new Error(`org ${orgId} has no motive_api_key configured`);

  const endDate   = opts.endDate   ?? new Date();
  const startDate = opts.startDate ?? new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    start_date: startDate.toISOString().slice(0, 10),
    end_date:   endDate.toISOString().slice(0, 10),
  });
  const baseUrl = `https://api.gomotive.com/v1/driving_periods?${params.toString()}`;

  let pages = 0;
  let inserted = 0;
  let skipped = 0;
  let maxUpdatedAt: string | null = null;

  try {
    for await (const page of paginate(baseUrl, apiKey)) {
      pages++;
      const rows: DrivingPeriodRow[] = [];
      for (const wrapper of (page.driving_periods ?? [])) {
        const r = rowFromMotive(wrapper.driving_period ?? {} as MotiveDrivingPeriodInner, orgId);
        if (r) {
          rows.push(r);
          if (r.motive_updated_at && (!maxUpdatedAt || r.motive_updated_at > maxUpdatedAt)) {
            maxUpdatedAt = r.motive_updated_at;
          }
        } else {
          skipped++;
        }
      }
      const { count } = await upsertBatch(rows);
      inserted += count;
    }
    // Cursor advances to the newest motive_updated_at we saw. If the
    // backfill window came back empty, leave the existing cursor alone.
    const existing = await readCursor(orgId);
    const next = maxUpdatedAt && (!existing || maxUpdatedAt > existing) ? maxUpdatedAt : existing;
    await writeSyncState(orgId, { cursor: next, status: "ok" });
    return { orgId, mode: "backfill", pagesFetched: pages, rowsUpserted: inserted, rowsSkipped: skipped, newCursor: next, durationMs: Date.now() - t0 };
  } catch (err) {
    await writeSyncState(orgId, { cursor: await readCursor(orgId), status: "error", detail: (err as Error).message });
    throw err;
  }
}

/**
 * Incremental mode — pull everything updated since the last cursor.
 * On the first ever run for an org (no cursor yet), defaults to the
 * last 7 days so the cron has something to chew on without blocking
 * on a separate backfill.
 */
export async function syncIncremental(orgId: string): Promise<SyncResult> {
  const t0 = Date.now();
  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) throw new Error(`org ${orgId} has no motive_api_key configured`);

  const cursor = await readCursor(orgId);
  const fallback = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const effectiveCursor = cursor ?? fallback;
  const params = new URLSearchParams({ updated_after: effectiveCursor });
  const baseUrl = `https://api.gomotive.com/v1/driving_periods?${params.toString()}`;

  let pages = 0;
  let inserted = 0;
  let skipped = 0;
  let maxUpdatedAt: string | null = effectiveCursor;

  try {
    for await (const page of paginate(baseUrl, apiKey)) {
      pages++;
      const rows: DrivingPeriodRow[] = [];
      for (const wrapper of (page.driving_periods ?? [])) {
        const r = rowFromMotive(wrapper.driving_period ?? {} as MotiveDrivingPeriodInner, orgId);
        if (r) {
          rows.push(r);
          if (r.motive_updated_at && r.motive_updated_at > (maxUpdatedAt ?? "")) {
            maxUpdatedAt = r.motive_updated_at;
          }
        } else {
          skipped++;
        }
      }
      const { count } = await upsertBatch(rows);
      inserted += count;
    }
    await writeSyncState(orgId, { cursor: maxUpdatedAt, status: "ok" });
    return { orgId, mode: "incremental", pagesFetched: pages, rowsUpserted: inserted, rowsSkipped: skipped, newCursor: maxUpdatedAt, durationMs: Date.now() - t0 };
  } catch (err) {
    await writeSyncState(orgId, { cursor, status: "error", detail: (err as Error).message });
    throw err;
  }
}

// ── Cron-level helper: run incremental for every org with a key ─────────

export async function syncIncrementalAllOrgs(): Promise<SyncResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgs, error } = await (supabase as any)
    .from("org_settings")
    .select("org_id, motive_api_key, motive_settings")
    .not("motive_api_key", "is", null);
  if (error) {
    console.error("[motiveIngest] orgs lookup:", error);
    return [];
  }

  type OrgRow = {
    org_id: string;
    motive_settings: {
      drivingPeriodsSyncEnabled?: boolean;
      drivingPeriodsSyncIntervalMinutes?: number;
    } | null;
  };

  const results: SyncResult[] = [];
  const nowMs = Date.now();

  for (const row of (orgs ?? []) as OrgRow[]) {
    const settings = row.motive_settings ?? null;
    // Master switch — defaults true. Customers can pause sync via
    // settings UI without yanking the API key.
    if (settings && settings.drivingPeriodsSyncEnabled === false) continue;

    // Per-org interval throttling. The scheduler ticks every 5 min
    // globally; if this org wants slower cadence (e.g. 30 min for a
    // very low-throughput carrier) we skip until enough time has
    // passed.
    const intervalMin = settings?.drivingPeriodsSyncIntervalMinutes;
    if (intervalMin && intervalMin > 5) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: state } = await (supabase as any)
        .from("motive_sync_state")
        .select("last_synced_at")
        .eq("org_id", row.org_id)
        .eq("feed", "driving_periods")
        .maybeSingle();
      const lastMs = state?.last_synced_at ? new Date(state.last_synced_at).getTime() : 0;
      const ageMin = lastMs > 0 ? (nowMs - lastMs) / 60_000 : Infinity;
      if (ageMin < intervalMin) continue;
    }

    try {
      results.push(await syncIncremental(row.org_id));
    } catch (err) {
      console.error(`[motiveIngest] sync failed for org ${row.org_id}:`, err);
    }
  }
  return results;
}

// ── Odometer snapshot ──────────────────────────────────────────────────
//
// Records each vehicle's current odometer reading once per day. Hits
// /v1/vehicle_locations (the same endpoint the live-location card uses)
// and pulls current_location.odometer + true_odometer for every truck
// returned. Idempotent per (vehicle_id, calendar_day) so re-running
// within the same day is a no-op.

export interface OdometerSnapshotResult {
  orgId:        string;
  vehiclesSeen: number;
  rowsInserted: number;
  rowsSkipped:  number;
  durationMs:   number;
}

interface MotiveVehicleLocationRow {
  vehicle: {
    id:     number;
    number: string | null;
    current_location: {
      located_at:     string | null;
      odometer:       number | null;
      true_odometer:  number | null;
    } | null;
  };
}

export async function snapshotOdometers(orgId: string): Promise<OdometerSnapshotResult> {
  const t0 = Date.now();
  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) throw new Error(`org ${orgId} has no motive_api_key configured`);

  // Paginate /v1/vehicle_locations — same pagination shape as
  // driving_periods. Per-page 100 keeps the response under control.
  const allVehicles: MotiveVehicleLocationRow[] = [];
  let pageNo = 1;
  while (pageNo <= 50) {
    const url = `https://api.gomotive.com/v1/vehicle_locations?per_page=100&page_no=${pageNo}`;
    const body = await motiveFetch(url, apiKey) as { vehicles?: MotiveVehicleLocationRow[]; pagination?: { total: number; per_page: number; page_no: number } };
    const items = body.vehicles ?? [];
    for (const v of items) allVehicles.push(v);
    if (!body.pagination || pageNo * (body.pagination.per_page ?? 100) >= (body.pagination.total ?? items.length)) break;
    pageNo++;
  }

  // Build a Motive-vehicle-id → fleetcal-asset-id map so we can stamp
  // asset_id on each new reading. Without this, every snapshot row
  // landed as asset_id=NULL, which broke the dashboard's Total Miles
  // tile (the summary endpoint joins by asset_id). The migration that
  // added asset_id (20260529) deferred this step to "eventually" —
  // doing it now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: assetRows, error: assetErr } = await (supabase as any)
    .from("assets")
    .select("id, motive_vehicle_id")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (assetErr) {
    console.error("[motiveIngest] asset lookup failed:", assetErr);
    throw new Error(`asset lookup failed: ${assetErr.message}`);
  }
  const vehicleIdToAssetId = new Map<number, number>();
  for (const r of (assetRows ?? []) as Array<{ id: number; motive_vehicle_id: number | null }>) {
    if (r.motive_vehicle_id != null) vehicleIdToAssetId.set(r.motive_vehicle_id, r.id);
  }

  // Build snapshot rows for vehicles whose ELDs reported an odometer.
  const today = new Date().toISOString().slice(0, 10); // UTC day for idempotency probe
  const rows: Array<{
    org_id: string; vehicle_id: number; vehicle_number: string | null;
    asset_id: number | null;
    odometer_miles: number | null; true_odometer_miles: number | null;
    located_at: string | null;
  }> = [];
  for (const v of allVehicles) {
    const loc = v.vehicle.current_location;
    if (!loc) continue;
    if (loc.odometer == null && loc.true_odometer == null) continue;
    rows.push({
      org_id:              orgId,
      vehicle_id:          v.vehicle.id,
      vehicle_number:      v.vehicle.number ?? null,
      // Resolve to the matching asset row. Null is allowed (the
      // schema CHECK requires vehicle_id OR asset_id, and we always
      // have vehicle_id from Motive), so vehicles whose asset doesn't
      // exist yet still land cleanly — they just won't roll up under
      // an asset in the dashboard until the asset is created.
      asset_id:            vehicleIdToAssetId.get(v.vehicle.id) ?? null,
      odometer_miles:      loc.odometer ?? null,
      true_odometer_miles: loc.true_odometer ?? null,
      located_at:          loc.located_at ?? null,
    });
  }

  // Idempotency: skip vehicles that already have a snapshot for today.
  // Pull existing UTC-day rows for these vehicles in one query, then
  // filter before insert.
  const vehicleIds = rows.map(r => r.vehicle_id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabase as any)
    .from("motive_odometer_readings")
    .select("vehicle_id, captured_at")
    .eq("org_id", orgId)
    .in("vehicle_id", vehicleIds.length ? vehicleIds : [0])
    .gte("captured_at", `${today}T00:00:00Z`)
    .lt("captured_at",  `${today}T23:59:59Z`);

  const alreadyToday = new Set<number>(
    ((existing ?? []) as Array<{ vehicle_id: number }>).map(r => r.vehicle_id),
  );
  const toInsert = rows.filter(r => !alreadyToday.has(r.vehicle_id));

  if (toInsert.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("motive_odometer_readings").insert(toInsert);
    if (error) {
      console.error("[motiveIngest] odometer insert failed:", error);
      throw new Error(`odometer insert failed: ${error.message}`);
    }
  }

  return {
    orgId,
    vehiclesSeen: rows.length,
    rowsInserted: toInsert.length,
    rowsSkipped:  rows.length - toInsert.length,
    durationMs:   Date.now() - t0,
  };
}

export async function snapshotOdometersAllOrgs(): Promise<OdometerSnapshotResult[]> {
  // Pull every org with a Motive key. We also need motive_settings to
  // decide whether to actually fire the snapshot for each org — see
  // below for the per-org enabled + interval check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgs } = await (supabase as any)
    .from("org_settings")
    .select("org_id, motive_api_key, motive_settings")
    .not("motive_api_key", "is", null);

  type OrgRow = {
    org_id: string;
    motive_settings: {
      odometerSyncEnabled?: boolean;
      odometerSyncIntervalHours?: number;
    } | null;
  };

  const results: OdometerSnapshotResult[] = [];
  const nowMs = Date.now();

  for (const row of (orgs ?? []) as OrgRow[]) {
    const settings = row.motive_settings ?? null;
    // Master switch — defaults true when the org has a key but
    // hasn't explicitly configured the toggle. Customers who want to
    // pause sync without removing the key set this to false.
    if (settings && settings.odometerSyncEnabled === false) continue;

    // Per-org interval throttling. The scheduler ticks once an hour
    // globally; if this org wants e.g. 4-hour cadence, skip orgs
    // whose newest snapshot is fresher than that.
    const intervalH = settings?.odometerSyncIntervalHours;
    if (intervalH && intervalH > 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: latest } = await (supabase as any)
        .from("motive_odometer_readings")
        .select("captured_at")
        .eq("org_id", row.org_id)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastMs = latest?.captured_at ? new Date(latest.captured_at).getTime() : 0;
      const ageHours = lastMs > 0 ? (nowMs - lastMs) / 3_600_000 : Infinity;
      if (ageHours < intervalH) {
        // Too soon — skip this org this tick. The scheduler will
        // catch them on the next hour.
        continue;
      }
    }

    try {
      results.push(await snapshotOdometers(row.org_id));
    } catch (err) {
      console.error(`[motiveIngest] odometer snapshot failed for org ${row.org_id}:`, err);
    }
  }
  return results;
}
