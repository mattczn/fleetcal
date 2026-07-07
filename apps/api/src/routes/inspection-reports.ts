/**
 * /v1/inspection-reports — dispatcher-facing surface for driver-submitted
 * DVIRs (Daily Vehicle Inspection Reports). Clerk-auth, org-scoped.
 * The driver-side counterpart lives in routes/driver.ts under
 * /v1/driver/inspections (submit + my history).
 *
 * Gated on the maintenance module + capability — fleet ops staff who
 * see maintenance reports also see inspections. We don't have a
 * separate "inspections" module flag since these workflows always
 * ship together for a trucking customer.
 */
import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";

const inspectionReports = new Hono<{ Variables: AuthVariables }>();

inspectionReports.use("*", requireModule("maintenance"), requireCapability("inspections.access"));

// ── Row + response shapes ──────────────────────────────────────────────

interface InspectionItem {
  id:      string;
  section: string;
  label:   string;
  status:  "pass" | "fail" | "na";
  notes?:  string;
}

interface DbInspectionRow {
  id:                string;
  org_id:            string;
  driver_id:         number;
  asset_id:          number | null;
  trailer_id:        number | null;
  inspection_date:   string;
  kind:              "pre_trip" | "post_trip";
  cleanliness_flagged: boolean;
  items:             InspectionItem[];
  trailer_items:     InspectionItem[] | null;
  notes:             string | null;
  has_defects:       boolean;
  signed_by:         string;
  submitted_at:      string;
  duration_seconds:  number | null;
  location_lat:      number | null;
  location_lon:      number | null;
}

interface InspectionPhotoRow {
  id:           string;
  report_id:    string;
  item_id:      string | null;
  target:       "truck" | "trailer" | null;
  storage_path: string;
  caption:      string | null;
  uploaded_at:  string;
}

interface InspectionPhoto {
  id:        string;
  itemId:    string | null;
  target:    "truck" | "trailer" | null;
  caption:   string | null;
  signedUrl: string | null;  // 1-hour TTL, minted by /:id
  uploadedAt: string;
}

interface ListInspectionRow {
  id:               string;
  driverId:         number;
  driverName:       string;
  assetId:          number | null;
  assetName:        string | null;
  trailerId:        number | null;
  trailerName:      string | null;
  inspectionDate:   string;
  kind:             "pre_trip" | "post_trip";
  cleanlinessFlagged: boolean;
  hasDefects:       boolean;
  defectCount:      number;
  itemCount:        number;
  photoCount:       number;
  durationSeconds:  number | null;
  submittedAt:      string;
  signedBy:         string;
}

