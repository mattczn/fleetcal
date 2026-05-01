// Mapbox geocoding and road-distance helpers (server-side only)
import { find as tzFind } from 'geo-tz';

const MAPBOX_TOKEN  = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
const GOOGLE_KEY    = process.env.GOOGLE_MAPS_API_KEY ?? '';

export interface GeoResult {
  lat: number;
  lng: number;
  timezone?: string;
}

/** Geocode a single address string → lat/lng + IANA timezone. Returns null on failure. */
export async function geocodeAddress(address: string): Promise<GeoResult | null> {
  if (!address?.trim()) return null;
  const trimmed = address.trim();

  // 1️⃣ Google Maps Geocoding (most reliable)
  if (GOOGLE_KEY) {
    try {
      const encoded = encodeURIComponent(trimmed);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = await res.json() as { status: string; results: { geometry: { location: { lat: number; lng: number } } }[] };
        const loc = json.results?.[0]?.geometry?.location;
        if (loc) return { lat: loc.lat, lng: loc.lng, timezone: tzFind(loc.lat, loc.lng)[0] ?? undefined };
      }
    } catch { /* fall through */ }
  }

  // 2️⃣ Mapbox fallback
  if (MAPBOX_TOKEN) {
    try {
      const encoded = encodeURIComponent(trimmed);
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${MAPBOX_TOKEN}&country=US,CA,MX&limit=1&types=address,place`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = await res.json() as { features?: { center: [number, number] }[] };
        const center = json.features?.[0]?.center;
        if (center) {
          const [lng, lat] = center;
          return { lat, lng, timezone: tzFind(lat, lng)[0] ?? undefined };
        }
      }
    } catch { /* fall through */ }
  }

  // 3️⃣ Nominatim (OpenStreetMap) last resort
  try {
    const encoded = encodeURIComponent(trimmed);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=us,ca,mx`;
    const res = await fetch(url, { headers: { 'User-Agent': 'DispatchApp/1.0' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json() as { lat: string; lon: string }[];
      if (json[0]) {
        const lat = parseFloat(json[0].lat);
        const lng = parseFloat(json[0].lon);
        return { lat, lng, timezone: tzFind(lat, lng)[0] ?? undefined };
      }
    }
  } catch { /* all failed */ }

  return null;
}

/**
 * Calculate road distance in miles between ordered waypoints using Mapbox Directions.
 * Returns null if fewer than 2 geocoded points or the API fails.
 */
export async function calcRoadMiles(
  waypoints: GeoResult[],
): Promise<number | null> {
  if (waypoints.length < 2 || !MAPBOX_TOKEN) return null;

  try {
    // Mapbox Directions supports up to 25 waypoints
    const coords = waypoints
      .slice(0, 25)
      .map(w => `${w.lng},${w.lat}`)
      .join(';');

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${MAPBOX_TOKEN}&overview=false&steps=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json() as { routes?: { distance: number }[] };
    const meters = json.routes?.[0]?.distance;
    if (meters == null) return null;
    return Math.round((meters / 1609.344) * 10) / 10; // meters → miles, 1 decimal
  } catch {
    return null;
  }
}

/**
 * Geocode an array of addresses concurrently with a concurrency cap.
 * Returns results in the same order; null entries indicate geocoding failure.
 */
export async function geocodeAll(
  addresses: (string | undefined)[],
  concurrency = 4,
): Promise<(GeoResult | null)[]> {
  const results: (GeoResult | null)[] = new Array(addresses.length).fill(null);

  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(addr => addr ? geocodeAddress(addr) : Promise.resolve(null)),
    );
    settled.forEach((r, j) => { results[i + j] = r; });
  }

  return results;
}
