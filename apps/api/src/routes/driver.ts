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
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
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
driver.get("/loads/:id/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { data, error } = await supabase
    .from("load_documents")
    .select("*")
    .eq("event_id", id)
    .eq("org_id", orgId)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.error("[GET /v1/driver/loads/:id/documents] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const documents = (data ?? []).map((r) => rowToDoc(r as DocRow));
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
  if (!["bol", "pod", "scale", "other"].includes(kind)) {
    return c.json({ error: "validation_failed", errors: ["kind must be bol|pod|scale|other"] }, 400);
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

export default driver;
