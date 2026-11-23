/**
 * Short-haul (150 air-mile) geometry — the primitives, shared.
 *
 * 49 CFR 395.1(e)(1) exempts a driver from keeping a record of duty
 * status while they operate within a 150 AIR-mile radius of their
 * normal work reporting location. Air miles, not road miles: it is a
 * straight-line radius, so a 200-mile drive that loops back stays
 * inside it while a 160-mile straight shot does not.
 *
 * This file holds only what BOTH the server and the browser need: the
 * radius, the distance function, and a coordinate guard. The richer
 * shift classifier — the one that reasons about ungeocoded stops and
 * refuses to decide on no data — stays in apps/api/src/lib/airMiles.ts
 * and imports these, so there is exactly one definition of the radius
 * and one of the distance maths in the monorepo.
 *
 * Why the browser needs it at all: the calendar outlines OTR legs, and
 * calendar stops already carry lat/lng. Classifying client-side means
 * the outline re-evaluates as a dispatcher edits stops, instead of
 * going stale against a value computed at fetch time.
 *
 * Pure: no I/O, no clock reads.
 */

/** Mean Earth radius in statute miles. An air mile IS a statute mile;
 *  the "air" only signifies straight-line rather than road distance. */
const EARTH_RADIUS_MILES = 3958.7613;

/** §395.1(e)(1)(i). 150 air miles ≈ 172.6 statute road miles. */
export const SHORT_HAUL_RADIUS_MILES = 150;

export interface Coord {
  lat: number;
  lon: number;
}

export function isUsableCoord(c: Partial<Coord> | null | undefined): c is Coord {
  if (!c) return false;
  const { lat, lon } = c;
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  // Null Island is what a failed geocode looks like, not a real stop.
  return !(lat === 0 && lon === 0);
}

/**
 * Great-circle distance in statute miles.
 *
 * Haversine rather than the simpler equirectangular approximation:
 * across the distances that matter here (100–200 miles at ~40°N) the
 * flat approximation drifts by a couple of miles, which is precisely
 * the margin that decides whether a shift crosses the 150-mile line.
 */
export function airMilesBetween(a: Coord, b: Coord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The org's home terminal, projected out of org_settings.hos_settings
 *  for clients that classify work against the radius themselves.
 *  Read-only: the HOS screen owns these values, this is a view. */
export interface ShortHaulTerminal {
  lat: number;
  lon: number;
  label?: string;
  /** Carried on the payload rather than hardcoded client-side, so the
   *  radius has one source even if it ever becomes per-org. */
  radiusMiles: number;
}

/**
 * Does any of these points fall outside the radius?
 *
 * Returns null when nothing was measurable — no points, or none
 * geocoded. Null is NOT "local": "this leg has no stops yet" and "this
 * leg stays close to home" must not render the same, or an un-geocoded
 * load would quietly pass for local work that owes no log.
 */
export function isOtrByAirMiles(
  terminal: Coord,
  points: Array<Partial<Coord> | null | undefined>,
  radiusMiles: number = SHORT_HAUL_RADIUS_MILES,
): boolean | null {
  let decided = false;
  let otr = false;
  for (const p of points) {
    if (!isUsableCoord(p)) continue;
    decided = true;
    if (airMilesBetween(terminal, p) > radiusMiles) { otr = true; break; }
  }
  return decided ? otr : null;
}
