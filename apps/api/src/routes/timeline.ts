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
import Anthropic from "@anthropic-ai/sdk";
import type { ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { env } from "../lib/env.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

// Anthropic client for the AI auto-link endpoint. Same model as the
// cost-analysis route — Opus is overkill for "classify N movements"
// but it keeps the link reasoning quality high, and the per-call
// volume is low (one per day, per truck, on demand).
const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });
const AI_MODEL = "claude-opus-4-5";

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
  // Soft-deleted events excluded so the dispatcher never sees ghost
  // loads on the timeline.
  const { data: events, error: eErr } = await sb
    .from("events")
    .select("id, title, start, \"end\", status, event_kind, non_revenue_type, driver_name, load:loads(load_price)")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
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

// ── POST /assets/:assetId/auto-link — Claude classifies CLUSTERS ──
//
// Pipeline:
//   1. Fetch raw movements in window.
//   2. Coalesce them into CLUSTERS (mirrors the calendar's logic —
//      see clusterTimelineMovements in apps/web/lib/timelineClusters.ts).
//      Motive splits a single trip into many sub-mile driving periods;
//      asking the AI to classify each fragment wastes context and
//      produces inconsistent calls across fragments of the same trip.
//   3. Build a prompt where the unit of classification is the CLUSTER,
//      not the raw movement. The cluster prompt also includes the
//      org's saved_locations so geographic addresses resolve to known
//      names (the yard, the shop, recurring customer sites).
//   4. Claude returns one (role + event refs + confidence + reasoning)
//      per cluster.
//   5. The server fans the cluster's role out to every member
//      movement — writes a link fact per member so the existing
//      per-movement DB schema is preserved and downstream readers
//      (analytics, dashboards) don't need to know about clusters.
//
// Clusters whose CURRENT links include any 'manual' source are skipped —
// the dispatcher's edits stay sticky.

const SHORT_MS_AI          = 30 * 60_000;
const MERGE_GAP_MS_AI      = 15 * 60_000;
const MIN_CLUSTER_MILES_AI = 1.0;

interface MovementForCluster {
  id: string;
  start_time: string;
  end_time: string | null;
  miles: number | null;
  duration_min: number | null;
  origin: string | null;
  destination: string | null;
  origin_lat?: number | null;
  origin_lon?: number | null;
  destination_lat?: number | null;
  destination_lon?: number | null;
}

interface ServerCluster {
  id:            string;     // synthetic — 'C0', 'C1', ... — referenced in the AI tool output
  startTime:     string;
  endTime:       string;
  miles:         number;
  durationMin:   number;
  origin:        string | null;
  destination:   string | null;
  members:       MovementForCluster[];
}

function periodMsAi(m: MovementForCluster): number {
  if (!m.end_time) return 0;
  return new Date(m.end_time).getTime() - new Date(m.start_time).getTime();
}

