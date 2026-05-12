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
  type DocumentKind,
  DOCUMENT_KINDS,
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
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  // Note: `internal_notes` deliberately excluded — those are dispatch's
  // private commentary on the load; drivers should never see them.
  "dispatcher,notes,accessorials,rate_con_pdf,ref_nums," +
  "audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

interface StopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
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
    state:         s.state         ?? undefined,
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

driver.get("/me", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const { data } = await supabase
    .from("drivers")
    .select("id,name,first_name,last_name,phone,notes,email,address," +
            "license_number,license_state,license_exp,medical_card_exp,dob")
    .eq("id", driverId)
    .eq("org_id", orgId)
    .maybeSingle();
  const row = data as {
    id: number; name: string; first_name: string | null; last_name: string | null;
    phone: string | null; notes: string | null; email: string | null;
    address: string | null; license_number: string | null; license_state: string | null;
    license_exp: string | null; medical_card_exp: string | null; dob: string | null;
  } | null;
  return c.json({
    driverId,
    orgId,
    name:           row?.name ?? c.get("driverName"),
    firstName:      row?.first_name      ?? undefined,
    lastName:       row?.last_name       ?? undefined,
    phone:          row?.phone           ?? c.get("phone"),
    email:          row?.email           ?? undefined,
    address:        row?.address         ?? undefined,
    licenseNumber:  row?.license_number  ?? undefined,
    licenseState:   row?.license_state   ?? undefined,
    licenseExp:     row?.license_exp     ?? undefined,
    medicalCardExp: row?.medical_card_exp?? undefined,
    dob:            row?.dob             ?? undefined,
    notes:          row?.notes           ?? undefined,
  });
});

