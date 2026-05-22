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
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const assets = new Hono<{ Variables: AuthVariables }>();

interface DbAssetRow {
  id: number;
  name: string;
  color: string;
  type: string;
  unit: string | null;
  truck: string | null;
  notes: string | null;
  hidden: boolean;
  motive_vehicle_id: string | null;
  sort_order: number;
  active_from: string;
  active_to: string | null;
}

// Columns shared across all endpoints — single source of truth so we
// can't forget to add a new column to one of the SELECTs.
const ASSET_COLS = "id,name,color,type,unit,truck,notes,hidden,motive_vehicle_id,sort_order,active_from,active_to";

function rowToAsset(r: DbAssetRow): Asset {
  return {
    id:               r.id,
    name:             r.name,
    color:            r.color,
    type:             r.type,
    unit:             r.unit              ?? undefined,
    truck:            r.truck             ?? undefined,
    hidden:           r.hidden,
    notes:            r.notes             ?? undefined,
    motiveVehicleId:  r.motive_vehicle_id ?? undefined,
    sortOrder:        r.sort_order,
    activeFrom:       r.active_from,
    activeTo:         r.active_to,
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

  let sortOrder = body.sortOrder;
  if (sortOrder === undefined) {
    const { count } = await supabase
      .from("assets")
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId);
    sortOrder = count ?? 0;
  }

  const insert = {
    org_id:            orgId,
    name:              body.name,
    color:             body.color,
    type:              body.type,
    unit:              body.unit             ?? null,
    truck:             body.truck            ?? null,
    notes:             body.notes            ?? null,
    hidden:            body.hidden           ?? false,
    motive_vehicle_id: body.motiveVehicleId  ?? null,
    sort_order:        sortOrder,
    // active_from defaults to CURRENT_DATE in the DB if omitted;
    // active_to defaults to NULL (currently active).
    active_from:       body.activeFrom       ?? todayUtcDateKey(),
    active_to:         body.activeTo         ?? null,
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
  if ("notes"           in body) update.notes             = body.notes            ?? null;
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

export default assets;
