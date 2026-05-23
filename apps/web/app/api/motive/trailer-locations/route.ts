/**
 * GET /api/motive/trailer-locations?ids=12,34,56
 *
 * Returns the last-known GPS location of every Motive-tracked trailer,
 * then optionally narrows to the IDs the caller asked about. Used by
 * the calendar's trailer fleet map panel.
 *
 * IMPORTANT — endpoint host and shape, both verified against the
 * working Python implementation in the my-calendar repo:
 *
 *   URL:  https://api.keeptruckin.com/v1/asset_locations?per_page=100
 *
 * The keeptruckin.com host (NOT api.gomotive.com) is what Motive's
 * bulk asset_locations endpoint lives behind — same legacy host as the
 * working /v1/vehicle_locations endpoint. The gomotive.com host serves
 * the asset *metadata* endpoint (/v1/assets) but does not have a bulk
 * locations route.
 *
 * Response shape (NOT the same as /v1/assets — the GPS lives nested
 * under asset_gateway.last_location, with the address field called
 * `address` (sometimes `formatted_address`) rather than `description`):
 *
 *   {
 *     "assets": [{
 *       "asset": {
 *         "id": 12345,
 *         "asset_gateway": {
 *           "last_location": {
 *             "lat": 41.86, "lon": -87.65,
 *             "address": "...", "located_at": "2026-05-23T...Z",
 *             "moving": false
 *           }
 *         }
 *       }
 *     }, ...]
 *   }
 *
 * Server caches per-org for 10 minutes; ?ids= filter trims the
 * response payload but the cache holds the full fleet so multiple
 * panels share one Motive call.
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
  moving?:     boolean;
}

/** Row shape from /v1/asset_locations. */
interface MotiveAssetRow {
  asset: {
    id: number | string;
    asset_gateway?: {
      last_location?: {
        address?:           string | null;
        formatted_address?: string | null;
        lat?:               number | null;
        lon?:               number | null;
        located_at?:        string | null;
        moving?:            boolean;
      } | null;
    } | null;
  };
}

export async function GET(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    res = await fetch('https://api.keeptruckin.com/v1/asset_locations?per_page=100', {
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

  // Pull last_location off each asset_gateway. Rows without coords get
  // dropped (tracker offline / never reported). Address falls back
  // from `address` → `formatted_address` → ''.
  const locations: MotiveTrailerLocation[] = (json.assets ?? [])
    .map((row): MotiveTrailerLocation | null => {
      const loc = row.asset.asset_gateway?.last_location;
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return null;
      return {
        trailerId:   String(row.asset.id),
        description: loc.address ?? loc.formatted_address ?? '',
        lat:         loc.lat,
        lon:         loc.lon,
        locatedAt:   loc.located_at ?? new Date().toISOString(),
        moving:      loc.moving ?? false,
      };
    })
    .filter((l): l is MotiveTrailerLocation => l !== null);

  // Telemetry — surfaces in Next.js logs so empty-map cases are
  // diagnosable. Shows raw asset count, count with usable GPS, and
  // how many IDs the caller filtered on.
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
