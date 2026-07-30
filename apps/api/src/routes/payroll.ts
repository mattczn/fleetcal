/**
 * /v1/payroll — driver pay adjustments + finalized records.
 *
 * Endpoints:
 *   GET    /v1/payroll/adjustments[?weekStart=&driverName=]
 *   POST   /v1/payroll/adjustments
 *   DELETE /v1/payroll/adjustments/:id
 *   GET    /v1/payroll/records?driverName=[&weekStart=][&includeSuperseded=1]
 *   POST   /v1/payroll/records              — finalize (snapshot)
 *   DELETE /v1/payroll/records/:id          — reopen (supersede, not delete)
 *
 * Records are APPEND-ONLY (migration 20260728_payroll_records_snapshot).
 * Finalizing inserts a row carrying the frozen line_items behind its
 * total; reopening or re-finalizing stamps superseded_* on the row that
 * was in force and leaves it there. Reads default to live rows only —
 * anything that SUMS records would double-count a re-finalized week
 * otherwise.
 */

import { Hono } from "hono";
import {
  type PayrollAdjustment,
  type PayrollLineItem,
  type PayrollRecord,
  type ListPayrollAdjustmentsResponse,
  type CreatePayrollAdjustmentRequest,
  type CreatePayrollAdjustmentResponse,
  type DeletePayrollAdjustmentResponse,
  type ListPayrollRecordsResponse,
  type UpsertPayrollRecordRequest,
  type UpsertPayrollRecordResponse,
  type DeletePayrollRecordResponse,
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
  line_items: unknown;
  finalized_by: string | null;
  finalized_by_name: string | null;
  superseded_at: string | null;
  superseded_by: string | null;
  superseded_by_name: string | null;
  superseded_reason: string | null;
}

/** Defensive read of the jsonb snapshot.
 *
 *  line_items is a document, not a typed column — a malformed or legacy
 *  value must degrade to "no frozen detail" (the record's total_pay is
 *  still authoritative) rather than throw on a payroll read. */
function parseLineItems(raw: unknown): PayrollLineItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw.filter(
    (x): x is PayrollLineItem =>
      !!x && typeof x === "object" &&
      typeof (x as PayrollLineItem).amount === "number",
  );
  return items.length > 0 ? items : undefined;
}

function rowToRec(r: RecRow): PayrollRecord {
  return {
    id:           r.id,
    driverName:   r.driver_name,
    weekStart:    r.week_start,
    totalPay:     Number(r.total_pay),
    finalizedAt:  r.finalized_at,
    notes:        r.notes ?? undefined,
    lineItems:        parseLineItems(r.line_items),
    finalizedBy:      r.finalized_by ?? undefined,
    finalizedByName:  r.finalized_by_name ?? undefined,
    supersededAt:     r.superseded_at ?? undefined,
    supersededBy:     r.superseded_by ?? undefined,
    supersededByName: r.superseded_by_name ?? undefined,
    supersededReason:
      r.superseded_reason === "reopen" || r.superseded_reason === "refinalize"
        ? r.superseded_reason
        : undefined,
  };
}

const ADJ_COLS = "id,driver_name,week_start,category,description,amount,created_at,inspection_report_id";
// Must stay a single string LITERAL — supabase-js parses it at the type
// level to shape the row, and a concatenated expression degrades to
// `string`, which turns every select into GenericStringError.
const REC_COLS = "id,driver_name,week_start,total_pay,finalized_at,notes,line_items,finalized_by,finalized_by_name,superseded_at,superseded_by,superseded_by_name,superseded_reason";

/** The record currently in force for a driver-week, or null.
 *
 *  Exact driver_name match on purpose: records are keyed by name string
 *  and the client resolves rename aliases before it calls us. A fuzzy
 *  match here could flag the WRONG week as finalized, which is worse
 *  than missing a flag (the UI's own snapshot-vs-live diff still catches
 *  the aliased case). */
async function activeRecordFor(
  orgId: string, driverName: string, weekStart: string,
): Promise<RecRow | null> {
  const { data, error } = await supabase
    .from("payroll_records")
    .select(REC_COLS)
    .eq("org_id", orgId)
    .eq("driver_name", driverName)
    .eq("week_start", weekStart)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) {
    console.error("[payroll] activeRecordFor failed:", error);
    return null;
  }
  return (data as RecRow | null) ?? null;
}

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