// PATCH /v1/driver/me — driver edits their own HR / compliance fields.
// The driver can NOT change their own `name`, `notes`, or org binding
// (those are ops decisions); everything else is fair game.
driver.patch("/me", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const update: Record<string, unknown> = {};
  if ("firstName"      in body) update.first_name       = body.firstName      ?? null;
  if ("lastName"       in body) update.last_name        = body.lastName       ?? null;
  if ("phone"          in body) update.phone            = body.phone          ?? null;
  if ("email"          in body) update.email            = body.email          ?? null;
  if ("address"        in body) update.address          = body.address        ?? null;
  if ("licenseNumber"  in body) update.license_number   = body.licenseNumber  ?? null;
  if ("licenseState"   in body) {
    update.license_state = typeof body.licenseState === "string" && body.licenseState.trim()
      ? body.licenseState.toUpperCase() : null;
  }
  if ("licenseExp"     in body) update.license_exp      = body.licenseExp     ?? null;
  if ("medicalCardExp" in body) update.medical_card_exp = body.medicalCardExp ?? null;
  if ("dob"            in body) update.dob              = body.dob            ?? null;

  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] }, 400);
  }

  // Keep `name` in sync if first/last changed. Drivers don't edit name
  // directly, but we want the display name updated when they fill in
  // first/last name for the first time.
  if (("first_name" in update || "last_name" in update)) {
    const { data: cur } = await supabase
      .from("drivers")
      .select("first_name,last_name,name")
      .eq("id", driverId)
      .eq("org_id", orgId)
      .maybeSingle();
    const curRow = cur as { first_name: string | null; last_name: string | null; name: string } | null;
    const nextFirst = ("first_name" in update ? update.first_name : curRow?.first_name) as string | null;
    const nextLast  = ("last_name"  in update ? update.last_name  : curRow?.last_name)  as string | null;
    const joined = [nextFirst, nextLast].filter(Boolean).join(" ").trim();
    if (joined && joined !== curRow?.name) update.name = joined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("drivers")
    .update(update as any)
    .eq("id", driverId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/driver/me] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
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

  // Doc-kind counts per load — drives the driver app's "delivered
  // without POD" warning chip on each load card. One query for the
  // visible page; relay loads share a load_id so both legs see the
  // same counts.
  const loadIds = Array.from(new Set(
    rows.map(r => (r.load_id as string | null)).filter((id): id is string => !!id),
  ));
  const countsByLoad = new Map<string, Record<string, number>>();
  if (loadIds.length > 0) {
    const { data: docs, error: docErr } = await supabase
      .from("load_documents")
      .select("load_id, kind")
      .eq("org_id", orgId)
      .in("load_id", loadIds);
    if (docErr) {
      console.error("[GET /v1/driver/loads] doc counts:", docErr);
    } else {
      for (const d of (docs ?? []) as Array<{ load_id: string | null; kind: string }>) {
        if (!d.load_id) continue;
        const m = countsByLoad.get(d.load_id) ?? {};
        m[d.kind] = (m[d.kind] ?? 0) + 1;
        countsByLoad.set(d.load_id, m);
      }
    }
  }

  const loads = buildLoads(rows, stopsByEvent, assetsById, trailersById);
  for (const l of loads) {
    if (!l.loadId) continue;
    const counts = countsByLoad.get(l.loadId);
    if (counts) l.documentCounts = counts;
  }
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

  // Doc-kind counts — same shape as the list endpoint so the load
  // detail screen can derive "delivered without POD" too. Cheap
  // single query keyed by load_id (shared across relay legs).
  if (load.loadId) {
    const { data: docs, error: docErr } = await supabase
      .from("load_documents")
      .select("kind")
      .eq("org_id", orgId)
      .eq("load_id", load.loadId);
    if (docErr) {
      console.error("[GET /v1/driver/loads/:id] doc counts:", docErr);
    } else {
      const counts: Record<string, number> = {};
      for (const d of (docs ?? []) as Array<{ kind: string }>) {
        counts[d.kind] = (counts[d.kind] ?? 0) + 1;
      }
      load.documentCounts = counts;
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
// GET /v1/driver/suggested-asset — best guess at the truck the driver is
// currently in. Used by the fuel + maintenance forms to pre-select.
//
// Lookup order:
//   1. Any non-deleted revenue OR non-revenue event assigned to this
//      driver whose [start, end] overlaps the window [now-6h, now+6h].
//      Take the event with the closest start to now.
//   2. The driver_asset_prefs row for this driver, if any.
//   3. null — caller shows the picker without a default.
driver.get("/suggested-asset", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const now    = new Date();
  const lookback = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const lookahead = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  // 1) Active / near-active events for this driver. Overlap with
  //    [lookback, lookahead] is: end >= lookback AND start <= lookahead.
  const { data: events } = await supabase
    .from("events")
    .select("asset_id, start")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .gte("end",   lookback.toISOString())
    .lte("start", lookahead.toISOString())
    .order("start", { ascending: true });

  const eventRows = (events ?? []) as Array<{ asset_id: number | null; start: string }>;
  if (eventRows.length > 0) {
    const nowMs = now.getTime();
    let best = eventRows[0];
    let bestDist = Math.abs(new Date(best.start).getTime() - nowMs);
    for (const e of eventRows.slice(1)) {
      const d = Math.abs(new Date(e.start).getTime() - nowMs);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    if (best.asset_id != null) {
      return c.json({ assetId: best.asset_id, source: "event" });
    }
  }

  // 2) Stored preference.
  const { data: pref } = await supabase
    .from("driver_asset_prefs")
    .select("asset_id")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .maybeSingle();
  const prefRow = pref as { asset_id: number } | null;
  if (prefRow?.asset_id != null) {
    return c.json({ assetId: prefRow.asset_id, source: "preference" });
  }

  return c.json({ assetId: null, source: null });
});

// GET /v1/driver/assets — every non-hidden asset in the driver's org.
// Used by the fuel-report form (driver picks which truck they're fueling).
// Returns the lean shape the form needs — full asset detail lives in the
// dispatch surface.
driver.get("/assets", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("assets")
    .select("id, name, unit, truck, color, type, sort_order")
    .eq("org_id", orgId)
    .eq("hidden", false)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/driver/assets] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const assets = (data ?? []).map((a) => {
    const r = a as { id: number; name: string; unit: string | null; truck: string | null; color: string; type: string };
    return {
      id:    r.id,
      name:  r.name,
      unit:  r.unit  ?? undefined,
      truck: r.truck ?? undefined,
      color: r.color,
      type:  r.type,
    };
  });
  return c.json({ assets });
});

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

// ─────────────────────────────────────────────────────────────────────────
// Audit-log helper — read-modify-write append on events.audit_log JSONB.
// Driver-paced edits are sequential per device, so optimistic update is
// fine; high-contention writes would need a postgres function instead.
// ─────────────────────────────────────────────────────────────────────────

interface AuditEntry {
  changedAt:    string;
  changedByName: string;
  prevStatus?:  string;
  newStatus?:   string;
  trailerChanged?: { prev?: string; next?: string };
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?:  { fileName: string; kind: string };
  stopCheckedIn?:    { stopFacility?: string; stopType?: string; distanceMi?: number };
  stopCheckInUndone?: { stopFacility?: string; stopType?: string };
}

async function appendAudit(
  eventId: string,
  orgId:   string,
  entry:   AuditEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from("events")
    .select("audit_log")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) { console.error("[driver/appendAudit] read:", error); return; }
  const existing = ((data as { audit_log: AuditEntry[] | null } | null)?.audit_log) ?? [];
  const next = [...existing, entry];
  const { error: writeErr } = await supabase
    .from("events")
    .update({ audit_log: next as never })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (writeErr) console.error("[driver/appendAudit] write:", writeErr);
}

