/**
 * Movement → load linking: the rules engine. Pure — no I/O, no clock.
 * Spec and the decisions behind it: docs/movement-linking.md.
 *
 * One truck at a time. The calendar is the source of truth for which truck
 * did what, so the engine never looks at other trucks: it lines up THIS
 * truck's GPS against THIS truck's calendar stops, in order, then labels
 * every drive by what the calendar says happens between the stops it falls
 * between. The whole window is one continuous sequence — loads run through
 * the night, so nothing is cut at midnight.
 */

import { airMilesBetween, isUsableCoord, type Coord } from "./airMiles.js";

export const LINK_RULES = {
  /** Stays this close together, joined only by short drives, are one visit. */
  stayMergeMi: 0.5,
  /** Longest drive that can sit inside a visit (dock moves, yard shuffles). */
  dockMoveMaxMi: 1,
  /** A visit this close to a saved location is a home visit. */
  homeRadiusMi: 0.75,
  /** A stop matches a visit with no distance penalty inside this radius… */
  geofenceMi: 1,
  /** …and never beyond this one. */
  geofenceMaxMi: 3,
  /** Calendar times are approximate: no penalty inside ± this many hours… */
  timeFreeH: 3,
  /** …and no match beyond this. */
  timeMaxH: 36,
  /** Visits shorter than this are a light or a fuel pump, not a dock. */
  shortVisitMin: 5,
  /** A stay this long away from stops and yards is rest. */
  restMinH: 2,
  /** GPS loaded miles ÷ route miles must land in this band (or within slack). */
  milesRatioLo: 0.8,
  milesRatioHi: 1.25,
  milesSlackMi: 15,
  /** Unexplained driving shorter than this is noise, not an exception. */
  unexplainedMinMi: 5,
  /** A drive that starts this far from where the last one ended means the
   *  ELD was off in between (a GPS gap), not that the truck sat still. */
  gapMi: 2,
  /** Appointment-booked entries overlapping by more than this are loads
   *  carried together (see sequenceStops). */
  concurrentOverlapH: 1,
};

export type LinkRules = typeof LINK_RULES;
type Rules = LinkRules;

const SKIP_COST = 10;
const HOUR = 3_600_000;

// ── Inputs ──────────────────────────────────────────────────────────────

export interface GpsDrive {
  id: string;
  /** UTC ms. */
  start: number;
  end: number;
  miles: number;
  from: Coord | null;
  to: Coord | null;
  /** Odometer at start / end, in miles, when Motive reports it. */
  odoStart?: number | null;
  odoEnd?: number | null;
}

export interface HomeBase {
  id: string;
  name: string;
  coord: Coord;
}

export type StopKind = "pickup" | "delivery" | "handoff" | "stop";

export interface CalStop {
  id: string;
  kind: StopKind;
  coord: Coord | null;
  /** UTC ms from the appointment / handoff time; null = interpolate. */
  expected: number | null;
  label: string;
}

export interface CalEvent {
  id: string;
  loadId: string | null;
  loadNum: string | null;
  revenue: boolean;
  /** UTC ms. */
  start: number;
  end: number;
  /** Routed loaded miles for this leg (events.loaded_miles). */
  routeMiles: number | null;
  /** This leg's own stops, in sequence (relay legs already sliced). */
  stops: CalStop[];
}

// ── Outputs ─────────────────────────────────────────────────────────────

export type LinkRole =
  | "loaded" | "deadhead" | "return" | "dwell" | "rest" | "idle"
  | "non_revenue" | "unexplained" | "uncertain" | "outside"
  /** Miles the odometer moved while GPS was off (no drive carries it). */
  | "gps_gap";

export interface Visit {
  idx: number;
  /** UTC ms; -Infinity / Infinity when the window edge cuts it. */
  arrive: number;
  depart: number;
  coord: Coord | null;
  home: HomeBase | null;
  /** Short drives that happened inside this visit. */
  insideDriveIds: string[];
  /** Set when the ELD was off: the truck reappeared somewhere else. Where
   *  it was in between is unknown; `missingMiles` comes from the odometer. */
  gap: { missingMiles: number | null } | null;
}

