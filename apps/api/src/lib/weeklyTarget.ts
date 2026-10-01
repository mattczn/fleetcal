/**
 * Weekly profitability target — the model behind the dashboard's
 * "Weekly target" card.
 *
 *   weekly profit = revenue × (1 − pay% − other%)
 *                 − miles × (fuel $/gal ÷ MPG + maintenance $/mi)
 *                 − fixed weekly costs
 *
 * Fuel and maintenance are charged per MILE DRIVEN, not as a share of
 * revenue: weekly miles barely track weekly revenue (local/OTR mix and
 * empty running move them independently), so a model that scales fuel
 * with revenue understates break-even in exactly the weeks that matter.
 * Driver pay IS a share of revenue — drivers are paid per load.
 *
 * Miles driven aren't known until the week is over, so the projection
 * uses booked LOADED miles × the empty-mile factor (odometer miles ÷
 * loaded miles over the last 8 complete weeks).
 *
 * Every input is measured from the org's own data and can be overridden
 * in org_settings.weekly_target_settings:
 *   MPG, empty factor, pay %       — last 8 complete weeks
 *   fixed / per-mile / revenue-%   — last 3 closed months on /expenses,
 *                                    per each bucket's cost behavior
 *   fuel price                     — last 7 days of fuel transactions
 *   margin target                  — trailing operating margin
 *
 * Report-excluded drivers and trucks (owner-operators) are out of every
 * number: their revenue and payouts are accounted for on their own.
 */

import type {
  BucketBasis,
  CostBehavior,
  HaulClass,
  WeeklyTargetClassTotals,
  WeeklyTargetParam,
  WeeklyTargetResponse,
  WeeklyTargetSettings,
} from "@fleetcal/types";
import { UNCATEGORIZED_BUCKET_ID } from "@fleetcal/types";
import { supabase as supabaseTyped } from "./supabase.js";
import { fetchAllRows } from "./fetchAllRows.js";
import {
  loadExcludedAssetIds,
  loadExcludedDrivers,
  isExcludedEvent,
  type ExcludedDrivers,
} from "./reportExclusions.js";
import { airMilesBetween, classifyByAirMiles, isUsableCoord, parseTerminal, type Coord } from "./airMiles.js";
import { snapshot, type Window as ExpenseWindow } from "../routes/expenses.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const DAY = 86_400_000;
const CALIBRATION_WEEKS = 8;
const COST_BASIS_MONTHS = 3;
/** Road miles per air mile, for loads whose leg miles were never cached. */
const ROAD_FACTOR = 1.2;
const STOP_BATCH = 150;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => iso(parseDay(d) + n * DAY);
export function saturdayOf(d: string): string {
  const t = parseDay(d);
  return iso(t - ((new Date(t).getUTCDay() + 1) % 7) * DAY);
}
const mkWindow = (from: string, to: string): ExpenseWindow => ({
  from, to, fromTs: `${from}T00:00:00Z`, toTs: `${to}T23:59:59Z`,
  days: Math.round((parseDay(to) - parseDay(from)) / DAY) + 1,
});

// ── Load economics ──────────────────────────────────────────────────────

interface EventRow {
  id: string;
  load_id: string;
  start: string;
  leg_index: number | null;
  status: string | null;
  driver_id: number | null;
  driver_name: string | null;
  asset_id: number | null;
  driver_pay: number | string | null;
  loaded_miles: number | string | null;
  loads: { total_billable: number | string | null; load_price: number | string | null; deleted_at: string | null } | null;
}

interface LoadEcon {
  pickup:       string;
  revenue:      number;
  loadedMiles:  number;
  milesMissing: boolean;
  driverPay:    number;
  payMissing:   boolean;
  cls:          HaulClass | null;
}

/**
 * One row per load whose earliest (non-cancelled, non-excluded) leg
 * starts inside [from, to]. Revenue is the whole load's; miles and pay
 * sum the remaining legs. Legs missing cached miles are estimated from
 * the stop path so the empty-mile factor isn't inflated by gaps.
 */
