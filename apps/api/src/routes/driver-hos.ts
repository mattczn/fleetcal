/**
 * Driver-app HOS endpoints. Mounted at /v1/driver/hos behind the same
 * driverAuth middleware as the rest of the driver surface, so every
 * handler can trust c.get("driverId") / c.get("orgId").
 *
 * Deliberate design choices:
 *   * Location is best-effort. A clock-in must never fail because GPS
 *     is unavailable — a driver in a dead zone still starts their day.
 *   * Clock-in is forgiving. A double-tap returns the open shift, and
 *     a forgotten clock-out auto-closes rather than blocking the new
 *     shift. Blocking would cost us today's data on top of yesterday's.
 *   * The driver sees today, not the cycle. The 70/8 number is only as
 *     good as a full week of clean clock-ins; today's timer is only as
 *     good as today. Fragile math belongs where dispatch can sanity
 *     check it, so it's omitted from this response.
 */
import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { type DriverAuthVariables } from "../middleware/driverAuth.js";
import {
  getDriverHosView, clockIn, clockOut, correctShiftTimes,
  type Classification,
} from "../lib/hosService.js";

// Mounted as a sub-router of driver.ts (`driver.route("/hos", …)`), so
// driverAuth is already applied upstream — don't re-apply it here or the
// JWT gets verified and the drivers row fetched twice per request.
const driverHos = new Hono<{ Variables: DriverAuthVariables }>();

/** Coerce a client-supplied coordinate; anything out of range or
 *  non-finite becomes null rather than poisoning the row. */
function coord(v: unknown, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

/** Clock skew allowance — a phone a few seconds ahead of the server
 *  shouldn't have its clock-in rejected as "in the future". */
const FUTURE_GRACE_MS = 60_000;

/** How far back a driver may backdate their own clock in/out. Beyond
 *  this it stops being "I forgot for a couple of hours" and becomes a
 *  records edit, which is dispatch's call, not the driver's. */
const MAX_BACKDATE_MS = 36 * 3600 * 1000;

type TimeCheck = { ok: true; at: Date } | { ok: false; error: string };

/** Parses and bounds a driver-supplied timestamp. `notBefore` is the
 *  shift start when closing a shift; omitted when opening one. */
function parseAdjustedTime(raw: unknown, now: Date, notBefore?: Date): TimeCheck {
  if (raw == null) return { ok: true, at: now };
  if (typeof raw !== "string") return { ok: false, error: "Time must be a timestamp." };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { ok: false, error: "That isn't a valid time." };
  if (at.getTime() > now.getTime() + FUTURE_GRACE_MS) {
    return { ok: false, error: "That time is in the future." };
  }
  if (now.getTime() - at.getTime() > MAX_BACKDATE_MS) {
    return { ok: false, error: "That time is more than 36 hours ago. Ask dispatch to fix it." };
  }
  if (notBefore && at.getTime() <= notBefore.getTime()) {
    return { ok: false, error: "That time is before your shift started." };
  }
  return { ok: true, at };
}

async function driverConfig(driverId: number): Promise<{
  enabled: boolean; defaultClassification: Classification; name: string;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("drivers")
    .select("name, hos_enabled, hos_default_classification")
    .eq("id", driverId)
    .maybeSingle();
  const d = (data ?? {}) as { name?: string; hos_enabled?: boolean; hos_default_classification?: string };
  return {
    enabled: d.hos_enabled !== false,
    defaultClassification: d.hos_default_classification === "otr" ? "otr" : "local",
    name: d.name ?? "Driver",
  };
}

/** Shape the driver card renders from. Cycle numbers are intentionally
 *  absent — see the header note. */
function statusPayload(view: Awaited<ReturnType<typeof getDriverHosView>>) {
  const { snapshot, openShift, lastClosedShift } = view;
  return {
    status: snapshot.status,
    stale:  snapshot.stale,
    onDutySecondsToday: Math.round(snapshot.onDutySecondsToday),
    currentShift: openShift ? {
      id:             openShift.id,
      startedAt:      openShift.started_at,
      classification: openShift.classification,
      elapsedSeconds:   Math.round(snapshot.window?.elapsedSeconds ?? 0),
      remainingSeconds: Math.round(snapshot.window?.remainingSeconds ?? 0),
      windowExpiresAt:  snapshot.window?.expiresAt.toISOString() ?? null,
      windowExpired:    snapshot.window?.expired ?? false,
    } : null,
    lastShift: lastClosedShift ? {
      id:        lastClosedShift.id,
      startedAt: lastClosedShift.started_at,
      endedAt:   lastClosedShift.ended_at,
      onDutySeconds: lastClosedShift.on_duty_seconds,
      autoClosed:    lastClosedShift.auto_closed,
      needsReview:   lastClosedShift.needs_review,
    } : null,
    rest: snapshot.rest ? {
      restSeconds: Math.round(snapshot.rest.restSeconds),
      satisfied:   snapshot.rest.satisfied,
      clearAt:     snapshot.rest.clearAt.toISOString(),
    } : null,
    // What an off-duty driver can do next. Two genuinely different
    // options exist while the 14-hour window is still open, and a
    // driver shown only the 10-hour reset will sit out hours they were
    // entitled to work.
    options: {
      windowEndsAt:          snapshot.options.windowEndsAt?.toISOString() ?? null,
      canResumeWithinWindow: snapshot.options.canResumeWithinWindow,
      resetCompleteAt:       snapshot.options.resetCompleteAt?.toISOString() ?? null,
      fullyRested:           snapshot.options.fullyRested,
    },
    /** Where the active 14-hour window began. Differs from the open
     *  shift's start whenever the driver took a break under 10 hours. */
    dutyPeriodStart: snapshot.dutyPeriodStart?.toISOString() ?? null,
  };
}

// ── GET /v1/driver/hos/status ────────────────────────────────────────
driverHos.get("/status", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const cfg = await driverConfig(driverId);
  if (!cfg.enabled) return c.json({ enabled: false });
  const view = await getDriverHosView(driverId, orgId, new Date());
  return c.json({ enabled: true, ...statusPayload(view) });
});