// Fetch the event ensuring it belongs to the auth'd driver. Used as a
// pre-check before mutating writes — refuses 404 / 403 explicitly so
// the driver app can show a clear error rather than a silent no-op.
async function loadDriverEvent(eventId: string, driverId: number, orgId: string) {
  const { data, error } = await supabase
    .from("events")
    .select("id, driver_id, org_id, status, trailer_id, deleted_at")
    .eq("id", eventId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; driver_id: number | null; org_id: string; status: string; trailer_id: number | null; deleted_at: string | null };
  if (row.org_id !== orgId)        return { row: null, reason: "wrong_org"   as const };
  if (row.driver_id !== driverId)  return { row: null, reason: "not_driver"  as const };
  if (row.deleted_at)              return { row: null, reason: "deleted"     as const };
  return { row, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Write endpoints
// ─────────────────────────────────────────────────────────────────────────

// PATCH /v1/driver/loads/:id — partial update for the fields a driver can
// change: status and trailer. Both audit-logged with the driver's name.
driver.patch("/loads/:id", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id   = c.req.param("id");
  const body = await c.req.json<{ status?: string; trailerId?: number | null }>();

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (found.row === null) return c.json({ error: "forbidden", reason: found.reason }, 403);
  const prev = found.row;

  const update: Record<string, unknown> = {};
  if (body.status !== undefined)    update.status     = body.status;
  if (body.trailerId !== undefined) update.trailer_id = body.trailerId;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["nothing to update"] }, 400);
  }

  const { error } = await supabase
    .from("events")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/driver/loads/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }

  // Audit each kind of change separately so the timeline reads cleanly.
  if (body.status !== undefined && body.status !== prev.status) {
    await appendAudit(id, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: driverName,
      prevStatus:   prev.status,
      newStatus:    body.status,
    });
  }
  if (body.trailerId !== undefined && body.trailerId !== prev.trailer_id) {
    await appendAudit(id, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: driverName,
      trailerChanged: {
        prev: prev.trailer_id != null ? String(prev.trailer_id) : undefined,
        next: body.trailerId != null  ? String(body.trailerId)  : undefined,
      },
    });
  }

  return c.json({ ok: true });
});

// POST /v1/driver/stops/:id/check-in — record arrival at a stop. Body:
// { lat, lng }. Server stamps arrived_at = now() so the device clock
// can't drift the timeline.
driver.post("/stops/:id/check-in", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const stopId = c.req.param("id");
  const body = await c.req.json<{ lat: number; lng: number; distanceMi?: number }>();

  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return c.json({ error: "validation_failed", errors: ["lat/lng required"] }, 400);
  }

  // Verify the stop belongs to a load assigned to the auth'd driver before
  // letting them mark it. Fetches the stop + parent event in one nested
  // select; rejects if the parent isn't theirs.
  const { data: stopRow, error: stopErr } = await supabase
    .from("stops")
    .select("id, event_id, type, facility_name, org_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopErr || !stopRow) return c.json({ error: "not_found" }, 404);
  const stop = stopRow as { id: string; event_id: string; type: string; facility_name: string | null; org_id: string };
  if (stop.org_id !== orgId) return c.json({ error: "forbidden" }, 403);

  const found = await loadDriverEvent(stop.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { error: writeErr } = await supabase
    .from("stops")
    .update({
      arrived_at:  new Date().toISOString(),
      arrived_lat: body.lat,
      arrived_lng: body.lng,
    })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (writeErr) {
    console.error("[POST /v1/driver/stops/:id/check-in] failed:", writeErr);
    return c.json({ error: "update_failed", detail: writeErr.message }, 500);
  }

  await appendAudit(stop.event_id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    stopCheckedIn: {
      stopFacility: stop.facility_name ?? undefined,
      stopType:     stop.type,
      distanceMi:   body.distanceMi,
    },
  });

  return c.json({ ok: true });
});

