/**
 * /v1/expenses — federated dashboard endpoints.
 *
 * Buckets are dynamic (expense_buckets table, 2-level tree per org).
 * The summary route enumerates them and sums entries/rules/ramp txns
 * by bucket_id, rolling sub-buckets up into their parents.
 *
 * Auto-injected sources — driver_pay + payroll_adjustments and
 * Mudflap fuel_transactions — flow into whichever bucket carries the
 * matching system_role. If no bucket holds a role, that source doesn't
 * appear on any tile (visible via a client-side warning).
 *
 * Uncategorized Ramp txns become an "Uncategorized card spend" pseudo-
 * bucket appended after the real ones.
 */

import { Hono } from "hono";
import type {
  ExpensesSummaryResponse,
  ExpenseBucketSummary,
  ExpensesActivityResponse,
  ExpenseEvent,
  ExpensesLedgerResponse,
  LedgerRow,
  RecurringExpense,
  RecurringExpenseCadence,
  ExpenseEntry,
  RevenueAdjustment,
  ListRevenueAdjustmentsResponse,
  ApiErrorResponse,
} from "@fleetcal/types";
import { UNCATEGORIZED_BUCKET_ID } from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { TX_COLS, rowToTx, type RampTransactionRow } from "./ramp-transactions.js";

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

// ── Prorate + data loading ─────────────────────────────────────────────

