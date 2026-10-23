/**
 * Trips — a driver's chain of loads from leaving a home base to getting
 * back (lib/payAreas.ts home bases), priced as a whole so a cheap leg out
 * is judged with the loads it set up: SLC → Vegas → Denver → SLC.
 *
 * Built per DRIVER (events.asset_id isn't a physical truck), over every
 * leg they drove; a relay leg is its own segment of the load's stop list
 * and earns the load's rate by its share of truck time (lib/legTime.ts).
 *
 *   base     the home area holding the org's home terminal (SLC); other home
 *            areas (Vegas) are just places a trip goes
 *   starts   a leg leaving the base, or a leg away from it right after
 *            the driver's last leg ended at one (an empty run out)
 *   ends     a leg arriving back at the base it left from; or the driver's
 *            next leg starting there (came back empty); or no next leg
 *            within MAX_GAP_DAYS (open)
 *   empty    runs with no load between loads, and out to the first / back
 *            from the last when the trip didn't start / end loaded: GPS
 *            deadhead / return miles where the leg is linked, else
 *            straight-line × ROAD_FACTOR between the stops (yard moves at
 *            the base are left to local work)
 *   relays   a load's rate is split by truck time across its linehaul legs;
 *            a short relay shuttle (≤ SHUTTLE_MILES) earns nothing itself —
 *            its pay, miles and truck time ride on the linehaul as cost
 *   cost     driver pay (payroll's per-leg amount, else the calendar's,
 *            else the dashboard OTR pay %) + layover / detention pay (per
 *            payroll week, split across the driver's trips) + relay shuttles + fuel and maintenance on loaded
 *            and empty miles + overhead per truck-day for the days away +
 *            hotels on OTR + other % of revenue — the dashboard's numbers
 *
 * Only trips that go past the short-haul radius from their own base are kept
 * (OTR). Trips with the same order of regions (an area, or the base it's
 * inside; each load's ends plus its farthest stop) and the same empty runs
 * group into a circuit.
 */

import type {
  HaulClass, LaneCircuit, LaneCircuitNode, LaneTrip, LaneTripLeg, LaneTripTotals, LaneTripsResponse, Stop,
} from "@fleetcal/types";
import { stopsForLeg } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { SHORT_HAUL_RADIUS_MILES, airMilesBetween } from "./airMiles.js";
import { computeWeeklyTarget, saturdayOf } from "./weeklyTarget.js";
import { areaLocator, readAreasAndLanes } from "./payAreas.js";
import { laneCostParams } from "./laneRates.js";
import { H, fetchLegActuals, legWindow, timeShares, wallStr } from "./legTime.js";
import { getHosConfig } from "./hosService.js";
import { isExcludedEvent, loadExcludedAssetIds, loadExcludedDrivers } from "./reportExclusions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const LOOKBACK_DAYS = 180;
const MAX_GAP_DAYS = 4;
const ROAD_FACTOR = 1.2;
const EMPTY_MPH = 50;
const SHUTTLE_MILES = 50;
/** Payroll adjustment categories that are pay for the trip, not a load. */
const TRIP_PAY_CATEGORIES = new Set(["layover", "detention"]);
const CACHE_MS = 10 * 60_000;
const CHUNK = 150;

type Pt = { lat: number; lng: number };
const r0 = (n: number) => Math.round(n);
const r2 = (n: number) => Math.round(n * 100) / 100;
const roadMiles = (a: Pt, b: Pt) => airMilesBetween({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }) * ROAD_FACTOR;

interface Ev {
  id: string; load_id: string; leg_index: number | null; start: string; end: string | null; status: string | null;
  driver_pay: number | null; loaded_miles: number | null; driver_id: number | null; driver_name: string | null; asset_id: number | null;
  loads: { load_num: string | null; broker: string | null; total_billable: number | null; load_price: number | null; deleted_at: string | null } | null;
}
type StopRow = { event_id: string; sequence: number; type: Stop["type"]; is_handoff: boolean | null; lat: number | null; lng: number | null; city: string | null; state: string | null };

/** One leg a driver drove, ready to chain. */
interface DriverLeg {
  ev: Ev; a: number; b: number; path: Pt[]; first: StopRow; last: StopRow;
  revenue: number; share: number; rate: number; pay: number; payBasis: LaneTripLeg["payBasis"];
  /** A relay shuttle: no revenue of its own; its cost rides on the linehaul (relayCost). */
  shuttle: boolean; relayCost: number;
  loadedMiles: number; shuttleMiles: number; gpsDeadhead: number | null; gpsReturn: number | null;
}

