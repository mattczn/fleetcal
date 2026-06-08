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
  sort_order: number;
  active_from: string;
  active_to: string | null;
}

// Columns shared across all endpoints — single source of truth so we
// can't forget to add a new column to one of the SELECTs.
const ASSET_COLS = "id,name,color,type,unit,truck,make,model,vin,license_plate,license_state,license_expiration,notes,hidden,motive_vehicle_id,sort_order,active_from,active_to";

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
  const res: ListAssetsResponse = { assets: ((data ?? []) as unknown as DbAssetRow[]).map(rowToAsset) };
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
    // `.neq("type", "Unassigned")` excludes the calendar's virtual
    // Unassigned column — it's a UI surface for unrouted events,
    // not a real truck, and shouldn't burn a paid seat.
    const baseQ = supabase
      .from("assets")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .neq("type", "Unassigned");
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

  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${kind}_${Date.now()}_${rand}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supabase.storage
    .from(ASSET_DOC_BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
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
      file_name:    file.name,
      mime_type:    file.type || null,
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

export default assets;
