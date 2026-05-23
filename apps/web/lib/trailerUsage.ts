/**
 * Trailer usage resolution.
 *
 * Given a trailer and the org's events list, classifies whether the
 * trailer is "in use right now" and, if so, surfaces the load that's
 * using it. Powers the calendar's trailer fleet map panel (pin color +
 * sidebar info).
 *
 * "In use" rules (matches the user's spec):
 *   - Some non-deleted event has trailerId === <this trailer>.
 *   - Its status is not 'delivered', 'cancelled', or 'tonu'.
 *   - The current moment falls within [start, end] (inclusive). Both
 *     are naive ISO in the org's dispatch zone; we compare against the
 *     same naive-now string so the filter respects the org's clock
 *     rather than the browser's.
 *
 * If multiple events qualify (rare — overlapping loads), the one with
 * the earliest start wins so the user sees the load actually running
 * right now, not a freshly-assigned one that hasn't started yet.
 */
import type { CalendarEvent } from '@/lib/types';
import { nowInTz } from '@/lib/time-utils';

export type TrailerStatus = 'in_use' | 'idle';

export interface TrailerUsage {
  status: TrailerStatus;
  load?:  CalendarEvent;
}

const INACTIVE_STATUSES = new Set(['delivered', 'cancelled', 'tonu']);

/** Format current moment in the org tz as a naive ISO "YYYY-MM-DDTHH:mm".
 *  Used to compare against events.start/end which are also naive in tz. */
function nowNaiveInTz(tz: string | undefined): string {
  const d = tz ? nowInTz(tz) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function getTrailerUsage(
  trailerId: number,
  events: CalendarEvent[],
  orgTz: string | undefined,
): TrailerUsage {
  const nowNaive = nowNaiveInTz(orgTz);

  const candidates = events
    .filter(e => e.trailerId === trailerId)
    .filter(e => !e.deletedAt)
    .filter(e => !INACTIVE_STATUSES.has(e.status ?? ''))
    .filter(e => e.start <= nowNaive && nowNaive <= e.end)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (candidates.length === 0) return { status: 'idle' };
  return { status: 'in_use', load: candidates[0] };
}
