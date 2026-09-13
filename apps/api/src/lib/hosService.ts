/**
 * HOS persistence + orchestration. All DB access for duty tracking
 * lives here; the arithmetic lives in lib/hos.ts (pure, tested).
 *
 * Tables (migration 20260913_hos_duty_tracking.sql) aren't in the
 * generated Database types yet, hence the `(supabase as any)` casts —
 * same pattern the inspection_reports routes use.
 */
import { supabase } from "./supabase.js";
import {
  driverHosSnapshot, SHIFT_WINDOW_SECONDS,
  type HosSnapshot, type HosCycle, type ShiftInterval,
} from "./hos.js";

/** How far back to pull shifts. The 8-day cycle needs 8; restart
 *  detection needs to see the gap *before* the window opens, so pad. */
const LOOKBACK_DAYS = 16;

/** A second clock-in inside this window is a double-tap, not a new
 *  shift — return the existing one instead of erroring at the driver. */
const DOUBLE_TAP_GRACE_SECONDS = 30 * 60;

export type DutySource = "driver_app" | "dispatch_edit" | "auto_close" | "motive";
export type Classification = "local" | "otr";
export type LogMethod = "none" | "motive" | "paper";

export interface ShiftRow {
  id: string;
  org_id: string;
  driver_id: number;
  started_at: string;
  ended_at: string | null;
  on_duty_seconds: number | null;
  classification: Classification;
  classification_source: string;
  log_method: LogMethod;
  log_verified_by: string | null;
  log_verified_at: string | null;
  auto_closed: boolean;
  needs_review: boolean;
  review_reason: string | null;
}

export interface HosConfig {
  cycle: HosCycle;
  timeZone: string;
}

export interface Actor {
  kind: "driver" | "dispatch";
  driverId?: number;
  userId?: string;
  name?: string;
}

// ── Config ───────────────────────────────────────────────────────────

/** Falls back to Denver because that's the operating zone; a wrong
 *  guess here shifts which calendar day a shift lands on, so orgs
 *  should always have org_settings.timezone set. */
export async function getHosConfig(orgId: string): Promise<HosConfig> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("org_settings")
    .select("timezone, hos_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const raw = (data ?? {}) as { timezone?: string | null; hos_settings?: { cycle?: string } | null };
  const cycle: HosCycle = raw.hos_settings?.cycle === "60_7" ? "60_7" : "70_8";
  return { cycle, timeZone: raw.timezone || "America/Denver" };
}

// ── Reads ────────────────────────────────────────────────────────────

export async function loadRecentShifts(driverId: number, now: Date): Promise<ShiftRow[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();
  // Open shifts can predate the lookback (that's exactly the forgotten
  // clock-out case), so pull them regardless of start time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("driver_id", driverId)
    .or(`started_at.gte.${since},ended_at.is.null`)
    .order("started_at", { ascending: true });
  if (error) throw new Error(`hos_shifts read failed: ${error.message}`);
  return (data ?? []) as ShiftRow[];
}

