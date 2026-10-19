/**
 * Route pay — what a leg should pay the driver, from what payroll has paid
 * on the same route.
 *
 *   Places   every stop location, grouped so one dock is one place (stops
 *            within its radius); yards and relay points are the saved
 *            locations. Stored in route_places so ids stay put.
 *   Route    a leg's ordered places — e.g. LV relay point > SLC Yard — plus
 *            its kind (pickup only, yard to yard, delivery only, …).
 *   History  settled payroll only: weeks whose week_start is 14+ days back
 *            (payroll is finalized the Friday after a week ends, so anything
 *            newer can still change). Per route: the usual amount (most
 *            common of the last 20 paid legs), how often it's exactly that,
 *            the range, and the most recent paid legs as references.
 *   Suggest  a standard set on the route, else the route's usual (3+ paid
 *            legs), else the same area-to-area usual, else the rule for the
 *            leg's kind (flat for local legs, base + per mile for long ones,
 *            both measured from history). Always says which it used.
 */

import type {
  PayRoute, PayRouteExample, PayRoutesResponse, PaySuggestion, PaySuggestRequest, RateCardConfig, RouteLegKind, RoutePlace, Stop,
} from "@fleetcal/types";
import { isHandoffStop, stopsForLeg } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { airMilesBetween } from "./airMiles.js";
import { getHosConfig } from "./hosService.js";
import { buildRateCard, readRateConfig, trainingPay, type RateCard, type RatePlace, type RateRoute } from "./rateCard.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const PLACE_RADIUS_MI = 0.35;
/** Yards / relay points take handoff stops this far out (big lots, loose
 *  pins); any other stop only when it's practically on the yard — a
 *  shipper half a mile from a yard is its own place. */
const YARD_RADIUS_MI = 1;
const YARD_ANY_STOP_MI = 0.15;
const ROAD_FACTOR = 1.2;
/** Legs at least this long are line hauls; shorter ones are local. */
const LONG_LEG_MI = 60;
/** Payroll weeks newer than this (by week_start) aren't settled yet. */
const SETTLED_AFTER_DAYS = 14;
const USUAL_WINDOW = 20;
const MIN_LEGS = 3;
const EXAMPLES = 10;
const CACHE_MS = 30 * 60_000;
const CHUNK = 150;

/** Relay legs: pickup, delivery, pickup + line haul, line haul + delivery,
 *  transfer (yard to yard); a load one driver runs start to finish is a
 *  whole load. */
export const KIND_LABEL: Record<RouteLegKind, string> = {
  pickup: "Pickup",
  delivery: "Delivery",
  pickup_linehaul: "Pickup + line haul",
  linehaul_delivery: "Line haul + delivery",
  transfer: "Transfer (yard to yard)",
  whole_local: "Whole load (local)",
  whole_long: "Whole load (long)",
};
/** Kinds paid by distance (base + per mile); the rest pay flat. */
const BY_MILE: RouteLegKind[] = ["pickup_linehaul", "linehaul_delivery", "transfer", "whole_long"];

export class RoutePayUnavailableError extends Error {}

// ── Places ──────────────────────────────────────────────────────────────

interface PlaceRow {
  id: number; name: string; lat: number; lng: number; radius_mi: number | string;
  saved_location_id: string | null; city: string | null; state: string | null; named_by_user: boolean;
}
interface StopLike {
  id?: string; lat?: number | null; lng?: number | null; type: string; isHandoff?: boolean;
  city?: string | null; state?: string | null; facilityName?: string | null;
}

const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  airMilesBetween({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng });

