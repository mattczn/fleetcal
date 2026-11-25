/**
 * Who is physically with this trailer, according to GPS.
 *
 * WHY THIS EXISTS. "Which truck has trailer X" used to be answered
 * from the dispatch record: the last load naming that trailer also
 * named a tractor, so that tractor was said to have it. Measured
 * against live Motive positions on 2026-11-25, that answer was wrong
 * for 13 of Curzon's 14 linked trailers. The worked example Matt
 * caught it with:
 *
 *   #402595 sat on I-70 at Cisco, UT. The map said CT-2020, from the
 *   load "PLS: Las Vegas → Grand Junction". CT-2020 was in Henderson,
 *   NV — 370 miles away. P-C412863 was 0.1 miles from the trailer. The
 *   load had been swapped mid-route, which is routine here.
 *
 * Dispatch records who was SUPPOSED to pull a load. It cannot record a
 * swap nobody typed in, and on this fleet trailers are swapped
 * constantly. GPS records where things actually are. So GPS decides,
 * and the dispatch record is a fallback for when GPS cannot speak.
 *
 * WHAT THE DATA SUPPORTS. In the 13 contradicted cases, 12 had exactly
 * one truck within 0.8 miles and the next nearest was 15 to 109 miles
 * away — not a close call. The exception is a yard: six trucks and six
 * trailers stand inside 800 m of the Salt Lake yard, all at zero
 * distance from each other, and no proximity reading can say which
 * truck is under which trailer. That case is reported as `ambiguous`
 * rather than guessed, and it is exactly what the manual assignment
 * is for.
 */
import { distanceMetres } from './yards';
import { DARK_ALERT_HOURS } from './trailerStillness';

/**
 * How close a truck has to be to count as standing with the trailer.
 *
 * One mile, and the number is measured rather than picked. Swept
 * against the live fleet on 2026-11-25, counting how many trailers
 * each radius resolves to a single truck versus leaves ambiguous:
 *
 *   0.25 mi   5 resolved   0 ambiguous   (loses a real pair)
 *   0.50 mi   6 resolved   0 ambiguous
 *   1.00 mi   6 resolved   0 ambiguous   ← widest clean radius
 *   1.50 mi   3 resolved   5 ambiguous
 *   2.00 mi   6 resolved   5 ambiguous
 *
 * Real pairs measure 0.0–0.8 mi, so anything from half a mile up
 * catches all of them; past a mile the Salt Lake cluster starts
 * pulling six or seven trucks inside the radius of trailers they have
 * nothing to do with, and two different trailers both "resolved" to
 * CT-2026 at 2.0 mi. A mile is therefore the widest bound that still
 * buys slack for clock skew between the two feeds — a trailer fix and
 * a truck fix a minute apart at highway speed — without inventing
 * pairings out of a busy industrial district.
 */
export const TOGETHER_MILES = 1;

const METRES_PER_MILE = 1609.344;

export interface TruckPosition {
  assetId: number;
  lat:     number;
  lon:     number;
}

export interface TrailerPosition {
  lat:        number;
  lon:        number;
  /** ISO. Used only to decide whether the fix is worth trusting. */
  locatedAt?: string | null;
}

export type PhysicalPairing =
  /** No usable fix for the trailer, so GPS has no opinion and the
   *  caller should fall back to the dispatch record. */
  | { kind: 'unknown'; reason: 'no_fix' | 'dark' }
  /** The trailer reported, and no truck is with it. */
  | { kind: 'alone' }
  /** Exactly one truck is with it. */
  | { kind: 'with'; assetId: number; miles: number }
  /** Several trucks are with it — a yard. Not guessable. */
  | { kind: 'ambiguous'; assetIds: number[] };

export interface PairingOptions {
  /** Defaults to now. Injected by the scenarios. */
  now?: Date;
  /** A fix older than this is not evidence of anything. Defaults to
   *  the same threshold trailerStillness calls a dark tracker. */
  maxFixAgeHours?: number;
}