interface RecurringRow {
  bucket_id:      string;
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

/**
 * PostgREST silently caps every response at 1000 rows. A half-year
 * window has ~3k imported entries and ~1.4k driver-pay events, so any
 * unranged query here undercounts — arbitrarily, by physical row order.
 * This helper pages through the full result set. `build` must return a
 * FRESH query each call (PostgREST builders are single-use).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(label: string, build: () => any): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

interface BucketRow {
  id:          string;
  parent_id:   string | null;
  name:        string;
  icon:        string | null;
  color:       string | null;
  sort_order:  number;
  system_role: string | null;
}

interface Snapshot {
  perBucket: Map<string, { total: number; count: number }>;
  uncategorized: { total: number; count: number };
}

async function snapshot(orgId: string, w: Window, bucketIds: Set<string>): Promise<Snapshot> {
  const perBucket = new Map<string, { total: number; count: number }>();
  const add = (id: string | null | undefined, amount: number) => {
    if (!id || !bucketIds.has(id)) return;
    const cur = perBucket.get(id) ?? { total: 0, count: 0 };
    cur.total += amount;
    cur.count += 1;
    perBucket.set(id, cur);
  };

  const [rules, entries, rampCateg, uncatRows] = await Promise.all([
    fetchAll<RecurringRow>("recurring", () => supabase
      .from("recurring_expenses")
      .select("bucket_id, amount, cadence, effective_from, effective_to")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .lte("effective_from", w.to)
      .or(`effective_to.is.null,effective_to.gte.${w.from}`)),
    fetchAll<{ bucket_id: string; amount: string | number | null }>("entries", () => supabase
      .from("expense_entries")
      .select("bucket_id, amount")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .gte("date", w.from)
      .lte("date", w.to)),
    fetchAll<{ bucket_id: string; amount: string | number | null }>("ramp categ", () => supabase
      .from("ramp_transactions")
      .select("bucket_id, amount")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("bucket_id", "is", null)
      .gte("transacted_at", w.fromTs)
      .lte("transacted_at", w.toTs)),
    fetchAll<{ amount: string | number | null }>("ramp uncat", () => supabase
      .from("ramp_transactions")
      .select("amount")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .is("bucket_id", null)
      .gte("transacted_at", w.fromTs)
      .lte("transacted_at", w.toTs)),
  ]);

  for (const r of rules) add(r.bucket_id, prorate(r, w));
  for (const e of entries) add(e.bucket_id, Number(e.amount ?? 0));
  for (const t of rampCateg) add(t.bucket_id, Number(t.amount ?? 0));
  const uncat = {
    total: uncatRows.reduce((s, r) => s + Number(r.amount ?? 0), 0),
    count: uncatRows.length,
  };
  return { perBucket, uncategorized: uncat };
}

async function payrollDriverAndAdjustments(orgId: string, w: Window): Promise<{ total: number; count: number }> {
  const [q1, q2, adj] = await Promise.all([
    fetchAll<{ driver_pay: string | number | null }>("events (q1)", () => supabase
      .from("events")
      .select("driver_pay")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("driver_pay", "is", null)
      .is("deferred_to_week", null)
      .gte("start", w.from)
      .lte("start", `${w.to}T23:59:59`)),
    fetchAll<{ driver_pay: string | number | null }>("events (q2)", () => supabase
      .from("events")
      .select("driver_pay")
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .not("driver_pay", "is", null)
      .not("deferred_to_week", "is", null)
      .gte("deferred_to_week", w.from)
      .lte("deferred_to_week", w.to)),
    fetchAll<{ amount: string | number | null }>("payroll_adjustments", () => supabase
      .from("payroll_adjustments")
      .select("amount")
      .eq("org_id", orgId)
      .gte("week_start", w.from)
      .lte("week_start", w.to)),
  ]);
  const rows = [...q1, ...q2];
  const loadPay = rows.reduce((s, r) => s + Number(r.driver_pay ?? 0), 0);
  const adjSum  = adj.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  return { total: loadPay + adjSum, count: rows.length };
}

async function mudflapFuel(orgId: string, w: Window): Promise<{ total: number; count: number }> {
  const rows = await fetchAll<{ total_charged: string | number | null }>("fuel_transactions", () => supabase
    .from("fuel_transactions")
    .select("total_charged")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("transaction_date", w.from)
    .lte("transaction_date", w.to));
  return {
    total: rows.reduce((s, r) => s + Number(r.total_charged ?? 0), 0),
    count: rows.length,
  };
}

expenses.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const w    = parseWindow(new URL(c.req.url));
  const prev = prevWindow(w);

  try {
    // Load bucket tree + auto-injected sources for both windows.
    const [{ data: buckets, error: bErr }, driver, fuel, driverPrev, fuelPrev] = await Promise.all([
      supabase
        .from("expense_buckets")
        .select("id, parent_id, name, icon, color, sort_order, system_role")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .order("sort_order", { ascending: true }),
      payrollDriverAndAdjustments(orgId, w),
      mudflapFuel(orgId, w),
      payrollDriverAndAdjustments(orgId, prev),
      mudflapFuel(orgId, prev),
    ]);
    if (bErr) throw new Error(`buckets: ${bErr.message}`);
    const bucketRows = (buckets ?? []) as BucketRow[];
    const bucketIds  = new Set(bucketRows.map(b => b.id));

    const [cur, past] = await Promise.all([
      snapshot(orgId, w,    bucketIds),
      snapshot(orgId, prev, bucketIds),
    ]);

    // Route auto-injected sources into the buckets flagged with the
    // matching system_role. If no bucket carries a role, the amounts
    // silently do nothing (client shows a warning).
    for (const b of bucketRows) {
      if (b.system_role === 'driver_pay') {
        const cur1  = cur.perBucket.get(b.id)  ?? { total: 0, count: 0 };
        const past1 = past.perBucket.get(b.id) ?? { total: 0, count: 0 };
        cur1.total  += driver.total;      cur1.count  += driver.count;
        past1.total += driverPrev.total;  past1.count += driverPrev.count;
        cur.perBucket.set(b.id, cur1);
        past.perBucket.set(b.id, past1);
      }
      if (b.system_role === 'mudflap_fuel') {
        const cur1  = cur.perBucket.get(b.id)  ?? { total: 0, count: 0 };
        const past1 = past.perBucket.get(b.id) ?? { total: 0, count: 0 };
        cur1.total  += fuel.total;      cur1.count  += fuel.count;
        past1.total += fuelPrev.total;  past1.count += fuelPrev.count;
        cur.perBucket.set(b.id, cur1);
        past.perBucket.set(b.id, past1);
      }
    }

    // Roll children into parents. Build a summary node per bucket then
    // nest.
    interface Node {
      row:      BucketRow;
      selfTotal: number;
      selfCount: number;
      selfPrevTotal: number;
      selfPrevCount: number;
    }
    const nodes: Map<string, Node> = new Map();
    for (const b of bucketRows) {
      const c1 = cur.perBucket.get(b.id)  ?? { total: 0, count: 0 };
      const p1 = past.perBucket.get(b.id) ?? { total: 0, count: 0 };
      nodes.set(b.id, {
        row: b,
        selfTotal: c1.total, selfCount: c1.count,
        selfPrevTotal: p1.total, selfPrevCount: p1.count,
      });
    }

    // Build children index.
    const kidsOf = new Map<string, BucketRow[]>();
    for (const b of bucketRows) {
      if (!b.parent_id) continue;
      const arr = kidsOf.get(b.parent_id) ?? [];
      arr.push(b);
      kidsOf.set(b.parent_id, arr);
    }

    const tops = bucketRows.filter(b => !b.parent_id);
    const buckets_out: ExpenseBucketSummary[] = tops.map(top => {
      const self = nodes.get(top.id)!;
      const kids = (kidsOf.get(top.id) ?? [])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(kid => {
          const kn = nodes.get(kid.id)!;
          return {
            bucketId:       kid.id,
            parentBucketId: top.id,
            name:           kid.name,
            icon:           kid.icon ?? undefined,
            color:          kid.color ?? undefined,
            total:          kn.selfTotal,
            count:          kn.selfCount,
            prevTotal:      kn.selfPrevTotal,
            prevCount:      kn.selfPrevCount,
          } satisfies ExpenseBucketSummary;
        });
      const total     = self.selfTotal     + kids.reduce((s, k) => s + k.total, 0);
      const count     = self.selfCount     + kids.reduce((s, k) => s + k.count, 0);
      const prevTotal = self.selfPrevTotal + kids.reduce((s, k) => s + k.prevTotal, 0);
      const prevCount = self.selfPrevCount + kids.reduce((s, k) => s + k.prevCount, 0);
      return {
        bucketId:       top.id,
        parentBucketId: null,
        name:           top.name,
        icon:           top.icon ?? undefined,
        color:          top.color ?? undefined,
        systemRole:     top.system_role ?? undefined,
        total, count, prevTotal, prevCount,
        children: kids.length ? kids : undefined,
      };
    });

    if (cur.uncategorized.count > 0) {
      buckets_out.push({
        bucketId:       UNCATEGORIZED_BUCKET_ID,
        parentBucketId: null,
        name:           "Uncategorized card spend",
        total:          cur.uncategorized.total,
        count:          cur.uncategorized.count,
        prevTotal:      0,
        prevCount:      0,
      });
    }

    const res: ExpensesSummaryResponse = {
      period: { from: w.from, to: w.to },
      buckets: buckets_out,
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/expenses/summary]", detail);
    return c.json({ error: "summary_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

// ── /ledger ─────────────────────────────────────────────────────────────
//
// Every expense event in the window, normalized to one row shape:
//   ramp       — one row per card transaction
//   mudflap    — one row per fuel_transactions row
//   payroll    — one row per driver per Sat–Fri week (driver_pay from
//                events + payroll_adjustments merged by name+week)
//   entry      — one row per one-time expense entry
//   recurring  — one prorated posting row per active rule
//
// The client does search/sort/filter/pagination locally — a week is a
// few hundred rows at most; the 2000-row safeguard covers YTD pulls.

/** Saturday (YYYY-MM-DD) of the Sat–Fri week containing `dateIso`. */
function satOfWeek(dateIso: string): string {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const daysSinceSat = (d.getUTCDay() + 1) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceSat);
  return d.toISOString().slice(0, 10);
}