// POST /v1/driver/stops/:id/check-out — undo the check-in. Clears the
// arrived_at/lat/lng triple and audits the undo.
driver.post("/stops/:id/check-out", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const stopId = c.req.param("id");

  const { data: stopRow, error: stopErr } = await supabase
    .from("stops")
    .select("id, event_id, type, facility_name, org_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopErr || !stopRow) return c.json({ error: "not_found" }, 404);
  const stop = stopRow as { id: string; event_id: string; type: string; facility_name: string | null; org_id: string };
  if (stop.org_id !== orgId) return c.json({ error: "forbidden" }, 403);

  const found = await loadDriverEvent(stop.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { error: writeErr } = await supabase
    .from("stops")
    .update({ arrived_at: null, arrived_lat: null, arrived_lng: null })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (writeErr) {
    console.error("[POST /v1/driver/stops/:id/check-out] failed:", writeErr);
    return c.json({ error: "update_failed", detail: writeErr.message }, 500);
  }

  await appendAudit(stop.event_id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    stopCheckInUndone: {
      stopFacility: stop.facility_name ?? undefined,
      stopType:     stop.type,
    },
  });

  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Documents — list, upload, delete, signed URL
// ─────────────────────────────────────────────────────────────────────────

const DOC_BUCKET = "load-documents";

interface DocRow {
  id: string;
  event_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string;
  uploaded_at: string;
  uploaded_by_driver_id: number | null;
  notes: string | null;
}

function rowToDoc(r: DocRow) {
  return {
    id:           r.id,
    eventId:      r.event_id,
    storagePath:  r.storage_path,
    fileName:     r.file_name,
    mimeType:     r.mime_type ?? undefined,
    sizeBytes:    r.size_bytes ?? undefined,
    kind:         r.kind,
    uploadedAt:   r.uploaded_at,
    uploadedByDriverId: r.uploaded_by_driver_id ?? undefined,
    notes:        r.notes ?? undefined,
  };
}

// GET /v1/driver/loads/:id/documents — list documents for a load assigned
// to the auth'd driver, newest first.
//
// `:id` is an event id. For relay loads the two legs share a single
// loads.id but each leg has its own event, so we resolve the event's
// load_id and query by that — both pickup and delivery drivers then
// see the same handoff photos. Non-revenue events have no load_id;
// we fall back to event_id-scoped listing in that case.
driver.get("/loads/:id/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { data: ev } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", id)
    .maybeSingle();
  const loadId = (ev as { load_id: string | null } | null)?.load_id ?? null;

  const baseQuery = supabase
    .from("load_documents")
    .select("*")
    .eq("org_id", orgId)
    .order("uploaded_at", { ascending: false });
  const { data, error } = await (loadId
    ? baseQuery.eq("load_id", loadId)
    : baseQuery.eq("event_id", id));

  if (error) {
    console.error("[GET /v1/driver/loads/:id/documents] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const rows = (data ?? []) as DocRow[];

  // Batch-mint signed URLs so thumbnails render without a per-doc round-trip.
  const urlByPath = new Map<string, string>();
  if (rows.length > 0) {
    const { data: signed, error: signErr } = await supabase.storage
      .from(DOC_BUCKET)
      .createSignedUrls(rows.map((r) => r.storage_path), 3600);
    if (signErr) {
      console.error("[GET /v1/driver/loads/:id/documents] sign failed:", signErr);
    } else {
      for (const u of signed ?? []) {
        if (u.path && u.signedUrl) urlByPath.set(u.path, u.signedUrl);
      }
    }
  }

  const documents = rows.map((r) => ({
    ...rowToDoc(r),
    signedUrl: urlByPath.get(r.storage_path),
  }));
  return c.json({ documents });
});

// POST /v1/driver/loads/:id/documents — multipart upload. Form fields:
//   file (binary), kind ("bol" | "pod" | "scale" | "other")
// Server writes to the load-documents bucket with the service role key
// and inserts a load_documents row, then audits.
driver.post("/loads/:id/documents", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  let body: { file?: File; kind?: string };
  try { body = await c.req.parseBody() as { file?: File; kind?: string }; }
  catch (err) {
    console.error("[POST /v1/driver/loads/:id/documents] parseBody:", err);
    return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400);
  }
  const file = body.file;
  const kind = (body.kind ?? "other").toString();
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }
  // Drivers can upload any of the standardized kinds — the phone UI
  // surfaces POD/BOL/Scale/Other today, but we accept the full set so
  // adding more categories doesn't need an API change.
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`] }, 400);
  }

  // Resolve load_id from the event so the document is reachable from
  // load-scoped reads (web app queries by load_id post-2.5a). Non-revenue
  // events have no load — load_id stays null, matching legacy behavior.
  const { data: ev } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", id)
    .maybeSingle();
  const loadId = (ev as { load_id: string | null } | null)?.load_id ?? null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext   = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const random = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${random}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(DOC_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST /v1/driver/loads/:id/documents] storage upload:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  const { data, error } = await supabase
    .from("load_documents")
    .insert({
      event_id:              id,
      load_id:               loadId,
      org_id:                orgId,
      storage_path:          storagePath,
      file_name:             file.name,
      mime_type:             file.type || null,
      size_bytes:            bytes.length,
      kind,
      uploaded_by_driver_id: driverId,
    } as never)
    .select("*")
    .single();
  if (error || !data) {
    // Attempt to clean up the orphaned blob; not critical if it fails.
    void supabase.storage.from(DOC_BUCKET).remove([storagePath]);
    console.error("[POST /v1/driver/loads/:id/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  const doc = rowToDoc(data as DocRow);

  await appendAudit(id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    documentUploaded: { fileName: doc.fileName, kind: doc.kind },
  });

  return c.json({ document: doc });
});

// DELETE /v1/driver/documents/:id — remove a document the driver uploaded.
// Storage object + DB row come down together; audit logged.
driver.delete("/documents/:id", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return c.json({ error: "not_found" }, 404);
  const doc = data as DocRow;

  // Authorize: parent event must be assigned to this driver.
  const found = await loadDriverEvent(doc.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const [storageRes, dbRes] = await Promise.all([
    supabase.storage.from(DOC_BUCKET).remove([doc.storage_path]),
    supabase.from("load_documents").delete().eq("id", id).eq("org_id", orgId),
  ]);
  if (storageRes.error) console.error("[DELETE /v1/driver/documents/:id] storage:", storageRes.error);
  if (dbRes.error)      console.error("[DELETE /v1/driver/documents/:id] db:",      dbRes.error);

  await appendAudit(doc.event_id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    documentDeleted: { fileName: doc.file_name, kind: doc.kind },
  });

  return c.json({ ok: true });
});

// GET /v1/driver/documents/:id/url — short-lived signed URL for viewing.
// Same authorization as DELETE — must be the driver's load.
driver.get("/documents/:id/url", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("event_id, storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return c.json({ error: "not_found" }, 404);
  const row = data as { event_id: string; storage_path: string };

  const found = await loadDriverEvent(row.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { data: signed, error: signErr } = await supabase.storage
    .from(DOC_BUCKET)
    .createSignedUrl(row.storage_path, 3600);
  if (signErr || !signed) {
    console.error("[GET /v1/driver/documents/:id/url] sign:", signErr);
    return c.json({ error: "sign_failed", detail: signErr?.message }, 500);
  }
  return c.json({ url: signed.signedUrl });
});

// ─────────────────────────────────────────────────────────────────────────
// Live truck location for a load (Motive ELD lookup)
// ─────────────────────────────────────────────────────────────────────────

interface MotiveLocation { description: string; lat: number; lon: number; locatedAt: string; }

// Per-org cache for Motive lookups — Motive's free tier has tight rate
// limits and the location only updates every minute or so on their side
// anyway. 10 min mirrors the dispatch app's cache.
const motiveCache = new Map<string, { locations: Map<string, MotiveLocation>; fetchedAt: number }>();
const MOTIVE_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchMotiveLocations(orgId: string): Promise<Map<string, MotiveLocation>> {
  const cached = motiveCache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < MOTIVE_CACHE_TTL_MS) return cached.locations;

  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  const apiKey = (settingsRow as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) {
    const empty = new Map<string, MotiveLocation>();
    motiveCache.set(orgId, { locations: empty, fetchedAt: Date.now() });
    return empty;
  }

  try {
    const res = await fetch("https://api.keeptruckin.com/v1/vehicle_locations?per_page=50", {
      headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Motive ${res.status}`);
    const json = await res.json() as {
      vehicles?: Array<{ vehicle: { id: number; current_location: { description: string; lat: number; lon: number; located_at: string } | null } }>;
    };
    const map = new Map<string, MotiveLocation>();
    for (const v of json.vehicles ?? []) {
      const cl = v.vehicle.current_location;
      if (cl) map.set(String(v.vehicle.id), {
        description: cl.description, lat: cl.lat, lon: cl.lon, locatedAt: cl.located_at,
      });
    }
    motiveCache.set(orgId, { locations: map, fetchedAt: Date.now() });
    return map;
  } catch (err) {
    console.warn("[driver/motive] fetch failed:", err);
    return cached?.locations ?? new Map();
  }
}

