/**
 * /v1/timeline — asset-timeline foundation.
 *
 * This is the read+write surface for the new source-agnostic movement
 * system (PR 1 of the asset-timeline build). It does NOT replace
 * /v1/movements — that endpoint stays as the Motive-specific calendar
 * feed for the existing calendar view. This route serves the new
 * /assets/:id/timeline page (PR 2) and the AI auto-link endpoint
 * (PR 3).
 *
 * Endpoints:
 *
 *   GET    /v1/timeline/assets/:assetId?from=&to=
 *      → events + movements + links for the asset in window
 *
 *   POST   /v1/timeline/movements
 *      → create a manual movement (for non-ELD trucks or gap-filling)
 *
 *   PATCH  /v1/timeline/movements/:id
 *      → edit a manual movement (motive rows reject)
 *
 *   DELETE /v1/timeline/movements/:id
 *      → soft-delete a manual movement (motive rows reject)
 *
 *   POST   /v1/timeline/links
 *      → assert a link between a movement and event(s). Inserts a
 *        new fact row; supersedes the prior current link for the
 *        movement in the same transaction.
 *
 *   DELETE /v1/timeline/links/:movementId
 *      → mark the current link as 'unrelated' (still a fact insert +
 *        supersede; the movement stays, the relationship goes).
 */