/** The nearest place a stop belongs to (see YARD_RADIUS_MI), or null. */
function matchPlace(places: PlaceRow[], s: StopLike): PlaceRow | null {
  if (s.lat == null || s.lng == null) return null;
  const pt = { lat: Number(s.lat), lng: Number(s.lng) };
  const handoff = isHandoffStop({ type: s.type as Stop["type"], isHandoff: s.isHandoff });
  let best: PlaceRow | null = null; let bestD = Infinity;
  for (const p of places) {
    const d = dist(pt, p);
    const reach = p.saved_location_id ? (handoff ? Number(p.radius_mi) : YARD_ANY_STOP_MI) : Number(p.radius_mi);
    if (d <= reach && d < bestD) { best = p; bestD = d; }
  }
  return best;
}

/** Serialize place creation per org so two requests don't make the same place twice. */
const placeLocks = new Map<string, Promise<unknown>>();
function withPlaceLock<T>(orgId: string, run: () => Promise<T>): Promise<T> {
  const prev = placeLocks.get(orgId) ?? Promise.resolve();
  const next = prev.then(run, run);
  placeLocks.set(orgId, next.catch(() => undefined));
  return next;
}

/**
 * The place for each stop (null without coordinates), creating places for
 * stops that aren't near one yet. Yards come from saved_locations.
 */
async function placesFor(orgId: string, stops: StopLike[]): Promise<{ placeOf: (s: StopLike) => PlaceRow | null; places: PlaceRow[] }> {
  return withPlaceLock(orgId, async () => {
    const [existing, saved] = await Promise.all([
      fetchAllRows<PlaceRow>("route places", () => supabase.from("route_places").select("*").eq("org_id", orgId)).catch((e: Error) => {
        throw new RoutePayUnavailableError(`route_places unavailable — has 20261017_route_pay.sql been run? (${e.message})`);
      }),
      fetchAllRows<{ id: string; name: string; lat: number | null; lng: number | null }>("saved locations", () =>
        supabase.from("saved_locations").select("id, name, lat, lng").eq("org_id", orgId)),
    ]);
    const places = [...existing];
    const fresh: Array<Omit<PlaceRow, "id"> & { tmp: number }> = [];

    // Pin every yard / relay point.
    for (const s of saved) {
      if (s.lat == null || s.lng == null || places.some((p) => p.saved_location_id === s.id)) continue;
      fresh.push({ tmp: -fresh.length - 1, name: s.name, lat: Number(s.lat), lng: Number(s.lng), radius_mi: YARD_RADIUS_MI, saved_location_id: s.id, city: null, state: null, named_by_user: false });
    }
    const all = () => [...places, ...fresh.map((f) => ({ ...f, id: f.tmp }))];
    const nearest = (s: StopLike) => matchPlace(all(), s);
    // Stable order so the same history always makes the same places.
    const withCoords = stops.filter((s) => s.lat != null && s.lng != null)
      .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    for (const s of withCoords) {
      const pt = { lat: Number(s.lat), lng: Number(s.lng) };
      if (nearest(s)) continue;
      fresh.push({
        tmp: -fresh.length - 1,
        name: s.facilityName?.trim() || [s.city, s.state].filter(Boolean).join(", ") || `${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}`,
        lat: pt.lat, lng: pt.lng, radius_mi: PLACE_RADIUS_MI, saved_location_id: null,
        city: s.city ?? null, state: s.state ?? null, named_by_user: false,
      });
    }

    if (fresh.length) {
      const { data, error } = await supabase.from("route_places")
        .insert(fresh.map(({ tmp: _tmp, ...f }) => ({ ...f, org_id: orgId })))
        .select("*");
      if (error) throw new RoutePayUnavailableError(`route_places insert failed: ${error.message}`);
      places.push(...(data as PlaceRow[]));
    }
    const placeOf = (s: StopLike) => matchPlace(places, s);
    return { placeOf, places };
  });
}

// ── Legs → routes ───────────────────────────────────────────────────────

interface LegRoute {
  key: string;
  placeIds: number[];
  areaKey: string;
  kind: RouteLegKind;
  miles: number;
  label: string;
  /** First stop's city, ST → last stop's city, ST. */
  cities: string;
}

