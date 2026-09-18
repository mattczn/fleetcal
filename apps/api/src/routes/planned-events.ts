/**
 * /v1/planned-events — dispatcher placeholders on a truck's calendar.
 *
 * Clerk-auth, org-scoped. Gated by the `planning` module (default-off,
 * Curzon only for now) and the `planning.access` capability (admin +
 * dispatcher). Deliberately NOT mounted anywhere the driver API can
 * reach, and plans live in their own table rather than `events`, so no
 * driver list, confirm reminder, push, payroll row, or revenue rollup
 * can pick one up. See migration 20260918_planned_events.sql.
 *
 * A plan is closed by attaching the load it turned into
 * (POST /:id/attach). Closed and deleted plans drop out of the list.
 * "Expired" is computed here on read so every client agrees on it.
 */
import { Hono } from "hono";

import { supabase } from "../lib/supabase.js";
import { getUserDisplayName } from "../lib/clerk.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import {
  PLANNED_PURPOSES, PLANNED_EXPIRY_HOURS,
  type PlannedEvent, type PlannedPurpose,
} from "@fleetcal/types";

const planned = new Hono<{ Variables: AuthVariables }>();

/**
 * Untyped handle: packages/types/database.ts is generated from the live
 * project, so planned_events only appears there after the migration is
 * applied (same position timesheets was in). Every column named below
 * was checked by hand against 20260918_planned_events.sql, and
 * PLANNED_COLS is the one place the column list is written. Re-run
 * `npm run types:gen` after the migration lands and drop this cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

planned.use("*", requireModule("planning"), requireCapability("planning.access"));

const PLANNED_COLS =
  "id,org_id,asset_id,driver_id,purpose,title,notes,start,\"end\"," +
  "converted_load_id,converted_at,created_by_name,created_at,updated_at," +
  "driver:drivers(name)";

interface PlannedRow {
  id: string;
  org_id: string;
  asset_id: number;
  driver_id: number | null;
  purpose: PlannedPurpose;
  title: string;
  notes: string | null;
  start: string;
  end: string;
  converted_load_id: string | null;
  converted_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  driver: { name: string | null } | null;
}

/** Calendar times are naive 'YYYY-MM-DDTHH:mm' in the org's home
 *  timezone (America/Denver — same constant as web lib/time-utils). */
const HOME_TZ = "America/Denver";

/** "Now minus the expiry window" as a naive home-tz string, so it can
 *  be compared directly against a plan's `end`. */
function expiryCutoff(): string {
  const d = new Date(Date.now() - PLANNED_EXPIRY_HOURS * 3600_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: HOME_TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function rowToPlanned(r: PlannedRow, cutoff: string): PlannedEvent & { expired: boolean } {
  return {
    id:              r.id,
    assetId:         r.asset_id,
    driverId:        r.driver_id ?? undefined,
    driverName:      r.driver?.name ?? undefined,
    purpose:         r.purpose,
    title:           r.title,
    notes:           r.notes ?? undefined,
    start:           r.start,
    end:             r.end,
    convertedLoadId: r.converted_load_id ?? undefined,
    convertedAt:     r.converted_at ?? undefined,
    createdByName:   r.created_by_name ?? undefined,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
    expired:         !r.converted_at && r.end.slice(0, 16) < cutoff,
  };
}

const NAIVE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type Parsed = {
  asset_id?: number; driver_id?: number | null; purpose?: PlannedPurpose;
  title?: string; notes?: string | null; start?: string; end?: string;
};

/** Validates the fields present on a create/update body. `partial`
 *  allows omissions (PATCH); create passes false and every required
 *  field must be there. Returns an error string or the parsed patch. */
function parseBody(body: Record<string, unknown>, partial: boolean): Parsed | string {
  const out: Parsed = {};
  if (body.assetId !== undefined) {
    if (typeof body.assetId !== "number" || !Number.isInteger(body.assetId)) return "assetId must be an integer";
    out.asset_id = body.assetId;
  } else if (!partial) return "assetId is required";

  if (body.driverId !== undefined) {
    if (body.driverId !== null && (typeof body.driverId !== "number" || !Number.isInteger(body.driverId))) {
      return "driverId must be an integer or null";
    }
    out.driver_id = body.driverId as number | null;
  }

  if (body.purpose !== undefined) {
    if (!PLANNED_PURPOSES.includes(body.purpose as PlannedPurpose)) return "invalid purpose";
    out.purpose = body.purpose as PlannedPurpose;
  } else if (!partial) out.purpose = "find_load";

  if (body.title !== undefined) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t) return "title is required";
    out.title = t;
  } else if (!partial) return "title is required";

  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== "string") return "notes must be a string";
    out.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  }

  for (const k of ["start", "end"] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== "string" || !NAIVE_TS.test(body[k] as string)) return `${k} must be YYYY-MM-DDTHH:mm`;
      out[k] = (body[k] as string).slice(0, 16);
    } else if (!partial) return `${k} is required`;
  }
  if (out.start && out.end && out.end <= out.start) return "end must be after start";
  return out;
}

/** The asset (and driver, when given) must belong to the caller's org —
 *  the service key bypasses RLS, so this is the only thing stopping a
 *  plan from pointing at another carrier's truck. */