import { Hono } from "hono";
import type { ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const timeline = new Hono<{ Variables: AuthVariables }>();

// Anyone with loads.view can read the timeline. Write-side endpoints
// gate at the route handler since some require asset/load mutation
// capability rather than view.
timeline.use("*", requireCapability("loads.view"));

// ── Shared row types ──────────────────────────────────────────────

interface MovementRow {
  id: string;
  org_id: string;
  asset_id: number;
  driver_id: number | null;
  source: "motive" | "manual" | "derived";
  motive_period_id: number | null;
  start_time: string;
  end_time: string | null;
  duration_min: number | null;
  miles: number | null;
  origin: string | null;
  destination: string | null;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MovementLinkRow {
  id: string;
  org_id: string;
  movement_id: string;
  role: "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loaded_event_id: string | null;
  from_event_id: string | null;
  to_event_id: string | null;
  dwell_stop_id: string | null;
  source: string;
  source_user: string | null;
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
  asserted_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

// Wire shapes — camelCased for the client.
interface MovementOut {
  id: string;
  assetId: number;
  driverId?: number;
  source: "motive" | "manual" | "derived";
  motivePeriodId?: number;
  startTime: string;
  endTime?: string;
  durationMin?: number;
  miles?: number;
  origin?: string;
  destination?: string;
  originLat?: number;
  originLon?: number;
  destinationLat?: number;
  destinationLon?: number;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface MovementLinkOut {
  id: string;
  movementId: string;
  role: "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loadedEventId?: string;
  fromEventId?: string;
  toEventId?: string;
  dwellStopId?: string;
  source: string;
  sourceUser?: string;
  confidence?: "high" | "medium" | "low";
  reasoning?: string;
  assertedAt: string;
}

function rowToMovement(r: MovementRow): MovementOut {
  return {
    id:              r.id,
    assetId:         r.asset_id,
    driverId:        r.driver_id ?? undefined,
    source:          r.source,
    motivePeriodId:  r.motive_period_id ?? undefined,
    startTime:       r.start_time,
    endTime:         r.end_time ?? undefined,
    durationMin:     r.duration_min ?? undefined,
    miles:           r.miles ?? undefined,
    origin:          r.origin ?? undefined,
    destination:     r.destination ?? undefined,
    originLat:       r.origin_lat ?? undefined,
    originLon:       r.origin_lon ?? undefined,
    destinationLat:  r.destination_lat ?? undefined,
    destinationLon:  r.destination_lon ?? undefined,
    notes:           r.notes ?? undefined,
    createdBy:       r.created_by,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
  };
}

function rowToLink(r: MovementLinkRow): MovementLinkOut {
  return {
    id:             r.id,
    movementId:     r.movement_id,
    role:           r.role,
    loadedEventId:  r.loaded_event_id ?? undefined,
    fromEventId:    r.from_event_id ?? undefined,
    toEventId:      r.to_event_id ?? undefined,
    dwellStopId:    r.dwell_stop_id ?? undefined,
    source:         r.source,
    sourceUser:     r.source_user ?? undefined,
    confidence:     r.confidence ?? undefined,
    reasoning:      r.reasoning ?? undefined,
    assertedAt:     r.asserted_at,
  };
}

const MOVEMENT_COLS =
  "id, org_id, asset_id, driver_id, source, motive_period_id, " +
  "start_time, end_time, duration_min, miles, " +
  "origin, destination, origin_lat, origin_lon, destination_lat, destination_lon, " +
  "notes, created_by, created_at, updated_at";

const LINK_COLS =
  "id, org_id, movement_id, role, " +
  "loaded_event_id, from_event_id, to_event_id, dwell_stop_id, " +
  "source, source_user, confidence, reasoning, " +
  "asserted_at, superseded_at, superseded_by";

// ── GET /assets/:assetId — timeline payload ────────────────────────

interface TimelineEvent {
  id: string;
  title: string | null;
  start: string;
  end: string;
  status: string | null;
  eventKind: string | null;
  nonRevenueType: string | null;
  loadPrice: number | null;
  driverName: string | null;
  stops: Array<{
    id: string;
    sequence: number;
    type: string | null;
    facilityName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    apptStart: string | null;
    apptEnd: string | null;
    lat: number | null;
    lng: number | null;
  }>;
}

interface TimelinePayload {
  asset: { id: number; name: string; unit: string | null };
  windowFrom: string;
  windowTo: string;
  events: TimelineEvent[];
  movements: MovementOut[];
  links: MovementLinkOut[];   // current truth only (superseded_at IS NULL)
}

timeline.get("/assets/:assetId", async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  const from = c.req.query("from");
  const to   = c.req.query("to");

  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO)"] } satisfies ApiErrorResponse, 400);
  }

  // Asset metadata (also confirms the asset belongs to the org).
  const { data: asset, error: aErr } = await sb
    .from("assets")
    .select("id, name, unit")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (aErr || !asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  // Events whose [start, end] intersects the window. Boundary-events
  // (a multi-day load that started before `from`) are included so the
  // timeline doesn't show partial trip endpoints with no context.
  const { data: events, error: eErr } = await sb
    .from("events")
    .select("id, title, start, \"end\", status, event_kind, non_revenue_type, driver_name, load:loads(load_price)")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .lt("start", to)
    .gt("end", from)
    .order("start", { ascending: true });
  if (eErr) {
    console.error("[GET /v1/timeline/assets/:id] events:", eErr);
    return c.json({ error: "fetch_failed", detail: eErr.message } satisfies ApiErrorResponse, 500);
  }
  const eventIds = ((events ?? []) as Array<{ id: string }>).map((e) => e.id);

  // Stops for each event — single batched query.
  const { data: stops } = eventIds.length > 0
    ? await sb
        .from("stops")
        .select("id, event_id, sequence, type, facility_name, address, city, state, appt_start, appt_end, lat, lng")
        .in("event_id", eventIds)
        .order("sequence", { ascending: true })
    : { data: [] };
  const stopsByEvent = new Map<string, TimelineEvent["stops"]>();
  for (const s of (stops ?? []) as Array<{
    id: string; event_id: string; sequence: number; type: string | null;
    facility_name: string | null; address: string | null; city: string | null; state: string | null;
    appt_start: string | null; appt_end: string | null; lat: number | null; lng: number | null;
  }>) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push({
      id:           s.id,
      sequence:     s.sequence,
      type:         s.type,
      facilityName: s.facility_name,
      address:      s.address,
      city:         s.city,
      state:        s.state,
      apptStart:    s.appt_start,
      apptEnd:      s.appt_end,
      lat:          s.lat,
      lng:          s.lng,
    });
    stopsByEvent.set(s.event_id, arr);
  }

  const eventsOut: TimelineEvent[] = ((events ?? []) as Array<{
    id: string; title: string | null; start: string; end: string;
    status: string | null; event_kind: string | null; non_revenue_type: string | null;
    driver_name: string | null; load: { load_price: number | null } | null;
  }>).map((e) => ({
    id:             e.id,
    title:          e.title,
    start:          e.start,
    end:            e.end,
    status:         e.status,
    eventKind:      e.event_kind,
    nonRevenueType: e.non_revenue_type,
    loadPrice:      e.load?.load_price ?? null,
    driverName:     e.driver_name,
    stops:          stopsByEvent.get(e.id) ?? [],
  }));

  // Movements whose start_time falls in the window OR end_time falls
  // in the window — covers boundary movements both ways.
  const { data: movementRows, error: mErr } = await sb
    .from("movements")
    .select(MOVEMENT_COLS)
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gte("start_time", from)
    .lt("start_time", to)
    .order("start_time", { ascending: true });
  if (mErr) {
    console.error("[GET /v1/timeline/assets/:id] movements:", mErr);
    return c.json({ error: "fetch_failed", detail: mErr.message } satisfies ApiErrorResponse, 500);
  }
  const movementsOut = ((movementRows ?? []) as MovementRow[]).map(rowToMovement);
  const movementIds  = movementsOut.map((m) => m.id);

  // Current-truth links for those movements.
  const { data: linkRows } = movementIds.length > 0
    ? await sb
        .from("movement_links")
        .select(LINK_COLS)
        .eq("org_id", orgId)
        .in("movement_id", movementIds)
        .is("superseded_at", null)
    : { data: [] };
  const linksOut = ((linkRows ?? []) as MovementLinkRow[]).map(rowToLink);

  const res: TimelinePayload = {
    asset:      { id: asset.id, name: asset.name, unit: asset.unit ?? null },
    windowFrom: from,
    windowTo:   to,
    events:     eventsOut,
    movements:  movementsOut,
    links:      linksOut,
  };
  return c.json(res);
});

// ── POST /movements — create a manual movement ────────────────────

interface CreateMovementBody {
  assetId:         number;
  driverId?:       number;
  startTime:       string;
  endTime?:        string;
  durationMin?:    number;
  miles?:          number;
  origin?:         string;
  destination?:    string;
  originLat?:      number;
  originLon?:      number;
  destinationLat?: number;
  destinationLon?: number;
  notes?:          string;
}

timeline.post("/movements", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  let body: CreateMovementBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  if (!Number.isFinite(body.assetId) || !body.startTime) {
    return c.json({ error: "validation_failed", errors: ["assetId and startTime required"] } satisfies ApiErrorResponse, 400);
  }

  // Confirm the asset belongs to the org before insert.
  const { data: asset } = await sb
    .from("assets")
    .select("id")
    .eq("id", body.assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  const { data, error } = await sb
    .from("movements")
    .insert({
      org_id:           orgId,
      asset_id:         body.assetId,
      driver_id:        body.driverId ?? null,
      source:           "manual",
      start_time:       body.startTime,
      end_time:         body.endTime ?? null,
      duration_min:     body.durationMin ?? null,
      miles:            body.miles ?? null,
      origin:           body.origin ?? null,
      destination:      body.destination ?? null,
      origin_lat:       body.originLat ?? null,
      origin_lon:       body.originLon ?? null,
      destination_lat:  body.destinationLat ?? null,
      destination_lon:  body.destinationLon ?? null,
      notes:            body.notes ?? null,
      created_by:       userId,
    })
    .select(MOVEMENT_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/timeline/movements] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ movement: rowToMovement(data as MovementRow) });
});

