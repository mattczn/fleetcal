const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export interface DirectionsResult {
  miles: number;
  durationSeconds: number;
}

/** Calculate road distance + duration between ordered lat/lng waypoints via Mapbox Directions. */
export async function calcRoadMiles(
  waypoints: { lat: number; lng: number }[],
): Promise<number | null> {
  const result = await calcDirections(waypoints);
  return result?.miles ?? null;
}

export async function calcDirections(
  waypoints: { lat: number; lng: number }[],
): Promise<DirectionsResult | null> {
  if (waypoints.length < 2 || !MAPBOX_TOKEN) return null;
  try {
    const coords = waypoints.slice(0, 25).map(w => `${w.lng},${w.lat}`).join(';');
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${MAPBOX_TOKEN}&overview=false&steps=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const json = await res.json() as { routes?: { distance: number; duration: number }[] };
    const route = json.routes?.[0];
    if (route == null) return null;
    return {
      miles:           Math.round((route.distance / 1609.344) * 10) / 10,
      durationSeconds: Math.round(route.duration),
    };
  } catch {
    return null;
  }
}
