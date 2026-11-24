/**
 * Trailer usage resolution.
 *
 * Classifies one trailer against the org's events into two states:
 *
 *   in_use  — a truck has it: either a load is running on it right
 *             now, or the last one left it behind a tractor and
 *             nothing since says otherwise.
 *   idle    — nothing has it.
 *
 * WHY A FINISHED LOAD STILL COUNTS. A load ending does not unhook a
 * trailer; a driver does, by dropping it. Deriving the link purely
 * from "is a load running" unlinked every trailer the moment its
 * load's window closed — wrong for the many hours between a delivery
 * and the next dispatch, which is exactly when a dispatcher asks "who
 * has 633453 right now?". So the link survives the load and is ended
 * only by the things that actually end it:
 *
 *   1. The trailer is inside one of our yards. It has been dropped
 *      and it is accounted for; whatever brought it home no longer
 *      matters. (Caller's call — see `atYard`.)
 *   2. That tractor's own most recent begun load names a DIFFERENT
 *      trailer. The truck has moved on, so the link is stale.
 *   3. That tractor has been retired. A truck that is out of the
 *      fleet is not holding a trailer today.
 *   4. The load ended more than HOOK_MAX_DAYS ago. Not a claim about
 *      trucks — a bound on how long a guess is worth repeating.
 *
 * A trailer behind a tractor between loads was briefly its own third
 * state ('hooked', drawn in a third colour and listed in its own
 * section). It isn't one: to a dispatcher "a truck has this trailer"
 * is one fact, and splitting it in two made the roster longer without
 * answering a different question. What DOES still differ is whether
 * the load is running, so that survives as `live` — a property of the
 * load on the link, not a status of the trailer. Callers use it to
 * avoid quoting a finished load's route as where the trailer is
 * heading.
 *
 * If several loads qualify as live (rare — overlapping dispatch), the
 * earliest start wins, so the user sees the load actually running now
 * rather than a freshly-assigned one.
 */
import type { CalendarEvent } from '@/lib/types';
import { nowInTz } from '@/lib/time-utils';

export type TrailerStatus = 'in_use' | 'idle';

/**
 * The fields of a load this module actually reads.
 *
 * CalendarEvent satisfies it. Naming the narrow shape lets the
 * scenarios in trailerUsage.verify.ts build a load out of six fields
 * instead of inventing the other forty columns, which is the
 * difference between the rules below being covered and not.
 */
export interface CalendarEventLike {
  id:         string;
  trailerId?: number;
  assetId:    number;
  status?:    string;
  /** Naive ISO "YYYY-MM-DDTHH:mm" in the org's dispatch zone. */
  start:      string;
  end:        string;
  deletedAt?: string;
}

export interface TrailerUsage {
  status: TrailerStatus;
  /** The load the link comes from: the one running now, or the one
   *  that left the trailer on that truck. Absent when idle. */
  load?:  CalendarEvent;
  /** True when `load` is running RIGHT NOW. False when the link is a
   *  finished load's leftover — same status, but the load's route is
   *  then history rather than where the trailer is going. */
  live:   boolean;
}

export interface TrailerUsageOptions {
  /** True when the trailer's latest fix is inside a known yard. Ends
   *  the link (rule 1). Passed in rather than derived here because the
   *  yard geofences and the live Motive positions both live in the
   *  component; this module stays a pure function of events. */
  atYard?: boolean;
  /** The org's "Unassigned" pseudo-asset. Every load carries an
   *  assetId, so without this a load parked on Unassigned would link
   *  the trailer to a tractor that does not exist. */
  unassignedAssetId?: number | null;
  /** Tractors retired as of today (assets.activeTo in the past). A
   *  retired truck is out of the fleet, so it cannot be holding a
   *  trailer right now however recent its last load was — and the
   *  retirement is usually the very event that ended the pairing.
   *  Passed in because retirement is a property of the asset, which
   *  this module deliberately knows nothing else about. */
  retiredAssetIds?: ReadonlySet<number>;
}

