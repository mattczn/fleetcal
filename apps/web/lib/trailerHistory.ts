/**
 * Turn a stream of GPS fixes into a readable history: where a trailer
 * sat, and when it was rolling between those places.
 *
 * The raw samples are the wrong unit for a human. Seven days of a
 * working trailer is a thousand coordinates; what a dispatcher wants
 * is "sat at SLC Yard Mon night, ran to Vegas Tuesday morning, sat at
 * the receiver until Wednesday".
 *
 * TWO MEASURED FACTS SHAPE THIS (Curzon, 2026-11-23):
 *
 *   1. A gateway on battery checks in every ~8 hours; plugged into a
 *      tractor it reports every 1–2 minutes. So the fixes are wildly
 *      uneven in time, and any segmentation that assumes a steady
 *      sample rate will be wrong. Everything here works off the
 *      timestamps on the fixes themselves.
 *
 *   2. Motive's `moving` flag read false on a trailer doing 68 mph.
 *      It is not usable. Motion is derived here from distance over
 *      time between consecutive fixes, which is the only signal that
 *      held up against real data.
 */
import { distanceMetres } from './yards';
import { MOVE_THRESHOLD_M } from './trailerStillness';

export interface HistorySample {
  lat:       number;
  lon:       number;
  locatedAt: string;
  address?:  string | null;
}

export type SegmentKind = 'stopped' | 'moving';

export interface TrailerSegment {
  kind:     SegmentKind;
  /** First and last fix in the segment. */
  from:     string;
  to:       string;
  hours:    number;
  /** Where it was (a stop) or where it set off from (a move). */
  lat:      number;
  lon:      number;
  /** Where the move ended. Unset on a stop. */
  endLat?:  number;
  endLon?:  number;
  /** Straight-line miles covered. Only meaningful on a move, and an
   *  UNDERSTATEMENT of road miles by definition — it's the sum of
   *  chords between fixes, not the route. */
  miles?:   number;
  /** Motive's label for the stop, taken from its first fix. */
  address?: string;
  /** How many fixes backed this segment. A stop built from one fix is
   *  a gateway that checked in once and went quiet, not an observed
   *  dwell, and the UI can say so. */
  fixes:    number;
}

/**
 * A cluster of fixes has to span at least this long to count as the
 * trailer having STOPPED there, rather than being two fixes that
 * happened to land close together.
 *
 * At highway speed consecutive 2-minute fixes are ~2.3 km apart, far
 * outside the move threshold, so a genuine run never produces a
 * cluster. This mainly catches a trailer crawling through a yard or
 * stuck in traffic, where several fixes land within 250 m without the
 * trailer having actually parked.
 */
export const MIN_STOP_MINUTES = 25;

/**
 * Segment a trailer's fixes, oldest first.
 *
 * A "stop" is a run of consecutive fixes all within MOVE_THRESHOLD_M
 * of the run's first fix, spanning at least MIN_STOP_MINUTES. Anything
 * between two stops is a move. Clusters too short to be a stop fold
 * into the surrounding move rather than becoming their own row.
 */
export function segmentTrail(samples: HistorySample[]): TrailerSegment[] {
  if (samples.length === 0) return [];

  // Group into position clusters first; decide what each one MEANS
  // afterwards. Doing both at once is what makes this kind of code
  // unreadable.
  const clusters: HistorySample[][] = [];
  let current: HistorySample[] = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const anchor = current[0];
    const s = samples[i];
    if (distanceMetres(anchor.lat, anchor.lon, s.lat, s.lon) <= MOVE_THRESHOLD_M) {
      current.push(s);
    } else {
      clusters.push(current);
      current = [s];
    }
  }
  clusters.push(current);

  const spanMinutes = (c: HistorySample[]) =>
    (new Date(c[c.length - 1].locatedAt).getTime() - new Date(c[0].locatedAt).getTime()) / 60_000;

  const segments: TrailerSegment[] = [];
  // Fixes seen since the last real stop; they belong to the move
  // that is still open.
  let pending: HistorySample[] = [];

  const flushMove = (upto: HistorySample | null) => {
    const pts = upto ? [...pending, upto] : pending;
    if (pts.length < 2) { pending = []; return; }
    let metres = 0;
    for (let i = 1; i < pts.length; i++) {
      metres += distanceMetres(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    }
    const first = pts[0], last = pts[pts.length - 1];
    segments.push({
      kind:   'moving',
      from:   first.locatedAt,
      to:     last.locatedAt,
      hours:  (new Date(last.locatedAt).getTime() - new Date(first.locatedAt).getTime()) / 3_600_000,
      lat:    first.lat,
      lon:    first.lon,
      endLat: last.lat,
      endLon: last.lon,
      miles:  metres / 1609.344,
      fixes:  pts.length,
    });
    pending = [];
  };

  for (const c of clusters) {
    const isStop = c.length > 1 && spanMinutes(c) >= MIN_STOP_MINUTES;
    if (!isStop) {
      // Not a stop — these fixes are part of whatever move is running.
      pending.push(...c);
      continue;
    }
    // The move that led here ends at this stop's first fix, so the
    // drive and the arrival share a boundary instead of leaving a gap.
    flushMove(c[0]);
    const first = c[0], last = c[c.length - 1];
    segments.push({
      kind:    'stopped',
      from:    first.locatedAt,
      to:      last.locatedAt,
      hours:   (new Date(last.locatedAt).getTime() - new Date(first.locatedAt).getTime()) / 3_600_000,
      lat:     first.lat,
      lon:     first.lon,
      address: first.address ?? undefined,
      fixes:   c.length,
    });
    // The next move sets off from where this stop ended.
    pending = [last];
  }
  flushMove(null);

  return segments;
}

/**
 * Thin a path down to at most `max` points for drawing.
 *
 * Keeps the first and last and takes an even stride through the
 * middle. Crude on purpose: the alternative (Douglas-Peucker) earns
 * its complexity when you need to preserve corners exactly, and this
 * line is a 7-day overview, not a route to navigate by.
 */
export function thinPath<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const stride = (points.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}