const INSPECTION_PHOTO_BUCKET = "inspection-photos";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;
function clampLimit(raw: string | undefined): number {
  const n = Number(raw ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

// ── GET /v1/inspection-reports ─────────────────────────────────────────
//
// Flat list, newest-first. Filters:
//   assetId    — only inspections covering this truck
//   trailerId  — only inspections covering this trailer
//   driverId   — only inspections filed by this driver
//   from / to  — submitted_at range
//
// Each row carries lightweight summary fields (defect count, photo
// count) so the dispatcher table can show badges without N+1 fetches.
// The full per-item checklist + signed photo URLs come from /:id.
inspectionReports.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const assetIdRaw  = url.searchParams.get("assetId");
  const trailerRaw  = url.searchParams.get("trailerId");
  const driverRaw   = url.searchParams.get("driverId");
  const from        = url.searchParams.get("from");
  const to          = url.searchParams.get("to");
  const defectsOnly = url.searchParams.get("defectsOnly") === "true";
  const limit  = clampLimit(url.searchParams.get("limit") ?? undefined);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  // inspection_reports isn't in the generated Database types yet
  // (regenerate after applying 20260523_inspection_reports.sql); cast
  // around it. Driver-side endpoint does the same.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (supabase as any)
    .from("inspection_reports")
    .select(`
      id, driver_id, asset_id, trailer_id, inspection_date, kind, cleanliness_flagged,
      items, trailer_items,
      has_defects, signed_by, submitted_at, duration_seconds,
      driver:drivers(name),
      asset:assets(name, unit),
      trailer:trailers(name, trailer_number)
    `, { count: "exact" })
    .eq("org_id", orgId)
    .order("submitted_at", { ascending: false });

  if (assetIdRaw)  q = q.eq("asset_id",   Number(assetIdRaw));
  if (trailerRaw)  q = q.eq("trailer_id", Number(trailerRaw));
  if (driverRaw)   q = q.eq("driver_id",  Number(driverRaw));
  if (from)        q = q.gte("submitted_at", from);
  if (to)          q = q.lt("submitted_at",  to);
  if (defectsOnly) q = q.eq("has_defects", true);
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    console.error("[GET /v1/inspection-reports] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  // Photo counts in a single batched query so the table can show
  // "📷 3" badges without one fetch per row.
  type RawRow = DbInspectionRow & {
    driver?:  { name: string | null } | { name: string | null }[] | null;
    asset?:   { name: string | null; unit: string | null } | Array<{ name: string | null; unit: string | null }> | null;
    trailer?: { name: string | null; trailer_number: string | null } | Array<{ name: string | null; trailer_number: string | null }> | null;
  };
  const rows = (data ?? []) as RawRow[];
  const reportIds = rows.map(r => r.id);
  const photoCountByReport = new Map<string, number>();
  if (reportIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: photos } = await (supabase as any)
      .from("inspection_photos")
      .select("report_id")
      .in("report_id", reportIds);
    for (const p of ((photos ?? []) as Array<{ report_id: string }>)) {
      photoCountByReport.set(p.report_id, (photoCountByReport.get(p.report_id) ?? 0) + 1);
    }
  }

  const result: ListInspectionRow[] = rows.map(r => {
    const truck   = Array.isArray(r.asset)   ? r.asset[0]   ?? null : r.asset   ?? null;
    const trailer = Array.isArray(r.trailer) ? r.trailer[0] ?? null : r.trailer ?? null;
    const driver  = Array.isArray(r.driver)  ? r.driver[0]  ?? null : r.driver  ?? null;
    const items   = [...(r.items ?? []), ...(r.trailer_items ?? [])];
    const defects = items.filter(i => i.status === "fail").length;
    return {
      id:              r.id,
      driverId:        r.driver_id,
      driverName:      driver?.name ?? "Driver",
      assetId:         r.asset_id,
      assetName:       truck ? `${truck.name ?? ""}${truck.unit ? ` #${truck.unit}` : ""}`.trim() : null,
      trailerId:       r.trailer_id,
      trailerName:     trailer ? `${trailer.name ?? ""}${trailer.trailer_number ? ` #${trailer.trailer_number}` : ""}`.trim() : null,
      inspectionDate:  r.inspection_date,
      kind:            r.kind ?? "pre_trip",
      cleanlinessFlagged: r.cleanliness_flagged ?? false,
      hasDefects:      r.has_defects,
      defectCount:     defects,
      itemCount:       items.length,
      photoCount:      photoCountByReport.get(r.id) ?? 0,
      durationSeconds: r.duration_seconds,
      submittedAt:     r.submitted_at,
      signedBy:        r.signed_by,
    };
  });

  return c.json({ inspections: result, total: count ?? rows.length, limit, offset });
});

