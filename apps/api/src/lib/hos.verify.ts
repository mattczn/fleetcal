/**
 * Verification scenarios for lib/hos.ts.
 *
 *   npx tsx src/lib/hos.verify.ts     (from apps/api)
 *
 * There's no test runner in this package yet, so this is a plain script
 * that asserts and prints. If a real runner lands later, the scenarios
 * below port to it verbatim.
 *
 * Every case here is one I actually expected to get wrong: DST, the
 * restart-clears-the-day trap, shifts straddling the window edge, and
 * the forgotten-clock-out case that produces a 40-hour shift.
 */
import {
  shiftWindow, restStatus, findRestart, cycleStatus,
  splitAcrossLocalDays, driverHosSnapshot, localDateString,
  findDutyPeriodStart, dutyOptions,
  type ShiftInterval,
} from "./hos.js";

const TZ = "America/Denver";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok   ${label}`); }
  else         { failed++; console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`); }
}

function near(label: string, actual: number, expected: number, tolerance = 1): void {
  if (Math.abs(actual - expected) <= tolerance) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n         expected ~${expected}\n         actual    ${actual}`); }
}

function section(name: string): void { console.log(`\n${name}`); }

const t = (iso: string) => new Date(iso);
let seq = 0;
const shift = (start: string, end: string | null): ShiftInterval => ({
  id: `s${++seq}`, startedAt: t(start), endedAt: end ? t(end) : null,
});
const H = 3600;

// ── 14-hour window ───────────────────────────────────────────────────
section("14-hour window");
{
  // Denver is UTC-6 in September (MDT). 06:00 local = 12:00Z.
  const w = shiftWindow(t("2026-09-10T12:00:00Z"), t("2026-09-10T20:00:00Z"));
  near("8h in → 8h elapsed", w.elapsedSeconds, 8 * H);
  near("8h in → 6h remaining", w.remainingSeconds, 6 * H);
  check("8h in → not expired", w.expired, false);
  check("expires 14h after clock-in", w.expiresAt.toISOString(), "2026-09-11T02:00:00.000Z");
}
{
  const w = shiftWindow(t("2026-09-10T12:00:00Z"), t("2026-09-11T03:00:00Z"));
  check("15h in → expired", w.expired, true);
  near("expired → remaining clamps at 0", w.remainingSeconds, 0);
}
{
  // A mid-shift break must NOT push the window out — that's the rule.
  const w = shiftWindow(t("2026-09-10T12:00:00Z"), t("2026-09-11T01:00:00Z"));
  near("window is wall-clock, not summed on-duty", w.elapsedSeconds, 13 * H);
}

// ── 10-hour rest ─────────────────────────────────────────────────────
section("10-hour rest");
{
  const r = restStatus(t("2026-09-10T22:00:00Z"), t("2026-09-11T02:00:00Z"));
  check("4h off → not satisfied", r.satisfied, false);
  check("clear time is end + 10h", r.clearAt.toISOString(), "2026-09-11T08:00:00.000Z");
}
{
  const r = restStatus(t("2026-09-10T22:00:00Z"), t("2026-09-11T09:00:00Z"));
  check("11h off → satisfied", r.satisfied, true);
}

// ── 34-hour restart ──────────────────────────────────────────────────
section("34-hour restart");
{
  // Fri 06:00–18:00, back on Sun 04:00 = 34h gap exactly.
  const shifts = [
    shift("2026-09-04T12:00:00Z", "2026-09-05T00:00:00Z"),
    shift("2026-09-06T10:00:00Z", "2026-09-06T22:00:00Z"),
  ];
  const r = findRestart(shifts, t("2026-09-07T00:00:00Z"));
  check("34h gap detected", r.last !== null, true);
  check("restart completes at gap start + 34h",
    r.last?.completedAt.toISOString(), "2026-09-06T10:00:00.000Z");
}
{
  // 30h gap — close, but no reset.
  const shifts = [
    shift("2026-09-04T12:00:00Z", "2026-09-05T00:00:00Z"),
    shift("2026-09-06T06:00:00Z", "2026-09-06T18:00:00Z"),
  ];
  const r = findRestart(shifts, t("2026-09-07T00:00:00Z"));
  check("30h gap is NOT a restart", r.last, null);
}
{
  // Trailing gap still accruing — the "will reset at" case for the UI.
  const shifts = [shift("2026-09-10T12:00:00Z", "2026-09-11T00:00:00Z")];
  const r = findRestart(shifts, t("2026-09-11T20:00:00Z"));
  check("20h off → no completed restart", r.last, null);
  check("20h off → restart in progress", r.inProgress !== null, true);
  check("in-progress completes at +34h",
    r.inProgress?.completesAt.toISOString(), "2026-09-12T10:00:00.000Z");
  near("14h remaining to reset", r.inProgress?.secondsRemaining ?? -1, 14 * H);
}

// ── 70/8 rolling cycle ───────────────────────────────────────────────
section("70/8 cycle");
{
  // Five consecutive 10h days, no gap long enough to reset.
  const shifts = [
    shift("2026-09-07T12:00:00Z", "2026-09-07T22:00:00Z"),
    shift("2026-09-08T12:00:00Z", "2026-09-08T22:00:00Z"),
    shift("2026-09-09T12:00:00Z", "2026-09-09T22:00:00Z"),
    shift("2026-09-10T12:00:00Z", "2026-09-10T22:00:00Z"),
    shift("2026-09-11T12:00:00Z", "2026-09-11T22:00:00Z"),
  ];
  const c = cycleStatus(shifts, t("2026-09-11T23:00:00Z"), TZ);
  near("5 x 10h → 50h used", c.usedSeconds, 50 * H);
  near("5 x 10h → 20h remaining", c.remainingSeconds, 20 * H);
}
{
  // THE TRAP: 12h worked Friday, then a 34h restart. Friday's calendar
  // day is still inside the 8-day window, but those hours belong to the
  // pre-restart cycle. A naive per-day sum counts them; clipping must not.
  const shifts = [
    shift("2026-09-04T12:00:00Z", "2026-09-05T00:00:00Z"),  // Fri 12h
    shift("2026-09-06T12:00:00Z", "2026-09-06T20:00:00Z"),  // Sun 8h, post-restart
  ];
  const c = cycleStatus(shifts, t("2026-09-06T21:00:00Z"), TZ);
  near("pre-restart hours excluded → only 8h counts", c.usedSeconds, 8 * H);
  check("restart recorded on the cycle", c.restartAt?.toISOString(), "2026-09-06T10:00:00.000Z");
}
{
  // A shift older than the window drops out entirely.
  const shifts = [
    shift("2026-08-20T12:00:00Z", "2026-08-20T22:00:00Z"),  // way outside
    shift("2026-09-11T12:00:00Z", "2026-09-11T20:00:00Z"),  // 8h today
  ];
  const c = cycleStatus(shifts, t("2026-09-11T21:00:00Z"), TZ);
  near("out-of-window shift ignored", c.usedSeconds, 8 * H);
}
{
  // Open shift contributes start→now, not zero.
  const shifts = [shift("2026-09-11T12:00:00Z", null)];
  const c = cycleStatus(shifts, t("2026-09-11T18:00:00Z"), TZ);
  near("open shift counts up to now", c.usedSeconds, 6 * H);
}
{
  const shifts = [
    shift("2026-09-07T12:00:00Z", "2026-09-07T22:00:00Z"),
    shift("2026-09-08T12:00:00Z", "2026-09-08T22:00:00Z"),
  ];
  const c = cycleStatus(shifts, t("2026-09-08T23:00:00Z"), TZ, "60_7");
  near("60/7 limit applies when selected", c.limitSeconds, 60 * H);
  near("60/7 remaining", c.remainingSeconds, 40 * H);
}

// ── Per-day split ────────────────────────────────────────────────────
section("per-day split");
{
  // 18:00 Mon → 04:00 Tue local. Denver is UTC-6 in September.
  const parts = splitAcrossLocalDays(
    t("2026-09-07T00:00:00Z"),   // Sun 18:00 MDT
    t("2026-09-07T10:00:00Z"),   // Mon 04:00 MDT
    TZ,
  );
  check("splits across midnight into 2 days", parts.length, 2);
  check("first segment is the earlier local date", parts[0].date, "2026-09-06");
  near("6h before midnight", parts[0].seconds, 6 * H);
  near("4h after midnight", parts[1].seconds, 4 * H);
}
{
  // Spring-forward: 2026-03-08, Denver skips 02:00→03:00.
  // 00:00 → 06:00 local is only 5 REAL hours that morning.
  const parts = splitAcrossLocalDays(
    t("2026-03-08T07:00:00Z"),   // 00:00 MST
    t("2026-03-08T12:00:00Z"),   // 06:00 MDT
    TZ,
  );
  check("DST day stays a single date", parts.length, 1);
  near("spring-forward reports 5 real hours, not 6", parts[0].seconds, 5 * H);
}

// ── Composite snapshot ───────────────────────────────────────────────
section("snapshot");
{
  const shifts = [shift("2026-09-11T12:00:00Z", null)];
  const s = driverHosSnapshot(shifts, t("2026-09-11T20:00:00Z"), TZ);
  check("open shift → on duty", s.status, "on_duty");
  check("open shift → not stale at 8h", s.stale, false);
  near("window remaining", s.window?.remainingSeconds ?? -1, 6 * H);
  check("no rest block while on duty", s.rest, null);
}
{
  // Forgotten clock-out: 40 hours and counting.
  const shifts = [shift("2026-09-10T12:00:00Z", null)];
  const s = driverHosSnapshot(shifts, t("2026-09-12T04:00:00Z"), TZ);
  check("40h open shift flags stale", s.stale, true);
  check("stale shift still reports on duty", s.status, "on_duty");
}
{
  const shifts = [shift("2026-09-10T12:00:00Z", "2026-09-10T22:00:00Z")];
  const s = driverHosSnapshot(shifts, t("2026-09-11T04:00:00Z"), TZ);
  check("closed shift → off duty", s.status, "off_duty");
  check("off duty → rest block present", s.rest !== null, true);
  check("6h rest → not yet clear", s.rest?.satisfied, false);
}
{
  // Hours-today must count only the portion falling on today's local date.
  const shifts = [shift("2026-09-11T00:00:00Z", "2026-09-11T10:00:00Z")]; // 18:00 Thu → 04:00 Fri
  const s = driverHosSnapshot(shifts, t("2026-09-11T15:00:00Z"), TZ);     // Fri 09:00 MDT
  near("only the post-midnight portion counts toward today", s.onDutySecondsToday, 4 * H);
}

// ── Duty period (the 14h window across split shifts) ─────────────────
section("duty period");
{
  // Out at 3pm, back in at 4pm. A 1-hour break does NOT reset the
  // window — it still runs from the 6am start, ending 8pm.
  const shifts = [
    shift("2026-09-11T12:00:00Z", "2026-09-11T21:00:00Z"), // 06:00–15:00 MDT
    shift("2026-09-11T22:00:00Z", null),                   // back on at 16:00
  ];
  const now = t("2026-09-11T23:00:00Z");                   // 17:00 MDT
  const start = findDutyPeriodStart(shifts, now);
  check("short break does not open a new window",
    start?.toISOString(), "2026-09-11T12:00:00.000Z");

  const s = driverHosSnapshot(shifts, now, TZ);
  near("window measured from the 6am start, not the 4pm one",
    s.window?.elapsedSeconds ?? -1, 11 * H);
  near("3h left, not 13h", s.window?.remainingSeconds ?? -1, 3 * H);
  check("second shift is only 1h old, so not stale", s.stale, false);
}
{
  // 11-hour break DOES reset. New window opens at the later shift.
  const shifts = [
    shift("2026-09-10T12:00:00Z", "2026-09-10T21:00:00Z"),
    shift("2026-09-11T08:00:00Z", null),                   // 11h later
  ];
  const start = findDutyPeriodStart(shifts, t("2026-09-11T10:00:00Z"));
  check("qualifying break opens a new window",
    start?.toISOString(), "2026-09-11T08:00:00.000Z");
}
{
  // Off duty 12 hours with nothing open — no window running at all.
  const shifts = [shift("2026-09-10T12:00:00Z", "2026-09-10T21:00:00Z")];
  const now = t("2026-09-11T09:00:00Z");
  check("fully rested → no active window", findDutyPeriodStart(shifts, now), null);
  const o = dutyOptions(shifts, now);
  check("fully rested flag", o.fullyRested, true);
  check("no window to resume into", o.canResumeWithinWindow, false);
}
{
  // THE CASE THIS WAS BUILT FOR: off duty at 3pm, window open till 8pm.
  // Driver has two real options and must be told about both.
  const shifts = [shift("2026-09-11T12:00:00Z", "2026-09-11T21:00:00Z")];
  const now = t("2026-09-11T22:00:00Z");                   // 16:00 MDT, 1h off
  const o = dutyOptions(shifts, now);
  check("can still resume inside the window", o.canResumeWithinWindow, true);
  check("window ends 14h after the 6am start",
    o.windowEndsAt?.toISOString(), "2026-09-12T02:00:00.000Z");
  check("reset completes 10h after clocking out",
    o.resetCompleteAt?.toISOString(), "2026-09-12T07:00:00.000Z");
  check("not yet rested", o.fullyRested, false);
}
{
  // Window expired but rest incomplete — only one option left.
  const shifts = [shift("2026-09-11T00:00:00Z", "2026-09-11T12:00:00Z")];
  const now = t("2026-09-11T16:00:00Z");                   // window died at 14:00Z
  const o = dutyOptions(shifts, now);
  check("expired window cannot be resumed", o.canResumeWithinWindow, false);
  check("reset is the only path", o.resetCompleteAt?.toISOString(), "2026-09-11T22:00:00.000Z");
}
{
  // Staleness must track the SHIFT, not the duty period. 16h into a
  // period but 2h into a fresh shift is not a forgotten clock-out.
  const shifts = [
    shift("2026-09-11T06:00:00Z", "2026-09-11T18:00:00Z"),
    shift("2026-09-11T20:00:00Z", null),
  ];
  const s = driverHosSnapshot(shifts, t("2026-09-11T22:00:00Z"), TZ);
  check("window expired", s.window?.expired, true);
  check("but shift is not stale", s.stale, false);
}

// ── tz sanity ────────────────────────────────────────────────────────
section("timezone");
{
  // 01:00Z on the 12th is still the 11th in Denver — the off-by-one that
  // would silently shift a shift onto the wrong cycle day.
  check("late-evening UTC maps to prior local date",
    localDateString(t("2026-09-12T01:00:00Z"), TZ), "2026-09-11");
  check("midday UTC maps to same local date",
    localDateString(t("2026-09-11T18:00:00Z"), TZ), "2026-09-11");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