export function toIntervals(rows: ShiftRow[]): ShiftInterval[] {
  return rows.map(r => ({
    id: r.id,
    startedAt: new Date(r.started_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : null,
  }));
}

/**
 * A shift for this driver that would overlap [start, end), or null.
 *
 * The partial unique index only prevents two OPEN shifts. Nothing stops
 * a backdated clock-in or a corrected start from being dragged back
 * across a shift that already exists, and overlapping shifts are not a
 * cosmetic problem: cycleStatus sums each shift's overlap with the
 * rolling window, so the same wall-clock hour gets counted twice and a
 * driver's 70/8 total silently inflates.
 *
 * `end` of null means "still open", which overlaps everything after
 * its start.
 */
export async function findOverlappingShift(
  driverId: number,
  start: Date,
  end: Date | null,
  excludeShiftId?: string,
): Promise<ShiftRow | null> {
  // Look slightly wider than the edit window so a long shift starting
  // just outside it is still caught.
  const since = new Date(start.getTime() - 3 * 24 * 3600 * 1000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("driver_id", driverId)
    .or(`started_at.gte.${since},ended_at.is.null`);

  const startMs = start.getTime();
  const endMs   = end ? end.getTime() : Number.POSITIVE_INFINITY;
  for (const row of ((data ?? []) as ShiftRow[])) {
    if (excludeShiftId && row.id === excludeShiftId) continue;
    const otherStart = new Date(row.started_at).getTime();
    const otherEnd   = row.ended_at ? new Date(row.ended_at).getTime() : Number.POSITIVE_INFINITY;
    // Touching end-to-end is fine; strictly crossing is not.
    if (otherStart < endMs && startMs < otherEnd) return row;
  }
  return null;
}

export interface DriverHosView {
  snapshot: HosSnapshot;
  openShift: ShiftRow | null;
  lastClosedShift: ShiftRow | null;
  config: HosConfig;
}

export async function getDriverHosView(
  driverId: number, orgId: string, now: Date,
): Promise<DriverHosView> {
  const [config, rows] = await Promise.all([
    getHosConfig(orgId),
    loadRecentShifts(driverId, now),
  ]);
  const snapshot = driverHosSnapshot(toIntervals(rows), now, config.timeZone, config.cycle);
  const openShift = rows.find(r => r.ended_at == null) ?? null;
  const lastClosedShift = [...rows].reverse().find(r => r.ended_at != null) ?? null;
  return { snapshot, openShift, lastClosedShift, config };
}

// ── Writes ───────────────────────────────────────────────────────────

interface InsertEventArgs {
  orgId: string;
  driverId: number;
  status: "on_duty" | "off_duty";
  occurredAt: Date;
  source: DutySource;
  lat?: number | null;
  lon?: number | null;
  note?: string | null;
  correctsEventId?: string | null;
  actor: Actor;
}

async function insertDutyEvent(args: InsertEventArgs): Promise<{ id: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("hos_duty_events")
    .insert({
      org_id:      args.orgId,
      driver_id:   args.driverId,
      status:      args.status,
      occurred_at: args.occurredAt.toISOString(),
      source:      args.source,
      location_lat: args.lat ?? null,
      location_lon: args.lon ?? null,
      note:         args.note ?? null,
      corrects_event_id: args.correctsEventId ?? null,
      created_by_driver_id: args.actor.kind === "driver" ? args.actor.driverId ?? null : null,
      created_by_user_id:   args.actor.userId ?? null,
      created_by_name:      args.actor.name ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`hos_duty_events insert failed: ${error.message}`);
  return data as { id: string };
}

/** Marks an event superseded. Never mutates occurred_at or status —
 *  the original stays readable so the correction is auditable. */
async function voidEvent(eventId: string, replacedBy: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabase as any)
    .from("hos_duty_events")
    .update({ voided_at: new Date().toISOString(), voided_by_event_id: replacedBy })
    .eq("id", eventId);
}

function reviewFor(startedAt: Date, endedAt: Date, autoClosed: boolean): {
  needs_review: boolean; review_reason: string | null;
} {
  const seconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (autoClosed)                    return { needs_review: true, review_reason: "auto_closed_estimate" };
  if (seconds > SHIFT_WINDOW_SECONDS) return { needs_review: true, review_reason: "exceeded_14h_window" };
  if (seconds < 300)                 return { needs_review: true, review_reason: "implausibly_short" };
  return { needs_review: false, review_reason: null };
}

async function closeShift(
  shift: ShiftRow, endedAt: Date, endEventId: string, autoClosed: boolean,
): Promise<void> {
  const startedAt = new Date(shift.started_at);
  const review = reviewFor(startedAt, endedAt, autoClosed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("hos_shifts")
    .update({
      ended_at:        endedAt.toISOString(),
      end_event_id:    endEventId,
      on_duty_seconds: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
      auto_closed:     autoClosed,
      updated_at:      new Date().toISOString(),
      ...review,
    })
    .eq("id", shift.id);
  if (error) throw new Error(`hos_shifts close failed: ${error.message}`);
}

export interface ClockInResult {
  shift: ShiftRow;
  /** True when this call matched an existing open shift instead of
   *  opening a new one (double-tap). */
  alreadyOpen: boolean;
  /** Set when a stale shift was closed to make room for this one —
   *  the driver app turns this into the "when did you finish?" prompt. */
  autoClosedShiftId: string | null;
}

/**
 * Opens a shift.
 *
 * A driver clocking IN cannot also be on duty, so any pre-existing
 * open shift is either a double-tap (return it) or a forgotten
 * clock-out (close it at a defensible estimate and flag it, rather
 * than blocking the driver from starting their day — a blocked
 * clock-in just means we lose today's data too).
 */
export async function clockIn(opts: {
  driverId: number;
  orgId: string;
  now: Date;
  /** Backdated shift start, for a driver who began work before they got
   *  to their phone. Defaults to `now`. Kept separate from `now` on
   *  purpose: staleness checks below must reason about real elapsed
   *  time, not the time the driver claims they started. */
  startedAt?: Date;
  lat?: number | null;
  lon?: number | null;
  classification: Classification;
  classificationSource?: string;
  actor: Actor;
}): Promise<ClockInResult> {
  const { driverId, orgId, now } = opts;
  const startedAt = opts.startedAt ?? now;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: openRows } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("driver_id", driverId)
    .is("ended_at", null)
    .limit(1);
  const open = ((openRows ?? []) as ShiftRow[])[0] ?? null;

  let autoClosedShiftId: string | null = null;
  if (open) {
    const openStart = new Date(open.started_at);
    const ageSeconds = (now.getTime() - openStart.getTime()) / 1000;
    if (ageSeconds <= DOUBLE_TAP_GRACE_SECONDS) {
      return { shift: open, alreadyOpen: true, autoClosedShiftId: null };
    }
    // Estimate the close at the end of the 14-hour window, but never
    // in the future — if they forgot to clock out three hours ago,
    // start+14h hasn't happened yet and would be a nonsense timestamp.
    const estimatedEnd = new Date(Math.min(
      openStart.getTime() + SHIFT_WINDOW_SECONDS * 1000,
      now.getTime(),
    ));
    const closeEvent = await insertDutyEvent({
      orgId, driverId, status: "off_duty", occurredAt: estimatedEnd,
      source: "auto_close",
      note: "Auto-closed: driver clocked in with a shift still open. End time is an estimate.",
      actor: { kind: "driver", driverId },
    });
    await closeShift(open, estimatedEnd, closeEvent.id, true);
    autoClosedShiftId = open.id;
  }

  const startEvent = await insertDutyEvent({
    orgId, driverId, status: "on_duty", occurredAt: startedAt,
    source: opts.actor.kind === "dispatch" ? "dispatch_edit" : "driver_app",
    lat: opts.lat, lon: opts.lon, actor: opts.actor,
    note: opts.startedAt ? "Start time set by the driver at clock-in." : null,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: created, error } = await (supabase as any)
    .from("hos_shifts")
    .insert({
      org_id: orgId,
      driver_id: driverId,
      started_at: startedAt.toISOString(),
      start_event_id: startEvent.id,
      classification: opts.classification,
      classification_source: opts.classificationSource ?? "default",
    })
    .select("*")
    .single();

  if (error) {
    // Almost certainly hos_shifts_one_open_per_driver losing a race with
    // a concurrent tap. Roll back the orphan event so it can't be read
    // as a real clock-in with no shift behind it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("hos_duty_events").delete().eq("id", startEvent.id);
    throw new Error(`hos_shifts insert failed: ${error.message}`);
  }

  return { shift: created as ShiftRow, alreadyOpen: false, autoClosedShiftId };
}

export async function clockOut(opts: {
  driverId: number;
  orgId: string;
  now: Date;
  /** Backdated shift end, for a driver who finished before they got to
   *  their phone. Defaults to `now`. Caller validates it sits after the
   *  shift start and isn't in the future. */
  endedAt?: Date;
  lat?: number | null;
  lon?: number | null;
  actor: Actor;
}): Promise<ShiftRow | null> {
  const { driverId, orgId, now } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: openRows } = await (supabase as any)
    .from("hos_shifts")
    .select("*")
    .eq("driver_id", driverId)
    .is("ended_at", null)
    .limit(1);
  const open = ((openRows ?? []) as ShiftRow[])[0] ?? null;
  if (!open) return null;

  const endedAt = opts.endedAt ?? now;
  const endEvent = await insertDutyEvent({
    orgId, driverId, status: "off_duty", occurredAt: endedAt,
    source: opts.actor.kind === "dispatch" ? "dispatch_edit" : "driver_app",
    lat: opts.lat, lon: opts.lon, actor: opts.actor,
    note: opts.endedAt ? "End time set by the driver at clock-out." : null,
  });
  await closeShift(open, endedAt, endEvent.id, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: fresh } = await (supabase as any)
    .from("hos_shifts").select("*").eq("id", open.id).maybeSingle();
  return (fresh ?? open) as ShiftRow;
}

/**
 * Rewrites a shift's start and/or end. Used by both the driver's
 * "when did you actually finish?" prompt and dispatch's edit workflow.
 *
 * The superseded event is voided, not deleted, and the replacement
 * points back at it via corrects_event_id.
 */
export async function correctShiftTimes(opts: {
  shiftId: string;
  orgId: string;
  startedAt?: Date;
  endedAt?: Date;
  note?: string;
  actor: Actor;
}): Promise<ShiftRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (supabase as any)
    .from("hos_shifts").select("*").eq("id", opts.shiftId).eq("org_id", opts.orgId).maybeSingle();
  const shift = row as (ShiftRow & { start_event_id: string; end_event_id: string | null }) | null;
  if (!shift) throw new Error("shift_not_found");

  const source: DutySource = opts.actor.kind === "dispatch" ? "dispatch_edit" : "driver_app";
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (opts.startedAt) {
    const ev = await insertDutyEvent({
      orgId: opts.orgId, driverId: shift.driver_id, status: "on_duty",
      occurredAt: opts.startedAt, source, note: opts.note ?? null,
      correctsEventId: shift.start_event_id, actor: opts.actor,
    });
    await voidEvent(shift.start_event_id, ev.id);
    patch.started_at = opts.startedAt.toISOString();
    patch.start_event_id = ev.id;
  }

  if (opts.endedAt) {
    const ev = await insertDutyEvent({
      orgId: opts.orgId, driverId: shift.driver_id, status: "off_duty",
      occurredAt: opts.endedAt, source, note: opts.note ?? null,
      correctsEventId: shift.end_event_id, actor: opts.actor,
    });
    if (shift.end_event_id) await voidEvent(shift.end_event_id, ev.id);
    patch.ended_at = opts.endedAt.toISOString();
    patch.end_event_id = ev.id;
  }

  const finalStart = opts.startedAt ?? new Date(shift.started_at);
  const finalEnd   = opts.endedAt ?? (shift.ended_at ? new Date(shift.ended_at) : null);
  if (finalEnd) {
    patch.on_duty_seconds = Math.max(0, Math.round((finalEnd.getTime() - finalStart.getTime()) / 1000));
    // A human supplied the time, so drop the auto-close estimate flag
    // and re-derive review purely from the corrected duration.
    patch.auto_closed = false;
    Object.assign(patch, reviewFor(finalStart, finalEnd, false));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error } = await (supabase as any)
    .from("hos_shifts").update(patch).eq("id", opts.shiftId).select("*").single();
  if (error) throw new Error(`hos_shifts correction failed: ${error.message}`);
  return updated as ShiftRow;
}