/**
 * Resolve which truck is standing with one trailer.
 *
 * `trucks` is every tractor with a current position — retired ones
 * filtered out by the caller, since this module knows nothing about
 * the fleet roster.
 */
export function resolvePhysicalPairing(
  trailer: TrailerPosition | undefined | null,
  trucks:  readonly TruckPosition[],
  opts:    PairingOptions = {},
): PhysicalPairing {
  if (!trailer || !Number.isFinite(trailer.lat) || !Number.isFinite(trailer.lon)) {
    return { kind: 'unknown', reason: 'no_fix' };
  }

  // A tracker that stopped reporting yesterday is not evidence about
  // today. Say nothing and let the dispatch record have its turn,
  // rather than reporting `alone` for a trailer that has simply gone
  // quiet in a customer's yard with a truck beside it.
  const maxAge = opts.maxFixAgeHours ?? DARK_ALERT_HOURS;
  if (trailer.locatedAt) {
    const fixed = new Date(trailer.locatedAt).getTime();
    const now   = (opts.now ?? new Date()).getTime();
    if (Number.isFinite(fixed) && (now - fixed) / 3_600_000 > maxAge) {
      return { kind: 'unknown', reason: 'dark' };
    }
  }

  const limit = TOGETHER_MILES * METRES_PER_MILE;
  const near: Array<{ assetId: number; metres: number }> = [];
  for (const t of trucks) {
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
    const metres = distanceMetres(trailer.lat, trailer.lon, t.lat, t.lon);
    if (metres <= limit) near.push({ assetId: t.assetId, metres });
  }

  if (near.length === 0) return { kind: 'alone' };
  if (near.length === 1) {
    return { kind: 'with', assetId: near[0].assetId, miles: near[0].metres / METRES_PER_MILE };
  }
  // Deliberately NOT "nearest wins". At the yard the spread between
  // the closest truck and the third closest is a few metres of GPS
  // noise, so picking the minimum would produce a confident answer
  // that changes every poll. Several trucks here means we don't know.
  return {
    kind: 'ambiguous',
    assetIds: near.sort((a, b) => a.metres - b.metres).map(t => t.assetId),
  };
}

/**
 * Resolve the whole fleet at once, so one tractor cannot hold two
 * trailers.
 *
 * resolvePhysicalPairing answers for one trailer and cannot see the
 * others, which is enough until a truck is parked between two of
 * them. On 2026-11-25 that was real: P-A296084 sat 0.1 miles from
 * #412051 AND 0.1 miles from #413453, so asked separately both
 * trailers claimed it. A tractor pulls one trailer; two claims at the
 * same distance is not evidence of which.
 *
 * So a truck claimed by more than one trailer is demoted on every one
 * of them — reported as `ambiguous` rather than handed to whichever
 * is a few metres nearer, for the same reason the yard is ambiguous:
 * the gap between the candidates is GPS noise, not information. A
 * dispatcher who knows which one it is can say so by hand, which is
 * what the manual assignment is for.
 */
export function resolveFleetPairing(
  trailers: ReadonlyArray<{ trailerId: number; position?: TrailerPosition | null }>,
  trucks:   readonly TruckPosition[],
  opts:     PairingOptions = {},
): Map<number, PhysicalPairing> {
  const out = new Map<number, PhysicalPairing>();
  /** truck → the trailers claiming it. */
  const claims = new Map<number, number[]>();

  for (const t of trailers) {
    const verdict = resolvePhysicalPairing(t.position, trucks, opts);
    out.set(t.trailerId, verdict);
    if (verdict.kind === 'with') {
      const list = claims.get(verdict.assetId);
      if (list) list.push(t.trailerId);
      else claims.set(verdict.assetId, [t.trailerId]);
    }
  }

  for (const [assetId, claimants] of claims) {
    if (claimants.length < 2) continue;
    for (const trailerId of claimants) {
      out.set(trailerId, { kind: 'ambiguous', assetIds: [assetId] });
    }
  }

  return out;
}