const cityOf = (s: StopLike | undefined, p: PlaceRow | undefined) => {
  const city = s?.city?.trim() || p?.city;
  const state = s?.state?.trim() || p?.state;
  if (city) return [titleCase(city), state?.toUpperCase()].filter(Boolean).join(", ");
  return p?.name ?? "?";
};
const titleCase = (t: string) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const areaOf = (p: PlaceRow) => (p.saved_location_id ? `place:${p.id}` : [p.city, p.state].filter(Boolean).join(", ") || `place:${p.id}`);

/** The route a leg runs: its slice of the load's stops, as places. */
function legRoute(allStops: StopLike[], legIndex: number, placeOf: (s: StopLike) => PlaceRow | null): LegRoute | null {
  const slice = stopsForLeg(
    allStops.map((s) => ({ ...s, type: s.type as Stop["type"] })),
    legIndex,
  ) as StopLike[];
  if (slice.length < 2) return null;
  const places = slice.map(placeOf);
  if (places.some((p) => p == null)) return null;
  const ps = places as PlaceRow[];
  const ids: number[] = [];
  for (const p of ps) if (ids[ids.length - 1] !== p.id) ids.push(p.id);
  let miles = 0;
  for (let i = 1; i < slice.length; i++) miles += dist({ lat: Number(slice[i - 1].lat), lng: Number(slice[i - 1].lng) }, { lat: Number(slice[i].lat), lng: Number(slice[i].lng) });
  miles *= ROAD_FACTOR;
  const first = slice[0];
  const last = slice[slice.length - 1];
  const startsAtHandoff = isHandoffStop({ type: first.type as Stop["type"], isHandoff: first.isHandoff });
  const endsAtHandoff = isHandoffStop({ type: last.type as Stop["type"], isHandoff: last.isHandoff });
  const long = miles >= LONG_LEG_MI;
  const kind: RouteLegKind = startsAtHandoff
    ? endsAtHandoff ? "transfer" : (long ? "linehaul_delivery" : "delivery")
    : endsAtHandoff ? (long ? "pickup_linehaul" : "pickup") : (long ? "whole_long" : "whole_local");
  const areas: string[] = [];
  for (const p of ps) { const a = areaOf(p); if (areas[areas.length - 1] !== a) areas.push(a); }
  const byId = new Map(ps.map((p) => [p.id, p]));
  return {
    key: ids.join(">"),
    placeIds: ids,
    areaKey: `${kind}|${areas.join(">")}`,
    kind,
    miles: Math.round(miles),
    label: ids.map((id) => byId.get(id)!.name).join(" → "),
    cities: `${cityOf(first, ps[0])} → ${cityOf(last, ps[ps.length - 1])}`,
  };
}

// ── Paid history ────────────────────────────────────────────────────────

interface PaidLeg extends PayRouteExample { route: LegRoute; customer: string | null }
interface Stats {
  legs: number; usual: number | null; usualShare: number | null; min: number; max: number; lastPaid: string | null;
  examples: PayRouteExample[]; customers: string[];
  /** Recent paid amounts (last 20 legs), most common first. */
  amounts: Array<{ amount: number; count: number }>;
}
interface History {
  settledThrough: string | null;
  paid: PaidLeg[];
  byRoute: Map<string, PaidLeg[]>;
  byArea: Map<string, PaidLeg[]>;
  kindRules: Record<RouteLegKind, { base: number; perMile: number; legs: number }>;
  places: PlaceRow[];
  placeOf: (s: StopLike) => PlaceRow | null;
}
const historyCache = new Map<string, { at: number; value: Promise<History> }>();

const dayIso = (t: number) => new Date(t).toISOString().slice(0, 10);

