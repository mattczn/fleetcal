/**
 * /v1/trailers — trailer CRUD.
 */

import { Hono } from "hono";
import {
  type Trailer,
  type TrailerCategory,
  type ListTrailersResponse,
  type CreateTrailerRequest,
  type CreateTrailerResponse,
  type UpdateTrailerRequest,
  type UpdateTrailerResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const trailers = new Hono<{ Variables: AuthVariables }>();

interface DbTrailerRow {
  id: number;
  name: string;
  trailer_number: string | null;
  category: TrailerCategory;
  notes: string | null;
  motive_vehicle_id: string | null;
  sort_order: number;
}

function rowToTrailer(r: DbTrailerRow): Trailer {
  return {
    id:               r.id,
    name:             r.name,
    trailerNumber:    r.trailer_number    ?? undefined,
    category:         r.category,
    notes:            r.notes             ?? undefined,
    motiveVehicleId:  r.motive_vehicle_id ?? undefined,
    sortOrder:        r.sort_order,
  };
}

const COLS = "id,name,trailer_number,category,notes,motive_vehicle_id,sort_order";

trailers.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("trailers")
    .select(COLS)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/trailers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListTrailersResponse = { trailers: ((data ?? []) as DbTrailerRow[]).map(rowToTrailer) };
  return c.json(res);
});

trailers.post("/", requireCapability("trailers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateTrailerRequest>();
  if (!body.name || !body.category) {
    return c.json({ error: "validation_failed", errors: ["name and category required"] } satisfies ApiErrorResponse, 400);
  }
  // Append to end
  const { count } = await supabase
    .from("trailers")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  const insert = {
    org_id:            orgId,
    name:              body.name,
    trailer_number:    body.trailerNumber   ?? null,
    category:          body.category,
    notes:             body.notes           ?? null,
    motive_vehicle_id: body.motiveVehicleId ?? null,
    sort_order:        count ?? 0,
  };
  const { data, error } = await supabase
    .from("trailers")
    .insert(insert as never)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/trailers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateTrailerResponse = { trailer: rowToTrailer(data as DbTrailerRow) };
  return c.json(res, 201);
});

trailers.patch("/:id", requireCapability("trailers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<UpdateTrailerRequest>();
  const update: Record<string, unknown> = {};
  if ("name"            in body) update.name              = body.name;
  if ("trailerNumber"   in body) update.trailer_number    = body.trailerNumber    ?? null;
  if ("category"        in body) update.category          = body.category;
  if ("notes"           in body) update.notes             = body.notes            ?? null;
  if ("motiveVehicleId" in body) update.motive_vehicle_id = body.motiveVehicleId  ?? null;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("trailers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/trailers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateTrailerResponse = { trailer: rowToTrailer(data as DbTrailerRow) };
  return c.json(res);
});

trailers.delete("/:id", requireCapability("trailers.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  const { error } = await supabase
    .from("trailers")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/trailers/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default trailers;