export interface DriveLink {
  driveId: string;
  role: LinkRole;
  /** The leg / entry the drive is charged to. */
  eventId: string | null;
  /** Every load aboard for a loaded drive (more than one = carried together;
   *  the miles are split evenly between them). */
  eventIds: string[];
  fromEventId: string | null;
  toEventId: string | null;
  stopId: string | null;
  miles: number;
  start: number;
  end: number;
  reason: string;
}

export interface VisitLink {
  visitIdx: number;
  role: LinkRole;
  eventId: string | null;
  stopIds: string[];
  hours: number;
}

/** Why a stop has no anchor:
 *  - stop_no_coords: the stop has no map pin;
 *  - stop_not_found: the truck never sat within the geofence of it in the time window;
 *  - stop_out_of_order: it did, but not in the order the calendar puts it in;
 *  - gps_gap: the calendar time falls while the truck's ELD was off. */
export type StopIssue = "stop_no_coords" | "stop_not_found" | "stop_out_of_order" | "gps_gap";

export interface StopAnchor {
  stopId: string;
  eventId: string;
  kind: StopKind;
  label: string;
  visitIdx: number | null;
  arrive: number | null;
  depart: number | null;
  distMi: number | null;
  /** Hours between the calendar time and the visit (0 when inside it). */
  offH: number | null;
  issue: StopIssue | null;
  /** For an unanchored stop: the truck's closest visit in the time window,
   *  so a reviewer can see how far off it was. */
  nearest: { distMi: number; offH: number; at: number } | null;
  /** The stop's pin and calendar time, for looking it up on other trucks. */
  coord: Coord | null;
  expected: number;
}

export type LegIssue = StopIssue | "miles_mismatch" | "detour" | "no_stops";

export interface LegActual {
  eventId: string;
  loadId: string | null;
  loadNum: string | null;
  revenue: boolean;
  routeMiles: number | null;
  stops: StopAnchor[];
  loadedMiles: number;
  loadedHours: number;
  deadheadMiles: number;
  deadheadHours: number;
  returnMiles: number;
  returnHours: number;
  dwellHours: number;
  restHours: number;
  confidence: "high" | "medium" | "low";
  issues: LegIssue[];
}

export interface TruckLinkResult {
  visits: Visit[];
  drives: DriveLink[];
  visitLinks: VisitLink[];
  legs: LegActual[];
  milesByRole: Record<LinkRole, number>;
}

// ── Step 1: visits ──────────────────────────────────────────────────────

const air = (a: Coord | null, b: Coord | null): number =>
  isUsableCoord(a) && isUsableCoord(b) ? airMilesBetween(a, b) : Infinity;

/**
 * Turns drives into the places the truck sat between them. A sub-mile drive
 * that ends near where the current visit sits is a dock move and folds into
 * it; every other drive closes one visit and opens the next. Returns the
 * visits and, for each pair of neighbours, the drive that joined them.
 */
export function buildVisits(drivesIn: GpsDrive[], homes: HomeBase[], rules: Rules = LINK_RULES): { visits: Visit[]; between: GpsDrive[] } {
  const drives = drivesIn.filter((d) => d.end >= d.start).sort((a, b) => a.start - b.start);
  if (drives.length === 0) return { visits: [], between: [] };
  const homeOf = (c: Coord | null) => {
    let best: HomeBase | null = null;
    let bestMi: number = rules.homeRadiusMi;
    for (const h of homes) {
      const mi = air(c, h.coord);
      if (mi <= bestMi) { best = h; bestMi = mi; }
    }
    return best;
  };

  const visits: Visit[] = [];
  const between: GpsDrive[] = [];
  let cur: Visit = {
    idx: 0, arrive: -Infinity, depart: drives[0].start,
    coord: drives[0].from ?? drives[0].to, home: null, insideDriveIds: [], gap: null,
  };
  for (let i = 0; i < drives.length; i++) {
    const d = drives[i];
    const next = drives[i + 1];
    const stayCoord = d.to ?? next?.from ?? null;
    const stayEnd = next ? next.start : Infinity;
    if (d.miles < rules.dockMoveMaxMi && air(cur.coord, stayCoord) <= rules.stayMergeMi) {
      cur.insideDriveIds.push(d.id);
      cur.depart = stayEnd;
      continue;
    }
    visits.push(cur);
    between.push(d);
    cur = { idx: visits.length, arrive: d.end, depart: stayEnd, coord: stayCoord, home: null, insideDriveIds: [], gap: null };
    if (next && air(d.to, next.from) > rules.gapMi) {
      const odo = next.odoStart != null && d.odoEnd != null ? next.odoStart - d.odoEnd : null;
      cur.gap = { missingMiles: odo != null && odo >= 0 ? odo : null };
    }
  }
  visits.push(cur);
  for (const v of visits) v.home = homeOf(v.coord);
  return { visits, between };
}

