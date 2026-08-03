import { env } from "./env";

export interface MotiveLocation {
  vehicleId:   string;
  description: string;
  lat:         number;
  lon:         number;
  locatedAt:   string;
}

/**
 * Fetch live truck locations via the Railway API.
 * Requires the user's Clerk session token (from useAuth().getToken()).
 *
 * Was previously routed through the fleetcal.app Next.js edge
 * middleware, which recurrently crashes with `TypeError: immutable`
 * from @clerk/nextjs and 503s every /api/motive/* call. Railway
 * uses Hono's Clerk JWT validator (not @clerk/nextjs) so it isn't
 * affected. Falls back to dispatchApiUrl only if railwayApiUrl
 * isn't configured, so old bundles still work.
 */
export async function fetchMotiveLocations(getToken: () => Promise<string | null>): Promise<MotiveLocation[]> {
  const railwayUrl = env.railwayApiUrl;
  const fallbackUrl = env.dispatchApiUrl;
  const useRailway = !!railwayUrl;
  const baseUrl = useRailway ? railwayUrl : fallbackUrl;
  if (!baseUrl) return [];
  const path = useRailway ? "/v1/motive/locations" : "/api/motive/locations";
  try {
    const token = await getToken();
    const res = await fetch(`${baseUrl}${path}`, {
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