async function loadEconomics(
  orgId: string, from: string, to: string,
  excluded: ExcludedDrivers, excludedAssets: Set<number>,
  terminal: Coord | null, withStops: boolean,
): Promise<LoadEcon[]> {
  const events = await fetchAllRows<EventRow>("weekly-target events", () => supabase
    .from("events")
    .select("id, load_id, start, leg_index, status, driver_id, driver_name, asset_id, driver_pay, loaded_miles, loads!inner(total_billable, load_price, deleted_at)")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .eq("event_kind", "revenue")
    .not("load_id", "is", null)
    .gte("start", addDays(from, -3))
    .lte("start", `${addDays(to, 3)}T23:59`));

  const byLoad = new Map<string, EventRow[]>();
  for (const e of events) {
    if (!e.loads || e.loads.deleted_at) continue;
    if (e.status === "cancelled") continue;
    if (isExcludedEvent(excluded, e)) continue;
    if (e.asset_id != null && excludedAssets.has(e.asset_id)) continue;
    const arr = byLoad.get(e.load_id) ?? [];
    arr.push(e);
    byLoad.set(e.load_id, arr);
  }

  const kept: Array<{ legs: EventRow[]; first: EventRow; pickup: string }> = [];
  for (const legs of byLoad.values()) {
    legs.sort((a, b) => (a.leg_index ?? 0) - (b.leg_index ?? 0) || a.start.localeCompare(b.start));
    const pickup = legs.reduce((m, e) => (e.start < m ? e.start : m), legs[0].start).slice(0, 10);
    if (pickup < from || pickup > to) continue;
    kept.push({ legs, first: legs[0], pickup });
  }

  // Relay legs each carry the load's FULL stop list, so the first leg's
  // copy is the whole route.
  const stopsByEvent = new Map<string, Array<{ sequence: number; lat: number | null; lng: number | null }>>();
  if (withStops) {
    const ids = kept.map(k => k.first.id);
    for (let i = 0; i < ids.length; i += STOP_BATCH) {
      const slice = ids.slice(i, i + STOP_BATCH);
      const { data, error } = await supabase
        .from("stops")
        .select("event_id, sequence, lat, lng")
        .in("event_id", slice);
      if (error) throw new Error(`weekly-target stops: ${error.message}`);
      for (const s of (data ?? []) as Array<{ event_id: string; sequence: number; lat: number | null; lng: number | null }>) {
        const arr = stopsByEvent.get(s.event_id) ?? [];
        arr.push(s);
        stopsByEvent.set(s.event_id, arr);
      }
    }
  }

  return kept.map(({ legs, first, pickup }) => {
    const lo = first.loads!;
    const revenue = Number(lo.total_billable ?? lo.load_price ?? 0);
    const stops = (stopsByEvent.get(first.id) ?? [])
      .sort((a, b) => a.sequence - b.sequence)
      .map(s => ({ lat: s.lat ?? undefined, lon: s.lng ?? undefined }))
      .filter(isUsableCoord);

    const known = legs.filter(l => l.loaded_miles != null);
    let loadedMiles = known.reduce((s, l) => s + Number(l.loaded_miles), 0);
    const nullLegs = legs.length - known.length;
    if (nullLegs > 0 && stops.length > 1) {
      let path = 0;
      for (let i = 1; i < stops.length; i++) path += airMilesBetween(stops[i - 1], stops[i]);
      loadedMiles += path * ROAD_FACTOR * (nullLegs / legs.length);
    }

    const haul = terminal && stops.length ? classifyByAirMiles(terminal, stops) : null;
    return {
      pickup,
      revenue,
      loadedMiles,
      milesMissing: nullLegs > 0,
      driverPay:  legs.reduce((s, l) => s + Number(l.driver_pay ?? 0), 0),
      payMissing: legs.some(l => l.driver_pay == null),
      cls: haul?.decided ? haul.classification : null,
    };
  });
}

async function adjustmentsTotal(orgId: string, from: string, to: string, excluded: ExcludedDrivers): Promise<number> {
  const rows = await fetchAllRows<{ amount: number | string | null; driver_name: string | null }>(
    "weekly-target adjustments", () => supabase
      .from("payroll_adjustments")
      .select("amount, driver_name")
      .eq("org_id", orgId)
      .gte("week_start", from)
      .lte("week_start", to));
  return rows
    .filter(r => !(r.driver_name && excluded.nameSet.has(r.driver_name.trim())))
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
}

/** Same number as the dashboard's Total Payroll KPI for a finalized week:
 *  current (non-superseded) payroll records, owner-ops out. 0 = pending. */
