/**
 * /v1/fuel-reports — dispatch + accounting surface for driver-submitted
 * fuel reports. Clerk-auth (org-scoped).
 *
 * The matching driver-side surface lives in routes/driver.ts under
 * /v1/driver/fuel-reports — both write into the same `fuel_reports`
 * table; only the auth model and the scope of GET differ.
 */

import { Hono } from "hono";
import {
  type FuelReport,
  type FuelReportMatchStatus,
  type CreateFuelReportRequest,
  type CreateFuelReportResponse,
  type ListFuelReportsResponse,
  type UpdateFuelReportRequest,
  type UpdateFuelReportResponse,
  type ApiErrorResponse,
  FUEL_REPORT_MATCH_STATUSES,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const fuelReports = new Hono<{ Variables: AuthVariables }>();

// ── Row converter ───────────────────────────────────────────────────────

interface FuelReportRow {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number;
  reported_at:    string;
  state:          string;
  latitude:       number | null;
  longitude:      number | null;
  diesel_gallons: number;
  def_gallons:    number | null;
  odometer:       number | null;
  transaction_id: string | null;
  match_status:   string;
  submitted_by:   string;
  notes:          string | null;
  created_at:     string;
}

function rowToFuelReport(r: FuelReportRow): FuelReport {
  return {
    id:            r.id,
    orgId:         r.org_id,
    driverId:      r.driver_id,
    assetId:       r.asset_id,
    reportedAt:    r.reported_at,
    state:         r.state,
    latitude:      r.latitude  ?? undefined,
    longitude:     r.longitude ?? undefined,
    dieselGallons: Number(r.diesel_gallons),
    defGallons:    r.def_gallons != null ? Number(r.def_gallons) : undefined,
    odometer:      r.odometer ?? undefined,
    transactionId: r.transaction_id ?? undefined,
    matchStatus:   r.match_status as FuelReportMatchStatus,
    submittedBy:   r.submitted_by,
    notes:         r.notes ?? undefined,
    createdAt:     r.created_at,
  };
}

const COLS =
  "id,org_id,driver_id,asset_id,reported_at,state,latitude,longitude," +
  "diesel_gallons,def_gallons,odometer,transaction_id,match_status," +
  "submitted_by,notes,created_at";

// ── Helpers ─────────────────────────────────────────────────────────────

function isUsState(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{2}$/.test(s.toUpperCase());
}

function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? "50");
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

// ── POST /v1/fuel-reports — submit ─────────────────────────────────────
//
// Dispatch / accounting may need to submit on a driver's behalf (e.g.
// the driver called in a fuel-up). The driver path lives under
// /v1/driver/fuel-reports and forces driver_id from the auth context.

fuelReports.post("/", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");

  let body: CreateFuelReportRequest;
  try { body = await c.req.json<CreateFuelReportRequest>(); }
  catch {
    return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400);
  }

  const errors: string[] = [];
  if (body.driverId == null || !Number.isFinite(body.driverId)) errors.push("driverId required");
  if (body.assetId  == null || !Number.isFinite(body.assetId))  errors.push("assetId required");
  if (!isUsState(body.state)) errors.push("state must be a 2-letter US abbreviation");
  if (body.dieselGallons == null || !Number.isFinite(body.dieselGallons) || body.dieselGallons <= 0) {
    errors.push("dieselGallons must be > 0");
  }
  if (body.defGallons != null && (!Number.isFinite(body.defGallons) || body.defGallons < 0)) {
    errors.push("defGallons must be >= 0");
  }
  if (body.odometer != null && (!Number.isInteger(body.odometer) || body.odometer < 0)) {
    errors.push("odometer must be a non-negative integer");
  }
  if (errors.length) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);

  const insertRow = {
    org_id:         orgId,
    driver_id:      body.driverId!,
    asset_id:       body.assetId,
    reported_at:    body.reportedAt ?? new Date().toISOString(),
    state:          body.state.toUpperCase(),
    latitude:       body.latitude  ?? null,
    longitude:      body.longitude ?? null,
    diesel_gallons: body.dieselGallons,
    def_gallons:    body.defGallons ?? null,
    odometer:       body.odometer ?? null,
    notes:          body.notes ?? null,
    submitted_by:   userId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_reports")
    .insert(insertRow as any)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/fuel-reports] insert failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }

  const res: CreateFuelReportResponse = { fuelReport: rowToFuelReport(data as unknown as FuelReportRow) };
  return c.json(res);
});

// ── GET /v1/fuel-reports — list ─────────────────────────────────────────

fuelReports.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from        = url.searchParams.get("from");
  const to          = url.searchParams.get("to");
  const driverIdRaw = url.searchParams.get("driverId");
  const assetIdRaw  = url.searchParams.get("assetId");
  const matchStatus = url.searchParams.get("matchStatus");
  const limit       = clampLimit(url.searchParams.get("limit") ?? undefined);
  const offset      = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("fuel_reports")
    .select(COLS, { count: "exact" })
    .eq("org_id", orgId)
    .order("reported_at", { ascending: false });

  if (driverIdRaw)  q = q.eq("driver_id", Number(driverIdRaw));
  if (assetIdRaw)   q = q.eq("asset_id",  Number(assetIdRaw));
  if (matchStatus && (FUEL_REPORT_MATCH_STATUSES as readonly string[]).includes(matchStatus)) {
    q = q.eq("match_status", matchStatus);
  }
  if (from) q = q.gte("reported_at", from);
  if (to)   q = q.lt("reported_at",  to);

  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    console.error("[GET /v1/fuel-reports] list failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = (data ?? []) as FuelReportRow[];
  const res: ListFuelReportsResponse = {
    fuelReports: rows.map(rowToFuelReport),
    total:       count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// ── PATCH /v1/fuel-reports/:id — edit ───────────────────────────────────

fuelReports.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  let body: UpdateFuelReportRequest;
  try { body = await c.req.json<UpdateFuelReportRequest>(); }
  catch {
    return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400);
  }

  const update: Record<string, unknown> = {};
  if ("assetId"       in body) update.asset_id       = body.assetId;
  if ("dieselGallons" in body) update.diesel_gallons = body.dieselGallons;
  if ("defGallons"    in body) update.def_gallons    = body.defGallons ?? null;
  if ("odometer"      in body) update.odometer       = body.odometer ?? null;
  if ("reportedAt"    in body) update.reported_at    = body.reportedAt;
  if ("notes"         in body) update.notes          = body.notes ?? null;
  if ("state" in body && body.state) {
    if (!isUsState(body.state)) {
      return c.json({ error: "validation_failed", errors: ["state must be 2-letter US abbreviation"] } satisfies ApiErrorResponse, 400);
    }
    update.state = body.state.toUpperCase();
  }
  if ("matchStatus" in body && body.matchStatus) {
    if (!(FUEL_REPORT_MATCH_STATUSES as readonly string[]).includes(body.matchStatus)) {
      return c.json({ error: "validation_failed", errors: ["matchStatus invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.match_status = body.matchStatus;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields to update"] } satisfies ApiErrorResponse, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_reports")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(COLS)
    .maybeSingle();
  if (error) {
    console.error("[PATCH /v1/fuel-reports/:id] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const res: UpdateFuelReportResponse = { fuelReport: rowToFuelReport(data as unknown as FuelReportRow) };
  return c.json(res);
});

// ── DELETE /v1/fuel-reports/:id — remove ────────────────────────────────

fuelReports.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { error } = await supabase
    .from("fuel_reports")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/fuel-reports/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default fuelReports;