// ── Step 2: anchor the calendar stops ───────────────────────────────────

interface SeqStop extends CalStop {
  event: CalEvent;
  pos: number;
  first: boolean;
  last: boolean;
  t: number;
}

function timedEvents(events: CalEvent[]) {
  return [...events].sort((a, b) => a.start - b.start || a.end - b.end).map((e) => {
    const n = e.stops.length;
    let prevT = -Infinity;
    const stops = e.stops.map((s, pos) => {
      const span = Math.max(0, e.end - e.start);
      const interp = n <= 1 ? e.start : e.start + (span * pos) / (n - 1);
      const t = Math.max(prevT, s.expected ?? interp);
      prevT = t;
      return { ...s, event: e, pos, first: pos === 0, last: pos === n - 1, t };
    });
    const booked = stops.length > 0 && e.stops.every((s) => s.expected != null);
    return { e, stops, booked, lo: stops[0]?.t ?? e.start, hi: stops[stops.length - 1]?.t ?? e.end };
  });
}

/**
 * Entries that may be loads on the truck at the same time (several pickups
 * consolidated into one DHL delivery, say): an appointment on every stop,
 * and overlapping the entry before by more than `overlapH`. Only candidates
 * — calendar times are rough and long OTR entries routinely "overlap" the
 * next leg on paper, so linkTruck interleaves a group only when that finds
 * more stops on GPS than calendar order does.
 */
export function concurrentGroups(events: CalEvent[], overlapH: number): string[][] {
  const groups: ReturnType<typeof timedEvents>[] = [];
  for (const x of timedEvents(events)) {
    const g = groups[groups.length - 1];
    const gHi = g ? Math.max(...g.map((y) => y.hi)) : -Infinity;
    if (g && x.booked && g.every((y) => y.booked) && x.lo < gHi - overlapH * HOUR) g.push(x);
    else groups.push([x]);
  }
  return groups.filter((g) => g.length > 1).map((g) => g.map((x) => x.e.id));
}

/**
 * The truck's calendar stops in order: entries by start, each entry's own
 * stops by sequence. The entries of each group in `interleave` are merged
 * and ordered by appointment instead. A leg's own stops never reorder.
 */
export function sequenceStops(events: CalEvent[], interleave: string[][] = []): SeqStop[] {
  const groupOf = new Map<string, string[]>();
  for (const g of interleave) for (const id of g) groupOf.set(id, g);
  const timed = timedEvents(events);
  const byId = new Map(timed.map((x) => [x.e.id, x]));
  const done = new Set<string>();
  const out: SeqStop[] = [];
  for (const x of timed) {
    if (done.has(x.e.id)) continue;
    const g = (groupOf.get(x.e.id) ?? [x.e.id]).map((id) => byId.get(id)).filter((y): y is (typeof timed)[number] => !!y);
    g.forEach((y) => done.add(y.e.id));
    const order = new Map(g.map((y, i) => [y.e.id, i]));
    out.push(...g.flatMap((y) => y.stops).sort((a, b) =>
      g.length === 1 ? a.pos - b.pos : a.t - b.t || (order.get(a.event.id)! - order.get(b.event.id)!) || a.pos - b.pos));
  }
  return out;
}

