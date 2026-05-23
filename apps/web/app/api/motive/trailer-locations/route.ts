/**
 * GET /api/motive/trailer-locations?ids=12,34,56
 *
 * Returns the last-known location for the specified Motive trailers.
 * Used by the calendar's trailer fleet map panel.
 *
 * Motive (gomotive.com) does not expose a bulk trailer-location
 * endpoint — `/v1/assets` gives us the asset list (with metadata) but
 * not real-time GPS. To get a trailer's current coordinates we have
 * to call `/v1/assets/{asset_id}/locate` per asset. We fan out via
 * Promise.all so total wall time is roughly one Motive call, not N.
 *
 * The caller passes the Motive asset IDs it actually cares about
 * (from the linked-trailer set) so we don't waste API budget
 * locating vehicles or unmapped equipment. Bad / unknown IDs return
 * silently as "no location" — the panel handles missing pins.
 *
 * Server caches per-org for 10 minutes; the panel polls every 60s
 * client-side but the cache absorbs duplicate fetches and protects
 * Motive's rate limit.
 */
import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { key: string; locations: MotiveTrailerLocation[]; fetchedAt: number }>();

export interface MotiveTrailerLocation {
  trailerId:   string;       // Motive asset id (matches trailers.motive_vehicle_id)
  description: string;
  lat:         number;
  lon:         number;
  locatedAt:   string;
}

/** Shape returned by /v1/assets/{id}/locate — only the fields we use. */
interface MotiveLocateResponse {
  asset_location?: {
    location?:    string | null;
    lat?:         number | null;
    lon?:         number | null;
    located_at?:  string | null;
  } | null;
}

export async function GET(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Parse + dedupe + sort ids so the cache key is stable regardless of
  // the order the panel sends them in.
  const idsParam = req.nextUrl.searchParams.get('ids') ?? '';
  const ids = Array.from(new Set(
    idsParam.split(',').map(s => s.trim()).filter(Boolean)
  )).sort();
  if (!ids.length) return NextResponse.json({ locations: [] });

  const cacheKey = ids.join(',');
  const cached = cache.get(orgId);
  if (cached && cached.key === cacheKey && Date.now() - cached.fetchedAt < CACHE_TTL)
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

  // Fan out per-asset /locate calls in parallel. We swallow individual
  // failures (network blip, asset deregistered, no recent ping) so one
  // bad ID doesn't blank out the whole map.
  const results = await Promise.all(ids.map(async (id): Promise<MotiveTrailerLocation | null> => {
    try {
      const res = await fetch(`https://api.gomotive.com/v1/assets/${encodeURIComponent(id)}/locate`, {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        next: { revalidate: 0 },
      });
      if (!res.ok) {
        if (res.status !== 404)
          console.error('Motive locate error for asset', id, res.status, await res.text());
        return null;
      }
      const json = await res.json() as MotiveLocateResponse;
      const loc = json.asset_location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return null;
      return {
        trailerId:   id,
        description: loc.location ?? '',
        lat:         loc.lat,
        lon:         loc.lon,
        locatedAt:   loc.located_at ?? new Date().toISOString(),
      };
    } catch (err) {
      console.error('Motive locate fetch failed for asset', id, err);
      return null;
    }
  }));

  const locations = results.filter((r): r is MotiveTrailerLocation => r !== null);
  cache.set(orgId, { key: cacheKey, locations, fetchedAt: Date.now() });
  return NextResponse.json({ locations });
}
