/**
 * /v1/loads — load CRUD (Phase 3, first endpoint).
 *
 * POST /v1/loads
 *   Creates a load row and 1-2 event rows pointing to it, plus per-event
 *   stops if provided. Returns the joined view (one Load entry per event).
 *
 * Atomicity: PostgREST doesn't expose Postgres transactions, so we do
 * sequential inserts (load → events → stops) with best-effort cleanup on
 * failure. A future improvement is wrapping this in a PL/pgSQL function
 * via supabase.rpc; deferred until the failure mode actually bites.
 */

import { Hono } from "hono";
import {
  appLoadToLoadInsert,
  appLoadToEventInsert,
  joinEventLoadToApp,
  type CreateLoadRequest,
  type CreateLoadResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const loads = new Hono<{ Variables: AuthVariables }>();

// ── POST /v1/loads ──────────────────────────────────────────────────────

loads.post("/", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateLoadRequest>();

  // ── Validation ────────────────────────────────────────────────────────
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    errors.push("body must be an object");
  }
  if (!body?.load || typeof body.load !== "object") {
    errors.push("missing 'load' object");
  }
  if (!Array.isArray(body?.events)) {
    errors.push("'events' must be an array");
  } else {
    if (body.events.length < 1 || body.events.length > 2) {
      errors.push("'events' must have 1 or 2 entries");
    }
    if (body.events.length === 2) {
      const roles = body.events.map((e) => e.relayRole);
      if (
        !roles.includes("pickup") ||
        !roles.includes("delivery") ||
        roles[0] === roles[1]
      ) {
        errors.push("relay loads need exactly one 'pickup' and one 'delivery' relayRole");
      }
    }
    for (const [i, ev] of body.events.entries()) {
      if (!ev.title?.trim()) errors.push(`events[${i}]: title required`);
      if (!ev.start) errors.push(`events[${i}]: start required`);
      if (!ev.end) errors.push(`events[${i}]: end required`);
      if (typeof ev.assetId !== "number") errors.push(`events[${i}]: assetId (number) required`);
      if (ev.start && ev.end && ev.start > ev.end) {
        errors.push(`events[${i}]: start must be <= end`);
      }
    }
  }

  if (errors.length) {
    const res: ApiErrorResponse = { error: "validation_failed", errors };
    return c.json(res, 400);
  }

  // ── 1. Insert load row ────────────────────────────────────────────────
  const loadInsert = appLoadToLoadInsert(body.load, orgId);
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .insert(loadInsert)
    .select()
    .single();

  if (loadErr || !loadRow) {
    console.error("[/v1/loads] load insert failed:", loadErr);
    const res: ApiErrorResponse = {
      error: "load_insert_failed",
      detail: loadErr?.message,
    };
    return c.json(res, 500);
  }

  // ── 2. Insert events (with load_id pointing at the new load) ──────────
  const eventInserts = body.events.map((ev) =>
    appLoadToEventInsert(
      {
        ...ev,
        loadId:    loadRow.id,
        eventKind: "revenue",
        status:    ev.status ?? "scheduled",
        // Load type requires `stops`; converter ignores it (stops are a
        // separate table) but TS needs the field present.
        stops:     [],
      },
      orgId,
    ),
  );

  const { data: eventRows, error: evErr } = await supabase
    .from("events")
    .insert(eventInserts)
    .select();

  if (evErr || !eventRows || eventRows.length !== body.events.length) {
    console.error("[/v1/loads] events insert failed:", evErr);
    // Best-effort cleanup: remove the orphan load row we just created.
    await supabase.from("loads").delete().eq("id", loadRow.id);
    const res: ApiErrorResponse = {
      error: "events_insert_failed",
      detail: evErr?.message,
    };
    return c.json(res, 500);
  }

  // ── 3. Insert stops (per-event) ───────────────────────────────────────
  const stopInserts = body.events.flatMap((ev, i) => {
    const eventId = eventRows[i].id;
    return (ev.stops ?? []).map((s, idx) => ({
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
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    }));
  });

  if (stopInserts.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopInserts);
    if (stopErr) {
      console.error("[/v1/loads] stops insert failed:", stopErr);
      // Cleanup: cascade delete via load (events are FK to loads with CASCADE)
      await supabase.from("loads").delete().eq("id", loadRow.id);
      const res: ApiErrorResponse = {
        error: "stops_insert_failed",
        detail: stopErr?.message,
      };
      return c.json(res, 500);
    }
  }

  // ── 4. Build joined-view response ─────────────────────────────────────
  // Re-fetch stops we just inserted so the response is the canonical view.
  const eventIds = eventRows.map((e) => e.id);
  const { data: stopRows } = await supabase
    .from("stops")
    .select("*")
    .in("event_id", eventIds);

  const stopsByEvent = new Map<string, typeof stopRows>();
  for (const s of stopRows ?? []) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(s);
    stopsByEvent.set(s.event_id, arr);
  }

  const responseLoads = eventRows.map((e) => {
    const joined = joinEventLoadToApp(e, loadRow);
    const evStops = (stopsByEvent.get(e.id) ?? []).slice().sort(
      (a, b) => a.sequence - b.sequence,
    );
    joined.stops = evStops.map((s) => ({
      id:           s.id,
      eventId:      s.event_id,
      sequence:     s.sequence,
      type:         s.type as never,
      facilityName: s.facility_name ?? undefined,
      address:      s.address       ?? undefined,
      city:         s.city          ?? undefined,
      timezone:     s.timezone      ?? undefined,
      apptStart:    s.appt_start    ?? undefined,
      apptEnd:      s.appt_end      ?? undefined,
      lat:          s.lat           ?? undefined,
      lng:          s.lng           ?? undefined,
      instructions: s.instructions  ?? undefined,
      geocodeStatus: (s.geocode_status as never) ?? "pending",
    }));
    return joined;
  });

  const response: CreateLoadResponse = { loads: responseLoads };
  return c.json(response, 201);
});

export default loads;
