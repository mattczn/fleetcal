/**
 * Scenarios for the trailer stillness maths. Run from apps/web:
 *   npx tsx lib/trailerStillness.verify.ts
 */
import {
  computeStillness, isDark, isStatic, formatStill, formatAge, formatDwell, hoursSince,
  MOVE_THRESHOLD_M, type LocationSample,
} from './trailerStillness';

let pass = 0;
const failures: string[] = [];
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

// The real SLC yard, and a point ~1.4 km away (clear of the threshold).
const YARD   = { lat: 40.7329433, lon: -111.9646778 };
const ACROSS = { lat: 40.7329433, lon: -111.9480000 };

const NOW = new Date('2026-11-23T18:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** A fix at `p`, `h` hours before NOW, nudged `jitterM` metres north. */
function fix(p: { lat: number; lon: number }, h: number, jitterM = 0): LocationSample {
  return { lat: p.lat + jitterM / 111_320, lon: p.lon, locatedAt: hoursAgo(h) };
}

// ── no history ──────────────────────────────────────────────────────
check('no samples means no answer', computeStillness([], NOW).sampleCount, 0);
check('no samples is truncated',    computeStillness([], NOW).truncated, true);
check('no samples has no parked time', computeStillness([], NOW).parkedSinceAt, null);
check('no samples never fires the static flag',
  isStatic(computeStillness([], NOW), NOW), false);

// ── one sample ──────────────────────────────────────────────────────
const one = computeStillness([fix(YARD, 2)], NOW);
check('a single fix parks at its own timestamp', one.parkedSinceAt, hoursAgo(2));
check('a single fix is truncated', one.truncated, true);
check('a single fix 2h old reads 2h still', Math.round(one.stillHours!), 2);

// ── jitter must not read as movement ────────────────────────────────
const jittery = computeStillness([
  fix(YARD, 1,  30), fix(YARD, 7, -45), fix(YARD, 13, 60),
  fix(YARD, 19, -20), fix(YARD, 25, 10), fix(YARD, 31, -55),
], NOW);
check('GPS wander within the threshold is not a move',
  Math.round(jittery.stillHours!), 31);
check('a long still run is not truncated when it ends at our oldest fix',
  jittery.truncated, true);
check('31h still does not trip the 2-day rule', isStatic(jittery, NOW), false);

// ── a real move ends the run ────────────────────────────────────────
const moved = computeStillness([
  fix(YARD, 1), fix(YARD, 7), fix(YARD, 13),
  fix(ACROSS, 19), fix(ACROSS, 25),
], NOW);
check('the run stops at the fix before the move', Math.round(moved.stillHours!), 13);
check('a run that ended on a real move is NOT truncated', moved.truncated, false);

// ── the 2-day rule ──────────────────────────────────────────────────
const stale = computeStillness([
  fix(YARD, 1), fix(YARD, 20), fix(YARD, 44), fix(YARD, 70), fix(ACROSS, 95),
], NOW);
check('70h still', Math.round(stale.stillHours!), 70);
check('70h trips the 2-day rule', isStatic(stale, NOW), true);
check('exactly 48h trips it',
  isStatic(computeStillness([fix(YARD, 1), fix(YARD, 48), fix(ACROSS, 60)], NOW), NOW), true);
check('47h does not',
  isStatic(computeStillness([fix(YARD, 1), fix(YARD, 47), fix(ACROSS, 60)], NOW), NOW), false);

// A short run only because collection just started must not claim the
// trailer recently arrived — but it also must not fire the alert.
const young = computeStillness([fix(YARD, 1), fix(YARD, 5)], NOW);
check('a young history is truncated', young.truncated, true);
check('a young history does not fire the alert', isStatic(young, NOW), false);

// ── threshold boundary ──────────────────────────────────────────────
check('a fix just inside the threshold is the same place',
  computeStillness([fix(YARD, 1), fix(YARD, 9, MOVE_THRESHOLD_M - 10)], NOW).sampleCount === 2
    && Math.round(computeStillness([fix(YARD, 1), fix(YARD, 9, MOVE_THRESHOLD_M - 10)], NOW).stillHours!) === 9,
  true);
check('a fix just outside the threshold ends the run',
  Math.round(computeStillness([fix(YARD, 1), fix(YARD, 9, MOVE_THRESHOLD_M + 50)], NOW).stillHours!), 1);

// ── dark trackers: no history needed ────────────────────────────────
check('a fix 2h old is not dark',  isDark(hoursAgo(2), NOW), false);
check('a fix 23h old is not dark', isDark(hoursAgo(23), NOW), false);
check('a fix 24h old is dark',     isDark(hoursAgo(24), NOW), true);
check('the 21-day reefer is dark', isDark(hoursAgo(508.7), NOW), true);
check('a missing timestamp is not reported as dark', isDark(null, NOW), false);
check('hoursSince reads back', Math.round(hoursSince(hoursAgo(9), NOW)!), 9);

// Dark and still are independent: a tracker can go dark minutes after
// the trailer was moved, and a healthy tracker can sit for a week.
check('dark does not imply static',
  isStatic(computeStillness([fix(YARD, 30), fix(ACROSS, 31)], NOW), NOW), false);
check('…while that same trailer IS dark', isDark(hoursAgo(30), NOW), true);

// ── formatting ──────────────────────────────────────────────────────
// A DURATION. These words follow "Parked ..." / "Stationary ...".
check('a short move reads in minutes', formatStill(0.4), '24m');
check('a sub-minute blip says so', formatStill(0.008), 'under a minute');
check('hours stay hours',  formatStill(6.7), '6h');
check('a day rounds down', formatStill(26), '1d 2h');
check('a whole day drops the hours', formatStill(48), '2d');
check('unknown stays unknown', formatStill(null), 'unknown');

// AN AGE. These follow "Last fix ...". Reading a duration into this
// slot is what produced "Last fix just arrived ago" on the panel.
check('a fresh fix is just now',  formatAge(0.005), 'just now');
check('minutes read as minutes',  formatAge(0.68), '41m ago');
check('hours read as hours',      formatAge(6.7), '6h ago');
check('days read as days',        formatAge(50), '2d ago');
check('an unknown age says so',   formatAge(null), 'unknown');

// A DWELL, with the hedge for history that runs off the end.
check('a hedged dwell carries the sign', formatDwell(50, true), '\u22652d 2h');
check('an unhedged dwell does not',      formatDwell(50, false), '2d 2h');
check('the hedge holds at the short end', formatDwell(0.3, true), '≥18m');

console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
