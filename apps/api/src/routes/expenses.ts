/**
 * /v1/expenses — federated dashboard endpoints over the existing spend
 * sources (fuel_transactions, payroll_records, ramp_transactions). No
 * new storage — just rollups + a normalized activity feed.
 *
 * Buckets grow over time (equipment depreciation, tolls, insurance) but
 * each is federated in via a query addition here, not a data pipe.
 * Once bucket boundaries stabilize this can be swapped for a
 * materialized view without changing the response shape.
 *
 * Module-gated on "expenses" (Curzon-only default-ON, mirrors the
 * maintenance pattern).
 */

import { Hono } from "hono";
import type {
  ExpensesSummaryResponse,
  ExpenseBucket,
  ExpensesActivityResponse,
  ExpenseEvent,
  ApiErrorResponse,
} from "@fleetcal/types";

import { supabase as supabaseTyped } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = supabaseTyped as any;

const expenses = new Hono<{ Variables: AuthVariables }>();
expenses.use("*", requireModule("expenses"), requireCapability("expenses.access"));

/** Parse ?from=&to= as ISO date strings (YYYY-MM-DD). If either is
 *  missing, defaults to the current Sat–Fri week (matching the web
 *  PeriodSelector's default). Returns start-of-day / end-of-day
 *  timestamps so the SQL between-clauses cover full inclusive days. */
function parseWindow(url: URL): { from: string; to: string; fromTs: string; toTs: string } {
  const q = (k: string) => url.searchParams.get(k);
  const now = new Date();
  let from = q("from");
  let to   = q("to");
  if (!from || !to) {
    // Default: this Sat-Fri week (Saturday = weekday 6 in JS).
    const day = now.getUTCDay();
    const daysSinceSat = (day + 1) % 7; // Sat→0, Sun→1, …, Fri→6
    const sat = new Date(now);
    sat.setUTCHours(0, 0, 0, 0);
    sat.setUTCDate(sat.getUTCDate() - daysSinceSat);
    const fri = new Date(sat);
    fri.setUTCDate(sat.getUTCDate() + 6);
    from = sat.toISOString().slice(0, 10);
    to   = fri.toISOString().slice(0, 10);
  }
  return {
    from, to,
    fromTs: `${from}T00:00:00Z`,
    toTs:   `${to}T23:59:59Z`,
  };
}

function prevWindow(from: string, to: string): { from: string; to: string; fromTs: string; toTs: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end   = new Date(`${to}T00:00:00Z`);
  const days  = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  const pf = prevStart.toISOString().slice(0, 10);
  const pt = prevEnd.toISOString().slice(0, 10);
  return {
    from: pf, to: pt,
    fromTs: `${pf}T00:00:00Z`,
    toTs:   `${pt}T23:59:59Z`,
  };
}

async function fuelBucket(orgId: string, fromTs: string, toTs: string) {
  const { data, error } = await supabase
    .from("fuel_transactions")
    .select("total_charged")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("transaction_date", fromTs.slice(0, 10))
    .lte("transaction_date", toTs.slice(0, 10));
  if (error) throw new Error(`fuel bucket: ${error.message}`);
  const rows = (data ?? []) as Array<{ total_charged: string | number | null }>;
  return {
    total: rows.reduce((acc, r) => acc + Number(r.total_charged ?? 0), 0),
    count: rows.length,
  };
}

async function payrollBucket(orgId: string, from: string, to: string) {
  // payroll_records.week_start is a date column (Mon-of-week). We match
  // any week_start falling inside the requested window. The Sat–Fri
  // dashboard week can straddle a payroll Mon-Sun week; that's fine —
  // the dashboard is a directional signal, not a payroll report.
  const { data, error } = await supabase
    .from("payroll_records")
    .select("total_pay, driver_name")
    .eq("org_id", orgId)
    .gte("week_start", from)
    .lte("week_start", to);
  if (error) throw new Error(`payroll bucket: ${error.message}`);
  const rows = (data ?? []) as Array<{ total_pay: string | number | null; driver_name: string }>;
  const drivers = new Set(rows.map(r => r.driver_name));
  return {
    total: rows.reduce((acc, r) => acc + Number(r.total_pay ?? 0), 0),
    count: drivers.size,
  };
}

async function cardsBucket(orgId: string, fromTs: string, toTs: string) {
  const { data, error } = await supabase
    .from("ramp_transactions")
    .select("amount, match_status")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .gte("transacted_at", fromTs)
    .lte("transacted_at", toTs);
  if (error) throw new Error(`cards bucket: ${error.message}`);
  const rows = (data ?? []) as Array<{ amount: string | number; match_status: string }>;
  const total = rows.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
  const unmatched = rows.filter(r => r.match_status === "unmatched").length;
  return { total, count: rows.length, unmatched };
}

// GET /v1/expenses/summary — bucket rollups for the requested window
// plus counts for the prior equal-length window (for Δ arrows on tiles).
expenses.get("/summary", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const w    = parseWindow(url);
  const prev = prevWindow(w.from, w.to);

  try {
    const [fuel, payroll, cards, prevFuel, prevPayroll, prevCards] = await Promise.all([
      fuelBucket(orgId, w.fromTs, w.toTs),
      payrollBucket(orgId, w.from, w.to),
      cardsBucket(orgId, w.fromTs, w.toTs),
      fuelBucket(orgId, prev.fromTs, prev.toTs),
      payrollBucket(orgId, prev.from, prev.to),
      cardsBucket(orgId, prev.fromTs, prev.toTs),
    ]);

    const buckets: ExpenseBucket[] = [
      {
        key: "fuel",
        label: "Fuel",
        total: fuel.total,
        count: fuel.count,
        prevTotal: prevFuel.total,
        prevCount: prevFuel.count,
      },
      {
        key: "payroll",
        label: "Payroll",
        total: payroll.total,
        count: payroll.count,
        prevTotal: prevPayroll.total,
        prevCount: prevPayroll.count,
      },
      {
        key: "cards",
        label: "Card Spend",
        total: cards.total,
        count: cards.count,
        prevTotal: prevCards.total,
        prevCount: prevCards.count,
        meta: { unmatched: cards.unmatched },
      },
    ];

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

// GET /v1/expenses/activity — most recent N events across all sources
// as a unified feed. Pulls limit from each source, merges + sorts by
// date desc, takes top limit.
expenses.get("/activity", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const w = parseWindow(url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);

  try {
    const [fuelRes, payrollRes, cardsRes] = await Promise.all([
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
        .from("payroll_records")
        .select("id, week_start, total_pay, driver_name, finalized_at")
        .eq("org_id", orgId)
        .gte("week_start", w.from)
        .lte("week_start", w.to)
        .order("finalized_at", { ascending: false })
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
    for (const r of (payrollRes.data ?? []) as Array<{
      id: string; week_start: string; total_pay: string | number | null;
      driver_name: string; finalized_at: string | null;
    }>) {
      events.push({
        source: "payroll",
        id: r.id,
        at: r.finalized_at ?? `${r.week_start}T12:00:00Z`,
        amount: Number(r.total_pay ?? 0),
        description: `Weekly pay · ${r.driver_name}`,
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