expenses.get("/ledger", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const w     = parseWindow(url);
  // Post-backfill, a half-year window runs ~5-6k rows; the old 2000-row
  // cap silently dropped the OLDEST rows (sort is date-desc), which read
  // as "history missing" on long windows. Cap stays as a runaway guard
  // only; the response includes `total` so the client can surface
  // truncation instead of hiding it.
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10000"), 1), 20000);

  try {
    const [bucketRows, rampRaw, fuelRaw, evQ1, evQ2, adjRaw, entriesRaw, rulesRaw] = await Promise.all([
      fetchAll<{ id: string; name: string; system_role: string | null }>("buckets", () => supabase
        .from("expense_buckets")
        .select("id, name, system_role")
        .eq("org_id", orgId)
        .is("deleted_at", null)),
      fetchAll<RampTransactionRow>("ramp", () => supabase
        .from("ramp_transactions")
        .select(TX_COLS)
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transacted_at", w.fromTs)
        .lte("transacted_at", w.toTs)),
      fetchAll<{
        id: string; transaction_date: string; total_charged: string | number | null;
        location: string | null; driver_name: string | null;
        diesel_gallons: string | number | null; asset_id: number | null;
      }>("fuel", () => supabase
        .from("fuel_transactions")
        .select("id, transaction_date, total_charged, location, driver_name, diesel_gallons, asset_id")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("transaction_date", w.from)
        .lte("transaction_date", w.to)),
      fetchAll<{ driver_pay: string | number | null; driver_name: string | null; start: string }>("events", () => supabase
        .from("events")
        .select("driver_pay, driver_name, start")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .not("driver_pay", "is", null)
        .is("deferred_to_week", null)
        .gte("start", w.from)
        .lte("start", `${w.to}T23:59:59`)),
      fetchAll<{ driver_pay: string | number | null; driver_name: string | null; deferred_to_week: string }>("events-deferred", () => supabase
        .from("events")
        .select("driver_pay, driver_name, deferred_to_week")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .not("driver_pay", "is", null)
        .not("deferred_to_week", "is", null)
        .gte("deferred_to_week", w.from)
        .lte("deferred_to_week", w.to)),
      fetchAll<{ driver_name: string; week_start: string; amount: string | number | null }>("adjustments", () => supabase
        .from("payroll_adjustments")
        .select("driver_name, week_start, amount")
        .eq("org_id", orgId)
        .gte("week_start", w.from)
        .lte("week_start", w.to)),
      fetchAll<{
        id: string; org_id: string; bucket_id: string; kind: string | null;
        date: string; amount: string | number; label: string; notes: string | null;
        created_at: string; updated_at: string;
      }>("entries", () => supabase
        .from("expense_entries")
        .select("id, org_id, bucket_id, kind, date, amount, label, notes, created_at, updated_at")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("date", w.from)
        .lte("date", w.to)),
      fetchAll<{
        id: string; org_id: string; bucket_id: string; kind: string | null;
        label: string; amount: string | number; cadence: string;
        effective_from: string; effective_to: string | null; notes: string | null;
        created_at: string; updated_at: string;
      }>("rules", () => supabase
        .from("recurring_expenses")
        .select("id, org_id, bucket_id, kind, label, amount, cadence, effective_from, effective_to, notes, created_at, updated_at")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .lte("effective_from", w.to)
        .or(`effective_to.is.null,effective_to.gte.${w.from}`)),
    ]);
    const bucketName = new Map(bucketRows.map(b => [b.id, b.name]));
    const driverPayBucket   = bucketRows.find(b => b.system_role === "driver_pay") ?? null;
    const mudflapBucket     = bucketRows.find(b => b.system_role === "mudflap_fuel") ?? null;

    const rows: LedgerRow[] = [];

    // Ramp card transactions
    for (const raw of rampRaw) {
      const tx = rowToTx(raw);
      rows.push({
        rowKey: `ramp:${tx.id}`,
        source: "ramp",
        refId:  tx.id,
        date:   tx.transactedAt.slice(0, 10),
        description: tx.merchantName ?? "Card purchase",
        sub: [tx.memo, tx.cardholderName].filter(Boolean).join(" · ") || undefined,
        amount: tx.amount,
        bucketId: tx.bucketId ?? null,
        bucketName: tx.bucketId ? (bucketName.get(tx.bucketId) ?? null) : null,
        bucketEditable: true,
        assetId: tx.assetId,
        trailerId: tx.trailerId,
        ramp: tx,
      });
    }

    // Mudflap fuel
    for (const f of fuelRaw) {
      rows.push({
        rowKey: `mudflap:${f.id}`,
        source: "mudflap",
        refId:  f.id,
        date:   f.transaction_date,
        description: f.location ?? "Fuel purchase",
        sub: f.driver_name ?? undefined,
        amount: Number(f.total_charged ?? 0),
        bucketId: mudflapBucket?.id ?? null,
        bucketName: mudflapBucket?.name ?? null,
        bucketEditable: false,
        assetId: f.asset_id ?? undefined,
        mudflap: {
          location: f.location,
          driverName: f.driver_name,
          gallons: f.diesel_gallons != null ? Number(f.diesel_gallons) : null,
          assetId: f.asset_id,
        },
      });
    }

    // Payroll — one row per driver per Sat–Fri week
    interface WeekAgg { driverName: string; weekStart: string; loadPay: number; adjustments: number; loadCount: number; }
    const weekly = new Map<string, WeekAgg>();
    const bump = (name: string | null, weekStart: string, pay: number, isLoad: boolean) => {
      const display = name?.trim() || "(No driver)";
      const key = `${display.toLowerCase()}|${weekStart}`;
      const agg = weekly.get(key) ?? { driverName: display, weekStart, loadPay: 0, adjustments: 0, loadCount: 0 };
      if (isLoad) { agg.loadPay += pay; agg.loadCount += 1; }
      else        { agg.adjustments += pay; }
      weekly.set(key, agg);
    };
    for (const e of evQ1) {
      bump(e.driver_name, satOfWeek(e.start), Number(e.driver_pay ?? 0), true);
    }
    for (const e of evQ2) {
      bump(e.driver_name, e.deferred_to_week, Number(e.driver_pay ?? 0), true);
    }
    for (const a of adjRaw) {
      bump(a.driver_name, a.week_start, Number(a.amount ?? 0), false);
    }
    const fmtAdj = (n: number) =>
      `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })} adj`;
    for (const agg of weekly.values()) {
      const subParts = [
        `wk of ${agg.weekStart}`,
        agg.loadCount ? `${agg.loadCount} load${agg.loadCount === 1 ? "" : "s"}` : null,
        agg.adjustments !== 0 ? fmtAdj(agg.adjustments) : null,
      ].filter(Boolean);
      rows.push({
        rowKey: `payroll:${agg.driverName.toLowerCase()}|${agg.weekStart}`,
        source: "payroll",
        refId:  agg.weekStart,
        date:   agg.weekStart,
        description: `Weekly pay · ${agg.driverName}`,
        sub: subParts.join(" · "),
        amount: agg.loadPay + agg.adjustments,
        bucketId: driverPayBucket?.id ?? null,
        bucketName: driverPayBucket?.name ?? null,
        bucketEditable: false,
        payroll: agg,
      });
    }

    // One-time entries
    for (const e of entriesRaw) {
      const entry: ExpenseEntry = {
        id: e.id, orgId: e.org_id, bucketId: e.bucket_id,
        bucketName: bucketName.get(e.bucket_id) ?? undefined,
        kind: e.kind ?? undefined, date: e.date, amount: Number(e.amount),
        label: e.label, notes: e.notes ?? undefined,
        createdAt: e.created_at, updatedAt: e.updated_at,
      };
      rows.push({
        rowKey: `entry:${entry.id}`,
        source: "entry",
        refId:  entry.id,
        date:   entry.date,
        description: entry.label,
        sub: [entry.kind, entry.notes].filter(Boolean).join(" · ") || undefined,
        amount: entry.amount,
        bucketId: entry.bucketId,
        bucketName: entry.bucketName ?? null,
        bucketEditable: true,
        entry,
      });
    }

    // Recurring rules → one prorated posting per rule for the window
    for (const r of rulesRaw) {
      const prorated = prorate(
        { bucket_id: r.bucket_id, amount: r.amount, cadence: r.cadence,
          effective_from: r.effective_from, effective_to: r.effective_to },
        w,
      );
      if (prorated <= 0) continue;
      const rule: RecurringExpense = {
        id: r.id, orgId: r.org_id, bucketId: r.bucket_id,
        bucketName: bucketName.get(r.bucket_id) ?? undefined,
        kind: r.kind ?? undefined, label: r.label, amount: Number(r.amount),
        cadence: r.cadence as RecurringExpenseCadence,
        effectiveFrom: r.effective_from, effectiveTo: r.effective_to ?? undefined,
        notes: r.notes ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
      };
      const periodDays  = r.cadence === "weekly" ? 7 : 30.4375;
      const overlapDays = Math.round((prorated / Number(r.amount)) * periodDays);
      rows.push({
        rowKey: `recurring:${r.id}`,
        source: "recurring",
        refId:  r.id,
        date:   w.from,
        description: rule.label,
        sub: `recurring · $${Number(r.amount).toLocaleString("en-US")} / ${r.cadence === "weekly" ? "wk" : "mo"} → prorated for this period`,
        amount: prorated,
        bucketId: rule.bucketId,
        bucketName: rule.bucketName ?? null,
        bucketEditable: false,
        recurring: { ...rule, prorated, overlapDays },
      });
    }

    rows.sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 :
      a.description.localeCompare(b.description));

    const res: ExpensesLedgerResponse = {
      period: { from: w.from, to: w.to },
      rows:   rows.slice(0, limit),
      total:  rows.length,
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/expenses/ledger]", detail);
    return c.json({ error: "ledger_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

// ── /revenue-adjustments ────────────────────────────────────────────────
//
// Manual revenue for pre-system periods (the January 2026 spreadsheet
// backfill). The workspace adds this to the loads-report revenue in
// the meter. Read-only endpoint — rows are managed via SQL for now;
// they change roughly never.

expenses.get("/revenue-adjustments", async (c) => {
  const orgId = c.get("orgId");
  const w = parseWindow(new URL(c.req.url));
  try {
    const rows = await fetchAll<{ id: string; date: string; amount: string | number; note: string | null }>(
      "revenue_adjustments", () => supabase
        .from("revenue_adjustments")
        .select("id, date, amount, note")
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .gte("date", w.from)
        .lte("date", w.to));
    const adjustments: RevenueAdjustment[] = rows.map(r => ({
      id: r.id, date: r.date, amount: Number(r.amount), note: r.note ?? undefined,
    }));
    const res: ListRevenueAdjustmentsResponse = {
      adjustments,
      total: adjustments.reduce((s, a) => s + a.amount, 0),
    };
    return c.json(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/expenses/revenue-adjustments]", detail);
    return c.json({ error: "revenue_adjustments_failed", detail } satisfies ApiErrorResponse, 500);
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
      id: string; date: string; amount: string | number;
      kind: string | null; label: string;
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
