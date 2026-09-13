/**
 * HOS (Hours of Service) math — pure functions over shift intervals.
 *
 * No DB access, no I/O, no clock reads: every entry point takes `now`
 * explicitly so the whole module is deterministic and testable. Run
 * `npx tsx src/lib/hos.verify.ts` from apps/api to exercise it.
 *
 * SCOPE: on-duty time only. We do not track driving time, so the
 * 11-hour driving limit and the 30-minute break (both driving-time
 * triggers) are NOT computed here — for ELD drivers those come from
 * Motive. On-duty is always >= driving, so any warning derived from
 * on-duty fires early rather than late, which is the safe direction.
 *
 * The four rules implemented:
 *   14-hour window  §395.3(a)(2) — wall-clock from clock-in. Breaks do
 *                   NOT extend it; that's the whole point of the rule.
 *   10-hour rest    §395.3(a)(1) — consecutive off-duty before restart.
 *   70/8 cycle      §395.3(b)(2) — rolling on-duty total. 60/7 for
 *                   carriers that don't run every day.
 *   34-hour restart §395.3(c)    — resets the cycle to zero.
 */

export const HOUR_SECONDS = 3600;
const hours = (n: number) => n * HOUR_SECONDS;

export const SHIFT_WINDOW_SECONDS   = hours(14);
export const REQUIRED_REST_SECONDS  = hours(10);
export const RESTART_SECONDS        = hours(34);

export type HosCycle = "70_8" | "60_7";

export function cycleLimitSeconds(cycle: HosCycle): number {
  return cycle === "60_7" ? hours(60) : hours(70);
}
export function cycleDays(cycle: HosCycle): number {
  return cycle === "60_7" ? 7 : 8;
}

export interface ShiftInterval {
  id:        string;
  startedAt: Date;
  /** null = still on duty. */
  endedAt:   Date | null;
}

// ── Timezone helpers ─────────────────────────────────────────────────
//
// No date library in this repo, so we lean on Intl, which is built into
// Node and correct across DST transitions. The trick throughout: format
// an instant into the target zone, re-read those wall-clock fields as
// if they were UTC, and the difference is that zone's offset at that
// instant.

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  // Some ICU versions render midnight as hour 24 under hour12:false.
  const hour = f.hour === 24 ? 0 : f.hour;
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second);
  return asIfUtc - instant.getTime();
}

