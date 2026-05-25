/**
 * /v1/maintenance-reports — ops surface for driver-submitted reports.
 * Clerk-auth (org-scoped). The matching driver-side surface lives in
 * routes/driver.ts under /v1/driver/maintenance-reports.
 */
import { Hono } from "hono";
import {
  type MaintenanceReport,
  type MaintenanceReportStatus,
  type MaintenanceReportPhoto,
  type MaintenanceActionItem,
  type ListMaintenanceReportsResponse,
  type GetMaintenanceReportResponse,
  type UpdateMaintenanceReportRequest,
  type UpdateMaintenanceReportResponse,
  type ConvertMaintenanceReportRequest,
  type ConvertMaintenanceReportResponse,
  type GetMaintenanceReportPhotoUrlResponse,
  type ApiErrorResponse,
  MAINTENANCE_REPORT_STATUSES,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

const maintenanceReports = new Hono<{ Variables: AuthVariables }>();

maintenanceReports.use("*", requireModule("maintenance"), requireCapability("maintenance.access"));

// ── Row types + converters ──────────────────────────────────────────────

export interface MaintenanceReportRow {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number | null;
  trailer_id:     number | null;
  description:    string;
  reported_at:    string;
  latitude:       number | null;
  longitude:      number | null;
  state:          string | null;
  status:         string;
  action_item_id: string | null;
  submitted_by:   string;
  created_at:     string;
}

export interface MaintenanceReportPhotoRow {
  id:          string;
  report_id:   string;
  org_id:      string;
  storage_path: string;
  file_name:   string;
  mime_type:   string | null;
  size_bytes:  number | null;
  uploaded_at: string;
}

export interface MaintenanceActionItemRow {
  id:             string;
  org_id:         string;
  asset_id:       number | null;
  trailer_id:     number | null;
  title:          string;
  description:    string | null;
  category:       string;
  priority:       string;
  status:         string;
  out_of_service: boolean;
  scheduled_date: string | null;
  due_date:       string | null;
  report_id:      string | null;
  completed_at:   string | null;
  completed_by:   string | null;
  vendor:         string | null;
  estimated_cost: number | null;
  actual_cost:    number | null;
  created_by:     string;
  created_at:     string;
  updated_at:     string;
}

export function rowToReport(r: MaintenanceReportRow, photos?: MaintenanceReportPhoto[]): MaintenanceReport {
  return {
    id:            r.id,
    orgId:         r.org_id,
    driverId:      r.driver_id,
    assetId:       r.asset_id   ?? undefined,
    trailerId:     r.trailer_id ?? undefined,
    description:   r.description,
    reportedAt:    r.reported_at,
    latitude:      r.latitude   ?? undefined,
    longitude:     r.longitude  ?? undefined,
    state:         r.state      ?? undefined,
    status:        r.status as MaintenanceReportStatus,
    actionItemId:  r.action_item_id ?? undefined,
    submittedBy:   r.submitted_by,
    createdAt:     r.created_at,
    photos:        photos,
  };
}

export function rowToPhoto(r: MaintenanceReportPhotoRow, signedUrl?: string): MaintenanceReportPhoto {
  return {
    id:         r.id,
    reportId:   r.report_id,
    fileName:   r.file_name,
    mimeType:   r.mime_type ?? undefined,
    sizeBytes:  r.size_bytes ?? undefined,
    uploadedAt: r.uploaded_at,
    signedUrl,
  };
}

export function rowToActionItem(r: MaintenanceActionItemRow): MaintenanceActionItem {
  return {
    id:            r.id,
    orgId:         r.org_id,
    assetId:       r.asset_id   ?? undefined,
    trailerId:     r.trailer_id ?? undefined,
    title:         r.title,
    description:   r.description ?? undefined,
    category:      r.category as MaintenanceActionItem["category"],
    priority:      r.priority as MaintenanceActionItem["priority"],
    status:        r.status   as MaintenanceActionItem["status"],
    outOfService:  r.out_of_service,
    scheduledDate: r.scheduled_date ?? undefined,
    dueDate:       r.due_date       ?? undefined,
    reportId:      r.report_id      ?? undefined,
    completedAt:   r.completed_at   ?? undefined,
    completedBy:   r.completed_by   ?? undefined,
    vendor:        r.vendor         ?? undefined,
    estimatedCost: r.estimated_cost != null ? Number(r.estimated_cost) : undefined,
    actualCost:    r.actual_cost    != null ? Number(r.actual_cost)    : undefined,
    createdBy:     r.created_by,
    createdAt:     r.created_at,
    updatedAt:     r.updated_at,
  };
}

export const REPORT_COLS =
  "id,org_id,driver_id,asset_id,trailer_id,description,reported_at," +
  "latitude,longitude,state,status,action_item_id,submitted_by,created_at";

export const ACTION_ITEM_COLS =
  "id,org_id,asset_id,trailer_id,title,description,category,priority,status," +
  "out_of_service,scheduled_date,due_date,report_id,completed_at,completed_by," +
  "vendor,estimated_cost,actual_cost,created_by,created_at,updated_at";

const PHOTO_COLS =
  "id,report_id,org_id,storage_path,file_name,mime_type,size_bytes,uploaded_at";

const PHOTO_BUCKET = "maintenance-photos";

// ── Helpers ─────────────────────────────────────────────────────────────

async function fetchPhotosForReports(reportIds: string[]): Promise<Map<string, MaintenanceReportPhoto[]>> {
  const out = new Map<string, MaintenanceReportPhoto[]>();
  if (reportIds.length === 0) return out;
  const { data, error } = await supabase
    .from("maintenance_report_photos")
    .select(PHOTO_COLS)
    .in("report_id", reportIds);
  if (error || !data) return out;

  // Mint 1-hour signed URLs in a single createSignedUrls call when
  // possible — cheaper than one round trip per photo.
  const rows = data as unknown as MaintenanceReportPhotoRow[];
  const paths = rows.map(r => r.storage_path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: signed } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  for (const r of rows) {
    const arr = out.get(r.report_id) ?? [];
    arr.push(rowToPhoto(r, urlByPath.get(r.storage_path)));
    out.set(r.report_id, arr);
  }
  return out;
}

function clampLimit(raw: string | undefined, fallback = 50): number {
  const n = Number(raw ?? String(fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

// ── GET /v1/maintenance-reports — list ──────────────────────────────────

maintenanceReports.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const status      = url.searchParams.get("status");
  const assetIdRaw  = url.searchParams.get("assetId");
  const trailerRaw  = url.searchParams.get("trailerId");
  const driverRaw   = url.searchParams.get("driverId");
  const from        = url.searchParams.get("from");
  const to          = url.searchParams.get("to");
  const limit  = clampLimit(url.searchParams.get("limit") ?? undefined);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  // Join drivers + assets + trailers so each row carries its own
  // labels. Same pattern as fuel-reports — eliminates the client-
  // side lookup that previously failed when the list/asset fetches
  // landed after the user opened the panel.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("maintenance_reports")
    .select(`${REPORT_COLS}, driver:drivers(name), asset:assets(name, unit), trailer:trailers(name, trailer_number)`, { count: "exact" })
    .eq("org_id", orgId)
    .order("reported_at", { ascending: false });

  if (status && (MAINTENANCE_REPORT_STATUSES as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }
  if (assetIdRaw) q = q.eq("asset_id",   Number(assetIdRaw));
  if (trailerRaw) q = q.eq("trailer_id", Number(trailerRaw));
  if (driverRaw)  q = q.eq("driver_id",  Number(driverRaw));
  if (from)       q = q.gte("reported_at", from);
  if (to)         q = q.lt("reported_at",  to);
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    console.error("[GET /v1/maintenance-reports] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  type JoinedRow = MaintenanceReportRow & {
    driver?:  { name: string | null } | { name: string | null }[] | null;
    asset?:   { name: string | null; unit: string | null } | Array<{ name: string | null; unit: string | null }> | null;
    trailer?: { name: string | null; trailer_number: string | null } | Array<{ name: string | null; trailer_number: string | null }> | null;
  };
  const rows = (data ?? []) as unknown as JoinedRow[];
  const photoMap = await fetchPhotosForReports(rows.map(r => r.id));
  const res: ListMaintenanceReportsResponse = {
    reports: rows.map(r => {
      const driver  = Array.isArray(r.driver)  ? r.driver[0]  ?? null : r.driver  ?? null;
      const asset   = Array.isArray(r.asset)   ? r.asset[0]   ?? null : r.asset   ?? null;
      const trailer = Array.isArray(r.trailer) ? r.trailer[0] ?? null : r.trailer ?? null;
      const rep = rowToReport(r as MaintenanceReportRow, photoMap.get(r.id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = rep as any;
      if (driver?.name) out.driverName = driver.name;
      if (asset)   out.assetName   = `${asset.name ?? ''}${asset.unit ? ` #${asset.unit}` : ''}`.trim();
      if (trailer) out.trailerName = trailer.trailer_number ? `#${trailer.trailer_number}` : (trailer.name ?? '');
      return out;
    }),
    total:   count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// ── GET /v1/maintenance-reports/:id ─────────────────────────────────────

maintenanceReports.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("maintenance_reports")
    .select(REPORT_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/maintenance-reports/:id] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const row = data as unknown as MaintenanceReportRow;
  const photoMap = await fetchPhotosForReports([row.id]);
  const res: GetMaintenanceReportResponse = { report: rowToReport(row, photoMap.get(row.id) ?? []) };
  return c.json(res);
});

// ── PATCH /v1/maintenance-reports/:id — status change ───────────────────

maintenanceReports.patch("/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  let body: UpdateMaintenanceReportRequest;
  try { body = await c.req.json<UpdateMaintenanceReportRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  // Only `status` is editable on a report — the description and
  // attachments are immutable input. If the user wants to change
  // anything else, they should reject + ask the driver to refile.
  const update: Record<string, unknown> = {};
  if (body.status) {
    if (!(MAINTENANCE_REPORT_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: "validation_failed", errors: ["status invalid"] } satisfies ApiErrorResponse, 400);
    }
    // Convert is its own endpoint — block direct transition here to
    // keep the action-item linkage atomic.
    if (body.status === 'converted') {
      return c.json({ error: "validation_failed", errors: ["use /convert to set status='converted'"] } satisfies ApiErrorResponse, 400);
    }
    update.status = body.status;
  }
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields to update"] } satisfies ApiErrorResponse, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_reports")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(REPORT_COLS)
    .maybeSingle();
  if (error) {
    console.error("[PATCH /v1/maintenance-reports/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateMaintenanceReportResponse = { report: rowToReport(data as unknown as MaintenanceReportRow) };
  return c.json(res);
});

// ── POST /v1/maintenance-reports/:id/convert ────────────────────────────

maintenanceReports.post("/:id/convert", requireCapability("maintenance.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");

  let body: ConvertMaintenanceReportRequest;
  try { body = await c.req.json<ConvertMaintenanceReportRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  // Fetch the report — we need asset/trailer/description to seed the
  // action item, and to verify it's still in a convertible state.
  const { data: reportRow, error: fetchErr } = await supabase
    .from("maintenance_reports")
    .select(REPORT_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr) {
    console.error("[convert] fetch failed:", fetchErr);
    return c.json({ error: "fetch_failed", detail: fetchErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!reportRow) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const report = reportRow as unknown as MaintenanceReportRow;

  if (report.status === 'converted' || report.action_item_id) {
    return c.json({ error: "already_converted", detail: "report already has an action item" } satisfies ApiErrorResponse, 409);
  }

  // Validate optional fields.
  const errors: string[] = [];
  if (body.category && !(MAINTENANCE_CATEGORIES as readonly string[]).includes(body.category)) {
    errors.push("category invalid");
  }
  if (body.priority && !(MAINTENANCE_PRIORITIES as readonly string[]).includes(body.priority)) {
    errors.push("priority invalid");
  }
  if (errors.length) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);

  // Build the action item insert. Title defaults to a server-derived
  // string when the operator didn't supply one — "{asset/trailer
  // label}: {first 40 chars of description}".
  const autoTitle = (() => {
    const head = report.description.replace(/\s+/g, " ").trim().slice(0, 60);
    return head || "Maintenance";
  })();

  const insertAi = {
    org_id:         orgId,
    asset_id:       report.asset_id,
    trailer_id:     report.trailer_id,
    title:          (body.title ?? "").trim() || autoTitle,
    description:    (body.description ?? "").trim() || report.description,
    category:       body.category ?? "repair",
    priority:       body.priority ?? "normal",
    status:         "open",
    out_of_service: !!body.outOfService,
    scheduled_date: body.scheduledDate ?? null,
    due_date:       body.dueDate       ?? null,
    report_id:      report.id,
    created_by:     userId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: aiData, error: aiErr } = await supabase
    .from("maintenance_action_items")
    .insert(insertAi as any)
    .select(ACTION_ITEM_COLS)
    .single();
  if (aiErr || !aiData) {
    console.error("[convert] action item insert failed:", aiErr);
    return c.json({ error: "insert_failed", detail: aiErr?.message } satisfies ApiErrorResponse, 500);
  }
  const actionItem = aiData as unknown as MaintenanceActionItemRow;

  // Flip the report to 'converted' and link it. If this fails we have
  // an orphaned action item — log + return the partial success since
  // the action item is the more important record; operators can
  // re-link manually if needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: reportUpd, error: updErr } = await supabase
    .from("maintenance_reports")
    .update({ status: "converted", action_item_id: actionItem.id } as any)
    .eq("id", report.id)
    .eq("org_id", orgId)
    .select(REPORT_COLS)
    .single();
  if (updErr || !reportUpd) {
    console.warn("[convert] report status flip failed (action item created):", updErr);
  }

  const res: ConvertMaintenanceReportResponse = {
    actionItem: rowToActionItem(actionItem),
    report:     rowToReport((reportUpd as unknown as MaintenanceReportRow) ?? {
      ...report,
      status: 'converted',
      action_item_id: actionItem.id,
    }),
  };
  return c.json(res);
});

// ── DELETE /v1/maintenance-reports/:id ──────────────────────────────────

maintenanceReports.delete("/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  // Photos cascade via ON DELETE CASCADE on the photo table FK.
  // Storage paths are NOT auto-deleted — fetch and remove explicitly.
  const { data: photos } = await supabase
    .from("maintenance_report_photos")
    .select("storage_path")
    .eq("report_id", id)
    .eq("org_id", orgId);
  const paths = ((photos ?? []) as Array<{ storage_path: string }>).map(p => p.storage_path);

  const { error } = await supabase
    .from("maintenance_reports")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/maintenance-reports/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  if (paths.length > 0) {
    void supabase.storage.from(PHOTO_BUCKET).remove(paths);
  }
  return c.json({ ok: true });
});

// ── GET /v1/maintenance-reports/photos/:id/url ──────────────────────────
//
// Mints a fresh 1-hour signed URL for a photo. List endpoints already
// embed signed URLs; this is for callers that need a fresh URL later
// (long-lived UI sessions where the original URL expired).

maintenanceReports.get("/photos/:id/url", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("maintenance_report_photos")
    .select("storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const path = (data as { storage_path: string }).storage_path;
  const { data: signed } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
  if (!signed) return c.json({ error: "sign_failed" } satisfies ApiErrorResponse, 500);
  const res: GetMaintenanceReportPhotoUrlResponse = { url: signed.signedUrl };
  return c.json(res);
});

export default maintenanceReports;
