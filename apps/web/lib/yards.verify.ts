/**
 * Scenarios for the yard geofence maths. Run from apps/web:
 *   npx tsx lib/yards.verify.ts
 */
import { yardsFrom, yardAt, distanceMetres, feetToMetres, metresToFeet, type Yard } from './yards';
import type { SavedLocation } from './types';

let pass = 0;
const failures: string[] = [];
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

// The real SLC yard, from org_settings.hos_settings.
const SLC = { lat: 40.7329433, lng: -111.9646778 };

const loc = (p: Partial<SavedLocation> & { id: string; name: string }): SavedLocation => p as SavedLocation;

// ── yardsFrom: a geofence needs both a radius and a point ───────────
check('a location with radius + point is a yard',
  yardsFrom([loc({ id: 'a', name: 'SLC Yard', ...SLC, radiusMeters: 300 })]).length, 1);

check('a radius with no geocode is not a yard yet',
  yardsFrom([loc({ id: 'b', name: 'Pending', radiusMeters: 300 })]).length, 0);

check('an ordinary preset is not a yard',
  yardsFrom([loc({ id: 'c', name: 'Some shipper', ...SLC })]).length, 0);

check('a zero radius is not a yard',
  yardsFrom([loc({ id: 'd', name: 'Zero', ...SLC, radiusMeters: 0 })]).length, 0);

// ── distance sanity ─────────────────────────────────────────────────
check('distance to itself is zero',
  Math.round(distanceMetres(SLC.lat, SLC.lng, SLC.lat, SLC.lng)), 0);

// ~0.001 deg of latitude is ~111 m.
check('a thousandth of a degree of latitude is ~111 m',
  Math.round(distanceMetres(SLC.lat, SLC.lng, SLC.lat + 0.001, SLC.lng)), 111);

// ── yardAt ──────────────────────────────────────────────────────────
const slcYard: Yard = { id: 'y1', name: 'SLC Yard', ...SLC, radiusMeters: 300 };

check('a trailer on the pin is at the yard',
  yardAt(SLC.lat, SLC.lng, [slcYard])?.name, 'SLC Yard');

check('a trailer 100 m away is still at the yard',
  yardAt(SLC.lat + 0.0009, SLC.lng, [slcYard])?.name, 'SLC Yard');

check('a trailer 500 m away is not',
  yardAt(SLC.lat + 0.0045, SLC.lng, [slcYard]), undefined);

check('no yards means never at a yard',
  yardAt(SLC.lat, SLC.lng, []), undefined);

// Overlapping geofences: a small lot drawn inside a big terminal
// circle should report the small one — the more specific answer.
const terminal: Yard = { id: 'y2', name: 'Whole terminal', ...SLC, radiusMeters: 5000 };
const dropLot:  Yard = { id: 'y3', name: 'Drop lot', lat: SLC.lat + 0.002, lng: SLC.lng, radiusMeters: 400 };

check('overlapping yards resolve to the nearest centre',
  yardAt(SLC.lat + 0.002, SLC.lng, [terminal, dropLot])?.name, 'Drop lot');

check('order does not change the winner',
  yardAt(SLC.lat + 0.002, SLC.lng, [dropLot, terminal])?.name, 'Drop lot');

check('outside the small lot, the terminal still claims it',
  yardAt(SLC.lat + 0.01, SLC.lng, [terminal, dropLot])?.name, 'Whole terminal');

// ── unit conversion ─────────────────────────────────────────────────
check('1000 ft is 305 m', feetToMetres(1000), 305);
check('305 m is ~1001 ft', metresToFeet(305), 1001);
check('feet round-trip within a foot', Math.abs(metresToFeet(feetToMetres(500)) - 500) <= 1, true);

console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
