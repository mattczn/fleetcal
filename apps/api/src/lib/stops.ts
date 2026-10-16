/**
 * Shared stop-row helpers. Multiple routes (loads, closeout, …) need to
 * fetch + project the same stop columns; centralizing here avoids
 * drifting copies of STOP_COLS / rowToStop / StopRow.
 */

import type { Stop, StopType } from "@fleetcal/types";
import { supabase } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";

export const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,is_handoff,handoff_drop_at,handoff_pickup_at," +
  "lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

export interface StopRow {
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
  is_handoff: boolean | null;
  handoff_drop_at: string | null;
  handoff_pickup_at: string | null;
  lat: number | null;
  lng: number | null;
  instructions: string | null;
  geocode_status: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

export function rowToStop(s: StopRow): Stop {
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
    isHandoff:  s.is_handoff ?? undefined,
    handoffDropAt:  s.handoff_drop_at ?? undefined,
    handoffPickupAt:  s.handoff_pickup_at ?? undefined,
    lat:           s.lat           ?? undefined,
    lng:           s.lng           ?? undefined,
    instructions:  s.instructions  ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
    arrivedAt:     s.arrived_at    ?? undefined,
    arrivedLat:    s.arrived_lat   ?? undefined,
    arrivedLng:    s.arrived_lng   ?? undefined,
  };
}

/** Event ids per stops query. `.in()` puts every id in the URL (~39
 *  bytes each once encoded) and the PostgREST gateway rejects URLs past
 *  ~25KB — about 640 ids, measured 2026-10-16. The calendar's 28-day
 *  window is ~950 events, so one query per window failed outright. */
const STOP_READ_CHUNK = 200;

/** Fetch + group stops by event_id. Returns a Map keyed on event_id with
 *  stops sorted by sequence. Pass an empty array → empty Map.
 *
 *  Chunked by event id AND paged within each chunk — a read that drops
 *  stops hands the editor a short list, and saving a short list deletes
 *  the stops it never saw. Throws rather than returning a partial map
 *  for the same reason. */
export async function fetchStopsByEvent(
  eventIds: string[],
): Promise<Map<string, Stop[]>> {
  const map = new Map<string, Stop[]>();
  const unique = [...new Set(eventIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += STOP_READ_CHUNK) {
    chunks.push(unique.slice(i, i + STOP_READ_CHUNK));
  }
  const pages = await Promise.all(chunks.map((chunk) =>
    fetchAllRows<StopRow>("fetchStopsByEvent", () =>
      supabase.from("stops").select(STOP_COLS).in("event_id", chunk),
    ),
  ));
  for (const s of pages.flat()) {
    const arr = map.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    map.set(s.event_id, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.sequence - b.sequence);
  }
  return map;
}

/** The columns a caller may set on a stop. event_id / org_id / sequence
 *  come from the call itself; arrived_* belong to the driver app and are
 *  never written from a dispatcher payload. */
function stopToRpcRow(s: Stop) {
  return {
    id:                s.id ?? null,
    type:              s.type,
    facility_name:     s.facilityName    ?? null,
    address:           s.address         ?? null,
    city:              s.city            ?? null,
    state:             s.state           ?? null,
    timezone:          s.timezone        ?? null,
    appt_start:        s.apptStart       ?? null,
    appt_end:          s.apptEnd         ?? null,
    schedule_type:     s.scheduleType    ?? null,
    is_handoff:        s.isHandoff       ?? false,
    handoff_drop_at:   s.handoffDropAt   ?? null,
    handoff_pickup_at: s.handoffPickupAt ?? null,
    lat:               s.lat             ?? null,
    lng:               s.lng             ?? null,
    instructions:      s.instructions    ?? null,
    geocode_status:    s.geocodeStatus   ?? "pending",
  };
}

export type ReplaceStopsResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 500; message: string };

/**
 * Write `stops` as the stop list of every event in `eventIds`, in ONE
 * transaction (replace_event_stops, migration 20261016b).
 *
 * Stops sent back with their id are updated in place, so the uuid the
 * driver app holds, the driver's check-in and any movement link on them
 * survive. Stops left out are deleted, new ones inserted. On any failure
 * nothing changes — the load keeps its old stops.
 *
 * This replaced a delete-then-insert pair: when the insert failed the
 * delete had already happened, and the load was left with no stops.
 */
export async function replaceEventStops(
  orgId: string,
  eventIds: string[],
  stops: Stop[],
): Promise<ReplaceStopsResult> {
  const { error } = await supabase.rpc("replace_event_stops", {
    p_org_id:    orgId,
    p_event_ids: eventIds,
    p_stops:     stops.map(stopToRpcRow),
  });
  if (!error) return { ok: true };
  console.error("[replaceEventStops] failed:", { orgId, eventIds, error });
  // 22023 = the function's own validation, 22P02 = a malformed value
  // (e.g. lat "abc"), P0002 = an event outside this org.
  const status = error.code === "22023" || error.code === "22P02" ? 400
    : error.code === "P0002" ? 404
    : 500;
  return { ok: false, status, message: error.message };
}
