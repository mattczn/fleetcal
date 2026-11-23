/**
 * Yards — saved locations that own a radius.
 *
 * A yard answers "is this trailer somewhere we know about?", which is
 * the question behind most of what a dispatcher does with the trailer
 * map: a pin in the middle of nowhere needs a phone call, a pin at the
 * SLC yard does not. Modelled as a column on saved_locations rather
 * than its own table — see the 20261123_yards migration for why.
 */
import type { SavedLocation } from './types';

/** A saved location that has a radius AND a point to centre it on.
 *  Both are required for the geofence to mean anything. */
export interface Yard extends SavedLocation {
  lat: number;
  lng: number;
  radiusMeters: number;
}

export const METRES_PER_FOOT = 0.3048;

export const feetToMetres = (ft: number): number => Math.round(ft * METRES_PER_FOOT);
export const metresToFeet = (m: number): number => Math.round(m / METRES_PER_FOOT);

/** Default for a new yard: 1,000 ft covers a typical drop lot plus the
 *  GPS slop on a trailer tracker parked between buildings. */
export const DEFAULT_YARD_RADIUS_FT = 1000;

/** Narrow a location list to the ones usable as geofences. A radius on
 *  a location that never got geocoded is inert, so it isn't a yard
 *  yet — the UI says so rather than silently ignoring it. */
export function yardsFrom(locations: SavedLocation[]): Yard[] {
  return locations.filter((l): l is Yard =>
    typeof l.radiusMeters === 'number' && l.radiusMeters > 0 &&
    typeof l.lat === 'number' && typeof l.lng === 'number',
  );
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres. Same haversine as the air-mile
 *  classifier; at yard scale the curvature is irrelevant but the
 *  formula costs nothing and avoids a second definition of distance. */
export function distanceMetres(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The yard a point sits in, or undefined. When geofences overlap the
 * NEAREST centre wins rather than the first match — a small yard drawn
 * inside a larger "whole terminal" circle should name the small one,
 * since that's the more specific answer to "where is it".
 */
export function yardAt(lat: number, lng: number, yards: Yard[]): Yard | undefined {
  let best: Yard | undefined;
  let bestDist = Infinity;
  for (const y of yards) {
    const d = distanceMetres(lat, lng, y.lat, y.lng);
    if (d <= y.radiusMeters && d < bestDist) {
      best = y;
      bestDist = d;
    }
  }
  return best;
}
