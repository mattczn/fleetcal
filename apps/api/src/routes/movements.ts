/**
 * /v1/movements — Motive driving-periods feed for the dispatcher
 * calendar's "Movements" mode.
 *
 *   POST /v1/movements/sync   — manual trigger (backfill or incremental).
 *                               Body: { mode: 'backfill' | 'incremental',
 *                                       windowDays?: number }
 *   GET  /v1/movements        — calendar feed for ?from=&to= (ISO dates),
 *                               returns display_eligible movements
 *                               grouped/keyed by vehicleId.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { syncBackfill, syncIncremental, getOrgMotiveKey, snapshotOdometers } from "../lib/motiveIngest.js";

const movements = new Hono<{ Variables: AuthVariables }>();

// ── Manual sync (dispatcher / admin button) ─────────────────────────────

movements.post("/sync", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const mode = body?.mode === "backfill" ? "backfill" : "incremental";
  const windowDays = Number.isFinite(body?.windowDays) ? Math.max(1, Math.min(90, body.windowDays)) : 7;

  try {
    const result = mode === "backfill"
      ? await syncBackfill(orgId, {
          startDate: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000),
          endDate:   new Date(),
        })
      : await syncIncremental(orgId);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error("[POST /v1/movements/sync] failed:", err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// ── Calendar feed ───────────────────────────────────────────────────────

interface MovementCard {
  id:             number;
  vehicleId:      number;
  vehicleNumber:  string | null;
  startTime:      string;
  endTime:        string | null;
  miles:          number | null;
  durationMin:    number | null;
  origin:         string | null;
  destination:    string | null;
  type:           string | null;   // 'driving' | 'PC' | 'YM'
  status:         string | null;   // 'in_progress' | 'complete' | 'interrupted'
  source:         number | null;   // 1=gateway 2=user-edit 3=unidentified-driver
  originLat:      number | null;
  originLon:      number | null;
  destinationLat: number | null;
  destinationLon: number | null;
}

interface ListMovementsResponse {
  /** Keyed by vehicleId (Motive's). The dispatcher web maps these to
   *  our asset.id via assets.motive_vehicle_id at render time. */
  byVehicle: Record<string, MovementCard[]>;
}

movements.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO timestamps)"] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("motive_driving_periods")
    .select(
      "id, vehicle_id, vehicle_number, start_time, end_time, miles, duration, origin, destination, type, status, source, origin_lat, origin_lon, destination_lat, destination_lon",
    )
    .eq("org_id", orgId)
    .gte("start_time", from)
    .lte("start_time", to)
    .order("start_time", { ascending: true });
  // Note: no display_eligible filter. Motive's API fragments long
  // trips into many sub-mile driving_periods (one per light, one per
  // duty-status change). The client's clusterMovements merges them
  // back together, and the cluster-level miles threshold lives there
  // — so a 150-mile trip composed of 50 tiny records survives.
  if (error) {
    console.error("[GET /v1/movements] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  const byVehicle: Record<string, MovementCard[]> = {};
  for (const r of ((data ?? []) as unknown as Array<{
    id: number; vehicle_id: number | null; vehicle_number: string | null;
    start_time: string; end_time: string | null; miles: number | null;
    duration: number | null; origin: string | null; destination: string | null;
    type: string | null; status: string | null; source: number | null;
    origin_lat: number | null; origin_lon: number | null;
    destination_lat: number | null; destination_lon: number | null;
  }>)) {
    if (r.vehicle_id == null) continue;
    const key = String(r.vehicle_id);
    const card: MovementCard = {
      id:             r.id,
      vehicleId:      r.vehicle_id,
      vehicleNumber:  r.vehicle_number,
      startTime:      r.start_time,
      endTime:        r.end_time,
      miles:          r.miles,
      durationMin:    r.duration != null ? Math.round(r.duration / 60) : null,
      origin:         r.origin,
      destination:    r.destination,
      type:           r.type,
      status:         r.status,
      source:         r.source,
      originLat:      r.origin_lat,
      originLon:      r.origin_lon,
      destinationLat: r.destination_lat,
      destinationLon: r.destination_lon,
    };
    const arr = byVehicle[key] ?? [];
    arr.push(card);
    byVehicle[key] = arr;
  }

  const res: ListMovementsResponse = { byVehicle };
  return c.json(res);
});