// ── PATCH /movements/:id — edit manual movement ───────────────────

interface UpdateMovementBody {
  startTime?:      string;
  endTime?:        string | null;
  durationMin?:    number | null;
  miles?:          number | null;
  origin?:         string | null;
  destination?:    string | null;
  originLat?:      number | null;
  originLon?:      number | null;
  destinationLat?: number | null;
  destinationLon?: number | null;
  notes?:          string | null;
}

timeline.patch("/movements/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  let body: UpdateMovementBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  const { data: existing } = await sb
    .from("movements")
    .select("id, source, deleted_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existing) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }
  if (existing.source === "motive") {
    return c.json({
      error: "motive_movement_immutable",
      detail: "Motive-sourced movements can't be edited (they're synced from the ELD).",
    } satisfies ApiErrorResponse, 400);
  }
  if (existing.deleted_at) {
    return c.json({ error: "movement_deleted" } satisfies ApiErrorResponse, 400);
  }

  // Build the partial update only including supplied fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: any = {};
  if ("startTime"      in body) update.start_time       = body.startTime;
  if ("endTime"        in body) update.end_time         = body.endTime;
  if ("durationMin"    in body) update.duration_min     = body.durationMin;
  if ("miles"          in body) update.miles            = body.miles;
  if ("origin"         in body) update.origin           = body.origin;
  if ("destination"    in body) update.destination      = body.destination;
  if ("originLat"      in body) update.origin_lat       = body.originLat;
  if ("originLon"      in body) update.origin_lon       = body.originLon;
  if ("destinationLat" in body) update.destination_lat  = body.destinationLat;
  if ("destinationLon" in body) update.destination_lon  = body.destinationLon;
  if ("notes"          in body) update.notes            = body.notes;

  const { data, error } = await sb
    .from("movements")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(MOVEMENT_COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/timeline/movements/:id] update:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ movement: rowToMovement(data as MovementRow) });
});

// ── DELETE /movements/:id — soft delete (manual only) ─────────────

timeline.delete("/movements/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: existing } = await sb
    .from("movements")
    .select("id, source")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existing) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }
  if (existing.source === "motive") {
    return c.json({
      error: "motive_movement_immutable",
      detail: "Motive-sourced movements are history — mark them 'unrelated' via a link instead of deleting.",
    } satisfies ApiErrorResponse, 400);
  }

  const { error } = await sb
    .from("movements")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/timeline/movements/:id]:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

