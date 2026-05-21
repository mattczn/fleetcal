/**
 * Clusters Motive driving periods for the calendar Movements column.
 *
 * Rules (display-only — does not change stored data):
 *   - Long periods (>= SHORT_MS) stay as their own single-member cluster.
 *   - Adjacent short periods (each < SHORT_MS) collapse into one cluster
 *     when the gap between them is <= MERGE_GAP_MS. This is what gets
 *     rid of yard-shuffle / bobtail-jiggle noise visually.
 *   - A long period never absorbs into a short cluster (and vice
 *     versa) — long trips are the signal we don't want to bury.
 *
 * Sorted by startTime ascending in the returned array.
 */
import type { MovementCard } from './railway';

const SHORT_MS     = 30 * 60_000;
const MERGE_GAP_MS = 15 * 60_000;

export interface MovementCluster {
  /** Synthetic key — stable for keying in React. */
  id:           string;
  startTime:    string;       // members[0].startTime
  endTime:      string;       // members[last].endTime (or startTime if in-progress)
  miles:        number;       // sum across members
  durationMin:  number;       // sum across members (minutes)
  origin:       string | null; // members[0].origin
  destination:  string | null; // members[last].destination
  members:      MovementCard[];
}

function periodMs(m: MovementCard): number {
  if (!m.endTime) return 0;
  return new Date(m.endTime).getTime() - new Date(m.startTime).getTime();
}

function newClusterFrom(m: MovementCard): MovementCluster {
  return {
    id:          String(m.id),
    startTime:   m.startTime,
    endTime:     m.endTime ?? m.startTime,
    miles:       m.miles ?? 0,
    durationMin: m.durationMin ?? 0,
    origin:      m.origin,
    destination: m.destination,
    members:     [m],
  };
}

export function clusterMovements(movements: MovementCard[]): MovementCluster[] {
  if (movements.length === 0) return [];

  const sorted = [...movements].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const result: MovementCluster[] = [];

  for (const m of sorted) {
    const mShort = periodMs(m) < SHORT_MS;
    const last   = result[result.length - 1];

    // Merge condition: both this period and the current cluster's last
    // member are short, and the gap between them is within threshold.
    const lastMember = last ? last.members[last.members.length - 1] : null;
    const lastShort  = lastMember ? periodMs(lastMember) < SHORT_MS : false;
    const gapMs      = last
      ? new Date(m.startTime).getTime() - new Date(last.endTime).getTime()
      : Infinity;

    if (last && mShort && lastShort && gapMs <= MERGE_GAP_MS) {
      last.endTime     = m.endTime ?? last.endTime;
      last.miles       += m.miles ?? 0;
      last.durationMin += m.durationMin ?? 0;
      last.destination = m.destination ?? last.destination;
      last.members.push(m);
      last.id          = `${last.members[0].id}-cluster-${last.members.length}`;
    } else {
      result.push(newClusterFrom(m));
    }
  }

  return result;
}
