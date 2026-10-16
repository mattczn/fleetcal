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
import { computeWeeklyTarget } from "./weeklyTarget.js";
import { isExcludedEvent, loadExcludedAssetIds, loadExcludedDrivers, type ExcludedDrivers } from "./reportExclusions.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const H = 3_600_000;
const DAY = 24 * H;
const BLOCK_MS = 6 * H;
/** A leg pays for a block once its truck spends this long of it on the leg. */
const MIN_BLOCK_HOURS = 1;
const MAX_LEG_MS = 14 * DAY;
/** Longer than this at a handoff = the trailer was parked, not a relay meet. */
const PARKED_HANDOFF_HOURS = 6;
/** Time allowed to drop or hook a trailer at a parked handoff. */
const HANDOFF_HOURS = 0.5;
/** Below this much revenue a class's block shares fall back to even. */
const MIN_SHARE_REVENUE = 5000;
const EVEN = [0.25, 0.25, 0.25, 0.25];
const CHUNK = 150;
const SHARES_TTL_MS = 6 * H;

// ── Time helpers ────────────────────────────────────────────────────────

const naiveMs = (s: string) => Date.parse(`${s.slice(0, 16)}:00Z`);
const wallStr = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => dayOf(Date.parse(`${d}T00:00:00Z`) + n * DAY);

const formatters = new Map<string, Intl.DateTimeFormat>();
function utcToWallMs(iso: string, tz: string): number {
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

interface Slice { date: string; block: number; hours: number }
/** The (day, block) pieces of a wall-clock interval. */
function slicesOf(a: number, b: number): Slice[] {
  const out: Slice[] = [];
  for (let t = a; t < b;) {
    const start = Math.floor(t / BLOCK_MS) * BLOCK_MS;
    const next = Math.min(b, start + BLOCK_MS);
    out.push({ date: dayOf(start), block: new Date(start).getUTCHours() / 6, hours: (next - t) / H });
    t = next;
  }
  return out;
}

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
  driverPayActual: number | null;
  routeMiles: number | null;
  gpsMiles: number | null;
  a: number;
  b: number;
  timesFromGps: boolean;
  confidence: LinkConfidence | null;
}

interface EventRow {
  id: string; load_id: string | null; asset_id: number; start: string; end: string | null; leg_index: number | null;
  status: string | null; event_kind: string; loaded_miles: number | null; driver_pay: number | null;
  driver_id: number | null; driver_name: string | null; title: string | null;
  loads: { load_num: string | null; total_billable: number | null; load_price: number | null; deleted_at: string | null } | null;
}
interface ActualRow {
  event_id: string; truck_start: string | null; truck_end: string | null; route_miles: number | null;
  loaded_miles: number | null; deadhead_miles: number | null; return_miles: number | null;
  deadhead_hours: number | null; return_hours: number | null;
  confidence: LinkConfidence; stops: Array<{ kind?: string; arrive?: string | null; depart?: string | null }> | null;
}
interface StopRow { event_id: string; sequence: number; type: string; is_handoff: boolean | null; lat: number | null; lng: number | null }

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