// GET /v1/driver/loads/:id/truck-location — current Motive position +
// asset color for the load's bound vehicle. Returns 404 silently when
// the asset has no Motive vehicle id, no location, or the org doesn't
// have a Motive API key configured.
driver.get("/loads/:id/truck-location", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  // Get the asset_id off the event, then look up its motive_vehicle_id + color.
  const { data: ev } = await supabase
    .from("events")
    .select("asset_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const assetId = (ev as { asset_id: number } | null)?.asset_id;
  if (!assetId) return c.json({ error: "not_found" }, 404);

  const { data: asset } = await supabase
    .from("assets")
    .select("motive_vehicle_id, color")
    .eq("id", assetId)
    .maybeSingle();
  const assetRow = asset as { motive_vehicle_id: string | null; color: string | null } | null;
  const vehicleId = assetRow?.motive_vehicle_id;
  if (!vehicleId) return c.json({ error: "not_found" }, 404);

  const locations = await fetchMotiveLocations(orgId);
  const loc = locations.get(vehicleId);
  if (!loc) return c.json({ error: "not_found" }, 404);

  return c.json({
    lat:         loc.lat,
    lon:         loc.lon,
    locatedAt:   loc.locatedAt,
    description: loc.description,
    color:       assetRow?.color ?? null,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fuel reports — driver-side surface. Submit + list-mine.
//
// driver_id and submitted_by are forced from the auth context; the
// driver can't post on behalf of another driver. Dispatch's surface
// for cross-driver views lives at /v1/fuel-reports (Clerk auth).
// ─────────────────────────────────────────────────────────────────────────

interface FuelReportRowDriver {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number;
  reported_at:    string;
  state:          string;
  latitude:       number | null;
  longitude:      number | null;
  diesel_gallons: number;
  def_gallons:    number | null;
  odometer:       number | null;
  transaction_id: string | null;
  match_status:   string;
  submitted_by:   string;
  notes:          string | null;
  created_at:     string;
}

const FUEL_REPORT_COLS =
  "id,org_id,driver_id,asset_id,reported_at,state,latitude,longitude," +
  "diesel_gallons,def_gallons,odometer,transaction_id,match_status," +
  "submitted_by,notes,created_at";

function rowToFuelReportDriver(r: FuelReportRowDriver) {
  return {
    id:            r.id,
    orgId:         r.org_id,
    driverId:      r.driver_id,
    assetId:       r.asset_id,
    reportedAt:    r.reported_at,
    state:         r.state,
    latitude:      r.latitude  ?? undefined,
    longitude:     r.longitude ?? undefined,
    dieselGallons: Number(r.diesel_gallons),
    defGallons:    r.def_gallons != null ? Number(r.def_gallons) : undefined,
    odometer:      r.odometer ?? undefined,
    transactionId: r.transaction_id ?? undefined,
    matchStatus:   r.match_status,
    submittedBy:   r.submitted_by,
    notes:         r.notes ?? undefined,
    createdAt:     r.created_at,
  };
}

// POST /v1/driver/fuel-reports — driver submits a fuel-up
driver.post("/fuel-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const errors: string[] = [];
  const assetId       = Number(body.assetId);
  const dieselGallons = Number(body.dieselGallons);
  if (!Number.isFinite(assetId)) errors.push("assetId required");
  if (!Number.isFinite(dieselGallons) || dieselGallons <= 0) errors.push("dieselGallons must be > 0");
  const stateRaw = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(stateRaw)) errors.push("state must be 2-letter US abbreviation");
  if (body.defGallons != null) {
    const v = Number(body.defGallons);
    if (!Number.isFinite(v) || v < 0) errors.push("defGallons must be >= 0");
  }
  if (body.odometer != null) {
    const v = Number(body.odometer);
    if (!Number.isInteger(v) || v < 0) errors.push("odometer must be a non-negative integer");
  }
  if (errors.length) return c.json({ error: "validation_failed", errors }, 400);

  // Defensive: make sure the asset belongs to this org. The DB FK
  // guarantees the asset row exists, but not that it's in our org.
  const { data: assetRow } = await supabase
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!assetRow) return c.json({ error: "asset_not_found" }, 404);

  const insertRow = {
    org_id:         orgId,
    driver_id:      driverId,
    asset_id:       assetId,
    reported_at:    typeof body.reportedAt === "string" ? body.reportedAt : new Date().toISOString(),
    state:          stateRaw,
    latitude:       typeof body.latitude  === "number" ? body.latitude  : null,
    longitude:      typeof body.longitude === "number" ? body.longitude : null,
    diesel_gallons: dieselGallons,
    def_gallons:    body.defGallons != null ? Number(body.defGallons) : null,
    odometer:       body.odometer    != null ? Number(body.odometer)   : null,
    notes:          typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
    submitted_by:   `driver:${driverId}`,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_reports")
    .insert(insertRow as any)
    .select(FUEL_REPORT_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/driver/fuel-reports] insert failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ fuelReport: rowToFuelReportDriver(data as unknown as FuelReportRowDriver) });
});

