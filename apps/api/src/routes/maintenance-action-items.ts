/**
 * /v1/maintenance-action-items — ops's tracked maintenance work.
 *
 * Items land here either via /v1/maintenance-reports/:id/convert (the
 * driver-report → action-item flow) or via POST here for ad-hoc work
 * orders that didn't come from a report.
 *
 * Clerk-auth (org-scoped). No driver-side surface — drivers see
 * historical reports, not work orders.
 */
import { Hono } from "hono";
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_ACTION_STATUSES,
  type ListMaintenanceActionItemsResponse,
  type GetMaintenanceActionItemResponse,
  type CreateMaintenanceActionItemRequest,
  type CreateMaintenanceActionItemResponse,
  type UpdateMaintenanceActionItemRequest,
  type UpdateMaintenanceActionItemResponse,
  type ApiErrorResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import {
  rowToActionItem,
  ACTION_ITEM_COLS,
  type MaintenanceActionItemRow,
} from "./maintenance-reports.js";

const actionItems = new Hono<{ Variables: AuthVariables }>();

function clampLimit(raw: string | undefined, fallback = 100): number {
  const n = Number(raw ?? String(fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 500);
}

function validateAssetOrTrailer(body: { assetId?: number; trailerId?: number }): string[] {
  const errors: string[] = [];
  const hasAsset   = body.assetId   != null && Number.isFinite(body.assetId);
  const hasTrailer = body.trailerId != null && Number.isFinite(body.trailerId);
  if (hasAsset && hasTrailer) errors.push("exactly one of assetId / trailerId");
  if (!hasAsset && !hasTrailer) errors.push("one of assetId / trailerId required");
  return errors;
}

// ── POST /v1/maintenance-action-items — create ad-hoc ──────────────────

actionItems.post("/", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");

  let body: CreateMaintenanceActionItemRequest;
  try { body = await c.req.json<CreateMaintenanceActionItemRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  const errors = validateAssetOrTrailer(body);
  if (!body.title || !body.title.trim()) errors.push("title required");
  if (body.category && !(MAINTENANCE_CATEGORIES as readonly string[]).includes(body.category)) errors.push("category invalid");
  if (body.priority && !(MAINTENANCE_PRIORITIES as readonly string[]).includes(body.priority)) errors.push("priority invalid");
  if (errors.length) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);

  const insertRow = {
    org_id:         orgId,
    asset_id:       body.assetId   ?? null,
    trailer_id:     body.trailerId ?? null,
    title:          body.title.trim(),
    description:    body.description?.trim() || null,
    category:       body.category ?? "repair",
    priority:       body.priority ?? "normal",
    status:         "open",
    out_of_service: !!body.outOfService,
    scheduled_date: body.scheduledDate ?? null,
    due_date:       body.dueDate       ?? null,
    vendor:         body.vendor?.trim() || null,
    estimated_cost: body.estimatedCost ?? null,
    created_by:     userId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_action_items")
    .insert(insertRow as any)
    .select(ACTION_ITEM_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/maintenance-action-items] failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateMaintenanceActionItemResponse = {
    actionItem: rowToActionItem(data as unknown as MaintenanceActionItemRow),
  };
  return c.json(res);
});

// ── GET /v1/maintenance-action-items — list ─────────────────────────────

actionItems.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const status        = url.searchParams.get("status");
  const priority      = url.searchParams.get("priority");
  const category      = url.searchParams.get("category");
  const oosRaw        = url.searchParams.get("outOfService");
  const assetIdRaw    = url.searchParams.get("assetId");
  const trailerRaw    = url.searchParams.get("trailerId");
  const scheduledFrom = url.searchParams.get("scheduledFrom");
  const scheduledTo   = url.searchParams.get("scheduledTo");
  const limit  = clampLimit(url.searchParams.get("limit") ?? undefined);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("maintenance_action_items")
    .select(ACTION_ITEM_COLS, { count: "exact" })
    .eq("org_id", orgId)
    .order("priority", { ascending: false }) // 'urgent' / 'high' first alphabetically backwards — overridden below
    .order("created_at", { ascending: false });

  if (status   && (MAINTENANCE_ACTION_STATUSES as readonly string[]).includes(status))   q = q.eq("status", status);
  if (priority && (MAINTENANCE_PRIORITIES      as readonly string[]).includes(priority)) q = q.eq("priority", priority);
  if (category && (MAINTENANCE_CATEGORIES      as readonly string[]).includes(category)) q = q.eq("category", category);
  if (oosRaw === "true")  q = q.eq("out_of_service", true);
  if (oosRaw === "false") q = q.eq("out_of_service", false);
  if (assetIdRaw) q = q.eq("asset_id",   Number(assetIdRaw));
  if (trailerRaw) q = q.eq("trailer_id", Number(trailerRaw));
  if (scheduledFrom) q = q.gte("scheduled_date", scheduledFrom);
  if (scheduledTo)   q = q.lt("scheduled_date",  scheduledTo);
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    console.error("[GET /v1/maintenance-action-items] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = (data ?? []) as unknown as MaintenanceActionItemRow[];
  const res: ListMaintenanceActionItemsResponse = {
    actionItems: rows.map(rowToActionItem),
    total:       count ?? rows.length,
    limit,
    offset,
  };
  return c.json(res);
});

