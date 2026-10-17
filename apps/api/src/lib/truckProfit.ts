/**
 * Truck profit — each load's profit on the dashboard's numbers, and each
 * truck-day split into four time-of-day blocks (12a–6a, 6a–12p, 12p–6p,
 * 6p–12a) so truck overhead is priced by when the truck is tied up.
 *
 *   revenue      load revenue, split across relay legs by route miles
 *   driver pay   the leg's recorded pay ("current") or the class pay %
 *   fuel, maint  miles the truck drove for the leg (linked GPS: deadhead +
 *                loaded + return) at the dashboard's fuel price, MPG and
 *                maintenance per mile; without GPS, route miles × the
 *                class's driven-per-loaded-mile
 *   overhead     the dashboard's overhead per truck-day split across the
 *                4 blocks by the share of revenue the fleet earns in each
 *                (per class, over the dashboard's calibration weeks). A leg
 *                pays a block when its truck spends ≥1 h of it on the leg;
 *                legs sharing a block split it by hours. Blocks nothing
 *                used are the truck's unused cost. Hotels come off every
 *                load and go onto OTR truck-days.
 *   other        the dashboard's other-costs % of revenue (minus hotels)
 *
 * Local vs OTR is the dashboard's rule — any stop past the short-haul
 * radius from the terminal — applied to the leg's own stops.
 *
 * Times: calendar entries are naive org wall-clock, GPS is UTC. Everything
 * here runs on "wall ms" (the wall-clock time read as if it were UTC), so
 * days and blocks are plain multiples of 6 h.
 */

import type {
  HaulClass, LinkConfidence, Stop, TruckProfitBlock, TruckProfitCosts, TruckProfitDay,
  TruckProfitLeg, TruckProfitPay, TruckProfitResponse, TruckProfitTruck,
} from "@fleetcal/types";
import { stopsForLeg } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import { classifyByAirMiles, parseTerminal, type Coord } from "./airMiles.js";
import { getHosConfig } from "./hosService.js";
import { computeWeeklyTarget, readSettings } from "./weeklyTarget.js";
import { isExcludedEvent, loadExcludedAssetIds, loadExcludedDrivers, type ExcludedDrivers } from "./reportExclusions.js";
import { H, addDays, dayOf, fetchLegActuals, hoursWithin, legWindow, naiveMs, slicesOf, timeShares, utcToWallMs, wallStr } from "./legTime.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

/** A leg pays for a block once its truck spends this long of it on the leg. */
const MIN_BLOCK_HOURS = 1;
/** Below this much revenue a class's shares fall back to even. */
const MIN_SHARE_REVENUE = 5000;
const EVEN = [0.25, 0.25, 0.25, 0.25];
const EVEN_DAYS = [1, 1, 1, 1, 1, 1, 1].map((x) => x / 7);
const dowOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const CHUNK = 150;
const SHARES_TTL_MS = 6 * H;
/** Bounds on scaling a truck's GPS miles to its odometer (bad reads). */
const MAX_ODO_SCALE = 4;

// ── Legs ────────────────────────────────────────────────────────────────

interface Ctx { tz: string; terminal: Coord | null; excluded: ExcludedDrivers; excludedAssets: Set<number> }

interface RawLeg {
  eventId: string;
  loadId: string | null;
  loadNum: string | null;
  assetId: number;
  driverName: string | null;
  revenueLeg: boolean;
  cls: HaulClass;
  revenue: number;
  /** Recorded pay for this leg, or the load's recorded pay split by truck
   *  time when it isn't recorded leg by leg; null = nothing recorded. */
  driverPayActual: number | null;
  driverPaySplit: boolean;
  routeMiles: number | null;
  gpsMiles: number | null;
  a: number;
  b: number;
  timesFromGps: boolean;
  confidence: LinkConfidence | null;
}

interface EventRow {
  id: string; load_id: string | null; asset_id: number | null; start: string; end: string | null; leg_index: number | null;
  status: string | null; event_kind: string; loaded_miles: number | null; driver_pay: number | null;
  driver_id: number | null; driver_name: string | null; title: string | null;
  loads: { load_num: string | null; total_billable: number | null; load_price: number | null; deleted_at: string | null } | null;
}
interface StopRow { event_id: string; sequence: number; type: string; is_handoff: boolean | null; lat: number | null; lng: number | null }