function statsOf(legs: PaidLeg[]): Stats {
  const recent = [...legs].sort((a, b) => b.date.localeCompare(a.date));
  const window = recent.slice(0, USUAL_WINDOW).map((l) => Math.round(l.amount));
  const counts = new Map<number, number>();
  for (const a of window) counts.set(a, (counts.get(a) ?? 0) + 1);
  // Most common; ties go to the most recently paid amount.
  let usual: number | null = null; let best = 0;
  for (const a of window) { const c = counts.get(a)!; if (c > best) { usual = a; best = c; } }
  const amounts = legs.map((l) => l.amount);
  const recentAmounts = [...counts.entries()].map(([amount, count]) => ({ amount, count })).sort((a, b) => b.count - a.count || b.amount - a.amount);
  return {
    amounts: recentAmounts,
    legs: legs.length,
    usual,
    usualShare: window.length ? best / window.length : null,
    min: amounts.length ? Math.min(...amounts) : 0,
    max: amounts.length ? Math.max(...amounts) : 0,
    lastPaid: recent[0]?.date ?? null,
    examples: recent.slice(0, EXAMPLES).map(({ route: _r, customer: _c, ...e }) => e),
    customers: [...new Set(recent.map((l) => l.customer).filter((c): c is string => !!c))].slice(0, 5),
  };
}

async function buildHistory(orgId: string): Promise<History> {
  const { timeZone } = await getHosConfig(orgId);
  const today = new Date().toLocaleDateString("en-CA", { timeZone });
  const cutoff = dayIso(Date.parse(`${today}T00:00:00Z`) - SETTLED_AFTER_DAYS * 86_400_000);

  const records = await fetchAllRows<{ id: string; driver_name: string; week_start: string; line_items: unknown }>("route pay payroll", () =>
    supabase.from("payroll_records").select("id, driver_name, week_start, line_items")
      .eq("org_id", orgId).is("superseded_at", null).lte("week_start", cutoff));
  type Line = { kind?: string; eventId?: string; loadId?: string; loadNum?: string; amount?: number; date?: string; label?: string };
  const byEvent = new Map<string, { amount: number; drivers: string[]; loadId: string | null; loadNum: string | null; date: string; weekStart: string; label: string | null }>();
  let settledThrough: string | null = null;
  for (const r of records) {
    if (!settledThrough || r.week_start > settledThrough) settledThrough = r.week_start;
    for (const li of (Array.isArray(r.line_items) ? r.line_items : []) as Line[]) {
      if (li.kind !== "load" || !li.eventId || !li.loadId || !(Number(li.amount) > 0)) continue;
      const cur = byEvent.get(li.eventId);
      if (cur) { cur.amount += Number(li.amount); cur.drivers.push(r.driver_name); continue; }
      byEvent.set(li.eventId, {
        amount: Number(li.amount), drivers: [r.driver_name], loadId: li.loadId ?? null, loadNum: li.loadNum ?? null,
        date: li.date ?? r.week_start, weekStart: r.week_start, label: li.label ?? null,
      });
    }
  }

  const ids = [...byEvent.keys()];
  const events: Array<{ id: string; leg_index: number | null; title: string | null }> = [];
  const stops: Array<StopLike & { event_id: string; sequence: number; is_handoff: boolean | null; facility_name: string | null }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [ev, st] = await Promise.all([
      supabase.from("events").select("id, leg_index, title").in("id", chunk),
      supabase.from("stops").select("id, event_id, sequence, type, is_handoff, lat, lng, city, state, facility_name").in("event_id", chunk),
    ]);
    if (ev.error) throw new Error(`route pay events: ${ev.error.message}`);
    if (st.error) throw new Error(`route pay stops: ${st.error.message}`);
    events.push(...ev.data);
    stops.push(...st.data);
  }
  const stopsOf = new Map<string, StopLike[]>();
  for (const s of stops.sort((a, b) => a.sequence - b.sequence)) {
    stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), {
      id: s.id, lat: s.lat, lng: s.lng, type: s.type, isHandoff: s.is_handoff ?? undefined,
      city: s.city, state: s.state, facilityName: s.facility_name,
    }]);
  }
  const { placeOf, places } = await placesFor(orgId, stops.map((s) => ({ ...s, isHandoff: s.is_handoff ?? undefined, facilityName: s.facility_name })));

  const paid: PaidLeg[] = [];
  for (const e of events) {
    const p = byEvent.get(e.id)!;
    const route = legRoute(stopsOf.get(e.id) ?? [], e.leg_index ?? 0, placeOf);
    if (!route) continue;
    paid.push({
      eventId: e.id, loadId: p.loadId, loadNum: p.loadNum, title: e.title?.trim() || p.label, date: p.date, weekStart: p.weekStart,
      driver: p.drivers.join(" + "), amount: Math.round(p.amount * 100) / 100,
      route, customer: p.label?.includes(":") ? p.label.split(":")[0].trim() : null,
    });
  }
  const group = (key: (l: PaidLeg) => string) => {
    const m = new Map<string, PaidLeg[]>();
    for (const l of paid) m.set(key(l), [...(m.get(key(l)) ?? []), l]);
    return m;
  };

  // Rules per kind: local kinds pay flat (median); long kinds base + per mile.
  const kindRules = {} as History["kindRules"];
  for (const kind of Object.keys(KIND_LABEL) as RouteLegKind[]) {
    const ls = paid.filter((l) => l.route.kind === kind);
    const amts = ls.map((l) => l.amount).sort((a, b) => a - b);
    const median = amts.length ? amts[Math.floor(amts.length / 2)] : 0;
    let base = median; let perMile = 0;
    if (ls.length >= MIN_LEGS && BY_MILE.includes(kind)) {
      const mx = ls.reduce((s, l) => s + l.route.miles, 0) / ls.length;
      const my = ls.reduce((s, l) => s + l.amount, 0) / ls.length;
      const sxx = ls.reduce((s, l) => s + (l.route.miles - mx) ** 2, 0);
      const b = sxx > 0 ? ls.reduce((s, l) => s + (l.route.miles - mx) * (l.amount - my), 0) / sxx : 0;
      perMile = Math.max(0, b);
      base = Math.max(0, my - perMile * mx);
    }
    kindRules[kind] = { base: Math.round(base), perMile: Math.round(perMile * 100) / 100, legs: ls.length };
  }

  return {
    settledThrough, paid, places, placeOf, kindRules,
    byRoute: group((l) => l.route.key),
    byArea: group((l) => l.route.areaKey),
  };
}