// Writing an adjustment into an ALREADY-FINALIZED week is allowed, and
// the response says so (weekFinalized).
//
// Rejecting was the other option, and it traps the dispatcher. Real
// corrections arrive after a week is closed — a fuel advance that came
// in late, a cleanliness deduction raised from an inspection, the
// POSITIVE half of a deferral landing in a week that has since been
// finalized (the negative half is written by the same flow into a
// different week, so a hard reject would leave payroll half-written and
// unbalanced). With a reject, the only way to record any of those is
// Reopen — which used to destroy the finalized record outright, so the
// "safe" answer was the destructive one.
//
// Accepting is only safe because the finalized total is now a SNAPSHOT:
// a new adjustment cannot move a finalized stub, it can only make live
// values diverge from it. That divergence is a thing the dispatcher must
// SEE, not a thing to prevent — so we tell the caller, and the payroll
// card renders a "current values differ from what was finalized" banner
// with an explicit Re-finalize action. Nothing is silently reconciled,
// and nothing is blocked.
payroll.post("/adjustments", requireCapability("payroll.adjust"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreatePayrollAdjustmentRequest>();
  if (!body.driverName || !body.weekStart || !body.category || typeof body.amount !== "number") {
    return c.json({
      error: "validation_failed",
      errors: ["driverName, weekStart, category, amount required"],
    } satisfies ApiErrorResponse, 400);
  }
  const finalized = await activeRecordFor(orgId, body.driverName, body.weekStart);
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
  const res: CreatePayrollAdjustmentResponse = {
    adjustment: rowToAdj(data as AdjRow),
    ...(finalized
      ? {
          weekFinalized:     true,
          finalizedRecordId: finalized.id,
          finalizedTotalPay: Number(finalized.total_pay),
        }
      : {}),
  };
  return c.json(res, 201);
});