function intervalsOverlapAi(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
      && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

function clusterMovementsForAi(movements: MovementForCluster[]): ServerCluster[] {
  if (movements.length === 0) return [];
  const sorted = [...movements].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const result: ServerCluster[] = [];

  for (const m of sorted) {
    const mEnd   = m.end_time ?? m.start_time;
    const mShort = periodMsAi(m) < SHORT_MS_AI;
    const last   = result[result.length - 1];

    let merge = false;
    if (last) {
      if (intervalsOverlapAi(last.startTime, last.endTime, m.start_time, mEnd)) {
        merge = true;
      } else {
        const lastMember = last.members[last.members.length - 1];
        const lastShort  = periodMsAi(lastMember) < SHORT_MS_AI;
        const gapMs      = new Date(m.start_time).getTime() - new Date(last.endTime).getTime();
        if (mShort && lastShort && gapMs <= MERGE_GAP_MS_AI) merge = true;
      }
    }

    if (merge && last) {
      const newEndMs = Math.max(new Date(last.endTime).getTime(), new Date(mEnd).getTime());
      last.endTime     = new Date(newEndMs).toISOString();
      last.miles       += m.miles ?? 0;
      last.durationMin += m.duration_min ?? 0;
      if (m.destination) last.destination = m.destination;
      last.members.push(m);
    } else {
      result.push({
        id:          "",        // assigned below after filtering
        startTime:   m.start_time,
        endTime:     mEnd,
        miles:       m.miles ?? 0,
        durationMin: m.duration_min ?? 0,
        origin:      m.origin,
        destination: m.destination,
        members:     [m],
      });
    }
  }

  const filtered = result.filter((c) => c.miles >= MIN_CLUSTER_MILES_AI);
  filtered.forEach((c, i) => { c.id = `C${i}`; });
  return filtered;
}

const AUTO_LINK_SYSTEM_PROMPT = `You classify CLUSTERS of driving from a truck's ELD log.

Each cluster represents one logical trip. Motive's API splits trips into many sub-mile fragments; the server has already coalesced overlapping and adjacent-short fragments into clusters so you don't waste your context on yard-jiggle GPS noise. A cluster is the unit of classification.

You will receive:
1. SAVED LOCATIONS — the org's named places (yard, shop, recurring customer sites). When a cluster's origin or destination matches one of these by address or coordinates, refer to it by NAME in your reasoning (e.g. "started at the yard" rather than "started at 1795 Milestone Dr").
2. THIS DAY'S LOADS on the truck (each with stops + scheduled window).
3. ADJACENT CONTEXT — the load BEFORE this day's first load and the load AFTER this day's last load on this truck. Use them to attribute the first/last deadhead correctly.
4. CLUSTERS — every logical driving trip in the window. Each has an opaque id like "C0", "C1". Refer to clusters by that id exactly.

Roles (pick exactly one per cluster):

- loaded     — cluster represents driving WITH a load on board. Set loaded_event_id.
- transition — cluster represents driving EMPTY between loads (a.k.a. deadhead). Set from_event_id and/or to_event_id. Either can be omitted: start-of-day from a saved location (yard / home) has no from; end-of-day to a saved location has no to.
- rest       — cluster represents the truck SHUFFLING IN PLACE at a rest area / overnight stop / hotel (rare — most rest periods are GAPS between clusters, not clusters themselves). No event refs.
- unrelated  — cluster doesn't fit any load story (personal conveyance to somewhere off-route, weird small loop far from any load geography). No event refs.

DO NOT use 'dwell' for clusters. Dwell is the GAP between clusters when the truck is stationary at a load location — it doesn't appear as a cluster in your input. If a cluster is at a load's pickup/delivery city, classify it as 'loaded' for that load (it's the drive that brought cargo in/out of the stop).

How to decide:

• loaded vs transition: did the cluster have cargo? It HAD cargo from the moment the truck left a pickup stop until it reached the delivery stop. Clusters whose route aligns with that segment of a load are 'loaded'. Clusters that connect a delivery to the next pickup (or yard to a pickup) are 'transition'.
• transition vs unrelated: a transition CONNECTS two loads (or a saved location + a load, or a load + a saved location). If you can identify the from/to load (or saved location) with reasonable confidence, it's a transition.
• Real-world driving doesn't match dispatch schedules exactly — treat ±2-4 hours of time drift as normal and don't downgrade confidence over it.

Confidence:

- high   — geography clearly matches the load route or a saved location.
- medium — ambiguous (could plausibly belong to two adjacent loads, or only one endpoint of the cluster aligns).
- low    — no clear match. Use 'unrelated' as the role.

For each cluster, output one entry in the submit_cluster_links tool call. The clusterId must match exactly. The reasoning field gets 1-2 sentences: which cities/saved-locations/loads/times drove the call.

Output ONLY via submit_cluster_links — no prose outside the tool call.`;

const AUTO_LINK_TOOL: Anthropic.Tool = {
  name: "submit_cluster_links",
  description: "Submit role + link classifications for every cluster provided.",
  input_schema: {
    type: "object",
    properties: {
      links: {
        type: "array",
        items: {
          type: "object",
          properties: {
            clusterId:      { type: "string", description: "Cluster id exactly as given (e.g. 'C0')." },
            role:           { type: "string", enum: ["loaded", "transition", "rest", "unrelated"] },
            loadedEventId:  { type: "string", description: "Required when role is 'loaded'." },
            fromEventId:    { type: "string", description: "For 'transition'. Omit when leaving from a saved location (yard, home)." },
            toEventId:      { type: "string", description: "For 'transition'. Omit when arriving at a saved location (yard, home)." },
            confidence:     { type: "string", enum: ["high", "medium", "low"] },
            reasoning:      { type: "string", description: "1-2 sentences: which cities/saved-locations/loads drove the call." },
          },
          required: ["clusterId", "role", "confidence", "reasoning"],
        },
      },
    },
    required: ["links"],
  },
};

interface AIClusterProposal {
  clusterId:      string;
  role:           "loaded" | "transition" | "rest" | "unrelated";
  loadedEventId?: string;
  fromEventId?:   string;
  toEventId?:     string;
  confidence:     "high" | "medium" | "low";
  reasoning:      string;
}

timeline.post("/assets/:assetId/auto-link", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const assetId = Number(c.req.param("assetId"));
  const from = c.req.query("from");
  const to   = c.req.query("to");

  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO)"] } satisfies ApiErrorResponse, 400);
  }

  // Confirm the asset belongs to the org.
  const { data: asset } = await sb
    .from("assets")
    .select("id, name, unit")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  // ── Fetch events on this truck in window (with stops) ───────────
  // Soft-deleted events excluded so the AI doesn't classify movements
  // against ghost loads.
  const { data: events } = await sb
    .from("events")
    .select("id, title, start, \"end\", event_kind, non_revenue_type")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .lt("start", to)
    .gt("end",   from)
    .order("start", { ascending: true });
  const eventList = (events ?? []) as Array<{
    id: string; title: string | null; start: string; end: string;
    event_kind: string | null; non_revenue_type: string | null;
  }>;
  const eventIds = eventList.map((e) => e.id);

  const { data: stops } = eventIds.length > 0
    ? await sb
        .from("stops")
        .select("id, event_id, sequence, type, facility_name, city, state, appt_start, appt_end")
        .in("event_id", eventIds)
        .order("sequence", { ascending: true })
    : { data: [] };
  const stopsByEvent = new Map<string, Array<{
    id: string; sequence: number | null; type: string | null;
    facility_name: string | null; city: string | null; state: string | null;
    appt_start: string | null; appt_end: string | null;
  }>>();
  for (const s of (stops ?? []) as Array<{
    id: string; event_id: string; sequence: number | null; type: string | null;
    facility_name: string | null; city: string | null; state: string | null;
    appt_start: string | null; appt_end: string | null;
  }>) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(s);
    stopsByEvent.set(s.event_id, arr);
  }

  // ── Adjacent context loads (prev + next on this asset) ──────────
  // Same soft-delete filter — a cancelled load shouldn't anchor the
  // model's pre/post-window deadhead attribution.
  const { data: prevEvents } = await sb
    .from("events")
    .select("id, title, start, \"end\"")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .lt("end", from)
    .order("end", { ascending: false })
    .limit(1);
  const prevEvent = ((prevEvents ?? []) as Array<{ id: string; title: string | null; start: string; end: string }>)[0];

  const { data: nextEvents } = await sb
    .from("events")
    .select("id, title, start, \"end\"")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gt("start", to)
    .order("start", { ascending: true })
    .limit(1);
  const nextEvent = ((nextEvents ?? []) as Array<{ id: string; title: string | null; start: string; end: string }>)[0];

  const adjacentIds = [prevEvent?.id, nextEvent?.id].filter(Boolean) as string[];
  const { data: adjStops } = adjacentIds.length > 0
    ? await sb
        .from("stops")
        .select("event_id, sequence, type, city, state")
        .in("event_id", adjacentIds)
        .order("sequence", { ascending: true })
    : { data: [] };
  const adjStopsByEvent = new Map<string, Array<{ type: string | null; city: string | null; state: string | null }>>();
  for (const s of (adjStops ?? []) as Array<{
    event_id: string; type: string | null; city: string | null; state: string | null;
  }>) {
    const arr = adjStopsByEvent.get(s.event_id) ?? [];
    arr.push({ type: s.type, city: s.city, state: s.state });
    adjStopsByEvent.set(s.event_id, arr);
  }

  // ── Fetch saved locations (the org's named places) ──────────────
  // Used by the AI to recognize the yard, the shop, recurring sites
  // so a movement starting/ending at a saved address resolves to a
  // name rather than a raw street string.
  const { data: savedLocRows } = await sb
    .from("saved_locations")
    .select("id, name, address, lat, lng")
    .eq("org_id", orgId);
  const savedLocations = (savedLocRows ?? []) as Array<{
    id: string; name: string; address: string | null;
    lat: number | null; lng: number | null;
  }>;

  // ── Fetch movements in window (incl. lat/lng for saved-loc match) ─
  const { data: movementRows } = await sb
    .from("movements")
    .select("id, start_time, end_time, miles, duration_min, origin, destination, origin_lat, origin_lon, destination_lat, destination_lon")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gte("start_time", from)
    .lt("start_time", to)
    .order("start_time", { ascending: true });
  const movements = (movementRows ?? []) as MovementForCluster[];

  if (movements.length === 0) {
    return c.json({ ok: true, linksWritten: 0, manualSkipped: 0, totalMovements: 0, message: "No movements in window." });
  }

  // ── Cluster movements (same algorithm as the timeline UI) ───────
  // The AI classifies CLUSTERS, not raw fragments. After this step,
  // sub-mile yard-noise clusters are dropped and short adjacent
  // fragments are merged so each unit represents one logical trip.
  const clusters = clusterMovementsForAi(movements);

  if (clusters.length === 0) {
    return c.json({
      ok: true,
      linksWritten: 0,
      manualSkipped: 0,
      totalMovements: movements.length,
      message: "No clusters survived coalescing (all under 1mi / too short).",
    });
  }

  // ── Skip clusters whose any member already has a manual link ────
  const allMovementIds = movements.map((m) => m.id);
  const { data: currentLinks } = await sb
    .from("movement_links")
    .select("movement_id, source")
    .eq("org_id", orgId)
    .in("movement_id", allMovementIds)
    .is("superseded_at", null);
  const manualMovementIds = new Set(
    ((currentLinks ?? []) as Array<{ movement_id: string; source: string }>)
      .filter((l) => l.source === "manual")
      .map((l) => l.movement_id),
  );
  const targetClusters = clusters.filter(
    (c) => !c.members.some((m) => manualMovementIds.has(m.id)),
  );

  if (targetClusters.length === 0) {
    return c.json({
      ok: true,
      linksWritten: 0,
      manualSkipped: manualMovementIds.size,
      totalMovements: movements.length,
      message: "Every cluster has at least one manual link — nothing for AI to do.",
    });
  }

  // ── Build user message ──────────────────────────────────────────
  const fmtEventBlock = (e: { id: string; title: string | null; start: string; end: string; event_kind?: string | null; non_revenue_type?: string | null }, label: string) => {
    const stopsHere = stopsByEvent.get(e.id) ?? [];
    const lines = [
      `${label} ${e.id}: "${e.title ?? "(no title)"}"${e.event_kind === "non_revenue" ? ` [${e.non_revenue_type ?? "non-revenue"}]` : ""}`,
      `  Window: ${e.start} → ${e.end}`,
    ];
    if (stopsHere.length > 0) {
      lines.push("  Stops:");
      for (const s of stopsHere) {
        lines.push(`    ${s.sequence ?? "?"}. ${s.type ?? "stop"} — ${s.city ?? "?"}, ${s.state ?? "?"}${s.facility_name ? ` (${s.facility_name})` : ""}${s.appt_start ? ` appt ${s.appt_start}${s.appt_end ? "→" + s.appt_end : ""}` : ""}`);
      }
    }
    return lines.join("\n");
  };

  const fmtAdjBlock = (e: { id: string; title: string | null; start: string; end: string } | undefined, label: string) => {
    if (!e) return `(no ${label} load on record)`;
    const stopsHere = adjStopsByEvent.get(e.id) ?? [];
    const pickup   = stopsHere.find((s) => s.type === "pickup");
    const delivery = [...stopsHere].reverse().find((s) => s.type === "delivery" || s.type === "drop" || s.type === "drop_hook");
    const route = `${pickup ? `${pickup.city ?? "?"}, ${pickup.state ?? "?"}` : "?"} → ${delivery ? `${delivery.city ?? "?"}, ${delivery.state ?? "?"}` : "?"}`;
    return `${label.toUpperCase()} ${e.id}: "${e.title ?? "(no title)"}"\n  Window: ${e.start} → ${e.end}\n  Route: ${route}`;
  };

  const fmtSavedLocBlock = () => {
    if (savedLocations.length === 0) return "(no saved locations on file)";
    return savedLocations.map((l) => {
      const parts: string[] = [];
      if (l.address) parts.push(l.address);
      if (l.lat != null && l.lng != null) parts.push(`coords ${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`);
      const tail = parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
      return `• ${l.name}${tail}`;
    }).join("\n");
  };

  const fmtClusterBlock = (cl: ServerCluster) => {
    const miles = `${cl.miles.toFixed(1)} mi`;
    const dur   = `${cl.durationMin} min`;
    const memberCount = cl.members.length === 1 ? "1 fragment" : `${cl.members.length} fragments`;
    return `${cl.id}: ${cl.startTime} → ${cl.endTime} | ${miles} · ${dur} | ${cl.origin ?? "??"} → ${cl.destination ?? "??"} (${memberCount})`;
  };

  const userMessage = [
    `# Asset`,
    `Truck #${assetId}: ${asset.name}${asset.unit ? ` (#${asset.unit})` : ""}`,
    ``,
    `# Saved locations (the org's named places — recognize these in cluster origin/destination)`,
    fmtSavedLocBlock(),
    ``,
    `# This day's loads on this truck`,
    eventList.length === 0
      ? "(no scheduled events in window)"
      : eventList.map((e) => fmtEventBlock(e, "LOAD")).join("\n\n"),
    ``,
    `# Adjacent context (so you can attribute pre/post-window transitions correctly)`,
    fmtAdjBlock(prevEvent, "previous"),
    fmtAdjBlock(nextEvent, "next"),
    ``,
    `# Clusters to classify (${targetClusters.length} of ${clusters.length}; ${manualMovementIds.size > 0 ? `${manualMovementIds.size} movements have manual links → their clusters are skipped` : "no manual overrides"})`,
    targetClusters.map(fmtClusterBlock).join("\n"),
    ``,
    `Classify every cluster above via submit_cluster_links.`,
  ].join("\n");

  // ── Call Claude ─────────────────────────────────────────────────
  let response;
  try {
    response = await anthropic.messages.create({
      model:      AI_MODEL,
      max_tokens: 8000,
      system:     [{ type: "text", text: AUTO_LINK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools:      [AUTO_LINK_TOOL],
      tool_choice: { type: "tool", name: "submit_cluster_links" },
      messages:   [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    console.error("[timeline auto-link] anthropic call failed:", err);
    return c.json({ error: "ai_failed", detail: (err as Error).message } satisfies ApiErrorResponse, 500);
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    return c.json({ error: "no_tool_use" } satisfies ApiErrorResponse, 500);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposed = ((toolUse.input as any)?.links ?? []) as AIClusterProposal[];

  // ── Write link facts (fan cluster decision out to every member) ──
  const clusterById = new Map(targetClusters.map((cl) => [cl.id, cl]));
  const validEventIds = new Set([
    ...eventList.map((e) => e.id),
    ...(prevEvent ? [prevEvent.id] : []),
    ...(nextEvent ? [nextEvent.id] : []),
  ]);

  let written = 0;
  let clustersWritten = 0;
  for (const p of proposed) {
    const cl = clusterById.get(p.clusterId);
    if (!cl) continue;                                                  // safety: AI hallucinated an id
    // Validate event references — AI hallucination can't sneak a
    // foreign org's event id into the link.
    const loadedOk = !p.loadedEventId || validEventIds.has(p.loadedEventId);
    const fromOk   = !p.fromEventId   || validEventIds.has(p.fromEventId);
    const toOk     = !p.toEventId     || validEventIds.has(p.toEventId);
    if (!loadedOk || !fromOk || !toOk) continue;
    // Validate role-refs combo matches the DB CHECK constraint.
    const roleOk =
      (p.role === "loaded"      && !!p.loadedEventId) ||
      (p.role === "transition"  && (!!p.fromEventId || !!p.toEventId)) ||
      (p.role === "rest" || p.role === "unrelated");
    if (!roleOk) continue;

    let clusterTouched = false;
    for (const member of cl.members) {
      // Skip the rare individually-overridden member inside an
      // otherwise unmanaged cluster (the cluster-level skip would
      // have caught a full manual override; this guards the edge).
      if (manualMovementIds.has(member.id)) continue;

      const { data: inserted, error: insErr } = await sb
        .from("movement_links")
        .insert({
          org_id:           orgId,
          movement_id:      member.id,
          role:             p.role,
          loaded_event_id:  p.loadedEventId ?? null,
          from_event_id:    p.fromEventId   ?? null,
          to_event_id:      p.toEventId     ?? null,
          source:           "ai_v1",
          source_user:      null,
          confidence:       p.confidence ?? null,
          reasoning:        p.reasoning
            ? `[cluster ${p.clusterId}] ${p.reasoning}`
            : `Cluster ${p.clusterId} (${cl.members.length} fragments).`,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.error("[timeline auto-link] insert failed for movement", member.id, insErr);
        continue;
      }

      await sb
        .from("movement_links")
        .update({ superseded_at: new Date().toISOString(), superseded_by: (inserted as { id: string }).id })
        .eq("org_id", orgId)
        .eq("movement_id", member.id)
        .is("superseded_at", null)
        .neq("id", (inserted as { id: string }).id);

      written++;
      clusterTouched = true;
    }
    if (clusterTouched) clustersWritten++;
  }

  return c.json({
    ok:               true,
    linksWritten:     written,
    clustersWritten,
    manualSkipped:    manualMovementIds.size,
    totalMovements:   movements.length,
    totalClusters:    clusters.length,
    proposedCount:    proposed.length,
    triggeredBy:      userId,
  });
});

export default timeline;
