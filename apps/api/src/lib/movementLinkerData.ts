/**
 * Loads what the movement linker needs for one org and window: every
 * truck's Motive drives, its calendar entries with their own stops, and the
 * org's saved locations. Read-only. See docs/movement-linking.md.
 */

import { handoffTimesOf, isHandoffStop, stopsForLeg, type Stop } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { getHosConfig } from "./hosService.js";
import { isUsableCoord, parseTerminal, type Coord } from "./airMiles.js";
import type { CalEvent, CalStop, GpsDrive, HomeBase, StopKind } from "./movementLinker.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const DAY = 86_400_000;
const kmToMi = (km: number | null | undefined) => (km == null ? null : Number(km) * 0.621371);

// ── Wall-clock → UTC ────────────────────────────────────────────────────

const offsetFmt = new Map<string, Intl.DateTimeFormat>();
function tzOffsetMs(utcMs: number, timeZone: string): number {
  let f = offsetFmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    offsetFmt.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return local - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Calendar times are stored as naive wall-clock strings ("2026-10-02T07:00")
 * in the org's (or the stop's) timezone; GPS is UTC. Strings that already
 * carry an offset are parsed as-is. Date-only and malformed values
 * ("2026-09-02T") fall back to midnight local; unparseable → null.
 */
export function wallClockToUtc(value: string | null | undefined, timeZone: string): number | null {
  if (!value) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const first = asUtc - tzOffsetMs(asUtc, timeZone);
  // Second pass settles DST transitions.
  return asUtc - tzOffsetMs(first, timeZone);
}

// ── Loader ──────────────────────────────────────────────────────────────

export interface TruckInputs {
  assetId: number;
  name: string;
  hasGps: boolean;
  drives: GpsDrive[];
  events: CalEvent[];
}

export interface OrgLinkInputs {
  timeZone: string;
  terminal: Coord | null;
  homes: HomeBase[];
  trucks: TruckInputs[];
}

interface StopRow {
  id: string; event_id: string; sequence: number; type: string;
  lat: number | null; lng: number | null; city: string | null; state: string | null;
  facility_name: string | null; timezone: string | null;
  appt_start: string | null; appt_end: string | null;
  is_handoff: boolean | null; handoff_drop_at: string | null; handoff_pickup_at: string | null;
}

/** `from`/`to` are ISO dates; a day of margin is read on each side so
 *  drives and legs crossing the window edges still line up. */
