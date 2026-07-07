/**
 * /v1/dispatchers — dispatcher CRUD.
 *
 * Dispatchers are per-org rows with first_name, last_name, optional
 * hire_date, optional clerk_user_id link, an is_default flag (at most
 * one per org), and an active soft-delete flag.
 *
 * The set-default flow is implicit: setting is_default=true in a
 * create OR update first clears every other row's is_default in the
 * same org. The unique partial index on (org_id) WHERE is_default
 * = true guarantees we never end up with two defaults even under
 * concurrent writes.
 *
 * DELETE soft-deletes (active=false) if the dispatcher is referenced
 * by any loads.dispatcher_id row; hard-deletes otherwise. Either way
 * the historical loads.dispatcher text cache stays intact.
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
  id:             number;
  first_name:     string;
  last_name:      string;
  hire_date:      string | null;
  clerk_user_id:  string | null;
  is_default:     boolean;
  active:         boolean;
}

function rowToDispatcher(r: DbDispatcherRow): Dispatcher {
  return {
    id:          r.id,
    firstName:   r.first_name,
    lastName:    r.last_name,
    hireDate:    r.hire_date    ?? undefined,
    clerkUserId: r.clerk_user_id ?? undefined,
    isDefault:   r.is_default,
    active:      r.active,
  };
}

const ROW_COLUMNS = "id,first_name,last_name,hire_date,clerk_user_id,is_default,active";

dispatchers.get("/", requireCapability("dispatchers.view"), async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("dispatchers")
    .select(ROW_COLUMNS)
    .eq("org_id", orgId)
    // Active first, then alphabetical. Soft-deleted rows surface at
    // the bottom so the dispatcher dropdown shows real options first.
    .order("active",     { ascending: false })
    .order("last_name",  { ascending: true })
    .order("first_name", { ascending: true });
  if (error) {
    console.error("[GET /v1/dispatchers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListDispatchersResponse = {
    dispatchers: ((data ?? []) as DbDispatcherRow[]).map(rowToDispatcher),
  };
  return c.json(res);
});

dispatchers.post("/", requireCapability("dispatchers.create"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<CreateDispatcherRequest>();
  const errors: string[] = [];
  if (!body.firstName?.trim()) errors.push("firstName required");
  if (!body.lastName?.trim())  errors.push("lastName required");
  if (errors.length > 0) {
    return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
  }
  if (body.isDefault) {
    // Clear any current default before we set ours. Partial unique
    // index prevents the race from breaking, but doing this first
    // avoids the constraint-violation noise in logs.
    await supabase
      .from("dispatchers")
      .update({ is_default: false } as never)
      .eq("org_id", orgId);
  }
  const { data, error } = await supabase
    .from("dispatchers")
    .insert({
      org_id:        orgId,
      first_name:    body.firstName.trim(),
      last_name:     body.lastName.trim(),
      hire_date:     body.hireDate ?? null,
      clerk_user_id: body.clerkUserId ?? null,
      is_default:    body.isDefault ?? false,
      active:        body.active    ?? true,
    } as never)
    .select(ROW_COLUMNS)
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
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["bad id"] } satisfies ApiErrorResponse, 400);
  }
  const body = await c.req.json<UpdateDispatcherRequest>();

  if (body.isDefault) {
    // Same clear-others-first pattern as POST.
    await supabase
      .from("dispatchers")
      .update({ is_default: false } as never)
      .eq("org_id", orgId);
  }

  const update: Record<string, unknown> = {};
  if ("firstName"  in body && body.firstName  !== undefined) update.first_name    = body.firstName.trim();
  if ("lastName"   in body && body.lastName   !== undefined) update.last_name     = body.lastName.trim();
  if ("hireDate"   in body) update.hire_date     = body.hireDate   ?? null;
  if ("clerkUserId"in body) update.clerk_user_id = body.clerkUserId ?? null;
  if ("isDefault"  in body) update.is_default    = body.isDefault;
  if ("active"     in body) update.active        = body.active;

  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("dispatchers")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(ROW_COLUMNS)
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
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["bad id"] } satisfies ApiErrorResponse, 400);
  }

  // Soft delete if any load references this dispatcher; hard delete
  // otherwise. Either way, the legacy loads.dispatcher text cache is
  // untouched so historical rows still display the name.
  const usageRes = await supabase
    .from("loads")
    .select("id", { count: "exact", head: true })
    .eq("dispatcher_id", id)
    .eq("org_id", orgId);

  const referenced = (usageRes.count ?? 0) > 0;
  if (referenced) {
    const { error } = await supabase
      .from("dispatchers")
      .update({ active: false, is_default: false } as never)
      .eq("id", id)
      .eq("org_id", orgId);
    if (error) {
      console.error("[DELETE /v1/dispatchers/:id soft] failed:", error);
      return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
  } else {
    const { error } = await supabase
      .from("dispatchers")
      .delete()
      .eq("id", id)
      .eq("org_id", orgId);
    if (error) {
      console.error("[DELETE /v1/dispatchers/:id hard] failed:", error);
      return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
  }
  return c.body(null, 204);
});

export default dispatchers;
