/**
 * Clusters Motive driving periods for the calendar Movements column.
 *
 * Merge rules (display-only — does not change stored data):
 *   1. Any two periods whose real time intervals OVERLAP merge into
 *      one cluster. Two trips can't physically happen at once for the
 *      same truck — overlapping records are usually a Motive artifact
 *      (driver edit, source=3 reassignment) of the same trip.
 *   2. Two adjacent SHORT periods (each < SHORT_MS) merge if the gap
 *      between them is <= MERGE_GAP_MS. Kills yard-shuffle noise.
 *   3. Two adjacent LONG periods stay separate — those are distinct
 *      loads we don't want to bury.
 *
 * Each cluster gets a `displayEndTime` — its real end padded up to the
 * 30-min visual minimum, but never crossing into the next cluster's
 * real start. This is what MovementCard paints.
 *
 * Sorted by startTime ascending in the returned array.
 */
import type { MovementCard } from './railway';

const SHORT_MS         = 30 * 60_000;
const MERGE_GAP_MS     = 15 * 60_000;
const MIN_DISPLAY_MS   = 30 * 60_000;
/** A cluster's total miles must reach this to survive — drops yard
 *  shuffles and tiny GPS jiggle clusters that aren't useful to paint.
 *  Applied AFTER merging fragments, so a 150-mile trip composed of
 *  50 sub-mile Motive records still passes. */
const MIN_CLUSTER_MILES = 1.0;

export interface MovementCluster {
  /** Synthetic key — stable for keying in React. */
  id:              string;
  startTime:       string;       // members[0].startTime
  endTime:         string;       // members[last].endTime (or startTime if in-progress)
  /** Padded end used for visual rendering — may extend past endTime
   *  to enforce a 30-min minimum block, but never reaches the next
   *  cluster's startTime. */
  displayEndTime:  string;
  miles:           number;       // sum across members
  durationMin:     number;       // sum across members (minutes)
  origin:          string | null; // members[0].origin
  destination:     string | null; // members[last].destination
  members:         MovementCard[];
}

function periodMs(m: MovementCard): number {
  if (!m.endTime) return 0;
  return new Date(m.endTime).getTime() - new Date(m.startTime).getTime();
}

function newClusterFrom(m: MovementCard): MovementCluster {
  return {
    id:             String(m.id),
    startTime:      m.startTime,
    endTime:        m.endTime ?? m.startTime,
    displayEndTime: m.endTime ?? m.startTime, // filled in by finalize pass
    miles:          m.miles ?? 0,
    durationMin:    m.durationMin ?? 0,
    origin:         m.origin,
    destination:    m.destination,
    members:        [m],
  };
}

/** True if the closed interval [aStart, aEnd] intersects [bStart, bEnd]. */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return new Date(aStart).getTime() < new Date(bEnd).getTime()
      && new Date(bStart).getTime() < new Date(aEnd).getTime();
}

/**
 * Pulls the city out of a Motive origin/destination string.
 *
 * Motive returns formatted addresses like:
 *   "123 Main St, Denver, CO 80202, USA"
 *   "I-70 W, Aurora, CO"
 *   "Truckee, CA"
 *   "Wyoming"
 *
 * Strategy: split on commas, drop a trailing country, then look for a
 * "ST" or "ST 12345" tail — the segment immediately before that is the
 * city. Falls back to the last remaining segment if the tail doesn't
 * look like a state.
 */
export function extractCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  // Drop a trailing country word — only full words, never the bare "CA"
  // since that collides with the state of California.
  const last = parts[parts.length - 1];
  if (/^(USA|United States|Canada|Mexico)$/i.test(last)) {
    parts.pop();
  }

  if (parts.length >= 2) {
    const tail = parts[parts.length - 1];
    if (/^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(tail)) {
      return parts[parts.length - 2];
    }
  }
  return parts[parts.length - 1];
}

export function clusterMovements(movements: MovementCard[]): MovementCluster[] {
  if (movements.length === 0) return [];

  const sorted = [...movements].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const result: MovementCluster[] = [];

  for (const m of sorted) {
    const mEnd     = m.endTime ?? m.startTime;
    const mShort   = periodMs(m) < SHORT_MS;
    const last     = result[result.length - 1];

    let merge = false;
    if (last) {
      // Rule 1: real time intervals overlap → merge (handles Motive
      // duplicate / edited / reassigned records on the same trip).
      if (intervalsOverlap(last.startTime, last.endTime, m.startTime, mEnd)) {
        merge = true;
      } else {
        // Rule 2: both short + small gap → merge (yard-shuffle noise).
        const lastMember = last.members[last.members.length - 1];
        const lastShort  = periodMs(lastMember) < SHORT_MS;
        const gapMs      = new Date(m.startTime).getTime() - new Date(last.endTime).getTime();
        if (mShort && lastShort && gapMs <= MERGE_GAP_MS) merge = true;
      }
    }

    if (merge && last) {
      // Extend end to the later of the two (overlapping case can have
      // either side end last). Origin sticks with members[0]; destination
      // tracks the latest member that has one.
      const newEndMs = Math.max(new Date(last.endTime).getTime(), new Date(mEnd).getTime());
      last.endTime     = new Date(newEndMs).toISOString();
      last.miles       += m.miles ?? 0;
      last.durationMin += m.durationMin ?? 0;
      if (m.destination) last.destination = m.destination;
      last.members.push(m);
      last.id          = `${last.members[0].id}-cluster-${last.members.length}`;
    } else {
      result.push(newClusterFrom(m));
    }
  }

  // Cluster-level miles filter — Motive's API returns long trips as
  // many sub-mile fragments, so we filter AFTER clustering. A 150-mile
  // trip composed of 50 fragments passes; a 0.5-mile yard shuffle
  // alone does not.
  const filtered = result.filter(c => c.miles >= MIN_CLUSTER_MILES);

  // displayEndTime pass — pad each cluster up to the 30-min visual
  // minimum, but cap so the padding can never collide with the next
  // cluster's real start time.
  for (let i = 0; i < filtered.length; i++) {
    const c        = filtered[i];
    const realEnd  = new Date(c.endTime).getTime();
    const start    = new Date(c.startTime).getTime();
    const minEnd   = start + MIN_DISPLAY_MS;
    const nextCap  = i + 1 < filtered.length
      ? new Date(filtered[i + 1].startTime).getTime()
      : Number.POSITIVE_INFINITY;
    const display  = Math.min(Math.max(realEnd, minEnd), nextCap);
    c.displayEndTime = new Date(display).toISOString();
  }

  return filtered;
}