// ── GET /v1/inspection-reports/:id ─────────────────────────────────────
//
// Full detail — every checklist item with pass/fail/n/a + notes, plus
// signed photo URLs for every attached image (1-hour TTL minted in a
// single batched call). The dispatcher detail panel renders straight
// from this response.
inspectionReports.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("inspection_reports")
    .select(`
      id, driver_id, asset_id, trailer_id, inspection_date, kind, cleanliness_flagged,
      items, trailer_items,
      notes, has_defects, signed_by, submitted_at,
      duration_seconds, location_lat, location_lon,
      driver:drivers(name, phone),
      asset:assets(name, unit, type),
      trailer:trailers(name, trailer_number)
    `)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/inspection-reports/:id] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);

  // Photos + signed URLs in a single batched mint.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: photoRows } = await (supabase as any)
    .from("inspection_photos")
    .select("id, report_id, item_id, target, storage_path, caption, uploaded_at")
    .eq("report_id", id)
    .order("uploaded_at", { ascending: true });
  const rawPhotos = (photoRows ?? []) as InspectionPhotoRow[];
  let urlByPath = new Map<string, string>();
  if (rawPhotos.length > 0) {
    const { data: signed } = await supabase.storage
      .from(INSPECTION_PHOTO_BUCKET)
      .createSignedUrls(rawPhotos.map(p => p.storage_path), 3600);
    if (signed) {
      // createSignedUrls types signedUrl as nullable, but a successful
      // mint always returns a string; coerce to "" so callers see
      // null on actual failure (we mark photos signedUrl null below).
      urlByPath = new Map(signed.map(s => [s.path ?? "", s.signedUrl ?? ""]));
    }
  }
  const photos: InspectionPhoto[] = rawPhotos.map(p => ({
    id:         p.id,
    itemId:     p.item_id,
    target:     p.target,
    caption:    p.caption,
    signedUrl:  urlByPath.get(p.storage_path) ?? null,
    uploadedAt: p.uploaded_at,
  }));

  return c.json({
    inspection: {
      id:              data.id,
      driverId:        data.driver_id,
      driver:          data.driver,
      assetId:         data.asset_id,
      asset:           data.asset,
      trailerId:       data.trailer_id,
      trailer:         data.trailer,
      inspectionDate:  data.inspection_date,
      kind:            data.kind ?? "pre_trip",
      cleanlinessFlagged: data.cleanliness_flagged ?? false,
      items:           data.items ?? [],
      trailerItems:    data.trailer_items ?? [],
      notes:           data.notes,
      hasDefects:      data.has_defects,
      signedBy:        data.signed_by,
      submittedAt:     data.submitted_at,
      durationSeconds: data.duration_seconds,
      locationLat:     data.location_lat,
      locationLon:     data.location_lon,
      photos,
    },
  });
});

// ── DELETE /v1/inspection-reports/:id — remove an inspection + its photos ──
// The inspection_photos rows cascade on report delete (ON DELETE CASCADE), but
// the Supabase Storage objects are separate and won't — so remove those first.
inspectionReports.delete("/:id", requireCapability("maintenance.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  // Confirm it's this org's report before touching anything.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (supabase as any)
    .from("inspection_reports")
    .select("id")
    .eq("id", id).eq("org_id", orgId)
    .maybeSingle();
  if (!row) return c.json({ error: "not_found" }, 404);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: photoRows } = await (supabase as any)
    .from("inspection_photos")
    .select("storage_path")
    .eq("report_id", id);
  const paths = ((photoRows ?? []) as Array<{ storage_path: string }>).map(p => p.storage_path);
  if (paths.length > 0) {
    const { error: rmErr } = await supabase.storage.from(INSPECTION_PHOTO_BUCKET).remove(paths);
    // Non-fatal: a lingering blob is better than blocking the delete.
    if (rmErr) console.error("[DELETE inspection] storage remove failed:", rmErr.message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: delErr } = await (supabase as any)
    .from("inspection_reports")
    .delete()
    .eq("id", id).eq("org_id", orgId);
  if (delErr) {
    console.error("[DELETE /v1/inspection-reports/:id] failed:", delErr);
    return c.json({ error: "delete_failed", detail: delErr.message }, 500);
  }
  return c.json({ ok: true });
});

export default inspectionReports;
