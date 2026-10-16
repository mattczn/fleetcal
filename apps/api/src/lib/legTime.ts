/**
 * When a truck was actually working a calendar leg — shared by the truck
 * profit grid (lib/truckProfit.ts) and the dashboard's "earned" revenue
 * (lib/weeklyTarget.ts), so both spread a load over the same hours.
 *
 * The leg's time is its linked-GPS window (leg_actuals: leaving for the
 * deadhead through the drive home) when there is one, else the calendar
 * entry, with two trims:
 *   - a local truck parked away before its first stop or after its last
 *     (left Friday, sat by the shipper all weekend) only counts the drive
 *     out, the stops and the drive home; OTR keeps its nights out
 *   - a relay trailer parked at a handoff (dropped at the yard, taken days
 *     later) isn't either leg's time: the leg ending there ends at the
 *     drop, the one starting there starts at the pickup
 *
 * Calendar entries are naive org wall-clock and GPS is UTC; everything
 * here runs on "wall ms" (the wall-clock time read as if it were UTC), so
 * days and 6-hour blocks are plain multiples.
 */

import type { HaulClass, LinkConfidence } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

export const H = 3_600_000;
export const DAY = 24 * H;
const BLOCK_MS = 6 * H;
const MAX_LEG_MS = 14 * DAY;
/** Longer than this at a handoff = the trailer was parked, not a relay meet. */
const PARKED_HANDOFF_HOURS = 6;
/** Time allowed to drop or hook a trailer at a parked handoff. */
const HANDOFF_HOURS = 0.5;
const CHUNK = 150;

export const naiveMs = (s: string) => Date.parse(`${s.slice(0, 16)}:00Z`);
export const wallStr = (ms: number) => new Date(ms).toISOString().slice(0, 16);
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => dayOf(Date.parse(`${d}T00:00:00Z`) + n * DAY);
/** Wall ms at the start of a YYYY-MM-DD day. */
export const dayStartMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

const formatters = new Map<string, Intl.DateTimeFormat>();
export function utcToWallMs(iso: string, tz: string): number {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(iso))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
}

export interface Slice { date: string; block: number; hours: number }
/** The (day, 6-hour block) pieces of a wall-clock interval. */
export function slicesOf(a: number, b: number): Slice[] {
  const out: Slice[] = [];
  for (let t = a; t < b;) {
    const start = Math.floor(t / BLOCK_MS) * BLOCK_MS;
    const next = Math.min(b, start + BLOCK_MS);
    out.push({ date: dayOf(start), block: new Date(start).getUTCHours() / 6, hours: (next - t) / H });
    t = next;
  }
  return out;
}

/** Hours of [a, b) that fall inside [from, to) (all wall ms). */
export const hoursWithin = (a: number, b: number, from: number, to: number) =>
  Math.max(0, Math.min(b, to) - Math.max(a, from)) / H;

export interface LegActualRow {
  event_id: string;
  truck_start: string | null;
  truck_end: string | null;
  route_miles: number | null;
  loaded_miles: number | null;
  deadhead_miles: number | null;
  return_miles: number | null;
  deadhead_hours: number | null;
  return_hours: number | null;
  confidence: LinkConfidence;
  stops: Array<{ kind?: string; arrive?: string | null; depart?: string | null }> | null;
}

/** leg_actuals rows by event id. */
export async function fetchLegActuals(eventIds: string[]): Promise<Map<string, LegActualRow>> {
  const out = new Map<string, LegActualRow>();
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("leg_actuals")
      .select("event_id, truck_start, truck_end, route_miles, loaded_miles, deadhead_miles, return_miles, deadhead_hours, return_hours, confidence, stops")
      .in("event_id", eventIds.slice(i, i + CHUNK));
    if (error) throw new Error(`leg actuals: ${error.message}`);
    for (const r of (data ?? []) as LegActualRow[]) out.set(r.event_id, r);
  }
  return out;
}

/** The wall-clock window the truck spent on a leg. */
export function legWindow(opts: {
  calStart: string; calEnd: string | null; actual: LegActualRow | null | undefined; cls: HaulClass; tz: string;
}): { a: number; b: number; fromGps: boolean } {
  const { calStart, calEnd, actual: la, cls, tz } = opts;
  const gps = !!(la?.truck_start && la?.truck_end);
  let a = gps ? utcToWallMs(la!.truck_start!, tz) : naiveMs(calStart);
  let b = gps ? utcToWallMs(la!.truck_end!, tz) : calEnd ? naiveMs(calEnd) : a + H;

  const stops = la?.stops ?? [];
  const first = stops[0];
  const last = stops.length ? stops[stops.length - 1] : undefined;
  const trimStart = (cut: number) => { if (cut > a && cut < b) a = cut; };
  const trimEnd = (cut: number) => { if (cut > a && cut < b) b = cut; };

  if (gps && cls === "local") {
    if (first?.arrive) trimStart(utcToWallMs(first.arrive, tz) - Number(la!.deadhead_hours ?? 0) * H);
    if (last?.depart) trimEnd(utcToWallMs(last.depart, tz) + Number(la!.return_hours ?? 0) * H);
  }
  const dwellH = (st?: { arrive?: string | null; depart?: string | null }) =>
    st?.arrive && st?.depart ? (Date.parse(st.depart) - Date.parse(st.arrive)) / H : 0;
  if (gps && last?.kind === "handoff" && last.arrive && dwellH(last) > PARKED_HANDOFF_HOURS) {
    trimEnd(utcToWallMs(last.arrive, tz) + HANDOFF_HOURS * H + Number(la!.return_hours ?? 0) * H);
  }
  if (gps && first?.kind === "handoff" && first.depart && dwellH(first) > PARKED_HANDOFF_HOURS) {
    trimStart(utcToWallMs(first.depart, tz) - HANDOFF_HOURS * H);
  }

  if (!(b > a)) b = a + H;
  if (b - a > MAX_LEG_MS) b = a + MAX_LEG_MS;
  return { a, b, fromGps: gps };
}

/** Each counted leg's share of its load — by the truck time it took
 *  (relay pay is often all entered on one leg, and miles undersell a short
 *  pickup leg). Shares sum to 1. */
export function timeShares(windows: Array<{ a: number; b: number }>): number[] {
  const hours = windows.map((w) => Math.max(0, w.b - w.a));
  const total = hours.reduce((x, y) => x + y, 0);
  return windows.map((_, i) => (total > 0 ? hours[i] / total : 1 / windows.length));
}