/** Revenue and non-revenue legs whose calendar time touches [from − 1, to + 1]. */
async function loadLegs(orgId: string, from: string, to: string, ctx: Ctx, assetId: number | null): Promise<RawLeg[]> {
  const events = await fetchAllRows<EventRow>("truck profit events", () => {
    let q = supabase.from("events")
      .select("id, load_id, asset_id, start, end, leg_index, status, event_kind, loaded_miles, driver_pay, driver_id, driver_name, title, loads(load_num, total_billable, load_price, deleted_at)")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("asset_id", "is", null)
      .in("event_kind", ["revenue", "non_revenue"])
      .lt("start", `${addDays(to, 2)}T00:00`)
      .gt("end", `${addDays(from, -1)}T00:00`);
    if (assetId != null) q = q.eq("asset_id", assetId);
    return q;
  });
  const live = events.filter((e) =>
    e.status !== "cancelled" && !e.loads?.deleted_at
    && !ctx.excludedAssets.has(e.asset_id) && !isExcludedEvent(ctx.excluded, e));
  if (!live.length) return [];

  const ids = live.map((e) => e.id);
  const loadIds = [...new Set(live.map((e) => e.load_id).filter((x): x is string => !!x))];
  const [siblings, actuals, stops] = await Promise.all([
    inChunks(loadIds, (c) => plain<{ id: string; load_id: string; loaded_miles: number | null; status: string | null }>("truck profit siblings",
      supabase.from("events").select("id, load_id, loaded_miles, status").in("load_id", c).is("deleted_at", null))),
    inChunks(ids, (c) => plain<ActualRow>("truck profit leg actuals",
      supabase.from("leg_actuals").select("event_id, truck_start, truck_end, route_miles, loaded_miles, deadhead_miles, return_miles, deadhead_hours, return_hours, confidence, stops").in("event_id", c))),
    inChunks(ids, (c) => plain<StopRow>("truck profit stops",
      supabase.from("stops").select("event_id, sequence, type, is_handoff, lat, lng").in("event_id", c))),
  ]);

  // Revenue split across a relay's legs by route miles (even when unknown).
  const share = new Map<string, number>();
  const byLoad = new Map<string, typeof siblings>();
  for (const s of siblings) if (s.status !== "cancelled") byLoad.set(s.load_id, [...(byLoad.get(s.load_id) ?? []), s]);
  for (const legs of byLoad.values()) {
    const miles = legs.map((l) => Number(l.loaded_miles ?? 0));
    const total = miles.reduce((x, y) => x + y, 0);
    const known = miles.every((m) => m > 0);
    legs.forEach((l, i) => share.set(l.id, known && total > 0 ? miles[i] / total : 1 / legs.length));
  }
  const actualOf = new Map(actuals.map((r) => [r.event_id, r]));
  const stopsOf = new Map<string, StopRow[]>();
  for (const s of stops) stopsOf.set(s.event_id, [...(stopsOf.get(s.event_id) ?? []), s]);

  return live.map((e) => {
    const la = actualOf.get(e.id);
    const all = (stopsOf.get(e.id) ?? [])
      .sort((x, y) => x.sequence - y.sequence)
      .map((s) => ({ ...s, type: s.type as Stop["type"], isHandoff: s.is_handoff ?? undefined }));
    const mine = stopsForLeg(all, e.leg_index ?? 0);
    const haul = ctx.terminal ? classifyByAirMiles(ctx.terminal, mine.map((s) => ({ lat: s.lat ?? undefined, lon: s.lng ?? undefined }))) : null;
    const cls: HaulClass = haul?.decided ? haul.classification : "local";
    const revenueLeg = e.event_kind === "revenue";
    const loadRevenue = Number(e.loads?.total_billable ?? e.loads?.load_price ?? 0);

    const gps = !!(la?.truck_start && la?.truck_end);
    let a = gps ? utcToWallMs(la!.truck_start!, ctx.tz) : naiveMs(e.start);
    let b = gps ? utcToWallMs(la!.truck_end!, ctx.tz) : e.end ? naiveMs(e.end) : a + H;
    // A local truck parked away before its first stop or after its last
    // (left Friday, sat by the shipper all weekend) isn't working the
    // load: count the drive out, the stops, and the drive home. OTR keeps
    // its nights out — that time belongs to the trip.
    const firstArrive = la?.stops?.[0]?.arrive;
    const lastDepart = la?.stops?.length ? la.stops[la.stops.length - 1]?.depart : null;
    if (gps && cls === "local" && firstArrive) {
      const cut = utcToWallMs(firstArrive, ctx.tz) - Number(la!.deadhead_hours ?? 0) * H;
      if (cut > a && cut < b) a = cut;
    }
    if (gps && cls === "local" && lastDepart) {
      const cut = utcToWallMs(lastDepart, ctx.tz) + Number(la!.return_hours ?? 0) * H;
      if (cut > a && cut < b) b = cut;
    }
    // A relay trailer parked at a handoff (dropped at the yard, taken days
    // later) isn't either leg's time: the leg ending there ends at the
    // drop, the one starting there starts at the pickup.
    const dwellH = (st?: { arrive?: string | null; depart?: string | null }) =>
      st?.arrive && st?.depart ? (Date.parse(st.depart) - Date.parse(st.arrive)) / H : 0;
    const firstStop = la?.stops?.[0];
    const lastStop = la?.stops?.length ? la.stops[la.stops.length - 1] : undefined;
    if (gps && lastStop?.kind === "handoff" && lastStop.arrive && dwellH(lastStop) > PARKED_HANDOFF_HOURS) {
      const cut = utcToWallMs(lastStop.arrive, ctx.tz) + HANDOFF_HOURS * H + Number(la!.return_hours ?? 0) * H;
      if (cut > a && cut < b) b = cut;
    }
    if (gps && firstStop?.kind === "handoff" && firstStop.depart && dwellH(firstStop) > PARKED_HANDOFF_HOURS) {
      const cut = utcToWallMs(firstStop.depart, ctx.tz) - HANDOFF_HOURS * H;
      if (cut > a && cut < b) a = cut;
    }
    if (!(b > a)) b = a + H;
    if (b - a > MAX_LEG_MS) b = a + MAX_LEG_MS;
    if (!Number.isFinite(a)) a = b = 0;

    return {
      eventId: e.id,
      loadId: e.load_id,
      loadNum: e.loads?.load_num ?? e.title ?? null,
      assetId: e.asset_id,
      driverName: e.driver_name,
      revenueLeg,
      cls,
      revenue: revenueLeg ? loadRevenue * (e.load_id ? share.get(e.id) ?? 1 : 1) : 0,
      driverPayActual: e.driver_pay == null ? null : Number(e.driver_pay),
      routeMiles: e.loaded_miles != null ? Number(e.loaded_miles) : la?.route_miles != null ? Number(la.route_miles) : null,
      gpsMiles: la && la.loaded_miles != null
        ? Number(la.loaded_miles) + Number(la.deadhead_miles ?? 0) + Number(la.return_miles ?? 0)
        : null,
      a, b,
      timesFromGps: gps,
      confidence: la?.confidence ?? null,
    };
  }).filter((l) => l.b > 0);
}