async function checkRefs(orgId: string, p: Parsed): Promise<string | null> {
  if (p.asset_id !== undefined) {
    const { data } = await supabase.from("assets").select("id").eq("org_id", orgId).eq("id", p.asset_id).maybeSingle();
    if (!data) return "asset not found";
  }
  if (p.driver_id != null) {
    const { data } = await supabase.from("drivers").select("id").eq("org_id", orgId).eq("id", p.driver_id).maybeSingle();
    if (!data) return "driver not found";
  }
  return null;
}

// ── GET / — open plans (not converted, not deleted) ────────────────────
// ?from=YYYY-MM-DD limits to plans ending on/after that date. Default is
// 30 days back, which comfortably covers expired plans still on screen.
planned.get("/", async (c) => {
  const orgId = c.get("orgId");
  const fromParam = c.req.query("from");
  const from = fromParam && /^\d{4}-\d{2}-\d{2}/.test(fromParam)
    ? fromParam.slice(0, 10)
    : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const { data, error } = await db
    .from("planned_events")
    .select(PLANNED_COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .is("converted_at", null)
    .gte("end", from)
    .order("start", { ascending: true })
    .order("id", { ascending: true });
  if (error) {
    console.error("[GET /v1/planned-events] failed:", error);
    return c.json({ error: "list_failed", detail: error.message }, 500);
  }
  const cutoff = expiryCutoff();
  return c.json({ plannedEvents: (data as PlannedRow[]).map((r) => rowToPlanned(r, cutoff)) });
});

// ── POST / — create ────────────────────────────────────────────────────
planned.post("/", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);

  const parsed = parseBody(body as Record<string, unknown>, false);
  if (typeof parsed === "string") return c.json({ error: "invalid_body", detail: parsed }, 400);
  const refErr = await checkRefs(orgId, parsed);
  if (refErr) return c.json({ error: "invalid_body", detail: refErr }, 400);

  const { data, error } = await db
    .from("planned_events")
    .insert({
      ...parsed,
      org_id:          orgId,
      created_by:      userId,
      created_by_name: await getUserDisplayName(userId),
    })
    .select(PLANNED_COLS)
    .single();
  if (error) {
    console.error("[POST /v1/planned-events] failed:", error);
    return c.json({ error: "create_failed", detail: error.message }, 500);
  }
  return c.json({ plannedEvent: rowToPlanned(data as PlannedRow, expiryCutoff()) }, 201);
});

// ── PATCH /:id — edit ──────────────────────────────────────────────────
planned.patch("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);

  const parsed = parseBody(body as Record<string, unknown>, true);
  if (typeof parsed === "string") return c.json({ error: "invalid_body", detail: parsed }, 400);
  if (Object.keys(parsed).length === 0) return c.json({ error: "invalid_body", detail: "nothing to update" }, 400);
  const refErr = await checkRefs(orgId, parsed);
  if (refErr) return c.json({ error: "invalid_body", detail: refErr }, 400);

  // Only one of start/end may be in the patch — validate the resulting
  // span against the stored other half before writing. The DB CHECK
  // would reject it too, but as a 500 instead of a readable 400.
  if ((parsed.start === undefined) !== (parsed.end === undefined)) {
    const { data: cur } = await db.from("planned_events").select("start,end")
      .eq("org_id", orgId).eq("id", id).is("deleted_at", null).maybeSingle();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const s = parsed.start ?? cur.start, e = parsed.end ?? cur.end;
    if (e <= s) return c.json({ error: "invalid_body", detail: "end must be after start" }, 400);
  }

  const { data, error } = await db
    .from("planned_events")
    .update(parsed)
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select(PLANNED_COLS)
    .maybeSingle();
  if (error) {
    console.error("[PATCH /v1/planned-events/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ plannedEvent: rowToPlanned(data as PlannedRow, expiryCutoff()) });
});

// ── POST /:id/attach — close the plan against the load it became ───────
// Body: { loadId }. The load must be in this org. Idempotent for the
// same load; attaching an already-closed plan to a different load is a
// 409 rather than a silent overwrite.
planned.post("/:id/attach", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { loadId?: unknown } | null;
  const loadId = typeof body?.loadId === "string" ? body.loadId : null;
  if (!loadId) return c.json({ error: "invalid_body", detail: "loadId is required" }, 400);

  const { data: load } = await supabase.from("loads").select("id")
    .eq("org_id", orgId).eq("id", loadId).is("deleted_at", null).maybeSingle();
  if (!load) return c.json({ error: "invalid_body", detail: "load not found" }, 400);

  const { data: cur } = await db.from("planned_events").select("converted_load_id,converted_at")
    .eq("org_id", orgId).eq("id", id).is("deleted_at", null).maybeSingle();
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.converted_at && cur.converted_load_id !== loadId) {
    return c.json({ error: "already_attached", detail: "This plan is already attached to another load." }, 409);
  }

  const { data, error } = await db
    .from("planned_events")
    .update({ converted_load_id: loadId, converted_at: cur.converted_at ?? new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", id)
    .select(PLANNED_COLS)
    .single();
  if (error) {
    console.error("[POST /v1/planned-events/:id/attach] failed:", error);
    return c.json({ error: "attach_failed", detail: error.message }, 500);
  }
  return c.json({ plannedEvent: rowToPlanned(data as PlannedRow, expiryCutoff()) });
});

// ── DELETE /:id — soft delete ──────────────────────────────────────────
planned.delete("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { data, error } = await db
    .from("planned_events")
    .update({ deleted_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[DELETE /v1/planned-events/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default planned;
