/**
 * GET /api/motive/trailer-locations?ids=12,34,56
 *
 * Returns the last-known location for every Motive-tracked asset, then
 * narrows to the trailer IDs the caller asked about. Used by the
 * calendar's trailer fleet map panel.
 *
 * One bulk call to `GET https://api.gomotive.com/v1/asset_locations`
 * rather than per-asset `/locate` fan-out — Motive returns the whole
 * fleet's last-known coordinates in a single response, so we map by
 * our stored motive_vehicle_id rather than burn one HTTP call per
 * trailer. The `?ids=` query param is still honored to trim the
 * response payload to trailers the panel actually cares about.
 *
 * Server caches per-org for 10 minutes; the panel polls every 60s
 * client-side but the cache absorbs duplicate fetches and protects
 * Motive's rate limit.
 */
import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
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

/**
 * Motive's /v1/asset_locations response shape — defensively typed
 * because Motive's docs aren't always exact about field names and
 * different account tiers / asset categories occasionally surface
 * slightly different envelopes. We accept either:
 *   - { asset_locations: [{ asset: { id, current_location: {...} } }] }
 *   - { asset_locations: [{ id, lat, lon, located_at, location }] }
 * and pluck whichever shape is present.
 */
interface MotiveAssetLocationsResponse {
  asset_locations?: Array<{
    /** Nested-asset envelope (mirrors /v1/assets shape). */
    asset?: {
      id?:               number | string;
      current_location?: {
        location?:   string | null;
        lat?:        number | null;
        lon?:        number | null;
        located_at?: string | null;
      } | null;
    } | null;
    /** Flat envelope — id + coordinates on the row itself. */
    id?:         number | string;
    location?:   string | null;
    lat?:        number | null;
    lon?:        number | null;
    located_at?: string | null;
  }>;
}

export async function GET(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Optional filter — when present, the response is trimmed to just
  // these IDs. The cache itself stores the *full* fleet response so
  // different panels (each asking for a different subset of IDs) all
  // share the same Motive call.
  const idsParam = req.nextUrl.searchParams.get('ids') ?? '';
  const filterIds = new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean));

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    const trimmed = filterIds.size
      ? cached.locations.filter(l => filterIds.has(l.trailerId))
      : cached.locations;
    return NextResponse.json({ locations: trimmed });
  }

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
    res = await fetch('https://api.gomotive.com/v1/asset_locations?per_page=100', {
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

  const json = await res.json() as MotiveAssetLocationsResponse;

  // Normalize whichever envelope Motive returned into a flat list. We
  // skip rows missing coordinates (Motive returns the row even if the
  // tracker hasn't pinged in a while) so the map only shows pins we
  // can actually plot.
  const locations: MotiveTrailerLocation[] = (json.asset_locations ?? [])
    .map((row): MotiveTrailerLocation | null => {
      const nested = row.asset?.current_location ?? null;
      const id = row.asset?.id ?? row.id;
      const lat = nested?.lat ?? row.lat;
      const lon = nested?.lon ?? row.lon;
      const description = nested?.location ?? row.location ?? '';
      const locatedAt   = nested?.located_at ?? row.located_at ?? new Date().toISOString();
      if (id == null || typeof lat !== 'number' || typeof lon !== 'number') return null;
      return {
        trailerId: String(id),
        description: description ?? '',
        lat,
        lon,
        locatedAt,
      };
    })
    .filter((l): l is MotiveTrailerLocation => l !== null);

  cache.set(orgId, { locations, fetchedAt: Date.now() });

  const trimmed = filterIds.size
    ? locations.filter(l => filterIds.has(l.trailerId))
    : locations;
  return NextResponse.json({ locations: trimmed });
}