/** The wall-clock calendar date in `timeZone`, as YYYY-MM-DD. */
export function localDateString(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is what we want to store/compare.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

/**
 * The UTC instant at which the given local wall-clock time occurs.
 * Applies the offset twice because the offset *at the guess* can differ
 * from the offset *at the answer* when the two straddle a DST change.
 */
function zonedWallTimeToInstant(
  y: number, m: number, d: number, hh: number, mm: number, timeZone: string,
): Date {
  const guessUtc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const firstPass = guessUtc - zoneOffsetMs(new Date(guessUtc), timeZone);
  const secondOffset = zoneOffsetMs(new Date(firstPass), timeZone);
  return new Date(guessUtc - secondOffset);
}

/** Midnight (local) that begins the calendar day containing `instant`. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const [y, m, d] = localDateString(instant, timeZone).split("-").map(Number);
  return zonedWallTimeToInstant(y, m, d, 0, 0, timeZone);
}

/** Midnight (local) `n` days before the day containing `instant`. */
export function startOfLocalDayOffset(instant: Date, timeZone: string, dayOffset: number): Date {
  const [y, m, d] = localDateString(instant, timeZone).split("-").map(Number);
  // Shift the calendar date in UTC space first — safe because we only
  // use it to derive Y/M/D, then re-resolve through the zone.
  const shifted = new Date(Date.UTC(y, m - 1, d + dayOffset));
  return zonedWallTimeToInstant(
    shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(),
    0, 0, timeZone,
  );
}

// ── Interval helpers ─────────────────────────────────────────────────

function overlapSeconds(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const start = Math.max(aStart, bStart);
  const end   = Math.min(aEnd, bEnd);
  return end > start ? (end - start) / 1000 : 0;
}

/** Effective end of a shift for math purposes: its close, or `now`. */
function shiftEnd(shift: ShiftInterval, now: Date): number {
  return (shift.endedAt ?? now).getTime();
}

function sortedByStart(shifts: ShiftInterval[]): ShiftInterval[] {
  return [...shifts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

// ── 14-hour window ───────────────────────────────────────────────────

export interface ShiftWindow {
  elapsedSeconds:   number;
  remainingSeconds: number;
  expiresAt:        Date;
  expired:          boolean;
}

/**
 * The 14-hour window runs on wall clock from clock-in. Time spent off
 * the truck mid-shift does not extend it, so this is pure subtraction —
 * deliberately not a sum of on-duty segments.
 */
export function shiftWindow(startedAt: Date, now: Date): ShiftWindow {
  const elapsedSeconds = Math.max(0, (now.getTime() - startedAt.getTime()) / 1000);
  const expiresAt = new Date(startedAt.getTime() + SHIFT_WINDOW_SECONDS * 1000);
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, SHIFT_WINDOW_SECONDS - elapsedSeconds),
    expiresAt,
    expired: elapsedSeconds >= SHIFT_WINDOW_SECONDS,
  };
}

// ── 10-hour rest ─────────────────────────────────────────────────────

export interface RestStatus {
  restSeconds: number;
  satisfied:   boolean;
  clearAt:     Date;
}

export function restStatus(lastShiftEndedAt: Date, now: Date): RestStatus {
  const restSeconds = Math.max(0, (now.getTime() - lastShiftEndedAt.getTime()) / 1000);
  return {
    restSeconds,
    satisfied: restSeconds >= REQUIRED_REST_SECONDS,
    clearAt:   new Date(lastShiftEndedAt.getTime() + REQUIRED_REST_SECONDS * 1000),
  };
}

// ── 34-hour restart ──────────────────────────────────────────────────

export interface Restart {
  /** When the driver went off duty and began accumulating the reset. */
  startedAt:   Date;
  /** startedAt + 34h — the moment the cycle actually zeroes. */
  completedAt: Date;
  /** Full length of the off-duty gap, which may exceed 34h. */
  gapSeconds:  number;
}

export interface RestartState {
  /** Most recent restart that has already completed at/before `now`. */
  last: Restart | null;
  /** An off-duty gap currently running that hasn't hit 34h yet. */
  inProgress: { startedAt: Date; completesAt: Date; secondsRemaining: number } | null;
}

/**
 * Walks the off-duty gaps between consecutive shifts (plus the trailing
 * gap up to `now`) looking for 34+ consecutive hours off.
 *
 * A restart completes at gapStart + 34h, NOT when the next shift begins.
 * The distinction is invisible to the cycle sum — there is by definition
 * zero on-duty time inside the gap — but it matters for telling a
 * dispatcher *when* someone's clock actually zeroed.
 */
export function findRestart(shifts: ShiftInterval[], now: Date): RestartState {
  const sorted = sortedByStart(shifts);
  let last: Restart | null = null;
  let inProgress: RestartState["inProgress"] = null;

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (current.endedAt == null) continue;       // open shift: no gap after it yet
    const gapStart = current.endedAt.getTime();
    // Gap runs to the next shift that actually starts after this one
    // ends, or to `now` if this is the last closed shift.
    const next = sorted.slice(i + 1).find(s => s.startedAt.getTime() >= gapStart);
    const gapEnd = next ? next.startedAt.getTime() : now.getTime();
    if (gapEnd <= gapStart) continue;

    const gapSeconds = (gapEnd - gapStart) / 1000;
    if (gapSeconds >= RESTART_SECONDS) {
      const completedAt = new Date(gapStart + RESTART_SECONDS * 1000);
      if (completedAt.getTime() <= now.getTime()) {
        // Keep the latest completed restart; sorted order means later
        // iterations legitimately overwrite earlier ones.
        last = { startedAt: new Date(gapStart), completedAt, gapSeconds };
      }
    } else if (!next) {
      // Trailing gap that hasn't matured into a restart yet.
      const completesAt = new Date(gapStart + RESTART_SECONDS * 1000);
      inProgress = {
        startedAt: new Date(gapStart),
        completesAt,
        secondsRemaining: (completesAt.getTime() - now.getTime()) / 1000,
      };
    }
  }
  return { last, inProgress };
}

// ── 70/8 rolling cycle ───────────────────────────────────────────────

export interface CycleStatus {
  usedSeconds:      number;
  remainingSeconds: number;
  limitSeconds:     number;
  /** Left edge of the counted window — the later of the N-day boundary
   *  and the last completed restart. */
  windowStart:      Date;
  restartAt:        Date | null;
}

/**
 * Sums on-duty time inside the rolling window, clipping each shift to
 * the window rather than counting it whole.
 *
 * Clipping is what makes restarts correct. A per-day rollup would
 * over-count: if a driver worked 12h on Friday and then took 34 off,
 * Friday's 12h sits on a calendar day inside the window but belongs to
 * the *pre-restart* cycle and must not count. Interval clipping drops
 * it automatically because the window starts after the restart.
 *
 * It also handles the far edge (a shift straddling the 8-day boundary
 * contributes only its in-window portion) and open shifts (counted
 * from start to `now`).
 */
