/**
 * Lane rates — what to quote between two areas (lib/payAreas.ts), from
 * the last LOOKBACK_DAYS of loads and the dashboard's cost numbers.
 *
 * For each region pair (first stop's area → last stop's area):
 *   market     what those loads billed: median, middle half, $/loaded mile
 *   cost       driver pay — your full-load standard for the pair, else
 *              what was actually paid — + fuel and maintenance on the
 *              driven miles (loaded × the dashboard's driven-per-loaded for
 *              local / OTR) + truck time (6-hour blocks at overhead per
 *              truck-day ÷ 4) + hotels on OTR blocks
 *   breakEven  cost ÷ (1 − other % of revenue)
 *   target     cost ÷ (1 − other % − your margin)
 *   balanced   for an OTR outbound / inbound pair whose reverse also runs, the
 *              two targets added up and split by each direction's market
 *              rate — the cheap direction can go below its own target as
 *              long as the trip back makes it up
 *   yours      an amount you set for the pair (route_pay_config.pairTargets)
 *   relay      the pickup + linehaul + delivery chain's pay, when all three
 *              are set, next to the one-driver pay
 */

import type { HaulClass, LaneDirection, LaneRatePair, LaneRatesResponse, WeeklyTargetResponse } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { classifyByAirMiles } from "./airMiles.js";
import { computeWeeklyTarget, readSettings } from "./weeklyTarget.js";
import { areaLocator, laneDirection, readAreasAndLanes } from "./payAreas.js";
import { readRateConfig } from "./rateCard.js";
import { fetchLegActuals } from "./legTime.js";
import { staleCache } from "./staleCache.js";
import { isExcludedEvent, loadExcludedAssetIds, loadExcludedDrivers } from "./reportExclusions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const LOOKBACK_DAYS = 120;
const MIN_BALANCE_LOADS = 3;
const CHUNK = 150;
const EST_MPH = 45;
const EST_HOURS_PER_STOP = 0.75;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const r0 = (n: number) => Math.round(n);

interface LoadSample { rate: number; miles: number; pay: number | null; hours: number; cls: HaulClass }

/** The dashboard's cost numbers, per mile / block / truck-day. */
export function laneCostParams(p: WeeklyTargetResponse["params"]) {
  const otrBlocksPerWeek = (p.truckDaysPerWeekByClass?.otr ?? 0) * 4;
  return {
    fuelPerMile: p.fuelPrice.value / p.mpg.value,
    maintPerMile: p.maintPerMile,
    otherPct: p.revenuePctOther,
    margin: p.marginTarget.value,
    overheadPerTruckDay: p.overheadPerTruckDay,
    hotelsPerBlock: otrBlocksPerWeek > 0 ? p.hotels.weekly / otrBlocksPerWeek : 0,
    drivenPer: { local: p.localDrivenPerLoaded.value, otr: p.otrDrivenPerLoaded.value } as Record<HaulClass, number>,
  };
}

const cache = staleCache(buildLaneRates, 10 * 60_000, 12 * 3_600_000);

/** Lane rates — from memory, rebuilt in the background every few minutes;
 *  your targets and ranking are read fresh on every call. */
export async function laneRates(orgId: string, opts: { fresh?: boolean } = {}): Promise<LaneRatesResponse> {
  const [r, cfg] = await Promise.all([cache.get(orgId, opts), readRateConfig(orgId)]);
  return {
    ...r,
    corridorOrder: cfg.config.corridorOrder ?? [],
    pairs: r.pairs.map((p) => ({ ...p, yourTarget: cfg.config.pairTargets?.[p.key] ?? null })),
  };
}
/** Rebuild now — areas or lane pay changed. */
export const invalidateLaneRates = (orgId: string) => cache.invalidate(orgId);

