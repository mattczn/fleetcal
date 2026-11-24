/**
 * Scenarios for trail segmentation. Run from apps/web:
 *   npx tsx lib/trailerHistory.verify.ts
 */
import { segmentTrail, thinPath, MIN_STOP_MINUTES, type HistorySample } from './trailerHistory';

let pass = 0;
const failures: string[] = [];
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

const T0 = new Date('2026-11-16T00:00:00Z').getTime();
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const SLC   = { lat: 40.7329, lon: -111.9647 };
const VEGAS = { lat: 36.1699, lon: -115.1398 };

/** A fix `min` minutes in, `jitterM` metres north of `p`. */
const fix = (p: { lat: number; lon: number }, min: number, jitterM = 0, address?: string): HistorySample =>
  ({ lat: p.lat + jitterM / 111_320, lon: p.lon, locatedAt: at(min), address });

/** Points along SLC -> Vegas at `frac` of the way. */
const along = (frac: number, min: number): HistorySample => ({
  lat: SLC.lat + (VEGAS.lat - SLC.lat) * frac,
  lon: SLC.lon + (VEGAS.lon - SLC.lon) * frac,
  locatedAt: at(min),
});

// ── nothing ─────────────────────────────────────────────────────────
check('no fixes, no segments', segmentTrail([]).length, 0);
check('one fix is not a stop and not a move', segmentTrail([fix(SLC, 0)]).length, 0);

// ── a parked trailer checking in on battery ─────────────────────────
// 8-hourly check-ins, wandering a few metres. One long stop, no moves.
const parked = segmentTrail([
  fix(SLC, 0, 0, 'Salt Lake City, UT'), fix(SLC, 480, 20), fix(SLC, 960, -35), fix(SLC, 1440, 15),
]);
check('a parked trailer is one stop', parked.length, 1);
check('…of kind stopped', parked[0].kind, 'stopped');
check('…spanning the whole 24h', Math.round(parked[0].hours), 24);
check('…keeping the address of its first fix', parked[0].address, 'Salt Lake City, UT');
check('…and counting its check-ins', parked[0].fixes, 4);

// ── a real trip: sit, run, sit ──────────────────────────────────────
const trip = segmentTrail([
  fix(SLC, 0, 0, 'Salt Lake City, UT'), fix(SLC, 240, 25), fix(SLC, 480, -10),
  along(0.25, 540), along(0.5, 600), along(0.75, 660),
  fix(VEGAS, 720, 0, 'Las Vegas, NV'), fix(VEGAS, 1200, 30), fix(VEGAS, 1680, -15),
]);
check('sit/run/sit is three segments', trip.map(s => s.kind), ['stopped', 'moving', 'stopped']);
check('the drive starts when the yard stop ends', trip[1].from, trip[0].to);
check('and ends when the Vegas stop starts', trip[1].to, trip[2].from);
check('the drive took 4h', Math.round(trip[1].hours), 4);
// SLC->Vegas is ~368 straight-line miles.
check('straight-line miles are in the right range',
  trip[1].miles! > 340 && trip[1].miles! < 400, true);
check('the second stop is Vegas', trip[2].address, 'Las Vegas, NV');
check('the Vegas stop lasts 16h', Math.round(trip[2].hours), 16);

// ── a brief cluster mid-run is not a stop ───────────────────────────
// Two fixes 5 minutes apart in the same spot (traffic) must fold into
// the drive rather than splitting it into three segments.
const traffic = segmentTrail([
  fix(SLC, 0, 0), fix(SLC, 240, 10),
  along(0.3, 300), along(0.3, 305),
  fix(VEGAS, 420, 0), fix(VEGAS, 900, 0),
]);
check('a 5-minute cluster mid-run does not become a stop',
  traffic.map(s => s.kind), ['stopped', 'moving', 'stopped']);

// …but one that lasts past the threshold does.
const restBreak = segmentTrail([
  fix(SLC, 0, 0), fix(SLC, 240, 10),
  along(0.3, 300), along(0.3, 300 + MIN_STOP_MINUTES + 5),
  fix(VEGAS, 600, 0), fix(VEGAS, 1080, 0),
]);
check('a cluster past the threshold becomes its own stop',
  restBreak.map(s => s.kind), ['stopped', 'moving', 'stopped', 'moving', 'stopped']);

// ── a trailer that only ever moved ──────────────────────────────────
const rolling = segmentTrail([along(0, 0), along(0.3, 60), along(0.6, 120), along(1, 180)]);
check('continuous movement is a single move', rolling.map(s => s.kind), ['moving']);
check('…covering the whole 3h', Math.round(rolling[0].hours), 3);
check('…with every fix counted', rolling[0].fixes, 4);

// ── thinPath ────────────────────────────────────────────────────────
const pts = Array.from({ length: 1000 }, (_, i) => i);
check('a short path is untouched', thinPath([1, 2, 3], 10), [1, 2, 3]);
check('a long path is capped', thinPath(pts, 100).length, 100);
check('…keeping the first point', thinPath(pts, 100)[0], 0);
check('…and the last', thinPath(pts, 100)[99], 999);

console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
