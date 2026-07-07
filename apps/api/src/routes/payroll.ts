/**
 * /v1/payroll — driver pay adjustments + finalized records.
 *
 * Endpoints:
 *   GET    /v1/payroll/adjustments[?weekStart=&driverName=]
 *   POST   /v1/payroll/adjustments
 *   DELETE /v1/payroll/adjustments/:id
 *   GET    /v1/payroll/records?driverName=[&weekStart=]
 *   POST   /v1/payroll/records              — upsert (finalize)
 *   DELETE /v1/payroll/records/:id          — unfinalize
 */

import { Hono } from "hono";
import {
  type PayrollAdjustment,
  type PayrollRecord,
  type ListPayrollAdjustmentsResponse,
  type CreatePayrollAdjustmentRequest,
  type CreatePayrollAdjustmentResponse,
  type ListPayrollRecordsResponse,
  type UpsertPayrollRecordRequest,
  type UpsertPayrollRecordResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { loadExcludedDrivers } from "../lib/reportExclusions.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

const payroll = new Hono<{ Variables: AuthVariables }>();

// Every payroll endpoint requires payroll.access at minimum (Owner /
// Admin only). Mutating endpoints additionally pin to .adjust or
// .finalize. Read endpoints below the line stay open to anyone with
// payroll.access — currently the same set of users, but keeps the
// option to give Accountant role read-only access later.
payroll.use("*", requireModule("payroll"), requireCapability("payroll.access"));

interface AdjRow {
  id: string;
  driver_name: string;
  week_start: string;
  category: string;
  description: string | null;
  amount: number | string;
  created_at: string;
  inspection_report_id: string | null;
}
function rowToAdj(r: AdjRow): PayrollAdjustment {
  return {
    id:          r.id,
    driverName:  r.driver_name,
    weekStart:   r.week_start,
    category:    r.category,
    description: r.description ?? undefined,
    amount:      Number(r.amount),
    createdAt:   r.created_at,
    inspectionReportId: r.inspection_report_id ?? undefined,
  };
}

interface RecRow {
  id: string;
  driver_name: string;
  week_start: string;
  total_pay: number | string;
  finalized_at: string;
  notes: string | null;
}
function rowToRec(r: RecRow): PayrollRecord {
  return {
    id:           r.id,
    driverName:   r.driver_name,
    weekStart:    r.week_start,
    totalPay:     Number(r.total_pay),
    finalizedAt:  r.finalized_at,
    notes:        r.notes ?? undefined,
  };
}

const ADJ_COLS = "id,driver_name,week_start,category,description,amount,created_at,inspection_report_id";
const REC_COLS = "id,driver_name,week_start,total_pay,finalized_at,notes";

// ── Adjustments ─────────────────────────────────────────────────────────

payroll.get("/adjustments", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const weekStart  = url.searchParams.get("weekStart");
  const driverName = url.searchParams.get("driverName");
  const inspectionReportId = url.searchParams.get("inspectionReportId");

  let q = supabase
    .from("payroll_adjustments")
    .select(ADJ_COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (weekStart)  q = q.eq("week_start", weekStart);
  if (driverName) q = q.eq("driver_name", driverName);
  if (inspectionReportId) q = q.eq("inspection_report_id", inspectionReportId);

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/payroll/adjustments] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListPayrollAdjustmentsResponse = {
    adjustments: ((data ?? []) as AdjRow[]).map(rowToAdj),
  };
  return c.json(res);
});

payroll.post("/adjustments", requireCapability("payroll.adjust"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreatePayrollAdjustmentRequest>();
  if (!body.driverName || !body.weekStart || !body.category || typeof body.amount !== "number") {
    return c.json({
      error: "validation_failed",
      errors: ["driverName, weekStart, category, amount required"],
    } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("payroll_adjustments")
    .insert({
      org_id:      orgId,
      driver_name: body.driverName,
      week_start:  body.weekStart,
      category:    body.category,
      description: body.description ?? null,
      amount:      body.amount,
      inspection_report_id: body.inspectionReportId ?? null,
    } as never)
    .select(ADJ_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/payroll/adjustments] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreatePayrollAdjustmentResponse = { adjustment: rowToAdj(data as AdjRow) };
  return c.json(res, 201);
});

payroll.delete("/adjustments/:id", requireCapability("payroll.adjust"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("payroll_adjustments")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/payroll/adjustments/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

// ── Records ─────────────────────────────────────────────────────────────

payroll.get("/records", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  // All filters are optional. Omitting every filter returns every
  // finalized record for the org, ordered newest-first — used by the
  // dashboard's Total Payroll KPI to sum across whatever weeks fall
  // inside the selected period.
  //
  // Filters compose:
  //   - driverName            single driver
  //   - weekStart             single specific week (YYYY-MM-DD Saturday)
  //   - weekStartFrom/To      range of week-start dates (inclusive)
  const driverName     = url.searchParams.get("driverName");
  const weekStart      = url.searchParams.get("weekStart");
  const weekStartFrom  = url.searchParams.get("weekStartFrom");
  const weekStartTo    = url.searchParams.get("weekStartTo");

  // Owner-op exclusion. Records are stored keyed by driver_name (no
  // FK column). Drop any record whose driver matches the excluded
  // set so the dashboard Total Payroll KPI + the payroll list don't
  // count settlements that go outside the carrier's own payroll. An
  // explicit driverName filter overrides — if you query a specific
  // owner-op by name, you still get their records (you asked).
  const excluded = await loadExcludedDrivers(orgId);

  let q = supabase
    .from("payroll_records")
    .select(REC_COLS)
    .eq("org_id", orgId)
    .order("week_start", { ascending: false });
  if (driverName)    q = q.eq("driver_name", driverName);
  if (weekStart)     q = q.eq("week_start", weekStart);
  if (weekStartFrom) q = q.gte("week_start", weekStartFrom);
  if (weekStartTo)   q = q.lte("week_start", weekStartTo);

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/payroll/records] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const records = ((data ?? []) as RecRow[]).map(rowToRec);
  const filtered = driverName
    ? records // explicit name query — caller asked for this driver
    : records.filter(r => !excluded.nameSet.has((r.driverName ?? "").trim()));
  const res: ListPayrollRecordsResponse = { records: filtered };
  return c.json(res);
});

payroll.post("/records", requireCapability("payroll.finalize"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<UpsertPayrollRecordRequest>();
  if (!body.driverName || !body.weekStart || typeof body.totalPay !== "number") {
    return c.json({
      error: "validation_failed",
      errors: ["driverName, weekStart, totalPay required"],
    } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("payroll_records")
    .upsert({
      org_id:       orgId,
      driver_name:  body.driverName,
      week_start:   body.weekStart,
      total_pay:    body.totalPay,
      finalized_at: new Date().toISOString(),
      notes:        body.notes ?? null,
    } as never, { onConflict: "org_id,driver_name,week_start" })
    .select(REC_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/payroll/records] failed:", error);
    return c.json({ error: "upsert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpsertPayrollRecordResponse = { record: rowToRec(data as RecRow) };
  return c.json(res);
});

payroll.delete("/records/:id", requireCapability("payroll.finalize"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("payroll_records")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/payroll/records/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default payroll;
