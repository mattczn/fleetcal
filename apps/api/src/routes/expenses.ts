/**
 * /v1/expenses — federated dashboard endpoints.
 *
 * Eight primary buckets + one CTA:
 *
 *   Payroll & People       driver pay (live events) + admin/dispatch/maint
 *                          recurring + address stipends (recurring) + Sophia/Luis
 *                          owner-op payouts (one-time entries)
 *   Fleet Operations       Mudflap fuel + Ramp categorized fuel/maintenance/
 *                          load_expenses/hotels
 *   Facilities             yard_rent + office_rent (recurring)
 *   Insurance & Claims     insurance recurring + claim_payout entries
 *   Software & Overhead    software_subscription recurring + Ramp office +
 *                          one-off subscription entries
 *   Capex                  truck_purchase + equipment_purchase entries
 *   Taxes                  tax entries (IRP/IFTA/income/state, spelled in label)
 *   Owner Draws            owner_draw entries (Chase Sapphire personal biz +
 *                          explicit withdrawals)
 *   Uncategorized card CTA Ramp txns where expense_category IS NULL — only
 *                          included when count > 0
 *
 * Payroll accuracy: driver comes live from events + payroll_adjustments the
 * same way PayrollView does, NOT from finalized payroll_records.
 *
 * Recurring proration: amount × (window_days / period_days). weekly = 7,
 * monthly = 30.4375.
 */

import { Hono } from "hono";
import type {
  ExpensesSummaryResponse,
  ExpenseBucket,
  ExpensesActivityResponse,
  ExpenseEvent,
  BackfillRampCategoriesResponse,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { mapRampCategory } from "../lib/rampCategoryMap.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const expenses = new Hono<{ Variables: AuthVariables }>();
expenses.use("*", requireModule("expenses"), requireCapability("expenses.access"));

// ── Window helpers ──────────────────────────────────────────────────────

interface Window { from: string; to: string; fromTs: string; toTs: string; days: number; }

function parseWindow(url: URL): Window {
  const q = (k: string) => url.searchParams.get(k);
  const now = new Date();
  let from = q("from");
  let to   = q("to");
  if (!from || !to) {
    const day = now.getUTCDay();
    const daysSinceSat = (day + 1) % 7;
    const sat = new Date(now);
    sat.setUTCHours(0, 0, 0, 0);
    sat.setUTCDate(sat.getUTCDate() - daysSinceSat);
    const fri = new Date(sat);
    fri.setUTCDate(sat.getUTCDate() + 6);
    from = sat.toISOString().slice(0, 10);
    to   = fri.toISOString().slice(0, 10);
  }
  const startTs = new Date(`${from}T00:00:00Z`);
  const endTs   = new Date(`${to}T00:00:00Z`);
  const days    = Math.round((endTs.getTime() - startTs.getTime()) / 86_400_000) + 1;
  return { from, to, fromTs: `${from}T00:00:00Z`, toTs: `${to}T23:59:59Z`, days };
}

function prevWindow(w: Window): Window {
  const start = new Date(w.fromTs);
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (w.days - 1));
  const pf = prevStart.toISOString().slice(0, 10);
  const pt = prevEnd.toISOString().slice(0, 10);
  return {
    from: pf, to: pt,
    fromTs: `${pf}T00:00:00Z`,
    toTs:   `${pt}T23:59:59Z`,
    days:   w.days,
  };
}

// ── Recurring rule proration ────────────────────────────────────────────

interface RecurringRow {
  id:             string;
  kind:           string;
  amount:         string | number;
  cadence:        string;
  effective_from: string;
  effective_to:   string | null;
}

