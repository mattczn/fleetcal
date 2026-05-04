/**
 * /v1/events — event-level operations.
 *
 * For non-revenue events (no parent load) and as a load-id-agnostic way
 * to address any event. Revenue events can also be patched here; for
 * load-scoped patches use PATCH /v1/loads/:loadId/events/:eventId
 * (the two are interchangeable for revenue events).
 *
 * Endpoints:
 *   POST   /v1/events                 — create non-revenue event
 *   PATCH  /v1/events/:id             — update any event (revenue or non-revenue)
 *   DELETE /v1/events/:id             — soft-delete (non-revenue only; revenue-event
 *                                       delete goes via DELETE /v1/loads/:loadId)
 *   PUT    /v1/events/:id/stops       — replace stops for an event
 */

import { Hono } from "hono";
import {
  joinEventLoadToApp,
  type CreateEventRequest,
  type CreateEventResponse,
  type UpdateEventByIdRequest,
  type UpdateEventByIdResponse,
  type DeleteEventResponse,
  type ReplaceStopsRequest,
  type ReplaceStopsResponse,
  type GetAuditLogResponse,
  type ApiErrorResponse,
  type Load,
  type LoadAuditEntry,
  type LoadStatus,
  LOAD_STATUSES,
  type Stop,
  type StopType,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const events = new Hono<{ Variables: AuthVariables }>();

// ── Helpers (duplicated from loads.ts; consolidate later if it bites) ──

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

/**
 * Fetch a single event by id with its load (if any) and stops, returning
 * the joined Load view (one entry).
 */
async function fetchEventJoined(
  eventId: string,
  orgId: string,
): Promise<Load | null> {
  const { data: ev, error: evErr } = await supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (evErr || !ev) return null;

  const evRow = ev as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
  const loadRow = Array.isArray(evRow.load) ? (evRow.load[0] ?? null) : (evRow.load ?? null);

  const { data: stopRowsRaw } = await supabase
    .from("stops")
    .select(STOP_COLS)
    .eq("event_id", eventId);

  const stops = ((stopRowsRaw ?? []) as unknown as StopRow[])
    .map(rowToStop)
    .sort((a, b) => a.sequence - b.sequence);

  const joined = joinEventLoadToApp(evRow, loadRow);
  joined.stops = stops;
  return joined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/events — create a non-revenue event
// ─────────────────────────────────────────────────────────────────────────

events.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateEventRequest>();

  const errors: string[] = [];
  if (!body?.title?.trim())          errors.push("title required");
  if (!body?.start)                  errors.push("start required");
  if (!body?.end)                    errors.push("end required");
  if (typeof body?.assetId !== "number") errors.push("assetId (number) required");
  if (!body?.nonRevenueType?.trim()) errors.push("nonRevenueType required for non-revenue event");
  if (body?.start && body?.end && body.start > body.end) errors.push("start must be <= end");
  if (errors.length) return badRequest(c, errors);

  const insert = {
    org_id:           orgId,
    asset_id:         body.assetId,
    driver_id:        body.driverId   ?? null,
    driver_name:      body.driverName ?? null,
    title:            body.title,
    start:            body.start,
    end:              body.end,
    status:           body.status ?? "scheduled",
    event_kind:       "non_revenue",
    non_revenue_type: body.nonRevenueType,
    relay_role:       null,
    load_id:          null,
    trailer_id:       body.trailerId   ?? null,
    trailer_type:     body.trailerType ?? null,
    driver_pay:       body.driverPay   ?? null,
    notes:            body.eventNotes  ?? null,
    priority:         body.priority    ?? false,
    deleted_at:       null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await supabase.from("events").insert(insert as any).select().single();
  if (error || !row) {
    return c.json({ error: "event_insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const eventRow = row as { id: string };

  // Insert stops if provided
  if (body.stops?.length) {
    const stopInserts = body.stops.map((s, idx) => ({
      event_id:       eventRow.id,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      schedule_type:  s.scheduleType  ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    }));
    const { error: stopErr } = await supabase.from("stops").insert(stopInserts);
    if (stopErr) {
      await supabase.from("events").delete().eq("id", eventRow.id);
      return c.json({ error: "stops_insert_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchEventJoined(eventRow.id, orgId);
  const res: CreateEventResponse = { loads: joined ? [joined] : [] };
  return c.json(res, 201);
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/events/:id — update any event by id
// ─────────────────────────────────────────────────────────────────────────

events.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");
  const body = await c.req.json<UpdateEventByIdRequest>();

  if (body.status && !LOAD_STATUSES.includes(body.status as LoadStatus)) {
    return badRequest(c, [`invalid status: ${body.status}`]);
  }
  if (body.start && body.end && body.start > body.end) {
    return badRequest(c, ["start must be <= end"]);
  }

  const update: Record<string, unknown> = {};
  if ("title"          in body) update.title             = body.title;
  if ("start"          in body) update.start             = body.start;
  if ("end"            in body) update.end               = body.end;
  if ("status"         in body) update.status            = body.status;
  if ("assetId"        in body) update.asset_id          = body.assetId;
  if ("driverId"       in body) update.driver_id         = body.driverId       ?? null;
  if ("driverName"     in body) update.driver_name       = body.driverName     ?? null;
  if ("trailerId"      in body) update.trailer_id        = body.trailerId      ?? null;
  if ("trailerType"    in body) update.trailer_type      = body.trailerType    ?? null;
  if ("driverPay"      in body) update.driver_pay        = body.driverPay      ?? null;
  if ("eventNotes"     in body) update.notes             = body.eventNotes     ?? null;
  if ("priority"       in body) update.priority          = body.priority       ?? false;
  if ("nonRevenueType" in body) update.non_revenue_type  = body.nonRevenueType ?? null;

  if (Object.keys(update).length === 0) {
    return badRequest(c, ["no allowed fields supplied; nothing to update"]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase.from("events").update(update as any).eq("id", eventId).eq("org_id", orgId);
  if (error) {
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchEventJoined(eventId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateEventByIdResponse = { loads: [joined] };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /v1/events/:id — soft-delete a non-revenue event
// ─────────────────────────────────────────────────────────────────────────

events.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");

  // Verify the event is non-revenue (revenue events go via DELETE /v1/loads/:id)
  const { data: ev, error: fetchErr } = await supabase
    .from("events")
    .select("id,event_kind,load_id")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!ev) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const evRow = ev as { event_kind: string; load_id: string | null };
  if (evRow.event_kind === "revenue" || evRow.load_id !== null) {
    return badRequest(c, ["cannot delete a revenue event directly; delete the parent load instead"]);
  }

  const { error: delErr } = await supabase
    .from("events")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (delErr) {
    return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }

  const res: DeleteEventResponse = { ok: true, eventId };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /v1/events/:id/stops — replace stops for an event
// ─────────────────────────────────────────────────────────────────────────

events.put("/:id/stops", async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");
  const body = await c.req.json<ReplaceStopsRequest>();

  if (!Array.isArray(body?.stops)) return badRequest(c, ["stops must be an array"]);

  // Verify event exists in this org
  const { data: ev } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!ev) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // Delete existing stops, then insert the new ordered set
  const { error: delErr } = await supabase
    .from("stops")
    .delete()
    .eq("event_id", eventId)
    .eq("org_id", orgId);
  if (delErr) {
    return c.json({ error: "stops_delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }

  if (body.stops.length) {
    const inserts = body.stops.map((s, idx) => ({
      event_id:       eventId,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      schedule_type:  s.scheduleType  ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    }));
    const { error: insErr } = await supabase.from("stops").insert(inserts);
    if (insErr) {
      return c.json({ error: "stops_insert_failed", detail: insErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchEventJoined(eventId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: ReplaceStopsResponse = { loads: [joined] };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/events/:id/audit-log — fetch merged audit log for an event
// ─────────────────────────────────────────────────────────────────────────
//
// Revenue events: returns loads.audit_log (load-level entries) merged with
// events.audit_log (per-leg driver-side entries), sorted by changedAt asc.
// Non-revenue events: returns events.audit_log only.

events.get("/:id/audit-log", async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");

  const { data: ev, error: evErr } = await supabase
    .from("events")
    .select("id,load_id,audit_log")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (evErr) {
    console.error("[GET /v1/events/:id/audit-log] event read failed:", evErr);
    return c.json({ error: "fetch_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!ev) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const eventEntries = ((ev.audit_log as LoadAuditEntry[] | null) ?? []);

  let loadEntries: LoadAuditEntry[] = [];
  if (ev.load_id) {
    const { data: ld, error: ldErr } = await supabase
      .from("loads")
      .select("audit_log")
      .eq("id", ev.load_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (ldErr) {
      console.error("[GET /v1/events/:id/audit-log] load read failed:", ldErr);
      return c.json({ error: "fetch_failed", detail: ldErr.message } satisfies ApiErrorResponse, 500);
    }
    loadEntries = ((ld?.audit_log as LoadAuditEntry[] | null) ?? []);
  }

  const merged = [...loadEntries, ...eventEntries].sort((a, b) =>
    (a.changedAt ?? "").localeCompare(b.changedAt ?? ""),
  );
  const res: GetAuditLogResponse = { entries: merged };
  return c.json(res);
});

export default events;