// ─────────────────────────────────────────────────────────────────────────
// Maintenance reports — driver-side surface.
//
//   POST /v1/driver/maintenance-reports         — submit
//   POST /v1/driver/maintenance-reports/:id/photos — upload photo
//   GET  /v1/driver/maintenance-reports/mine    — driver's own history
//   GET  /v1/driver/maintenance-reports/history — recent reports on a
//                                                  specific asset/trailer,
//                                                  any driver in the org
// ─────────────────────────────────────────────────────────────────────────

interface MaintReportRowDriver {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number | null;
  trailer_id:     number | null;
  description:    string;
  reported_at:    string;
  latitude:       number | null;
  longitude:      number | null;
  state:          string | null;
  status:         string;
  action_item_id: string | null;
  submitted_by:   string;
  created_at:     string;
}

const MAINT_REPORT_COLS_DRIVER =
  "id,org_id,driver_id,asset_id,trailer_id,description,reported_at," +
  "latitude,longitude,state,status,action_item_id,submitted_by,created_at";

const MAINT_PHOTO_BUCKET_DRIVER = "maintenance-photos";

function rowToMaintReportDriver(r: MaintReportRowDriver) {
  return {
    id:           r.id,
    orgId:        r.org_id,
    driverId:     r.driver_id,
    assetId:      r.asset_id   ?? undefined,
    trailerId:    r.trailer_id ?? undefined,
    description:  r.description,
    reportedAt:   r.reported_at,
    latitude:     r.latitude   ?? undefined,
    longitude:    r.longitude  ?? undefined,
    state:        r.state      ?? undefined,
    status:       r.status,
    actionItemId: r.action_item_id ?? undefined,
    submittedBy:  r.submitted_by,
    createdAt:    r.created_at,
  };
}