// ── Debug endpoint ──────────────────────────────────────────────────────
// Hits Motive's /v1/driving_periods directly with the org's API key,
// walks through up to MAX_PAGES, and reports back: which vehicle_ids
// showed up across the response and whether the queried vehicle was
// among them. Lets us tell "ingest dropped it" from "Motive's API never
// had it" without bouncing through our cron + DB layer.

movements.get("/debug", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const vehicleIdStr = url.searchParams.get("vehicleId");
  const days  = Math.max(1, Math.min(90, Number(url.searchParams.get("days") ?? 14)));
  if (!vehicleIdStr) return c.json({ error: "vehicleId required" }, 400);
  const vehicleIdNum = Number(vehicleIdStr);
  if (!Number.isFinite(vehicleIdNum)) return c.json({ error: "vehicleId must be numeric" }, 400);

  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) return c.json({ error: "no motive api key configured for this org" }, 400);

  const MAX_PAGES = 50;
  // Motive's /v1/driving_periods uses `start_date` (YYYY-MM-DD), not
  // `start_time`. Per docs, when no date params are given the default
  // is "today minus 7 days." We pin start_date explicitly to honor the
  // `days` parameter.
  const endDate   = new Date();
  const startDate = new Date(endDate.getTime() - days * 86_400_000);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr   = endDate.toISOString().slice(0, 10);

  // Probe Motive's driving_periods endpoint twice — once with default
  // filter (assigned-to-driver only) and once with
  // assigned_to_driver=false (unidentified records). Both calls scope
  // to the queried vehicle via vehicle_ids[] so we get an exact answer
  // instead of fetching the whole org and filtering client-side.
  const probe = async (extraParams: Record<string, string> = {}) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = [];
    let pagesFetched = 0;
    // Manually compose the query string so the brackets in
    // `vehicle_ids[]` stay literal — URLSearchParams encodes them to
    // %5B%5D and some Motive endpoints don't decode that form.
    const parts: string[] = [
      `start_date=${encodeURIComponent(startDateStr)}`,
      `end_date=${encodeURIComponent(endDateStr)}`,
      `vehicle_ids[]=${vehicleIdNum}`,
      `per_page=100`,
    ];
    for (const [k, v] of Object.entries(extraParams)) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    const firstUrl = `https://api.gomotive.com/v1/driving_periods?${parts.join('&')}`;
    let nextUrl: string | null = firstUrl;
    let httpStatus: number | null = null;
    let error: string | null = null;
    let firstRawSample: unknown = null;
    try {
      while (nextUrl && pagesFetched < MAX_PAGES) {
        const res = await fetch(nextUrl, { headers: { "x-api-key": apiKey, "Accept": "application/json" } });
        httpStatus = res.status;
        if (!res.ok) {
          error = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
          break;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await res.json();
        if (pagesFetched === 0) firstRawSample = data;
        const wrappers = data?.driving_periods ?? [];
        for (const w of wrappers) items.push(w.driving_period ?? w);
        pagesFetched++;
        const pagination = data?.pagination;
        if (pagination && pagination.per_page && pagination.total &&
            pagination.page * pagination.per_page < pagination.total) {
          const next: URL = new URL(nextUrl);
          next.searchParams.set("page_no", String(pagination.page + 1));
          nextUrl = next.toString();
        } else {
          nextUrl = null;
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    return { items, pagesFetched, httpStatus, error, firstRawSample, firstUrl };
  };

  // Motive's /v1/driving_periods defaults to "assigned periods only"
  // — unidentified ones (driver=null until reassigned in Motive) come
  // back only when the request opts in with assigned_to_driver=false.
  // Probe both flavors so we know if the missing trucks are hidden in
  // the unassigned bucket.
  const driving      = await probe();
  const unidentified = await probe({ assigned_to_driver: "false" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vehicleOf = (p: any): number | null => p?.vehicle?.id ?? p?.vehicle_id ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasDriver = (p: any): boolean => p?.driver?.id != null;
  const summarize = (probeRes: typeof driving) => {
    const ids = [...new Set(probeRes.items.map(vehicleOf).filter((v): v is number => v != null))].sort((a, b) => a - b);
    const periodsForVehicle = probeRes.items.filter(p => vehicleOf(p) === vehicleIdNum);
    const assignedCount   = periodsForVehicle.filter(hasDriver).length;
    const unassignedCount = periodsForVehicle.length - assignedCount;
    return {
      httpStatus: probeRes.httpStatus,
      pagesFetched: probeRes.pagesFetched,
      totalReturned: probeRes.items.length,
      uniqueVehicleIds: ids,
      includesQueriedVehicle: ids.includes(vehicleIdNum),
      periodsForQueriedVehicle: periodsForVehicle.length,
      assignedToDriver:   assignedCount,
      unassignedToDriver: unassignedCount,
      sampleForQueriedVehicle: periodsForVehicle.slice(0, 2),
      firstRawSample: probeRes.firstRawSample,
      firstUrl: probeRes.firstUrl,
      error: probeRes.error,
    };
  };

  // True row count over the same date window — using head:true so we
  // don't pay for the rows. We also pull a 3-row sample to eyeball.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: dbCount } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .gte("start_time", startDate.toISOString())
    .lte("start_time", endDate.toISOString());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: dbAssignedCount } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .gte("start_time", startDate.toISOString())
    .lte("start_time", endDate.toISOString())
    .not("driver_id", "is", null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: dbEligibleCount } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .eq("display_eligible", true)
    .gte("start_time", startDate.toISOString())
    .lte("start_time", endDate.toISOString());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dbSample } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id, vehicle_id, start_time, end_time, miles, display_eligible, driver_id, source")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .order("start_time", { ascending: false })
    .limit(3);

  return c.json({
    queriedVehicleId: vehicleIdNum,
    queriedDays:      days,
    queriedStartTime: `${startDateStr} → ${endDateStr}`,
    pagesCapAt:       MAX_PAGES,
    drivingPeriods:        summarize(driving),
    unidentifiedDriving:   summarize(unidentified),
    db: {
      rowsForQueriedVehicle: dbCount ?? 0,
      assignedRowsInWindow:  dbAssignedCount ?? 0,
      eligibleRowsInWindow:  dbEligibleCount ?? 0,
      sample: dbSample ?? [],
    },
  });
});

// ── Verify endpoint ─────────────────────────────────────────────────────
// Per-vehicle comparison of Motive's driving_periods against our DB
// for a given date window. Useful for catching ingest gaps: pulls the
// truth from Motive and shows side-by-side counts + sums by vehicle.

movements.get("/verify", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const from  = url.searchParams.get("from"); // YYYY-MM-DD
  const to    = url.searchParams.get("to");   // YYYY-MM-DD (exclusive)
  if (!from || !to) return c.json({ error: "from and to required (YYYY-MM-DD)" }, 400);

  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) return c.json({ error: "no motive api key configured for this org" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseDistance = (s: any): number => {
    if (typeof s !== "string") return 0;
    const m = s.trim().match(/^([\d,]+\.?\d*)\s*(mi|km)?$/i);
    if (!m) return 0;
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(v)) return 0;
    const unit = (m[2] ?? "mi").toLowerCase();
    return unit === "km" ? v * 0.621371 : v;
  };

  // Pull every driving period from Motive in the window. Hard cap
  // to avoid runaway responses for huge orgs.
  const MAX_PAGES = 100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPeriods: any[] = [];
  let pagesFetched = 0;
  let motiveError: string | null = null;
  let pageNo = 1;
  try {
    while (pagesFetched < MAX_PAGES) {
      const parts = [
        `start_date=${encodeURIComponent(from)}`,
        `end_date=${encodeURIComponent(to)}`,
        `per_page=100`,
        `page_no=${pageNo}`,
      ];
      const reqUrl = `https://api.gomotive.com/v1/driving_periods?${parts.join('&')}`;
      const res = await fetch(reqUrl, { headers: { "x-api-key": apiKey, "Accept": "application/json" } });
      if (!res.ok) {
        motiveError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const wrappers = data?.driving_periods ?? [];
      for (const w of wrappers) allPeriods.push(w.driving_period ?? w);
      pagesFetched++;

      const pagination = data?.pagination;
      const totalSoFar = pagesFetched * 100;
      if (!pagination || !pagination.total || totalSoFar >= pagination.total) break;
      pageNo++;
    }
  } catch (e) {
    motiveError = (e as Error).message;
  }

  // Group Motive results by vehicle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const motiveByVehicle: Record<number, { records: number; miles: number }> = {};
  for (const p of allPeriods) {
    const vid = p?.vehicle?.id;
    if (vid == null) continue;
    const m = motiveByVehicle[vid] ?? { records: 0, miles: 0 };
    m.records++;
    m.miles += parseDistance(p.distance);
    motiveByVehicle[vid] = m;
  }

  // Query our DB for the same window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dbRows } = await (supabase as any)
    .from("motive_driving_periods")
    .select("vehicle_id, miles")
    .eq("org_id", orgId)
    .gte("start_time", `${from}T00:00:00Z`)
    .lt("start_time",  `${to}T00:00:00Z`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbByVehicle: Record<number, { records: number; miles: number }> = {};
  for (const r of (dbRows ?? []) as Array<{ vehicle_id: number | null; miles: number | null }>) {
    if (r.vehicle_id == null) continue;
    const d = dbByVehicle[r.vehicle_id] ?? { records: 0, miles: 0 };
    d.records++;
    d.miles += r.miles ?? 0;
    dbByVehicle[r.vehicle_id] = d;
  }

  // Merge into per-vehicle rows
  const allVehicleIds = new Set<number>([
    ...Object.keys(motiveByVehicle).map(Number),
    ...Object.keys(dbByVehicle).map(Number),
  ]);
  const rows = [...allVehicleIds].sort((a, b) => a - b).map(vid => {
    const motive = motiveByVehicle[vid] ?? { records: 0, miles: 0 };
    const db     = dbByVehicle[vid]     ?? { records: 0, miles: 0 };
    const recordDiff = motive.records - db.records;
    const mileDiff   = motive.miles - db.miles;
    return {
      vehicleId: vid,
      motiveRecords: motive.records,
      motiveMiles:   Math.round(motive.miles * 10) / 10,
      dbRecords:     db.records,
      dbMiles:       Math.round(db.miles * 10) / 10,
      recordDiff,
      mileDiff:      Math.round(mileDiff * 10) / 10,
      ok:            recordDiff === 0 && Math.abs(mileDiff) < 1,
    };
  });

  const summary = {
    motiveTotalRecords: Object.values(motiveByVehicle).reduce((s, v) => s + v.records, 0),
    motiveTotalMiles:   Math.round(Object.values(motiveByVehicle).reduce((s, v) => s + v.miles, 0) * 10) / 10,
    dbTotalRecords:     Object.values(dbByVehicle).reduce((s, v) => s + v.records, 0),
    dbTotalMiles:       Math.round(Object.values(dbByVehicle).reduce((s, v) => s + v.miles, 0) * 10) / 10,
    vehiclesInMotive:   Object.keys(motiveByVehicle).length,
    vehiclesInDb:       Object.keys(dbByVehicle).length,
    okCount:            rows.filter(r => r.ok).length,
    mismatchCount:      rows.filter(r => !r.ok).length,
  };

  return c.json({
    window: { from, to },
    pagesFetched,
    pagesCapAt: MAX_PAGES,
    motiveError,
    summary,
    rows,
  });
});

// ── Odometer time-series ────────────────────────────────────────────────
//
// Per-vehicle odometer history for the asset-profile line chart. The
// daily cron writes one row per vehicle per day; this route returns
// them in chronological order for plotting.

movements.get("/odometer", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const vehicleIdStr = url.searchParams.get("vehicleId");
  const from = url.searchParams.get("from"); // optional ISO
  const to   = url.searchParams.get("to");   // optional ISO
  if (!vehicleIdStr) return c.json({ error: "vehicleId required" }, 400);
  const vehicleIdNum = Number(vehicleIdStr);
  if (!Number.isFinite(vehicleIdNum)) return c.json({ error: "vehicleId must be numeric" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("motive_odometer_readings")
    .select("captured_at, located_at, odometer_miles, true_odometer_miles")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .order("captured_at", { ascending: true });
  if (from) q = q.gte("captured_at", from);
  if (to)   q = q.lte("captured_at", to);

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/movements/odometer] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  return c.json({
    vehicleId: vehicleIdNum,
    readings:  data ?? [],
  });
});

// ── Odometer fleet-wide aggregate ──────────────────────────────────────
//
// `GET /v1/movements/odometer-summary?from=&to=`
//
// Returns ELD-only fleet mileage for the period: for every asset that
// has motive_vehicle_id set, compute `max(odometer_miles) - min(...)`
// within [from, to] and sum. Used by the dashboard's Total Miles tile,
// which previously summed raw driving-period fragments (the wrong
// table — Motive splits long trips into many sub-mile records).
//
// One round-trip: pull all readings for the org in window, group by
// asset in TS, and aggregate. With one reading per asset per day this
// is ~30 rows × asset count per month — trivially small.

movements.get("/odometer-summary", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const from  = url.searchParams.get("from");
  const to    = url.searchParams.get("to");
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO)"] }, 400);
  }

  // Step 1: which assets have ELDs? `motive_vehicle_id IS NOT NULL` is
  // the canonical signal. Pull both the asset id AND the Motive vehicle
  // id — we need the vehicle id to match Motive-sourced readings, since
  // those rows historically (and currently, until backfill catches up)
  // have asset_id IS NULL. The 2026-05-29 migration added asset_id but
  // its own comment punted the ingest update to "eventually", which
  // meant every daily snapshot kept landing as asset_id=NULL. The
  // dashboard's Total Miles tile then read 0 for every org with only
  // Motive-sourced rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: assetRows, error: assetErr } = await (supabase as any)
    .from("assets")
    .select("id, motive_vehicle_id")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (assetErr) {
    console.error("[GET /v1/movements/odometer-summary] assets fetch:", assetErr);
    return c.json({ error: "fetch_failed", detail: assetErr.message }, 500);
  }
  const eldAssets = (assetRows ?? []) as Array<{ id: number; motive_vehicle_id: number | null }>;
  if (eldAssets.length === 0) {
    return c.json({ totalMiles: 0, eldAssetCount: 0, perAsset: {} });
  }
  const eldAssetIds   = eldAssets.map(a => a.id);
  const eldVehicleIds = eldAssets.map(a => a.motive_vehicle_id).filter((v): v is number => v != null);
  // Reverse map for grouping rows whose asset_id is NULL — we resolve
  // them back to the right asset via their Motive vehicle id.
  const vehicleIdToAssetId = new Map<number, number>();
  for (const a of eldAssets) {
    if (a.motive_vehicle_id != null) vehicleIdToAssetId.set(a.motive_vehicle_id, a.id);
  }

  // Step 2: pull readings that match either axis. We deliberately
  // run TWO queries instead of a single `.or()` with nested
  // `in.(...)` — PostgREST's OR parsing splits on commas, which can
  // misinterpret the commas inside the in-list under some versions
  // and silently return zero rows. Two queries cost the same
  // wall-clock when run in parallel; deduping by row id in TS is
  // trivial.
  type ReadingRow = {
    id: number; asset_id: number | null; vehicle_id: number | null;
    captured_at: string;
    odometer_miles: number | null; true_odometer_miles: number | null;
  };
  const select = "id, asset_id, vehicle_id, captured_at, odometer_miles, true_odometer_miles";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byAssetIdP = (supabase as any)
    .from("motive_odometer_readings")
    .select(select)
    .eq("org_id", orgId)
    .in("asset_id", eldAssetIds)
    .gte("captured_at", from)
    .lte("captured_at", to);
  const byVehicleIdP = eldVehicleIds.length > 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (supabase as any)
        .from("motive_odometer_readings")
        .select(select)
        .eq("org_id", orgId)
        .in("vehicle_id", eldVehicleIds)
        .gte("captured_at", from)
        .lte("captured_at", to)
    : Promise.resolve({ data: [], error: null });
  const [
    { data: rowsAsset,   error: rowsAssetErr },
    { data: rowsVehicle, error: rowsVehicleErr },
  ] = await Promise.all([byAssetIdP, byVehicleIdP]);
  if (rowsAssetErr) {
    console.error("[GET /v1/movements/odometer-summary] by-asset fetch:", rowsAssetErr);
    return c.json({ error: "fetch_failed", detail: rowsAssetErr.message }, 500);
  }
  if (rowsVehicleErr) {
    console.error("[GET /v1/movements/odometer-summary] by-vehicle fetch:", rowsVehicleErr);
    return c.json({ error: "fetch_failed", detail: rowsVehicleErr.message }, 500);
  }

  // Dedup: rows with both asset_id and vehicle_id set match both queries.
  const seen = new Set<number>();
  const rows: ReadingRow[] = [];
  for (const r of [...(rowsAsset ?? []), ...(rowsVehicle ?? [])] as ReadingRow[]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
  }

  // Step 3: group by RESOLVED asset_id (asset_id when set, otherwise
  // look up via vehicle_id). Compute max - min per asset.
  // true_odometer_miles wins when present (Motive provides a
  // back-calculated true reading that survives sensor resets);
  // otherwise fall back to the raw odometer_miles.
  const byAsset = new Map<number, { min: number; max: number }>();
  let countedRows = 0;
  let unresolvedRows = 0;
  let nullMilesRows = 0;
  for (const r of rows) {
    const assetId = r.asset_id
      ?? (r.vehicle_id != null ? vehicleIdToAssetId.get(r.vehicle_id) : undefined);
    if (assetId == null) { unresolvedRows++; continue; }
    const miles = r.true_odometer_miles ?? r.odometer_miles;
    if (miles == null) { nullMilesRows++; continue; }
    countedRows++;
    const cur = byAsset.get(assetId);
    if (!cur) byAsset.set(assetId, { min: miles, max: miles });
    else {
      cur.min = Math.min(cur.min, miles);
      cur.max = Math.max(cur.max, miles);
    }
  }

  const perAsset: Record<number, number> = {};
  let total = 0;
  for (const [assetId, { min, max }] of byAsset) {
    const delta = Math.max(0, max - min);
    perAsset[assetId] = delta;
    total += delta;
  }

  // Diagnostic logging — Railway logs will show exactly where the
  // pipeline collapsed if total ever comes back as 0 again.
  console.log(
    `[odometer-summary] org=${orgId} window=${from}→${to} ` +
    `eldAssets=${eldAssets.length} eldVehicles=${eldVehicleIds.length} ` +
    `rowsAsset=${(rowsAsset ?? []).length} rowsVehicle=${(rowsVehicle ?? []).length} ` +
    `deduped=${rows.length} counted=${countedRows} ` +
    `unresolved=${unresolvedRows} nullMiles=${nullMilesRows} ` +
    `groups=${byAsset.size} totalMiles=${total}`,
  );

  return c.json({
    totalMiles:    total,
    eldAssetCount: byAsset.size,
    perAsset,
    // Surface the raw counts so the dashboard (or curl) can see which
    // pipeline stage is empty without digging into Railway logs.
    debug: {
      eldAssets:        eldAssets.length,
      eldVehicleIds:    eldVehicleIds.length,
      rowsByAssetId:    (rowsAsset ?? []).length,
      rowsByVehicleId:  (rowsVehicle ?? []).length,
      rowsDeduped:      rows.length,
      countedRows,
      unresolvedRows,
      nullMilesRows,
      groupedAssets:    byAsset.size,
    },
  });
});

// ── Manual odometer snapshot (admin) — useful for testing + first-load
// before the daily cron has had a chance to run.

movements.post("/odometer/snapshot", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  try {
    const result = await snapshotOdometers(orgId);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error("[POST /v1/movements/odometer/snapshot] failed:", err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

export default movements;