function matchCost(s: SeqStop, v: Visit, rules: Rules): number {
  if (v.gap || !isUsableCoord(s.coord) || !isUsableCoord(v.coord)) return Infinity;
  const d = airMilesBetween(s.coord, v.coord);
  if (d > rules.geofenceMaxMi) return Infinity;
  const offH = Math.max(0, v.arrive - s.t, s.t - v.depart) / HOUR;
  if (offH > rules.timeMaxH) return Infinity;
  const durMin = (v.depart - v.arrive) / 60_000;
  return 0.2 * d + 3 * Math.max(0, d - rules.geofenceMi)
       + 0.05 * offH + 0.5 * Math.max(0, offH - rules.timeFreeH)
       + (durMin < rules.shortVisitMin ? 2 : 0);
}

/**
 * Ordered alignment of stops to visits (dynamic programming). Each stop is
 * matched to one visit or skipped; matched visits never go backwards, and
 * two stops may share a visit (same facility). Returns visit index per stop.
 */
export function alignStops(stops: SeqStop[], visits: Visit[], rules: Rules = LINK_RULES): (number | null)[] {
  const m = stops.length;
  const n = visits.length;
  const W = n + 1;
  const F = new Float64Array((m + 1) * W);
  const choice = new Uint8Array((m + 1) * W); // 0 = left, 1 = skip, 2 = match
  for (let j = 1; j <= m; j++) {
    F[j * W] = j * SKIP_COST;
    choice[j * W] = 1;
    const s = stops[j - 1];
    for (let i = 1; i <= n; i++) {
      let best = F[j * W + i - 1];
      let ch = 0;
      const skip = F[(j - 1) * W + i] + SKIP_COST;
      if (skip < best) { best = skip; ch = 1; }
      const c = matchCost(s, visits[i - 1], rules);
      if (c < Infinity) {
        const match = F[(j - 1) * W + i] + c;
        if (match < best) { best = match; ch = 2; }
      }
      F[j * W + i] = best;
      choice[j * W + i] = ch;
    }
  }
  const out: (number | null)[] = new Array(m).fill(null);
  let j = m;
  let i = n;
  while (j > 0) {
    const ch = i === 0 ? 1 : choice[j * W + i];
    if (ch === 0) i--;
    else if (ch === 1) j--;
    else { out[j - 1] = i - 1; j--; }
  }
  return out;
}

/**
 * For a stop its own truck never reached: the other trucks that sat within
 * the geofence around the calendar time. One hit usually means the load
 * changed trucks (a swap or relay) and the calendar wasn't updated — a flag
 * for a person, since the calendar also drives pay; never a correction.
 */
