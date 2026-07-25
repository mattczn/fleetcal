/**
 * Server-side route geometry cache.
 *
 * The driver/dispatch/web map views used to each call Google Directions on
 * every map open just to draw the route line. Instead we compute the route
 * ONCE — server-side, via Mapbox Directions (cheaper, already on our bill) —
 * and cache the encoded polyline on `events.route_polyline`. Map clients draw
 * the stored polyline; nobody calls Google Directions to render a route.
 *
 * Compute-on-read: the single-event / single-load detail endpoints call
 * `ensureEventRouteCached` after loading stops. It is a no-op when the cache
 * is already warm for the current stop set, cheap-computes + writes back when
 * it's cold, and self-invalidates when stops change (via `route_stops_key`).
 *
 * `geometries=polyline` returns a precision-5 encoded polyline — the exact
 * format Google Static Maps `path=enc:` wants — so mobile thumbnails can drop
 * it straight into a Static Maps URL. `overview=simplified` keeps the string
 * short (well under the Static Maps URL length cap).
 */

import type { Stop } from "@fleetcal/types";
import { env } from "./env.js";
import { supabase } from "./supabase.js";

export interface RouteGeometry {
  /** Encoded polyline (precision-5) or null when uncomputable. */
  polyline: string | null;
  /** Routed road miles (one decimal) or null. */
  miles: number | null;
}

interface CachedRoute {
  routePolyline: string | null;
  loadedMiles: number | null;
}

/** What the caller already has stored on the event row. */
interface CurrentRoute {
  routePolyline?: string | null;
  routeStopsKey?: string | null;
  loadedMiles?: number | null;
}

/** Build the stable stop signature the cache is keyed on. Rounds to ~1m so
 *  float noise on re-read doesn't invalidate a still-valid polyline. */
function stopsKey(coords: { lat: number; lng: number }[]): string {
  return coords.map((c) => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join("|");
}

/** Ordered, geocoded coordinates for an event's stops. */
function geocodedCoords(stops: Stop[]): { lat: number; lng: number }[] {
  return stops
    .filter((s): s is Stop & { lat: number; lng: number } => s.lat != null && s.lng != null)
    .map((s) => ({ lat: s.lat as number, lng: s.lng as number }));
}

/** Which leg of its load an event is: 0-based position + total legs. */
export interface LegPosition {
  legIndex: number;
  legCount: number;
}

/**
 * Stops that belong to this leg. Relay legs store the FULL merged stop
 * list on EVERY event; relay-type stops are the handoff markers — marker
 * i divides leg i from leg i+1. Leg i routes from marker i-1 (or the
 * first stop) through marker i (or the last stop), both markers included
 * as route endpoints, so each leg's `loaded_miles` reflects only the
 * distance that leg actually hauled and all legs sum to the whole load.
 * Mirrors the client's per-leg calc in EventModal.tsx so server + client
 * agree. Non-relay events (no relay stop) route through every stop
 * unchanged.
 */
function legStops(stops: Stop[], leg: LegPosition | null): Stop[] {
  const markerIdxs: number[] = [];
  stops.forEach((s, i) => {
    if (s.type === "relay") markerIdxs.push(i);
  });
  if (markerIdxs.length === 0) return stops;
  if (!leg) {
    // Relay markers present but this event isn't tagged as a leg — drop
    // the markers and route the remaining real stops.
    return stops.filter((s) => s.type !== "relay");
  }
  const startIdx = leg.legIndex <= 0 ? 0 : (markerIdxs[leg.legIndex - 1] ?? 0);
  const endIdx =
    leg.legIndex >= markerIdxs.length
      ? stops.length - 1
      : markerIdxs[leg.legIndex];
  return stops.slice(startIdx, endIdx + 1);
}

/** Call Mapbox Directions for the simplified driving route through `coords`. */
async function computeRoute(coords: { lat: number; lng: number }[]): Promise<RouteGeometry> {
  if (coords.length < 2 || !env.mapboxToken) return { polyline: null, miles: null };
  try {
    // Mapbox caps waypoints at 25 per request; a load never has that many stops.
    const path = coords.slice(0, 25).map((c) => `${c.lng},${c.lat}`).join(";");
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/${path}` +
      `?access_token=${env.mapboxToken}&overview=simplified&geometries=polyline&steps=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { polyline: null, miles: null };
    const json = (await res.json()) as { routes?: { geometry: string; distance: number }[] };
    const route = json.routes?.[0];
    if (!route) return { polyline: null, miles: null };
    return {
      polyline: route.geometry,
      miles: Math.round((route.distance / 1609.344) * 10) / 10,
    };
  } catch {
    return { polyline: null, miles: null };
  }
}

/**
 * Ensure `events.route_polyline` (and `loaded_miles`) are warm for this
 * event's current stop set, computing + writing back on a cache miss.
 * Returns the values to attach to the response so the first read after a
 * change still gets a populated polyline in the same payload.
 *
 * Safe to await on a detail endpoint: it makes at most one Mapbox call, only
 * on a miss, guarded by a 6s timeout, and never throws — on any failure it
 * returns whatever was already stored and clients fall back to their own draw.
 */
export async function ensureEventRouteCached(
  eventId: string,
  stops: Stop[],
  current: CurrentRoute,
  leg: LegPosition | null = null,
): Promise<CachedRoute> {
  const storedPolyline = current.routePolyline ?? null;
  const storedMiles = current.loadedMiles ?? null;
  const coords = geocodedCoords(legStops(stops, leg));

  // Not routable (fewer than 2 geocoded stops). Clear a stale polyline if one
  // lingers from when the event previously had coordinates; otherwise no-op.
  if (coords.length < 2) {
    if (storedPolyline != null) {
      await supabase
        .from("events")
        .update({ route_polyline: null, route_stops_key: null })
        .eq("id", eventId);
    }
    return { routePolyline: null, loadedMiles: storedMiles };
  }

  const key = stopsKey(coords);

  // Cache hit — the stored polyline was computed from exactly these stops
  // (the stored signature still matches). No Mapbox call.
  if (storedPolyline != null && current.routeStopsKey === key) {
    return { routePolyline: storedPolyline, loadedMiles: storedMiles };
  }

  const { polyline, miles } = await computeRoute(coords);
  if (polyline == null) {
    // Mapbox unavailable/failed — leave whatever we had, client falls back.
    return { routePolyline: storedPolyline, loadedMiles: storedMiles };
  }

  // Recompute refreshes BOTH the geometry and the miles from the same call so
  // a stops change keeps them in sync. Miles come free from the response.
  const nextMiles = miles ?? storedMiles;
  await supabase
    .from("events")
    .update({ route_polyline: polyline, route_stops_key: key, loaded_miles: nextMiles })
    .eq("id", eventId);

  return { routePolyline: polyline, loadedMiles: nextMiles };
}
