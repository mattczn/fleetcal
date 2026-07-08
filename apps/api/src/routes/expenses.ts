/**
 * /v1/expenses — federated dashboard endpoints.
 *
 * Eight primary buckets + one CTA. Routing is now purely by bucket_key:
 * recurring_expenses.bucket_key, expense_entries.bucket_key, and
 * ramp_transactions.bucket_key all point directly at the dashboard tile
 * they feed. No more kind-to-bucket mapping table in code.
 *
 * Special cases still applied:
 *   - Payroll & People auto-includes driver_pay from events +
 *     payroll_adjustments (the /payroll page's live source of truth).
 *   - Fleet Operations auto-includes fuel_transactions (Mudflap) since
 *     those don't have a bucket_key column.
 *   - Uncategorized CTA lists Ramp txns with bucket_key IS NULL.
 */

import { Hono } from "hono";
import type {
  ExpensesSummaryResponse,
  ExpenseBucket,
  ExpenseBucketKey,
  ExpensesActivityResponse,
  ExpenseEvent,
  ApiErrorResponse,
} from "@fleetcal/types";
import { EXPENSE_BUCKET_KEYS, EXPENSE_BUCKET_LABELS } from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

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

// ── Recurring proration ────────────────────────────────────────────────

interface RecurringRow {
  id:             string;
  bucket_key:     string;
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
    .select("id, bucket_key, amount, cadence, effective_from, effective_to")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("effective_from", w.to)
    .or(`effective_to.is.null,effective_to.gte.${w.from}`);
  if (error) throw new Error(`recurring rules: ${error.message}`);
  return (data ?? []) as RecurringRow[];
}

// ── One-time entries ────────────────────────────────────────────────────

interface EntryRow { id: string; bucket_key: string; amount: string | number; }