async function finalizedPayroll(orgId: string, weekStart: string, excluded: ExcludedDrivers): Promise<number> {
  const rows = await fetchAllRows<{ total_pay: number | string | null; driver_name: string | null }>(
    "weekly-target payroll", () => supabase
      .from("payroll_records")
      .select("total_pay, driver_name")
      .eq("org_id", orgId)
      .eq("week_start", weekStart)
      .is("superseded_at", null));
  return rows
    .filter(r => !excluded.nameSet.has((r.driver_name ?? "").trim()))
    .reduce((s, r) => s + Number(r.total_pay ?? 0), 0);
}

/** Fleet odometer miles (max − min per ELD truck), owner-op trucks out. */
async function eldMiles(orgId: string, from: string, to: string, excludedAssets: Set<number>): Promise<{ miles: number; trucks: number }> {
  const { data: assets, error } = await supabase
    .from("assets")
    .select("id, motive_vehicle_id")
    .eq("org_id", orgId)
    .not("motive_vehicle_id", "is", null);
  if (error) throw new Error(`weekly-target assets: ${error.message}`);
  const vehicles = new Set(
    ((assets ?? []) as Array<{ id: number; motive_vehicle_id: string | number }>)
      .filter(a => !excludedAssets.has(a.id))
      .map(a => String(a.motive_vehicle_id)),
  );
  const reads = await fetchAllRows<{ vehicle_id: string | number; odometer_miles: number | string }>(
    "weekly-target odometer", () => supabase
      .from("motive_odometer_readings")
      .select("vehicle_id, odometer_miles")
      .eq("org_id", orgId)
      .not("odometer_miles", "is", null)
      .gte("captured_at", `${from}T00:00:00Z`)
      .lte("captured_at", `${addDays(to, 1)}T12:00:00Z`));
  const span = new Map<string, [number, number]>();
  for (const r of reads) {
    const v = String(r.vehicle_id);
    const m = Number(r.odometer_miles);
    if (!vehicles.has(v) || !(m > 0)) continue;
    const cur = span.get(v);
    span.set(v, cur ? [Math.min(cur[0], m), Math.max(cur[1], m)] : [m, m]);
  }
  let miles = 0; let trucks = 0;
  for (const [lo, hi] of span.values()) {
    const d = hi - lo;
    miles += d;
    if (d > 100) trucks++;
  }
  return { miles, trucks };
}

async function fuelTotals(orgId: string, from: string, to: string): Promise<{ spend: number; gallons: number }> {
  const rows = await fetchAllRows<{ total_charged: number | string | null; diesel_gallons: number | string | null }>(
    "weekly-target fuel", () => supabase
      .from("fuel_transactions")
      .select("total_charged, diesel_gallons")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("transaction_date", from)
      .lte("transaction_date", to));
  let spend = 0; let gallons = 0;
  for (const r of rows) {
    const g = Number(r.diesel_gallons ?? 0);
    if (!(g > 0)) continue;
    spend += Number(r.total_charged ?? 0);
    gallons += g;
  }
  return { spend, gallons };
}

/** The last COST_BASIS_MONTHS calendar months (before the current one)
 *  that have any imported expense entries — i.e. months that have been
 *  closed. An unclosed month would understate every fixed cost. */
async function closedMonths(orgId: string, today: string): Promise<string[]> {
  const out: string[] = [];
  const [y, m] = today.split("-").map(Number);
  for (let k = 1; k <= 12 && out.length < COST_BASIS_MONTHS; k++) {
    const first = new Date(Date.UTC(y, m - 1 - k, 1));
    const last  = new Date(Date.UTC(y, m - k, 0));
    const { count, error } = await supabase
      .from("expense_entries")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("date", iso(first.getTime()))
      .lte("date", iso(last.getTime()));
    if (error) throw new Error(`weekly-target closed months: ${error.message}`);
    if ((count ?? 0) > 0) out.push(iso(first.getTime()).slice(0, 7));
  }
  return out.sort();
}

// ── Settings ────────────────────────────────────────────────────────────

export async function readSettings(orgId: string): Promise<{
  settings: WeeklyTargetSettings; terminal: Coord | null; unavailable: boolean;
}> {
  const full = await supabase
    .from("org_settings")
    .select("hos_settings, weekly_target_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!full.error) {
    return {
      settings: (full.data?.weekly_target_settings ?? {}) as WeeklyTargetSettings,
      terminal: parseTerminal(full.data?.hos_settings),
      unavailable: false,
    };
  }
  // Column not migrated yet — the calculator still works on computed
  // values; overrides just can't persist.
  const hos = await supabase.from("org_settings").select("hos_settings").eq("org_id", orgId).maybeSingle();
  return { settings: {}, terminal: parseTerminal(hos.data?.hos_settings), unavailable: true };
}