driver.post("/maintenance-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const errors: string[] = [];
  const description = typeof body.description === 'string' ? body.description.trim() : "";
  if (!description) errors.push("description required");

  const assetId   = body.assetId   != null ? Number(body.assetId)   : null;
  const trailerId = body.trailerId != null ? Number(body.trailerId) : null;
  const hasAsset   = assetId   != null && Number.isFinite(assetId);
  const hasTrailer = trailerId != null && Number.isFinite(trailerId);
  if (hasAsset && hasTrailer)   errors.push("exactly one of assetId / trailerId");
  if (!hasAsset && !hasTrailer) errors.push("one of assetId / trailerId required");
  if (errors.length) return c.json({ error: "validation_failed", errors }, 400);

  // Defensive: confirm the asset/trailer is in this org so the driver
  // can't reach into another org's records via a guessed id.
  if (hasAsset) {
    const { data: row } = await supabase
      .from("assets").select("id").eq("id", assetId!).eq("org_id", orgId).maybeSingle();
    if (!row) return c.json({ error: "asset_not_found" }, 404);
  } else {
    const { data: row } = await supabase
      .from("trailers").select("id").eq("id", trailerId!).eq("org_id", orgId).maybeSingle();
    if (!row) return c.json({ error: "trailer_not_found" }, 404);
  }

  const insertRow = {
    org_id:       orgId,
    driver_id:    driverId,
    asset_id:     hasAsset   ? assetId   : null,
    trailer_id:   hasTrailer ? trailerId : null,
    description,
    reported_at:  typeof body.reportedAt === 'string' ? body.reportedAt : new Date().toISOString(),
    latitude:     typeof body.latitude  === 'number' ? body.latitude  : null,
    longitude:    typeof body.longitude === 'number' ? body.longitude : null,
    state:        typeof body.state     === 'string' && body.state.trim()
                    ? body.state.trim().toUpperCase() : null,
    submitted_by: `driver:${driverId}`,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_reports")
    .insert(insertRow as any)
    .select(MAINT_REPORT_COLS_DRIVER)
    .single();
  if (error || !data) {
    console.error("[POST /v1/driver/maintenance-reports] failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ report: rowToMaintReportDriver(data as unknown as MaintReportRowDriver) });
});

// Photo upload — multipart. One file per request to keep the wire
// shape simple from React Native; the driver app loops over selected
// photos and posts each.
driver.post("/maintenance-reports/:id/photos", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // Confirm the report exists in this org AND belongs to this driver
  // (drivers can only attach photos to their own reports).
  const { data: rep, error: repErr } = await supabase
    .from("maintenance_reports")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (repErr) return c.json({ error: "fetch_failed", detail: repErr.message }, 500);
  if (!rep) return c.json({ error: "not_found" }, 404);
  if ((rep as { driver_id: number }).driver_id !== driverId) {
    return c.json({ error: "not_authorized" }, 403);
  }

  let body: { file?: File };
  try { body = await c.req.parseBody() as { file?: File }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }
  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }

  const ext = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(MAINT_PHOTO_BUCKET_DRIVER)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST .../photos] storage:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_report_photos")
    .insert({
      report_id:    id,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    file.type || null,
      size_bytes:   bytes.length,
    } as any)
    .select("id, file_name, mime_type, size_bytes, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(MAINT_PHOTO_BUCKET_DRIVER).remove([storagePath]);
    console.error("[POST .../photos] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ photo: data });
});

driver.get("/maintenance-reports/mine", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url      = new URL(c.req.url);
  const limit    = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);
  const { data, error } = await supabase
    .from("maintenance_reports")
    .select(MAINT_REPORT_COLS_DRIVER)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  return c.json({
    reports: (data ?? []).map(r => rowToMaintReportDriver(r as unknown as MaintReportRowDriver)),
  });
});

