/**
 * Fetch a driving polyline through ordered lat/lng waypoints using Google Directions.
 * Decodes Google's encoded polyline string (same algorithm as Mapbox default).
 *
 * Set EXPO_PUBLIC_GOOGLE_MAPS_API_KEY in .env.local. Make sure the key has the
 * "Directions API" enabled in the Google Cloud console and isn't HTTP-referer
 * restricted (mobile clients have no referer).
 */
const GOOGLE_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

export interface RoutePolyline {
  coords: { latitude: number; longitude: number }[];
  miles:  number;
}

/**
 * Decode a Google encoded polyline string into [lat,lng] pairs.
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function decodePolyline(encoded: string): { latitude: number; longitude: number }[] {
  const out: { latitude: number; longitude: number }[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let result = 0, shift = 0, b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    result = 0; shift = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    out.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return out;
}

export async function fetchRoadPolyline(
  waypoints: { lat: number; lng: number }[],
): Promise<RoutePolyline | null> {
  if (waypoints.length < 2 || !GOOGLE_KEY) return null;
  try {
    const origin      = `${waypoints[0].lat},${waypoints[0].lng}`;
    const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
    const intermediate = waypoints.slice(1, -1).map((w) => `${w.lat},${w.lng}`).join("|");

    const params = new URLSearchParams({
      origin,
      destination,
      mode: "driving",
      key:  GOOGLE_KEY,
    });
    if (intermediate) params.set("waypoints", intermediate);

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status: string;
      routes?: {
        overview_polyline: { points: string };
        legs: { distance: { value: number } }[];
      }[];
    };
    if (json.status !== "OK") {
      console.warn("Google Directions status:", json.status);
      return null;
    }
    const route = json.routes?.[0];
    if (!route) return null;

    const totalMeters = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
    return {
      coords: decodePolyline(route.overview_polyline.points),
      miles:  Math.round((totalMeters / 1609.344) * 10) / 10,
    };
  } catch (err) {
    console.error("fetchRoadPolyline:", err);
    return null;
  }
}
