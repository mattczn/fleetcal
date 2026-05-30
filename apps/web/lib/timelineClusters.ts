/**
 * Clusters TimelineMovement records the same way the calendar's
 * Movements column does (see clusterMovements.ts) — but operating on
 * the richer TimelineMovement shape so we keep ids, source, lat/lng,
 * etc. for the timeline detail panel + AI auto-link.
 *
 * Why coalesce at all on this page:
 *   The user pointed out that a single load gets fragmented by Motive
 *   into many sub-mile driving periods. Those fragments aren't useful
 *   classification units — they're just GPS noise inside one logical
 *   trip. The calendar already collapses them; the timeline should too,
 *   AND the AI should reason about CLUSTERS, not raw fragments, so a
 *   delivery-area circle of three 0.4-mile pings doesn't waste a role
 *   assignment apiece.
 *
 * Rules mirror clusterMovements.ts so dispatchers see the same chip
 * counts on both views:
 *   1. Overlapping real intervals merge (Motive duplicate / edited /
 *      reassigned records of the same trip).
 *   2. Two adjacent SHORT (<30min) periods with a gap <=15min merge.
 *      Kills yard-shuffle and pickup-area noise.
 *   3. Adjacent LONG periods stay separate.
 *
 * displayEndTime pads short clusters up to a 30-min visual minimum,
 * capped by the next cluster's real start so chips never overlap.
 *
 * After merging, clusters under 1 mile total get dropped — those are
 * tiny GPS jiggles that aren't real trips, and surfacing them just
 * confuses the AI ("classify this 0.3-mile yard nudge against your
 * 6 loads, please").
 */

import type { TimelineMovement } from './railway';

const SHORT_MS          = 30 * 60_000;
const MERGE_GAP_MS      = 15 * 60_000;
const MIN_DISPLAY_MS    = 30 * 60_000;
const MIN_CLUSTER_MILES = 1.0;

export interface TimelineCluster {
  /** Stable id — first member's uuid + cluster size. */
  id:              string;
  /** First member's startTime (sort key). */
  startTime:       string;
  /** Last member's endTime (or last startTime if in-progress). */
  endTime:         string;
  /** Padded end used for chip rendering — may extend past endTime to
   *  hit the 30-min visual minimum, never crossing next cluster start. */
  displayEndTime:  string;
  /** Sum of member miles. */
  miles:           number;
  /** Sum of member duration in minutes. */
  durationMin:     number;
  /** First member's origin. */
  origin:          string | null;
  /** Latest non-null destination across members. */
  destination:     string | null;
  /** First member's origin lat/lng — used by AI to match saved locations. */
  originLat:       number | null;
  originLon:       number | null;
  /** Latest non-null destination lat/lng across members. */
  destinationLat:  number | null;
  destinationLon:  number | null;
  /** Distinct movement sources represented in this cluster.
   *  Almost always just ['motive'] in practice but tracked for the
   *  display badge ("Motive • Manual" if mixed). */
  sources:         Array<'motive' | 'manual' | 'derived'>;
  members:         TimelineMovement[];
}

function periodMs(m: TimelineMovement): number {
  if (!m.endTime) return 0;
  return new Date(m.endTime).getTime() - new Date(m.startTime).getTime();
}

function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
      && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

function newClusterFrom(m: TimelineMovement): TimelineCluster {
  return {
    id:              m.id,
    startTime:       m.startTime,
    endTime:         m.endTime ?? m.startTime,
    displayEndTime:  m.endTime ?? m.startTime,
    miles:           m.miles ?? 0,
    durationMin:     m.durationMin ?? 0,
    origin:          m.origin ?? null,
    destination:     m.destination ?? null,
    originLat:       m.originLat ?? null,
    originLon:       m.originLon ?? null,
    destinationLat:  m.destinationLat ?? null,
    destinationLon:  m.destinationLon ?? null,
    sources:         [m.source],
    members:         [m],
  };
}

export function clusterTimelineMovements(movements: TimelineMovement[]): TimelineCluster[] {
  if (movements.length === 0) return [];

  const sorted = [...movements].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const result: TimelineCluster[] = [];

  for (const m of sorted) {
    const mEnd   = m.endTime ?? m.startTime;
    const mShort = periodMs(m) < SHORT_MS;
    const last   = result[result.length - 1];

    let merge = false;
    if (last) {
      if (intervalsOverlap(last.startTime, last.endTime, m.startTime, mEnd)) {
        merge = true;
      } else {
        const lastMember = last.members[last.members.length - 1];
        const lastShort  = periodMs(lastMember) < SHORT_MS;
        const gapMs      = new Date(m.startTime).getTime() - new Date(last.endTime).getTime();
        if (mShort && lastShort && gapMs <= MERGE_GAP_MS) merge = true;
      }
    }

    if (merge && last) {
      const newEndMs = Math.max(new Date(last.endTime).getTime(), new Date(mEnd).getTime());
      last.endTime     = new Date(newEndMs).toISOString();
      last.miles       += m.miles ?? 0;
      last.durationMin += m.durationMin ?? 0;
      if (m.destination)         last.destination    = m.destination;
      if (m.destinationLat != null) last.destinationLat = m.destinationLat;
      if (m.destinationLon != null) last.destinationLon = m.destinationLon;
      if (!last.sources.includes(m.source)) last.sources.push(m.source);
      last.members.push(m);
      last.id = `${last.members[0].id}-cluster-${last.members.length}`;
    } else {
      result.push(newClusterFrom(m));
    }
  }

  // Drop sub-mile noise AFTER merging (so a long trip fragmented into
  // many sub-mile rows still survives as a single cluster).
  const filtered = result.filter((c) => c.miles >= MIN_CLUSTER_MILES);

  // displayEndTime pass — same logic as clusterMovements.ts.
  for (let i = 0; i < filtered.length; i++) {
    const c       = filtered[i];
    const realEnd = new Date(c.endTime).getTime();
    const start   = new Date(c.startTime).getTime();
    const minEnd  = start + MIN_DISPLAY_MS;
    const nextCap = i + 1 < filtered.length
      ? new Date(filtered[i + 1].startTime).getTime()
      : Number.POSITIVE_INFINITY;
    c.displayEndTime = new Date(Math.min(Math.max(realEnd, minEnd), nextCap)).toISOString();
  }

  return filtered;
}