// History on a SPECIFIC asset/trailer, regardless of which driver
// filed it. Used by the driver app's "what's already been reported on
// this truck" rail — so the next driver doesn't duplicate.
driver.get("/maintenance-reports/history", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const assetRaw   = url.searchParams.get("assetId");
  const trailerRaw = url.searchParams.get("trailerId");
  const limit      = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 50);

  const hasAsset   = assetRaw && Number.isFinite(Number(assetRaw));
  const hasTrailer = trailerRaw && Number.isFinite(Number(trailerRaw));
  if (hasAsset === hasTrailer) {
    return c.json({ error: "validation_failed", errors: ["exactly one of assetId / trailerId"] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("maintenance_reports")
    .select(MAINT_REPORT_COLS_DRIVER)
    .eq("org_id", orgId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (hasAsset)   q = q.eq("asset_id",   Number(assetRaw));
  if (hasTrailer) q = q.eq("trailer_id", Number(trailerRaw));

  const { data, error } = await q;
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  return c.json({
    reports: (data ?? []).map((r: unknown) => rowToMaintReportDriver(r as MaintReportRowDriver)),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Driver documents — driver self-service.
//   POST /v1/driver/documents       — upload (multipart: file + kind)
//   GET  /v1/driver/documents       — list mine
//   DELETE /v1/driver/documents/:id — remove mine
// The ops surface (/v1/drivers/:id/documents) writes to the same table.
// ─────────────────────────────────────────────────────────────────────────

const DRIVER_DOC_BUCKET_SELF = "driver-documents";
const DRIVER_DOC_KINDS_SELF = ['license','medical_card','mvr','other'] as const;
type DriverDocKindSelf = typeof DRIVER_DOC_KINDS_SELF[number];

interface DriverDocRowSelf {
  id:           string;
  org_id:       string;
  driver_id:    number;
  kind:         string;
  storage_path: string;
  file_name:    string;
  mime_type:    string | null;
  size_bytes:   number | null;
  expires_on:   string | null;
  notes:        string | null;
  uploaded_at:  string;
  uploaded_by:  string;
}

const DRIVER_DOC_COLS_SELF =
  "id,org_id,driver_id,kind,storage_path,file_name,mime_type,size_bytes," +
  "expires_on,notes,uploaded_at,uploaded_by";

function rowToDriverDocSelf(r: DriverDocRowSelf, signedUrl?: string) {
  return {
    id:         r.id,
    orgId:      r.org_id,
    driverId:   r.driver_id,
    kind:       r.kind as DriverDocKindSelf,
    fileName:   r.file_name,
    mimeType:   r.mime_type ?? undefined,
    sizeBytes:  r.size_bytes ?? undefined,
    expiresOn:  r.expires_on ?? undefined,
    notes:      r.notes ?? undefined,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    signedUrl,
  };
}

driver.post("/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  let body: { file?: File; kind?: string; expiresOn?: string; notes?: string };
  try { body = await c.req.parseBody() as typeof body; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }

  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }
  const kind = (body.kind ?? "other").toString() as DriverDocKindSelf;
  if (!(DRIVER_DOC_KINDS_SELF as readonly string[]).includes(kind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DRIVER_DOC_KINDS_SELF.join("|")}`] }, 400);
  }

  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${driverId}/${kind}_${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from(DRIVER_DOC_BUCKET_SELF)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (upErr) {
    console.error("[POST /v1/driver/documents] storage:", upErr);
    return c.json({ error: "upload_failed", detail: upErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("driver_documents")
    .insert({
      org_id:       orgId,
      driver_id:    driverId,
      kind,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    file.type || null,
      size_bytes:   bytes.length,
      expires_on:   body.expiresOn?.trim() || null,
      notes:        body.notes?.trim() || null,
      uploaded_by:  `driver:${driverId}`,
    } as any)
    .select(DRIVER_DOC_COLS_SELF)
    .single();
  if (error || !data) {
    void supabase.storage.from(DRIVER_DOC_BUCKET_SELF).remove([storagePath]);
    console.error("[POST /v1/driver/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET_SELF).createSignedUrl(storagePath, 3600);
  return c.json({ document: rowToDriverDocSelf(data as unknown as DriverDocRowSelf, signed?.signedUrl) });
});

driver.get("/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const { data, error } = await supabase
    .from("driver_documents")
    .select(DRIVER_DOC_COLS_SELF)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("uploaded_at", { ascending: false });
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  const rows = (data ?? []) as unknown as DriverDocRowSelf[];
  if (rows.length === 0) return c.json({ documents: [] });

  const paths = rows.map(r => r.storage_path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET_SELF).createSignedUrls(paths, 3600);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  return c.json({
    documents: rows.map(r => rowToDriverDocSelf(r, urlByPath.get(r.storage_path))),
  });
});

driver.delete("/documents/:id", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // Ownership check + path lookup in one round trip.
  const { data } = await supabase
    .from("driver_documents")
    .select("storage_path, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const row = data as { storage_path: string; driver_id: number } | null;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.driver_id !== driverId) return c.json({ error: "not_authorized" }, 403);

  const { error } = await supabase
    .from("driver_documents")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) return c.json({ error: "delete_failed", detail: error.message }, 500);
  void supabase.storage.from(DRIVER_DOC_BUCKET_SELF).remove([row.storage_path]);
  return c.json({ ok: true });
});

// POST /v1/driver/fuel-reports/:id/photos — upload a receipt photo.
// One file per request (keeps RN FormData simple). Driver can only
// attach to their own reports.
const FUEL_RECEIPT_BUCKET = "fuel-receipts";
driver.post("/fuel-reports/:id/photos", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  const { data: rep, error: repErr } = await supabase
    .from("fuel_reports")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (repErr) return c.json({ error: "fetch_failed", detail: repErr.message }, 500);
  if (!rep) return c.json({ error: "not_found" }, 404);
  if ((rep as { driver_id: number }).driver_id !== driverId) {
    return c.json({ error: "not_authorized" }, 403);
  }

  let body: { file?: File };
  try { body = await c.req.parseBody() as { file?: File }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }
  const file = body.file;
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }

  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(FUEL_RECEIPT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST fuel/photos] storage:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_report_photos")
    .insert({
      report_id:    id,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    file.type || null,
      size_bytes:   bytes.length,
    } as any)
    .select("id, file_name, mime_type, size_bytes, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(FUEL_RECEIPT_BUCKET).remove([storagePath]);
    console.error("[POST fuel/photos] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ photo: data });
});

// GET /v1/driver/fuel-reports — the driver's own submission history.
// Useful for the "my recent submissions" rail on the form screen.
driver.get("/fuel-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url      = new URL(c.req.url);
  const limit    = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);

  const { data, error } = await supabase
    .from("fuel_reports")
    .select(FUEL_REPORT_COLS)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[GET /v1/driver/fuel-reports] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  return c.json({
    fuelReports: (data ?? []).map(r => rowToFuelReportDriver(r as unknown as FuelReportRowDriver)),
  });
});

export default driver;
