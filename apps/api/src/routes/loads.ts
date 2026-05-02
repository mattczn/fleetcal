/**
 * /v1/loads — load CRUD against the split (loads + events) schema.
 *
 * All handlers require Clerk auth (mounted under the authed sub-app); the
 * orgId is read from the JWT and used to scope every query.
 *
 * Endpoints:
 *   POST   /v1/loads                            — create
 *   GET    /v1/loads                            — list (with filters)
 *   GET    /v1/loads/:id                        — single by load uuid
 *   PATCH  /v1/loads/:id                        — update load-level fields
 *   PATCH  /v1/loads/:id/events/:eventId        — update event-level fields
 *   POST   /v1/loads/:id/split-relay            — convert single → relay
 *   DELETE /v1/loads/:id                        — soft-delete
 *
 * Atomicity: PostgREST has no transactions, so multi-step writes use
 * sequential inserts/updates with best-effort cleanup on failure.
 */

import { Hono } from "hono";
import {
  appLoadToLoadInsert,
  appLoadToEventInsert,
  joinEventLoadToApp,
  type CreateLoadRequest,
  type CreateLoadResponse,
  type ListLoadsResponse,
  type GetLoadResponse,
  type UpdateLoadRequest,
  type UpdateLoadResponse,
  type UpdateEventRequest,
  type UpdateEventResponse,
  type SplitRelayRequest,
  type SplitRelayResponse,
  type DeleteLoadResponse,
  type RestoreLoadResponse,
  type ApiErrorResponse,
  type Load,
  type LoadStatus,
  LOAD_STATUSES,
  type Stop,
  type StopType,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const loads = new Hono<{ Variables: AuthVariables }>();

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,timezone," +
  "appt_start,appt_end,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,dispatcher,notes," +
  "accessorials,rate_con_pdf,ref_nums,audit_log,created_by_name," +
  "customer_id,deleted_at,created_at,updated_at";

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
    lat:           s.lat           ?? undefined,
    lng:           s.lng           ?? undefined,
    instructions:  s.instructions  ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
    arrivedAt:     s.arrived_at    ?? undefined,
    arrivedLat:    s.arrived_lat   ?? undefined,
    arrivedLng:    s.arrived_lng   ?? undefined,
  };
}

/**
 * Fetch the joined Load[] view for a single load id (1 entry for single,
 * 2 for relay). Returns null if the load doesn't exist or doesn't belong
 * to the org. Stops are populated and sorted by sequence.
 */