export function otherTrucksAt(
  stop: Pick<StopAnchor, "coord" | "expected">,
  fleet: Array<{ assetId: number; name: string; visits: Visit[] }>,
  ownAssetId: number,
  rules: Rules = LINK_RULES,
): Array<{ assetId: number; name: string; arrive: number; distMi: number; offH: number }> {
  if (!isUsableCoord(stop.coord)) return [];
  const out: Array<{ assetId: number; name: string; arrive: number; distMi: number; offH: number }> = [];
  for (const t of fleet) {
    if (t.assetId === ownAssetId) continue;
    let best: (typeof out)[number] | null = null;
    for (const v of t.visits) {
      const offH = Math.max(0, v.arrive - stop.expected, stop.expected - v.depart) / HOUR;
      if (offH > rules.timeFreeH) continue;
      const distMi = air(stop.coord, v.coord);
      if (distMi > rules.geofenceMi) continue;
      if (!best || offH < best.offH) best = { assetId: t.assetId, name: t.name, arrive: v.arrive, distMi, offH };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.offH - b.offH);
}

// ── Step 3: label ───────────────────────────────────────────────────────

const ROLES: LinkRole[] = ["loaded", "deadhead", "return", "dwell", "rest", "idle", "non_revenue", "unexplained", "uncertain", "outside", "gps_gap"];

export function linkTruck(input: {
  drives: GpsDrive[];
  events: CalEvent[];
  homes: HomeBase[];
  rules?: Rules;
}): TruckLinkResult {
  const rules = input.rules ?? LINK_RULES;
  const { visits, between } = buildVisits(input.drives, input.homes, rules);
  // Calendar order first; then, for each group of possibly-concurrent loads
  // with a stop that didn't match, try them interleaved and keep it only if
  // more stops match.
  const unmatched = (a: (number | null)[]) => a.reduce<number>((n, v) => n + (v == null ? 1 : 0), 0);
  const kept: string[][] = [];
  let stops = sequenceStops(input.events);
  let at = alignStops(stops, visits, rules);
  for (const g of concurrentGroups(input.events, rules.concurrentOverlapH)) {
    if (!stops.some((s, j) => at[j] == null && g.includes(s.event.id))) continue;
    const trialStops = sequenceStops(input.events, [...kept, g]);
    const trialAt = alignStops(trialStops, visits, rules);
    if (unmatched(trialAt) < unmatched(at)) { kept.push(g); stops = trialStops; at = trialAt; }
  }

  // Anchored stops, in order. Non-revenue stops that didn't match don't
  // block anything — those entries are linked by time instead (below).
  const anchored = stops.map((s, j) => ({ s, j, v: at[j] })).filter((a) => a.v != null) as Array<{ s: SeqStop; j: number; v: number }>;
  const blocking = (j: number) => at[j] == null && stops[j].event.revenue;

  /** Last anchor at or before visit v, and first anchor at or after visit w. */
  const prevAnchor = (v: number) => {
    let r: (typeof anchored)[number] | null = null;
    for (const a of anchored) { if (a.v <= v) r = a; else break; }
    return r;
  };
  const nextAnchor = (w: number) => anchored.find((a) => a.v >= w) ?? null;
  const unanchoredBetween = (j0: number, j1: number) => {
    for (let j = j0 + 1; j < j1; j++) if (blocking(j)) return true;
    return false;
  };

  const drives: DriveLink[] = [];
  const mk = (d: GpsDrive, role: LinkRole, ref: Partial<DriveLink>, reason: string): DriveLink => ({
    driveId: d.id, role, eventId: null, eventIds: [], fromEventId: null, toEventId: null, stopId: null,
    miles: d.miles, start: d.start, end: d.end, reason, ...ref,
  });

  // What's on the truck after stop j: every entry whose first stop is at or
  // before j and whose last stop is after it. Several at once = loads
  // carried together; their shared miles are split between them.
  const span = new Map<string, { first: number; last: number }>();
  stops.forEach((s, j) => {
    const r = span.get(s.event.id);
    span.set(s.event.id, r ? { first: r.first, last: j } : { first: j, last: j });
  });
  const onBoardAfter = (j: number) => input.events.filter((e) => {
    const r = span.get(e.id);
    return r != null && r.first <= j && j < r.last;
  });

  const visitHours = (v: Visit) => (Number.isFinite(v.arrive) && Number.isFinite(v.depart) ? (v.depart - v.arrive) / HOUR : 0);

  // Role of the span a drive between visit k and k+1 falls in.
  const spanRole = (k: number) => {
    const pa = prevAnchor(k);
    const na = nextAnchor(k + 1);
    const homesIn = (lo: number, hi: number) => visits.slice(lo, hi + 1).filter((v) => v.home).map((v) => v.idx);
    if (pa && na) {
      if (unanchoredBetween(pa.j, na.j)) {
        return { role: "uncertain" as LinkRole, ref: { fromEventId: pa.s.event.id, toEventId: na.s.event.id }, why: "a calendar stop between these anchors wasn't found on GPS" };
      }
      const aboard = onBoardAfter(pa.j);
      if (aboard.length) {
        const ids = aboard.map((e) => e.id);
        const role: LinkRole = aboard.some((e) => e.revenue) ? "loaded" : "non_revenue";
        return { role, ref: { eventId: ids[0], eventIds: ids }, why: `${pa.s.label} → ${na.s.label}${ids.length > 1 ? ` (${ids.length} loads aboard)` : ""}` };
      }
      // Nothing aboard: between two calendar entries. The truck's longest
      // stop at a yard or home parking spot splits it — driving there is
      // the return of the earlier leg, driving out is the deadhead to the
      // next (a quick yard stop on the way, for a trailer, doesn't split).
      const yards = homesIn(pa.v + 1, na.v - 1);
      if (yards.length === 0) {
        return { role: "deadhead" as LinkRole, ref: { eventId: na.s.event.id, fromEventId: pa.s.event.id, toEventId: na.s.event.id }, why: `to ${na.s.label}` };
      }
      const park = yards.reduce((best, i) => (visitHours(visits[i]) > visitHours(visits[best]) ? i : best), yards[0]);
      if (k < park) {
        return { role: "return" as LinkRole, ref: { eventId: pa.s.event.id, fromEventId: pa.s.event.id }, why: `after ${pa.s.label}, back to ${visits[park].home?.name ?? "yard"}` };
      }
      return { role: "deadhead" as LinkRole, ref: { eventId: na.s.event.id, fromEventId: pa.s.event.id, toEventId: na.s.event.id }, why: `from ${visits[park].home?.name ?? "yard"} to ${na.s.label}` };
    }
    if (na) {
      // Before the first anchor in the window.
      if (unanchoredBetween(-1, na.j) && stops.slice(0, na.j).some((s, j) => blocking(j) && s.t >= (visits[k].depart - rules.timeMaxH * HOUR))) {
        return { role: "uncertain" as LinkRole, ref: { toEventId: na.s.event.id }, why: "an earlier calendar stop wasn't found on GPS" };
      }
      const yards = homesIn(0, na.v - 1);
      if (yards.length && k >= yards[yards.length - 1] && na.s.first) {
        return { role: "deadhead" as LinkRole, ref: { eventId: na.s.event.id, toEventId: na.s.event.id }, why: `to ${na.s.label}` };
      }
      return { role: "outside" as LinkRole, ref: {}, why: "before the window's first anchor" };
    }
    if (pa) {
      // After the last anchor in the window.
      if (onBoardAfter(pa.j).some((e) => e.revenue)) {
        return { role: "uncertain" as LinkRole, ref: { fromEventId: pa.s.event.id }, why: "the rest of this leg wasn't found on GPS" };
      }
      const yards = homesIn(pa.v + 1, visits.length - 1);
      if (yards.length && k < yards[0]) {
        return { role: "return" as LinkRole, ref: { eventId: pa.s.event.id, fromEventId: pa.s.event.id }, why: `after ${pa.s.label}, back to ${visits[yards[0]].home?.name ?? "yard"}` };
      }
      return { role: "outside" as LinkRole, ref: {}, why: "after the window's last anchor" };
    }
    return { role: "outside" as LinkRole, ref: {}, why: "no calendar stop matched in the window" };
  };

  const spanOfVisit = new Map<number, ReturnType<typeof spanRole>>();
  between.forEach((d, k) => {
    const sr = spanRole(k);
    spanOfVisit.set(k, sr);
    drives.push(mk(d, sr.role, sr.ref, sr.why));
  });

  // Non-revenue entries without a matched stop: link the otherwise
  // unaccounted drives that happen during them.
  const nonRev = input.events.filter((e) => !e.revenue);
  for (const dl of drives) {
    if (!["unexplained", "outside", "deadhead", "return"].includes(dl.role)) continue;
    const e = nonRev.find((x) => dl.start < x.end + HOUR && dl.end > x.start - HOUR
      && !anchored.some((a) => a.s.event.id === x.id));
    if (e) Object.assign(dl, { role: "non_revenue", eventId: e.id, eventIds: [e.id], fromEventId: null, toEventId: null, reason: "during a non-revenue calendar entry" });
  }
  for (const dl of drives) {
    if (dl.role === "outside" && dl.miles >= rules.unexplainedMinMi
      && !input.events.some((e) => dl.start < e.end + rules.timeFreeH * HOUR && dl.end > e.start - rules.timeFreeH * HOUR)) {
      Object.assign(dl, { role: "unexplained", reason: "driving with nothing on the calendar" });
    }
  }

  // Visits: dwell at anchored stops, idle at yards, rest on the road.
  const hostOf = new Map<number, SeqStop[]>();
  anchored.forEach((a) => hostOf.set(a.v, [...(hostOf.get(a.v) ?? []), a.s]));
  const visitLinks: VisitLink[] = visits.map((v) => {
    const hours = Number.isFinite(v.arrive) && Number.isFinite(v.depart) ? (v.depart - v.arrive) / HOUR : 0;
    if (v.gap) return { visitIdx: v.idx, role: "gps_gap", eventId: null, stopIds: [], hours };
    const hosted = hostOf.get(v.idx);
    if (hosted?.length) return { visitIdx: v.idx, role: "dwell", eventId: hosted[0].event.id, stopIds: hosted.map((s) => s.id), hours };
    const inbound = v.idx > 0 ? spanOfVisit.get(v.idx - 1) : undefined;
    if (v.home && inbound?.role !== "loaded") return { visitIdx: v.idx, role: "idle", eventId: null, stopIds: [], hours };
    if (hours >= rules.restMinH && inbound && ["loaded", "deadhead", "return", "non_revenue"].includes(inbound.role)) {
      return { visitIdx: v.idx, role: "rest", eventId: inbound.ref.eventId ?? null, stopIds: [], hours };
    }
    return { visitIdx: v.idx, role: inbound?.role ?? "outside", eventId: inbound?.ref.eventId ?? null, stopIds: [], hours };
  });
  const driveById = new Map(input.drives.map((d) => [d.id, d]));
  for (const v of visits) {
    const vl = visitLinks[v.idx];
    for (const id of v.insideDriveIds) {
      const d = driveById.get(id);
      if (!d) continue;
      drives.push(mk(d, vl.role, { eventId: vl.eventId, stopId: vl.stopIds[0] ?? null }, "short move inside a stop"));
    }
  }

  // Per-leg actuals.
  const legs: LegActual[] = input.events.map((e) => {
    const legStops = stops.filter((s) => s.event.id === e.id);
    const offOf = (s: SeqStop, v: Visit) => Math.max(0, v.arrive - s.t, s.t - v.depart) / HOUR;
    const anchors: StopAnchor[] = legStops.map((s) => {
      const j = stops.indexOf(s);
      const vi = at[j];
      const v = vi == null ? null : visits[vi];
      let nearest: StopAnchor["nearest"] = null;
      let issue: StopIssue | null = null;
      if (!v) {
        if (!isUsableCoord(s.coord)) issue = "stop_no_coords";
        else {
          // Closest in time among visits inside the geofence; failing that,
          // closest in distance.
          let inside: StopAnchor["nearest"] = null;
          for (const c of visits) {
            const off = offOf(s, c);
            if (off > rules.timeMaxH) continue;
            const mi = air(s.coord, c.coord);
            const cand = { distMi: mi, offH: off, at: Number.isFinite(c.arrive) ? c.arrive : c.depart };
            if (mi <= rules.geofenceMaxMi && (!inside || off < inside.offH)) inside = cand;
            if (!nearest || mi < nearest.distMi) nearest = cand;
          }
          if (inside) nearest = inside;
          const inGap = visits.some((g) => g.gap && s.t >= g.arrive - rules.timeFreeH * HOUR && s.t <= g.depart + rules.timeFreeH * HOUR);
          issue = inGap ? "gps_gap" : inside ? "stop_out_of_order" : "stop_not_found";
        }
      }
      return {
        stopId: s.id, eventId: e.id, kind: s.kind, label: s.label,
        visitIdx: vi,
        arrive: v && Number.isFinite(v.arrive) ? v.arrive : null,
        depart: v && Number.isFinite(v.depart) ? v.depart : null,
        distMi: v ? air(s.coord, v.coord) : null,
        offH: v ? offOf(s, v) : null,
        issue,
        nearest,
        coord: s.coord,
        expected: s.t,
      };
    });
    // Miles from the drives; hours from the drives plus the short stops
    // along the way (fuel, lights) that carry the same role. Miles shared
    // with other loads aboard are split evenly; `whole` keeps the unsplit
    // total for the route-miles check.
    const sum = (role: LinkRole, pick: (d: DriveLink) => boolean) => {
      const ds = drives.filter((d) => d.role === role && pick(d));
      const share = (d: DriveLink) => 1 / Math.max(1, d.eventIds.length);
      const stopHours = visitLinks.filter((v) => v.role === role && v.eventId === e.id).reduce((a, v) => a + v.hours, 0);
      return {
        miles: ds.reduce((a, d) => a + d.miles * share(d), 0),
        whole: ds.reduce((a, d) => a + d.miles, 0),
        hours: ds.reduce((a, d) => a + ((d.end - d.start) / HOUR) * share(d), 0) + stopHours,
        drives: ds,
      };
    };
    const aboard = (d: DriveLink) => d.eventId === e.id || d.eventIds.includes(e.id);
    const loaded = sum(e.revenue ? "loaded" : "non_revenue", aboard);
    const dh = sum("deadhead", (d) => d.toEventId === e.id);
    const ret = sum("return", (d) => d.fromEventId === e.id);
    // Empty driving much longer than the straight shot means a stop the
    // calendar doesn't show (an errand, a home stop): flag it rather than
    // quietly charging it to the load.
    const detour = (x: ReturnType<typeof sum>) => {
      if (!x.drives.length) return false;
      const ordered = [...x.drives].sort((a, b) => a.start - b.start);
      const from = driveById.get(ordered[0].driveId)?.from ?? null;
      const to = driveById.get(ordered[ordered.length - 1].driveId)?.to ?? null;
      const direct = air(from, to) * 1.2;
      return Number.isFinite(direct) && x.whole > 1.5 * direct + 20;
    };
    const dwellHours = visitLinks.filter((v) => v.role === "dwell" && legStops.some((s) => v.stopIds.includes(s.id)))
      .reduce((a, v) => a + v.hours / Math.max(1, v.stopIds.length), 0);
    const restHours = visitLinks.filter((v) => v.role === "rest" && v.eventId === e.id).reduce((a, v) => a + v.hours, 0);

    const issues: LegIssue[] = [];
    // A load always has stops; one without them didn't save right.
    if (e.revenue && e.stops.length === 0) issues.push("no_stops");
    for (const a of anchors) if (a.issue && !issues.includes(a.issue)) issues.push(a.issue);
    const allAnchored = anchors.length > 0 && anchors.every((a) => a.visitIdx != null);
    let milesOk = true;
    if (allAnchored && e.revenue && e.routeMiles && e.routeMiles > 0 && anchors.length >= 2) {
      const ratio = loaded.whole / e.routeMiles;
      milesOk = (ratio >= rules.milesRatioLo && ratio <= rules.milesRatioHi) || Math.abs(loaded.whole - e.routeMiles) <= rules.milesSlackMi;
      if (!milesOk) issues.push("miles_mismatch");
    }
    if (detour(dh) || detour(ret)) issues.push("detour");
    const tight = anchors.every((a) => (a.distMi ?? Infinity) <= rules.geofenceMi && (a.offH ?? Infinity) <= rules.timeFreeH);
    const confidence: LegActual["confidence"] =
      !allAnchored ? "low" : tight && milesOk && !issues.includes("detour") ? "high" : "medium";
    return {
      eventId: e.id, loadId: e.loadId, loadNum: e.loadNum, revenue: e.revenue, routeMiles: e.routeMiles,
      stops: anchors,
      loadedMiles: loaded.miles, loadedHours: loaded.hours,
      deadheadMiles: dh.miles, deadheadHours: dh.hours,
      returnMiles: ret.miles, returnHours: ret.hours,
      dwellHours, restHours, confidence, issues,
    };
  });

  const milesByRole = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<LinkRole, number>;
  for (const d of drives) milesByRole[d.role] += d.miles;
  for (const v of visits) milesByRole.gps_gap += v.gap?.missingMiles ?? 0;
  return { visits, drives, visitLinks, legs, milesByRole };
}
