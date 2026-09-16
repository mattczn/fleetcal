/**
 * Dispatch-facing HOS endpoints (Clerk-authed, org-scoped).
 *
 * The board answers one question — "who can I use, and who needs
 * chasing" — so it leads with the two things a dispatcher can act on:
 * OTR shifts whose log nobody has verified, and shifts whose recorded
 * times are obviously wrong. Hours are the substrate; the enforcement
 * loop is the product.
 *
 * Unlike the driver payload, this one DOES carry cycle totals. The
 * 70/8 number is only as trustworthy as a week of clean clock-ins,
 * which is exactly why it belongs here — dispatch can see the shifts
 * behind it and correct them.
 */
import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { getUserDisplayName } from "../lib/clerk.js";
import { requireCapability } from "../middleware/require.js";
import {
  getHosConfig, loadRecentShifts, toIntervals, correctShiftTimes,
  findOverlappingShift, classifyShiftByLoads,
  type ShiftRow, type Classification, type LogMethod,
} from "../lib/hosService.js";
import { driverHosSnapshot, localDateString } from "../lib/hos.js";

const hos = new Hono<{ Variables: AuthVariables }>();

/** Rolling window for the paper-log counter. A driver may keep paper
 *  RODS on at most 8 days in any 30 before an ELD is required
 *  (§395.8(a)(1)(iii)(A)(1)). Nothing else in the app counts this, and
 *  with OTR slots rotating across the fleet it's very easy to cross
 *  quietly. */
const PAPER_LOG_WINDOW_DAYS = 30;
const PAPER_LOG_LIMIT = 8;
const PAPER_LOG_WARN_AT = 6;

interface DriverRow {
  id: number;
  name: string | null;
  hos_enabled: boolean | null;
  hos_default_classification: string | null;
  active_to: string | null;
}