async function fetchLoadJoined(
  loadId: string,
  orgId: string,
): Promise<Load[] | null> {
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .select(LOAD_COLS)
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (loadErr || !loadRow) return null;

  const { data: eventRowsRaw, error: evErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .order("start", { ascending: true });
  if (evErr || !eventRowsRaw) return [];
  const eventRows = eventRowsRaw as unknown as Array<Record<string, unknown> & { id: string }>;

  const { data: stopRowsRaw } = await supabase
    .from("stops")
    .select(STOP_COLS)
    .in("event_id", eventRows.map((e) => e.id));

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopRowsRaw ?? []) as unknown as StopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }

  return eventRows.map((ev) => {
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(ev.id) ?? []).slice().sort(
      (a, b) => a.sequence - b.sequence,
    );
    return joined;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;

/** Bad-request helper. Caller passes the Hono context. */
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads — create a load (1 or 2 events)
// ─────────────────────────────────────────────────────────────────────────

loads.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateLoadRequest>();

  // Validation
  const errors: string[] = [];
  if (!body || typeof body !== "object") errors.push("body must be an object");
  if (!body?.load || typeof body.load !== "object") errors.push("missing 'load' object");
  if (!Array.isArray(body?.events)) {
    errors.push("'events' must be an array");
  } else {
    if (body.events.length < 1 || body.events.length > 2) {
      errors.push("'events' must have 1 or 2 entries");
    }
    if (body.events.length === 2) {
      const roles = body.events.map((e) => e.relayRole);
      if (!roles.includes("pickup") || !roles.includes("delivery") || roles[0] === roles[1]) {
        errors.push("relay loads need exactly one 'pickup' and one 'delivery' relayRole");
      }
    }
    for (const [i, ev] of body.events.entries()) {
      if (!ev.title?.trim()) errors.push(`events[${i}]: title required`);
      if (!ev.start) errors.push(`events[${i}]: start required`);
      if (!ev.end) errors.push(`events[${i}]: end required`);
      if (typeof ev.assetId !== "number") errors.push(`events[${i}]: assetId (number) required`);
      if (ev.start && ev.end && ev.start > ev.end) errors.push(`events[${i}]: start must be <= end`);
    }
  }
  if (errors.length) return badRequest(c, errors);

  // 1. Insert load
  const loadInsert = appLoadToLoadInsert(body.load, orgId);
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .insert(loadInsert)
    .select()
    .single();
  if (loadErr || !loadRow) {
    console.error("[POST /v1/loads] load insert failed:", loadErr);
    return c.json({ error: "load_insert_failed", detail: loadErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Insert events
  const eventInserts = body.events.map((ev) =>
    appLoadToEventInsert(
      { ...ev, loadId: loadRow.id, eventKind: "revenue", status: ev.status ?? "scheduled", stops: [] },
      orgId,
    ),
  );
  const { data: eventRows, error: evErr } = await supabase
    .from("events")
    .insert(eventInserts)
    .select();
  if (evErr || !eventRows || eventRows.length !== body.events.length) {
    console.error("[POST /v1/loads] events insert failed:", evErr);
    await supabase.from("loads").delete().eq("id", loadRow.id);
    return c.json({ error: "events_insert_failed", detail: evErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Insert stops
  const stopInserts = body.events.flatMap((ev, i) =>
    (ev.stops ?? []).map((s, idx) => ({
      event_id:       eventRows[i].id,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    })),
  );
  if (stopInserts.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopInserts);
    if (stopErr) {
      console.error("[POST /v1/loads] stops insert failed:", stopErr);
      await supabase.from("loads").delete().eq("id", loadRow.id);
      return c.json({ error: "stops_insert_failed", detail: stopErr?.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchLoadJoined(loadRow.id, orgId);
  const res: CreateLoadResponse = { loads: joined ?? [] };
  return c.json(res, 201);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads — list with filters
// ─────────────────────────────────────────────────────────────────────────

loads.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const statusParam = url.searchParams.get("status");
  const assetIdParam = url.searchParams.get("assetId");
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";

  // Validate status values if provided
  let statusList: LoadStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((s) => !LOAD_STATUSES.includes(s as LoadStatus));
    if (invalid.length) return badRequest(c, [`unknown status values: ${invalid.join(",")}`]);
    statusList = parts as LoadStatus[];
  }

  let assetIds: number[] | undefined;
  if (assetIdParam) {
    const parts = assetIdParam.split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = parts.map((s) => Number(s));
    if (parsed.some((n) => !Number.isFinite(n))) return badRequest(c, ["assetId must be numeric"]);
    assetIds = parsed;
  }

  // Joined fetch via PostgREST nested select
  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .order("start", { ascending: true });

  if (!includeDeleted) q = q.is("deleted_at", null);
  if (from) q = q.gte("end", from);
  if (to) q = q.lte("start", to);
  if (statusList) q = q.in("status", statusList);
  if (assetIds) q = q.in("asset_id", assetIds);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/loads] query failed:", error);
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = events ?? [];

  // Fetch stops in one query for all events
  const eventIds = (rows as Array<Record<string, unknown>>).map((r) => r.id as string);
  const stopsByEvent = new Map<string, Stop[]>();
  if (eventIds.length) {
    const { data: stopRows } = await supabase
      .from("stops")
      .select(STOP_COLS)
      .in("event_id", eventIds);
    for (const s of (stopRows ?? []) as unknown as StopRow[]) {
      const arr = stopsByEvent.get(s.event_id) ?? [];
      arr.push(rowToStop(s));
      stopsByEvent.set(s.event_id, arr);
    }
  }

  const result: Load[] = rows.map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    return joined;
  });

  const res: ListLoadsResponse = { loads: result };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads/:id — single load by uuid
// ─────────────────────────────────────────────────────────────────────────

loads.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const joined = await fetchLoadJoined(loadId, orgId);
  if (joined === null) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const res: GetLoadResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/loads/:id — update load-level fields
// ─────────────────────────────────────────────────────────────────────────

loads.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<UpdateLoadRequest>();

  // Whitelist load-level fields. Anything not listed here is ignored.
  const update: Record<string, unknown> = {};
  if ("loadNum"      in body) update.load_num       = body.loadNum      ?? null;
  if ("broker"       in body) update.broker         = body.broker       ?? null;
  if ("customerId"   in body) update.customer_id    = body.customerId   ?? null;
  if ("dispatcher"   in body) update.dispatcher     = body.dispatcher   ?? null;
  if ("loadPrice"    in body) update.load_price     = body.loadPrice    ?? null;
  if ("rateConPdf"   in body) update.rate_con_pdf   = body.rateConPdf   ?? null;
  if ("accessorials" in body) update.accessorials   = body.accessorials ?? null;
  if ("refNums"      in body) update.ref_nums       = body.refNums?.length ? JSON.stringify(body.refNums) : null;
  if ("notes"        in body) update.notes          = body.notes        ?? null;

  if (Object.keys(update).length === 0) {
    return badRequest(c, ["no allowed fields supplied; nothing to update"]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("loads")
    .update(update as any)
    .eq("id", loadId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/loads/:id] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateLoadResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/loads/:id/events/:eventId — update event-level fields
// ─────────────────────────────────────────────────────────────────────────

loads.patch("/:id/events/:eventId", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const body = await c.req.json<UpdateEventRequest>();

  // Validate status if provided
  if (body.status && !LOAD_STATUSES.includes(body.status)) {
    return badRequest(c, [`invalid status: ${body.status}`]);
  }
  if (body.start && body.end && body.start > body.end) {
    return badRequest(c, ["start must be <= end"]);
  }

  // Whitelist event-level fields
  const update: Record<string, unknown> = {};
  if ("title"       in body) update.title        = body.title;
  if ("start"       in body) update.start        = body.start;
  if ("end"         in body) update.end          = body.end;
  if ("status"      in body) update.status       = body.status;
  if ("assetId"     in body) update.asset_id     = body.assetId;
  if ("driverId"    in body) update.driver_id    = body.driverId    ?? null;
  if ("driverName"  in body) update.driver_name  = body.driverName  ?? null;
  if ("trailerId"   in body) update.trailer_id   = body.trailerId   ?? null;
  if ("trailerType" in body) update.trailer_type = body.trailerType ?? null;
  if ("driverPay"   in body) update.driver_pay   = body.driverPay   ?? null;
  if ("eventNotes"  in body) update.notes        = body.eventNotes  ?? null;
  if ("priority"    in body) update.priority     = body.priority    ?? false;

  if (Object.keys(update).length === 0) {
    return badRequest(c, ["no allowed fields supplied; nothing to update"]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("events")
    .update(update as any)
    .eq("id", eventId)
    .eq("load_id", loadId) // ensures the event belongs to this load
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/loads/:id/events/:eventId] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateEventResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/split-relay — convert single → relay
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/split-relay", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<SplitRelayRequest>();

  // Validation
  const errors: string[] = [];
  if (!body.pickupEnd)      errors.push("pickupEnd required");
  if (!body.deliveryStart)  errors.push("deliveryStart required");
  if (!body.deliveryEnd)    errors.push("deliveryEnd required");
  if (typeof body.deliveryAssetId !== "number") errors.push("deliveryAssetId (number) required");
  if (!Array.isArray(body.mergedStops) || body.mergedStops.length < 2) errors.push("mergedStops must have at least 2 entries");
  if (typeof body.relayStopIndex !== "number") errors.push("relayStopIndex (number) required");
  if (body.relayStopIndex < 0 || (body.mergedStops && body.relayStopIndex >= body.mergedStops.length - 1)) {
    errors.push("relayStopIndex must be in [0, mergedStops.length - 2]");
  }
  if (body.pickupEnd && body.deliveryStart && body.pickupEnd > body.deliveryStart) {
    errors.push("pickupEnd must be <= deliveryStart");
  }
  if (body.deliveryStart && body.deliveryEnd && body.deliveryStart > body.deliveryEnd) {
    errors.push("deliveryStart must be <= deliveryEnd");
  }
  if (errors.length) return badRequest(c, errors);

  // Fetch the load and verify it has exactly one event
  const { data: existingEventsRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (fetchErr || !existingEventsRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existingEvents = existingEventsRaw as unknown as Array<Record<string, unknown> & {
    id: string; title: string; end: string; priority: boolean;
  }>;
  if (existingEvents.length !== 1) {
    return badRequest(c, [`load must have exactly 1 event to split; found ${existingEvents.length}`]);
  }
  const pickupEvent = existingEvents[0];

  // 1. Update the existing event → pickup leg
  const { error: pickupErr } = await supabase
    .from("events")
    .update({
      end:        body.pickupEnd,
      relay_role: "pickup",
    })
    .eq("id", pickupEvent.id)
    .eq("org_id", orgId);
  if (pickupErr) {
    return c.json({ error: "pickup_update_failed", detail: pickupErr.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Create the delivery leg event
  const deliveryInsert = {
    org_id:      orgId,
    load_id:     loadId,
    asset_id:    body.deliveryAssetId,
    driver_id:   body.deliveryDriverId   ?? null,
    driver_name: body.deliveryDriverName ?? null,
    title:       pickupEvent.title,
    start:       body.deliveryStart,
    end:         body.deliveryEnd,
    status:      "scheduled",
    event_kind:  "revenue",
    relay_role:  "delivery",
    priority:    pickupEvent.priority,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: deliveryEventRaw, error: delivErr } = await supabase
    .from("events")
    .insert(deliveryInsert as any)
    .select()
    .single();
  const deliveryEvent = deliveryEventRaw as { id: string } | null;
  if (delivErr || !deliveryEvent) {
    // Cleanup: revert pickup event role
    await supabase
      .from("events")
      .update({ relay_role: null, end: pickupEvent.end })
      .eq("id", pickupEvent.id)
      .eq("org_id", orgId);
    return c.json({ error: "delivery_create_failed", detail: delivErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Replace stops on both legs
  const pickupStops = body.mergedStops.slice(0, body.relayStopIndex + 1);
  const deliveryStops = body.mergedStops.slice(body.relayStopIndex + 1);

  // Delete existing stops, insert new partitioned ones
  await supabase.from("stops").delete().eq("event_id", pickupEvent.id).eq("org_id", orgId);

  const stopRows = [
    ...pickupStops.map((s, idx) => ({
      event_id:       pickupEvent.id,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    })),
    ...deliveryStops.map((s, idx) => ({
      event_id:       deliveryEvent.id,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    })),
  ];

  if (stopRows.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopRows);
    if (stopErr) {
      console.error("[POST /v1/loads/:id/split-relay] stops insert failed:", stopErr);
      // Best-effort: orphan stops are bad but recovery is hard here.
      return c.json({ error: "stops_insert_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  const res: SplitRelayResponse = { loads: joined ?? [] };
  return c.json(res, 200);
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /v1/loads/:id — soft-delete the load and its events
// ─────────────────────────────────────────────────────────────────────────

loads.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const now = new Date().toISOString();

  // Soft-delete the load
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .update({ deleted_at: now })
    .eq("id", loadId)
    .eq("org_id", orgId)
    .select()
    .maybeSingle();
  if (loadErr) {
    return c.json({ error: "delete_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!loadRow) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }

  // Soft-delete the events tied to this load
  const { error: evErr } = await supabase
    .from("events")
    .update({ deleted_at: now })
    .eq("load_id", loadId)
    .eq("org_id", orgId);
  if (evErr) {
    // Roll back the load delete; events are still active
    await supabase
      .from("loads")
      .update({ deleted_at: null })
      .eq("id", loadId)
      .eq("org_id", orgId);
    return c.json({ error: "events_delete_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }

  const res: DeleteLoadResponse = { ok: true, loadId };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/restore — undelete a soft-deleted load + its events
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/restore", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .update({ deleted_at: null })
    .eq("id", loadId)
    .eq("org_id", orgId)
    .select()
    .maybeSingle();
  if (loadErr) {
    return c.json({ error: "restore_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!loadRow) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }

  const { error: evErr } = await supabase
    .from("events")
    .update({ deleted_at: null })
    .eq("load_id", loadId)
    .eq("org_id", orgId);
  if (evErr) {
    return c.json({ error: "events_restore_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: RestoreLoadResponse = { loads: joined };
  return c.json(res);
});

export default loads;
