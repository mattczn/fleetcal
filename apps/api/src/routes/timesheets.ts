/**
 * /v1/timesheets — shop clock in / clock out + location pings.
 *
 * Clerk-auth, org-scoped. Gated by the `timesheets` module and the
 * `timesheet.self` capability at the router level: everyone who can
 * reach any of this can at least punch their own clock. Reading OTHER
 * people's hours needs `timesheet.view_all`, and changing recorded
 * times needs `timesheet.edit` — both checked per-handler because they
 * branch on whose row is being touched, not on the route.
 *
 * ── The invariant this file is built around ──────────────────────────
 *
 * A shift row is what someone gets PAID from, so the dangerous failure
 * is not a lost punch, it's a duplicated or overlapping one. The
 * database enforces both (see 20260915_timesheets.sql: a partial
 * unique index for one open shift per user, and a gist exclusion
 * constraint against overlapping spans). This layer translates those
 * violations into honest 409s instead of retrying around them — a
 * retry that "succeeds" by opening a second shift is the bug.
 */
import { Hono } from "hono";

import { supabase } from "../lib/supabase.js";
import { getUserDisplayName } from "../lib/clerk.js";
import type { AuthVariables } from "../middleware/clerk.js";
import {
  requireCapability, requireModule, effectiveCanForOrg,
} from "../middleware/require.js";

const timesheets = new Hono<{ Variables: AuthVariables }>();

/**
 * Untyped handle for the two timesheet tables.
 *
 * packages/types/database.ts is GENERATED from the live Supabase
 * project (`npm run types:gen`), so a table only appears there after
 * its migration has been applied. `hos_shifts` and `ramp_transactions`
 * are in the same position today and use this same cast.
 *
 * The cost is real: this turns OFF column-name checking for these
 * tables, which is exactly the class of typo that ships silently. Every
 * column named in this file was checked by hand against
 * 20260915_timesheets.sql, and SHIFT_COLS below is the single place the
 * shift column list is written. When the migration lands, re-run
 * `npm run types:gen` and this cast can be deleted outright.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

timesheets.use("*", requireModule("timesheets"), requireCapability("timesheet.self"));

// ── Row types + converters ──────────────────────────────────────────────

interface ShiftRow {
  id:                  string;
  org_id:              string;
  user_id:             string;
  user_name:           string | null;
  started_at:          string;
  ended_at:            string | null;
  start_lat:           number | string | null;
  start_lng:           number | string | null;
  end_lat:             number | string | null;
  end_lng:             number | string | null;
  notes:               string | null;
  tracking_stopped_at: string | null;
  edited_by:           string | null;
  edited_at:           string | null;
  created_at:          string;
  updated_at:          string;
}

/** Postgres `numeric` arrives as a string over PostgREST — coercing
 *  here keeps every caller from having to remember that. */
