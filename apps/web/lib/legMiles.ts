/**
 * Straight-line leg miles for revenue prorating on relay loads.
 *
 * The dashboard's revenue-by-asset chart needs to attribute a relay
 * load's price to BOTH legs in proportion to how far each one hauled.
 * Calling Google Directions for every leg in a date range would be
 * slow and expensive; haversine is a 90%-accurate approximation that
 * runs synchronously off lat/lng we already have on each stop.
 */

import type { CalendarEvent } from './types';

/** Haversine distance in miles between two lat/lng points. */
export function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Sum of consecutive-stop distances for one event. Skips stops without
 *  geocoded coordinates. Returns 0 if fewer than two coords are usable. */
export function legStraightMiles(event: Pick<CalendarEvent, 'stops'>): number {
  const pts = (event.stops ?? [])
    .filter((s): s is typeof s & { lat: number; lng: number } => s.lat != null && s.lng != null);
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += distanceMiles(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }
  return total;
}

/**
 * Compute the share (0..1) of a relay leg's revenue. Pass the legs in
 * either order. Falls back to 0.5 when one leg has no usable miles —
 * better than crediting the whole load to one asset and unfair to the
 * driver who hauled the other half.
 */
export function relayLegShare(thisLeg: CalendarEvent, partnerLeg: CalendarEvent): number {
  const a = legStraightMiles(thisLeg);
  const b = legStraightMiles(partnerLeg);
  if (a + b <= 0) return 0.5;
  return a / (a + b);
}