export async function loadOrgLinkInputs(orgId: string, from: string, to: string): Promise<OrgLinkInputs> {
  const fromMs = Date.parse(`${from}T00:00:00Z`) - DAY;
  const toMs = Date.parse(`${to}T00:00:00Z`) + 2 * DAY;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const fromWall = fromIso.slice(0, 16);
  const toWall = toIso.slice(0, 16);

  const [hos, settings, assets, homesRows, moves, events] = await Promise.all([
    getHosConfig(orgId),
    supabase.from("org_settings").select("hos_settings").eq("org_id", orgId).maybeSingle(),
    fetchAllRows<{ id: number; name: string; motive_vehicle_id: string | null }>(
      "linker assets", () => supabase.from("assets").select("id, name, motive_vehicle_id").eq("org_id", orgId)),
    fetchAllRows<{ id: string; name: string; lat: number | null; lng: number | null }>(
      "linker saved locations", () => supabase.from("saved_locations").select("id, name, lat, lng").eq("org_id", orgId)),
    fetchAllRows<{
      id: string; asset_id: number; start_time: string; end_time: string | null; miles: number | null;
      origin_lat: number | null; origin_lon: number | null; destination_lat: number | null; destination_lon: number | null;
      motive_driving_periods: { start_kilometers: number | null; end_kilometers: number | null } | null;
    }>("linker movements", () => supabase
      .from("movements")
      .select("id, asset_id, start_time, end_time, miles, origin_lat, origin_lon, destination_lat, destination_lon, motive_driving_periods(start_kilometers, end_kilometers)")
      .eq("org_id", orgId)
      .eq("source", "motive")
      .is("deleted_at", null)
      .gte("start_time", fromIso)
      .lt("start_time", toIso)),
    fetchAllRows<{
      id: string; load_id: string | null; asset_id: number | null; start: string; end: string | null;
      leg_index: number | null; status: string | null; event_kind: string | null; loaded_miles: number | null;
      title: string | null; loads: { load_num: string | null } | null;
    }>("linker events", () => supabase
      .from("events")
      .select("id, load_id, asset_id, start, end, leg_index, status, event_kind, loaded_miles, title, loads(load_num)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("asset_id", "is", null)
      .lt("start", toWall)
      .gt("end", fromWall)),
  ]);
  const timeZone = hos.timeZone;
  const terminal = parseTerminal(settings.data?.hos_settings);

  const live = events.filter((e) => e.status !== "cancelled" && (e.event_kind === "revenue" || e.event_kind === "non_revenue"));
  const stopRows: StopRow[] = [];
  const ids = live.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    stopRows.push(...await fetchAllRows<StopRow>("linker stops", () => supabase
      .from("stops")
      .select("id, event_id, sequence, type, lat, lng, city, state, facility_name, timezone, appt_start, appt_end, is_handoff, handoff_drop_at, handoff_pickup_at")
      .in("event_id", chunk)));
  }
  const stopsByEvent = new Map<string, StopRow[]>();
  for (const s of stopRows) stopsByEvent.set(s.event_id, [...(stopsByEvent.get(s.event_id) ?? []), s]);

  const coord = (lat: number | null, lon: number | null): Coord | null => {
    const c = { lat: Number(lat), lon: Number(lon) };
    return lat != null && lon != null && isUsableCoord(c) ? c : null;
  };

  const toCalEvent = (e: (typeof live)[number]): CalEvent | null => {
    const start = wallClockToUtc(e.start, timeZone);
    const end = wallClockToUtc(e.end, timeZone) ?? start;
    if (start == null || end == null) return null;
    const all = (stopsByEvent.get(e.id) ?? [])
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({ ...s, type: s.type as Stop["type"], isHandoff: s.is_handoff ?? undefined }));
    // Relay legs carry the whole load's stop list; keep this leg's slice.
    const mine = stopsForLeg(all, e.leg_index ?? 0);
    const stops: CalStop[] = mine.map((s, pos) => {
      const tz = s.timezone || timeZone;
      const handoff = isHandoffStop(s);
      let when: string | null = s.appt_start;
      if (handoff) {
        const h = handoffTimesOf({
          type: s.type, apptStart: s.appt_start ?? undefined, apptEnd: s.appt_end ?? undefined,
          handoffDropAt: s.handoff_drop_at ?? undefined, handoffPickupAt: s.handoff_pickup_at ?? undefined,
        });
        // The leg that starts here picks the trailer up; the one ending here drops it.
        when = (pos === 0 ? h.pickup : h.drop) ?? null;
      }
      const kind: StopKind = handoff ? "handoff" : s.type === "pickup" ? "pickup" : s.type === "delivery" ? "delivery" : "stop";
      const place = s.facility_name || [s.city, s.state].filter(Boolean).join(", ") || "stop";
      return { id: s.id, kind, coord: coord(s.lat, s.lng), expected: wallClockToUtc(when, tz), label: `${kind} ${place}` };
    });
    return {
      id: e.id, loadId: e.load_id, loadNum: e.loads?.load_num ?? e.title ?? null,
      revenue: e.event_kind === "revenue",
      start, end, routeMiles: e.loaded_miles == null ? null : Number(e.loaded_miles), stops,
    };
  };

  const trucks: TruckInputs[] = assets.map((a) => ({
    assetId: a.id,
    name: a.name,
    hasGps: !!a.motive_vehicle_id,
    drives: moves
      .filter((m) => m.asset_id === a.id && m.end_time)
      .map((m) => ({
        id: m.id,
        start: Date.parse(m.start_time),
        end: Date.parse(m.end_time as string),
        miles: Number(m.miles ?? 0),
        from: coord(m.origin_lat, m.origin_lon),
        to: coord(m.destination_lat, m.destination_lon),
        odoStart: kmToMi(m.motive_driving_periods?.start_kilometers),
        odoEnd: kmToMi(m.motive_driving_periods?.end_kilometers),
      })),
    events: live.filter((e) => e.asset_id === a.id).map(toCalEvent).filter((e): e is CalEvent => e != null),
  })).filter((t) => t.drives.length || t.events.length);

  const homes: HomeBase[] = homesRows
    .map((h) => ({ id: h.id, name: h.name, coord: coord(h.lat, h.lng) }))
    .filter((h): h is HomeBase => h.coord != null);

  return { timeZone, terminal, homes, trucks };
}