// ── Block shares ────────────────────────────────────────────────────────

interface Shares { local: number[]; otr: number[]; measured: boolean; activeAssets: Set<number> }
const sharesCache = new Map<string, { at: number; value: Promise<Shares> }>();

/** Share of revenue earned in each block, per class, over the calibration weeks. */
async function measureShares(orgId: string, from: string, to: string, ctx: Ctx): Promise<Shares> {
  const legs = await loadLegs(orgId, from, to, ctx, null);
  const rev: Record<HaulClass, number[]> = { local: [0, 0, 0, 0], otr: [0, 0, 0, 0] };
  for (const l of legs) {
    if (!l.revenueLeg || l.revenue <= 0) continue;
    const ss = slicesOf(l.a, l.b);
    const total = ss.reduce((s, x) => s + x.hours, 0);
    for (const s of ss) if (s.date >= from && s.date <= to) rev[l.cls][s.block] += l.revenue * s.hours / total;
  }
  const norm = (r: number[]) => {
    const t = r.reduce((x, y) => x + y, 0);
    return t >= MIN_SHARE_REVENUE ? r.map((x) => x / t) : EVEN;
  };
  const local = norm(rev.local);
  const otr = norm(rev.otr);
  return { local, otr, measured: local !== EVEN || otr !== EVEN, activeAssets: new Set(legs.map((l) => l.assetId)) };
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
  const [wt, hos, settings, excluded, excludedAssets] = await Promise.all([
    computeWeeklyTarget(orgId, { from, to }),
    getHosConfig(orgId),
    supabase.from("org_settings").select("hos_settings").eq("org_id", orgId).maybeSingle(),
    loadExcludedDrivers(orgId),
    loadExcludedAssetIds(orgId),
  ]);
  const ctx: Ctx = { tz: hos.timeZone, terminal: parseTerminal(settings.data?.hos_settings), excluded, excludedAssets };

  // The dashboard's numbers, with hotels moved onto OTR truck-days.
  const p = wt.params;
  const otrDaysPerWeek = p.truckDaysPerWeekByClass?.otr ?? 0;
  const hotels = otrDaysPerWeek > 0 ? p.hotels : { weekly: 0, fixedWeekly: 0, perMile: 0, revenuePct: 0 };
  const hotelsPerOtrDay = otrDaysPerWeek > 0 ? hotels.weekly / otrDaysPerWeek : 0;
  const baseOverhead = Math.max(0, p.fixedWeekly.value - hotels.fixedWeekly) / Math.max(1, p.truckDaysPerWeek);
  const overhead: Record<HaulClass, number> = { local: baseOverhead, otr: baseOverhead + hotelsPerOtrDay };
  const maintPerMile = Math.max(0, p.maintPerMile - hotels.perMile);
  const otherPct = Math.max(0, p.revenuePctOther - hotels.revenuePct);
  const fuelPerMile = p.fuelPrice.value / p.mpg.value;
  const payPct: Record<HaulClass, number> = { local: p.payPct.local, otr: p.payPct.otr };
  const drivenPer: Record<HaulClass, number> = { local: p.localDrivenPerLoaded.value, otr: p.otrDrivenPerLoaded.value };

  const [shares, raw, assets] = await Promise.all([
    blockShares(orgId, wt.calibration.from, wt.calibration.to, ctx),
    loadLegs(orgId, from, to, ctx, assetId),
    fetchAllRows<{ id: number; name: string; type: string; hidden: boolean; sort_order: number; motive_vehicle_id: string | null }>("truck profit assets", () =>
      supabase.from("assets").select("id, name, type, hidden, sort_order, motive_vehicle_id").eq("org_id", orgId)),
  ]);
  const shareOf: Record<HaulClass, number[]> = { local: shares.local, otr: shares.otr };
  const blockPrice = (cls: HaulClass, block: number) => overhead[cls] * shareOf[cls][block];

  // Per-leg variable costs.
  const legs = raw.map((l) => {
    let driverPay: number;
    let driverPaySource: "actual" | "avg";
    if (!l.revenueLeg) { driverPay = l.driverPayActual ?? 0; driverPaySource = "actual"; }
    else if (pay === "current" && l.driverPayActual != null) { driverPay = l.driverPayActual; driverPaySource = "actual"; }
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
  for (const [truck, cells] of cellsByTruck) {
    const charges = new Map<string, Charge>();
    for (const [key, occ] of cells) {
      const using = occ.filter((o) => o.hours >= MIN_BLOCK_HOURS);
      if (!using.length) continue;
      const lead = using.reduce((m, o) => (o.hours > m.hours ? o : m));
      const cls = legs[lead.leg].cls;
      const price = blockPrice(cls, Number(key.slice(-1)));
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

  const trucks: TruckProfitTruck[] = truckRows.map((asset) => {
    const cells = cellsByTruck.get(asset.id) ?? new Map<string, Occ[]>();
    const charges = chargesByTruck.get(asset.id) ?? new Map<string, Charge>();
    const mine = legs.filter((l) => l.assetId === asset.id);
    // Idle time is priced at the truck's usual class this period.
    const otrHours = mine.filter((l) => l.cls === "otr").reduce((s, l) => s + l.hours, 0);
    const localHours = mine.filter((l) => l.cls === "local").reduce((s, l) => s + l.hours, 0);
    const usual: HaulClass = otrHours > localHours ? "otr" : "local";

    const totals = { ...zero(), unused: 0, routeMiles: 0, drivenMiles: 0 };
    const dayRows: TruckProfitDay[] = days.map((date) => {
      const touching = [0, 1, 2, 3].flatMap((b) => cells.get(`${date}|${b}`) ?? []).map((o) => legs[o.leg]);
      const dayCls: HaulClass | null = touching.some((l) => l.cls === "otr") ? "otr" : touching.length ? "local" : null;
      const day: TruckProfitDay = { date, cls: dayCls, ...zero(), blocks: [], unused: 0 };
      for (let b = 0; b < 4; b++) {
        const key = `${date}|${b}`;
        const occ = cells.get(key) ?? [];
        const spread = zero();
        for (const o of occ) {
          const l = legs[o.leg];
          const f = l.hours > 0 ? o.hours / l.hours : 0;
          addInto(spread, { ...costsOf(l), overhead: 0, profit: 0 }, f);
          totals.routeMiles += (l.routeMiles ?? 0) * f;
          totals.drivenMiles += l.drivenMiles * f;
        }
        const charge = charges.get(key);
        const cls = charge?.cls ?? dayCls ?? usual;
        const price = charge?.price ?? blockPrice(cls, b);
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
      days: dayRows,
      totals: { ...round(totals), unused: r2(totals.unused), routeMiles: Math.round(totals.routeMiles), drivenMiles: Math.round(totals.drivenMiles) },
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

  const totals = { ...zero(), unused: 0 };
  for (const t of trucks) { addInto(totals, t.totals); totals.unused += t.totals.unused; }

  return {
    from, to, pay,
    params: {
      fuelPrice: r2(p.fuelPrice.value),
      mpg: r2(p.mpg.value),
      maintPerMile: Math.round(maintPerMile * 1000) / 1000,
      otherPct: Math.round(otherPct * 10000) / 10000,
      payPct,
      overheadPerTruckDay: { local: r2(overhead.local), otr: r2(overhead.otr) },
      hotelsPerOtrDay: r2(hotelsPerOtrDay),
      blockShares: { local: shares.local, otr: shares.otr },
      blockSharesMeasured: shares.measured,
      breakEven: { local: r2(wt.classes.local.breakEven), otr: r2(wt.classes.otr.breakEven) },
      target: { local: r2(wt.classes.local.target), otr: r2(wt.classes.otr.target) },
      marginTarget: p.marginTarget.value,
      calibration: wt.calibration,
    },
    trucks,
    legs: legRows,
    totals: { ...round(totals), unused: r2(totals.unused) },
  };
}