async function buildLaneRates(orgId: string): Promise<LaneRatesResponse> {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [wt, al, cfg, stored, excluded, excludedAssets] = await Promise.all([
    computeWeeklyTarget(orgId),
    readAreasAndLanes(orgId),
    readRateConfig(orgId),
    readSettings(orgId),
    loadExcludedDrivers(orgId),
    loadExcludedAssetIds(orgId),
  ]);
  const p = wt.params;
  const params = laneCostParams(p);
  const { fuelPerMile, otherPct, margin, hotelsPerBlock, drivenPer } = params;
  const blockOverhead = p.overheadPerTruckDay / 4;
  const terminal = stored.terminal;

  const empty: LaneRatesResponse = {
    available: al.available, lookbackDays: LOOKBACK_DAYS, since, until: today, pairs: [], loadsOutsideAreas: 0,
    areas: al.areas.map((a) => ({ id: a.id, name: a.name, color: a.color, isHome: a.isHome, homeId: a.homeId })),
    params,
    corridorOrder: cfg.config.corridorOrder ?? [],
  };
  if (!al.available || !al.areas.length) return empty;
  const locate = areaLocator(al.areas);
  const areaById = new Map(al.areas.map((a) => [a.id, a]));

  // Loads in the window: legs, first leg's stops (every leg carries the full list), GPS hours.
  type Ev = {
    id: string; load_id: string; leg_index: number | null; start: string; end: string | null; status: string | null;
    driver_pay: number | null; loaded_miles: number | null; driver_id: number | null; driver_name: string | null; asset_id: number | null;
    loads: { total_billable: number | null; load_price: number | null; deleted_at: string | null } | null;
  };
  const events = await fetchAllRows<Ev>("lane rates events", () => supabase.from("events")
    .select("id, load_id, leg_index, start, end, status, driver_pay, loaded_miles, driver_id, driver_name, asset_id, loads(total_billable, load_price, deleted_at)")
    .eq("org_id", orgId).is("deleted_at", null).eq("event_kind", "revenue").not("load_id", "is", null)
    .gte("start", since).lte("start", `${today}T23:59`));
  const byLoad = new Map<string, Ev[]>();
  for (const e of events) {
    if (e.status === "cancelled" || e.loads?.deleted_at) continue;
    if (isExcludedEvent(excluded, e) || (e.asset_id != null && excludedAssets.has(e.asset_id))) continue;
    byLoad.set(e.load_id, [...(byLoad.get(e.load_id) ?? []), e]);
  }
  const firstIds = [...byLoad.values()].map((ls) => ls.sort((a, b) => (a.leg_index ?? 0) - (b.leg_index ?? 0))[0].id);
  const stops: Array<{ event_id: string; sequence: number; lat: number | null; lng: number | null }> = [];
  for (let i = 0; i < firstIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("stops").select("event_id, sequence, lat, lng").in("event_id", firstIds.slice(i, i + CHUNK));
    if (error) throw new Error(`lane rates stops: ${error.message}`);
    stops.push(...data);
  }
  const stopsOf = new Map<string, typeof stops>();
  for (const s of stops) stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), s]);
  const actuals = await fetchLegActuals(events.map((e) => e.id));

  const samples = new Map<string, LoadSample[]>();
  let outside = 0;
  for (const legs of byLoad.values()) {
    const st = (stopsOf.get(legs[0].id) ?? []).filter((x) => x.lat != null && x.lng != null).sort((a, b) => a.sequence - b.sequence);
    if (st.length < 2) continue;
    const from = locate({ lat: Number(st[0].lat), lng: Number(st[0].lng) });
    const to = locate({ lat: Number(st[st.length - 1].lat), lng: Number(st[st.length - 1].lng) });
    if (!from || !to) { outside++; continue; }
    const rate = Number(legs[0].loads?.total_billable ?? legs[0].loads?.load_price ?? 0);
    const miles = legs.reduce((s, l) => s + Number(l.loaded_miles ?? 0), 0);
    if (!(rate > 0) || !(miles > 0)) continue;
    const paid = legs.filter((l) => l.driver_pay != null);
    // Truck time from GPS when every leg is linked; calendar windows run all
    // day on local work, so otherwise it's estimated from miles and stops.
    const gps = legs.map((l) => actuals.get(l.id)).filter((la) => la?.truck_start && la.truck_end);
    const hours = gps.length === legs.length
      ? gps.reduce((s, la) => s + Math.max(0.5, Math.min(14 * 24, (Date.parse(la!.truck_end!) - Date.parse(la!.truck_start!)) / 3_600_000)), 0)
      : miles / EST_MPH + EST_HOURS_PER_STOP * st.length;
    const haul = terminal ? classifyByAirMiles(terminal, st.map((x) => ({ lat: Number(x.lat), lon: Number(x.lng) }))) : null;
    const key = `${from.id}>${to.id}`;
    samples.set(key, [...(samples.get(key) ?? []), {
      rate, miles, hours, cls: haul?.decided ? haul.classification : "local",
      pay: paid.length === legs.length ? paid.reduce((s, l) => s + Number(l.driver_pay), 0) : null,
    }]);
  }

  const laneAmount = (from: number, to: number, kind: string) =>
    al.lanes.find((l) => l.fromAreaId === from && l.toAreaId === to && l.kind === kind)?.amount ?? null;

  const pairs: LaneRatePair[] = [];
  for (const [key, ss] of samples) {
    const [fromId, toId] = key.split(">").map(Number);
    const A = areaById.get(fromId)!;
    const B = areaById.get(toId)!;
    const direction: LaneDirection = laneDirection(A, B, al.baseId);
    // Work inside one area or one base is local wherever it is (Vegas is "OTR" by radius from SLC).
    const cls: HaulClass = direction !== "local" && ss.filter((x) => x.cls === "otr").length * 2 > ss.length ? "otr" : "local";
    const rate = median(ss.map((x) => x.rate))!;
    const miles = median(ss.map((x) => x.miles))!;
    const hours = median(ss.map((x) => x.hours))!;
    const paidActual = median(ss.map((x) => x.pay).filter((x): x is number => x != null));
    const fullStandard = laneAmount(fromId, toId, "whole");
    const relayParts = fromId === toId ? null : [laneAmount(fromId, fromId, "pickup"), laneAmount(fromId, toId, "transfer"), laneAmount(toId, toId, "delivery")];
    const relayPay = relayParts && relayParts.every((x) => x != null) ? relayParts.reduce((s, x) => s + (x ?? 0), 0) : null;
    const driverPay = fullStandard ?? paidActual ?? p.payPct[cls] * rate;
    const driven = miles * drivenPer[cls];
    const blocks = Math.max(1, Math.ceil(hours / 6));
    const cost = {
      driverPay, driverPayBasis: (fullStandard != null ? "standard" : paidActual != null ? "paid" : "percent") as LaneRatePair["cost"]["driverPayBasis"],
      fuel: driven * fuelPerMile, maintenance: driven * p.maintPerMile,
      overhead: blocks * blockOverhead, hotels: cls === "otr" ? blocks * hotelsPerBlock : 0,
      drivenMiles: driven, hours, blocks,
    };
    const fixed = cost.driverPay + cost.fuel + cost.maintenance + cost.overhead + cost.hotels;
    pairs.push({
      key, fromAreaId: fromId, toAreaId: toId, direction, cls, loads: ss.length,
      market: {
        rate: r0(rate), low: r0(quantile(ss.map((x) => x.rate), 0.25)!), high: r0(quantile(ss.map((x) => x.rate), 0.75)!),
        miles: r0(miles), perMile: Math.round((median(ss.map((x) => x.rate / x.miles)) ?? 0) * 100) / 100,
      },
      cost: { ...cost, driverPay: r0(cost.driverPay), fuel: r0(cost.fuel), maintenance: r0(cost.maintenance), overhead: r0(cost.overhead), hotels: r0(cost.hotels), drivenMiles: r0(driven), hours: Math.round(hours * 10) / 10 },
      breakEven: r0(fixed / Math.max(0.05, 1 - otherPct)),
      target: r0(fixed / Math.max(0.05, 1 - otherPct - margin)),
      balancedTarget: null,
      yourTarget: cfg.config.pairTargets?.[key] ?? null,
      relayPay, fullPay: fullStandard,
    });
  }
  // Round trips: an outbound pair and its inbound reverse share one target,
  // split by what each direction's market pays.
  const byKey = new Map(pairs.map((x) => [x.key, x]));
  for (const x of pairs) {
    if ((x.direction !== "outbound" && x.direction !== "inbound") || x.cls !== "otr") continue;
    const back = byKey.get(`${x.toAreaId}>${x.fromAreaId}`);
    if (!back || back.cls !== "otr" || x.loads < MIN_BALANCE_LOADS || back.loads < MIN_BALANCE_LOADS) continue;
    const share = x.market.rate / (x.market.rate + back.market.rate);
    x.balancedTarget = r0((x.target + back.target) * share);
  }
  pairs.sort((a, b) => b.loads - a.loads);
  return { ...empty, pairs, loadsOutsideAreas: outside };
}