// Same accept-and-flag contract as POST (see the note above). Returns
// 200 + a body instead of the old bare 204 so the flag has somewhere to
// live; callers that ignore the body are unaffected.
payroll.delete("/adjustments/:id", requireCapability("payroll.adjust"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  // Read the row before deleting — it's the only way to know which
  // driver-week this adjustment belonged to, and therefore whether that
  // week is finalized.
  const { data: existing } = await supabase
    .from("payroll_adjustments")
    .select("driver_name,week_start")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const existingRow = existing as { driver_name: string; week_start: string } | null;
  const finalized = existingRow
    ? await activeRecordFor(orgId, existingRow.driver_name, existingRow.week_start)
    : null;
  const { error } = await supabase
    .from("payroll_adjustments")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/payroll/adjustments/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: DeletePayrollAdjustmentResponse = finalized
    ? {
        weekFinalized:     true,
        finalizedRecordId: finalized.id,
        finalizedTotalPay: Number(finalized.total_pay),
      }
    : {};
  return c.json(res, 200);
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
  //   - includeSuperseded=1   also return reopened / replaced records
  const driverName     = url.searchParams.get("driverName");
  const weekStart      = url.searchParams.get("weekStart");
  const weekStartFrom  = url.searchParams.get("weekStartFrom");
  const weekStartTo    = url.searchParams.get("weekStartTo");
  // Superseded records are HISTORY, not current payroll. They are
  // excluded by default because every summing caller — the dashboard's
  // Total Payroll KPI above all — would otherwise count a re-finalized
  // week two or three times. Opt in explicitly to audit a week.
  const includeSuperseded = url.searchParams.get("includeSuperseded") === "1";

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
    .order("week_start", { ascending: false })
    .order("finalized_at", { ascending: false });
  if (!includeSuperseded) q = q.is("superseded_at", null);
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

// Finalize = take a SNAPSHOT, not just a total.
//
// Supersede-then-insert rather than upsert: records are append-only, and
// the partial unique index from 20260728 (live rows only) can't be used
// for PostgREST's ON CONFLICT inference anyway. Re-finalizing a week
// therefore leaves the previous amount, its lines, and who signed it in
// the table, marked 'refinalize'.
payroll.post("/records", requireCapability("payroll.finalize"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<UpsertPayrollRecordRequest>();
  if (!body.driverName || !body.weekStart || typeof body.totalPay !== "number") {
    return c.json({
      error: "validation_failed",
      errors: ["driverName, weekStart, totalPay required"],
    } satisfies ApiErrorResponse, 400);
  }
  if (!Number.isFinite(body.totalPay)) {
    return c.json({
      error: "validation_failed",
      errors: ["totalPay must be a finite number"],
    } satisfies ApiErrorResponse, 400);
  }
  // Reject a snapshot whose lines don't add up to the total we're about
  // to record. The two are stored redundantly on purpose (see the
  // migration), which is only sound if they agree at write time — a
  // stub that doesn't foot is worse than no stub. Half-cent tolerance
  // for float summation.
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : null;
  if (lineItems) {
    const bad = lineItems.find(li => !li || typeof li.amount !== "number" || !Number.isFinite(li.amount));
    if (bad) {
      return c.json({
        error: "validation_failed",
        errors: ["every lineItem needs a finite numeric amount"],
      } satisfies ApiErrorResponse, 400);
    }
    const sum = lineItems.reduce((s, li) => s + li.amount, 0);
    if (Math.abs(sum - body.totalPay) > 0.005) {
      return c.json({
        error: "validation_failed",
        errors: [`lineItems sum to ${sum.toFixed(2)} but totalPay is ${body.totalPay.toFixed(2)}`],
      } satisfies ApiErrorResponse, 400);
    }
  }

  const now = new Date().toISOString();
  const previous = await activeRecordFor(orgId, body.driverName, body.weekStart);
  if (previous) {
    // Retire the outgoing record FIRST — the partial unique index would
    // reject the insert below while two live rows exist for the week.
    const { error: supErr } = await supabase
      .from("payroll_records")
      .update({
        superseded_at:      now,
        superseded_by:      userId,
        superseded_by_name: body.finalizedByName ?? null,
        superseded_reason:  "refinalize",
      } as never)
      .eq("id", previous.id)
      .eq("org_id", orgId)
      .is("superseded_at", null);
    if (supErr) {
      console.error("[POST /v1/payroll/records] supersede failed:", supErr);
      return c.json({ error: "upsert_failed", detail: supErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  const { data, error } = await supabase
    .from("payroll_records")
    .insert({
      org_id:            orgId,
      driver_name:       body.driverName,
      week_start:        body.weekStart,
      total_pay:         body.totalPay,
      finalized_at:      now,
      notes:             body.notes ?? null,
      line_items:        lineItems,
      finalized_by:      userId,
      finalized_by_name: body.finalizedByName ?? null,
    } as never)
    .select(REC_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/payroll/records] insert failed:", error);
    return c.json({ error: "upsert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpsertPayrollRecordResponse = {
    record: rowToRec(data as RecRow),
    ...(previous ? { supersededRecord: rowToRec(previous) } : {}),
  };
  return c.json(res);
});

// Reopen. Soft — the record is stamped superseded and stays. A hard
// DELETE here used to destroy the amount a human signed off on, with
// nothing left to say a driver had ever been paid that week.
payroll.delete("/records/:id", requireCapability("payroll.finalize"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id = c.req.param("id");
  let reopenedByName: string | null = null;
  try {
    // Body is optional on a DELETE; a missing/blank one just means no
    // display label.
    const body = await c.req.json<{ reopenedByName?: string | null }>();
    reopenedByName = body?.reopenedByName ?? null;
  } catch { /* no body sent */ }

  const { data, error } = await supabase
    .from("payroll_records")
    .update({
      superseded_at:      new Date().toISOString(),
      superseded_by:      userId,
      superseded_by_name: reopenedByName,
      superseded_reason:  "reopen",
    } as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("superseded_at", null)   // never re-stamp an already-retired row
    .select(REC_COLS)
    .maybeSingle();
  if (error) {
    console.error("[DELETE /v1/payroll/records/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) {
    // Either no such record in this org, or it was already reopened by
    // someone else. Idempotent from the caller's point of view.
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const res: DeletePayrollRecordResponse = { record: rowToRec(data as RecRow) };
  return c.json(res);
});

export default payroll;