const param = (computed: number | null, override: number | null | undefined, fallback: number): WeeklyTargetParam => {
  const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  if (ok(override)) return { value: override, computed, overridden: true };
  return { value: ok(computed) ? computed : fallback, computed, overridden: false };
};

const totals = (rows: LoadEcon[]): WeeklyTargetClassTotals => ({
  loads: rows.length,
  revenue: rows.reduce((s, r) => s + r.revenue, 0),
  loadedMiles: rows.reduce((s, r) => s + r.loadedMiles, 0),
  driverPay: rows.reduce((s, r) => s + r.driverPay, 0),
});

/** Pay ÷ revenue over loads whose pay has been entered. */
const payRate = (rows: LoadEcon[]): number | null => {
  const paid = rows.filter(r => !r.payMissing && r.revenue > 0);
  const rev = paid.reduce((s, r) => s + r.revenue, 0);
  return rev > 0 ? paid.reduce((s, r) => s + r.driverPay, 0) / rev : null;
};

// ── The model ───────────────────────────────────────────────────────────

export async function computeWeeklyTarget(
  orgId: string,
  opts: { week?: string; today?: string; settings?: WeeklyTargetSettings } = {},
): Promise<WeeklyTargetResponse> {
  const today = opts.today ?? iso(Date.now());
  const weekFrom = saturdayOf(opts.week ?? today);
  const weekTo = addDays(weekFrom, 6);
  const calTo = addDays(saturdayOf(today), -1);
  const calFrom = addDays(calTo, -(CALIBRATION_WEEKS * 7 - 1));

  const [stored, excluded, excludedAssets, months] = await Promise.all([
    readSettings(orgId),
    loadExcludedDrivers(orgId),
    loadExcludedAssetIds(orgId),
    closedMonths(orgId, today),
  ]);
  const { terminal, unavailable } = stored;
  // opts.settings previews unsaved overrides on top of the stored ones.
  const settings: WeeklyTargetSettings = opts.settings
    ? mergeSettings(stored.settings, opts.settings as Record<string, unknown>)
    : stored.settings;
  const basisFrom = months.length ? `${months[0]}-01` : calFrom;
  const basisTo = months.length
    ? iso(Date.UTC(Number(months[months.length - 1].slice(0, 4)), Number(months[months.length - 1].slice(5, 7)), 0))
    : calTo;
  const lastFrom = months.length ? `${months[months.length - 1]}-01` : null;

  const [
    calLoads, calEld, calFuel, calAdj,
    weekLoads, weekEld, weekPayroll,
    basisLoads, basisEld, basisFuel, basisAdj,
    price7, bucketRows, lastEld,
  ] = await Promise.all([
    loadEconomics(orgId, calFrom, calTo, excluded, excludedAssets, terminal, true),
    eldMiles(orgId, calFrom, calTo, excludedAssets),
    fuelTotals(orgId, calFrom, calTo),
    adjustmentsTotal(orgId, calFrom, calTo, excluded),
    loadEconomics(orgId, weekFrom, weekTo, excluded, excludedAssets, terminal, true),
    weekFrom <= today ? eldMiles(orgId, weekFrom, weekTo < today ? weekTo : today, excludedAssets) : Promise.resolve(null),
    finalizedPayroll(orgId, weekFrom, excluded),
    loadEconomics(orgId, basisFrom, basisTo, excluded, excludedAssets, terminal, false),
    eldMiles(orgId, basisFrom, basisTo, excludedAssets),
    fuelTotals(orgId, basisFrom, basisTo),
    adjustmentsTotal(orgId, basisFrom, basisTo, excluded),
    fuelTotals(orgId, addDays(today, -6), today),
    fetchAllRows<{ id: string; parent_id: string | null; name: string; system_role: string | null }>(
      "weekly-target buckets", () => supabase
        .from("expense_buckets")
        .select("id, parent_id, name, system_role")
        .eq("org_id", orgId)
        .is("deleted_at", null)),
    lastFrom ? eldMiles(orgId, lastFrom, basisTo, excludedAssets) : Promise.resolve(null),
  ]);

  // ── Calibration (last 8 complete weeks) ──
  const cal = totals(calLoads);
  const calAdjPct = cal.revenue > 0 ? calAdj / cal.revenue : 0;
  const payAll = (payRate(calLoads) ?? 0) + calAdjPct;
  const payLocal = (payRate(calLoads.filter(r => r.cls === "local")) ?? payAll - calAdjPct) + calAdjPct;
  const payOtr = (payRate(calLoads.filter(r => r.cls === "otr")) ?? payAll - calAdjPct) + calAdjPct;

  const fuelPrice = param(
    price7.gallons > 0 ? price7.spend / price7.gallons : calFuel.gallons > 0 ? calFuel.spend / calFuel.gallons : null,
    settings.fuelPrice, 0);
  const mpg = param(calFuel.gallons > 0 && calEld.miles > 0 ? calEld.miles / calFuel.gallons : null, settings.mpg, 6.5);
  const emptyFactor = param(cal.loadedMiles > 0 && calEld.miles > 0 ? calEld.miles / cal.loadedMiles : null, settings.emptyFactor, 1);
  const trucks = Math.max(1, calEld.trucks);
  // Without a measured OTR trip pattern, fall back to fleet averages —
  // conservative (they include local empty running), and labelled as
  // computed so the card can show they're worth setting.
  const otrLoadedShare = param(emptyFactor.value > 0 ? 1 / emptyFactor.value : null, settings.otrLoadedShare, 1);
  const otrMilesPerDay = param(
    calEld.miles > 0 ? calEld.miles / (trucks * CALIBRATION_WEEKS * 7) : null, settings.otrMilesPerDay, 400);

  // ── Cost basis (last closed months) ──
  const bucketIds = new Set(bucketRows.map(b => b.id));
  const [snap, snapLast] = await Promise.all([
    snapshot(orgId, mkWindow(basisFrom, basisTo), bucketIds),
    lastFrom ? snapshot(orgId, mkWindow(lastFrom, basisTo), bucketIds) : Promise.resolve(null),
  ]);
  const byId = new Map(bucketRows.map(b => [b.id, b]));
  const behaviors = settings.bucketBehaviors ?? {};
  const bases = settings.bucketBasis ?? {};
  const basisOf = (id: string): BucketBasis => {
    const b = byId.get(id);
    return bases[id] ?? (b?.parent_id ? bases[b.parent_id] : undefined) ?? "avg";
  };
  const behaviorOf = (id: string): CostBehavior | "modeled" => {
    const b = byId.get(id);
    if (!b) return "fixed";
    if (b.system_role) return "modeled";
    const parent = b.parent_id ? byId.get(b.parent_id) : undefined;
    if (parent?.system_role) return "modeled";
    return behaviors[id] ?? (b.parent_id ? behaviors[b.parent_id] : undefined) ?? "fixed";
  };
  // sums: full-window spend per behavior (for the trailing margin).
  // rates: the model's going-forward rates, each bucket on its own basis.
  const basis = totals(basisLoads);
  const basisWeeks = mkWindow(basisFrom, basisTo).days / 7;
  const lastWeeks = lastFrom ? mkWindow(lastFrom, basisTo).days / 7 : basisWeeks;
  const lastRevenue = lastFrom ? basisLoads.filter(r => r.pickup >= lastFrom).reduce((s, r) => s + r.revenue, 0) : basis.revenue;
  const lastMiles = lastEld?.miles ?? basisEld.miles;
  const sums: Record<CostBehavior, number> = { fixed: 0, per_mile: 0, revenue_pct: 0, exclude: 0 };
  const rates = { fixedWeekly: 0, perMile: 0, revenuePct: 0 };
  const apply = (behavior: CostBehavior, bb: BucketBasis, total: number, lastTotal: number) => {
    sums[behavior] += total;
    const useLast = bb === "last_month" && snapLast != null;
    const amt = useLast ? lastTotal : total;
    if (behavior === "fixed") rates.fixedWeekly += amt / (useLast ? lastWeeks : basisWeeks);
    else if (behavior === "per_mile") {
      const mi = useLast ? lastMiles : basisEld.miles;
      if (mi > 0) rates.perMile += amt / mi;
    } else if (behavior === "revenue_pct") {
      const rv = useLast ? lastRevenue : basis.revenue;
      if (rv > 0) rates.revenuePct += amt / rv;
    }
  };
  const bucketsOut: WeeklyTargetResponse["buckets"] = bucketRows.map(b => {
    const behavior = behaviorOf(b.id);
    const bb = basisOf(b.id);
    const basisTotal = snap.perBucket.get(b.id)?.total ?? 0;
    const lastMonthTotal = snapLast?.perBucket.get(b.id)?.total ?? 0;
    if (behavior !== "modeled") apply(behavior, bb, basisTotal, lastMonthTotal);
    return { id: b.id, name: b.name, parentId: b.parent_id, systemRole: b.system_role, behavior, basis: bb, basisTotal, lastMonthTotal };
  });
  const uncatBehavior = behaviors[UNCATEGORIZED_BUCKET_ID] ?? "fixed";
  const uncatBasis = bases[UNCATEGORIZED_BUCKET_ID] ?? "avg";
  apply(uncatBehavior, uncatBasis, snap.uncategorized.total, snapLast?.uncategorized.total ?? 0);
  bucketsOut.push({
    id: UNCATEGORIZED_BUCKET_ID, name: "Uncategorized card spend", parentId: null, systemRole: null,
    behavior: uncatBehavior, basis: uncatBasis,
    basisTotal: snap.uncategorized.total, lastMonthTotal: snapLast?.uncategorized.total ?? 0,
  });

  const fixed = param(rates.fixedWeekly, settings.fixedWeekly, 0);
  const fixedWeekly = fixed.value;
  const maintPerMile = rates.perMile;
  const revenuePctOther = rates.revenuePct;
  const trailingMargin = basis.revenue > 0
    ? (basis.revenue - basis.driverPay - basisAdj - basisFuel.spend - sums.fixed - sums.per_mile - sums.revenue_pct) / basis.revenue
    : null;
  const marginTarget = param(
    trailingMargin == null ? null : Math.round(trailingMargin * 200) / 200, settings.marginTarget, 0.1);

  // ── This week ──
  const wk = totals(weekLoads);
  const local = totals(weekLoads.filter(r => r.cls === "local"));
  const otr = totals(weekLoads.filter(r => r.cls === "otr"));
  const weekComplete = weekTo < today;
  // Mirrors the dashboard Total Payroll KPI: finalized records once the
  // week is closed, otherwise driver pay on the week's loads.
  const driverPaySource: "payroll" | "loads" = weekPayroll > 0 ? "payroll" : "loads";
  const driverPay = weekPayroll > 0 ? weekPayroll : wk.driverPay;

  const perMileCost = fuelPrice.value / mpg.value + maintPerMile;
  const totalMiles = wk.loadedMiles * emptyFactor.value;
  const fuel = totalMiles * fuelPrice.value / mpg.value;
  const maintenance = totalMiles * maintPerMile;
  const other = wk.revenue * revenuePctOther;
  const profit = wk.revenue - driverPay - fuel - maintenance - fixedWeekly - other;

  const milesCost = fixedWeekly + totalMiles * perMileCost;
  const breakEvenRevenue = milesCost / Math.max(0.05, 1 - payAll - revenuePctOther);
  const targetRevenue = milesCost / Math.max(0.05, 1 - payAll - revenuePctOther - marginTarget.value);
  const perLoaded = (v: number) => (wk.loadedMiles > 0 ? v / wk.loadedMiles : null);

  // ── OTR rate per loaded mile ──
  // Fixed costs are time-based (leases, insurance, admin), so an OTR run
  // carries them per truck-DAY, spread over the miles it covers that day.
  const fixedPerTruckDay = fixedWeekly / (trucks * 7);
  const otrRplm = (price: number, margin: number) => {
    const perTotalMile = price / mpg.value + maintPerMile + fixedPerTruckDay / otrMilesPerDay.value;
    return (perTotalMile / otrLoadedShare.value) / Math.max(0.05, 1 - payOtr - revenuePctOther - margin);
  };

  return {
    week: { from: weekFrom, to: weekTo, complete: weekComplete },
    calibration: { from: calFrom, to: calTo },
    costBasis: { from: basisFrom, to: basisTo, months, lastMonth: lastFrom ? { from: lastFrom, to: basisTo } : null },
    params: {
      fuelPrice, mpg, emptyFactor, otrLoadedShare, otrMilesPerDay, marginTarget,
      fixedWeekly: fixed, maintPerMile, revenuePctOther,
      payPct: { all: payAll, local: payLocal, otr: payOtr },
      trucks, fixedPerTruckDay,
    },
    booked: {
      ...wk,
      loadsMissingMiles: weekLoads.filter(r => r.milesMissing).length,
      local, otr,
    },
    projection: {
      totalMiles,
      actualMiles: weekEld ? weekEld.miles : null,
      driverPay, driverPaySource, fuel, maintenance, fixed: fixedWeekly, other, profit,
      breakEvenRevenue, targetRevenue,
      revenuePerLoadedMile: perLoaded(wk.revenue),
      breakEvenPerLoadedMile: perLoaded(breakEvenRevenue),
      targetPerLoadedMile: perLoaded(targetRevenue),
    },
    otr: {
      breakEvenRplm: otrRplm(fuelPrice.value, 0),
      targetRplm: otrRplm(fuelPrice.value, marginTarget.value),
      sensitivity: [-0.5, 0, 0.5, 1].map(d => {
        const p = Math.round((fuelPrice.value + d) * 100) / 100;
        return { fuelPrice: p, breakEvenRplm: otrRplm(p, 0), targetRplm: otrRplm(p, marginTarget.value) };
      }),
    },
    buckets: bucketsOut,
    settingsUnavailable: unavailable,
  };
}

