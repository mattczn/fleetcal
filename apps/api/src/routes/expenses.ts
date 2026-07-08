/**
 * /v1/expenses — federated dashboard endpoints.
 *
 * Six primary buckets + one CTA:
 *   Payroll        = live driver_pay from events (matches /payroll page)
 *                    + payroll_adjustments in window
 *                    + recurring rules of kinds admin/dispatch/maintenance
 *                    Sub-buckets exposed in meta so the tile can drill down.
 *   Fuel           = fuel_transactions.total_charged
 *                    + ramp_transactions.amount WHERE expense_category='fuel'
 *   Insurance      = recurring rules of kind 'insurance'
 *   Maintenance    = ramp_transactions.amount WHERE expense_category='maintenance'
 *   Load expenses  = ramp_transactions.amount WHERE expense_category='load_expenses'
 *   Hotels         = ramp_transactions.amount WHERE expense_category='hotels'
 *   Uncategorized  = ramp_transactions WHERE expense_category IS NULL — CTA only
 *
 * Payroll accuracy note: reads live from events + adjustments the same
 * way the /payroll page does (see PayrollView.tsx). payroll_records is
 * NOT the source of truth — those only exist after finalize.
 *
 * Recurring proration: rules stored as amount + cadence + effective
 * range. Summed into any window as amount * (window_days / period_days)
 * where period_days = 7 for weekly, 30.4375 for monthly. Editing a
 * rate applies from the effective date forward, no historical rewrite.
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
  // Clamp the rule's effective range to the requested window.
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
  // A rule is "active during the window" iff its effective range
  // overlaps the window: effective_from <= to AND (effective_to IS NULL
  // OR effective_to >= from).
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

// ── Bucket computations ────────────────────────────────────────────────

/** Payroll — live driver pay from events + adjustments + recurring rules.
 *  Returns the sub-bucket breakdown too. */
async function payrollBucket(orgId: string, w: Window, rules: RecurringRow[]) {
  // events with driver_pay:
  //   Q1 — not deferred, start falls in window
  //   Q2 — deferred to a Saturday inside the window
  // No overlap: Q1 filters deferred_to_week IS NULL, Q2 filters IS NOT NULL.
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
  const driverFromLoads   = eventRows.reduce((s, r) => s + Number(r.driver_pay ?? 0), 0);
  const driverFromAdjust  = ((adjustments.data ?? []) as Array<{ amount: string | number | null }>)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  const driver = driverFromLoads + driverFromAdjust;
  const driverCount = eventRows.length;

  const admin       = rules.filter(r => r.kind === "payroll_admin").reduce((s, r) => s + prorate(r, w), 0);
  const dispatch    = rules.filter(r => r.kind === "payroll_dispatch").reduce((s, r) => s + prorate(r, w), 0);
  const maintenance = rules.filter(r => r.kind === "payroll_maintenance").reduce((s, r) => s + prorate(r, w), 0);

  return {
    total: driver + admin + dispatch + maintenance,
    count: driverCount,   // just load-count for the tile; recurring people aren't "events"
    breakdown: { driver, admin, dispatch, maintenance },
  };
}

async function fuelBucket(orgId: string, w: Window) {
  const [mudflap, rampFuel] = await Promise.all([
    supabase
      .from("fuel_transactions")
      .select("total_charged")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("transaction_date", w.from)
      .lte("transaction_date", w.to),
    supabase
      .from("ramp_transactions")
      .select("amount")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .eq("expense_category", "fuel")
      .gte("transacted_at", w.fromTs)
      .lte("transacted_at", w.toTs),
  ]);
  if (mudflap.error)  throw new Error(`fuel_transactions: ${mudflap.error.message}`);
  if (rampFuel.error) throw new Error(`ramp fuel: ${rampFuel.error.message}`);
  const mfRows = (mudflap.data ?? [])  as Array<{ total_charged: string | number | null }>;
  const rfRows = (rampFuel.data ?? []) as Array<{ amount: string | number | null }>;
  return {
    total: mfRows.reduce((s, r) => s + Number(r.total_charged ?? 0), 0)
         + rfRows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: mfRows.length + rfRows.length,
  };
}

function insuranceBucket(w: Window, rules: RecurringRow[]) {
  const active = rules.filter(r => r.kind === "insurance");
  return {
    total: active.reduce((s, r) => s + prorate(r, w), 0),
    count: active.length,
  };
}

