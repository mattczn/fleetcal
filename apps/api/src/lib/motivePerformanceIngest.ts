/**
 * Motive driver performance events ingestion (GET /v2/driver_performance_events).
 *
 * Cursored incremental sync. Same shape as motiveIngest.ts but for the
 * safety-event feed — hard acceleration, hard braking, hard cornering,
 * plus any v2-only event types the fleet's dashcam plan surfaces (phone
 * use, distraction, tailgating, etc.). We store whatever comes back and
 * let the UI decide what to display.
 *
 * v2 endpoint intentionally: v1 is a strict subset (only hard_accel /
 * hard_brake / hard_corner), so hitting v2 without an event_types filter
 * covers both. Fleets without AI dashcams still get only the 3 hard
 * events back — same behavior as v1, no downside.
 *
 * Auth + retry + pagination reuse the same conventions as motiveIngest.ts:
 * key from org_settings.motive_api_key, x-api-key header, 429/5xx backoff.
 */

import { supabase } from "./supabase.js";
import { env } from "./env.js";

// ── Config ─────────────────────────────────────────────────────────────

const PER_PAGE       = Math.max(1, Math.min(500, Number(process.env.MOTIVE_PERF_PER_PAGE ?? 100)));
const BACKOFF_BASE_MS = Number(process.env.MOTIVE_BACKOFF_BASE_MS ?? 750);
const BACKOFF_MAX_MS  = Number(process.env.MOTIVE_BACKOFF_MAX_MS  ?? 15_000);
const MAX_RETRIES     = Number(process.env.MOTIVE_MAX_RETRIES     ?? 5);

// ── Motive response shapes (only what we consume) ──────────────────────

interface MotivePerfEventInner {
  id:           number;
  type?:        string | null;                // 'hard_accel' | 'hard_brake' | 'hard_corner' | v2 types
  start_time?:  string | null;
  end_time?:    string | null;
  duration?:    number | null;
  intensity?:   string | null;
  location?:    string | null;
  lat?:         number | null;
  lon?:         number | null;
  m_gps_lat?:   number | null;
  m_gps_lon?:   number | null;
  vehicle?: {
    id:      number | null;
    number:  string | null;
  } | null;
  driver?: {
    id:          number | null;
    first_name?: string | null;
    last_name?:  string | null;
  } | null;
  updated_at?:  string | null;
}

interface MotivePerfEventsPage {
  driver_performance_events?: Array<{ driver_performance_event?: MotivePerfEventInner }>;
  pagination?: { per_page?: number; page_no?: number; total?: number };
}

// ── Auth ───────────────────────────────────────────────────────────────

async function getOrgMotiveKey(orgId: string): Promise<string | null> {
  const { data } = await supabase
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  return (data as { motive_api_key: string | null } | null)?.motive_api_key ?? null;
}

// ── HTTP w/ retry ──────────────────────────────────────────────────────

function jitter(ms: number): number {
  return ms + Math.floor((Math.random() - 0.5) * ms * 0.5);
}