/**
 * How long a finished load keeps claiming its trailer.
 *
 * Seven days is generous for the case this is for (a load that ended
 * hours ago) and short enough that a trailer sitting at a customer
 * for a fortnight stops naming a truck that has long since pulled
 * something else. It also matches the window the calendar store
 * guarantees it has loaded (±7 days around today): a longer cap would
 * make the answer depend on how far the user had scrolled the
 * calendar, which is the kind of invisible coupling that produces a
 * bug nobody can reproduce.
 */
export const HOOK_MAX_DAYS = 7;

/** Loads that never happened never hooked anything. */
const VOID_STATUSES = new Set<string>(['cancelled', 'tonu']);

/** Void, plus the one that means the work is done. Used only to
 *  decide "is this running now" — `delivered` is a perfectly good
 *  basis for the link, and is in fact the normal one. */
const INACTIVE_STATUSES = new Set<string>(['delivered', 'cancelled', 'tonu']);

/** Format a Date as the naive ISO "YYYY-MM-DDTHH:mm" that
 *  events.start / events.end use, so every comparison in here is a
 *  string compare in one consistent frame. */
function naive(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function getTrailerUsage<E extends CalendarEventLike>(
  trailerId: number,
  events: E[],
  orgTz: string | undefined,
  opts: TrailerUsageOptions = {},
): { status: TrailerStatus; load?: E; live: boolean } {
  const nowDate  = orgTz ? nowInTz(orgTz) : new Date();
  const nowNaive = naive(nowDate);

  const mine = events.filter(e =>
    e.trailerId === trailerId &&
    !e.deletedAt &&
    !VOID_STATUSES.has(e.status ?? ''));

  // ── A live load wins outright ───────────────────────────────────────
  const live = mine
    .filter(e => !INACTIVE_STATUSES.has(e.status ?? ''))
    .filter(e => e.start <= nowNaive && nowNaive <= e.end)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (live.length > 0) return { status: 'in_use', load: live[0], live: true };

  // ── Rule 1: in a yard, it is a spare again ──────────────────────────
  // Checked after the live load, not before: a trailer loading at the
  // yard is still on that load.
  if (opts.atYard) return { status: 'idle', live: false };

  // The most recent load that is OVER. "Over" means delivered OR past
  // its window, not just past its window — a driver who delivers
  // early flips the status hours before the planned end, and treating
  // that load as neither running nor finished would blank the link
  // for the gap in between.
  const last = mine
    .filter(e => e.status === 'delivered' || e.end <= nowNaive)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!last) return { status: 'idle', live: false };

  // Needs a real tractor to link to.
  if (last.assetId == null) return { status: 'idle', live: false };
  if (opts.unassignedAssetId != null && last.assetId === opts.unassignedAssetId) {
    return { status: 'idle', live: false };
  }

  // ── Rule 3: the tractor has been retired ────────────────────────────
  if (opts.retiredAssetIds?.has(last.assetId)) return { status: 'idle', live: false };

  // ── Rule 4: age bound ───────────────────────────────────────────────
  const cutoff = new Date(nowDate);
  cutoff.setDate(cutoff.getDate() - HOOK_MAX_DAYS);
  if (last.end < naive(cutoff)) return { status: 'idle', live: false };

  // ── Rule 2: has that tractor since been given another trailer? ──────
  // (Numbered by the order the doc comment lists them, not the order
  // they run — the cheap checks go first.)
  // Measured as "the truck's most recent BEGUN load that recorded a
  // trailer", which is `last` itself unless something newer exists.
  // Two deliberate choices:
  //   - Loads with no trailerId are ignored rather than read as a
  //     drop. Only about a quarter of loads record both a truck and a
  //     trailer, so treating silence as "it let go" would make this
  //     link almost never survive.
  //   - Only loads that have STARTED count. A swap scheduled for
  //     tomorrow has not happened yet, and the link is a statement
  //     about now.
  const truckLatest = events
    .filter(e =>
      e.assetId === last.assetId &&
      !e.deletedAt &&
      !VOID_STATUSES.has(e.status ?? '') &&
      e.trailerId != null &&
      e.start <= nowNaive)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (truckLatest && truckLatest.trailerId !== trailerId) {
    return { status: 'idle', live: false };
  }

  return { status: 'in_use', load: last, live: false };
}
