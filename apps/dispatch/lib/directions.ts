import { env } from "./env";

/**
 * Calculate the road distance in miles between ordered lat/lng waypoints
 * via the Google Directions API. Returns null on error or missing key.
 */
export async function calcRoadMiles(waypoints: { lat: number; lng: number }[]): Promise<number | null> {
  const key = env.googleMapsKey;
  if (!key || waypoints.length < 2) return null;
  try {
    const origin      = `${waypoints[0].lat},${waypoints[0].lng}`;
    const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;
    const middle      = waypoints.slice(1, -1).map((w) => `${w.lat},${w.lng}`).join("|");
    const params = new URLSearchParams({
      origin, destination,
      mode: "driving",
      key,
    });
    if (middle) params.set("waypoints", middle);
    const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`);
    const data = await res.json() as {
      routes?: { legs?: { distance?: { value: number } }[] }[];
    };
    const legs = data.routes?.[0]?.legs;
    if (!legs || legs.length === 0) return null;
    const meters = legs.reduce((sum, l) => sum + (l.distance?.value ?? 0), 0);
    return Math.round((meters / 1609.344) * 10) / 10;
  } catch (err) {
    console.warn("calcRoadMiles:", err);
    return null;
  }
}
