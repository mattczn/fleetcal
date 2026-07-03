// Mapbox geocoding and road-distance helpers (server-side only)
import { find as tzFind } from 'geo-tz';

const MAPBOX_TOKEN  = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
const GOOGLE_KEY    = process.env.GOOGLE_MAPS_API_KEY ?? '';

/**
 * Best-effort IANA timezone from lat/lng. geo-tz can THROW at runtime (its
 * data files don't reliably bundle into a serverless function on Vercel), and
 * the callers below run tzFind *inside* their return — so an unguarded throw
 * discards the whole geocode result (valid coordinates included) via the
 * surrounding catch/fall-through, which then wipes the stop's coordinates in
 * the UI. Timezone is optional; coordinates are essential — never let one take
 * the other down. Returns undefined on any failure.
 */
function safeTz(lat: number, lng: number): string | undefined {
  try { return tzFind(lat, lng)[0] ?? undefined; } catch { return undefined; }
}

export interface GeoResult {
  lat:       number;
  lng:       number;
  /** City — prefer Google's `locality`, then `postal_town`, then `sublocality`. */
  city?:     string;
  /** Two-letter state / province code from `administrative_area_level_1`. */
  state?:    string;
  timezone?: string;
}

interface GoogleAddressComponent {
  long_name:  string;
  short_name: string;
  types:      string[];
}

/**
 * Pull city + state out of Google's structured address_components in a
 * way that's stable across countries (US locality, UK postal_town, etc.).
 */
function extractCityState(components: GoogleAddressComponent[] | undefined):
  { city?: string; state?: string }
{
  if (!components?.length) return {};
  const find = (...types: string[]) =>
    components.find((c) => types.some((t) => c.types.includes(t)));
  const cityComp =
    find("locality") ??
    find("postal_town") ??
    find("sublocality_level_1") ??
    find("sublocality") ??
    find("administrative_area_level_3");
  const stateComp = find("administrative_area_level_1");
  return {
    city:  cityComp?.long_name,
    state: stateComp?.short_name,
  };
}

/** Geocode a single address string → lat/lng + city/state + IANA timezone. */
export async function geocodeAddress(address: string): Promise<GeoResult | null> {
  if (!address?.trim()) return null;
  const trimmed = address.trim();

  // 1️⃣ Google Maps Geocoding (most reliable, gives us address_components)
  if (GOOGLE_KEY) {
    try {
      const encoded = encodeURIComponent(trimmed);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${GOOGLE_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const json = await res.json() as {
          status:  string;
          results: {
            geometry:           { location: { lat: number; lng: number } };
            address_components: GoogleAddressComponent[];
          }[];
        };
        const r = json.results?.[0];
        const loc = r?.geometry?.location;
        if (loc) {
          const { city, state } = extractCityState(r?.address_components);
          return {
            lat: loc.lat, lng: loc.lng,
            city, state,
            timezone: safeTz(loc.lat, loc.lng),
          };
        }
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
          return { lat, lng, timezone: safeTz(lat, lng) };
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
        return { lat, lng, timezone: safeTz(lat, lng) };
      }
    }
  } catch { /* all failed */ }

  return null;
}

/**
 * Reverse-geocode lat/lng → city + state + timezone via Google's
 * Geocoding API. Used when we already have coordinates (existing stop
 * with no city/state, or a stop entered as raw coords) and just need
 * the address_components.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoResult | null> {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!GOOGLE_KEY) {
    // Fall back to just timezone — better than nothing.
    return { lat, lng, timezone: safeTz(lat, lng) };
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { lat, lng, timezone: safeTz(lat, lng) };
    const json = await res.json() as {
      status:  string;
      results: { address_components: GoogleAddressComponent[] }[];
    };
    const components = json.results?.[0]?.address_components;
    const { city, state } = extractCityState(components);
    return { lat, lng, city, state, timezone: safeTz(lat, lng) };
  } catch {
    return { lat, lng, timezone: safeTz(lat, lng) };
  }
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