async function motiveFetch(url: string, apiKey: string): Promise<unknown> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey, "Accept": "application/json" },
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      const wait = jitter(backoff);
      console.warn(`[perfIngest] ${res.status} on ${url} — retry ${attempt + 1}/${MAX_RETRIES} after ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`Motive ${res.status}: ${body.slice(0, 300)}`);
  }
}

// ── Pagination ─────────────────────────────────────────────────────────

async function* paginate(baseUrl: string, apiKey: string): AsyncGenerator<MotivePerfEventsPage> {
  let pageNo = 1;
  let totalSeen = 0;
  while (true) {
    const url = new URL(baseUrl);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page_no",  String(pageNo));
    const body = await motiveFetch(url.toString(), apiKey) as MotivePerfEventsPage;
    const items = body.driver_performance_events ?? [];
    yield body;
    totalSeen += items.length;
    const total = body.pagination?.total ?? totalSeen;
    if (totalSeen >= total || items.length === 0) return;
    pageNo++;
    if (pageNo > 200) {
      console.warn("[perfIngest] pagination exceeded 200 pages; stopping defensively");
      return;
    }
  }
}

// ── Row mapping ────────────────────────────────────────────────────────

interface PerfEventRow {
  id:                  number;
  org_id:              string;
  event_type:          string;
  event_time:          string;
  end_time:            string | null;
  duration:            number | null;
  intensity:           string | null;
  vehicle_id:          number;
  vehicle_number:      string | null;
  asset_id:            number | null;
  driver_id:           number | null;
  driver_first_name:   string | null;
  driver_last_name:    string | null;
  lat:                 number | null;
  lon:                 number | null;
  location_label:      string | null;
  raw:                 unknown;
  motive_updated_at:   string | null;
}

function rowFromMotive(
  e: MotivePerfEventInner,
  orgId: string,
  vehicleAssetMap: Map<string, number>,
): PerfEventRow | null {
  // Drop rows we can't anchor. event_time + vehicle_id + event_type are
  // the minimum for the drawer to be useful — everything else is nullable.
  if (!e.id || !e.start_time || !e.type || e.vehicle?.id == null) return null;

  // Prefer the top-level lat/lon (event location), fall back to the
  // m_gps_lat/lon telemetry sample when the top level is empty.
  const lat = e.lat ?? e.m_gps_lat ?? null;
  const lon = e.lon ?? e.m_gps_lon ?? null;

  return {
    id:                e.id,
    org_id:            orgId,
    event_type:        e.type,
    event_time:        e.start_time,
    end_time:          e.end_time ?? null,
    // Motive returns fractional seconds (observed on driving_periods).
    // Column is double precision here so no round needed, but coerce
    // undefined → null cleanly.
    duration:          e.duration ?? null,
    intensity:         e.intensity ?? null,
    vehicle_id:        e.vehicle.id,
    vehicle_number:    e.vehicle.number ?? null,
    // String-key lookup — assets.motive_vehicle_id can be text or bigint
    // depending on when the row was created. See motiveIngest.ts for the
    // same defensive coercion.
    asset_id:          vehicleAssetMap.get(String(e.vehicle.id)) ?? null,
    driver_id:         e.driver?.id ?? null,
    driver_first_name: e.driver?.first_name ?? null,
    driver_last_name:  e.driver?.last_name ?? null,
    lat,
    lon,
    location_label:    e.location ?? null,
    raw:               e,
    motive_updated_at: e.updated_at ?? null,
  };
}

// ── Vehicle → asset map (per org) ──────────────────────────────────────

async function loadVehicleAssetMap(orgId: string): Promise<Map<string, number>> {
  const { data } = await supabase
    .from("assets")
    .select("id, motive_vehicle_id")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  const map = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ id: number; motive_vehicle_id: number | string | null }>) {
    if (r.motive_vehicle_id != null) map.set(String(r.motive_vehicle_id), r.id);
  }
  return map;
}

// ── Upsert ─────────────────────────────────────────────────────────────

async function upsertBatch(rows: PerfEventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  // INSERT-only conflict target — we NEVER want a Motive replay to
  // overwrite the dispatcher-facing columns (dispatch_status, notified_*,
  // dispatch_note). onConflict: 'id' with ignoreDuplicates=true does what
  // we want: new events land, existing events stay untouched even if
  // Motive updates their raw payload.
  //
  // If we ever need to refresh Motive-side fields (say, coaching_status
  // becomes important), switch to explicit UPDATE ... FROM excluded with
  // a column allowlist so dispatcher-facing cols are excluded.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error, count } = await (supabase as any)
    .from("motive_performance_events")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true, count: "exact" });
  if (error) {
    console.error("[perfIngest] upsert failed:", error);
    throw new Error(`upsert failed: ${error.message}`);
  }
  return count ?? rows.length;
}

// ── Sync state (reuses motive_sync_state with feed='performance_events') ─

const FEED = "performance_events";

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

// ── Public entrypoints ─────────────────────────────────────────────────

export interface PerfSyncResult {
  orgId:         string;
  pagesFetched:  number;
  rowsInserted:  number;
  rowsSkipped:   number;
  newCursor:     string | null;
  durationMs:    number;
}

/**
 * Incremental pull for a single org. On the first ever run (no cursor)
 * we look back 24h — safety events are only actionable while fresh, so
 * there's no reason to backfill a wide window when a customer first
 * enables the feature.
 */
export async function syncPerformanceEvents(orgId: string): Promise<PerfSyncResult> {
  const t0 = Date.now();
  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) throw new Error(`org ${orgId} has no motive_api_key configured`);

  const cursor = await readCursor(orgId);
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const effectiveCursor = cursor ?? fallback;

  // media_required=true → Motive includes camera_media.downloadable_videos
  // in the response for events with an AI dashcam clip. URLs are signed
  // and time-limited (typically ~48h), so we bake them into `raw` at
  // ingest time; older events with expired links show a "video expired"
  // placeholder in the drawer.
  const params = new URLSearchParams({
    updated_after:  effectiveCursor,
    media_required: "true",
  });
  const baseUrl = `https://api.gomotive.com/v2/driver_performance_events?${params.toString()}`;

  const vehicleAssetMap = await loadVehicleAssetMap(orgId);

  let pages = 0;
  let inserted = 0;
  let skipped = 0;
  let maxUpdatedAt: string | null = effectiveCursor;

  try {
    for await (const page of paginate(baseUrl, apiKey)) {
      pages++;
      const rows: PerfEventRow[] = [];
      for (const wrapper of (page.driver_performance_events ?? [])) {
        const inner = wrapper.driver_performance_event ?? {} as MotivePerfEventInner;
        const r = rowFromMotive(inner, orgId, vehicleAssetMap);
        if (r) {
          rows.push(r);
          if (r.motive_updated_at && r.motive_updated_at > (maxUpdatedAt ?? "")) {
            maxUpdatedAt = r.motive_updated_at;
          }
        } else {
          skipped++;
        }
      }
      inserted += await upsertBatch(rows);
    }
    await writeSyncState(orgId, { cursor: maxUpdatedAt, status: "ok" });
    return {
      orgId,
      pagesFetched: pages,
      rowsInserted: inserted,
      rowsSkipped: skipped,
      newCursor: maxUpdatedAt,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    await writeSyncState(orgId, { cursor, status: "error", detail: (err as Error).message });
    throw err;
  }
}

export async function syncPerformanceEventsAllOrgs(): Promise<PerfSyncResult[]> {
  // ALLOWLIST — safety-alert bell is Curzon-only during initial rollout,
  // gated by the same CRM_INTERNAL_ORG_IDS env var the API route
  // (requireTruckHistoryOrg) uses. Rolling out to another Motive-integrated
  // org later = add the org_id to that env var; no code change here.
  // Skipping the DB round-trip entirely when the list is empty avoids
  // burning a query per tick in local dev.
  if (env.crmInternalOrgIds.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgs } = await (supabase as any)
    .from("org_settings")
    .select("org_id, motive_api_key, motive_settings")
    .in("org_id", env.crmInternalOrgIds)
    .not("motive_api_key", "is", null);

  type OrgRow = {
    org_id: string;
    motive_settings: {
      performanceEventsSyncEnabled?: boolean;
    } | null;
  };

  const results: PerfSyncResult[] = [];
  for (const row of (orgs ?? []) as OrgRow[]) {
    // Per-org master switch (defaults true when the flag is absent —
    // same convention as drivingPeriodsSyncEnabled). Turn OFF explicitly
    // via org_settings.motive_settings.performanceEventsSyncEnabled=false
    // to pause without yanking the API key.
    if (row.motive_settings?.performanceEventsSyncEnabled === false) continue;
    try {
      results.push(await syncPerformanceEvents(row.org_id));
    } catch (err) {
      console.error(`[perfIngest] sync failed for org ${row.org_id}:`, err);
    }
  }
  return results;
}
