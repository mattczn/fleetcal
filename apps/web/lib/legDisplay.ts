/**
 * Leg-position display helpers for N-leg relay loads.
 *
 * The canonical label helpers (legLabel / legShortLabel / byLegIndex)
 * live in @fleetcal/types — this module bridges them to the web app's
 * event shape, where legIndex/legCount may be missing on older rows or
 * on events fetched before the N-leg columns were populated. When the
 * explicit fields are absent we derive position from the other store
 * events sharing the relayGroupId, and as a last resort from relayRole
 * alone (pickup = first, delivery = last).
 */

import { byLegIndex, legLabel, legShortLabel } from '@fleetcal/types';
import type { CalendarEvent } from '@/lib/types';

type LegLike = Pick<CalendarEvent, 'id' | 'start' | 'relayGroupId' | 'relayRole' | 'legIndex' | 'legCount'>;

export interface LegPosition {
  index: number;
  count: number;
}

/**
 * Resolve (index, count) for a relay leg. `allEvents` is any list that
 * may contain the load's sibling legs (typically the calendar store's
 * events array). Returns null for non-relay events and for relay legs
 * whose position genuinely can't be established (partner legs not
 * loaded AND no legIndex/legCount from the API) — callers should fall
 * back to a role-only label in that case.
 */
export function legPositionFor(
  event: LegLike,
  allEvents?: readonly LegLike[],
): LegPosition | null {
  const isRelay = !!event.relayGroupId || event.relayRole != null;
  if (!isRelay) return null;

  // Best source: explicit fields from the API.
  if (event.legIndex != null && event.legCount != null && event.legCount > 1) {
    return { index: event.legIndex, count: event.legCount };
  }

  // Next: siblings sharing the relayGroupId in the provided list.
  if (event.relayGroupId && allEvents) {
    const group = allEvents
      .filter(e => e.relayGroupId === event.relayGroupId)
      .sort(byLegIndex);
    if (group.length > 1) {
      const idx = group.findIndex(e => e.id === event.id);
      if (idx >= 0) return { index: idx, count: group.length };
    }
  }

  // Last resort: role alone. We know a relay has >= 2 legs; pickup is
  // always first and delivery always last, so a 2-leg assumption gives
  // the right label for the overwhelmingly common case. A transfer leg
  // is by definition neither, so pin it mid-load of an assumed 3.
  switch (event.relayRole) {
    case 'pickup':   return { index: 0, count: event.legCount ?? 2 };
    case 'delivery': return { index: (event.legCount ?? 2) - 1, count: event.legCount ?? 2 };
    case 'transfer': return { index: 1, count: event.legCount ?? 3 };
    default:         return null;
  }
}

/** Full label — "Leg 1 · Pickup" / "Leg 2 · Transfer" / "Leg 3 · Delivery".
 *  Empty string for non-relay events. */
export function eventLegLabel(event: LegLike, allEvents?: readonly LegLike[]): string {
  const pos = legPositionFor(event, allEvents);
  return pos ? legLabel(pos.index, pos.count) : '';
}

/** Compact form for tight chips — "Leg 1/3". Empty for non-relay events. */
export function eventLegShortLabel(event: LegLike, allEvents?: readonly LegLike[]): string {
  const pos = legPositionFor(event, allEvents);
  return pos ? legShortLabel(pos.index, pos.count) : '';
}