// ── POST /v1/driver/hos/clock-in ─────────────────────────────────────
driverHos.post("/clock-in", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const name     = c.get("driverName");

  const cfg = await driverConfig(driverId);
  if (!cfg.enabled) {
    return c.json({ error: "hos_disabled", detail: "HOS tracking is off for this driver." }, 403);
  }

  let body: { latitude?: unknown; longitude?: unknown; occurredAt?: unknown } = {};
  try { body = await c.req.json(); } catch { /* body is optional */ }

  const now = new Date();
  // occurredAt lets a driver who started before reaching their phone
  // set the real start time. Absent = clock in now.
  const when = parseAdjustedTime(body.occurredAt, now);
  if (!when.ok) return c.json({ error: "validation_failed", errors: [when.error] }, 400);

  try {
    const result = await clockIn({
      driverId, orgId, now,
      startedAt: when.at,
      lat: coord(body.latitude, 90),
      lon: coord(body.longitude, 180),
      classification: cfg.defaultClassification,
      classificationSource: "default",
      actor: { kind: "driver", driverId, name },
    });
    const view = await getDriverHosView(driverId, orgId, now);
    return c.json({
      ...statusPayload(view),
      alreadyOpen: result.alreadyOpen,
      // Non-null means we closed a forgotten shift to make room. The
      // app turns this into the "when did you actually finish?" prompt.
      autoClosedShiftId: result.autoClosedShiftId,
    });
  } catch (err) {
    console.error("[POST /v1/driver/hos/clock-in] failed:", err);
    return c.json({ error: "clock_in_failed", detail: (err as Error).message }, 500);
  }
});

// ── POST /v1/driver/hos/clock-out ────────────────────────────────────
driverHos.post("/clock-out", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const name     = c.get("driverName");

  let body: { latitude?: unknown; longitude?: unknown; occurredAt?: unknown } = {};
  try { body = await c.req.json(); } catch { /* body is optional */ }

  const now = new Date();

  // Bound a backdated end against this shift's start, so a driver can't
  // close a shift before it began.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: openRow } = await (supabase as any)
    .from("hos_shifts").select("started_at")
    .eq("driver_id", driverId).is("ended_at", null).limit(1).maybeSingle();
  if (!openRow) {
    return c.json({ error: "not_clocked_in", detail: "No open shift to close." }, 409);
  }
  const when = parseAdjustedTime(body.occurredAt, now, new Date((openRow as { started_at: string }).started_at));
  if (!when.ok) return c.json({ error: "validation_failed", errors: [when.error] }, 400);

  try {
    const closed = await clockOut({
      driverId, orgId, now,
      endedAt: when.at,
      lat: coord(body.latitude, 90),
      lon: coord(body.longitude, 180),
      actor: { kind: "driver", driverId, name },
    });
    if (!closed) {
      return c.json({ error: "not_clocked_in", detail: "No open shift to close." }, 409);
    }
    const view = await getDriverHosView(driverId, orgId, now);
    return c.json(statusPayload(view));
  } catch (err) {
    console.error("[POST /v1/driver/hos/clock-out] failed:", err);
    return c.json({ error: "clock_out_failed", detail: (err as Error).message }, 500);
  }
});