function prorate(rule: RecurringRow, w: Window): number {
  const ruleStart = new Date(`${rule.effective_from}T00:00:00Z`);
  const ruleEnd   = rule.effective_to
    ? new Date(`${rule.effective_to}T00:00:00Z`)
    : new Date(w.toTs);
  const winStart  = new Date(w.fromTs);
  const winEnd    = new Date(w.toTs);
  const overlapStart = ruleStart > winStart ? ruleStart : winStart;
  const overlapEnd   = ruleEnd   < winEnd   ? ruleEnd   : winEnd;
  if (overlapEnd < overlapStart) return 0;
  const overlapDays = Math.floor((overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000) + 1;
  const periodDays  = rule.cadence === "weekly" ? 7 : 30.4375;
  return Number(rule.amount) * (overlapDays / periodDays);
}

async function loadActiveRules(orgId: string, w: Window): Promise<RecurringRow[]> {
  const { data, error } = await supabase
    .from("recurring_expenses")
    .select("id, kind, amount, cadence, effective_from, effective_to")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("effective_from", w.to)
    .or(`effective_to.is.null,effective_to.gte.${w.from}`);
  if (error) throw new Error(`recurring rules: ${error.message}`);
  return (data ?? []) as RecurringRow[];
}

function sumRecurring(rules: RecurringRow[], kinds: string[], w: Window): number {
  return rules
    .filter(r => kinds.includes(r.kind))
    .reduce((s, r) => s + prorate(r, w), 0);
}

// ── One-time entries ────────────────────────────────────────────────────

interface EntryRow {
  id:     string;
  kind:   string;
  date:   string;
  amount: string | number;
}

async function loadEntries(orgId: string, w: Window): Promise<EntryRow[]> {
  const { data, error } = await supabase
    .from("expense_entries")
    .select("id, kind, date, amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("date", w.from)
    .lte("date", w.to);
  if (error) throw new Error(`expense_entries: ${error.message}`);
  return (data ?? []) as EntryRow[];
}

function sumEntries(entries: EntryRow[], kinds: string[]): { total: number; count: number } {
  const rows = entries.filter(e => kinds.includes(e.kind));
  return {
    total: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: rows.length,
  };
}

// ── Payroll bucket ──────────────────────────────────────────────────────

async function payrollDriverAndAdjustments(orgId: string, w: Window) {
  const [eventsQ1, eventsQ2, adjustments] = await Promise.all([
    supabase
      .from("events")
      .select("driver_pay")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("driver_pay", "is", null)
      .is("deferred_to_week", null)
      .gte("start", w.from)
      .lte("start", `${w.to}T23:59:59`),
    supabase
      .from("events")
      .select("driver_pay")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("driver_pay", "is", null)
      .not("deferred_to_week", "is", null)
      .gte("deferred_to_week", w.from)
      .lte("deferred_to_week", w.to),
    supabase
      .from("payroll_adjustments")
      .select("amount")
      .eq("org_id", orgId)
      .gte("week_start", w.from)
      .lte("week_start", w.to),
  ]);
  if (eventsQ1.error) throw new Error(`events (q1): ${eventsQ1.error.message}`);
  if (eventsQ2.error) throw new Error(`events (q2): ${eventsQ2.error.message}`);
  if (adjustments.error) throw new Error(`payroll_adjustments: ${adjustments.error.message}`);
  const eventRows = [
    ...((eventsQ1.data ?? []) as Array<{ driver_pay: string | number | null }>),
    ...((eventsQ2.data ?? []) as Array<{ driver_pay: string | number | null }>),
  ];
  const loadPay = eventRows.reduce((s, r) => s + Number(r.driver_pay ?? 0), 0);
  const adjSum  = ((adjustments.data ?? []) as Array<{ amount: string | number | null }>)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  return { total: loadPay + adjSum, count: eventRows.length };
}

// ── Fleet operations ────────────────────────────────────────────────────

async function fleetOpsSubs(orgId: string, w: Window) {
  const [mudflap, rampCat] = await Promise.all([
    supabase
      .from("fuel_transactions")
      .select("total_charged")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("transaction_date", w.from)
      .lte("transaction_date", w.to),
    supabase
      .from("ramp_transactions")
      .select("amount, expense_category")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .in("expense_category", ["fuel", "maintenance", "load_expenses", "hotels"])
      .gte("transacted_at", w.fromTs)
      .lte("transacted_at", w.toTs),
  ]);
  if (mudflap.error) throw new Error(`fuel_transactions: ${mudflap.error.message}`);
  if (rampCat.error) throw new Error(`ramp fleet_ops: ${rampCat.error.message}`);
  const mudflapRows = (mudflap.data ?? []) as Array<{ total_charged: string | number | null }>;
  const rampRows    = (rampCat.data ?? []) as Array<{ amount: string | number | null; expense_category: string }>;
  const fuel = mudflapRows.reduce((s, r) => s + Number(r.total_charged ?? 0), 0)
             + rampRows.filter(r => r.expense_category === "fuel").reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const maintenance = rampRows.filter(r => r.expense_category === "maintenance")
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const loadExp = rampRows.filter(r => r.expense_category === "load_expenses")
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const hotels = rampRows.filter(r => r.expense_category === "hotels")
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  return {
    fuel, maintenance, loadExpenses: loadExp, hotels,
    total: fuel + maintenance + loadExp + hotels,
    count: mudflapRows.length + rampRows.length,
  };
}

async function rampOfficeSum(orgId: string, w: Window) {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .eq("expense_category", "office")
    .gte("transacted_at", w.fromTs)
    .lte("transacted_at", w.toTs);
  if (error) throw new Error(`ramp office: ${error.message}`);
  const rows = (data ?? []) as Array<{ amount: string | number | null }>;
  return {
    total: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: rows.length,
  };
}

async function uncategorizedRampBucket(orgId: string, w: Window) {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("expense_category", null)
    .gte("transacted_at", w.fromTs)
    .lte("transacted_at", w.toTs);
  if (error) throw new Error(`ramp uncategorized: ${error.message}`);
  const rows = (data ?? []) as Array<{ amount: string | number | null }>;
  return {
    total: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: rows.length,
  };
}

// ── Compose one window's snapshot ───────────────────────────────────────

interface Snapshot {
  payroll_people:    { total: number; count: number; driver: number; admin: number; dispatch: number; maintenance: number; stipends: number; ownerOpPayouts: number };
  fleet_ops:         { total: number; count: number; fuel: number; maintenance: number; loadExpenses: number; hotels: number };
  facilities:        { total: number; count: number; yard: number; office: number };
  insurance_claims:  { total: number; count: number; insurance: number; claims: number };
  software_overhead: { total: number; count: number; recurring: number; rampOffice: number; oneOff: number };
  capex:             { total: number; count: number; truck: number; equipment: number };
  taxes:             { total: number; count: number };
  owner_draws:       { total: number; count: number };
  uncategorized:     { total: number; count: number };
}

async function snapshot(orgId: string, w: Window): Promise<Snapshot> {
  const [rules, entries, driver, fleetOps, rampOff, uncat] = await Promise.all([
    loadActiveRules(orgId, w),
    loadEntries(orgId, w),
    payrollDriverAndAdjustments(orgId, w),
    fleetOpsSubs(orgId, w),
    rampOfficeSum(orgId, w),
    uncategorizedRampBucket(orgId, w),
  ]);

  const admin    = sumRecurring(rules, ["payroll_admin"], w);
  const dispatch = sumRecurring(rules, ["payroll_dispatch"], w);
  const maint    = sumRecurring(rules, ["payroll_maintenance"], w);
  const stipends = sumRecurring(rules, ["address_stipend"], w);
  const ownerOp  = sumEntries(entries, ["owner_op_payout"]);

  const yardRent   = sumRecurring(rules, ["yard_rent"], w);
  const officeRent = sumRecurring(rules, ["office_rent"], w);

  const insurance  = sumRecurring(rules, ["insurance"], w);
  const claims     = sumEntries(entries, ["claim_payout"]);

  const subs      = sumRecurring(rules, ["software_subscription"], w);
  const oneOffSub = sumEntries(entries, ["subscription"]);

  const truckCapex = sumEntries(entries, ["truck_purchase"]);
  const equipCapex = sumEntries(entries, ["equipment_purchase"]);

  const taxes      = sumEntries(entries, ["tax"]);
  const draws      = sumEntries(entries, ["owner_draw"]);

  return {
    payroll_people: {
      total: driver.total + admin + dispatch + maint + stipends + ownerOp.total,
      count: driver.count + ownerOp.count,
      driver: driver.total, admin, dispatch, maintenance: maint,
      stipends, ownerOpPayouts: ownerOp.total,
    },
    fleet_ops: {
      total: fleetOps.total,
      count: fleetOps.count,
      fuel: fleetOps.fuel,
      maintenance: fleetOps.maintenance,
      loadExpenses: fleetOps.loadExpenses,
      hotels: fleetOps.hotels,
    },
    facilities: {
      total: yardRent + officeRent,
      count: rules.filter(r => r.kind === "yard_rent" || r.kind === "office_rent").length,
      yard: yardRent, office: officeRent,
    },
    insurance_claims: {
      total: insurance + claims.total,
      count: rules.filter(r => r.kind === "insurance").length + claims.count,
      insurance, claims: claims.total,
    },
    software_overhead: {
      total: subs + rampOff.total + oneOffSub.total,
      count: rules.filter(r => r.kind === "software_subscription").length + rampOff.count + oneOffSub.count,
      recurring: subs, rampOffice: rampOff.total, oneOff: oneOffSub.total,
    },
    capex: {
      total: truckCapex.total + equipCapex.total,
      count: truckCapex.count + equipCapex.count,
      truck: truckCapex.total, equipment: equipCapex.total,
    },
    taxes:       { total: taxes.total, count: taxes.count },
    owner_draws: { total: draws.total, count: draws.count },
    uncategorized: uncat,
  };
}

// ── /summary ────────────────────────────────────────────────────────────

expenses.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const w    = parseWindow(new URL(c.req.url));
  const prev = prevWindow(w);

  try {
    const [cur, past] = await Promise.all([snapshot(orgId, w), snapshot(orgId, prev)]);

    const buckets: ExpenseBucket[] = [
      {
        key: "payroll_people",
        label: "Payroll & People",
        total: cur.payroll_people.total,
        count: cur.payroll_people.count,
        prevTotal: past.payroll_people.total,
        prevCount: past.payroll_people.count,
        meta: {
          driver:         cur.payroll_people.driver,
          admin:          cur.payroll_people.admin,
          dispatch:       cur.payroll_people.dispatch,
          maintenance:    cur.payroll_people.maintenance,
          stipends:       cur.payroll_people.stipends,
          ownerOpPayouts: cur.payroll_people.ownerOpPayouts,
        },
      },
      {
        key: "fleet_ops",
        label: "Fleet Operations",
        total: cur.fleet_ops.total,
        count: cur.fleet_ops.count,
        prevTotal: past.fleet_ops.total,
        prevCount: past.fleet_ops.count,
        meta: {
          fuel:         cur.fleet_ops.fuel,
          maintenance:  cur.fleet_ops.maintenance,
          loadExpenses: cur.fleet_ops.loadExpenses,
          hotels:       cur.fleet_ops.hotels,
        },
      },
      {
        key: "facilities",
        label: "Facilities",
        total: cur.facilities.total,
        count: cur.facilities.count,
        prevTotal: past.facilities.total,
        prevCount: past.facilities.count,
        meta: { yard: cur.facilities.yard, office: cur.facilities.office },
      },
      {
        key: "insurance_claims",
        label: "Insurance & Claims",
        total: cur.insurance_claims.total,
        count: cur.insurance_claims.count,
        prevTotal: past.insurance_claims.total,
        prevCount: past.insurance_claims.count,
        meta: { insurance: cur.insurance_claims.insurance, claims: cur.insurance_claims.claims },
      },
      {
        key: "software_overhead",
        label: "Software & Overhead",
        total: cur.software_overhead.total,
        count: cur.software_overhead.count,
        prevTotal: past.software_overhead.total,
        prevCount: past.software_overhead.count,
        meta: {
          recurring:  cur.software_overhead.recurring,
          rampOffice: cur.software_overhead.rampOffice,
          oneOff:     cur.software_overhead.oneOff,
        },
      },
      {
        key: "capex",
        label: "Capex",
        total: cur.capex.total,
        count: cur.capex.count,
        prevTotal: past.capex.total,
        prevCount: past.capex.count,
        meta: { truck: cur.capex.truck, equipment: cur.capex.equipment },
      },
      {
        key: "taxes",
        label: "Taxes",
        total: cur.taxes.total,
        count: cur.taxes.count,
        prevTotal: past.taxes.total,
        prevCount: past.taxes.count,
      },
      {
        key: "owner_draws",
        label: "Owner Draws",
        total: cur.owner_draws.total,
        count: cur.owner_draws.count,
        prevTotal: past.owner_draws.total,
        prevCount: past.owner_draws.count,
      },
    ];

    if (cur.uncategorized.count > 0) {
      buckets.push({
        key: "uncategorized",
        label: "Uncategorized card spend",
        total: cur.uncategorized.total,
        count: cur.uncategorized.count,
        prevTotal: 0,
        prevCount: 0,
      });
    }

    const res: ExpensesSummaryResponse = {
      period: { from: w.from, to: w.to },
      buckets,
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/expenses/summary]", detail);
    return c.json({ error: "summary_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

// ── /activity ───────────────────────────────────────────────────────────

expenses.get("/activity", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const w = parseWindow(url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);

  try {
    const [fuelRes, adjRes, cardsRes, entriesRes] = await Promise.all([
      supabase
        .from("fuel_transactions")
        .select("id, transaction_date, total_charged, location, driver_name, asset_id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transaction_date", w.from)
        .lte("transaction_date", w.to)
        .order("transaction_date", { ascending: false })
        .limit(limit),
      supabase
        .from("payroll_adjustments")
        .select("id, week_start, amount, category, description, driver_name, created_at")
        .eq("org_id", orgId)
        .gte("week_start", w.from)
        .lte("week_start", w.to)
        .order("created_at", { ascending: false })
        .limit(limit),
      supabase
        .from("ramp_transactions")
        .select("id, transacted_at, amount, merchant_name, memo, cardholder_name, asset_id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transacted_at", w.fromTs)
        .lte("transacted_at", w.toTs)
        .order("transacted_at", { ascending: false })
        .limit(limit),
      supabase
        .from("expense_entries")
        .select("id, date, amount, kind, label")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("date", w.from)
        .lte("date", w.to)
        .order("date", { ascending: false })
        .limit(limit),
    ]);

    const events: ExpenseEvent[] = [];
    for (const r of (fuelRes.data ?? []) as Array<{
      id: string; transaction_date: string; total_charged: string | number | null;
      location: string | null; driver_name: string | null; asset_id: number | null;
    }>) {
      events.push({
        source: "fuel",
        id: r.id,
        at: `${r.transaction_date}T12:00:00Z`,
        amount: Number(r.total_charged ?? 0),
        description: r.location ?? "Fuel purchase",
        assetId: r.asset_id ?? undefined,
        driverName: r.driver_name ?? undefined,
        href: `/equipment?tab=fuel`,
      });
    }
    for (const r of (adjRes.data ?? []) as Array<{
      id: string; week_start: string; amount: string | number | null;
      category: string; description: string | null; driver_name: string; created_at: string;
    }>) {
      events.push({
        source: "payroll",
        id: r.id,
        at: r.created_at ?? `${r.week_start}T12:00:00Z`,
        amount: Number(r.amount ?? 0),
        description: `${r.category}${r.description ? ` · ${r.description}` : ""} · ${r.driver_name}`,
        driverName: r.driver_name,
        href: `/payroll`,
      });
    }
    for (const r of (cardsRes.data ?? []) as Array<{
      id: string; transacted_at: string; amount: string | number;
      merchant_name: string | null; memo: string | null;
      cardholder_name: string | null; asset_id: number | null;
    }>) {
      const parts = [r.merchant_name, r.memo].filter(Boolean).join(" · ") || "Card purchase";
      events.push({
        source: "cards",
        id: r.id,
        at: r.transacted_at,
        amount: Number(r.amount ?? 0),
        description: parts,
        assetId: r.asset_id ?? undefined,
        driverName: r.cardholder_name ?? undefined,
        href: `/expenses/cards`,
      });
    }
    for (const r of (entriesRes.data ?? []) as Array<{
      id: string; date: string; amount: string | number; kind: string; label: string;
    }>) {
      events.push({
        source: "payroll", // reuse "payroll" for the pill color; entries span sources
        id: r.id,
        at: `${r.date}T12:00:00Z`,
        amount: Number(r.amount ?? 0),
        description: `${r.label} (${r.kind.replace(/_/g, " ")})`,
        href: `/expenses/one-time`,
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const res: ExpensesActivityResponse = { events: events.slice(0, limit) };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/expenses/activity]", detail);
    return c.json({ error: "activity_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

// ── /backfill-categories ───────────────────────────────────────────────

expenses.post("/backfill-categories", async (c) => {
  const orgId = c.get("orgId");
  try {
    const { data, error } = await supabase
      .from("ramp_transactions")
      .select("id, sk_category_name")
      .eq("org_id", orgId)
      .is("expense_category", null)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ id: string; sk_category_name: string | null }>;
    const perCategory: Record<string, number> = {};
    let categorized = 0;
    for (const r of rows) {
      const cat = mapRampCategory(r.sk_category_name);
      if (!cat) continue;
      const { error: uErr } = await supabase
        .from("ramp_transactions")
        .update({ expense_category: cat })
        .eq("id", r.id)
        .eq("org_id", orgId);
      if (uErr) continue;
      categorized++;
      perCategory[cat] = (perCategory[cat] ?? 0) + 1;
    }
    const res: BackfillRampCategoriesResponse = {
      scanned: rows.length,
      categorized,
      perCategory,
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: "backfill_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

export default expenses;
