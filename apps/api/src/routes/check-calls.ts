/**
 * Check-call helpers and the bare /v1/check-calls/:id DELETE handler.
 *
 * The load-scoped GET/POST handlers are mounted from loads.ts via
 * `loads.route("/:loadId/check-calls", checkCallsScopedRouter)` so that
 * Hono's path-merging works the same way as every other sub-route.
 *
 * Auth: clerk org_id required. Rows are scoped per-org so cross-org access
 * fails the eq("org_id") filter.
 */

import { Hono } from "hono";
import {
  type CheckCall,
  type ListCheckCallsResponse,
  type CreateCheckCallRequest,
  type CreateCheckCallResponse,
  type ApiErrorResponse,
  CHECK_CALL_CHANNELS,
  CHECK_CALL_PARTIES,
  type CheckCallChannel,
  type CheckCallParty,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

interface CheckCallRow {
  id:            string;
  load_id:       string;
  ts:            string;
  by_name:       string;
  channel:       string;
  with_party:    string;
  body:          string;
  next_check_at: string | null;
  created_at:    string;
}

function rowToCheckCall(r: CheckCallRow): CheckCall {
  return {
    id:           r.id,
    loadId:       r.load_id,
    ts:           r.ts,
    byName:       r.by_name,
    channel:      r.channel as CheckCallChannel,
    withParty:    r.with_party as CheckCallParty,
    body:         r.body,
    nextCheckAt:  r.next_check_at ?? undefined,
    createdAt:    r.created_at,
  };
}

const COLS = "id,load_id,ts,by_name,channel,with_party,body,next_check_at,created_at";

// ── /v1/loads/:loadId/check-calls (mounted from loads.ts) ───────────────

export const checkCallsScopedRouter = new Hono<{ Variables: AuthVariables }>();

checkCallsScopedRouter.get("/", async (c) => {
  const orgId = c.get("orgId");
  // `loadId` is bound by the parent mount (`/loads/:loadId/check-calls`);
  // inner-router types don't carry it, so narrow defensively.
  const loadId = c.req.param("loadId") ?? "";
  if (!loadId) return c.json({ error: "missing_load_id" } satisfies ApiErrorResponse, 400);

  const { data, error } = await supabase
    .from("check_calls")
    .select(COLS)
    .eq("org_id", orgId)
    .eq("load_id", loadId)
    .order("ts", { ascending: false });

  if (error) {
    console.error("[GET check-calls] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const res: ListCheckCallsResponse = {
    checkCalls: ((data ?? []) as CheckCallRow[]).map(rowToCheckCall),
  };
  return c.json(res);
});

checkCallsScopedRouter.post("/", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("loadId") ?? "";
  if (!loadId) return c.json({ error: "missing_load_id" } satisfies ApiErrorResponse, 400);
  const body = await c.req.json<CreateCheckCallRequest>();

  const errors: string[] = [];
  if (!body || typeof body !== "object") errors.push("body must be an object");
  if (!body?.channel || !(CHECK_CALL_CHANNELS as readonly string[]).includes(body.channel)) {
    errors.push(`channel must be one of: ${CHECK_CALL_CHANNELS.join(", ")}`);
  }
  if (!body?.withParty || !(CHECK_CALL_PARTIES as readonly string[]).includes(body.withParty)) {
    errors.push(`withParty must be one of: ${CHECK_CALL_PARTIES.join(", ")}`);
  }
  if (!body?.body?.trim()) errors.push("body text required");
  if (!body?.byName?.trim()) errors.push("byName required");
  if (errors.length) {
    return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
  }

  const insert = {
    org_id:        orgId,
    load_id:       loadId,
    ts:            body.ts ?? new Date().toISOString(),
    by_name:       body.byName.trim(),
    channel:       body.channel,
    with_party:    body.withParty,
    body:          body.body.trim(),
    next_check_at: body.nextCheckAt ?? null,
  };

  const { data, error } = await supabase
    .from("check_calls")
    .insert(insert as never)
    .select(COLS)
    .single();

  if (error || !data) {
    console.error("[POST check-calls] failed:", error);
    return c.json({ error: "create_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const res: CreateCheckCallResponse = { checkCall: rowToCheckCall(data as CheckCallRow) };
  return c.json(res, 201);
});

// ── /v1/check-calls (top-level) — DELETE only ───────────────────────────

const checkCallsRouter = new Hono<{ Variables: AuthVariables }>();

checkCallsRouter.delete("/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { error } = await supabase
    .from("check_calls")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE check-calls] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.body(null, 204);
});

export default checkCallsRouter;
