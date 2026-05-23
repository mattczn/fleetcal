/**
 * GET /api/motive/trailer-locations
 *
 * Returns the last-known location for every Motive-tracked trailer in
 * the org's account. Used by the calendar's trailer fleet map panel.
 *
 * Motive separates trucks from non-vehicle equipment (trailers,
 * containers, gensets). Truck locations live at /v1/vehicle_locations
 * (see ../locations/route.ts). Trailer locations live at
 * /v2/asset_locations. Each row is normalized to match the truck
 * `MotiveLocation` shape so the client can reuse the same staleness +
 * map-marker helpers.
 *
 * Server caches per-org for 10 minutes — the panel polls every 60s
 * client-side but the cache absorbs duplicate fetches and avoids
 * hammering Motive's rate limit. Same TTL pattern as the truck
 * locations endpoint.
 */
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { locations: MotiveTrailerLocation[]; fetchedAt: number }>();

export interface MotiveTrailerLocation {
  trailerId:   string;       // Motive asset id (matches trailers.motive_vehicle_id)
  description: string;
  lat:         number;
  lon:         number;
  locatedAt:   string;
}

interface MotiveAssetRow {
  asset: {
    id: number;
    current_location: {
      description: string;
      lat: number;
      lon: number;
      located_at: string;
    } | null;
  };
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL)
    return NextResponse.json({ locations: cached.locations });

  const db = getSupabaseServer();
  const { data: settingsRow, error: settingsErr } = await db
    .from('org_settings')
    .select('motive_api_key')
    .eq('org_id', orgId)
    .single();
  if (settingsErr || !settingsRow) return NextResponse.json({ locations: [] });

  const apiKey = (settingsRow as { motive_api_key: string | null }).motive_api_key;
  if (!apiKey) return NextResponse.json({ locations: [] });

  let res: Response;
  try {
    res = await fetch('https://api.keeptruckin.com/v2/asset_locations?per_page=50', {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      next: { revalidate: 0 },
    });
  } catch (err) {
    console.error('Motive trailer-locations fetch error:', err);
    return NextResponse.json({ error: 'Failed to reach Motive API' }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('Motive trailer-locations API error:', res.status, text);
    return NextResponse.json({ error: `Motive API responded ${res.status}` }, { status: 502 });
  }

  const json = await res.json() as { assets?: MotiveAssetRow[] };
  const locations: MotiveTrailerLocation[] = (json.assets ?? [])
    .filter(a => a.asset.current_location)
    .map(a => ({
      trailerId:   String(a.asset.id),
      description: a.asset.current_location!.description,
      lat:         a.asset.current_location!.lat,
      lon:         a.asset.current_location!.lon,
      locatedAt:   a.asset.current_location!.located_at,
    }));

  cache.set(orgId, { locations, fetchedAt: Date.now() });
  return NextResponse.json({ locations });
}