const EVENT_COLS = "id, load_id, asset_id, start, end, leg_index, status, event_kind, loaded_miles, driver_pay, driver_id, driver_name, title, loads(load_num, total_billable, load_price, deleted_at)";

async function inChunks<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await run(ids.slice(i, i + CHUNK)));
  return out;
}
async function plain<T>(label: string, q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

/**
 * Revenue and non-revenue legs whose calendar time touches [from − 1, to + 1].
 *
 * A relay load's revenue and its recorded driver pay are split across its
 * counted legs by truck time (lib/legTime.ts): pay is often entered on one
 * leg for the whole load, and a 3-mile Vegas pickup leg is hours of truck
 * time, not 1% of the load. Pay recorded on every leg stays leg by leg.
 */
async function loadLegs(orgId: string, from: string, to: string, ctx: Ctx, assetId: number | null): Promise<RawLeg[]> {
  const events = await fetchAllRows<EventRow>("truck profit events", () => {
    let q = supabase.from("events")
      .select(EVENT_COLS)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("asset_id", "is", null)
      .in("event_kind", ["revenue", "non_revenue"])
      .lt("start", `${addDays(to, 2)}T00:00`)
      .gt("end", `${addDays(from, -1)}T00:00`);
    if (assetId != null) q = q.eq("asset_id", assetId);
    return q;
  });
  // Counted the way the dashboard counts loads.
  const kept = (e: EventRow) =>
    e.status !== "cancelled" && !e.loads?.deleted_at
    && !(e.asset_id != null && ctx.excludedAssets.has(e.asset_id)) && !isExcludedEvent(ctx.excluded, e);
  const live = events.filter(kept);
  if (!live.length) return [];

  // Every counted leg of these loads, for the splits.
  const loadIds = [...new Set(live.map((e) => e.load_id).filter((x): x is string => !!x))];
  const siblings = (await inChunks(loadIds, (c) => plain<EventRow>("truck profit siblings",
    supabase.from("events").select(EVENT_COLS).in("load_id", c).is("deleted_at", null))))
    .filter((e) => e.event_kind === "revenue" && kept(e));
  const byId = new Map<string, EventRow>([...live, ...siblings].map((e) => [e.id, e]));
  const ids = [...byId.keys()];
  const [actuals, stops] = await Promise.all([
    fetchLegActuals(ids),
    inChunks(ids, (c) => plain<StopRow>("truck profit stops",
      supabase.from("stops").select("event_id, sequence, type, is_handoff, lat, lng").in("event_id", c))),
  ]);
  const stopsOf = new Map<string, StopRow[]>();
  for (const s of stops) stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), s]);

  const legInfo = new Map<string, { cls: HaulClass; a: number; b: number; fromGps: boolean }>();
  for (const e of byId.values()) {
    const all = (stopsOf.get(e.id) ?? [])
      .sort((x, y) => x.sequence - y.sequence)
      .map((s) => ({ ...s, type: s.type as Stop["type"], isHandoff: s.is_handoff ?? undefined }));
    const mine = stopsForLeg(all, e.leg_index ?? 0);
    const haul = ctx.terminal ? classifyByAirMiles(ctx.terminal, mine.map((s) => ({ lat: s.lat ?? undefined, lon: s.lng ?? undefined }))) : null;
    const cls: HaulClass = haul?.decided ? haul.classification : "local";
    const w = legWindow({ calStart: e.start, calEnd: e.end, actual: actuals.get(e.id), cls, tz: ctx.tz });
    legInfo.set(e.id, { cls, a: w.a, b: w.b, fromGps: w.fromGps });
  }

  // Per load: each counted leg's share of truck time, and its pay.
  const share = new Map<string, number>();
  const pay = new Map<string, { amount: number | null; split: boolean }>();
  const legsOf = new Map<string, EventRow[]>();
  for (const e of siblings) legsOf.set(e.load_id!, [...(legsOf.get(e.load_id!) ?? []), e]);
  for (const legs of legsOf.values()) {
    const sh = timeShares(legs.map((l) => legInfo.get(l.id)!));
    const recorded = legs.filter((l) => l.driver_pay != null);
    const total = recorded.reduce((x, l) => x + Number(l.driver_pay), 0);
    legs.forEach((l, i) => {
      share.set(l.id, sh[i]);
      if (recorded.length === legs.length) pay.set(l.id, { amount: Number(l.driver_pay), split: false });
      else if (recorded.length) pay.set(l.id, { amount: total * sh[i], split: legs.length > 1 });
      else pay.set(l.id, { amount: null, split: false });
    });
  }

  return live.map((e) => {
    const la = actuals.get(e.id);
    const info = legInfo.get(e.id)!;
    const revenueLeg = e.event_kind === "revenue";
    const loadRevenue = Number(e.loads?.total_billable ?? e.loads?.load_price ?? 0);
    const p = e.load_id && revenueLeg ? pay.get(e.id) : undefined;
    return {
      eventId: e.id,
      loadId: e.load_id,
      loadNum: e.loads?.load_num ?? e.title ?? null,
      assetId: e.asset_id!,
      driverName: e.driver_name,
      revenueLeg,
      cls: info.cls,
      revenue: revenueLeg ? loadRevenue * (e.load_id ? share.get(e.id) ?? 1 : 1) : 0,
      driverPayActual: p ? p.amount : e.driver_pay == null ? null : Number(e.driver_pay),
      driverPaySplit: p?.split ?? false,
      routeMiles: e.loaded_miles != null ? Number(e.loaded_miles) : la?.route_miles != null ? Number(la.route_miles) : null,
      gpsMiles: la && la.loaded_miles != null
        ? Number(la.loaded_miles) + Number(la.deadhead_miles ?? 0) + Number(la.return_miles ?? 0)
        : null,
      a: info.a,
      b: info.b,
      timesFromGps: info.fromGps,
      confidence: la?.confidence ?? null,
    };
  }).filter((l) => Number.isFinite(l.a) && Number.isFinite(l.b));
}

