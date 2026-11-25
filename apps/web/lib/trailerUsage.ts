/**
 * Trailer usage resolution.
 *
 * Answers two questions that used to be one:
 *
 *   status  — in_use or idle. Is this trailer working?
 *   truck   — WHICH tractor has it, and how we know.
 *
 * They were one field because the truck was read off the load: the
 * last load naming the trailer also named a tractor, so that tractor
 * was said to have it. Measured against live Motive positions on
 * 2026-11-25 that was wrong for 13 of Curzon's 14 linked trailers —
 * #402595 was shown behind CT-2020 while CT-2020 sat 370 miles away
 * in Henderson and P-C412863 was 0.1 miles from the trailer. Loads get
 * swapped mid-route constantly and nobody retypes the dispatch record,
 * so the record says who was SUPPOSED to pull it, which is a different
 * fact from who has it. See lib/trailerPairing.ts for the measurement.
 *
 * SO: GPS decides, and the sources are ranked.
 *
 *   1. MANUAL   — somebody said so on the trailers page. Outranks
 *                 everything and holds until it is changed or cleared;
 *                 a human standing in the yard beats both derivations.
 *   2. GPS      — exactly one truck is standing with the trailer. At a
 *                 yard, where six trucks and six trailers sit at zero
 *                 distance from each other, proximity cannot say which
 *                 is under which, so nothing is claimed.
 *   3. DISPATCH — only when GPS has no opinion: no fix, or a tracker
 *                 that has gone dark. The old derivation, below,
 *                 unchanged, including the four things that end a
 *                 link.
 *
 * WHY A FINISHED LOAD STILL COUNTS (the dispatch path). A load ending
 * does not unhook a trailer; a driver does, by dropping it. Deriving
 * the link purely from "is a load running" unlinked every trailer the
 * moment its load's window closed — wrong for the many hours between
 * a delivery and the next dispatch. So the link survives the load and
 * is ended only by the things that actually end it:
 *
 *   1. The trailer is inside one of our yards. It has been dropped
 *      and it is accounted for. (Caller's call — see `atYard`.)
 *   2. That tractor's own most recent begun load names a DIFFERENT
 *      trailer. The truck has moved on, so the link is stale.
 *   3. That tractor has been retired.
 *   4. The load ended more than HOOK_MAX_DAYS ago. Not a claim about
 *      trucks — a bound on how long a guess is worth repeating.
 *
 * `live` says whether the load on the result is running right now.
 * Callers use it to avoid quoting a finished load's route as where the
 * trailer is heading. Note that `load` is CONTEXT — what the trailer
 * is on or just came off — and is no longer where the truck comes
 * from, so a result can name a truck from GPS and a load dispatched to
 * a different one. That pair is not a contradiction; it is the swap,
 * finally visible.
 */
import type { CalendarEvent } from '@/lib/types';
import { nowInTz } from '@/lib/time-utils';
import type { PhysicalPairing } from './trailerPairing';

export type TrailerStatus = 'in_use' | 'idle';

/** Where the named truck came from. Absent when no truck is named. */
export type LinkSource = 'manual' | 'gps' | 'dispatch';

/** The common case: usage resolved against the store's CalendarEvent. */
export type TrailerUsage = TrailerUsageResult<CalendarEvent>;

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

export interface TrailerUsageResult<E> {
  status: TrailerStatus;
  /** The tractor that has it. Absent when nothing does — including a
   *  trailer that is working but standing on its own, which happens
   *  when it has been dropped at a receiver mid-load. */
  truckAssetId?: number;
  /** How we know. Absent exactly when truckAssetId is. */
  source?: LinkSource;
  /** The load the trailer is on, or the one it just came off.
   *  CONTEXT — not the source of truckAssetId unless source is
   *  'dispatch'. */
  load?: E;
  /** The tractor that load was dispatched to, when it differs from
   *  truckAssetId. This is the swap, and the UI can say so. */
  dispatchedAssetId?: number;
  /** True when `load` is running RIGHT NOW. */
  live: boolean;
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
  /** Tractors retired as of today (assets.activeTo in the past). */
  retiredAssetIds?: ReadonlySet<number>;
  /** What GPS says is standing with this trailer. Omitted means GPS
   *  has no opinion, which is also what resolvePhysicalPairing returns
   *  for a trailer with no fix — so leaving it out gives exactly the
   *  dispatch-only behaviour this module had before. */
  physical?: PhysicalPairing;
  /** A tractor somebody assigned by hand. Outranks both derivations
   *  and holds until changed or cleared. */
  manualAssetId?: number | null;
}

