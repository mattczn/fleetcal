/**
 * "How long has this trailer been sitting there?"
 *
 * Two different alarms hide behind "is my trailer still where I left
 * it", and they need different evidence. Keeping them apart is the
 * whole point of this module:
 *
 *   DARK   — the tracker has stopped reporting. Dead gateway battery,
 *            out of coverage, or unplugged. Needs no history at all:
 *            Motive's own located_at is already old. On Curzon's fleet
 *            (measured 2026-11-23) 26 of 27 trailers had reported
 *            within 7 hours and one reefer had not reported in 21
 *            days, sitting in Coppell, TX. That one is the alarm, and
 *            it was visible before any history existed.
 *
 *   STATIC — the tracker reports fine and the position hasn't changed.
 *            This one genuinely needs stored history, because a parked
 *            trailer pings exactly like a moving one; the only
 *            difference is yesterday's coordinates.
 *
 * A trailer can be both, neither, or either. Treating them as one
 * "stale" number would mean a dark tracker in a yard looks identical
 * to a healthy trailer parked in a yard, which is the case worth
 * telling apart.
 */
import { distanceMetres } from './yards';

/**
 * How far a trailer has to be from where it was to count as having
 * moved.
 *
 * Consumer GPS on a stationary unit wanders by tens of metres between
 * fixes, so a naive "coordinates changed" test reports every parked
 * trailer as moving all day. 250 m is comfortably past that jitter and
 * comfortably short of any real relocation — a trailer shunted to the
 * far end of a big yard clears it, and a trailer that hasn't been
 * touched never does.
 */
export const MOVE_THRESHOLD_M = 250;

/** Matt's rule: flag a trailer that hasn't moved in more than 2 days
 *  so someone lays eyes on it. */
export const STILL_ALERT_DAYS = 2;

/** A tracker that hasn't reported in a day has stopped reporting.
 *  Generous on purpose: live trailers were reporting every 0–7 hours,
 *  so 24h is well outside normal rather than on its edge. */
export const DARK_ALERT_HOURS = 24;

/** One stored GPS fix. Ordered newest first by every caller. */
export interface LocationSample {
  lat:       number;
  lon:       number;
  locatedAt: string;
}

export interface Stillness {
  /**
   * When the trailer arrived where it is now — the oldest fix in the
   * unbroken run of fixes within MOVE_THRESHOLD_M of its current
   * position. Null when there are no samples at all.
   */
  parkedSinceAt: string | null;
  /**
   * Hours from parkedSinceAt until `now`. This is the number the
   * 2-day rule tests, because "hasn't moved in 3 days" is a statement
   * about wall-clock time, not about how many fixes we happened to
   * store.
   */
  stillHours: number | null;
  /**
   * The stationary run runs off the end of the history we hold, so the
   * trailer may have been parked longer than stillHours says — we
   * simply weren't watching yet. True for every trailer for the first
   * days after collection starts, which is exactly when a confident
   * "parked 4h" would be most misleading.
   */
  truncated: boolean;
  /** How many fixes backed this answer. 0 means no history yet. */
  sampleCount: number;
}

export const NO_HISTORY: Stillness = {
  parkedSinceAt: null, stillHours: null, truncated: true, sampleCount: 0,
};

/**
 * Walk back through a trailer's fixes until one is far enough from the
 * current position to count as a move.
 *
 * `samples` must be newest-first. `now` is injectable so the scenarios
 * can pin it.
 */
export function computeStillness(samples: LocationSample[], now: number = Date.now()): Stillness {
  if (samples.length === 0) return NO_HISTORY;

  const current = samples[0];
  // Index of the oldest fix still at the current position. Starts at
  // the newest, which is trivially at it.
  let oldestStill = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = distanceMetres(current.lat, current.lon, samples[i].lat, samples[i].lon);
    if (d > MOVE_THRESHOLD_M) break;
    oldestStill = i;
  }

  const parkedSinceAt = samples[oldestStill].locatedAt;
  const parkedMs = new Date(parkedSinceAt).getTime();
  return {
    parkedSinceAt,
    stillHours: Number.isFinite(parkedMs) ? Math.max(0, (now - parkedMs) / 3_600_000) : null,
    // The run reached the last sample we have, so an earlier fix at
    // the same spot may exist outside the window we read.
    truncated: oldestStill === samples.length - 1,
    sampleCount: samples.length,
  };
}

/** Hours since a fix. Null for a missing or unparseable timestamp. */
export function hoursSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

/** A trailer's tracker has gone quiet. Independent of whether it moved. */
export function isDark(lastFixAt: string | null | undefined, now: number = Date.now()): boolean {
  const h = hoursSince(lastFixAt, now);
  return h != null && h >= DARK_ALERT_HOURS;
}

/**
 * Matt's 2-day rule.
 *
 * `truncated` does NOT suppress the flag: if the history we hold says
 * it has been still for 3 days, more history could only make that
 * longer. It suppresses the opposite case — a run that is short only
 * because we started watching recently returns false, and the UI says
 * "collecting" rather than claiming the trailer just arrived.
 */
export function isStatic(s: Stillness, now: number = Date.now()): boolean {
  void now;
  return s.stillHours != null && s.stillHours >= STILL_ALERT_DAYS * 24;
}

/**
 * A LENGTH OF TIME: "3d 4h", "6h", "under 1h".
 *
 * Not an age. The two read differently in English and mixing them up
 * produces sentences like "Last fix just arrived ago", so ages go
 * through formatAge below and every caller here is describing a
 * duration — how long something lasted, not how long ago it was.
 */
export function formatStill(hours: number | null): string {
  if (hours == null) return 'unknown';
  const mins = hours * 60;
  // Minutes matter at the short end. A yard shunt is "Moved 6 mi in
  // 23m"; rounding that to an hour throws away the only interesting
  // part of the sentence.
  if (mins < 1)  return 'under a minute';
  if (mins < 60) return `${Math.round(mins)}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const d = Math.floor(hours / 24);
  const h = Math.floor(hours % 24);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** HOW LONG AGO: "just now", "41m ago", "6h ago", "3d ago". */
export function formatAge(hours: number | null): string {
  if (hours == null) return 'unknown';
  if (hours < 1 / 60) return 'just now';
  if (hours < 1)  return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * How long it has sat where it is, with the honest hedge.
 *
 * `truncated` means the stationary run reaches the oldest fix we
 * hold, so the real figure can only be longer — "≥41m" rather than a
 * confident "41m", which would be a claim we can't back.
 */
export function formatDwell(hours: number | null, truncated: boolean): string {
  if (hours == null) return 'unknown';
  return `${truncated ? '\u2265' : ''}${formatStill(hours)}`;
}