const cache = new Map<string, { at: number; value: Promise<LaneTripsResponse> }>();

/** Trips for the org, cached for a few minutes (it reads half a year of loads). */
export function laneTrips(orgId: string, opts: { fresh?: boolean } = {}): Promise<LaneTripsResponse> {
  const hit = cache.get(orgId);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = buildTrips(orgId);
  cache.set(orgId, { at: Date.now(), value });
  value.catch(() => cache.delete(orgId));
  return value;
}

async function buildTrips(orgId: string): Promise<LaneTripsResponse> {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [wt, al, hos, excluded, excludedAssets, events] = await Promise.all([
    computeWeeklyTarget(orgId),
    readAreasAndLanes(orgId),
    getHosConfig(orgId),
    loadExcludedDrivers(orgId),
    loadExcludedAssetIds(orgId),
    fetchAllRows<Ev>("trips events", () => supabase.from("events")
      .select("id, load_id, leg_index, start, end, status, driver_pay, loaded_miles, driver_id, driver_name, asset_id, loads(load_num, broker, total_billable, load_price, deleted_at)")
      .eq("org_id", orgId).is("deleted_at", null).eq("event_kind", "revenue").not("load_id", "is", null)
      .gte("start", since).lte("start", `${today}T23:59`)),
  ]);
  const params = laneCostParams(wt.params);
  const payPctOtr = wt.params.payPct.otr;
  const empty: LaneTripsResponse = { available: al.available, lookbackDays: LOOKBACK_DAYS, since, until: today, trips: [], circuits: [], openTrips: 0, params, tripTypes: [] };
  // Trips start and end at the base (the home area holding the home
  // terminal); other home areas are places trips go, like Vegas.
  const homes = al.areas.filter((a) => a.isHome && (al.baseId == null || a.id === al.baseId));
  const isBase = (homeId: number | null) => homeId != null && homes.some((h) => h.id === homeId);
  if (!al.available || !homes.length) return empty;
  const homeCenter = new Map(homes.map((h) => [h.id, {
    lat: h.polygon.reduce((s, p) => s + p.lat, 0) / h.polygon.length,
    lng: h.polygon.reduce((s, p) => s + p.lng, 0) / h.polygon.length,
  }]));
  const locate = areaLocator(al.areas);
  const areaById = new Map(al.areas.map((a) => [a.id, a]));

  const byLoad = new Map<string, Ev[]>();
  for (const e of events) {
    if (e.status === "cancelled" || e.loads?.deleted_at) continue;
    byLoad.set(e.load_id, [...(byLoad.get(e.load_id) ?? []), e]);
  }
  for (const legs of byLoad.values()) legs.sort((a, b) => (a.leg_index ?? 0) - (b.leg_index ?? 0));

  // Every leg carries the full stop list — read the first leg's, slice per leg.
  const firstIds = [...byLoad.values()].map((ls) => ls[0].id);
  const stops: StopRow[] = [];
  for (let i = 0; i < firstIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("stops").select("event_id, sequence, type, is_handoff, lat, lng, city, state").in("event_id", firstIds.slice(i, i + CHUNK));
    if (error) throw new Error(`trips stops: ${error.message}`);
    stops.push(...data);
  }
  const stopsOf = new Map<string, StopRow[]>();
  for (const s of stops.sort((a, b) => a.sequence - b.sequence)) stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), s]);

  const [actuals, { byEvent: payByEvent, tripPay }] = await Promise.all([fetchLegActuals(events.map((e) => e.id)), payrollPay(orgId, since)]);

  // Legs by driver. A relay load's rate is split by truck time across its
  // linehaul legs; short relay shuttles (≤ SHUTTLE_MILES, e.g. a Vegas
  // pickup to the yard) earn nothing themselves — their pay, miles and truck
  // time are charged to the linehaul legs instead.
  const byDriver = new Map<string, DriverLeg[]>();
  const perMile = params.fuelPerMile + params.maintPerMile;
  const loads = [...byLoad.values()].map((legs) => prepareLoad(legs)).filter((x): x is NonNullable<typeof x> => !!x);
  // What a shuttle usually pays, for shuttles without a recorded amount.
  const shuttlePays = loads.flatMap((x) => x.info.filter((_, i) => x.shuttle[i]).map((y) => y.recorded?.[0]).filter((v): v is number => v != null && v > 0)).sort((a, b) => a - b);
  const typicalShuttlePay = shuttlePays.length ? shuttlePays[Math.floor(shuttlePays.length / 2)] : 100;

  function prepareLoad(legs: Ev[]) {
    const all = (stopsOf.get(legs[0].id) ?? []).map((s) => ({ ...s, isHandoff: s.is_handoff ?? undefined }));
    if (all.length < 2) return null;
    const rate = Number(legs[0].loads?.total_billable ?? legs[0].loads?.load_price ?? 0);
    const everyLegPriced = legs.every((l) => l.driver_pay != null);
    const windows = legs.map((l) => legWindow({ calStart: l.start, calEnd: l.end, actual: actuals.get(l.id), cls: "otr", tz: hos.timeZone }));
    const timeShare = timeShares(windows);
    const info = legs.map((l, i) => {
      const seg = (legs.length > 1 ? stopsForLeg(all, l.leg_index ?? i) : all).filter((s) => s.lat != null && s.lng != null);
      const path = seg.map((s) => ({ lat: Math.round(Number(s.lat) * 1e4) / 1e4, lng: Math.round(Number(s.lng) * 1e4) / 1e4 }));
      const la = actuals.get(l.id);
      // Uncached miles: stop to stop, straight-line × road factor.
      const cached = Number(la?.loaded_miles ?? l.loaded_miles ?? 0);
      const miles = cached > 0 ? cached : path.slice(1).reduce((s, p, k) => s + roadMiles(path[k], p), 0);
      const payroll = payByEvent.get(l.id);
      const recorded: [number, LaneTripLeg["payBasis"]] | null = payroll != null ? [payroll, "payroll"]
        : l.driver_pay != null && (legs.length === 1 || everyLegPriced) ? [Number(l.driver_pay), "calendar"] : null;
      return { l, seg, path, la, miles, recorded };
    });
    const shuttle = info.map((x) => legs.length > 1 && x.miles <= SHUTTLE_MILES);
    if (shuttle.every(Boolean)) shuttle.fill(false);
    return { legs, rate, windows, timeShare, info, shuttle };
  }

  for (const { rate, windows, info, shuttle } of loads) {
    const lineShare = timeShares(windows.map((w, i) => (shuttle[i] ? { a: 0, b: 0 } : w)));
    const relayCost = info.reduce((sum, x, i) => {
      if (!shuttle[i]) return sum;
      const pay = x.recorded?.[0] ?? typicalShuttlePay;
      // Calendar windows on local work run all day; without GPS, estimate.
      const hours = windows[i].fromGps ? Math.min(12, (windows[i].b - windows[i].a) / H) : x.miles / 30 + 1;
      return sum + pay + x.miles * perMile + (hours / 24) * params.overheadPerTruckDay;
    }, 0);
    info.forEach((x, i) => {
      const { l, seg, path, la } = x;
      if (isExcludedEvent(excluded, l) || (l.asset_id != null && excludedAssets.has(l.asset_id))) return;
      const driver = l.driver_id != null ? `id:${l.driver_id}` : l.driver_name?.trim() ? `name:${l.driver_name.trim()}` : null;
      if (!driver || seg.length < 2) return;
      const revenue = shuttle[i] ? 0 : rate * lineShare[i];
      const [pay, payBasis]: [number, LaneTripLeg["payBasis"]] = shuttle[i] ? [0, x.recorded?.[1] ?? "percent"] : x.recorded ?? [payPctOtr * revenue, "percent"];
      byDriver.set(driver, [...(byDriver.get(driver) ?? []), {
        ev: l, a: windows[i].a, b: windows[i].b,
        path, first: seg[0], last: seg[seg.length - 1],
        revenue, share: shuttle[i] ? 0 : lineShare[i], rate, pay, payBasis,
        shuttle: shuttle[i], relayCost: shuttle[i] ? 0 : relayCost * lineShare[i],
        loadedMiles: shuttle[i] ? 0 : x.miles, shuttleMiles: shuttle[i] ? x.miles : 0,
        gpsDeadhead: la?.deadhead_miles != null ? Number(la.deadhead_miles) : null,
        gpsReturn: la?.return_miles != null ? Number(la.return_miles) : null,
      }]);
    });
  }

  const ptOf = (s: StopRow): Pt => ({ lat: Number(s.lat), lng: Number(s.lng) });
  const areaOf = (s: StopRow) => locate(ptOf(s));
  const homeOf = (s: StopRow) => { const h = areaOf(s)?.homeId ?? null; return isBase(h) ? h : null; };
  // A region is the base an area sits in, else the area, else the state.
  const regionOf = (s: StopRow): { key: string; label: string; areaId: number | null } => {
    const a = areaOf(s);
    if (a?.homeId != null) return { key: `a${a.homeId}`, label: areaById.get(a.homeId)?.name ?? a.name, areaId: a.homeId };
    if (a) return { key: `a${a.id}`, label: a.name, areaId: a.id };
    const st = s.state?.trim().toUpperCase() || "?";
    return { key: `s${st}`, label: `${st} (no area)`, areaId: null };
  };

  const trips: LaneTrip[] = [];
  const nodesOf = new Map<string, LaneCircuitNode[]>();
  const rawOf = new Map<string, Parameters<typeof totalsFor>[0]>();
  for (const [driverKey, legs] of byDriver) {
    legs.sort((x, y) => x.a - y.a);
    const driverName = legs.find((l) => l.ev.driver_name)?.ev.driver_name?.trim() ?? driverKey;
    let cur: { home: number; legs: DriverLeg[]; emptyOut: { miles: number; from: Pt } | null } | null = null;
    let prev: DriverLeg | null = null;
    const close = (returned: LaneTrip["returned"], emptyBack: { miles: number; to: Pt } | null) => {
      if (cur) trips.push(buildTrip(driverName, cur.home, cur.legs, cur.emptyOut, emptyBack, returned));
      cur = null;
    };
    for (const leg of legs) {
      const gapDays = prev ? (leg.a - prev.b) / (24 * H) : Infinity;
      const fromHome = homeOf(leg.first);
      const toHome = homeOf(leg.last);
      if (cur && gapDays > MAX_GAP_DAYS) close("open", null);
      if (cur && fromHome === (cur as { home: number }).home) {
        // Back at the base before this leg: came home empty.
        const last = prev!;
        const miles = last.gpsReturn ?? roadMiles(ptOf(last.last), ptOf(leg.first));
        close("empty", { miles, to: ptOf(leg.first) });
      }
      if (!cur) {
        if (fromHome != null && toHome !== fromHome) {
          cur = { home: fromHome, legs: [], emptyOut: null };
        } else if (fromHome == null && prev && homeOf(prev.last) != null && gapDays <= MAX_GAP_DAYS) {
          const miles = leg.gpsDeadhead ?? roadMiles(ptOf(prev.last), ptOf(leg.first));
          cur = { home: homeOf(prev.last)!, legs: [], emptyOut: { miles, from: ptOf(prev.last) } };
        } else {
          prev = leg;
          continue;
        }
      }
      cur!.legs.push(leg);
      if (toHome === cur!.home) close("loaded", null);
      prev = leg;
    }
    if (cur) close("open", null);
  }

  function buildTrip(driver: string, home: number, legs: DriverLeg[], emptyOut: { miles: number; from: Pt } | null, emptyBack: { miles: number; to: Pt } | null, returned: LaneTrip["returned"]): LaneTrip {
    const out: LaneTripLeg[] = legs.map((l, i) => {
      const fromA = areaOf(l.first);
      const toA = areaOf(l.last);
      const before = i === 0
        ? emptyOut?.miles ?? 0
        : l.gpsDeadhead ?? roadMiles(ptOf(legs[i - 1].last), ptOf(l.first));
      return {
        eventId: l.ev.id, loadId: l.ev.load_id, loadNum: l.ev.loads?.load_num ?? null, broker: l.ev.loads?.broker ?? null,
        start: wallStr(l.a), end: wallStr(l.b),
        from: fromA?.name ?? [l.first.city, l.first.state].filter(Boolean).join(", "),
        to: toA?.name ?? [l.last.city, l.last.state].filter(Boolean).join(", "),
        fromAreaId: fromA?.id ?? null, toAreaId: toA?.id ?? null,
        rate: r0(l.rate), share: r2(l.share), revenue: r0(l.revenue), driverPay: r0(l.pay), payBasis: l.payBasis,
        shuttle: l.shuttle, relayCost: r0(l.relayCost),
        loadedMiles: r0(l.loadedMiles || l.shuttleMiles), emptyMilesBefore: r0(before), path: l.path,
      };
    });
    const lastLeg = legs[legs.length - 1];
    const backMiles = emptyBack?.miles ?? 0;
    const loadedMiles = legs.reduce((s, l) => s + l.loadedMiles, 0);
    const emptyMiles = out.reduce((s, l) => s + l.emptyMilesBefore, 0) + backMiles;
    const startMs = legs[0].a - (emptyOut ? (emptyOut.miles / EMPTY_MPH) * H : 0);
    const endMs = lastLeg.b + (emptyBack ? (emptyBack.miles / EMPTY_MPH) * H : 0);
    const days = Math.max(0.5, (endMs - startMs) / (24 * H));
    const center = homeCenter.get(home)!;
    const farthest = Math.max(...legs.flatMap((l) => l.path.map((p) => airMilesBetween({ lat: center.lat, lon: center.lng }, { lat: p.lat, lon: p.lng }))));
    const cls: HaulClass = farthest > SHORT_HAUL_RADIUS_MILES ? "otr" : "local";
    const raw = {
      revenue: legs.reduce((s, l) => s + l.revenue, 0),
      driverPay: legs.reduce((s, l) => s + l.pay, 0),
      layover: 0,
      relayLegs: legs.reduce((s, l) => s + l.relayCost, 0),
      loadedMiles, emptyMiles, days, otr: cls === "otr",
    };

    // Circuit: the regions in order, with the empty runs between them.
    const nodes: LaneCircuitNode[] = [];
    const push = (r: { key: string; label: string; areaId: number | null }, emptyIn: boolean) => {
      if (nodes[nodes.length - 1]?.key !== r.key) nodes.push({ ...r, emptyIn });
    };
    const base = regionOf(emptyOut ? { ...legs[0].first, lat: emptyOut.from.lat, lng: emptyOut.from.lng } : legs[0].first);
    push(base, false);
    for (const l of legs) {
      push(regionOf(l.first), true);
      // A load out and back to the same region still shows where it went.
      const far = l.path.reduce((best, p) => (roadMiles(p, ptOf(l.first)) > roadMiles(best, ptOf(l.first)) ? p : best), l.path[0]);
      const farRegion = regionOf({ ...l.first, lat: far.lat, lng: far.lng, state: null });
      const ends = [regionOf(l.first).key, regionOf(l.last).key];
      if (farRegion.areaId != null && !ends.includes(farRegion.key)) push(farRegion, false);
      push(regionOf(l.last), false);
    }
    if (returned === "empty") push(base, true);
    const circuitKey = nodes.map((n) => (n.emptyIn ? "~" : "") + n.key).join(">") + (returned === "open" ? ">…" : "");
    nodesOf.set(circuitKey, nodes);
    const id = legs[0].ev.id;
    rawOf.set(id, raw);

    return {
      id, driver, start: wallStr(startMs), end: wallStr(endMs), returned, cls, circuitKey,
      emptyOut: emptyOut ? { miles: r0(emptyOut.miles), from: emptyOut.from } : null,
      emptyBack: emptyBack ? { miles: r0(emptyBack.miles), to: emptyBack.to } : null,
      legs: out, totals: totalsFor(raw),
    };
  }

  function totalsFor(x: { revenue: number; driverPay: number; layover: number; relayLegs: number; loadedMiles: number; emptyMiles: number; days: number; otr: boolean }): LaneTripTotals {
    const miles = x.loadedMiles + x.emptyMiles;
    const fuel = miles * params.fuelPerMile;
    const maintenance = miles * params.maintPerMile;
    const overhead = x.days * params.overheadPerTruckDay;
    const hotels = x.otr ? x.days * 4 * params.hotelsPerBlock : 0;
    const other = x.revenue * params.otherPct;
    const fixed = x.driverPay + x.layover + x.relayLegs + fuel + maintenance + overhead + hotels;
    const cost = fixed + other;
    const targetRevenue = fixed / Math.max(0.05, 1 - params.otherPct - params.margin);
    return {
      revenue: r0(x.revenue), driverPay: r0(x.driverPay), layover: r0(x.layover), relayLegs: r0(x.relayLegs), fuel: r0(fuel), maintenance: r0(maintenance), overhead: r0(overhead),
      hotels: r0(hotels), other: r0(other), cost: r0(cost), profit: r0(x.revenue - cost), profitPerDay: r0((x.revenue - cost) / x.days),
      targetRevenue: r0(targetRevenue), vsTarget: r0(x.revenue - targetRevenue),
      loadedMiles: r0(x.loadedMiles), emptyMiles: r0(x.emptyMiles), days: Math.round(x.days * 10) / 10,
    };
  }

  const kept = trips.filter((t) => t.cls === "otr").sort((a, b) => b.start.localeCompare(a.start));
  // Layover / detention pay is entered per payroll week with no date: split
  // each driver's week evenly across their trips that started that week.
  const tripsOfWeek = new Map<string, LaneTrip[]>();
  for (const t of kept) {
    const k = `${t.driver.toLowerCase()}|${saturdayOf(t.start.slice(0, 10))}`;
    tripsOfWeek.set(k, [...(tripsOfWeek.get(k) ?? []), t]);
  }
  for (const [k, amount] of tripPay) {
    const ts = tripsOfWeek.get(k);
    if (!ts) continue;
    for (const t of ts) {
      const raw = rawOf.get(t.id)!;
      raw.layover += amount / ts.length;
      t.totals = totalsFor(raw);
    }
  }
  const groups = new Map<string, LaneTrip[]>();
  for (const t of kept) groups.set(t.circuitKey, [...(groups.get(t.circuitKey) ?? []), t]);
  const circuits: LaneCircuit[] = [...groups].map(([key, ts]) => {
    const mean = (f: (t: LaneTripTotals) => number) => ts.reduce((s, t) => s + f(t.totals), 0) / ts.length;
    const days = mean((t) => t.days);
    const revenue = mean((t) => t.revenue);
    const cost = mean((t) => t.cost);
    return {
      key, nodes: nodesOf.get(key) ?? [], open: ts[0].returned === "open", trips: ts.length, tripIds: ts.map((t) => t.id),
      avg: {
        revenue: r0(revenue), driverPay: r0(mean((t) => t.driverPay)), layover: r0(mean((t) => t.layover)), relayLegs: r0(mean((t) => t.relayLegs)), fuel: r0(mean((t) => t.fuel)), maintenance: r0(mean((t) => t.maintenance)),
        overhead: r0(mean((t) => t.overhead)), hotels: r0(mean((t) => t.hotels)), other: r0(mean((t) => t.other)), cost: r0(cost),
        profit: r0(revenue - cost), profitPerDay: r0((revenue - cost) / days),
        targetRevenue: r0(mean((t) => t.targetRevenue)), vsTarget: r0(mean((t) => t.vsTarget)),
        loadedMiles: r0(mean((t) => t.loadedMiles)), emptyMiles: r0(mean((t) => t.emptyMiles)), days: Math.round(days * 10) / 10,
      },
    };
  }).sort((a, b) => b.trips - a.trips);

  return { ...empty, trips: kept, circuits, openTrips: kept.filter((t) => t.returned === "open").length };
}

