/**
 * /v1/dispatchers — dispatcher CRUD.
 *
 * Only one dispatcher per org can be marked default. The handlers clear
 * other rows' is_default flag when a row is created/updated as default.
 */

import { Hono } from "hono";
import {
  type Dispatcher,
  type ListDispatchersResponse,
  type CreateDispatcherRequest,
  type CreateDispatcherResponse,
  type UpdateDispatcherRequest,
  type UpdateDispatcherResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const dispatchers = new Hono<{ Variables: AuthVariables }>();

interface DbDispatcherRow {
  id: string;
  name: string;
  is_default: boolean;
}

function rowToDispatcher(r: DbDispatcherRow): Dispatcher {
  return { id: r.id, name: r.name, isDefault: r.is_default };
}

dispatchers.get("/", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("dispatchers")
    .select("id,name,is_default")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) {
    console.error("[GET /v1/dispatchers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListDispatchersResponse = { dispatchers: ((data ?? []) as DbDispatcherRow[]).map(rowToDispatcher) };
  return c.json(res);
});

dispatchers.post("/", requireCapability("dispatchers.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateDispatcherRequest>();
  if (!body.name) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  if (body.isDefault) {
    await supabase.from("dispatchers").update({ is_default: false } as never).eq("org_id", orgId);
  }
  const { data, error } = await supabase
    .from("dispatchers")
    .insert({ org_id: orgId, name: body.name, is_default: body.isDefault ?? false } as never)
    .select("id,name,is_default")
    .single();
  if (error || !data) {
    console.error("[POST /v1/dispatchers] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateDispatcherResponse = { dispatcher: rowToDispatcher(data as DbDispatcherRow) };
  return c.json(res, 201);
});

dispatchers.patch("/:id", requireCapability("dispatchers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<UpdateDispatcherRequest>();
  if (body.isDefault) {
    await supabase.from("dispatchers").update({ is_default: false } as never).eq("org_id", orgId);
  }
  const update: Record<string, unknown> = {};
  if ("name"      in body) update.name       = body.name;
  if ("isDefault" in body) update.is_default = body.isDefault;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("dispatchers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id,name,is_default")
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/dispatchers/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: UpdateDispatcherResponse = { dispatcher: rowToDispatcher(data as DbDispatcherRow) };
  return c.json(res);
});

dispatchers.delete("/:id", requireCapability("dispatchers.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("dispatchers")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/dispatchers/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default dispatchers;
