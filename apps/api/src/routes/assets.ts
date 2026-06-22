/**
 * /v1/assets — fleet assets (trucks/trailers) CRUD.
 *
 * Endpoints:
 *   GET    /v1/assets             — list (sort_order asc)
 *   POST   /v1/assets             — create (server appends to end if no sortOrder)
 *   PATCH  /v1/assets/:id         — update fields
 *   DELETE /v1/assets/:id         — hard delete (cascades events)
 *   POST   /v1/assets/reorder     — bulk sort_order rewrite
 */

import { Hono } from "hono";
import {
  type Asset,
  type ListAssetsResponse,
  type CreateAssetRequest,
  type CreateAssetResponse,
  type UpdateAssetRequest,
  type UpdateAssetResponse,
  type ReorderAssetsRequest,
  type ApiErrorResponse,
  ASSET_DOCUMENT_KINDS,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { getOrgTier, applyActiveCapFilter } from "../lib/orgTier.js";
import { loadExcludedDrivers } from "../lib/reportExclusions.js";
import { convertIfHeicAtUpload, HEIC_DECODE_FAILED } from "../lib/heicToJpeg.js";

const assets = new Hono<{ Variables: AuthVariables }>();

interface DbAssetRow {
  id: number;
  name: string;
  color: string;
  type: string;
  unit: string | null;
  truck: string | null;
  make: string | null;
  model: string | null;
  vin: string | null;
  license_plate: string | null;
  license_state: string | null;
  license_expiration: string | null;
  notes: string | null;
  hidden: boolean;
  motive_vehicle_id: string | null;
  mudflap_card_last4: string | null;
  sort_order: number;
  active_from: string;
  active_to: string | null;
}

// Columns shared across all endpoints — single source of truth so we
// can't forget to add a new column to one of the SELECTs.
const ASSET_COLS = "id,name,color,type,unit,truck,make,model,vin,license_plate,license_state,license_expiration,notes,hidden,motive_vehicle_id,mudflap_card_last4,sort_order,active_from,active_to";

function rowToAsset(r: DbAssetRow): Asset {
  return {
    id:                r.id,
    name:              r.name,
    color:             r.color,
    type:              r.type,
    unit:              r.unit               ?? undefined,
    truck:             r.truck              ?? undefined,
    make:              r.make               ?? undefined,
    model:             r.model              ?? undefined,
    vin:               r.vin                ?? undefined,
    licensePlate:      r.license_plate      ?? undefined,
    licenseState:      r.license_state      ?? undefined,
    licenseExpiration: r.license_expiration ?? null,
    hidden:            r.hidden,
    notes:             r.notes              ?? undefined,
    motiveVehicleId:   r.motive_vehicle_id  ?? undefined,
    mudflapCardLast4:  r.mudflap_card_last4 ?? undefined,
    sortOrder:         r.sort_order,
    activeFrom:        r.active_from,
    activeTo:          r.active_to,
  };
}

/** YYYY-MM-DD for today in UTC. Good enough for retire-stamping —
 *  the boundary is a day not a moment. */
function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

assets.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("assets")
    .select(ASSET_COLS)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/assets] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const assetsList = ((data ?? []) as unknown as DbAssetRow[]).map(rowToAsset);

  // Derive the owner-op flag per asset. An asset is excluded when its
  // default driver (per driver_asset_prefs) is flagged
  // exclude_from_reports. Computed here once so every client
  // (dashboard, performance, timeline) gets the same answer instead of
  // re-deriving from a separate fetch. Two queries instead of a join
  // because driver_asset_prefs.driver_id has no PostgREST FK alias
  // tying it to drivers.id in the current schema dump.
  const excluded = await loadExcludedDrivers(orgId);
  if (excluded.ids.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prefRows, error: prefErr } = await (supabase as any)
      .from("driver_asset_prefs")
      .select("asset_id, driver_id")
      .eq("org_id", orgId)
      .in("driver_id", excluded.ids);
    if (prefErr) {
      console.error("[GET /v1/assets] driver_asset_prefs fetch (non-fatal):", prefErr);
    } else {
      const excludedAssetIds = new Set<number>(
        ((prefRows ?? []) as Array<{ asset_id: number | null }>)
          .map(r => r.asset_id)
          .filter((v): v is number => v != null),
      );
      for (const a of assetsList) {
        if (excludedAssetIds.has(a.id)) a.excludeFromReports = true;
      }
    }
  }

  const res: ListAssetsResponse = { assets: assetsList };
  return c.json(res);
});

