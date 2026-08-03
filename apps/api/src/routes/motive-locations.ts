/**
 * GET /v1/motive/locations
 *
 * Fleet-wide current vehicle positions from Motive, for dispatch
 * surfaces (mobile Dispatch Go + web fallback). Same response shape
 * as the Next.js /api/motive/locations route on fleetcal.app, but
 * served from Railway so it isn't affected by the recurring
 * @clerk/nextjs + Next 16 `TypeError: immutable` middleware crash
 * (which makes every Vercel /api/motive/* return 503 today).
 *
 * Auth: standard Clerk JWT via the `authed` mount in index.ts.
 * Motive key: per-org `org_settings.motive_api_key`. Silently
 * returns [] when the org has no key or Motive itself errors, so a
 * transient upstream failure never breaks the caller's UI — it just
 * shows the last cached positions or a "no data" state.
 *
 * Per-org 60s cache — Motive publishes fresh positions on their
 * own ~30-60s cadence, so anything tighter just burns quota.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const motiveLocations = new Hono<{ Variables: AuthVariables }>();

interface MotiveLocation {
  vehicleId:   string;
  description: string;
  lat:         number;
  lon:         number;
  locatedAt:   string;
}

interface CachedLocations {
  locations: MotiveLocation[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, CachedLocations>();

interface MotiveVehicleRow {
  vehicle: {
    id: number;
    current_location: {
      description: string;
      lat:         number;
      lon:         number;
      located_at:  string;
    } | null;
  };
}

motiveLocations.get("/", async (c) => {
  const orgId = c.get("orgId");

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return c.json({ locations: cached.locations });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (supabase as any)
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  const apiKey = (settings as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) {
    cache.set(orgId, { locations: [], fetchedAt: Date.now() });
    return c.json({ locations: [] });
  }

  // gomotive.com is the current canonical host — keeptruckin.com still
  // works today but the rest of the codebase (motiveIngest,
  // motivePerformanceIngest) is on gomotive.com and there's no reason
  // to keep a foot on the deprecated domain.
  let res: Response;
  try {
    res = await fetch("https://api.gomotive.com/v1/vehicle_locations?per_page=100", {
      headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
    });
  } catch (err) {
    console.warn("[GET /v1/motive/locations] motive fetch failed:", err);
    return c.json({ locations: cached?.locations ?? [] });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[GET /v1/motive/locations] motive", res.status, body.slice(0, 200));
    return c.json({ locations: cached?.locations ?? [] });
  }

  const json = await res.json() as { vehicles?: MotiveVehicleRow[] };
  const locations: MotiveLocation[] = (json.vehicles ?? [])
    .filter(v => v.vehicle.current_location)
    .map(v => ({
      vehicleId:   String(v.vehicle.id),
      description: v.vehicle.current_location!.description,
      lat:         v.vehicle.current_location!.lat,
      lon:         v.vehicle.current_location!.lon,
      locatedAt:   v.vehicle.current_location!.located_at,
    }));

  cache.set(orgId, { locations, fetchedAt: Date.now() });
  return c.json({ locations });
});

export default motiveLocations;