function history(orgId: string): Promise<History> {
  const hit = historyCache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = buildHistory(orgId);
  historyCache.set(orgId, { at: Date.now(), value });
  value.catch(() => historyCache.delete(orgId));
  return value;
}
export function forgetRoutePayHistory(orgId: string) { historyCache.delete(orgId); }

// ── Standards ───────────────────────────────────────────────────────────

interface StandardRow { route_key: string; amount: number | string; note: string | null; set_by_name: string | null; set_at: string }
async function standards(orgId: string): Promise<Map<string, StandardRow>> {
  const rows = await fetchAllRows<StandardRow & { id: number }>("route pay standards", () =>
    supabase.from("route_pay_standards").select("id, route_key, amount, note, set_by_name, set_at").eq("org_id", orgId));
  return new Map(rows.map((r) => [r.route_key, r]));
}
/** Route names; empty when the route_names table isn't there yet. */
async function routeNames(orgId: string): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("route_names").select("route_key, name").eq("org_id", orgId);
  if (error) return new Map();
  return new Map((data as Array<{ route_key: string; name: string }>).map((r) => [r.route_key, r.name]));
}

export async function setRouteName(orgId: string, routeKey: string, name: string | null, byName: string | null): Promise<void> {
  if (!name) {
    const { error } = await supabase.from("route_names").delete().eq("org_id", orgId).eq("route_key", routeKey);
    if (error) throw new RoutePayUnavailableError(`${error.message} — has 20261017b_route_names.sql been run?`);
    return;
  }
  const { error } = await supabase.from("route_names").upsert(
    { org_id: orgId, route_key: routeKey, name, set_by_name: byName, set_at: new Date().toISOString() },
    { onConflict: "org_id,route_key" },
  );
  if (error) throw new RoutePayUnavailableError(`${error.message} — has 20261017b_route_names.sql been run?`);
}