assets.post("/", requireCapability("assets.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateAssetRequest>();
  if (!body.name || !body.color || !body.type) {
    return c.json({ error: "validation_failed", errors: ["name, color, type required"] } satisfies ApiErrorResponse, 400);
  }

  // ── Subscription cap (PR: server-side tier enforcement) ──────
  // The client-side useOrgTier hook nags the user with an upgrade
  // banner, but it's not a security gate — a motivated user could
  // open DevTools and curl past it. This block is the actual gate.
  //
  // Count non-retired trucks (active_to IS NULL). Compare to the
  // org's tier cap, return 402 if they'd exceed it.
  //
  // Why active_to IS NULL and NOT "active today" — see the long
  // explainer in orgTier.ts/applyActiveCapFilter. tl;dr: removing
  // the date from the predicate kills the server-UTC / client-
  // local race condition that was causing "client shows 8/9 but
  // server rejects" mismatches every evening.
  //
  // Unrestricted tier (Curzon + internal orgs) short-circuits the
  // count entirely so we don't add latency to dogfooding flows.
  const tier = await getOrgTier(orgId);
  if (Number.isFinite(tier.maxTrucks)) {
    // Exclude the calendar's virtual Unassigned column — it's a
    // UI surface for unrouted events, not a real truck, and
    // shouldn't burn a paid seat. We have to check BOTH `type`
    // AND `name` because the seed isn't consistent across code
    // paths: the production seed in useCalendarStore.ts line ~553
    // creates it with type='Unassigned', but the demo-reset seed
    // at line ~725 creates it with type='OTR', name='Unassigned'.
    // The client filter checks both; the server used to check
    // only type, so on demo-seeded orgs the server overcounted
    // by 1 and returned 402 even when the dispatcher was 1 under
    // the cap. Mirror the client's check exactly.
    const baseQ = supabase
      .from("assets")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .neq("type", "Unassigned")
      .neq("name", "Unassigned");
    const { count: activeCount, error: countErr } = await applyActiveCapFilter(baseQ);
    if (countErr) {
      console.error("[POST /v1/assets] tier cap count failed:", countErr);
      // Fail closed — if we can't count, we can't safely allow.
      return c.json({ error: "tier_check_failed", detail: countErr.message } satisfies ApiErrorResponse, 500);
    }
    const current = activeCount ?? 0;
    if (current >= tier.maxTrucks) {
      // Two phrasings: one for orgs on a real tier, one for orgs
      // with no resolvable plan (Clerk billing feature didn't
      // propagate or slug mismatch). Both call out the THREE ways
      // to make room: upgrade, contact sales, or retire/delete an
      // existing truck — the third one is the cheapest path for a
      // customer who's just rotating equipment, so we surface it
      // first in the "real tier" message.
      const detail = tier.tier === "none"
        ? `You've hit your truck limit. Retire or delete an existing truck to free a slot, or contact support to increase capacity.`
        : `You've hit the truck limit for your plan (${current} of ${tier.maxTrucks}). Retire or delete an existing truck to free a slot, or upgrade your plan / contact sales to raise the cap.`;
      return c.json({
        error:  "tier_cap_exceeded",
        detail,
        errors: [`tier=${tier.tier}`, `current=${current}`, `max=${tier.maxTrucks}`],
      } satisfies ApiErrorResponse, 402);
    }
  }

  let sortOrder = body.sortOrder;
  if (sortOrder === undefined) {
    const { count } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId);
    sortOrder = count ?? 0;
  }

  const insert = {
    org_id:             orgId,
    name:               body.name,
    color:              body.color,
    type:               body.type,
    unit:               body.unit              ?? null,
    truck:              body.truck             ?? null,
    make:               body.make              ?? null,
    model:              body.model             ?? null,
    vin:                body.vin               ?? null,
    license_plate:      body.licensePlate      ?? null,
    license_state:      body.licenseState      ?? null,
    license_expiration: body.licenseExpiration ?? null,
    notes:              body.notes             ?? null,
    hidden:             body.hidden            ?? false,
    motive_vehicle_id:  body.motiveVehicleId   ?? null,
    mudflap_card_last4: body.mudflapCardLast4  ?? null,
    sort_order:         sortOrder,
    // active_from defaults to CURRENT_DATE in the DB if omitted;
    // active_to defaults to NULL (currently active).
    active_from:        body.activeFrom        ?? todayUtcDateKey(),
    active_to:          body.activeTo          ?? null,
  };
  const { data, error } = await supabase
    .from("assets")
    .insert(insert as never)
    .select(ASSET_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/assets] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateAssetResponse = { asset: rowToAsset(data as unknown as DbAssetRow) };
  return c.json(res, 201);
});

