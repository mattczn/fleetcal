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
import { sendPushToDriver } from "../lib/push.js";
import { sendSms, toE164US } from "../lib/twilio.js";
import { env } from "../lib/env.js";
import { randomBytes } from "node:crypto";

import type { SendPaystubResponse } from "@fleetcal/types";

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
  view_token:       string | null;
  sent_at:          string | null;
  sent_via:         string[] | null;
  sms_message_sid:  string | null;
  send_error:       string | null;
  viewed_at:        string | null;
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
    viewToken:     r.view_token      ?? undefined,
    sentAt:        r.sent_at         ?? undefined,
    sentVia:       (r.sent_via ?? []).filter(
                     (v): v is "sms" | "push" => v === "sms" || v === "push",
                   ),
    smsMessageSid: r.sms_message_sid ?? undefined,
    sendError:     r.send_error      ?? undefined,
    viewedAt:      r.viewed_at       ?? undefined,
  };
}

const ADJ_COLS = "id,driver_name,week_start,category,description,amount,created_at,inspection_report_id";
// Must stay a single string LITERAL — supabase-js parses it at the type
// level to shape the row, and a concatenated expression degrades to
// `string`, which turns every select into GenericStringError.
const REC_COLS = "id,driver_name,week_start,total_pay,finalized_at,notes,line_items,finalized_by,finalized_by_name,superseded_at,superseded_by,superseded_by_name,superseded_reason,view_token,sent_at,sent_via,sms_message_sid,send_error,viewed_at";

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
  // Generated Supabase types lag the 20260803 delivery-columns
  // migration; cast through unknown until the types are regenerated.
  return (data as unknown as RecRow | null) ?? null;
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
  const records = ((data ?? []) as unknown as RecRow[]).map(rowToRec);
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
    record: rowToRec(data as unknown as RecRow),
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
  const res: DeletePayrollRecordResponse = { record: rowToRec(data as unknown as RecRow) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/payroll/records/:id/send — send the paystub link to the driver
//
// Fires SMS (if the driver has a phone AND Twilio is configured) and a
// push notification (if the driver has any registered devices). Marks
// the record with delivery state so the payroll UI can show a "Sent"
// chip and the recipient can be re-nudged if the link goes stale.
//
// The record MUST be active — the frozen numbers behind the link are
// exactly what the driver will see, and there's no point sending them
// something that's since been superseded. Reopening a week clears the
// live row's send state (a new row inserted on re-finalize), so a
// corrected paystub needs its own explicit send.
//
// Idempotency: re-sending is allowed and overwrites the delivery state
// with the latest attempt. `view_token` is minted once and reused so
// the link doesn't rotate under a driver who bookmarked it.
// ─────────────────────────────────────────────────────────────────────────

/** ~110 bits of entropy in ~22 base32 chars — collision-free for our
 *  volume and short enough to fit in an SMS with room to spare. */
function mintViewToken(): string {
  // 14 bytes = 112 bits; base32 (no padding) is 5 bits/char → 23 chars.
  const bytes = randomBytes(14);
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"; // no 0/1/l/o
  let bits = 0, value = 0, out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 0x1f];
  return out;
}