// ── Block shares ────────────────────────────────────────────────────────

/**
 * Where the fleet earns its revenue in time: the share by day of the week
 * (0 = Sunday, whole fleet) and the share by block of the day (per class —
 * local afternoons pay, OTR runs around the clock). A day's price is
 * overhead per truck-day × 7 × its day share, so every truck's week adds
 * up to exactly 7 truck-days of overhead; its four blocks split that by
 * the day's class (OTR if the truck worked an OTR load that day).
 * (Measured separately: 8 weeks is too thin to price all 28 day × block
 * combinations on their own.)
 */
interface Shares {
  local: number[]; otr: number[];
  days: number[];
  /** Truck-blocks a week spent on OTR loads (≥1 h), for sizing hotels. */
  otrBlocksPerWeek: number;
  measured: boolean;
  activeAssets: Set<number>;
}
const sharesCache = new Map<string, { at: number; value: Promise<Shares> }>();

/** Share of revenue earned in each block, per class, over the calibration weeks. */
async function measureShares(orgId: string, from: string, to: string, ctx: Ctx): Promise<Shares> {
  const legs = await loadLegs(orgId, from, to, ctx, null);
  const rev: Record<HaulClass, number[]> = { local: [0, 0, 0, 0], otr: [0, 0, 0, 0] };
  const byDay = [0, 0, 0, 0, 0, 0, 0];
  const otrBlocks = new Set<string>();
  for (const l of legs) {
    if (!l.revenueLeg) continue;
    const ss = slicesOf(l.a, l.b);
    if (l.cls === "otr") {
      for (const x of ss) if (x.date >= from && x.date <= to && x.hours >= MIN_BLOCK_HOURS) otrBlocks.add(`${l.assetId}|${x.date}|${x.block}`);
    }
    if (l.revenue <= 0) continue;
    const total = ss.reduce((s, x) => s + x.hours, 0);
    for (const s of ss) {
      if (s.date < from || s.date > to) continue;
      const amt = l.revenue * s.hours / total;
      rev[l.cls][s.block] += amt;
      byDay[dowOf(s.date)] += amt;
    }
  }
  const norm = (r: number[], even: number[]) => {
    const t = r.reduce((x, y) => x + y, 0);
    return t >= MIN_SHARE_REVENUE ? r.map((x) => x / t) : even;
  };
  const local = norm(rev.local, EVEN);
  const otr = norm(rev.otr, EVEN);
  return {
    local, otr,
    days: norm(byDay, EVEN_DAYS),
    otrBlocksPerWeek: otrBlocks.size / ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 24 * H) + 1 / 7),
    measured: local !== EVEN || otr !== EVEN,
    activeAssets: new Set(legs.map((l) => l.assetId)),
  };
}