function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToShift(r: ShiftRow) {
  const startedMs = new Date(r.started_at).getTime();
  const endedMs   = r.ended_at ? new Date(r.ended_at).getTime() : null;
  return {
    id:        r.id,
    userId:    r.user_id,
    userName:  r.user_name ?? undefined,
    startedAt: r.started_at,
    endedAt:   r.ended_at ?? undefined,
    startLat:  num(r.start_lat)  ?? undefined,
    startLng:  num(r.start_lng)  ?? undefined,
    endLat:    num(r.end_lat)    ?? undefined,
    endLng:    num(r.end_lng)    ?? undefined,
    notes:     r.notes ?? undefined,
    trackingStoppedAt: r.tracking_stopped_at ?? undefined,
    editedBy:  r.edited_by ?? undefined,
    editedAt:  r.edited_at ?? undefined,
    /** Server-computed so every surface agrees on the number. Null
     *  while the shift is still open — an in-progress duration is a
     *  render-time concern, not a stored one. */
    durationMinutes: endedMs != null
      ? Math.round((endedMs - startedMs) / 60000)
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SHIFT_COLS =
  "id,org_id,user_id,user_name,started_at,ended_at,start_lat,start_lng," +
  "end_lat,end_lng,notes,tracking_stopped_at,edited_by,edited_at,created_at,updated_at";

/** Postgres SQLSTATEs the constraints in the migration can raise.
 *  23505 = unique_violation (the one-open-shift index),
 *  23P01 = exclusion_violation (the no-overlap constraint). */
const UNIQUE_VIOLATION    = "23505";
const EXCLUSION_VIOLATION = "23P01";

function isConflict(code: string | undefined): boolean {
  return code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION;
}

/** Coordinate pair off a request body, or nulls. A punch is never
 *  rejected for a missing or malformed fix — recording the hour
 *  matters more than recording where it started, and the client may
 *  legitimately have no permission or no signal. */
function coords(body: Record<string, unknown>): { lat: number | null; lng: number | null } {
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  // Half a coordinate is not a location. Keep the pair all-or-nothing
  // so a reviewer never sees a pin at longitude 0.
  if (lat == null || lng == null) return { lat: null, lng: null };
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { lat: null, lng: null };
  return { lat, lng };
}

// ── GET /active — my currently-running shift, if any ────────────────────
//
// Always scoped to the caller. A reviewer wanting someone else's open
// shift reads it off GET / with ?userId=, which is where the
// view_all check lives.
timesheets.get("/active", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");

  const { data, error } = await db
    .from("timesheet_shifts")
    .select(SHIFT_COLS)
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .is("ended_at", null)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    console.error("[timesheets] GET /active:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }
  return c.json({ shift: data ? rowToShift(data as unknown as ShiftRow) : null });
});

// ── POST /clock-in ──────────────────────────────────────────────────────
timesheets.post("/clock-in", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body   = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const { lat, lng } = coords(body);

  // The server owns the timestamp. A phone whose clock is wrong (or
  // set deliberately) must not be able to write a start time, because
  // that time is what the hours are computed from.
  const startedAt = new Date().toISOString();
  const userName  = await getUserDisplayName(userId);

  const { data, error } = await db
    .from("timesheet_shifts")
    .insert({
      org_id:     orgId,
      user_id:    userId,
      user_name:  userName,
      started_at: startedAt,
      start_lat:  lat,
      start_lng:  lng,
      notes:      typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
    } as never)
    .select(SHIFT_COLS)
    .single();

  if (error) {
    // Already clocked in. Hand back the OPEN shift rather than an
    // opaque error — the usual cause is a retry after a response the
    // phone never received, and the client's correct next move is to
    // show the running clock it already has.
    if (isConflict(error.code)) {
      const { data: open } = await db
        .from("timesheet_shifts")
        .select(SHIFT_COLS)
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .is("ended_at", null)
        .is("deleted_at", null)
        .maybeSingle();
      return c.json({
        error:   "already_clocked_in",
        message: "There is already an open shift for this user.",
        shift:   open ? rowToShift(open as unknown as ShiftRow) : null,
      }, 409);
    }
    console.error("[timesheets] POST /clock-in:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }

  return c.json({ shift: rowToShift(data as unknown as ShiftRow) }, 201);
});

// ── POST /:id/clock-out ─────────────────────────────────────────────────
timesheets.post("/:id/clock-out", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const role   = c.get("orgRole");
  const id     = c.req.param("id");
  const body   = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const { lat, lng } = coords(body);

  const { data: existing, error: readErr } = await db
    .from("timesheet_shifts")
    .select(SHIFT_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (readErr) {
    console.error("[timesheets] clock-out read:", readErr);
    return c.json({ error: "db_error", message: readErr.message }, 500);
  }
  if (!existing) return c.json({ error: "not_found" }, 404);

  const row = existing as unknown as ShiftRow;

  // Closing someone else's shift is an edit of their pay record.
  if (row.user_id !== userId && !(await effectiveCanForOrg(role, "timesheet.edit", orgId))) {
    return c.json({ error: "forbidden", reason: "not_your_shift" }, 403);
  }
  // Already closed — idempotent, same reasoning as clock-in.
  if (row.ended_at) {
    return c.json({ shift: rowToShift(row) });
  }

  const { data, error } = await db
    .from("timesheet_shifts")
    .update({
      ended_at:   new Date().toISOString(),
      end_lat:    lat,
      end_lng:    lng,
      notes:      typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : row.notes,
      // The client sets this when it detects background location has
      // stopped delivering, so a gap in the pings reads as "tracking
      // was off" rather than "he didn't move".
      tracking_stopped_at: typeof body.trackingStoppedAt === "string"
        ? body.trackingStoppedAt
        : row.tracking_stopped_at,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("org_id", orgId)
    .eq("id", id)
    .select(SHIFT_COLS)
    .single();

  if (error) {
    console.error("[timesheets] clock-out:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }
  return c.json({ shift: rowToShift(data as unknown as ShiftRow) });
});

// ── POST /:id/pings — batch upload of buffered location samples ─────────
//
// Batched and idempotent on purpose. The phone keeps sampling while
// offline and flushes whatever it has whenever it next reaches the
// network, so the same batch can legitimately arrive twice after a
// timeout the client never saw resolved. UNIQUE(shift_id, at) plus
// ignoreDuplicates makes the retry a no-op instead of a second cluster
// of pins on the reviewer's map.
timesheets.post("/:id/pings", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const body   = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const raw = Array.isArray(body.pings) ? body.pings : [];
  if (raw.length === 0) return c.json({ inserted: 0 });
  if (raw.length > 500) {
    return c.json({ error: "too_many_pings", message: "Send at most 500 samples per request." }, 400);
  }

  const { data: shift, error: readErr } = await db
    .from("timesheet_shifts")
    .select("id,user_id,ended_at")
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (readErr) {
    console.error("[timesheets] pings read:", readErr);
    return c.json({ error: "db_error", message: readErr.message }, 500);
  }
  if (!shift) return c.json({ error: "not_found" }, 404);
  // Only the person being tracked may add to their own trail. There is
  // no reviewer override here on purpose — a location history someone
  // else can append to is not evidence of anything.
  if ((shift as { user_id: string }).user_id !== userId) {
    return c.json({ error: "forbidden", reason: "not_your_shift" }, 403);
  }

  const rows: Array<{ shift_id: string; org_id: string; at: string; lat: number; lng: number; accuracy_m: number | null }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const s = p as Record<string, unknown>;
    const { lat, lng } = coords(s);
    if (lat == null || lng == null) continue;
    const at = typeof s.at === "string" ? s.at : null;
    if (!at || Number.isNaN(new Date(at).getTime())) continue;
    const acc = typeof s.accuracy === "number" && Number.isFinite(s.accuracy) ? s.accuracy : null;
    rows.push({ shift_id: id, org_id: orgId, at, lat, lng, accuracy_m: acc });
  }
  if (rows.length === 0) return c.json({ inserted: 0 });

  const { data, error } = await db
    .from("timesheet_pings")
    .upsert(rows as never, { onConflict: "shift_id,at", ignoreDuplicates: true })
    .select("id");

  if (error) {
    console.error("[timesheets] pings insert:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }
  return c.json({ inserted: data?.length ?? 0, received: rows.length });
});

// ── GET /:id/pings — the trail for one shift ────────────────────────────
timesheets.get("/:id/pings", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const role   = c.get("orgRole");
  const id     = c.req.param("id");

  const { data: shift } = await db
    .from("timesheet_shifts")
    .select("id,user_id")
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();

  if (!shift) return c.json({ error: "not_found" }, 404);
  if ((shift as { user_id: string }).user_id !== userId
      && !(await effectiveCanForOrg(role, "timesheet.view_all", orgId))) {
    return c.json({ error: "forbidden", reason: "not_your_shift" }, 403);
  }

  const { data, error } = await db
    .from("timesheet_pings")
    .select("id,at,lat,lng,accuracy_m")
    .eq("org_id", orgId)
    .eq("shift_id", id)
    .order("at", { ascending: true });

  if (error) {
    console.error("[timesheets] GET pings:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }

  type PingRow = { id: number; at: string; lat: number | string; lng: number | string; accuracy_m: number | string | null };
  const pings = ((data ?? []) as PingRow[]).map((r) => {
    return { id: r.id, at: r.at, lat: num(r.lat)!, lng: num(r.lng)!, accuracy: num(r.accuracy_m) ?? undefined };
  });
  return c.json({ pings });
});

// ── GET / — list shifts ─────────────────────────────────────────────────
//
// Defaults to the caller's own shifts. `?userId=` (or `?all=1`) widens
// it and requires timesheet.view_all — a caller without that cap gets
// their own rows rather than a 403, so a shared client can render the
// same screen for both roles without branching on permissions.
timesheets.get("/", async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const role   = c.get("orgRole");
  const url    = new URL(c.req.url);

  const wantsAll    = url.searchParams.get("all") === "1";
  const wantsUser   = url.searchParams.get("userId");
  const from        = url.searchParams.get("from");
  const to          = url.searchParams.get("to");
  const limitRaw    = Number(url.searchParams.get("limit") ?? "100");
  const limit       = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);

  const canViewAll = await effectiveCanForOrg(role, "timesheet.view_all", orgId);

  let q = db
    .from("timesheet_shifts")
    .select(SHIFT_COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    // Ordered before limiting. An unordered range over PostgREST can
    // drop and duplicate rows across pages — see fetchAll's ORDER BY.
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (!canViewAll)          q = q.eq("user_id", userId);
  else if (wantsUser)       q = q.eq("user_id", wantsUser);
  else if (!wantsAll)       q = q.eq("user_id", userId);

  if (from) q = q.gte("started_at", from);
  if (to)   q = q.lte("started_at", to);

  const { data, error } = await q;
  if (error) {
    console.error("[timesheets] GET /:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }

  return c.json({
    shifts: ((data ?? []) as ShiftRow[]).map((r) => rowToShift(r)),
    scope:  canViewAll && (wantsAll || wantsUser) ? "org" : "self",
  });
});

// ── PATCH /:id — correct recorded times ─────────────────────────────────
//
// The forgotten clock-out is the common case: someone goes home, the
// shift runs overnight, and a reviewer fixes it the next morning. Every
// correction stamps edited_by / edited_at so the record shows it was
// touched. Correcting your OWN times still needs timesheet.edit —
// timesheet.self is "punch the clock", not "rewrite the clock".
timesheets.patch("/:id", requireCapability("timesheet.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");
  const body   = await c.req.json().catch(() => ({})) as Record<string, unknown>;

  const patch: Record<string, unknown> = {
    edited_by:  userId,
    edited_at:  new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  for (const [key, col] of [["startedAt", "started_at"], ["endedAt", "ended_at"]] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null) { patch[col] = null; continue; }
    if (typeof v !== "string" || Number.isNaN(new Date(v).getTime())) {
      return c.json({ error: "bad_request", message: `${key} must be an ISO timestamp or null.` }, 400);
    }
    patch[col] = v;
  }
  if ("notes" in body) {
    patch.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  }
  if (patch.started_at === null) {
    return c.json({ error: "bad_request", message: "startedAt cannot be cleared." }, 400);
  }

  const { data, error } = await db
    .from("timesheet_shifts")
    .update(patch as never)
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select(SHIFT_COLS)
    .single();

  if (error) {
    // A correction that would overlap another shift, or reopen a second
    // concurrent one, is refused by the DB. Surface it as a conflict so
    // the reviewer fixes the other row rather than seeing "save failed".
    if (isConflict(error.code)) {
      return c.json({
        error: "overlaps_existing_shift",
        message: "Those times overlap another shift for this person.",
      }, 409);
    }
    // 23514 = check_violation, i.e. ended_at <= started_at.
    if (error.code === "23514") {
      return c.json({
        error: "bad_span",
        message: "Clock-out must be after clock-in.",
      }, 400);
    }
    console.error("[timesheets] PATCH:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);

  return c.json({ shift: rowToShift(data as unknown as ShiftRow) });
});

// ── DELETE /:id — soft delete ───────────────────────────────────────────
timesheets.delete("/:id", requireCapability("timesheet.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const id     = c.req.param("id");

  const { data, error } = await db
    .from("timesheet_shifts")
    .update({ deleted_at: new Date().toISOString(), deleted_by: userId } as never)
    .eq("org_id", orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[timesheets] DELETE:", error);
    return c.json({ error: "db_error", message: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default timesheets;
