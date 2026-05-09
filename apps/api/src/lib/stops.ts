/**
 * Shared stop-row helpers. Multiple routes (loads, closeout, …) need to
 * fetch + project the same stop columns; centralizing here avoids
 * drifting copies of STOP_COLS / rowToStop / StopRow.
 */

import type { Stop, StopType } from "@fleetcal/types";
import { supabase } from "./supabase.js";

export const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
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
    lat:           s.lat           ?? undefined,
    lng:           s.lng           ?? undefined,
    instructions:  s.instructions  ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
    arrivedAt:     s.arrived_at    ?? undefined,
    arrivedLat:    s.arrived_lat   ?? undefined,
    arrivedLng:    s.arrived_lng   ?? undefined,
  };
}

/** Fetch + group stops by event_id. Returns a Map keyed on event_id with
 *  stops sorted by sequence. Pass an empty array → empty Map. */
export async function fetchStopsByEvent(
  eventIds: string[],
): Promise<Map<string, Stop[]>> {
  const map = new Map<string, Stop[]>();
  if (eventIds.length === 0) return map;
  const { data: stopRows } = await supabase
    .from("stops")
    .select(STOP_COLS)
    .in("event_id", eventIds);
  for (const s of (stopRows ?? []) as unknown as StopRow[]) {
    const arr = map.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    map.set(s.event_id, arr);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.sequence - b.sequence);
  }
  return map;
}