// ── POST /v1/driver/hos/shifts/:id/correct-end ───────────────────────
//
// The driver answering "you were still clocked in — when did you
// finish?". Scoped to their OWN shifts, end time only: a driver can
// tell us when they stopped, but moving a start time is a dispatch
// action so the two can't be quietly rewritten from the same screen.
driverHos.post("/shifts/:id/correct-end", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const name     = c.get("driverName");
  const shiftId  = c.req.param("id");

  let body: { endedAt?: string; note?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.endedAt) {
    return c.json({ error: "validation_failed", errors: ["endedAt required"] }, 400);
  }
  const endedAt = new Date(body.endedAt);
  if (Number.isNaN(endedAt.getTime())) {
    return c.json({ error: "validation_failed", errors: ["endedAt is not a valid timestamp"] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: owned } = await (supabase as any)
    .from("hos_shifts")
    .select("id, driver_id, started_at")
    .eq("id", shiftId).eq("org_id", orgId)
    .maybeSingle();
  const shift = owned as { id: string; driver_id: number; started_at: string } | null;
  if (!shift) return c.json({ error: "not_found" }, 404);
  if (shift.driver_id !== driverId) return c.json({ error: "not_authorized" }, 403);

  const startedAt = new Date(shift.started_at);
  if (endedAt.getTime() <= startedAt.getTime()) {
    return c.json({ error: "validation_failed", errors: ["End time must be after the shift start."] }, 400);
  }
  if (endedAt.getTime() > Date.now() + 60_000) {
    return c.json({ error: "validation_failed", errors: ["End time can't be in the future."] }, 400);
  }

  try {
    await correctShiftTimes({
      shiftId, orgId, endedAt,
      note: body.note ?? "Corrected by driver after a missed clock-out.",
      actor: { kind: "driver", driverId, name },
    });
    const view = await getDriverHosView(driverId, orgId, new Date());
    return c.json(statusPayload(view));
  } catch (err) {
    console.error("[POST /v1/driver/hos/shifts/:id/correct-end] failed:", err);
    return c.json({ error: "correction_failed", detail: (err as Error).message }, 500);
  }
});

// ── POST /v1/driver/hos/shifts/:id/correct ───────────────────────────
//
// General correction of a driver's own shift: start, end, or both.
// Supersedes the end-only /correct-end below, which stays mounted so
// older app builds keep working through an OTA rollout.
//
// Drivers may now move a start time as well as an end. The earlier
// restriction (end-only, on the theory that starts were dispatch's
// business) just meant a driver who clocked in late had no way to say
// so, and the resulting shift was wrong in a way nobody would catch.
driverHos.post("/shifts/:id/correct", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const name     = c.get("driverName");
  const shiftId  = c.req.param("id");

  let body: { startedAt?: string; endedAt?: string; note?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body.startedAt && !body.endedAt) {
    return c.json({ error: "validation_failed", errors: ["Nothing to change."] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: owned } = await (supabase as any)
    .from("hos_shifts")
    .select("id, driver_id, started_at, ended_at")
    .eq("id", shiftId).eq("org_id", orgId)
    .maybeSingle();
  const shift = owned as
    { id: string; driver_id: number; started_at: string; ended_at: string | null } | null;
  if (!shift) return c.json({ error: "not_found" }, 404);
  if (shift.driver_id !== driverId) return c.json({ error: "not_authorized" }, 403);

  const now = new Date();
  const errors: string[] = [];
  let startedAt: Date | undefined;
  let endedAt:   Date | undefined;

  if (body.startedAt) {
    const parsed = parseAdjustedTime(body.startedAt, now);
    if (!parsed.ok) errors.push(parsed.error);
    else startedAt = parsed.at;
  }
  if (body.endedAt) {
    const parsed = parseAdjustedTime(body.endedAt, now);
    if (!parsed.ok) errors.push(parsed.error);
    else endedAt = parsed.at;
  }

  // Validate the resulting pair, not just each field: moving a start
  // past an untouched end (or vice versa) would invert the shift.
  const finalStart = startedAt ?? new Date(shift.started_at);
  const finalEnd   = endedAt ?? (shift.ended_at ? new Date(shift.ended_at) : null);
  if (finalEnd && finalEnd.getTime() <= finalStart.getTime()) {
    errors.push("The end time has to be after the start time.");
  }
  if (errors.length > 0) return c.json({ error: "validation_failed", errors }, 400);

  try {
    await correctShiftTimes({
      shiftId, orgId, startedAt, endedAt,
      note: body.note ?? "Times corrected by the driver.",
      actor: { kind: "driver", driverId, name },
    });
    const view = await getDriverHosView(driverId, orgId, new Date());
    return c.json(statusPayload(view));
  } catch (err) {
    console.error("[POST /v1/driver/hos/shifts/:id/correct] failed:", err);
    return c.json({ error: "correction_failed", detail: (err as Error).message }, 500);
  }
});

export default driverHos;
