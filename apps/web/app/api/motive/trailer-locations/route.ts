/**
 * GET /api/motive/trailer-locations?ids=12,34,56
 *
 * Returns the last-known location for every Motive-tracked asset that
 * has a recent GPS ping, then optionally narrows to the trailer IDs
 * the caller asked about. Used by the calendar's trailer fleet map.
 *
 * Why /v1/assets and not /v1/asset_locations or /assets/{id}/locate:
 *
 *   - There IS no bulk /v1/asset_locations endpoint in Motive's API,
 *     despite the name being plausible. /v1/assets is the bulk source
 *     and it embeds `current_location` on each row (same pattern as
 *     /v1/vehicle_locations does for trucks).
 *   - /v1/assets/{id}/locate is a PUT and ASYNCHRONOUS — it pings the
 *     gateway, the actual coordinates come back 5-15 minutes later,
 *     and there's a 15-minute per-asset cooldown. That's the wrong
 *     tool for a "show me current pins" map.
 *
 * The `?ids=` query param trims the response payload to trailers the
 * panel actually cares about, but the per-org 10-minute cache stores
 * the *full* fleet response so different filtered calls share the
 * same Motive fetch.
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

/** Raw row from /v1/assets — only the fields we care about for mapping. */
interface MotiveAssetRow {
  asset: {
    id: number | string;
    /** Motive embeds the asset's most recent ping here when one exists.
     *  Trackers that haven't reported recently return null. */
    current_location?: {
      description?: string | null;
      lat?:         number | null;
      lon?:         number | null;
      located_at?:  string | null;
    } | null;
  };
}

export async function GET(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Optional filter — narrows the response payload. Cache itself is
  // unfiltered so multiple panels share one Motive call.
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
    res = await fetch('https://api.gomotive.com/v1/assets?per_page=100', {
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

  // Pull current_location out of each asset row. Rows without a
  // current_location are silently dropped — that's expected: trackers
  // that haven't pinged in a while leave the field null.
  const locations: MotiveTrailerLocation[] = (json.assets ?? [])
    .map((row): MotiveTrailerLocation | null => {
      const loc = row.asset.current_location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return null;
      return {
        trailerId:   String(row.asset.id),
        description: loc.description ?? '',
        lat:         loc.lat,
        lon:         loc.lon,
        locatedAt:   loc.located_at ?? new Date().toISOString(),
      };
    })
    .filter((l): l is MotiveTrailerLocation => l !== null);

  // Telemetry log — surfaces in Next.js logs if the panel still shows
  // empty. Tells us how many assets Motive returned vs how many had
  // a usable current_location, which is the single most diagnostic
  // signal when no pins appear.
  console.log(
    `[motive/trailer-locations] assets=${(json.assets ?? []).length} ` +
    `with-location=${locations.length} ` +
    `filter-ids=${filterIds.size || '(none)'}`
  );

  cache.set(orgId, { locations, fetchedAt: Date.now() });

  const trimmed = filterIds.size
    ? locations.filter(l => filterIds.has(l.trailerId))
    : locations;
  return NextResponse.json({ locations: trimmed });
}
