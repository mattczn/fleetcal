/**
 * Scenarios for GPS pairing — which truck is standing with a trailer.
 * Run from apps/web:
 *   npx tsx lib/trailerPairing.verify.ts
 *
 * The coordinates are the real ones measured on 2026-11-25, so the
 * cases are the fleet's own: the Cisco UT swap that started this, and
 * the Salt Lake yard huddle that proximity cannot resolve.
 */
import {
  resolvePhysicalPairing, resolveFleetPairing, TOGETHER_MILES, type TruckPosition,
} from './trailerPairing';

let pass = 0;
const failures: string[] = [];
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

const NOW = new Date('2026-11-25T17:00:00Z');
const fresh = '2026-11-25T16:52:00Z';
const opts  = { now: NOW };

// Real positions, 2026-11-25.
const CISCO      = { lat: 38.9913, lon: -109.3342, locatedAt: fresh };  // #402595
const P_C412863: TruckPosition = { assetId: 1, lat: 38.9900, lon: -109.3350 };  // 0.1 mi
const CT_2020:   TruckPosition = { assetId: 2, lat: 36.0517, lon: -115.0219 };  // Henderson
const LUIS_0809: TruckPosition = { assetId: 3, lat: 39.6336, lon: -110.8618 };  // 107 mi

// The Salt Lake yard, where six trucks stand within 800 m.
const YARD      = { lat: 40.7326, lon: -111.9644, locatedAt: fresh };
const CT_01:     TruckPosition = { assetId: 4, lat: 40.7327, lon: -111.9638 };
const CT_2022:   TruckPosition = { assetId: 5, lat: 40.7326, lon: -111.9644 };
const CT_2027:   TruckPosition = { assetId: 6, lat: 40.7328, lon: -111.9644 };

const FLEET = [P_C412863, CT_2020, LUIS_0809, CT_01, CT_2022, CT_2027];

// ── the case that started it ────────────────────────────────────────
const cisco = resolvePhysicalPairing(CISCO, FLEET, opts);
check('the truck actually beside it is the answer', cisco.kind, 'with');
check('…and it is P-C412863, not the dispatched CT-2020',
  cisco.kind === 'with' ? cisco.assetId : null, P_C412863.assetId);
check('…at the distance measured',
  cisco.kind === 'with' ? Math.round(cisco.miles * 10) / 10 : null, 0.1);

// ── the yard cannot be resolved ─────────────────────────────────────
const yard = resolvePhysicalPairing(YARD, FLEET, opts);
check('six trucks on one spot is not an answer', yard.kind, 'ambiguous');
check('…and it reports every candidate, nearest first',
  yard.kind === 'ambiguous' ? yard.assetIds.length : null, 3);
check('…nearest first',
  yard.kind === 'ambiguous' ? yard.assetIds[0] : null, CT_2022.assetId);

// ── nothing with it ─────────────────────────────────────────────────
check('a trailer on its own is alone',
  resolvePhysicalPairing(CISCO, [CT_2020, LUIS_0809], opts).kind, 'alone');
check('an empty fleet leaves it alone',
  resolvePhysicalPairing(CISCO, [], opts).kind, 'alone');

// ── GPS declining to speak ──────────────────────────────────────────
check('no position at all is unknown, not alone',
  resolvePhysicalPairing(undefined, FLEET, opts).kind, 'unknown');
check('…with the reason',
  (resolvePhysicalPairing(null, FLEET, opts) as { reason?: string }).reason, 'no_fix');
check('NaN coordinates are no position',
  resolvePhysicalPairing({ lat: NaN, lon: -109, locatedAt: fresh }, FLEET, opts).kind, 'unknown');
check('a tracker that went dark yesterday is unknown, not alone',
  resolvePhysicalPairing({ ...CISCO, locatedAt: '2026-11-23T10:00:00Z' },
                         [CT_2020], opts).kind, 'unknown');
check('…with the reason',
  (resolvePhysicalPairing({ ...CISCO, locatedAt: '2026-11-23T10:00:00Z' },
                          [CT_2020], opts) as { reason?: string }).reason, 'dark');
check('a fix from this morning is still evidence',
  resolvePhysicalPairing({ ...CISCO, locatedAt: '2026-11-25T06:00:00Z' },
                         FLEET, opts).kind, 'with');
check('a fix with no timestamp is taken at face value',
  resolvePhysicalPairing({ lat: CISCO.lat, lon: CISCO.lon }, FLEET, opts).kind, 'with');

// ── the threshold ───────────────────────────────────────────────────
// 1 degree of latitude is ~69 miles, so this steps a truck away from
// the trailer in known increments either side of the bound.
const milesNorth = (m: number): TruckPosition =>
  ({ assetId: 99, lat: CISCO.lat + m / 69.0, lon: CISCO.lon });
check('a truck just inside the bound is with it',
  resolvePhysicalPairing(CISCO, [milesNorth(TOGETHER_MILES - 0.3)], opts).kind, 'with');
check('a truck just outside it is not',
  resolvePhysicalPairing(CISCO, [milesNorth(TOGETHER_MILES + 0.3)], opts).kind, 'alone');
check('a truck a county away is certainly not',
  resolvePhysicalPairing(CISCO, [milesNorth(40)], opts).kind, 'alone');

// ── junk in the truck list ──────────────────────────────────────────
check('a truck with no usable position is skipped, not matched',
  resolvePhysicalPairing(CISCO, [{ assetId: 7, lat: NaN, lon: NaN }], opts).kind, 'alone');
check('…and does not spoil a real match',
  resolvePhysicalPairing(CISCO, [{ assetId: 7, lat: NaN, lon: NaN }, P_C412863], opts).kind,
  'with');

// ── one tractor, one trailer ────────────────────────────────────────
// The real case: P-A296084 sat 0.1 mi from #412051 and 0.1 mi from
// #413453 on 2026-11-25, so asked one at a time both claimed it.
const LOT       = { lat: 40.7236, lon: -111.9436, locatedAt: fresh };
const LOT_NEAR  = { lat: 40.7240, lon: -111.9440, locatedAt: fresh };
const P_A296084: TruckPosition = { assetId: 8, lat: 40.7236, lon: -111.9436 };

const fleet = resolveFleetPairing(
  [{ trailerId: 1, position: LOT }, { trailerId: 2, position: LOT_NEAR }],
  [P_A296084], opts);
check('a truck between two trailers claims neither',
  fleet.get(1)?.kind, 'ambiguous');
check('…on both of them', fleet.get(2)?.kind, 'ambiguous');
check('…naming the truck it could not be split between',
  (fleet.get(1) as { assetIds?: number[] }).assetIds, [P_A296084.assetId]);

const solo = resolveFleetPairing(
  [{ trailerId: 1, position: LOT }, { trailerId: 2, position: CISCO }],
  [P_A296084, P_C412863], opts);
check('two trailers with a truck each keep their trucks',
  solo.get(1)?.kind === 'with' ? solo.get(1) && (solo.get(1) as { assetId: number }).assetId : null,
  P_A296084.assetId);
check('…and the other one too',
  solo.get(2)?.kind === 'with' ? (solo.get(2) as { assetId: number }).assetId : null,
  P_C412863.assetId);
check('a trailer with no position still gets an answer',
  resolveFleetPairing([{ trailerId: 9 }], [P_A296084], opts).get(9)?.kind, 'unknown');
check('every trailer asked is in the result',
  resolveFleetPairing([{ trailerId: 1, position: LOT }, { trailerId: 9 }],
                      [P_A296084], opts).size, 2);

console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