export function cycleStatus(
  shifts: ShiftInterval[],
  now: Date,
  timeZone: string,
  cycle: HosCycle = "70_8",
): CycleStatus {
  const limitSeconds = cycleLimitSeconds(cycle);
  // "8 consecutive days" is today plus the previous 7.
  const dayWindowStart = startOfLocalDayOffset(now, timeZone, -(cycleDays(cycle) - 1));
  const { last: restart } = findRestart(shifts, now);

  const windowStartMs = Math.max(
    dayWindowStart.getTime(),
    restart ? restart.completedAt.getTime() : Number.NEGATIVE_INFINITY,
  );
  const nowMs = now.getTime();

  let usedSeconds = 0;
  for (const s of shifts) {
    usedSeconds += overlapSeconds(
      s.startedAt.getTime(), shiftEnd(s, now),
      windowStartMs, nowMs,
    );
  }

  return {
    usedSeconds,
    remainingSeconds: Math.max(0, limitSeconds - usedSeconds),
    limitSeconds,
    windowStart: new Date(windowStartMs),
    restartAt:   restart ? restart.completedAt : null,
  };
}

// ── Per-day allocation (display only) ────────────────────────────────

/**
 * Splits a shift into per-calendar-day on-duty seconds in the given
 * zone. Used for "hours today" on the dispatch board and for weekly
 * reporting — NOT load-bearing for the cycle math, which clips
 * intervals directly.
 *
 * DST-safe: allocations are real elapsed seconds, so a shift spanning
 * spring-forward reports the 23-hour day honestly instead of assuming
 * every day is 86400s.
 */
export function splitAcrossLocalDays(
  startedAt: Date, endedAt: Date, timeZone: string,
): Array<{ date: string; seconds: number }> {
  if (endedAt.getTime() <= startedAt.getTime()) return [];
  const out: Array<{ date: string; seconds: number }> = [];
  let cursor = startedAt;

  // Bounded to keep a bad timestamp from spinning forever; a single
  // shift spanning 40 days is data corruption, not a real shift.
  for (let guard = 0; guard < 40; guard++) {
    const date = localDateString(cursor, timeZone);
    const nextMidnight = startOfLocalDayOffset(cursor, timeZone, 1);
    const segmentEnd = new Date(Math.min(nextMidnight.getTime(), endedAt.getTime()));
    out.push({ date, seconds: (segmentEnd.getTime() - cursor.getTime()) / 1000 });
    if (segmentEnd.getTime() >= endedAt.getTime()) break;
    cursor = segmentEnd;
  }
  return out;
}

// ── Composite snapshot ───────────────────────────────────────────────

export interface HosSnapshot {
  status: "on_duty" | "off_duty";
  /** Open shift's 14-hour window. Present only while on duty. */
  window: ShiftWindow | null;
  /** Rest accrued since the last close. Present only while off duty. */
  rest: RestStatus | null;
  cycle: CycleStatus;
  restart: RestartState;
  /**
   * On duty past the 14-hour window — almost always a forgotten
   * clock-out rather than a real 19-hour shift. Drives the driver-app
   * correction prompt and the dispatch review worklist.
   */
  stale: boolean;
  currentShiftId: string | null;
  onDutySecondsToday: number;
}

export function driverHosSnapshot(
  shifts: ShiftInterval[],
  now: Date,
  timeZone: string,
  cycle: HosCycle = "70_8",
): HosSnapshot {
  const sorted = sortedByStart(shifts);
  const open = sorted.find(s => s.endedAt == null) ?? null;
  const lastClosed = [...sorted].reverse().find(s => s.endedAt != null) ?? null;

  const window = open ? shiftWindow(open.startedAt, now) : null;
  const rest = !open && lastClosed?.endedAt ? restStatus(lastClosed.endedAt, now) : null;

  const today = localDateString(now, timeZone);
  let onDutySecondsToday = 0;
  for (const s of sorted) {
    const end = new Date(shiftEnd(s, now));
    for (const seg of splitAcrossLocalDays(s.startedAt, end, timeZone)) {
      if (seg.date === today) onDutySecondsToday += seg.seconds;
    }
  }

  return {
    status: open ? "on_duty" : "off_duty",
    window,
    rest,
    cycle:   cycleStatus(sorted, now, timeZone, cycle),
    restart: findRestart(sorted, now),
    stale:   window?.expired ?? false,
    currentShiftId: open?.id ?? null,
    onDutySecondsToday,
  };
}