// ── GET /v1/hos/board ────────────────────────────────────────────────
//
// One row per HOS-enabled driver, with everything the board renders.
// Deliberately a single call: 15 drivers x 4 queries would be 60 round
// trips for a screen that's refreshed constantly.
hos.get("/board", async (c) => {
  const orgId = c.get("orgId");
  const now = new Date();
  const config = await getHosConfig(orgId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: driverRows, error: driverErr } = await (supabase as any)
    .from("drivers")
    .select("id, name, hos_enabled, hos_default_classification, active_to")
    .eq("org_id", orgId)
    .is("active_to", null)
    .order("name", { ascending: true });
  if (driverErr) {
    console.error("[GET /v1/hos/board] drivers failed:", driverErr);
    return c.json({ error: "fetch_failed", detail: driverErr.message }, 500);
  }
  const drivers = ((driverRows ?? []) as DriverRow[]).filter(d => d.hos_enabled !== false);
  if (drivers.length === 0) return c.json({ drivers: [], config, generatedAt: now.toISOString() });

  // Every shift for every driver in one read, then grouped in memory.
  // The cycle needs 8 days and restart detection needs to see the gap
  // before that, so 16 days back; open shifts are pulled regardless of
  // age because a forgotten clock-out is exactly what we want to show.
  const since = new Date(now.getTime() - 16 * 24 * 3600 * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: shiftRows, error: shiftErr } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(`started_at.gte.${since},ended_at.is.null`)
    .order("started_at", { ascending: true });
  if (shiftErr) {
    console.error("[GET /v1/hos/board] shifts failed:", shiftErr);
    return c.json({ error: "fetch_failed", detail: shiftErr.message }, 500);
  }

  const byDriver = new Map<number, ShiftRow[]>();
  for (const row of ((shiftRows ?? []) as ShiftRow[])) {
    const list = byDriver.get(row.driver_id) ?? [];
    list.push(row);
    byDriver.set(row.driver_id, list);
  }

  // Re-classify OPEN shifts against the 150 air-mile radius. A driver
  // clocks in before dispatch has finished assigning the day, so the
  // classification made at clock-in goes stale the moment a load is
  // added — and an out-of-range load added at 10am is exactly the one
  // that needs flagging. Only open shifts (a handful at a time), and
  // never over a dispatcher's explicit call.
  const openShifts = ((shiftRows ?? []) as ShiftRow[])
    .filter(s => s.ended_at == null && s.classification_source !== "dispatch");
  await Promise.all(openShifts.map(async (s) => {
    try {
      const auto = await classifyShiftByLoads({
        driverId: s.driver_id, orgId,
        localDate: localDateString(new Date(s.started_at), config.timeZone),
      });
      if (!auto.decided || auto.classification === s.classification) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from("hos_shifts").update({
        classification: auto.classification,
        classification_source: "computed",
        // Turning local → OTR invalidates any verification: nobody
        // confirmed a log for a shift that wasn't OTR when they looked.
        ...(auto.classification === "otr"
          ? { log_verified_at: null, log_verified_by: null }
          : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", s.id);
      s.classification = auto.classification;
      s.classification_source = "computed";
      if (auto.classification === "otr") s.log_verified_at = null;
    } catch (err) {
      // Never let classification failure take the board down with it.
      console.warn("[hos/board] reclassify failed for shift", s.id, err);
    }
  }));

  // Paper-log counter needs a wider window than the cycle does.
  const paperSince = new Date(now.getTime() - PAPER_LOG_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: paperRows } = await (supabase as any)
    .from("hos_shifts")
    .select("driver_id, started_at")
    .eq("org_id", orgId)
    .eq("classification", "otr")
    .eq("log_method", "paper")
    .is("deleted_at", null)
    .gte("started_at", paperSince);
  // Count DAYS, not shifts — two OTR runs on one paper log is one day
  // against the limit.
  const paperDays = new Map<number, Set<string>>();
  for (const r of ((paperRows ?? []) as Array<{ driver_id: number; started_at: string }>)) {
    const set = paperDays.get(r.driver_id) ?? new Set<string>();
    set.add(localDateString(new Date(r.started_at), config.timeZone));
    paperDays.set(r.driver_id, set);
  }

  const result = drivers.map(d => {
    const shifts = byDriver.get(d.id) ?? [];
    const snapshot = driverHosSnapshot(toIntervals(shifts), now, config.timeZone, config.cycle);
    const open = shifts.find(s => s.ended_at == null) ?? null;
    const lastClosed = [...shifts].reverse().find(s => s.ended_at != null) ?? null;

    // Any OTR shift in the last week whose log nobody has confirmed.
    // This is the number dispatch is supposed to be driving to zero.
    const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
    const unverifiedOtr = shifts.filter(s =>
      s.classification === "otr" &&
      s.log_verified_at == null &&
      new Date(s.started_at).getTime() >= weekAgo,
    );
    const needsReview = shifts.filter(s => s.needs_review);
    const paperCount = paperDays.get(d.id)?.size ?? 0;

    return {
      driverId: d.id,
      name: d.name ?? `Driver ${d.id}`,
      defaultClassification: d.hos_default_classification === "otr" ? "otr" : "local",

      status: snapshot.status,
      classification: (open?.classification ?? lastClosed?.classification ?? d.hos_default_classification ?? "local") as Classification,

      currentShift: open ? {
        id: open.id,
        startedAt: open.started_at,
        classification: open.classification,
        logMethod: open.log_method,
        logVerifiedAt: open.log_verified_at,
        logVerifiedBy: open.log_verified_by,
        elapsedSeconds: Math.round((now.getTime() - new Date(open.started_at).getTime()) / 1000),
      } : null,
      lastShift: lastClosed ? {
        id: lastClosed.id,
        startedAt: lastClosed.started_at,
        endedAt: lastClosed.ended_at,
        onDutySeconds: lastClosed.on_duty_seconds,
      } : null,

      // 14-hour window, measured from the duty period rather than the
      // open shift — a break under 10 hours does not open a new one.
      dutyPeriodStart: snapshot.dutyPeriodStart?.toISOString() ?? null,
      windowRemainingSeconds: snapshot.window ? Math.round(snapshot.window.remainingSeconds) : null,
      // snapshot.window only exists while ON duty, but an off-duty
      // driver's window keeps running — that's the whole point of
      // canResumeWithinWindow. Take the end from options, which is
      // computed either way, or the board renders a blank "resume
      // until —" for exactly the drivers who need the number.
      windowExpiresAt: snapshot.options.windowEndsAt?.toISOString()
        ?? snapshot.window?.expiresAt.toISOString() ?? null,

      restSeconds: snapshot.rest ? Math.round(snapshot.rest.restSeconds) : null,
      restRemainingSeconds: snapshot.rest && !snapshot.rest.satisfied
        ? Math.round((snapshot.rest.clearAt.getTime() - now.getTime()) / 1000)
        : null,
      availableAt: snapshot.rest && !snapshot.rest.satisfied
        ? snapshot.rest.clearAt.toISOString()
        : null,
      canResumeWithinWindow: snapshot.options.canResumeWithinWindow,
      fullyRested: snapshot.options.fullyRested,

      onDutySecondsToday: Math.round(snapshot.onDutySecondsToday),
      cycleUsedSeconds: Math.round(snapshot.cycle.usedSeconds),
      cycleLimitSeconds: snapshot.cycle.limitSeconds,
      cycleRemainingSeconds: Math.round(snapshot.cycle.remainingSeconds),

      // With slow weekends most drivers restart without planning it, so
      // the signal dispatch actually needs is who DIDN'T.
      lastRestartAt: snapshot.restart.last?.completedAt.toISOString() ?? null,
      restartInProgressCompletesAt: snapshot.restart.inProgress?.completesAt.toISOString() ?? null,

      unverifiedOtrCount: unverifiedOtr.length,
      needsReviewCount: needsReview.length,
      paperLogDays: paperCount,
      paperLogLimit: PAPER_LOG_LIMIT,
      paperLogWarning: paperCount >= PAPER_LOG_WARN_AT,
      stale: snapshot.stale,
    };
  });

  return c.json({ drivers: result, config, generatedAt: now.toISOString() });
});

// ── GET /v1/hos/drivers/:id/shifts ───────────────────────────────────
//
// Drill-in: the shift list behind one driver's numbers, newest first,
// each with its correction trail so a dispatcher can see what a time
// originally was before someone changed it.
hos.get("/drivers/:id/shifts", async (c) => {
  const orgId = c.get("orgId");
  const driverId = Number(c.req.param("id"));
  if (!Number.isFinite(driverId)) return c.json({ error: "bad_request" }, 400);

  const now = new Date();
  const config = await getHosConfig(orgId);
  const days = Math.min(60, Math.max(1, Number(new URL(c.req.url).searchParams.get("days") ?? "14")));
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .or(`started_at.gte.${since},ended_at.is.null`)
    .order("started_at", { ascending: false });
  if (error) {
    console.error("[GET /v1/hos/drivers/:id/shifts] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const shifts = (data ?? []) as ShiftRow[];

  // Event trail, including voided rows — the whole point of keeping
  // them is being able to answer "what did the driver originally say".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: eventRows } = await (supabase as any)
    .from("hos_duty_events")
    .select("id, status, occurred_at, source, voided_at, corrects_event_id, note, created_by_name, created_at")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .gte("occurred_at", since)
    .order("created_at", { ascending: true });

  const snapshot = driverHosSnapshot(toIntervals(shifts), now, config.timeZone, config.cycle);

  return c.json({
    shifts: shifts.map(s => ({
      id: s.id,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      onDutySeconds: s.on_duty_seconds,
      classification: s.classification,
      classificationSource: s.classification_source,
      logMethod: s.log_method,
      logVerifiedBy: s.log_verified_by,
      logVerifiedAt: s.log_verified_at,
      autoClosed: s.auto_closed,
      needsReview: s.needs_review,
      reviewReason: s.review_reason,
      dayLabel: localDateString(new Date(s.started_at), config.timeZone),
    })),
    events: eventRows ?? [],
    cycle: {
      usedSeconds: Math.round(snapshot.cycle.usedSeconds),
      limitSeconds: snapshot.cycle.limitSeconds,
      remainingSeconds: Math.round(snapshot.cycle.remainingSeconds),
      windowStart: snapshot.cycle.windowStart.toISOString(),
      restartAt: snapshot.cycle.restartAt?.toISOString() ?? null,
    },
    config,
  });
});

// ── PATCH /v1/hos/shifts/:id ─────────────────────────────────────────
//
// Dispatch edits: classification, log verification, and times. Times go
// through the same correctShiftTimes() path the driver app uses, so the
// void/supersede trail is identical regardless of who made the change.
hos.patch("/shifts/:id", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const shiftId = c.req.param("id");
  // Resolved rather than taken from the request body: log_verified_by
  // is an accountability record, so the name has to come from the
  // authenticated identity, not from whatever the client claims.
  const userName = (await getUserDisplayName(userId)) ?? "Dispatch";

  let body: {
    classification?: Classification;
    logMethod?: LogMethod;
    verifyLog?: boolean;
    startedAt?: string;
    endedAt?: string;
    clearReview?: boolean;
    note?: string;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabase as any)
    .from("hos_shifts").select("*").eq("id", shiftId).eq("org_id", orgId).maybeSingle();
  const shift = existing as ShiftRow | null;
  if (!shift) return c.json({ error: "not_found" }, 404);

  const now = new Date();
  const errors: string[] = [];
  const patch: Record<string, unknown> = { updated_at: now.toISOString() };

  if (body.classification === "local" || body.classification === "otr") {
    patch.classification = body.classification;
    patch.classification_source = "dispatch";
    // Reclassifying local → OTR invalidates any prior verification:
    // nobody confirmed a log for a shift that wasn't OTR at the time.
    if (body.classification === "otr" && shift.classification !== "otr") {
      patch.log_verified_at = null;
      patch.log_verified_by = null;
    }
  }

  if (body.logMethod && ["none", "motive", "paper"].includes(body.logMethod)) {
    patch.log_method = body.logMethod;
  }

  // Verification stamps WHO confirmed it — the accountability trail is
  // the point, so this can't be set without an identified user.
  if (body.verifyLog === true) {
    patch.log_verified_at = now.toISOString();
    patch.log_verified_by = userName || userId || "Dispatch";
  } else if (body.verifyLog === false) {
    patch.log_verified_at = null;
    patch.log_verified_by = null;
  }

  if (body.clearReview === true) {
    patch.needs_review = false;
    patch.review_reason = null;
  }

  // Time edits: validate the resulting pair and guard overlap, same as
  // the driver path. Dispatch gets a wider reach but not a free hand.
  let startedAt: Date | undefined;
  let endedAt: Date | undefined;
  const parse = (raw: string, label: string): Date | undefined => {
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) { errors.push(`That ${label} isn't a valid time.`); return; }
    if (at.getTime() > now.getTime() + 60_000) { errors.push(`That ${label} is in the future.`); return; }
    return at;
  };
  if (body.startedAt) startedAt = parse(body.startedAt, "start time");
  if (body.endedAt)   endedAt   = parse(body.endedAt, "end time");

  if (errors.length === 0 && (startedAt || endedAt)) {
    const finalStart = startedAt ?? new Date(shift.started_at);
    const finalEnd = endedAt ?? (shift.ended_at ? new Date(shift.ended_at) : null);
    if (finalEnd && finalEnd.getTime() <= finalStart.getTime()) {
      errors.push("The end time has to be after the start time.");
    } else {
      const clash = await findOverlappingShift(shift.driver_id, finalStart, finalEnd, shiftId);
      if (clash) {
        // Org timezone, not the server's — Railway runs in UTC and a
        // clash reported six hours off is worse than no message.
        const { timeZone } = await getHosConfig(orgId);
        const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", {
          timeZone, weekday: "short", hour: "numeric", minute: "2-digit",
        });
        errors.push(`That overlaps another shift for this driver (${fmt(clash.started_at)} to ${clash.ended_at ? fmt(clash.ended_at) : "now"}).`);
      }
    }
  }

  if (errors.length > 0) {
    // Logged, not just returned: a bare "400" in the Railway log gives
    // nothing to debug from, and these are exactly the failures someone
    // reports after the fact.
    console.warn("[PATCH /v1/hos/shifts/:id] rejected", {
      shiftId, driverId: shift.driver_id, body, errors,
    });
    return c.json({ error: "validation_failed", errors }, 400);
  }

  if (startedAt || endedAt) {
    await correctShiftTimes({
      shiftId, orgId, startedAt, endedAt,
      note: body.note ?? `Times corrected by ${userName}.`,
      actor: { kind: "dispatch", userId, name: userName },
    });
  }

  if (Object.keys(patch).length > 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("hos_shifts").update(patch).eq("id", shiftId).eq("org_id", orgId);
    if (error) {
      console.error("[PATCH /v1/hos/shifts/:id] failed:", error);
      return c.json({ error: "update_failed", detail: error.message }, 500);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: fresh } = await (supabase as any)
    .from("hos_shifts").select("*").eq("id", shiftId).maybeSingle();
  return c.json({ shift: fresh });
});

// ── POST /v1/hos/shifts ──────────────────────────────────────────────
//
// Manually record a shift a driver never clocked. Leaving `endedAt` off
// opens the shift, for a driver who is working right now but forgot to
// clock in — the DB's exclusion constraint treats an open shift as
// running to infinity, so that will correctly refuse if anything is
// already recorded after the start.
hos.post("/shifts", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const userName = (await getUserDisplayName(userId)) ?? "Dispatch";

  let body: {
    driverId?: number;
    startedAt?: string;
    endedAt?: string | null;
    classification?: Classification;
    note?: string;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const errors: string[] = [];
  const driverId = Number(body.driverId);
  if (!Number.isFinite(driverId)) errors.push("Pick a driver.");

  const now = new Date();
  const startedAt = body.startedAt ? new Date(body.startedAt) : null;
  const endedAt = body.endedAt ? new Date(body.endedAt) : null;
  if (!startedAt || Number.isNaN(startedAt.getTime())) errors.push("Start time is required.");
  if (body.endedAt && (!endedAt || Number.isNaN(endedAt.getTime()))) errors.push("That end time isn't valid.");
  if (startedAt && startedAt.getTime() > now.getTime() + 60_000) errors.push("The start time is in the future.");
  if (endedAt && endedAt.getTime() > now.getTime() + 60_000) errors.push("The end time is in the future.");
  if (startedAt && endedAt && endedAt.getTime() <= startedAt.getTime()) {
    errors.push("The end time has to be after the start time.");
  }
  if (errors.length > 0) return c.json({ error: "validation_failed", errors }, 400);

  // Confirm the driver belongs to this org before writing anything
  // against their record.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: driver } = await (supabase as any)
    .from("drivers").select("id, hos_default_classification")
    .eq("id", driverId).eq("org_id", orgId).maybeSingle();
  if (!driver) return c.json({ error: "not_found", detail: "No such driver in this org." }, 404);

  const clash = await findOverlappingShift(driverId, startedAt!, endedAt);
  if (clash) {
    const { timeZone } = await getHosConfig(orgId);
    const fmt = (iso: string) => new Date(iso).toLocaleString("en-US", {
      timeZone, weekday: "short", hour: "numeric", minute: "2-digit",
    });
    return c.json({
      error: "validation_failed",
      errors: [`That overlaps a shift already recorded for this driver (${fmt(clash.started_at)} to ${clash.ended_at ? fmt(clash.ended_at) : "now"}).`],
    }, 400);
  }

  const classification: Classification =
    body.classification === "otr" ? "otr"
      : body.classification === "local" ? "local"
        : (driver as { hos_default_classification?: string }).hos_default_classification === "otr" ? "otr" : "local";

  // Events first, so the shift's FKs point at a real trail — a manually
  // created shift is still auditable as having come from dispatch.
  const note = body.note ?? `Shift added manually by ${userName}.`;
  const actor = { kind: "dispatch" as const, userId, name: userName };
  const mkEvent = async (status: "on_duty" | "off_duty", at: Date) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("hos_duty_events")
      .insert({
        org_id: orgId, driver_id: driverId, status,
        occurred_at: at.toISOString(), source: "dispatch_edit", note,
        created_by_user_id: actor.userId, created_by_name: actor.name,
      })
      .select("id").single();
    if (error) throw new Error(`hos_duty_events insert failed: ${error.message}`);
    return (data as { id: string }).id;
  };

  try {
    const startEventId = await mkEvent("on_duty", startedAt!);
    const endEventId = endedAt ? await mkEvent("off_duty", endedAt) : null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error } = await (supabase as any)
      .from("hos_shifts")
      .insert({
        org_id: orgId,
        driver_id: driverId,
        started_at: startedAt!.toISOString(),
        ended_at: endedAt?.toISOString() ?? null,
        start_event_id: startEventId,
        end_event_id: endEventId,
        on_duty_seconds: endedAt
          ? Math.round((endedAt.getTime() - startedAt!.getTime()) / 1000)
          : null,
        classification,
        classification_source: "dispatch",
      })
      .select("*").single();
    if (error) {
      // 23P01 is the exclusion-constraint violation — the DB catching an
      // overlap the check above raced past.
      const msg = (error as { code?: string }).code === "23P01"
        ? "That overlaps a shift already recorded for this driver."
        : error.message;
      return c.json({ error: "validation_failed", errors: [msg] }, 400);
    }
    return c.json({ shift: created });
  } catch (err) {
    console.error("[POST /v1/hos/shifts] failed:", err);
    return c.json({ error: "create_failed", detail: (err as Error).message }, 500);
  }
});