assets.patch("/:id", requireCapability("assets.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<UpdateAssetRequest>();

  const update: Record<string, unknown> = {};
  if ("name"            in body) update.name              = body.name;
  if ("color"           in body) update.color             = body.color;
  if ("type"            in body) update.type              = body.type;
  if ("unit"            in body) update.unit              = body.unit             ?? null;
  if ("truck"           in body) update.truck             = body.truck            ?? null;
  if ("make"            in body) update.make              = body.make             ?? null;
  if ("model"           in body) update.model             = body.model            ?? null;
  if ("vin"               in body) update.vin                = body.vin               ?? null;
  if ("licensePlate"      in body) update.license_plate      = body.licensePlate      ?? null;
  if ("licenseState"      in body) update.license_state      = body.licenseState      ?? null;
  if ("licenseExpiration" in body) update.license_expiration = body.licenseExpiration ?? null;
  if ("notes"             in body) update.notes              = body.notes             ?? null;
  if ("hidden"          in body) update.hidden            = body.hidden           ?? false;
  if ("motiveVehicleId" in body) update.motive_vehicle_id = body.motiveVehicleId  ?? null;
  if ("mudflapCardLast4" in body) update.mudflap_card_last4 = body.mudflapCardLast4 ?? null;
  if ("sortOrder"       in body) update.sort_order        = body.sortOrder;
  if ("activeFrom"      in body) update.active_from       = body.activeFrom;
  if ("activeTo"        in body) update.active_to         = body.activeTo         ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("assets")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(ASSET_COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/assets/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateAssetResponse = { asset: rowToAsset(data as unknown as DbAssetRow) };
  return c.json(res);
});

// DELETE semantics changed: this no longer hard-deletes the row
// (that would be blocked by the events.asset_id FK anyway, now that
// it's ON DELETE RESTRICT). Instead it RETIRES the asset by stamping
// active_to = today. All historical events keep their reference; the
// asset just stops appearing in the calendar grid + new-load pickers
// for dates after today.
//
// Idempotent: if active_to is already set, leave it alone — that
// way an accidental double-tap on Retire doesn't push the date back.
assets.delete("/:id", requireCapability("assets.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  // Hard delete branch — actually remove the row. Used for "created
  // by accident" cleanup where the entity is fully orphaned.
  //
  // Strict pre-flight: count rows in every related table. If anything
  // references this asset (loads, fuel reports, maintenance reports),
  // we refuse the delete with a per-table breakdown. This makes
  // cascade impossible — by the time the DELETE fires, there is
  // nothing to cascade.
  const hard = c.req.query("hard") === "true";
  if (hard) {
    const blockers = await countAssetBlockers(orgId, id);
    const total = Object.values(blockers).reduce((s, n) => s + n, 0);
    if (total > 0) {
      return c.json(
        {
          error: "has_references",
          detail: "This asset can't be permanently deleted because other records still reference it.",
          blockers,
        },
        409,
      );
    }
    const { error: delErr } = await supabase
      .from("assets")
      .delete()
      .eq("id", id)
      .eq("org_id", orgId);
    if (delErr) {
      console.error("[DELETE /v1/assets/:id?hard=true] failed:", delErr);
      return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ deleted: true, id });
  }

  const today = todayUtcDateKey();
  const { data, error } = await supabase
    .from("assets")
    .update({ active_to: today } as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("active_to", null)              // only stamp when not already retired
    .select(ASSET_COLS)
    .maybeSingle();
  if (error) {
    console.error("[DELETE /v1/assets/:id] retire failed:", error);
    return c.json({ error: "retire_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  // data is null when the row was already retired — fetch + return so
  // the client gets the current state either way.
  if (!data) {
    const { data: existing } = await supabase
      .from("assets")
      .select(ASSET_COLS)
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
    return c.json({ asset: rowToAsset(existing as unknown as DbAssetRow) });
  }
  return c.json({ asset: rowToAsset(data as unknown as DbAssetRow) });
});

assets.post("/reorder", requireCapability("assets.edit"), async (c) => {
  const orgId = c.get("orgId");
  const { ids } = await c.req.json<ReorderAssetsRequest>();
  if (!Array.isArray(ids) || ids.some((n) => !Number.isFinite(n))) {
    return c.json({ error: "validation_failed", errors: ["ids must be number[]"] } satisfies ApiErrorResponse, 400);
  }

  // Sequential per-row update (PostgREST has no batch update by id list).
  // Small N (≤100 trucks) so latency is fine.
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase
      .from("assets")
      .update({ sort_order: i } as never)
      .eq("id", ids[i])
      .eq("org_id", orgId);
    if (error) {
      console.error("[POST /v1/assets/reorder] failed at index", i, error);
      return c.json({ error: "reorder_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
  }
  return c.body(null, 204);
});

/**
 * Count every table that references an asset. Returns { table → count }
 * with only non-zero entries. Used as a pre-flight before hard delete
 * so we never trigger a cascade — if anything points at this asset,
 * the delete is refused with a breakdown.
 */
async function countAssetBlockers(orgId: string, assetId: number): Promise<Record<string, number>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const count = async (table: string, col: string) => {
    const { count: n, error } = await sb
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq(col, assetId);
    if (error) {
      console.error(`[countAssetBlockers] ${table}.${col}:`, error);
      return 0;
    }
    return n ?? 0;
  };
  // Run in parallel — each is a HEAD count, cheap.
  const [events, fuel, maintenance] = await Promise.all([
    count("events",              "asset_id"),
    count("fuel_reports",        "asset_id"),
    count("maintenance_reports", "asset_id"),
  ]);
  const out: Record<string, number> = {};
  if (events      > 0) out.loads               = events;       // friendlier label
  if (fuel        > 0) out.fuel_reports        = fuel;
  if (maintenance > 0) out.maintenance_reports = maintenance;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Asset documents — ops surface.
//   GET    /v1/assets/:id/documents          — list
//   POST   /v1/assets/:id/documents          — upload (multipart)
//   GET    /v1/asset-documents/:docId/url    — fresh signed URL
//   DELETE /v1/asset-documents/:docId        — remove (cascades storage)
// ─────────────────────────────────────────────────────────────────────────

export const ASSET_DOC_BUCKET = "asset-documents";
type AssetDocKind = typeof ASSET_DOCUMENT_KINDS[number];

interface AssetDocRow {
  id:           string;
  org_id:       string;
  asset_id:     number;
  kind:         string;
  storage_path: string;
  file_name:    string;
  mime_type:    string | null;
  size_bytes:   number | null;
  expires_on:   string | null;
  notes:        string | null;
  uploaded_at:  string;
  uploaded_by:  string;
}

export const ASSET_DOC_COLS =
  "id,org_id,asset_id,kind,storage_path,file_name,mime_type,size_bytes," +
  "expires_on,notes,uploaded_at,uploaded_by";

export function rowToAssetDoc(r: AssetDocRow, signedUrl?: string) {
  return {
    id:         r.id,
    orgId:      r.org_id,
    assetId:    r.asset_id,
    kind:       r.kind as AssetDocKind,
    fileName:   r.file_name,
    mimeType:   r.mime_type ?? undefined,
    sizeBytes:  r.size_bytes ?? undefined,
    expiresOn:  r.expires_on ?? undefined,
    notes:      r.notes ?? undefined,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    signedUrl,
  };
}

export async function listDocsForAsset(orgId: string, assetId: number) {
  const { data, error } = await supabase
    .from("asset_documents")
    .select(ASSET_DOC_COLS)
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .order("uploaded_at", { ascending: false });
  if (error) return { error, docs: [] as ReturnType<typeof rowToAssetDoc>[] };

  const rows = (data ?? []) as unknown as AssetDocRow[];
  if (rows.length === 0) return { error: null, docs: [] };

  const paths = rows.map(r => r.storage_path);
  const { data: signed } = await supabase.storage.from(ASSET_DOC_BUCKET).createSignedUrls(paths, 3600);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  return { error: null, docs: rows.map(r => rowToAssetDoc(r, urlByPath.get(r.storage_path))) };
}

assets.get("/:id/documents", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error, docs } = await listDocsForAsset(orgId, id);
  if (error) {
    console.error("[GET /v1/assets/:id/documents] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ documents: docs });
});

assets.post("/:id/documents", requireCapability("assets.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }

  let body: { file?: File; kind?: string; expiresOn?: string; notes?: string };
  try { body = await c.req.parseBody() as typeof body; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400); }

  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] } satisfies ApiErrorResponse, 400);
  }
  const kind = (body.kind ?? "other").toString() as AssetDocKind;
  if (!(ASSET_DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${ASSET_DOCUMENT_KINDS.join("|")}`] } satisfies ApiErrorResponse, 400);
  }

  // Confirm the asset belongs to this org.
  const { data: assetRow } = await supabase
    .from("assets").select("id").eq("id", id).eq("org_id", orgId).maybeSingle();
  if (!assetRow) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  // Convert HEIC → JPEG at the boundary (truck title, registration,
  // license photos from iPhone). Same playbook as trailers + drivers
  // doc-upload: raw HEIC breaks the document preview + invoice-packet
  // embedder downstream.
  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadMime = file.type || "application/octet-stream";
  let uploadName = file.name;
  const conv = await convertIfHeicAtUpload(file, bytes, "[POST /v1/assets/:id/documents]");
  if ('failed' in conv) return c.json(HEIC_DECODE_FAILED, 415);
  bytes      = conv.bytes;
  uploadMime = conv.mime || uploadMime;
  uploadName = conv.name;

  const ext  = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${kind}_${Date.now()}_${rand}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(ASSET_DOC_BUCKET)
    .upload(storagePath, bytes, {
      contentType: uploadMime,
      upsert: false,
    });
  if (upErr) {
    console.error("[POST assets/:id/documents] storage:", upErr);
    return c.json({ error: "upload_failed", detail: upErr.message } satisfies ApiErrorResponse, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("asset_documents")
    .insert({
      org_id:       orgId,
      asset_id:     id,
      kind,
      storage_path: storagePath,
      file_name:    uploadName,
      mime_type:    uploadMime || null,
      size_bytes:   bytes.length,
      expires_on:   body.expiresOn?.trim() || null,
      notes:        body.notes?.trim() || null,
      uploaded_by:  userId,
    } as any)
    .select(ASSET_DOC_COLS)
    .single();
  if (error || !data) {
    void supabase.storage.from(ASSET_DOC_BUCKET).remove([storagePath]);
    console.error("[POST assets/:id/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const { data: signed } = await supabase.storage.from(ASSET_DOC_BUCKET).createSignedUrl(storagePath, 3600);
  const doc = rowToAssetDoc(data as unknown as AssetDocRow, signed?.signedUrl);
  return c.json({ document: doc });
});

// ── Asset activity periods ───────────────────────────────────────────────
//
// Each asset has 1+ activity periods (start_date → end_date, end_date NULL
// = currently open). The 20260616 migration created the table, backfilled
// one period per asset from the legacy active_from/active_to columns, and
// installed a trigger that keeps those legacy columns in sync as a
// denormalized view of the periods. So:
//   - Existing reads (filter by active_to IS NULL) keep working unchanged.
//   - These endpoints are the new write surface — closing/opening periods.
//   - The DB-level EXCLUDE constraint prevents overlapping periods for the
//     same asset; we map that error to a 409 here.

interface DbActivityPeriodRow {
  id:              number;
  asset_id:        number;
  org_id:          string;
  start_date:      string;
  end_date:        string | null;
  created_at:      string;
  created_by_name: string | null;
}

interface AssetActivityPeriod {
  id:            number;
  assetId:       number;
  startDate:     string;
  endDate:       string | null;
  createdAt:     string;
  createdByName: string | null;
}

function rowToPeriod(r: DbActivityPeriodRow): AssetActivityPeriod {
  return {
    id:            r.id,
    assetId:       r.asset_id,
    startDate:     r.start_date,
    endDate:       r.end_date,
    createdAt:     r.created_at,
    createdByName: r.created_by_name,
  };
}

/**
 * Cap check for a period mutation: returns a 402 Response if reopening
 * this asset would put the org over its truck cap, else null.
 *
 * The cap counts assets whose active_to is NULL or >= today (mirrors
 * applyActiveCapFilter, what POST /v1/assets uses). A period mutation
 * only changes the count when it moves the asset from "currently
 * retired" (active_to in the past) to "active or future" (period
 * extending end_date to NULL or today+). Otherwise the count stays
 * the same — adding more periods to an already-counted asset doesn't
 * change anything.
 *
 * Internal/unrestricted orgs short-circuit to null. Caller patterns:
 *   const block = await capCheckForPeriodChange(orgId, id, endDate);
 *   if (block) return block;
 */
type CapBlockResponse = ReturnType<typeof Response.json>;
async function capCheckForPeriodChange(
  orgId: string,
  assetId: number,
  newEndDate: string | null,
): Promise<CapBlockResponse | null> {
  const today = new Date().toISOString().slice(0, 10);
  // Read current asset.active_to to know whether this asset is already
  // counted toward the cap. Trigger keeps this in sync with all periods.
  const { data: assetRow } = await supabase
    .from("assets")
    .select("active_to")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  const currentActiveTo = (assetRow as { active_to: string | null } | null)?.active_to;
  const currentlyCounted =
    currentActiveTo === null || (currentActiveTo !== undefined && currentActiveTo >= today);
  const wouldBeCounted = newEndDate === null || newEndDate >= today;
  if (currentlyCounted || !wouldBeCounted) return null;

  const tier = await getOrgTier(orgId);
  if (!Number.isFinite(tier.maxTrucks)) return null;

  // Same filter and Unassigned exclusions as POST /v1/assets so the
  // count matches across endpoints (otherwise "you're at 5/5" could
  // disagree between Add Truck and Reopen Period).
  const baseQ = supabase
    .from("assets")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .neq("type", "Unassigned")
    .neq("name", "Unassigned");
  const { count: activeCount, error: countErr } = await applyActiveCapFilter(baseQ);
  if (countErr) {
    console.error("[capCheckForPeriodChange] count failed:", countErr);
    return Response.json(
      { error: "tier_check_failed", detail: countErr.message } satisfies ApiErrorResponse,
      { status: 500 },
    );
  }
  const current = activeCount ?? 0;
  if (current < tier.maxTrucks) return null;

  const detail = tier.tier === "none"
    ? `Reopening this truck would put you over your truck limit. Retire or delete a different truck first, or contact support.`
    : `Reopening this truck would put you over your plan limit (${current} of ${tier.maxTrucks} active). Retire or delete a different truck first, or upgrade your plan.`;
  return Response.json(
    {
      error:  "tier_cap_exceeded",
      detail,
      errors: [`tier=${tier.tier}`, `current=${current}`, `max=${tier.maxTrucks}`],
    } satisfies ApiErrorResponse,
    { status: 402 },
  );
}

// GET /v1/assets/:id/periods — list all periods for an asset, oldest first.
assets.get("/:id/periods", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("asset_activity_periods" as never)
    .select("id, asset_id, org_id, start_date, end_date, created_at, created_by_name")
    .eq("org_id", orgId)
    .eq("asset_id", id)
    .order("start_date", { ascending: true });
  if (error) {
    console.error("[GET /v1/assets/:id/periods] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const periods = ((data ?? []) as DbActivityPeriodRow[]).map(rowToPeriod);
  return c.json({ periods });
});

// POST /v1/assets/:id/periods — start a new period for an asset.
// Body: { startDate: "YYYY-MM-DD", endDate?: "YYYY-MM-DD" | null }
// Typical flow: "+ New activity period" after a previous one was closed.
// The EXCLUDE constraint on (asset_id, daterange) rejects overlaps; we
// surface that as a 409 with a human-readable message.
assets.post("/:id/periods", requireCapability("assets.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<{ startDate?: string; endDate?: string | null; createdByName?: string }>();
  const startDate = (body.startDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return c.json({ error: "validation_failed", errors: ["startDate required as YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
  }
  const endDate = body.endDate ?? null;
  if (endDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return c.json({ error: "validation_failed", errors: ["endDate must be YYYY-MM-DD or null"] } satisfies ApiErrorResponse, 400);
  }
  if (endDate !== null && endDate < startDate) {
    return c.json({ error: "validation_failed", errors: ["endDate must be on or after startDate"] } satisfies ApiErrorResponse, 400);
  }

  // Tier cap: refuse if reopening this asset would exceed the org's plan.
  const capBlock = await capCheckForPeriodChange(orgId, id, endDate);
  if (capBlock) return capBlock;

  const { data, error } = await supabase
    .from("asset_activity_periods" as never)
    .insert({
      asset_id:        id,
      org_id:          orgId,
      start_date:      startDate,
      end_date:        endDate,
      created_by_name: body.createdByName ?? null,
    } as never)
    .select("id, asset_id, org_id, start_date, end_date, created_at, created_by_name")
    .single();
  if (error || !data) {
    if (error?.message?.includes("aap_no_overlap")) {
      return c.json({
        error:  "period_overlap",
        detail: "This period overlaps with an existing activity period for this asset.",
      } satisfies ApiErrorResponse, 409);
    }
    console.error("[POST /v1/assets/:id/periods] failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ period: rowToPeriod(data as unknown as DbActivityPeriodRow) });
});

// PATCH /v1/assets/:id/periods/:periodId — edit a period's dates.
// Used to close an open period (set endDate to today) and to correct
// mistakes in start/end dates.
assets.patch("/:id/periods/:periodId", requireCapability("assets.edit"), async (c) => {
  const orgId    = c.get("orgId");
  const id       = Number(c.req.param("id"));
  const periodId = Number(c.req.param("periodId"));
  if (!Number.isFinite(id) || !Number.isFinite(periodId)) {
    return c.json({ error: "validation_failed", errors: ["id and periodId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<{ startDate?: string; endDate?: string | null }>();
  const update: Record<string, unknown> = {};
  if ("startDate" in body) {
    if (typeof body.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      return c.json({ error: "validation_failed", errors: ["startDate must be YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
    }
    update.start_date = body.startDate;
  }
  if ("endDate" in body) {
    if (body.endDate !== null && (typeof body.endDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.endDate))) {
      return c.json({ error: "validation_failed", errors: ["endDate must be YYYY-MM-DD or null"] } satisfies ApiErrorResponse, 400);
    }
    update.end_date = body.endDate;
  }
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  // Tier cap: if this PATCH extends the period to today or beyond and
  // the asset is currently retired (active_to in the past), reopening
  // it could push the org over the cap. Compute the effective new
  // end_date — body value if provided, otherwise the period's existing
  // end_date — and run the same check used on POST /v1/assets/:id/periods.
  if ("endDate" in body) {
    const { data: currentPeriod } = await supabase
      .from("asset_activity_periods" as never)
      .select("end_date")
      .eq("id", periodId)
      .eq("asset_id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    const currentEnd = (currentPeriod as { end_date: string | null } | null)?.end_date ?? null;
    const effectiveNewEnd: string | null = body.endDate === undefined ? currentEnd : (body.endDate ?? null);
    const capBlock = await capCheckForPeriodChange(orgId, id, effectiveNewEnd);
    if (capBlock) return capBlock;
  }

  const { data, error } = await supabase
    .from("asset_activity_periods" as never)
    .update(update as never)
    .eq("id", periodId)
    .eq("asset_id", id)
    .eq("org_id", orgId)
    .select("id, asset_id, org_id, start_date, end_date, created_at, created_by_name")
    .single();
  if (error || !data) {
    if (error?.message?.includes("aap_no_overlap")) {
      return c.json({
        error:  "period_overlap",
        detail: "The new dates overlap with another activity period for this asset.",
      } satisfies ApiErrorResponse, 409);
    }
    if (error?.message?.includes("aap_end_after_start")) {
      return c.json({
        error:  "validation_failed",
        errors: ["endDate must be on or after startDate"],
      } satisfies ApiErrorResponse, 400);
    }
    console.error("[PATCH /v1/assets/:id/periods/:periodId] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ period: rowToPeriod(data as unknown as DbActivityPeriodRow) });
});

// DELETE /v1/assets/:id/periods/:periodId — remove a wrongly-created
// period. Gated on assets.delete because it's a structural edit; the
// common "close this period" action is a PATCH, not a DELETE. Refuses
// to delete the last remaining period (would leave the asset orphaned
// from a period perspective — the trigger handles the legacy columns
// but downstream views would still want at least one row).
assets.delete("/:id/periods/:periodId", requireCapability("assets.delete"), async (c) => {
  const orgId    = c.get("orgId");
  const id       = Number(c.req.param("id"));
  const periodId = Number(c.req.param("periodId"));
  if (!Number.isFinite(id) || !Number.isFinite(periodId)) {
    return c.json({ error: "validation_failed", errors: ["id and periodId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { count: existing } = await supabase
    .from("asset_activity_periods" as never)
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("asset_id", id);
  if ((existing ?? 0) <= 1) {
    return c.json({
      error:  "last_period",
      detail: "Can't delete the only activity period for an asset. Edit its dates instead, or retire the asset.",
    } satisfies ApiErrorResponse, 409);
  }
  const { error } = await supabase
    .from("asset_activity_periods" as never)
    .delete()
    .eq("id", periodId)
    .eq("asset_id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/assets/:id/periods/:periodId] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ deleted: true, id: periodId });
});

export default assets;