/**
 * How long a finished load keeps claiming its trailer, on the
 * dispatch path.
 *
 * Seven days is generous for the case this is for (a load that ended
 * hours ago) and short enough that a trailer sitting at a customer
 * for a fortnight stops naming a truck that has long since pulled
 * something else. It also matches the window the calendar store
 * guarantees it has loaded (±7 days around today).
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
): TrailerUsageResult<E> {
  const nowDate  = orgTz ? nowInTz(orgTz) : new Date();
  const nowNaive = naive(nowDate);

  const mine = events.filter(e =>
    e.trailerId === trailerId &&
    !e.deletedAt &&
    !VOID_STATUSES.has(e.status ?? ''));

  // If several loads qualify as live (rare — overlapping dispatch),
  // the earliest start wins, so the user sees the load actually
  // running now rather than a freshly-assigned one.
  const liveLoad = mine
    .filter(e => !INACTIVE_STATUSES.has(e.status ?? ''))
    .filter(e => e.start <= nowNaive && nowNaive <= e.end)
    .sort((a, b) => a.start.localeCompare(b.start))[0];

  // The most recent load that is OVER. "Over" means delivered OR past
  // its window, not just past its window — a driver who delivers early
  // flips the status hours before the planned end, and treating that
  // load as neither running nor finished would blank the link for the
  // gap in between.
  const lastOver = mine
    .filter(e => e.status === 'delivered' || e.end <= nowNaive)
    .sort((a, b) => b.end.localeCompare(a.end))[0];

  const context = liveLoad ?? lastOver;
  const physical: PhysicalPairing = opts.physical ?? { kind: 'unknown', reason: 'no_fix' };
  const gpsTruck = physical.kind === 'with' ? physical.assetId : undefined;

  /** The tractor a load names, once the things that make it not a
   *  real tractor are filtered out. */
  const tractorOf = (e: E | undefined): number | undefined => {
    if (!e || e.assetId == null) return undefined;
    if (opts.unassignedAssetId != null && e.assetId === opts.unassignedAssetId) return undefined;
    return e.assetId;
  };
  const dispatchedAssetId = tractorOf(context);

  const result = (
    truckAssetId: number | undefined,
    source: LinkSource | undefined,
    status: TrailerStatus,
    withContext = true,
  ): TrailerUsageResult<E> => ({
    status,
    truckAssetId,
    source: truckAssetId == null ? undefined : source,
    load: withContext ? context : undefined,
    dispatchedAssetId:
      withContext && dispatchedAssetId != null && dispatchedAssetId !== truckAssetId
        ? dispatchedAssetId
        : undefined,
    live: withContext && !!liveLoad,
  });

  // ── 1. A human said so ──────────────────────────────────────────────
  if (opts.manualAssetId != null) {
    return result(opts.manualAssetId, 'manual', 'in_use');
  }

  // ── 2. A load running right now ─────────────────────────────────────
  // The trailer is working whatever GPS thinks, and a trailer being
  // loaded at the yard is still on that load — so this sits above the
  // yard rule, as it always has. GPS still decides WHO has it, and may
  // honestly say nobody: a trailer dropped at a receiver mid-load is
  // in use with no tractor attached.
  if (liveLoad) {
    if (gpsTruck != null)               return result(gpsTruck, 'gps', 'in_use');
    if (physical.kind === 'unknown')    return result(tractorOf(liveLoad), 'dispatch', 'in_use');
    return result(undefined, undefined, 'in_use');
  }

  // ── 3. In a yard, it is a spare again ───────────────────────────────
  // Above GPS deliberately. Trucks park next to trailers they are not
  // pulling all day at the yard, so proximity there is not evidence of
  // a hookup — it is evidence of a car park.
  if (opts.atYard) return result(undefined, undefined, 'idle', false);

  // ── 4. GPS ──────────────────────────────────────────────────────────
  if (physical.kind === 'with')      return result(physical.assetId, 'gps', 'in_use');
  // Nothing with it, or a yard-like huddle nobody can resolve. Either
  // way no truck has it, and claiming one would be the old bug.
  if (physical.kind === 'alone')     return result(undefined, undefined, 'idle', false);
  if (physical.kind === 'ambiguous') return result(undefined, undefined, 'idle', false);

  // ── 5. Dispatch, when GPS has no opinion ────────────────────────────
  if (!lastOver) return result(undefined, undefined, 'idle', false);

  const tractor = tractorOf(lastOver);
  if (tractor == null) return result(undefined, undefined, 'idle', false);

  // Rule 3: the tractor has been retired.
  if (opts.retiredAssetIds?.has(tractor)) return result(undefined, undefined, 'idle', false);

  // Rule 4: age bound.
  const cutoff = new Date(nowDate);
  cutoff.setDate(cutoff.getDate() - HOOK_MAX_DAYS);
  if (lastOver.end < naive(cutoff)) return result(undefined, undefined, 'idle', false);

  // Rule 2: has that tractor since been given another trailer?
  // Measured as "the truck's most recent BEGUN load that recorded a
  // trailer". Two deliberate choices:
  //   - Loads with no trailerId are ignored rather than read as a
  //     drop. Only about a quarter of loads record both a truck and a
  //     trailer, so treating silence as "it let go" would make this
  //     link almost never survive.
  //   - Only loads that have STARTED count. A swap scheduled for
  //     tomorrow has not happened yet, and the link is about now.
  const truckLatest = events
    .filter(e =>
      e.assetId === tractor &&
      !e.deletedAt &&
      !VOID_STATUSES.has(e.status ?? '') &&
      e.trailerId != null &&
      e.start <= nowNaive)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (truckLatest && truckLatest.trailerId !== trailerId) {
    return result(undefined, undefined, 'idle', false);
  }

  return result(tractor, 'dispatch', 'in_use');
}