function fmtWeekLabel(weekStart: string): string {
  // weekStart is a YYYY-MM-DD; label as MM/DD–MM/DD (7-day window).
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end   = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const mmdd = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${mmdd(start)}–${mmdd(end)}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

payroll.post("/records/:id/send", requireCapability("payroll.finalize"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  // (1) Load record + verify it's active + in this org.
  const { data: recRaw, error: recErr } = await supabase
    .from("payroll_records")
    .select(REC_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (recErr) {
    console.error("[POST /v1/payroll/records/:id/send] fetch failed:", recErr);
    return c.json({ error: "fetch_failed", detail: recErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!recRaw) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const rec = recRaw as unknown as RecRow;
  if (rec.superseded_at) {
    return c.json({
      error:  "record_superseded",
      detail: "This paystub has been reopened or replaced. Re-finalize the week and send the new record.",
    } satisfies ApiErrorResponse, 409);
  }

  // (2) Resolve the driver by exact-name match — same convention every
  //     payroll query uses (records store driver_name as a string). We
  //     need the driver row for phone (SMS) and id (push). Ambiguous
  //     name matches are rare on Curzon-scale fleets and would fail
  //     silently by picking the first row; explicit .limit(2) then
  //     branch keeps that failure visible.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: drvRows } = await (supabase as any)
    .from("drivers")
    .select("id, name, phone")
    .eq("org_id", orgId)
    .eq("name", rec.driver_name)
    .limit(2);
  const drivers = (drvRows ?? []) as Array<{ id: number; name: string; phone: string | null }>;
  if (drivers.length === 0) {
    return c.json({
      error:  "driver_not_found",
      detail: `No driver named "${rec.driver_name}" in this org. Rename the record or add the driver first.`,
    } satisfies ApiErrorResponse, 404);
  }
  if (drivers.length > 1) {
    return c.json({
      error:  "driver_ambiguous",
      detail: `Multiple drivers named "${rec.driver_name}" — deduplicate before sending so the paystub goes to the right person.`,
    } satisfies ApiErrorResponse, 409);
  }
  const driver = drivers[0];

  // (3) Mint the view token on first send. Reuse on resend so a driver
  //     who bookmarked the link doesn't 404.
  const viewToken = rec.view_token ?? mintViewToken();
  const weekLabel = fmtWeekLabel(rec.week_start);
  const netStr    = fmtMoney(Number(rec.total_pay));

  // Both the SMS prefix (companyName) and the paystub URL host
  // (driver_portal_url) are per-org config. Fetched together in one
  // round-trip. Orgs without driver_portal_url set fall back to the
  // process-wide PUBLIC_WEB_URL (which itself falls back to
  // fleetcal.app) — that keeps every existing FleetCal customer
  // working while letting Curzon route paystubs through
  // curzontrucking.com.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settingsRow } = await (supabase as any)
    .from("org_settings")
    .select("invoice_settings, driver_portal_url")
    .eq("org_id", orgId)
    .maybeSingle();
  const orgSettings = settingsRow as {
    invoice_settings:  { companyName?: string } | null;
    driver_portal_url: string | null;
  } | null;
  const orgLabel =
    orgSettings?.invoice_settings?.companyName?.trim() || "Your carrier";
  const paystubHost =
    orgSettings?.driver_portal_url?.trim() || env.publicWebUrl;
  const publicUrl = `${paystubHost.replace(/\/$/, "")}/paystub/${viewToken}`;

  // (4) Fire push (independent of SMS — some drivers have the app but
  //     no valid phone). sendPushToDriver silently no-ops when there
  //     are no registered tokens; we treat "no tokens" as ok so an
  //     app-less driver doesn't fail the whole send.
  let pushResult: SendPaystubResponse["pushResult"];
  try {
    await sendPushToDriver(orgId, driver.id, {
      title: "Paystub ready",
      body:  `${weekLabel} — Net ${netStr}. Tap to view.`,
      data:  { url: `/paystub/${viewToken}`, kind: "paystub" },
    });
    pushResult = { ok: true };
  } catch (err) {
    pushResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // (5) Fire SMS if the driver has a valid phone AND Twilio is set up.
  //     A bad phone or unconfigured Twilio isn't a send-endpoint
  //     failure — it's a per-channel outcome, surfaced back to the UI.
  let smsResult: SendPaystubResponse["smsResult"];
  const e164 = toE164US(driver.phone);
  if (!e164) {
    smsResult = { ok: false, error: driver.phone
        ? `Invalid phone: "${driver.phone}" — expected +1XXXXXXXXXX or 10 digits.`
        : "Driver has no phone number on file." };
  } else {
    const smsBody =
      `${orgLabel}: your paystub for ${weekLabel} is ready. ` +
      `Net ${netStr}. View: ${publicUrl}`;
    const r = await sendSms({ to: e164, body: smsBody });
    smsResult = r.ok
      ? { ok: true, sid: r.sid }
      : { ok: false, error: `${r.kind}: ${r.detail}` };
  }

  // (6) Record delivery state. sent_at is stamped on ANY successful
  //     channel — a driver got the message somehow. If both channels
  //     failed we still update the token + send_error so the UI can
  //     show why the click didn't land.
  const nowIso = new Date().toISOString();
  const anySuccess = smsResult.ok || pushResult.ok;
  const sentVia: string[] = [];
  if (smsResult.ok)  sentVia.push("sms");
  if (pushResult.ok) sentVia.push("push");
  const errorSummary = anySuccess
    ? null
    // Both failed → concatenate for the UI. Truncated so a long Twilio
    // error doesn't blow the varchar (the column is text so it's fine
    // schema-wise, but a 5-line toast is worse than a 1-line one).
    : [
        smsResult.ok  ? null : `sms: ${(smsResult as { error: string }).error}`,
        pushResult.ok ? null : `push: ${(pushResult as { error: string }).error}`,
      ].filter(Boolean).join(" · ").slice(0, 500);

  const updates: Record<string, unknown> = {
    view_token:      viewToken,
    sent_via:        sentVia,
    send_error:      errorSummary,
    sms_message_sid: smsResult.ok ? smsResult.sid : rec.sms_message_sid,
  };
  if (anySuccess) updates.sent_at = nowIso;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: upErr } = await (supabase as any)
    .from("payroll_records")
    .update(updates)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("superseded_at", null)  // race: don't stamp send state onto a row that just got superseded
    .select(REC_COLS)
    .maybeSingle();
  if (upErr) {
    console.error("[POST /v1/payroll/records/:id/send] update failed:", upErr);
    return c.json({ error: "update_failed", detail: upErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!updated) {
    // Rare: someone reopened the week between our fetch and our update.
    // The send already happened (SMS was already at Twilio), so we
    // don't retry — just tell the caller the record vanished.
    return c.json({
      error:  "record_superseded",
      detail: "The record was reopened while sending. The message may still have been delivered; re-finalize + resend to be sure.",
    } satisfies ApiErrorResponse, 409);
  }

  const res: SendPaystubResponse = {
    record:     rowToRec(updated as unknown as RecRow),
    smsResult,
    pushResult,
  };
  return c.json(res);
});

export default payroll;