const toStandard = (s: StandardRow | undefined) =>
  s ? { amount: Number(s.amount), note: s.note, setByName: s.set_by_name, setAt: s.set_at } : null;

const toPlace = (p: PlaceRow): RoutePlace => ({
  id: p.id, name: p.name, lat: p.lat, lng: p.lng, city: p.city, state: p.state, isYard: !!p.saved_location_id,
});

/** Pay on a route varies when its recent legs were paid different amounts,
 *  or something other than its standard. */
const variesOf = (amounts: Array<{ amount: number }>, standard: StandardRow | undefined) =>
  amounts.length > 1 || (!!standard && amounts.some((a) => Math.abs(a.amount - Number(standard.amount)) >= 0.5));

const toRatePlace = (p: PlaceRow): RatePlace => ({ id: p.id, lat: p.lat, lng: p.lng, name: p.name, city: p.city, state: p.state });

/** The rate card, trained on every route with paid history. */
async function rateCardFor(
  orgId: string, h: History, std: Map<string, StandardRow>, names: Map<string, string>, config?: RateCardConfig,
): Promise<RateCard> {
  const cfg = config ? { config, available: true } : await readRateConfig(orgId);
  const placeById = new Map(h.places.map((p) => [p.id, p]));
  const routes: RateRoute[] = [];
  for (const [key, legs] of h.byRoute) {
    const st = statsOf(legs);
    const r = legs[0].route;
    const standard = toStandard(std.get(key));
    routes.push({
      key, kind: r.kind, miles: r.miles, label: r.label, name: names.get(key) ?? null, cities: r.cities,
      places: r.placeIds.map((id) => placeById.get(id)).filter((p): p is PlaceRow => !!p).map(toRatePlace),
      customers: st.customers, legs: st.legs, standard: !!standard,
      pay: trainingPay({ standard, usual: st.usual, usualShare: st.usualShare, legs: st.legs }),
    });
  }
  return buildRateCard(routes, cfg.config, cfg.available);
}

// ── Public ──────────────────────────────────────────────────────────────

export async function listPayRoutes(orgId: string): Promise<PayRoutesResponse> {
  const [h, std, names] = await Promise.all([history(orgId), standards(orgId), routeNames(orgId)]);
  const card = await rateCardFor(orgId, h, std, names);
  const excluded = new Set(card.response.excluded);
  const routes: PayRoute[] = [];
  const seen = new Set<string>();
  for (const [key, legs] of h.byRoute) {
    const st = statsOf(legs);
    const r = legs[0].route;
    seen.add(key);
    routes.push({
      key, places: r.placeIds, label: r.label, name: names.get(key) ?? null, cities: r.cities, kind: r.kind, miles: r.miles,
      ...st, standard: toStandard(std.get(key)),
      varies: variesOf(st.amounts, std.get(key)),
      rateCell: card.cellOf(key), rateExcluded: excluded.has(key),
    });
  }
  // Standards set on routes with no settled pay yet still show.
  const placeName = new Map(h.places.map((p) => [p.id, p.name]));
  for (const [key, s] of std) {
    if (seen.has(key)) continue;
    const ids = key.split(">").map(Number);
    const ends = [h.places.find((p) => p.id === ids[0]), h.places.find((p) => p.id === ids[ids.length - 1])];
    routes.push({
      key, places: ids, label: ids.map((id) => placeName.get(id) ?? `#${id}`).join(" → "),
      name: names.get(key) ?? null, cities: `${cityOf(undefined, ends[0])} → ${cityOf(undefined, ends[1])}`, kind: null, miles: null,
      legs: 0, usual: null, usualShare: null, min: 0, max: 0, lastPaid: null, examples: [], customers: [], amounts: [],
      standard: toStandard(s), varies: false, rateCell: null, rateExcluded: false,
    });
  }
  routes.sort((a, b) => b.legs - a.legs);
  return {
    places: h.places.map(toPlace),
    routes,
    settledThrough: h.settledThrough,
    kindRules: h.kindRules,
    kindLabels: KIND_LABEL,
    rateCard: card.response,
  };
}