function blockShares(orgId: string, from: string, to: string, ctx: Ctx): Promise<Shares> {
  const key = `${orgId}|${from}|${to}`;
  const hit = sharesCache.get(key);
  if (hit && Date.now() - hit.at < SHARES_TTL_MS) return hit.value;
  const value = measureShares(orgId, from, to, ctx);
  sharesCache.set(key, { at: Date.now(), value });
  value.catch(() => sharesCache.delete(key));
  return value;
}

// ── The model ───────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;
const zero = (): TruckProfitCosts => ({ revenue: 0, driverPay: 0, fuel: 0, maintenance: 0, overhead: 0, other: 0, profit: 0 });
function addInto(t: TruckProfitCosts, c: TruckProfitCosts, f = 1) {
  t.revenue += c.revenue * f; t.driverPay += c.driverPay * f; t.fuel += c.fuel * f;
  t.maintenance += c.maintenance * f; t.overhead += c.overhead * f; t.other += c.other * f; t.profit += c.profit * f;
}
function round<T extends TruckProfitCosts>(c: T): T {
  return { ...c, revenue: r2(c.revenue), driverPay: r2(c.driverPay), fuel: r2(c.fuel), maintenance: r2(c.maintenance), overhead: r2(c.overhead), other: r2(c.other), profit: r2(c.profit) };
}

