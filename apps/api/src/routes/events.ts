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
  type GetEventResponse,
  type ApiErrorResponse,
  type Load,
  type LoadAuditEntry,
  type LoadStatus,
  LOAD_STATUSES,
  type LoadNotification,
  type LoadNotificationKind,
  LOAD_NOTIFICATION_KINDS,
  type Stop,
  type StopType,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, effectiveCanForOrg } from "../middleware/require.js";

const events = new Hono<{ Variables: AuthVariables }>();

// ── Helpers (duplicated from loads.ts; consolidate later if it bites) ──

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at," +
  "trailer_dropoff_lat,trailer_dropoff_lng,trailer_dropoff_at,trailer_dropoff_address";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,total_billable,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids,document_counts," +
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
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS}), asset:assets(name, unit)`)
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (evErr || !ev) return null;

  const evRow = ev as unknown as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
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
  // documentCounts is denormalized onto loads.document_counts and
  // populated by joinEventLoadToApp directly off the load row. No
  // extra query needed — the trigger guarantees it's fresh.
  return joined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/events/:id — fetch a single event with its load + stops (relay-aware)
// ─────────────────────────────────────────────────────────────────────────

events.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");

  const joined = await fetchEventJoined(id, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // For relay events, also pull the partner leg (events sharing the same load_id).
  if (joined.loadId && joined.relayRole) {
    const { data: partnerRowsRaw } = await supabase
      .from("events")
      .select(`${EVENT_COLS}, load:loads(${LOAD_COLS}), asset:assets(name, unit)`)
      .eq("load_id", joined.loadId)
      .eq("org_id", orgId)
      .neq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (partnerRowsRaw) {
      const pRow = partnerRowsRaw as unknown as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null; id: string };
      const pLoadRow = Array.isArray(pRow.load) ? (pRow.load[0] ?? null) : (pRow.load ?? null);
      const partnerJoined = joinEventLoadToApp(pRow, pLoadRow);
      const { data: pStopsRaw } = await supabase
        .from("stops")
        .select(STOP_COLS)
        .eq("event_id", pRow.id);
      partnerJoined.stops = ((pStopsRaw ?? []) as unknown as StopRow[])
        .map(rowToStop)
        .sort((a, b) => a.sequence - b.sequence);
      // No need to mirror documentCounts onto the partner — both legs
      // share load_id, and joinEventLoadToApp pulls document_counts
      // directly from the load row, so partnerJoined already has
      // the same counts as joined.
      return c.json({ loads: [joined, partnerJoined] } satisfies GetEventResponse);
    }
  }

  return c.json({ loads: [joined] } satisfies GetEventResponse);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/events — create a non-revenue event
// ─────────────────────────────────────────────────────────────────────────

// POST /v1/events creates a non-revenue event (the handler hardcodes
// event_kind: "non_revenue"). Revenue loads go through POST /v1/loads
// instead. Gated on nonRevenueEvents.create so a Maintenance role
// can add maintenance / repair blocks without unlocking revenue-load
// creation.
events.post("/", requireCapability("nonRevenueEvents.create"), async (c) => {
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
      state:          s.state         ?? null,
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
  const role  = c.get("orgRole");
  const eventId = c.req.param("id");
  const body = await c.req.json<UpdateEventByIdRequest>();

  if (body.status && !LOAD_STATUSES.includes(body.status as LoadStatus)) {
    return badRequest(c, [`invalid status: ${body.status}`]);
  }
  if (body.start && body.end && body.start > body.end) {
    return badRequest(c, ["start must be <= end"]);
  }

  // Permission check is event-kind-dependent: revenue events require
  // loads.edit (full revenue-load editing); non-revenue events accept
  // either loads.edit OR nonRevenueEvents.edit so a Maintenance role
  // can fix up their own blocks without touching revenue loads.
  const { data: kindRow } = await supabase
    .from("events")
    .select("event_kind,load_id")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!kindRow) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const kr = kindRow as { event_kind: string; load_id: string | null };
  const isRevenue = kr.event_kind === "revenue" || kr.load_id !== null;
  const required = isRevenue ? "loads.edit" : "nonRevenueEvents.edit";
  if (!(await effectiveCanForOrg(role, required, orgId))) {
    // For non-revenue, fall back to loads.edit just in case (Admin
    // who has loads.edit but the nonRevenueEvents.* override revoked).
    if (isRevenue || !(await effectiveCanForOrg(role, "loads.edit", orgId))) {
      return c.json({
        error: "forbidden",
        reason: "missing_capability",
        capability: required,
        role: role ?? null,
      }, 403);
    }
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
  if ("loadedMiles"    in body) update.loaded_miles      = body.loadedMiles    ?? null;
  if ("eventNotes"     in body) update.notes             = body.eventNotes     ?? null;
  if ("priority"       in body) update.priority          = body.priority       ?? false;
  if ("nonRevenueType" in body) update.non_revenue_type  = body.nonRevenueType ?? null;
  if ("trailerDropoffAddress" in body)
    update.trailer_dropoff_address = (body.trailerDropoffAddress as string | null | undefined) ?? null;

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
// DELETE /v1/events/:id — soft-delete an event row.
//   - Non-revenue events: always allowed.
//   - Revenue events: only allowed when ?keepLoad=true. Use case:
//     the "Cancel & Remove from Calendar" workflow, where the load
//     record stays in the system (searchable, accounting,
//     potentially TONU-billable) but the event vanishes from the
//     calendar / dispatch board.
// ─────────────────────────────────────────────────────────────────────────

events.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const role  = c.get("orgRole");
  const eventId = c.req.param("id");
  const keepLoad = c.req.query("keepLoad") === "true";

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
  const isRevenue = evRow.event_kind === "revenue" || evRow.load_id !== null;

  // Event-kind-aware permission check: revenue events require
  // loads.delete; non-revenue events accept loads.delete OR
  // nonRevenueEvents.delete (so a Maintenance role can clear out
  // their own blocks).
  const requiredDeleteCap = isRevenue ? "loads.delete" : "nonRevenueEvents.delete";
  if (!(await effectiveCanForOrg(role, requiredDeleteCap, orgId))) {
    if (isRevenue || !(await effectiveCanForOrg(role, "loads.delete", orgId))) {
      return c.json({
        error: "forbidden",
        reason: "missing_capability",
        capability: requiredDeleteCap,
        role: role ?? null,
      }, 403);
    }
  }

  if (isRevenue && !keepLoad) {
    return badRequest(c, ["cannot delete a revenue event directly; pass keepLoad=true to drop the event but keep the load, or DELETE /v1/loads/:id to delete both"]);
  }

  const { error: delErr } = await supabase
    .from("events")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (delErr) {
    return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
  }

  // Unlink any maintenance work orders that pointed at this event.
  // The schema's FK cascades (ON DELETE CASCADE on the M:N join table,
  // ON DELETE SET NULL on the event_id column) only fire on a hard
  // DELETE; we soft-delete (set deleted_at), so the WOs would
  // otherwise still appear linked to a dead event — the "View"
  // button would land on a soft-deleted row and the maintenance
  // board would still place the WO on the dead event's day.
  //
  // Both writes are best-effort: a failure here is logged but
  // doesn't fail the event delete (the event is already gone from
  // the user's perspective, and the join cleanup can be re-applied
  // later by a sweeper if we ever build one).
  const { error: clearColErr } = await supabase
    .from("maintenance_action_items")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ event_id: null, updated_at: new Date().toISOString() } as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq("event_id" as any, eventId)
    .eq("org_id", orgId);
  if (clearColErr && !/column .* does not exist/i.test(clearColErr.message ?? "")) {
    console.warn("[DELETE /v1/events/:id] clearing event_id column failed (non-fatal):", clearColErr);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAny: any = supabase;
  const { error: clearJoinErr } = await supabaseAny
    .from("maintenance_action_item_events")
    .delete()
    .eq("event_id", eventId);
  if (clearJoinErr && !/relation .* does not exist/i.test(clearJoinErr.message ?? "")) {
    console.warn("[DELETE /v1/events/:id] clearing join table failed (non-fatal):", clearJoinErr);
  }

  const res: DeleteEventResponse = { ok: true, eventId };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /v1/events/:id/stops — replace stops for an event
// ─────────────────────────────────────────────────────────────────────────

events.put("/:id/stops", requireCapability("loads.edit"), async (c) => {
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
      state:          s.state         ?? null,
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

// ─────────────────────────────────────────────────────────────────────────
// Load-notification timeline (dispatcher → driver nudges).
// One row per push sent; auto-acknowledged when the driver does the
// thing the nudge asked for. See migration 20260513_load_notifications.sql.
// ─────────────────────────────────────────────────────────────────────────

interface LoadNotificationRow {
  id:              string;
  org_id:          string;
  event_id:        string;
  load_id:         string | null;
  driver_id:       number;
  kind:            string;
  sent_at:         string;
  sent_by_name:    string;
  acknowledged_at: string | null;
}

function rowToLoadNotification(r: LoadNotificationRow): LoadNotification {
  return {
    id:              r.id,
    orgId:           r.org_id,
    eventId:         r.event_id,
    loadId:          r.load_id ?? undefined,
    driverId:        r.driver_id,
    kind:            r.kind as LoadNotificationKind,
    sentAt:          r.sent_at,
    sentByName:      r.sent_by_name,
    acknowledgedAt:  r.acknowledged_at ?? undefined,
  };
}

// GET /v1/events/:id/notifications — chronological list of every push
// sent for this event. Used by the dispatcher modal to render the
// nudge timeline.
events.get("/:id/notifications", async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");

  const { data, error } = await supabase
    .from("load_notifications")
    .select("id,org_id,event_id,load_id,driver_id,kind,sent_at,sent_by_name,acknowledged_at")
    .eq("event_id", eventId)
    .eq("org_id", orgId)
    .order("sent_at", { ascending: false });

  if (error) {
    console.error("[GET /v1/events/:id/notifications] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const notifications = ((data ?? []) as LoadNotificationRow[]).map(rowToLoadNotification);
  return c.json({ notifications });
});

// POST /v1/events/:id/notify — dispatcher sends a nudge to the driver.
// Body: { kind, sentByName, force? }. Also creates the load_notifications
// row and (best-effort) fires the actual push via the existing
// /api/driver-push surface — but since the Railway API doesn't have
// direct push access we just record the row here. The DISPATCHER WEB
// is responsible for also calling /api/driver-push so the push fans
// out via Expo. Both writes happen client-side in the store.
//
// (Cron sweeps will call this endpoint server-to-server with a synthetic
// sentByName like 'Auto: evening sweep'.)
events.post("/:id/notify", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");
  const body = await c.req.json<{ kind: string; sentByName: string; force?: boolean }>();

  if (!LOAD_NOTIFICATION_KINDS.includes(body.kind as LoadNotificationKind)) {
    return c.json(
      { error: "validation_failed", errors: [`invalid kind: ${body.kind}`] } satisfies ApiErrorResponse,
      400,
    );
  }
  if (!body.sentByName?.trim()) {
    return c.json(
      { error: "validation_failed", errors: ["sentByName required"] } satisfies ApiErrorResponse,
      400,
    );
  }

  // Pull the event so we can populate load_id + driver_id, and so we
  // can refuse to nudge a load that has no driver assigned.
  const { data: ev, error: evErr } = await supabase
    .from("events")
    .select("id,load_id,driver_id,org_id")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (evErr) {
    console.error("[POST /v1/events/:id/notify] event read:", evErr);
    return c.json({ error: "fetch_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!ev) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const evRow = ev as { id: string; load_id: string | null; driver_id: number | null };
  if (!evRow.driver_id) {
    return c.json(
      { error: "no_driver", detail: "Event has no driver assigned" } satisfies ApiErrorResponse,
      400,
    );
  }

  const { data: inserted, error: insErr } = await supabase
    .from("load_notifications")
    .insert({
      org_id:       orgId,
      event_id:     eventId,
      load_id:      evRow.load_id,
      driver_id:    evRow.driver_id,
      kind:         body.kind,
      sent_by_name: body.sentByName.trim(),
    } as never)
    .select("id,org_id,event_id,load_id,driver_id,kind,sent_at,sent_by_name,acknowledged_at")
    .single();
  if (insErr || !inserted) {
    console.error("[POST /v1/events/:id/notify] insert:", insErr);
    return c.json({ error: "insert_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
  }

  return c.json({ notification: rowToLoadNotification(inserted as LoadNotificationRow) });
});

// POST /v1/events/:id/record-auto-notification
//
// Records a row in load_notifications for an *auto-fired* push (driver
// assignment, reassign-away, etc.) — i.e. pushes that originate from
// the dispatcher web's /api/driver-push surface, NOT a dispatcher
// clicking a button in the notify popover.
//
// Differs from POST /:id/notify in three ways:
//   - takes an explicit driverId in the body (so reassign-away can
//     record against the OLD driver, not the event's current one).
//   - doesn't require the event to currently have a driver assigned.
//   - kinds accepted include the informational 'assigned' /
//     'reassigned_away' rows that the notify popover never emits.
//
// Service-role insert — the web's /api/driver-push only has anon
// supabase access, so it can't do this itself.
events.post("/:id/record-auto-notification", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const eventId = c.req.param("id");
  const body = await c.req.json<{
    kind:        string;
    driverId:    number;
    loadId?:     string | null;
    sentByName:  string;
  }>();

  if (!LOAD_NOTIFICATION_KINDS.includes(body.kind as LoadNotificationKind)) {
    return c.json(
      { error: "validation_failed", errors: [`invalid kind: ${body.kind}`] } satisfies ApiErrorResponse,
      400,
    );
  }
  if (typeof body.driverId !== "number" || !Number.isFinite(body.driverId)) {
    return c.json(
      { error: "validation_failed", errors: ["driverId required (number)"] } satisfies ApiErrorResponse,
      400,
    );
  }
  if (!body.sentByName?.trim()) {
    return c.json(
      { error: "validation_failed", errors: ["sentByName required"] } satisfies ApiErrorResponse,
      400,
    );
  }

  // Verify the event belongs to this org so a malicious client can't
  // record notifications against arbitrary events.
  const { data: ev, error: evErr } = await supabase
    .from("events")
    .select("id,load_id")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (evErr) {
    console.error("[POST /v1/events/:id/record-auto-notification] event read:", evErr);
    return c.json({ error: "fetch_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!ev) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const evRow = ev as { id: string; load_id: string | null };

  const { error: insErr } = await supabase
    .from("load_notifications")
    .insert({
      org_id:       orgId,
      event_id:     eventId,
      load_id:      body.loadId ?? evRow.load_id,
      driver_id:    body.driverId,
      kind:         body.kind,
      sent_by_name: body.sentByName.trim(),
    } as never);
  if (insErr) {
    console.error("[POST /v1/events/:id/record-auto-notification] insert:", insErr);
    return c.json({ error: "insert_failed", detail: insErr.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default events;
