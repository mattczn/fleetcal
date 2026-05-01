import { env } from "./env";

export interface MotiveLocation {
  vehicleId:   string;
  description: string;
  lat:         number;
  lon:         number;
  locatedAt:   string;
}

/**
 * Fetch live truck locations via the dispatch-next API.
 * Requires the user's Clerk session token (from useAuth().getToken()).
 *
 * NOTE: dispatchApiUrl in app.json must point at a reachable dispatch-next.
 * On simulator, http://localhost:3000 hits the Mac's dev server. On a real
 * device, point it at the deployed dispatch URL.
 */
export async function fetchMotiveLocations(getToken: () => Promise<string | null>): Promise<MotiveLocation[]> {
  const baseUrl = env.dispatchApiUrl;
  if (!baseUrl) return [];
  try {
    const token = await getToken();
    const res = await fetch(`${baseUrl}/api/motive/locations`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { locations?: MotiveLocation[] };
    return json.locations ?? [];
  } catch (err) {
    console.warn("fetchMotiveLocations:", err);
    return [];
  }
}

/** Haversine distance between two lat/lng points in miles. */
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