// ── DELETE /v1/hos/shifts/:id ────────────────────────────────────────
//
// Soft delete. For short-haul drivers these rows are the employer time
// record required by 49 CFR 395.1(e)(1)(v), which carries a 6-month
// retention duty — so a shift recorded wrongly is marked invisible to
// every read path rather than destroyed, and stays recoverable.
hos.delete("/shifts/:id", requireCapability("drivers.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const shiftId = c.req.param("id");
  const userName = (await getUserDisplayName(userId)) ?? "Dispatch";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabase as any)
    .from("hos_shifts").select("id, deleted_at")
    .eq("id", shiftId).eq("org_id", orgId).maybeSingle();
  if (!existing) return c.json({ error: "not_found" }, 404);
  if ((existing as { deleted_at: string | null }).deleted_at) {
    return c.json({ ok: true, alreadyDeleted: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("hos_shifts")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: userName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shiftId).eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/hos/shifts/:id] failed:", error);
    return c.json({ error: "delete_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

// ── GET /v1/hos/by-asset ─────────────────────────────────────────────
//
// Who is in each truck today, and what their hours look like. Feeds the
// driver chip in the calendar column header.
//
// Resolution waterfall, highest priority first:
//   1. asset_driver_day  — an explicit "Luis is in 0809 today" from
//                          dispatch. Always wins; a human said so.
//   2. calendar_active   — the load whose window contains now. On a
//                          relay overlap prefer the one ending soonest,
//                          matching the safety-alert resolver so the
//                          two surfaces never disagree about who's
//                          driving a given truck.
//   3. calendar_recent   — most recent load that ended before now.
//   4. driver_asset_prefs — the truck's standing primary driver.
hos.get("/by-asset", async (c) => {
  const orgId = c.get("orgId");
  const now = new Date();
  const config = await getHosConfig(orgId);
  const today = localDateString(now, config.timeZone);
  const url = new URL(c.req.url);
  const date = url.searchParams.get("date") || today;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const [assetsRes, eventsRes, prefsRes, driversRes] = await Promise.all([
    sb.from("assets").select("id, name, unit").eq("org_id", orgId)
      .eq("hidden", false).is("active_to", null),
    sb.from("events").select("id, asset_id, driver_id, driver_name, start, end")
      .eq("org_id", orgId).is("deleted_at", null)
      .lte("start", `${date}T23:59`).gte("end", `${date}T00:00`),
    sb.from("driver_asset_prefs").select("asset_id, driver_id").eq("org_id", orgId),
    sb.from("drivers").select("id, name, hos_enabled").eq("org_id", orgId).is("active_to", null),
  ]);

  // Overrides are read separately and tolerantly: if migration
  // 20260914 hasn't run, fall through to the waterfall rather than
  // failing the whole endpoint. Shipping a read of a column before its
  // migration already took this feature down once.
  let overrides: Array<{ asset_id: number; driver_id: number }> = [];
  {
    const { data, error } = await sb.from("asset_driver_day")
      .select("asset_id, driver_id").eq("org_id", orgId).eq("duty_date", date);
    if (error) console.warn("[hos/by-asset] override table unavailable:", error.message);
    else overrides = data ?? [];
  }

  const overrideByAsset = new Map(overrides.map(o => [o.asset_id, o.driver_id]));
  const prefByAsset = new Map(
    ((prefsRes.data ?? []) as Array<{ asset_id: number; driver_id: number | null }>)
      .filter(p => p.driver_id != null).map(p => [p.asset_id, p.driver_id as number]),
  );
  const driverName = new Map(
    ((driversRes.data ?? []) as Array<{ id: number; name: string | null }>)
      .map(d => [d.id, d.name ?? `Driver ${d.id}`]),
  );

  type Ev = { asset_id: number | null; driver_id: number | null; driver_name: string | null; start: string; end: string };
  const evByAsset = new Map<number, Ev[]>();
  for (const e of ((eventsRes.data ?? []) as Ev[])) {
    if (e.asset_id == null) continue;
    const l = evByAsset.get(e.asset_id) ?? []; l.push(e); evByAsset.set(e.asset_id, l);
  }

  // Naive local "YYYY-MM-DDTHH:mm", the shape events store — compared
  // lexicographically, as the rest of the codebase does.
  const nowNaive = new Date(now.toLocaleString("en-US", { timeZone: config.timeZone }));
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowLocal = `${nowNaive.getFullYear()}-${pad(nowNaive.getMonth() + 1)}-${pad(nowNaive.getDate())}T${pad(nowNaive.getHours())}:${pad(nowNaive.getMinutes())}`;

  const resolve = (assetId: number): { driverId: number | null; source: string } => {
    const ov = overrideByAsset.get(assetId);
    if (ov != null) return { driverId: ov, source: "override" };

    const candidates = evByAsset.get(assetId) ?? [];
    let best: Ev | null = null;
    for (const e of candidates) {
      if (e.start <= nowLocal && e.end >= nowLocal) {
        if (!best || e.end < best.end) best = e;   // relay: soonest-ending leg wins
      }
    }
    if (best?.driver_id != null) return { driverId: best.driver_id, source: "calendar_active" };

    best = null;
    for (const e of candidates) {
      if (e.end <= nowLocal) { if (!best || e.end > best.end) best = e; }
    }
    if (best?.driver_id != null) return { driverId: best.driver_id, source: "calendar_recent" };

    const pref = prefByAsset.get(assetId);
    if (pref != null) return { driverId: pref, source: "asset_default" };
    return { driverId: null, source: "none" };
  };

  // Hours for every driver that resolved to a truck — reuse the same
  // snapshot the board renders so the two can't disagree.
  const assets = (assetsRes.data ?? []) as Array<{ id: number; name: string; unit: string | null }>;
  const resolved = assets.map(a => ({ asset: a, ...resolve(a.id) }));
  const driverIds = Array.from(new Set(
    resolved.map(r => r.driverId).filter((x): x is number => x != null),
  ));

  const snapshots = new Map<number, ReturnType<typeof driverHosSnapshot>>();
  if (driverIds.length > 0) {
    const since = new Date(now.getTime() - 16 * 24 * 3600 * 1000).toISOString();
    const { data: shifts } = await sb.from("hos_shifts").select("*")
      .eq("org_id", orgId).in("driver_id", driverIds).is("deleted_at", null)
      .or(`started_at.gte.${since},ended_at.is.null`);
    const byDriver = new Map<number, ShiftRow[]>();
    for (const s of ((shifts ?? []) as ShiftRow[])) {
      const l = byDriver.get(s.driver_id) ?? []; l.push(s); byDriver.set(s.driver_id, l);
    }
    for (const id of driverIds) {
      snapshots.set(id, driverHosSnapshot(
        toIntervals(byDriver.get(id) ?? []), now, config.timeZone, config.cycle,
      ));
    }
  }

  const hosEnabled = new Set(
    ((driversRes.data ?? []) as Array<{ id: number; hos_enabled: boolean | null }>)
      .filter(d => d.hos_enabled !== false).map(d => d.id),
  );

  return c.json({
    date,
    config,
    assets: resolved.map(({ asset, driverId, source }) => {
      const snap = driverId != null ? snapshots.get(driverId) : null;
      return {
        assetId: asset.id,
        assetName: asset.name,
        driverId,
        driverName: driverId != null ? driverName.get(driverId) ?? null : null,
        source,
        hos: snap && driverId != null && hosEnabled.has(driverId) ? {
          status: snap.status,
          windowRemainingSeconds: snap.window ? Math.round(snap.window.remainingSeconds) : null,
          windowExpiresAt: snap.options.windowEndsAt?.toISOString() ?? null,
          availableAt: snap.rest && !snap.rest.satisfied ? snap.rest.clearAt.toISOString() : null,
          canResumeWithinWindow: snap.options.canResumeWithinWindow,
          fullyRested: snap.options.fullyRested,
          stale: snap.stale,
          onDutySecondsToday: Math.round(snap.onDutySecondsToday),
        } : null,
      };
    }),
  });
});

// ── GET /v1/hos/assets/:id/driver-options ────────────────────────────
//
// Drivers ordered by how closely they're tied to THIS truck, so the
// picker opens on the likely answer instead of an alphabetical fleet
// list. Ranked: the truck's standing primary, then its secondary, then
// whoever has actually driven it recently (by recency), then everyone
// else alphabetically.
hos.get("/assets/:id/driver-options", async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("id"));
  if (!Number.isFinite(assetId)) return c.json({ error: "bad_request" }, 400);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const lookback = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const since = `${lookback.getFullYear()}-${pad(lookback.getMonth() + 1)}-${pad(lookback.getDate())}T00:00`;

  const [driversRes, prefRes, recentRes] = await Promise.all([
    sb.from("drivers").select("id, name").eq("org_id", orgId).is("active_to", null).order("name"),
    sb.from("driver_asset_prefs").select("driver_id, secondary_driver_id")
      .eq("org_id", orgId).eq("asset_id", assetId).maybeSingle(),
    sb.from("events").select("driver_id, end")
      .eq("org_id", orgId).eq("asset_id", assetId).is("deleted_at", null)
      .gte("end", since).order("end", { ascending: false }).limit(200),
  ]);

  const primary = (prefRes.data as { driver_id: number | null } | null)?.driver_id ?? null;
  const secondary = (prefRes.data as { secondary_driver_id: number | null } | null)?.secondary_driver_id ?? null;

  // Most recent use of this truck per driver — the ordering signal.
  const lastUse = new Map<number, string>();
  for (const e of ((recentRes.data ?? []) as Array<{ driver_id: number | null; end: string }>)) {
    if (e.driver_id == null) continue;
    if (!lastUse.has(e.driver_id)) lastUse.set(e.driver_id, e.end);
  }

  const drivers = (driversRes.data ?? []) as Array<{ id: number; name: string | null }>;
  const ranked = drivers.map(d => {
    const rank =
      d.id === primary ? 0
      : d.id === secondary ? 1
      : lastUse.has(d.id) ? 2
      : 3;
    return {
      driverId: d.id,
      name: d.name ?? `Driver ${d.id}`,
      rank,
      lastUsedAt: lastUse.get(d.id) ?? null,
      relation: rank === 0 ? "primary" : rank === 1 ? "secondary" : rank === 2 ? "recent" : "other",
    };
  }).sort((a, b) =>
    a.rank - b.rank ||
    (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
    a.name.localeCompare(b.name),
  );

  return c.json({ drivers: ranked });
});

// ── PUT /v1/hos/assets/:id/driver ────────────────────────────────────
//
// Record who is actually in this truck today. driverId null clears the
// override and hands the truck back to the automatic waterfall.
hos.put("/assets/:id/driver", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const assetId = Number(c.req.param("id"));
  if (!Number.isFinite(assetId)) return c.json({ error: "bad_request" }, 400);

  let body: { driverId?: number | null; date?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const config = await getHosConfig(orgId);
  const date = body.date || localDateString(new Date(), config.timeZone);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  if (body.driverId == null) {
    const { error } = await sb.from("asset_driver_day").delete()
      .eq("org_id", orgId).eq("asset_id", assetId).eq("duty_date", date);
    if (error) return c.json({ error: "update_failed", detail: error.message }, 500);
    return c.json({ ok: true, cleared: true });
  }

  const { data: driver } = await sb.from("drivers")
    .select("id").eq("id", body.driverId).eq("org_id", orgId).maybeSingle();
  if (!driver) return c.json({ error: "not_found", detail: "No such driver in this org." }, 404);

  const userName = (await getUserDisplayName(userId)) ?? "Dispatch";
  const { error } = await sb.from("asset_driver_day")
    .upsert({
      org_id: orgId, asset_id: assetId, duty_date: date,
      driver_id: body.driverId, set_by: userName, set_at: new Date().toISOString(),
    }, { onConflict: "org_id,asset_id,duty_date" });
  if (error) {
    console.error("[PUT /v1/hos/assets/:id/driver] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

export default hos;
