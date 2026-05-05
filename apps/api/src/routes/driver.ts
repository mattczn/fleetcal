/**
 * /v1/driver/* — endpoints scoped to the authenticated driver. All routes
 * mounted here go through the `driverAuth` middleware (verifies Supabase
 * JWT, resolves to drivers row), so handlers can trust c.get("driverId")
 * and c.get("orgId") to be the actual driver's identity.
 */
import { Hono } from "hono";
import {
  joinEventLoadToApp,
  type Load,
  type Stop,
  type StopType,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { driverAuth, type DriverAuthVariables } from "../middleware/driverAuth.js";

const driver = new Hono<{ Variables: DriverAuthVariables }>();

driver.use("*", driverAuth);

// ─────────────────────────────────────────────────────────────────────────
// Column lists + row converters (mirror loads.ts; duplicated here so the
// driver routes can evolve independently without touching the dispatch
// loads route surface).
// ─────────────────────────────────────────────────────────────────────────

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  "dispatcher,notes,internal_note,accessorials,rate_con_pdf,ref_nums," +
  "audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

interface StopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  timezone: string | null;
  appt_start: string | null;
  appt_end: string | null;
  schedule_type: string | null;
  lat: number | null;
  lng: number | null;
  instructions: string | null;
  geocode_status: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

function rowToStop(s: StopRow): Stop {
  return {
    id:            s.id,
    eventId:       s.event_id,
    sequence:      s.sequence,
    type:          s.type as StopType,
    facilityName:  s.facility_name ?? undefined,
    address:       s.address       ?? undefined,
    city:          s.city          ?? undefined,
    timezone:      s.timezone      ?? undefined,
    apptStart:     s.appt_start    ?? undefined,
    apptEnd:       s.appt_end      ?? undefined,
    scheduleType:  (s.schedule_type as Stop["scheduleType"]) ?? undefined,
    lat:           s.lat           ?? undefined,
    lng:           s.lng           ?? undefined,
    instructions:  s.instructions  ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
    arrivedAt:     s.arrived_at    ?? undefined,
    arrivedLat:    s.arrived_lat   ?? undefined,
    arrivedLng:    s.arrived_lng   ?? undefined,
  };
}

interface AssetMini { id: number; name: string; unit: string | null; color: string | null; motive_vehicle_id: string | null }
interface TrailerMini { id: number; name: string; trailer_number: string | null }

/**
 * Take a list of joined event rows + their stop/asset/trailer rows and
 * stitch them into the Load[] domain shape. Same pattern as loads.ts but
 * also copies asset.name/unit and trailer info onto the Load so the
 * driver app doesn't have to do a follow-up lookup.
 */
function buildLoads(
  eventRows:    Record<string, unknown>[],
  stopsByEvent: Map<string, Stop[]>,
  assetsById:   Map<number, AssetMini>,
  trailersById: Map<number, TrailerMini>,
): Load[] {
  return eventRows.map((e) => {
    const ev = e as Record<string, unknown> & {
      load?: Record<string, unknown>[] | Record<string, unknown> | null;
      asset_id: number;
      trailer_id?: number | null;
    };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);

    const asset = assetsById.get(ev.asset_id);
    if (asset) {
      joined.assetName = `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}`;
      // motiveVehicleId lives on assets — copy it onto the Load so the
      // driver app can show truck location without a separate query.
      if (asset.motive_vehicle_id) joined.motiveVehicleId = asset.motive_vehicle_id;
    }
    if (ev.trailer_id != null) {
      const t = trailersById.get(ev.trailer_id);
      if (t) joined.trailerName = `#${t.trailer_number ?? t.name}`;
    }
    return joined;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

driver.get("/me", (c) => {
  return c.json({
    driverId:   c.get("driverId"),
    orgId:      c.get("orgId"),
    name:       c.get("driverName"),
    phone:      c.get("phone"),
  });
});

// GET /v1/driver/loads — every (non-deleted) load assigned to the auth'd
// driver, ordered by start time. Takes optional ?from / ?to date filters
// (same semantics as /v1/loads — overlap with the window).
driver.get("/loads", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (from) q = q.gte("end", from);
  if (to)   q = q.lte("start", to);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/driver/loads] failed:", error);
    return c.json({ error: "list_failed", detail: error.message }, 500);
  }
  const rows = (events ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return c.json({ loads: [] });

  const eventIds = rows.map((r) => r.id as string);
  const assetIds = Array.from(new Set(rows.map((r) => r.asset_id as number)));
  const trailerIds = Array.from(new Set(
    rows.map((r) => r.trailer_id as number | null).filter((x): x is number => x != null),
  ));

  const [stopsRes, assetsRes, trailersRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit,color,motive_vehicle_id").in("id", assetIds),
    trailerIds.length > 0
      ? supabase.from("trailers").select("id,name,trailer_number").in("id", trailerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (stopsRes.error)    console.error("[GET /v1/driver/loads] stops:",    stopsRes.error);
  if (assetsRes.error)   console.error("[GET /v1/driver/loads] assets:",   assetsRes.error);
  if (trailersRes.error) console.error("[GET /v1/driver/loads] trailers:", trailersRes.error);

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as unknown as StopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }
  const assetsById = new Map<number, AssetMini>();
  for (const a of (assetsRes.data ?? []) as unknown as AssetMini[]) assetsById.set(a.id, a);
  const trailersById = new Map<number, TrailerMini>();
  for (const t of (trailersRes.data ?? []) as unknown as TrailerMini[]) trailersById.set(t.id, t);

  const loads = buildLoads(rows, stopsByEvent, assetsById, trailersById);
  return c.json({ loads });
});

// GET /v1/driver/loads/:id — single load by event id, scoped to the auth'd
// driver. Includes the relay partner leg's stops + driver name when this
// is one half of a relay so the driver can see what comes after their leg.
driver.get("/loads/:id", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const { data: row, error } = await supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/driver/loads/:id] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!row) return c.json({ error: "not_found" }, 404);

  const ev = row as Record<string, unknown> & {
    asset_id: number;
    trailer_id: number | null;
    relay_role: string | null;
    load?: Record<string, unknown>[] | Record<string, unknown> | null;
  };
  const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);

  const [stopsRes, assetRes, trailerRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).eq("event_id", id),
    supabase.from("assets").select("id,name,unit,color,motive_vehicle_id").eq("id", ev.asset_id).maybeSingle(),
    ev.trailer_id != null
      ? supabase.from("trailers").select("id,name,trailer_number").eq("id", ev.trailer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const stopsByEvent = new Map<string, Stop[]>();
  stopsByEvent.set(
    id,
    ((stopsRes.data ?? []) as unknown as StopRow[]).map(rowToStop).sort((a, b) => a.sequence - b.sequence),
  );
  const assetsById = new Map<number, AssetMini>();
  if (assetRes.data) assetsById.set(ev.asset_id, assetRes.data as unknown as AssetMini);
  const trailersById = new Map<number, TrailerMini>();
  if (trailerRes.data && ev.trailer_id != null) {
    trailersById.set(ev.trailer_id, trailerRes.data as unknown as TrailerMini);
  }

  const [load] = buildLoads([ev], stopsByEvent, assetsById, trailersById);

  // Relay partner — same load_id, different event id. Surface stops + driver
  // name so the driver knows where their leg hands off (or starts from).
  if (loadRow && (loadRow as { id?: string }).id && ev.relay_role) {
    const partnerLoadId = (loadRow as { id: string }).id;
    const { data: partner } = await supabase
      .from("events")
      .select("id, driver_name")
      .eq("load_id", partnerLoadId)
      .eq("org_id", orgId)
      .neq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (partner) {
      const partnerEv = partner as { id: string; driver_name: string | null };
      const { data: partnerStops } = await supabase
        .from("stops")
        .select(STOP_COLS)
        .eq("event_id", partnerEv.id);
      load.partnerEventId   = partnerEv.id;
      load.partnerDriverName = partnerEv.driver_name ?? undefined;
      load.partnerStops      = ((partnerStops ?? []) as unknown as StopRow[])
        .map(rowToStop)
        .sort((a, b) => a.sequence - b.sequence);
    }
  }

  return c.json({ load });
});

// GET /v1/driver/org-settings — the subset of org_settings the driver app
// actually reads. Right now that's just showDriverPay; defaults to false.
driver.get("/org-settings", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // 42P01/42703 = table or column doesn't exist; treat as defaults.
    if (error.code !== "42P01" && error.code !== "42703") {
      console.error("[GET /v1/driver/org-settings] failed:", error);
      return c.json({ error: "fetch_failed", detail: error.message }, 500);
    }
  }
  const showDriverPay = (data as { show_driver_pay: boolean } | null)?.show_driver_pay ?? false;
  return c.json({ settings: { showDriverPay } });
});

// GET /v1/driver/trailers — list of trailers in the driver's org for the
// trailer picker. Sort order matches the dispatch app.
driver.get("/trailers", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("trailers")
    .select("id, name, trailer_number, category, sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/driver/trailers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const trailers = (data ?? []).map((t) => {
    const r = t as { id: number; name: string; trailer_number: string | null; category: string };
    return {
      id:            r.id,
      name:          r.name,
      trailerNumber: r.trailer_number ?? undefined,
      category:      r.category,
    };
  });
  return c.json({ trailers });
});

export default driver;
