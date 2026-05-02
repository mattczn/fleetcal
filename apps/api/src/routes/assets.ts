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
}

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
  };
}

assets.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("assets")
    .select("id,name,color,type,unit,truck,notes,hidden,motive_vehicle_id,sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/assets] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListAssetsResponse = { assets: ((data ?? []) as DbAssetRow[]).map(rowToAsset) };
  return c.json(res);
});

assets.post("/", async (c) => {
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
  };
  const { data, error } = await supabase
    .from("assets")
    .insert(insert as never)
    .select("id,name,color,type,unit,truck,notes,hidden,motive_vehicle_id,sort_order")
    .single();
  if (error || !data) {
    console.error("[POST /v1/assets] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateAssetResponse = { asset: rowToAsset(data as DbAssetRow) };
  return c.json(res, 201);
});

assets.patch("/:id", async (c) => {
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
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("assets")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id,name,color,type,unit,truck,notes,hidden,motive_vehicle_id,sort_order")
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/assets/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateAssetResponse = { asset: rowToAsset(data as DbAssetRow) };
  return c.json(res);
});

assets.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("assets")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/assets/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

assets.post("/reorder", async (c) => {
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

export default assets;