// ── GET /v1/maintenance-action-items/:id ────────────────────────────────

actionItems.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { data, error } = await supabase
    .from("maintenance_action_items")
    .select(ACTION_ITEM_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: GetMaintenanceActionItemResponse = {
    actionItem: rowToActionItem(data as unknown as MaintenanceActionItemRow),
  };
  return c.json(res);
});

// ── PATCH /v1/maintenance-action-items/:id ──────────────────────────────

actionItems.patch("/:id", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");

  let body: UpdateMaintenanceActionItemRequest;
  try { body = await c.req.json<UpdateMaintenanceActionItemRequest>(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] } satisfies ApiErrorResponse, 400); }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("title"       in body) update.title       = (body.title ?? "").trim() || null;
  if ("description" in body) update.description = body.description?.toString().trim() || null;
  if ("category" in body && body.category) {
    if (!(MAINTENANCE_CATEGORIES as readonly string[]).includes(body.category)) {
      return c.json({ error: "validation_failed", errors: ["category invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.category = body.category;
  }
  if ("priority" in body && body.priority) {
    if (!(MAINTENANCE_PRIORITIES as readonly string[]).includes(body.priority)) {
      return c.json({ error: "validation_failed", errors: ["priority invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.priority = body.priority;
  }
  if ("status" in body && body.status) {
    if (!(MAINTENANCE_ACTION_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: "validation_failed", errors: ["status invalid"] } satisfies ApiErrorResponse, 400);
    }
    update.status = body.status;
    // Auto-stamp completion when transitioning to 'done'. Caller can
    // override completedBy via the same payload.
    if (body.status === 'done') {
      update.completed_at = new Date().toISOString();
      if (body.completedBy === undefined) update.completed_by = userId;
    }
  }
  if ("outOfService" in body && typeof body.outOfService === 'boolean') {
    update.out_of_service = body.outOfService;
  }
  if ("scheduledDate" in body) update.scheduled_date = body.scheduledDate ?? null;
  if ("dueDate"       in body) update.due_date       = body.dueDate       ?? null;
  if ("vendor"        in body) update.vendor         = body.vendor ?? null;
  if ("estimatedCost" in body) update.estimated_cost = body.estimatedCost ?? null;
  if ("actualCost"    in body) update.actual_cost    = body.actualCost    ?? null;
  if ("completedBy"   in body) update.completed_by   = body.completedBy   ?? null;

  if (Object.keys(update).length <= 1) { // only updated_at
    return c.json({ error: "validation_failed", errors: ["no fields to update"] } satisfies ApiErrorResponse, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_action_items")
    .update(update as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(ACTION_ITEM_COLS)
    .maybeSingle();
  if (error) {
    console.error("[PATCH /v1/maintenance-action-items/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateMaintenanceActionItemResponse = {
    actionItem: rowToActionItem(data as unknown as MaintenanceActionItemRow),
  };
  return c.json(res);
});

// ── DELETE /v1/maintenance-action-items/:id ─────────────────────────────

actionItems.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  const { error } = await supabase
    .from("maintenance_action_items")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/maintenance-action-items/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

export default actionItems;
