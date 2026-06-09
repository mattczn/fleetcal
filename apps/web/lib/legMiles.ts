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

/** Best-available leg miles. Prefers the cached routed value (set when
 *  the modal computed Google Directions), falls back to haversine when
 *  no cache exists yet. */
export function legMiles(event: Pick<CalendarEvent, 'stops' | 'loadedMiles'>): number {
  if (typeof event.loadedMiles === 'number' && event.loadedMiles > 0) return event.loadedMiles;
  return legStraightMiles(event);
}

/**
 * Compute the share (0..1) of a relay leg's revenue. Pass the legs in
 * either order. Falls back to 0.5 when one leg has no usable miles —
 * better than crediting the whole load to one asset and unfair to the
 * driver who hauled the other half. Uses cached routed miles when
 * available and falls back to haversine on a per-leg basis.
 */
export function relayLegShare(thisLeg: CalendarEvent, partnerLeg: CalendarEvent): number {
  const a = legMiles(thisLeg);
  const b = legMiles(partnerLeg);
  if (a + b <= 0) return 0.5;
  return a / (a + b);
}

/**
 * Total loaded miles for a load across ALL of its legs. For single-event
 * loads this is just the event's own loadedMiles. For relay loads it's
 * the sum across both legs (pickup + delivery), so RPM displays in
 * lists and on the load page use load-level miles rather than per-leg.
 *
 * Pass the list of events visible in the current view (e.g. all events
 * the page already has loaded for the date range). The function only
 * sums events that share the given event's relayGroupId — no extra
 * fetch.
 *
 * Returns null when nothing usable is available, so callers can
 * distinguish "0 miles confirmed" from "no data yet".
 */
export function loadTotalLoadedMiles(
  event:    Pick<CalendarEvent, 'loadedMiles' | 'relayGroupId'>,
  allEvents: Array<Pick<CalendarEvent, 'loadedMiles' | 'relayGroupId'>>,
): number | null {
  if (!event.relayGroupId) {
    return typeof event.loadedMiles === 'number' && event.loadedMiles > 0 ? event.loadedMiles : null;
  }
  let sum = 0;
  let any = false;
  for (const ev of allEvents) {
    if (ev.relayGroupId !== event.relayGroupId) continue;
    if (typeof ev.loadedMiles === 'number' && ev.loadedMiles > 0) { sum += ev.loadedMiles; any = true; }
  }
  return any ? sum : null;
}

/**
 * Pre-compute a relayGroupId → totalMiles map from a list of events.
 * Cheaper than calling loadTotalLoadedMiles repeatedly inside a table
 * render — the closeout + accounting RPM columns build this once per
 * render and look up per row.
 */
export function buildRelayMilesMap(
  events: Array<Pick<CalendarEvent, 'loadedMiles' | 'relayGroupId'>>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    if (!ev.relayGroupId) continue;
    if (typeof ev.loadedMiles !== 'number' || ev.loadedMiles <= 0) continue;
    out.set(ev.relayGroupId, (out.get(ev.relayGroupId) ?? 0) + ev.loadedMiles);
  }
  return out;
}
