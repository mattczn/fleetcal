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
import { syncBackfill, syncIncremental, getOrgMotiveKey } from "../lib/motiveIngest.js";

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
    .eq("display_eligible", true)
    .gte("start_time", from)
    .lte("start_time", to)
    .order("start_time", { ascending: true });
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

  const startTime = new Date(Date.now() - days * 86_400_000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPeriods: any[] = [];
  const MAX_PAGES = 50;
  let pagesFetched = 0;
  let nextUrl: string | null = `https://api.gomotive.com/v1/driving_periods?start_time=${encodeURIComponent(startTime)}&per_page=100`;
  let motiveError: string | null = null;

  try {
    while (nextUrl && pagesFetched < MAX_PAGES) {
      const res = await fetch(nextUrl, { headers: { "x-api-key": apiKey, "Accept": "application/json" } });
      if (!res.ok) {
        motiveError = `Motive HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        break;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const wrappers = data?.driving_periods ?? [];
      for (const w of wrappers) allPeriods.push(w.driving_period ?? w);
      pagesFetched++;

      const pagination = data?.pagination;
      if (pagination && pagination.per_page && pagination.total &&
          pagination.page * pagination.per_page < pagination.total) {
        const nextUrlObj: URL = new URL(nextUrl);
        nextUrlObj.searchParams.set("page_no", String(pagination.page + 1));
        nextUrl = nextUrlObj.toString();
      } else {
        nextUrl = null;
      }
    }
  } catch (e) {
    motiveError = (e as Error).message;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vehicleOf = (p: any): number | null => p?.vehicle?.id ?? null;
  const uniqueVehicleIds = [...new Set(allPeriods.map(vehicleOf).filter((v): v is number => v != null))].sort((a, b) => a - b);
  const periodsForVehicle = allPeriods.filter(p => vehicleOf(p) === vehicleIdNum);

  // DB rows for this vehicle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dbRows } = await (supabase as any)
    .from("motive_driving_periods")
    .select("id, vehicle_id, vehicle_number, start_time, end_time, miles, display_eligible")
    .eq("org_id", orgId)
    .eq("vehicle_id", vehicleIdNum)
    .order("start_time", { ascending: false })
    .limit(5);

  return c.json({
    queriedVehicleId: vehicleIdNum,
    queriedDays:      days,
    queriedStartTime: startTime,
    motive: {
      pagesFetched,
      pagesCapAt: MAX_PAGES,
      totalPeriodsReturned: allPeriods.length,
      uniqueVehicleIdsInResponse: uniqueVehicleIds,
      includesQueriedVehicle:    uniqueVehicleIds.includes(vehicleIdNum),
      periodsForQueriedVehicle:  periodsForVehicle.length,
      sampleForQueriedVehicle:   periodsForVehicle.slice(0, 3),
      error: motiveError,
    },
    db: {
      rowsForQueriedVehicle: dbRows?.length ?? 0,
      sample: dbRows ?? [],
    },
  });
});

export default movements;
