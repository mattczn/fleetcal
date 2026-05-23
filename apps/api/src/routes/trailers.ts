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
  active_from: string;
  active_to: string | null;
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
    activeFrom:       r.active_from,
    activeTo:         r.active_to,
  };
}

const COLS = "id,name,trailer_number,category,notes,motive_vehicle_id,sort_order,active_from,active_to";

function todayUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  const res: ListTrailersResponse = { trailers: ((data ?? []) as unknown as DbTrailerRow[]).map(rowToTrailer) };
  return c.json(res);
});

trailers.post("/", requireCapability("trailers.create"), async (c) => {
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
    active_from:       body.activeFrom      ?? todayUtcDateKey(),
    active_to:         body.activeTo        ?? null,
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
  const res: CreateTrailerResponse = { trailer: rowToTrailer(data as unknown as DbTrailerRow) };
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
  if ("activeFrom"      in body) update.active_from       = body.activeFrom;
  if ("activeTo"        in body) update.active_to         = body.activeTo ?? null;
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
  const res: UpdateTrailerResponse = { trailer: rowToTrailer(data as unknown as DbTrailerRow) };
  return c.json(res);
});

// DELETE has two modes:
//   default       → SOFT RETIRE — stamps active_to = today. Loads stay
//                   attached, the trailer just stops appearing in the
//                   active fleet view.
//   ?hard=true    → HARD DELETE — actually removes the row. Strict
//                   pre-flight count of every related table; if anything
//                   still references this trailer (loads, inspection
//                   reports, maintenance reports/items), we refuse with
//                   a 409 and a per-table breakdown rather than letting
//                   the DB's ON DELETE RESTRICT raise a generic 500.
//                   This makes cascade impossible.
trailers.delete("/:id", requireCapability("trailers.delete"), async (c) => {
  const orgId = c.get("orgId");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["id must be numeric"] } satisfies ApiErrorResponse, 400);
  }

  // Hard delete branch — "created by accident" cleanup. Must be
  // fully orphaned across every referencing table.
  const hard = c.req.query("hard") === "true";
  if (hard) {
    const blockers = await countTrailerBlockers(orgId, id);
    const total = Object.values(blockers).reduce((s, n) => s + n, 0);
    if (total > 0) {
      return c.json(
        {
          error: "has_references",
          detail: "This trailer can't be permanently deleted because other records still reference it.",
          blockers,
        },
        409,
      );
    }
    const { error: delErr } = await supabase
      .from("trailers")
      .delete()
      .eq("id", id)
      .eq("org_id", orgId);
    if (delErr) {
      console.error("[DELETE /v1/trailers/:id?hard=true] failed:", delErr);
      return c.json({ error: "delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
    }
    return c.json({ deleted: true, id });
  }

  // Soft retire — idempotent: only stamp active_to when it's null so
  // an accidental double-tap on Retire doesn't bump the date.
  const today = todayUtcDateKey();
  const { data, error } = await supabase
    .from("trailers")
    .update({ active_to: today } as never)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("active_to", null)
    .select(COLS)
    .maybeSingle();
  if (error) {
    console.error("[DELETE /v1/trailers/:id] retire failed:", error);
    return c.json({ error: "retire_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) {
    const { data: existing } = await supabase
      .from("trailers")
      .select(COLS)
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!existing) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
    return c.json({ trailer: rowToTrailer(existing as unknown as unknown as DbTrailerRow) });
  }
  return c.json({ trailer: rowToTrailer(data as unknown as unknown as DbTrailerRow) });
});

/**
 * Count every table that references a trailer. Returns { table → count }
 * with only non-zero entries. Same shape/pattern as countAssetBlockers
 * in assets.ts so the client can render a uniform "has_references"
 * blocker message. Each lookup is a HEAD count (cheap) and they run
 * in parallel.
 *
 * Known referencing tables:
 *   - events.trailer_id              → labeled "loads" (friendlier)
 *   - inspection_reports.trailer_id  → DVIR inspection history
 *   - maintenance_reports.trailer_id
 *   - maintenance_action_items.trailer_id
 */
async function countTrailerBlockers(orgId: string, trailerId: number): Promise<Record<string, number>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const count = async (table: string, col: string) => {
    const { count: n, error } = await sb
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq(col, trailerId);
    if (error) {
      console.error(`[countTrailerBlockers] ${table}.${col}:`, error);
      return 0;
    }
    return n ?? 0;
  };
  const [events, inspections, maint, maintItems] = await Promise.all([
    count("events",                   "trailer_id"),
    count("inspection_reports",       "trailer_id"),
    count("maintenance_reports",      "trailer_id"),
    count("maintenance_action_items", "trailer_id"),
  ]);
  const out: Record<string, number> = {};
  if (events      > 0) out.loads                     = events;
  if (inspections > 0) out.inspection_reports        = inspections;
  if (maint       > 0) out.maintenance_reports       = maint;
  if (maintItems  > 0) out.maintenance_action_items  = maintItems;
  return out;
}

export default trailers;