// ── Settings writes ─────────────────────────────────────────────────────

const RANGES: Record<Exclude<keyof WeeklyTargetSettings, "bucketBehaviors" | "bucketBasis">, [number, number]> = {
  fuelPrice:      [1, 20],
  marginTarget:   [-0.5, 0.9],
  mpg:            [2, 15],
  emptyFactor:    [1, 3],
  otrLoadedShare: [0.3, 1],
  otrMilesPerDay: [50, 1000],
  fixedWeekly:    [0, 1_000_000],
};
const BEHAVIORS: CostBehavior[] = ["fixed", "per_mile", "revenue_pct", "exclude"];
const BASES: BucketBasis[] = ["avg", "last_month"];

/** Validates a partial settings patch. null clears an override. */
export function validateSettingsPatch(body: unknown): { patch?: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return { errors: ["body must be an object"] };
  const b = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v === null) { patch[key] = null; continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      errors.push(`${key} must be a number between ${lo} and ${hi}, or null`);
      continue;
    }
    patch[key] = v;
  }
  if ("bucketBehaviors" in b) {
    const bb = b.bucketBehaviors;
    if (!bb || typeof bb !== "object") errors.push("bucketBehaviors must be an object");
    else {
      for (const [id, v] of Object.entries(bb as Record<string, unknown>)) {
        if (v !== null && !BEHAVIORS.includes(v as CostBehavior)) errors.push(`bucketBehaviors.${id} must be one of ${BEHAVIORS.join(", ")} or null`);
      }
      patch.bucketBehaviors = bb;
    }
  }
  if ("bucketBasis" in b) {
    const bb = b.bucketBasis;
    if (!bb || typeof bb !== "object") errors.push("bucketBasis must be an object");
    else {
      for (const [id, v] of Object.entries(bb as Record<string, unknown>)) {
        if (v !== null && !BASES.includes(v as BucketBasis)) errors.push(`bucketBasis.${id} must be one of ${BASES.join(", ")} or null`);
      }
      patch.bucketBasis = bb;
    }
  }
  return { patch, errors };
}

export function mergeSettings(current: WeeklyTargetSettings, patch: Record<string, unknown>): WeeklyTargetSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "bucketBehaviors" || k === "bucketBasis") continue;
    if (v === null) delete next[k]; else next[k] = v;
  }
  if (patch.bucketBehaviors) {
    const bb: Record<string, CostBehavior> = { ...(current.bucketBehaviors ?? {}) };
    for (const [id, v] of Object.entries(patch.bucketBehaviors as Record<string, CostBehavior | null>)) {
      if (v === null) delete bb[id]; else bb[id] = v;
    }
    next.bucketBehaviors = bb;
  }
  if (patch.bucketBasis) {
    const bb: Record<string, BucketBasis> = { ...(current.bucketBasis ?? {}) };
    for (const [id, v] of Object.entries(patch.bucketBasis as Record<string, BucketBasis | null>)) {
      if (v === null) delete bb[id]; else bb[id] = v;
    }
    next.bucketBasis = bb;
  }
  return next as WeeklyTargetSettings;
}