async function loadEntries(orgId: string, w: Window): Promise<EntryRow[]> {
  const { data, error } = await supabase
    .from("expense_entries")
    .select("id, bucket_key, amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("date", w.from)
    .lte("date", w.to);
  if (error) throw new Error(`expense_entries: ${error.message}`);
  return (data ?? []) as EntryRow[];
}

// ── Ramp categorized ────────────────────────────────────────────────────

interface RampRow { id: string; bucket_key: string | null; amount: string | number; }

async function loadRampCategorized(orgId: string, w: Window): Promise<RampRow[]> {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("id, bucket_key, amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .not("bucket_key", "is", null)
    .gte("transacted_at", w.fromTs)
    .lte("transacted_at", w.toTs);
  if (error) throw new Error(`ramp categorized: ${error.message}`);
  return (data ?? []) as RampRow[];
}

async function loadRampUncategorized(orgId: string, w: Window) {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("amount")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("bucket_key", null)
    .gte("transacted_at", w.fromTs)
    .lte("transacted_at", w.toTs);
  if (error) throw new Error(`ramp uncategorized: ${error.message}`);
  const rows = (data ?? []) as Array<{ amount: string | number | null }>;
  return {
    total: rows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: rows.length,
  };
}

// ── Payroll driver + adjustments (live source of truth) ────────────────

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
  const rows = [
    ...((eventsQ1.data ?? []) as Array<{ driver_pay: string | number | null }>),
    ...((eventsQ2.data ?? []) as Array<{ driver_pay: string | number | null }>),
  ];
  const loadPay = rows.reduce((s, r) => s + Number(r.driver_pay ?? 0), 0);
  const adjSum  = ((adjustments.data ?? []) as Array<{ amount: string | number | null }>)
    .reduce((s, r) => s + Number(r.amount ?? 0), 0);
  return { total: loadPay + adjSum, count: rows.length };
}

// ── Fuel Mudflap (feeds Fleet Ops by default) ──────────────────────────

async function mudflapFuel(orgId: string, w: Window) {
  const { data, error } = await supabase
    .from("fuel_transactions")
    .select("total_charged")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("transaction_date", w.from)
    .lte("transaction_date", w.to);
  if (error) throw new Error(`fuel_transactions: ${error.message}`);
  const rows = (data ?? []) as Array<{ total_charged: string | number | null }>;
  return {
    total: rows.reduce((s, r) => s + Number(r.total_charged ?? 0), 0),
    count: rows.length,
  };
}

// ── Compose one window's snapshot ───────────────────────────────────────

interface Snapshot {
  buckets: Record<ExpenseBucketKey, { total: number; count: number }>;
  uncategorized: { total: number; count: number };
}

async function snapshot(orgId: string, w: Window): Promise<Snapshot> {
  const [rules, entries, ramp, driver, fuel, uncat] = await Promise.all([
    loadActiveRules(orgId, w),
    loadEntries(orgId, w),
    loadRampCategorized(orgId, w),
    payrollDriverAndAdjustments(orgId, w),
    mudflapFuel(orgId, w),
    loadRampUncategorized(orgId, w),
  ]);

  // Initialize every bucket to zero, then accumulate from each source.
  const buckets = Object.fromEntries(
    EXPENSE_BUCKET_KEYS.map(k => [k, { total: 0, count: 0 }]),
  ) as Record<ExpenseBucketKey, { total: number; count: number }>;

  // Recurring rules → their declared bucket_key, prorated.
  for (const rule of rules) {
    const key = rule.bucket_key as ExpenseBucketKey;
    if (!buckets[key]) continue;
    buckets[key].total += prorate(rule, w);
    buckets[key].count += 1;
  }

  // One-time entries → their declared bucket_key, at face value.
  for (const e of entries) {
    const key = e.bucket_key as ExpenseBucketKey;
    if (!buckets[key]) continue;
    buckets[key].total += Number(e.amount ?? 0);
    buckets[key].count += 1;
  }

  // Ramp txns → their declared bucket_key. Uncategorized handled below.
  for (const r of ramp) {
    if (!r.bucket_key) continue;
    const key = r.bucket_key as ExpenseBucketKey;
    if (!buckets[key]) continue;
    buckets[key].total += Number(r.amount ?? 0);
    buckets[key].count += 1;
  }

  // Auto-added sources that don't carry a bucket_key column:
  //   Payroll & People — always includes live driver pay + adjustments.
  //   Fleet Operations — always includes Mudflap fuel transactions.
  buckets.payroll_people.total += driver.total;
  buckets.payroll_people.count += driver.count;
  buckets.fleet_ops.total      += fuel.total;
  buckets.fleet_ops.count      += fuel.count;

  return { buckets, uncategorized: uncat };
}

// ── /summary ────────────────────────────────────────────────────────────

expenses.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const w    = parseWindow(new URL(c.req.url));
  const prev = prevWindow(w);

  try {
    const [cur, past] = await Promise.all([
      snapshot(orgId, w),
      snapshot(orgId, prev),
    ]);

    const buckets: ExpenseBucket[] = EXPENSE_BUCKET_KEYS.map(key => ({
      key,
      label: EXPENSE_BUCKET_LABELS[key],
      total: cur.buckets[key].total,
      count: cur.buckets[key].count,
      prevTotal: past.buckets[key].total,
      prevCount: past.buckets[key].count,
    }));

    if (cur.uncategorized.count > 0) {
      buckets.push({
        key:       "uncategorized",
        label:     "Uncategorized card spend",
        total:     cur.uncategorized.total,
        count:     cur.uncategorized.count,
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
        .select("id, date, amount, bucket_key, kind, label")
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
      id: string; date: string; amount: string | number;
      bucket_key: string; kind: string | null; label: string;
    }>) {
      const tag = r.kind ? ` (${r.kind})` : "";
      events.push({
        source: "payroll",
        id: r.id,
        at: `${r.date}T12:00:00Z`,
        amount: Number(r.amount ?? 0),
        description: `${r.label}${tag}`,
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

export default expenses;