// ── POST /links — assert a link (append + supersede) ──────────────

interface AssertLinkBody {
  movementId:      string;
  role:            "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loadedEventId?:  string;
  fromEventId?:    string;
  toEventId?:      string;
  dwellStopId?:    string;
  source?:         string;   // defaults to 'manual'
  confidence?:     "high" | "medium" | "low";
  reasoning?:      string;
}

timeline.post("/links", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  let body: AssertLinkBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  if (!body.movementId || !body.role) {
    return c.json({ error: "validation_failed", errors: ["movementId and role required"] } satisfies ApiErrorResponse, 400);
  }

  // Validate the role <-> refs combo matches the DB CHECK so we can
  // return a friendly error instead of a Postgres constraint message.
  const roleValid =
    (body.role === "loaded"      && !!body.loadedEventId) ||
    (body.role === "transition"  && (!!body.fromEventId || !!body.toEventId)) ||
    (body.role === "dwell"       && !!body.loadedEventId) ||
    (body.role === "rest" || body.role === "unrelated");
  if (!roleValid) {
    return c.json({
      error: "validation_failed",
      errors: ["role/event-references combination invalid (see API docs)"],
    } satisfies ApiErrorResponse, 400);
  }

  // Confirm the movement belongs to the org.
  const { data: movement } = await sb
    .from("movements")
    .select("id, org_id")
    .eq("id", body.movementId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!movement) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }

  const source = body.source ?? "manual";
  const isManual = source === "manual";

  // 1. Insert the new fact.
  const { data: inserted, error: insErr } = await sb
    .from("movement_links")
    .insert({
      org_id:           orgId,
      movement_id:      body.movementId,
      role:             body.role,
      loaded_event_id:  body.loadedEventId ?? null,
      from_event_id:    body.fromEventId   ?? null,
      to_event_id:      body.toEventId     ?? null,
      dwell_stop_id:    body.dwellStopId   ?? null,
      source,
      source_user:      isManual ? userId : null,
      confidence:       body.confidence ?? null,
      reasoning:        body.reasoning  ?? null,
    })
    .select(LINK_COLS)
    .single();
  if (insErr || !inserted) {
    console.error("[POST /v1/timeline/links] insert:", insErr);
    return c.json({ error: "insert_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
  }
  const newLink = inserted as MovementLinkRow;

  // 2. Mark all prior current links for this movement as superseded.
  //    (Exclude the row we just inserted by id.)
  const { error: supErr } = await sb
    .from("movement_links")
    .update({ superseded_at: new Date().toISOString(), superseded_by: newLink.id })
    .eq("org_id", orgId)
    .eq("movement_id", body.movementId)
    .is("superseded_at", null)
    .neq("id", newLink.id);
  if (supErr) {
    // The new fact still landed; surface the supersede issue but don't
    // 500 the whole call. Readers filter on superseded_at IS NULL so the
    // worst-case is two "current" rows until next cleanup.
    console.error("[POST /v1/timeline/links] supersede:", supErr);
  }

  return c.json({ link: rowToLink(newLink) });
});

// ── DELETE /links/:movementId — mark current link 'unrelated' ─────

timeline.delete("/links/:movementId", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const movementId = c.req.param("movementId");

  const { data: movement } = await sb
    .from("movements")
    .select("id")
    .eq("id", movementId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!movement) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }

  // Insert an 'unrelated' fact + supersede previous in one go.
  const { data: inserted, error: insErr } = await sb
    .from("movement_links")
    .insert({
      org_id:      orgId,
      movement_id: movementId,
      role:        "unrelated",
      source:      "manual",
      source_user: userId,
      reasoning:   "Cleared via DELETE /v1/timeline/links/:movementId",
    })
    .select(LINK_COLS)
    .single();
  if (insErr || !inserted) {
    console.error("[DELETE /v1/timeline/links/:movementId]:", insErr);
    return c.json({ error: "insert_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
  }

  const { error: supErr } = await sb
    .from("movement_links")
    .update({ superseded_at: new Date().toISOString(), superseded_by: (inserted as MovementLinkRow).id })
    .eq("org_id", orgId)
    .eq("movement_id", movementId)
    .is("superseded_at", null)
    .neq("id", (inserted as MovementLinkRow).id);
  if (supErr) {
    console.error("[DELETE /v1/timeline/links/:movementId] supersede:", supErr);
  }

  return c.json({ link: rowToLink(inserted as MovementLinkRow) });
});

export default timeline;