async function rampCategoryBucket(orgId: string, w: Window, category: string) {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .eq("expense_category", category)
    .gte("transacted_at", w.fromTs)
    .lte("transacted_at", w.toTs);
  if (error) throw new Error(`ramp ${category}: ${error.message}`);
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

// ── /summary ────────────────────────────────────────────────────────────

expenses.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const w    = parseWindow(new URL(c.req.url));
  const prev = prevWindow(w);

  try {
    const [rulesW, rulesP] = await Promise.all([
      loadActiveRules(orgId, w),
      loadActiveRules(orgId, prev),
    ]);

    const [
      payroll,    fuel,    insurance,    maintenance,    loadExpenses,    hotels,    uncat,
      payrollPrev, fuelPrev, insurancePrev, maintenancePrev, loadExpensesPrev, hotelsPrev,
    ] = await Promise.all([
      payrollBucket(orgId, w, rulesW),
      fuelBucket(orgId, w),
      Promise.resolve(insuranceBucket(w, rulesW)),
      rampCategoryBucket(orgId, w, "maintenance"),
      rampCategoryBucket(orgId, w, "load_expenses"),
      rampCategoryBucket(orgId, w, "hotels"),
      uncategorizedRampBucket(orgId, w),
      payrollBucket(orgId, prev, rulesP),
      fuelBucket(orgId, prev),
      Promise.resolve(insuranceBucket(prev, rulesP)),
      rampCategoryBucket(orgId, prev, "maintenance"),
      rampCategoryBucket(orgId, prev, "load_expenses"),
      rampCategoryBucket(orgId, prev, "hotels"),
    ]);

    const buckets: ExpenseBucket[] = [
      {
        key: "payroll",
        label: "Payroll",
        total: payroll.total,
        count: payroll.count,
        prevTotal: payrollPrev.total,
        prevCount: payrollPrev.count,
        meta: {
          driver:      payroll.breakdown.driver,
          admin:       payroll.breakdown.admin,
          dispatch:    payroll.breakdown.dispatch,
          maintenance: payroll.breakdown.maintenance,
        },
      },
      { key: "fuel",          label: "Fuel",          total: fuel.total,         count: fuel.count,         prevTotal: fuelPrev.total,         prevCount: fuelPrev.count },
      { key: "insurance",     label: "Insurance",     total: insurance.total,    count: insurance.count,    prevTotal: insurancePrev.total,    prevCount: insurancePrev.count },
      { key: "maintenance",   label: "Maintenance",   total: maintenance.total,  count: maintenance.count,  prevTotal: maintenancePrev.total,  prevCount: maintenancePrev.count },
      { key: "load_expenses", label: "Load expenses", total: loadExpenses.total, count: loadExpenses.count, prevTotal: loadExpensesPrev.total, prevCount: loadExpensesPrev.count },
      { key: "hotels",        label: "Hotels",        total: hotels.total,       count: hotels.count,       prevTotal: hotelsPrev.total,       prevCount: hotelsPrev.count },
    ];

    // Uncategorized is a CTA — only include it when there's something to
    // categorize so the client can conditionally render.
    if (uncat.count > 0) {
      buckets.push({
        key: "uncategorized",
        label: "Uncategorized card spend",
        total: uncat.total,
        count: uncat.count,
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
    const [fuelRes, adjRes, cardsRes] = await Promise.all([
      supabase
        .from("fuel_transactions")
        .select("id, transaction_date, total_charged, location, driver_name, asset_id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transaction_date", w.from)
        .lte("transaction_date", w.to)
        .order("transaction_date", { ascending: false })
        .limit(limit),
      // Adjustments as a proxy for "payroll events" in the feed — they're
      // the discrete payroll actions humans take (finalize, adjust,
      // defer). Loads are already surfaced elsewhere in the app.
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
        .select("id, transacted_at, amount, merchant_name, memo, cardholder_name, asset_id, expense_category")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transacted_at", w.fromTs)
        .lte("transacted_at", w.toTs)
        .order("transacted_at", { ascending: false })
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
      expense_category: string | null;
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
//
// One-shot to populate expense_category on legacy ramp_transactions
// that were synced before the auto-mapper existed. Skips rows that
// already have a value so manual assignments aren't clobbered.

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