/** What payroll paid on each leg (event id → amount), and the trip pay
 *  entered per week (layover + detention, 'driver name|week start' → amount). */
async function payrollPay(orgId: string, since: string): Promise<{ byEvent: Map<string, number>; tripPay: Map<string, number> }> {
  const weekBefore = new Date(Date.parse(`${since}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const records = await fetchAllRows<{ id: string; driver_name: string; week_start: string; line_items: unknown }>("trips payroll", () =>
    supabase.from("payroll_records").select("id, driver_name, week_start, line_items").eq("org_id", orgId).is("superseded_at", null).gte("week_start", weekBefore));
  const byEvent = new Map<string, number>();
  const tripPay = new Map<string, number>();
  for (const r of records) {
    for (const li of (Array.isArray(r.line_items) ? r.line_items : []) as Array<{ kind?: string; eventId?: string; amount?: number; category?: string }>) {
      const amount = Number(li.amount);
      if (!(amount > 0)) continue;
      if (li.kind === "load" && li.eventId) byEvent.set(li.eventId, (byEvent.get(li.eventId) ?? 0) + amount);
      else if (TRIP_PAY_CATEGORIES.has((li.category ?? "").toLowerCase())) {
        const k = `${r.driver_name.trim().toLowerCase()}|${r.week_start}`;
        tripPay.set(k, (tripPay.get(k) ?? 0) + amount);
      }
    }
  }
  return { byEvent, tripPay };
}