export async function computeTruckProfit(
  orgId: string,
  opts: { from: string; to: string; pay: TruckProfitPay; assetId?: number | null },
): Promise<TruckProfitResponse> {
  const { from, to, pay } = opts;
  const assetId = opts.assetId ?? null;
  const [wt, hos, settings, excluded, excludedAssets, targetSettings] = await Promise.all([
    computeWeeklyTarget(orgId, { from, to }),
    getHosConfig(orgId),
    supabase.from("org_settings").select("hos_settings").eq("org_id", orgId).maybeSingle(),
    loadExcludedDrivers(orgId),
    loadExcludedAssetIds(orgId),
    readSettings(orgId),
  ]);
  const ctx: Ctx = { tz: hos.timeZone, terminal: parseTerminal(settings.data?.hos_settings), excluded, excludedAssets };

  // The dashboard's numbers, with hotels moved onto the blocks a truck
  // spends on OTR loads.
  const p = wt.params;
  const otrDaysPerWeek = p.truckDaysPerWeekByClass?.otr ?? 0;
  const hotels = otrDaysPerWeek > 0 ? p.hotels : { weekly: 0, fixedWeekly: 0, perMile: 0, revenuePct: 0 };
  const hotelsPerOtrDay = otrDaysPerWeek > 0 ? hotels.weekly / otrDaysPerWeek : 0;
  const baseOverhead = Math.max(0, p.fixedWeekly.value - hotels.fixedWeekly) / Math.max(1, p.truckDaysPerWeek);
  const maintPerMile = Math.max(0, p.maintPerMile - hotels.perMile);
  const otherPct = Math.max(0, p.revenuePctOther - hotels.revenuePct);
  const fuelPerMile = p.fuelPrice.value / p.mpg.value;
  const payPct: Record<HaulClass, number> = { local: p.payPct.local, otr: p.payPct.otr };
  const drivenPer: Record<HaulClass, number> = { local: p.localDrivenPerLoaded.value, otr: p.otrDrivenPerLoaded.value };

  const nowWall = utcToWallMs(new Date().toISOString(), ctx.tz);
  const today = dayOf(nowWall);
  const odoTo = to < today ? to : today;
  const [shares, raw, assets, drives, odoReads] = await Promise.all([
    blockShares(orgId, wt.calibration.from, wt.calibration.to, ctx),
    loadLegs(orgId, from, to, ctx, assetId),
    fetchAllRows<{ id: number; name: string; type: string; hidden: boolean; sort_order: number; motive_vehicle_id: string | null }>("truck profit assets", () =>
      supabase.from("assets").select("id, name, type, hidden, sort_order, motive_vehicle_id").eq("org_id", orgId)),
    fetchAllRows<{ id: string; asset_id: number; start_time: string; end_time: string | null; miles: number | null }>("truck profit drives", () =>
      supabase.from("movements").select("id, asset_id, start_time, end_time, miles")
        .eq("org_id", orgId).eq("source", "motive").is("deleted_at", null)
        .gte("start_time", `${addDays(from, -1)}T00:00:00Z`).lt("start_time", `${addDays(to, 2)}T00:00:00Z`)),
    // Odometer, read exactly as the dashboard does (lib/weeklyTarget eldMiles).
    from <= today
      ? fetchAllRows<{ id: number; vehicle_id: string | number; odometer_miles: number | string }>("truck profit odometer", () =>
        supabase.from("motive_odometer_readings").select("id, vehicle_id, odometer_miles")
          .eq("org_id", orgId).not("odometer_miles", "is", null)
          .gte("captured_at", `${from}T00:00:00Z`).lte("captured_at", `${addDays(odoTo, 1)}T12:00:00Z`))
      : Promise.resolve([]),
  ]);
  // Each truck's odometer miles over the days already driven.
  const odoByAsset = new Map<number, number>();
  {
    const assetOfVehicle = new Map(assets.filter((a) => a.motive_vehicle_id).map((a) => [String(a.motive_vehicle_id), a.id]));
    const span = new Map<number, [number, number]>();
    for (const r of odoReads) {
      const id = assetOfVehicle.get(String(r.vehicle_id));
      const m = Number(r.odometer_miles);
      if (id == null || !(m > 0)) continue;
      const cur = span.get(id);
      span.set(id, cur ? [Math.min(cur[0], m), Math.max(cur[1], m)] : [m, m]);
    }
    for (const [id, [lo, hi]] of span) odoByAsset.set(id, hi - lo);
  }

  // Fuel and wear on GPS trucks: miles on a linked load are spread with
  // that load (like its revenue), and every other drive — yard moves, fuel
  // runs, anything not linked — lands when it was driven. Together that's
  // every GPS mile; complete weeks land within ~1.5% of the odometer.
  const linkedDrives = new Set<string>();
  const driveIds = drives.map((d) => d.id);
  for (let i = 0; i < driveIds.length; i += CHUNK) {
    const { data, error } = await supabase.from("movement_links").select("movement_id")
      .eq("org_id", orgId).is("superseded_at", null).in("role", ["loaded", "transition"])
      .in("movement_id", driveIds.slice(i, i + CHUNK));
    if (error) throw new Error(`truck profit links: ${error.message}`);
    for (const r of (data ?? []) as Array<{ movement_id: string }>) linkedDrives.add(r.movement_id);
  }
  const gpsCells = new Map<number, Map<string, number>>();
  for (const d of drives) {
    if (linkedDrives.has(d.id)) continue;
    const miles = Number(d.miles ?? 0);
    if (!(miles > 0)) continue;
    const a = utcToWallMs(d.start_time, ctx.tz);
    const b = d.end_time ? utcToWallMs(d.end_time, ctx.tz) : a;
    const pieces = b > a ? slicesOf(a, b) : [{ date: dayOf(a), block: Math.floor(new Date(a).getUTCHours() / 6), hours: 1 }];
    const total = pieces.reduce((x, y) => x + y.hours, 0);
    let cells = gpsCells.get(d.asset_id);
    if (!cells) { cells = new Map(); gpsCells.set(d.asset_id, cells); }
    for (const piece of pieces) {
      if (piece.date < from || piece.date > to) continue;
      const key = `${piece.date}|${piece.block}`;
      cells.set(key, (cells.get(key) ?? 0) + miles * piece.hours / total);
    }
  }

  const shareOf: Record<HaulClass, number[]> = { local: shares.local, otr: shares.otr };
  // A truck's share of a standard truck's daily cost (an owned box truck
  // costs far less); the fixed costs are re-spread over the fleet so the
  // total doesn't change.
  const weights = targetSettings.settings.truckCostWeights ?? {};
  const costShare = (assetId: number) => {
    const w = Number(weights[String(assetId)]);
    return Number.isFinite(w) && w >= 0 ? w : 1;
  };
  const fleet = assets.filter((a) => !a.hidden && a.type !== "Unassigned" && a.name !== "Unassigned"
    && !excludedAssets.has(a.id) && !!a.motive_vehicle_id && shares.activeAssets.has(a.id));
  const shareSum = fleet.reduce((s, a) => s + costShare(a.id), 0);
  const standardPerDay = baseOverhead * (shareSum > 0 ? fleet.length / shareSum : 1);
  /** dayCls = the class the truck worked that day (see Shares). */
  const blockPrice = (assetId: number, dayCls: HaulClass, date: string, block: number) =>
    standardPerDay * costShare(assetId) * 7 * shares.days[dowOf(date)] * shareOf[dayCls][block];
  // Hotels per block of OTR work, sized so a typical week's OTR blocks add
  // up to the weekly hotel spend.
  const hotelsPerBlock = hotels.weekly > 0 && shares.otrBlocksPerWeek > 0
    ? hotels.weekly / shares.otrBlocksPerWeek
    : hotelsPerOtrDay / 4;

  // Per-leg variable costs.
  const legs = raw.map((l) => {
    let driverPay: number;
    let driverPaySource: "actual" | "split" | "avg";
    if (!l.revenueLeg) { driverPay = l.driverPayActual ?? 0; driverPaySource = "actual"; }
    else if (pay === "current" && l.driverPayActual != null) { driverPay = l.driverPayActual; driverPaySource = l.driverPaySplit ? "split" : "actual"; }
    else { driverPay = payPct[l.cls] * l.revenue; driverPaySource = "avg"; }
    const drivenMiles = l.gpsMiles ?? (l.routeMiles ?? 0) * drivenPer[l.cls];
    const slices = slicesOf(l.a, l.b);
    return {
      ...l, driverPay, driverPaySource, drivenMiles,
      fuel: drivenMiles * fuelPerMile,
      maintenance: drivenMiles * maintPerMile,
      other: l.revenue * otherPct,
      overhead: 0,
      slices,
      hours: slices.reduce((s, x) => s + x.hours, 0),
    };
  });

  // Block overhead, truck by truck.
  type Occ = { leg: number; hours: number };
  type Charge = { price: number; cls: HaulClass; using: Occ[] };
  const cellsByTruck = new Map<number, Map<string, Occ[]>>();
  const chargesByTruck = new Map<number, Map<string, Charge>>();
  legs.forEach((l, i) => {
    let cells = cellsByTruck.get(l.assetId);
    if (!cells) { cells = new Map(); cellsByTruck.set(l.assetId, cells); }
    for (const s of l.slices) {
      const key = `${s.date}|${s.block}`;
      cells.set(key, [...(cells.get(key) ?? []), { leg: i, hours: s.hours }]);
    }
  });
  // The class a truck worked each day: OTR if it spent a block on an OTR
  // load, local if on any load; days with no work take the truck's usual.
  const dayClsByTruck = new Map<number, Map<string, HaulClass>>();
  const usualByTruck = new Map<number, HaulClass>();
  for (const [truck, cells] of cellsByTruck) {
    const byDate = new Map<string, HaulClass>();
    let otrH = 0; let localH = 0;
    for (const [key, occ] of cells) {
      for (const o of occ) {
        if (o.hours < MIN_BLOCK_HOURS) continue;
        const c = legs[o.leg].cls;
        if (c === "otr") otrH += o.hours; else localH += o.hours;
        const date = key.slice(0, 10);
        if (c === "otr" || !byDate.has(date)) byDate.set(date, c);
      }
    }
    dayClsByTruck.set(truck, byDate);
    usualByTruck.set(truck, otrH > localH ? "otr" : "local");
  }
  const dayClass = (truck: number, date: string): HaulClass =>
    dayClsByTruck.get(truck)?.get(date) ?? usualByTruck.get(truck) ?? "local";

  for (const [truck, cells] of cellsByTruck) {
    const charges = new Map<string, Charge>();
    for (const [key, occ] of cells) {
      const using = occ.filter((o) => o.hours >= MIN_BLOCK_HOURS);
      if (!using.length) continue;
      const lead = using.reduce((m, o) => (o.hours > m.hours ? o : m));
      const cls = legs[lead.leg].cls;
      const date = key.slice(0, 10);
      const price = blockPrice(truck, dayClass(truck, date), date, Number(key.slice(-1))) + (cls === "otr" ? hotelsPerBlock : 0);
      const total = using.reduce((s, o) => s + o.hours, 0);
      for (const o of using) legs[o.leg].overhead += price * o.hours / total;
      charges.set(key, { price, cls, using });
    }
    chargesByTruck.set(truck, charges);
  }

  const costsOf = (l: (typeof legs)[number]): TruckProfitCosts => ({
    revenue: l.revenue, driverPay: l.driverPay, fuel: l.fuel, maintenance: l.maintenance,
    overhead: l.overhead, other: l.other,
    profit: l.revenue - l.driverPay - l.fuel - l.maintenance - l.overhead - l.other,
  });

  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const windowA = naiveMs(`${from}T00:00`);
  const windowB = naiveMs(`${addDays(to, 1)}T00:00`);

  const truckRows = assets
    .filter((a) => !a.hidden && a.type !== "Unassigned" && a.name !== "Unassigned" && !excludedAssets.has(a.id))
    .filter((a) => assetId == null || a.id === assetId)
    // The trucks the dashboard spreads overhead over: ones that worked in
    // its calibration weeks (with GPS), plus any that ran something now.
    .filter((a) => (!!a.motive_vehicle_id && shares.activeAssets.has(a.id)) || legs.some((l) => l.assetId === a.id))
    .sort((a, b) => a.sort_order - b.sort_order);

  // "Current" pay over whole finalized Sat–Fri weeks is the finalized
  // payroll (the dashboard's Total Payroll): load pay plus adjustments,
  // spread where the load pay landed. Each load's own panel keeps its pay.
  const shownIds = new Set(truckRows.map((a) => a.id));
  const assetHasGps = new Set(truckRows.filter((a) => a.motive_vehicle_id).map((a) => a.id));
  const wholeWeeks = dowOf(from) === 6 && dowOf(to) === 5;
  const payrollTotal = pay === "current" && wholeWeeks && wt.projection.driverPaySource === "payroll" ? wt.projection.driverPay : null;
  const legPayInWindow = legs
    .filter((l) => shownIds.has(l.assetId) && l.hours > 0)
    .reduce((sum, l) => sum + l.driverPay * hoursWithin(l.a, l.b, windowA, windowB) / l.hours, 0);
  const payScale = payrollTotal != null && legPayInWindow > 0 ? payrollTotal / legPayInWindow : 1;

  const trucks: TruckProfitTruck[] = truckRows.map((asset) => {
    const cells = cellsByTruck.get(asset.id) ?? new Map<string, Occ[]>();
    const charges = chargesByTruck.get(asset.id) ?? new Map<string, Charge>();

    const gpsMiles = assetHasGps.has(asset.id) ? gpsCells.get(asset.id) ?? new Map<string, number>() : null;
    const totals = { ...zero(), unused: 0, routeMiles: 0, linkedMiles: 0, gpsMiles: 0 };
    // Miles in a block on a GPS truck: linked loads' miles spread with the
    // load, loads not run yet at their estimate, other drives when driven.
    const blockMiles = (key: string) => {
      let m = gpsMiles?.get(key) ?? 0;
      for (const o of cells.get(key) ?? []) {
        const l = legs[o.leg];
        if ((l.gpsMiles != null || l.a > nowWall) && l.hours > 0) m += l.drivenMiles * o.hours / l.hours;
      }
      return m;
    };
    // Days already driven are scaled to the truck's odometer (what the
    // dashboard's earned view counts); GPS only decides where they land.
    let driven = 0;
    if (gpsMiles) for (const date of days) if (date <= today) for (let b = 0; b < 4; b++) driven += blockMiles(`${date}|${b}`);
    const odo = odoByAsset.get(asset.id);
    const odoScale = gpsMiles && odo != null && odo > 0 && driven > 0
      ? Math.min(MAX_ODO_SCALE, Math.max(1 / MAX_ODO_SCALE, odo / driven))
      : 1;
    const dayRows: TruckProfitDay[] = days.map((date) => {
      const worked = dayClsByTruck.get(asset.id)?.get(date) ?? null;
      const day: TruckProfitDay = { date, cls: worked, ...zero(), blocks: [], unused: 0 };
      for (let b = 0; b < 4; b++) {
        const key = `${date}|${b}`;
        const occ = cells.get(key) ?? [];
        const spread = zero();
        for (const o of occ) {
          const l = legs[o.leg];
          const f = l.hours > 0 ? o.hours / l.hours : 0;
          addInto(spread, { ...costsOf(l), overhead: 0, profit: 0 }, f);
          totals.routeMiles += (l.routeMiles ?? 0) * f;
          totals.linkedMiles += l.drivenMiles * f;
        }
        spread.driverPay *= payScale;
        if (gpsMiles) {
          const miles = blockMiles(key) * (date <= today ? odoScale : 1);
          totals.gpsMiles += miles;
          spread.fuel = miles * fuelPerMile;
          spread.maintenance = miles * maintPerMile;
        }
        const charge = charges.get(key);
        const cls = charge?.cls ?? dayClass(asset.id, date);
        const price = charge?.price ?? blockPrice(asset.id, dayClass(asset.id, date), date, b);
        spread.overhead = price;
        spread.profit = spread.revenue - spread.driverPay - spread.fuel - spread.maintenance - spread.other - price;
        addInto(day, spread);
        if (!charge) day.unused += price;
        const block: TruckProfitBlock = {
          state: !charge ? "idle" : charge.using.some((o) => legs[o.leg].revenueLeg) ? "loaded" : "non_revenue",
          cls,
          price: r2(price),
          profit: r2(spread.profit),
          eventIds: [...new Set(occ.map((o) => legs[o.leg].eventId))],
        };
        day.blocks.push(block);
      }
      addInto(totals, day);
      totals.unused += day.unused;
      return { ...round(day), unused: r2(day.unused) };
    });
    return {
      assetId: asset.id,
      name: asset.name,
      costShare: costShare(asset.id),
      days: dayRows,
      totals: {
        ...round(totals),
        unused: r2(totals.unused),
        routeMiles: Math.round(totals.routeMiles),
        linkedMiles: Math.round(totals.linkedMiles),
        gpsMiles: gpsMiles ? Math.round(totals.gpsMiles) : null,
        drivenMiles: Math.round(gpsMiles ? totals.gpsMiles : totals.linkedMiles),
      },
    };
  });

  const truckName = new Map(assets.map((a) => [a.id, a.name]));
  const legRows: TruckProfitLeg[] = legs
    .filter((l) => l.a < windowB && l.b > windowA && truckRows.some((t) => t.id === l.assetId))
    .sort((x, y) => x.a - y.a)
    .map((l) => ({
      ...round(costsOf(l)),
      eventId: l.eventId,
      loadId: l.loadId,
      loadNum: l.loadNum,
      assetId: l.assetId,
      truck: truckName.get(l.assetId) ?? "",
      driverName: l.driverName,
      revenueLeg: l.revenueLeg,
      cls: l.cls,
      start: wallStr(l.a),
      end: wallStr(l.b),
      timesFromGps: l.timesFromGps,
      routeMiles: l.routeMiles == null ? null : Math.round(l.routeMiles),
      drivenMiles: Math.round(l.drivenMiles),
      milesSource: l.gpsMiles != null ? "gps" : "estimate",
      driverPaySource: l.driverPaySource,
      perLoadedMile: l.revenueLeg && l.routeMiles ? r2(l.revenue / l.routeMiles) : null,
      breakEven: r2(wt.classes[l.cls].breakEven),
      target: r2(wt.classes[l.cls].target),
      confidence: l.confidence,
    }));

  const totals = { ...zero(), unused: 0, drivenMiles: 0, linkedMiles: 0 };
  for (const t of trucks) {
    addInto(totals, t.totals);
    totals.unused += t.totals.unused;
    totals.drivenMiles += t.totals.drivenMiles;
    totals.linkedMiles += t.totals.linkedMiles;
  }

  return {
    from, to, pay,
    params: {
      fuelPrice: r2(p.fuelPrice.value),
      mpg: r2(p.mpg.value),
      maintPerMile: Math.round(maintPerMile * 1000) / 1000,
      otherPct: Math.round(otherPct * 10000) / 10000,
      payPct,
      overheadPerTruckDay: { local: r2(standardPerDay), otr: r2(standardPerDay) },
      hotelsPerOtrDay: r2(hotelsPerBlock * 4),
      blockShares: { local: shares.local, otr: shares.otr },
      dayShares: shares.days,
      blockSharesMeasured: shares.measured,
      breakEven: { local: r2(wt.classes.local.breakEven), otr: r2(wt.classes.otr.breakEven) },
      target: { local: r2(wt.classes.local.target), otr: r2(wt.classes.otr.target) },
      marginTarget: p.marginTarget.value,
      calibration: wt.calibration,
    },
    trucks,
    legs: legRows,
    totals: { ...round(totals), unused: r2(totals.unused), drivenMiles: totals.drivenMiles, linkedMiles: totals.linkedMiles },
    payroll: payrollTotal != null ? { total: r2(payrollTotal), loadPay: r2(legPayInWindow) } : null,
  };
}
