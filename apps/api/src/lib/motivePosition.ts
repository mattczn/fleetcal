/**
 * Current vehicle position for a single asset, for the public tracking
 * portal's map and its geofence-derived status.
 *
 * Motive publishes positions on its own ~30–60s cadence and the fleet
 * endpoint returns every vehicle in one call, so this caches the whole fleet
 * per org and picks one out. The tracking route only calls this when a
 * customer actually opens a load — there is no background poll — so a quiet
 * day costs nothing and a busy one collapses onto the 60s cache.
 */

import { supabase } from "./supabase.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

export interface VehiclePosition {
  lat: number;
  lon: number;
  locatedAt: string;
  description: string;
}

interface MotiveVehicleRow {
  vehicle: {
    id: number;
    current_location: {
      description: string;
      lat: number;
      lon: number;
      located_at: string;
    } | null;
  };
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, { positions: Map<string, VehiclePosition>; fetchedAt: number }>();

async function fleetPositions(orgId: string): Promise<Map<string, VehiclePosition>> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.positions;

  const { data: settings } = await sb
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();

  const apiKey = settings?.motive_api_key;
  const positions = new Map<string, VehiclePosition>();

  if (!apiKey) {
    cache.set(orgId, { positions, fetchedAt: Date.now() });
    return positions;
  }

  try {
    const res = await fetch("https://api.gomotive.com/v1/vehicle_locations?per_page=100", {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`motive ${res.status}`);

    const json = (await res.json()) as { vehicles?: MotiveVehicleRow[] };
    for (const row of json.vehicles ?? []) {
      const loc = row.vehicle.current_location;
      if (!loc) continue;
      positions.set(String(row.vehicle.id), {
        lat: loc.lat,
        lon: loc.lon,
        locatedAt: loc.located_at,
        description: loc.description,
      });
    }
  } catch (err) {
    // A transient Motive failure must never break the tracking page — the
    // customer just sees the map without a truck on it.
    console.warn("[motivePosition] fetch failed:", err);
    return cached?.positions ?? positions;
  }

  cache.set(orgId, { positions, fetchedAt: Date.now() });
  return positions;
}

/** Position for one asset, or null if the truck has no Motive mapping, the
 *  org has no key, or Motive is unreachable. */
export async function positionForAsset(
  orgId: string,
  assetId: number
): Promise<VehiclePosition | null> {
  const { data: asset } = await sb
    .from("assets")
    .select("motive_vehicle_id")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();

  const vehicleId = asset?.motive_vehicle_id;
  if (!vehicleId) return null;

  const positions = await fleetPositions(orgId);
  return positions.get(String(vehicleId)) ?? null;
}

/** Great-circle distance in miles. */
export function milesBetween(
  aLat: number, aLon: number,
  bLat: number, bLon: number
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