const round5 = (n: number) => Math.max(0, Math.round(n / 5) * 5);

/**
 * Suggested pay per leg: the route's standard, else the route's settled
 * usual, else the rate card, else the usual between the same areas, else
 * a rate card estimate, else the rough rule for the leg's kind. (This
 * order backtested best on a week the history hadn't seen: 63% exact,
 * 91% within $25.) opts.config is for backtests.
 */
export async function suggestPay(
  orgId: string, req: PaySuggestRequest, opts: { config?: RateCardConfig } = {},
): Promise<Record<string, PaySuggestion | null>> {
  const [h, std, names] = await Promise.all([history(orgId), standards(orgId), routeNames(orgId)]);
  const card = await rateCardFor(orgId, h, std, names, opts.config);

  // Legs given by event id: load their leg index and stops.
  const eventIds = req.legs.filter((l) => l.eventId && !l.stops).map((l) => l.eventId!);
  const legIndexOf = new Map<string, number>();
  const stopsOf = new Map<string, StopLike[]>();
  for (let i = 0; i < eventIds.length; i += CHUNK) {
    const chunk = eventIds.slice(i, i + CHUNK);
    const [ev, st] = await Promise.all([
      supabase.from("events").select("id, leg_index").eq("org_id", orgId).in("id", chunk),
      supabase.from("stops").select("id, event_id, sequence, type, is_handoff, lat, lng, city, state, facility_name").in("event_id", chunk),
    ]);
    if (ev.error) throw new Error(`suggest events: ${ev.error.message}`);
    if (st.error) throw new Error(`suggest stops: ${st.error.message}`);
    for (const e of ev.data as Array<{ id: string; leg_index: number | null }>) legIndexOf.set(e.id, e.leg_index ?? 0);
    for (const s of (st.data as Array<StopLike & { event_id: string; sequence: number; is_handoff: boolean | null; facility_name: string | null }>)
      .sort((a, b) => a.sequence - b.sequence)) {
      stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), { ...s, isHandoff: s.is_handoff ?? undefined, facilityName: s.facility_name }]);
    }
  }

  // New places for stops we haven't seen (so the route has stable ids).
  const allStops: StopLike[] = req.legs.flatMap((l): StopLike[] => l.stops ?? (l.eventId ? stopsOf.get(l.eventId) ?? [] : []));
  const unknown = allStops.filter((s) => s.lat != null && s.lng != null && !h.placeOf(s));
  const fresh = unknown.length ? await placesFor(orgId, unknown) : null;
  const placeOf = fresh?.placeOf ?? h.placeOf;
  const placeById = new Map((fresh?.places ?? h.places).map((p) => [p.id, p]));

  const out: Record<string, PaySuggestion | null> = {};
  for (const leg of req.legs) {
    const given: StopLike[] | undefined = leg.stops ?? (leg.eventId ? stopsOf.get(leg.eventId) : undefined);
    // One driver doing the whole run: relay points drop out, handoffs are ordinary stops.
    const stops = leg.wholeLoad && given
      ? given.filter((st) => st.type !== "relay").map((st) => ({ ...st, isHandoff: false }))
      : given;
    const legIndex = leg.wholeLoad ? 0 : leg.legIndex ?? (leg.eventId ? legIndexOf.get(leg.eventId) ?? 0 : 0);
    const route = stops ? legRoute(stops, legIndex, placeOf) : null;
    if (!route) { out[leg.key] = null; continue; }
    const routeLegs = h.byRoute.get(route.key) ?? [];
    const areaLegs = h.byArea.get(route.areaKey) ?? [];
    const routeStats = statsOf(routeLegs);
    const standard = std.get(route.key);
    const rate = card.rateFor({
      places: route.placeIds.map((id) => placeById.get(id)).filter((p): p is PlaceRow => !!p).map(toRatePlace),
      kind: route.kind, miles: route.miles,
    });
    const base = {
      routeKey: route.key, routeLabel: route.label, routeName: names.get(route.key) ?? null, cities: route.cities, kind: route.kind, miles: route.miles,
      amounts: routeStats.amounts, varies: variesOf(routeStats.amounts, std.get(route.key)),
      rateValue: rate && !rate.estimate ? rate.amount : null,
    };
    const fromRate = (): PaySuggestion => ({
      ...base, amount: rate!.amount, source: "rate", note: rate!.estimate ? "estimate" : null,
      legs: routeStats.legs, usual: routeStats.usual, usualShare: routeStats.usualShare, examples: routeStats.examples,
      rate: { key: rate!.key, label: rate!.label, refs: rate!.refs.slice(0, 8), extraStops: rate!.extraStops, extraStopAmount: rate!.extraStopAmount },
    });
    const routeUsual = routeStats.legs >= MIN_LEGS && routeStats.usual != null;
    if (standard) {
      out[leg.key] = { ...base, amount: Number(standard.amount), source: "standard", note: standard.note,
        legs: routeStats.legs, usual: routeStats.usual, usualShare: routeStats.usualShare, examples: routeStats.examples };
    } else if (routeUsual) {
      out[leg.key] = { ...base, amount: routeStats.usual!, source: "route", note: null,
        legs: routeStats.legs, usual: routeStats.usual, usualShare: routeStats.usualShare, examples: routeStats.examples };
    } else if (rate && !rate.estimate) {
      out[leg.key] = fromRate();
    } else if (areaLegs.length >= MIN_LEGS) {
      const a = statsOf(areaLegs);
      out[leg.key] = { ...base, amount: a.usual ?? 0, source: "area", note: null,
        legs: a.legs, usual: a.usual, usualShare: a.usualShare, examples: a.examples };
    } else if (rate) {
      out[leg.key] = fromRate();
    } else {
      const rule = h.kindRules[route.kind];
      out[leg.key] = rule && rule.legs > 0 ? {
        ...base, amount: round5(rule.base + rule.perMile * route.miles), source: "kind", note: null,
        legs: rule.legs, usual: null, usualShare: null, examples: routeStats.examples,
      } : null;
    }
  }
  return out;
}

export async function setRouteStandard(
  orgId: string, routeKey: string, amount: number | null, note: string | null, by: { id: string; name: string | null },
): Promise<void> {
  if (amount == null) {
    const { error } = await supabase.from("route_pay_standards").delete().eq("org_id", orgId).eq("route_key", routeKey);
    if (error) throw new RoutePayUnavailableError(error.message);
    return;
  }
  const { error } = await supabase.from("route_pay_standards").upsert({
    org_id: orgId, route_key: routeKey, amount, note, set_by: by.id, set_by_name: by.name, set_at: new Date().toISOString(),
  }, { onConflict: "org_id,route_key" });
  if (error) throw new RoutePayUnavailableError(error.message);
}

export async function renamePlace(orgId: string, placeId: number, name: string): Promise<void> {
  const { error } = await supabase.from("route_places").update({ name, named_by_user: true }).eq("org_id", orgId).eq("id", placeId);
  if (error) throw new RoutePayUnavailableError(error.message);
  forgetRoutePayHistory(orgId);
}
