/**
 * GET /api/motive/trailers
 *
 * Lists trailers / non-vehicle equipment from the org's Motive
 * (KeepTruckin) account. Motive separates these from trucks: the
 * truck endpoint is /vehicle_locations (or /vehicles), and trailers
 * sit at /v2/assets where `asset_type` distinguishes trailer vs other
 * equipment.
 *
 * Used by the trailer-matcher in Settings → Integrations to suggest
 * which calendar trailer maps to which Motive asset. The shape is
 * normalized to match what the vehicles endpoint returns so the same
 * AI match prompt structure can be reused.
 *
 * Returns { trailers: MotiveTrailer[] }. Returns 400 when the org
 * has no motive_api_key configured (matches the vehicles route's
 * behavior).
 */
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

export interface MotiveTrailer {
  id:     string;
  number: string;
  year:   number | null;
  make:   string | null;
  model:  string | null;
  type:   string | null;   // Motive's asset_type — "Trailer", "Container", etc.
}

/** Raw asset shape from Motive's /v2/assets — the part we care about. */
interface MotiveAssetRow {
  asset: {
    id:          number;
    name?:       string | null;
    asset_type?: string | null;   // e.g. "Trailer", "Container"
    properties?: {
      identifier?: string | null;  // unit number (we map to .number)
      year?:       number | null;
      make?:       string | null;
      model?:      string | null;
    } | null;
  };
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getSupabaseServer();
  const { data: row } = await db
    .from('org_settings')
    .select('motive_api_key')
    .eq('org_id', orgId)
    .single();
  const apiKey = (row as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) return NextResponse.json({ error: 'Motive not configured' }, { status: 400 });

  let res: Response;
  try {
    // Motive's assets endpoint. asset_type=Trailer would filter to
    // only trailers; leave broad so reefers/containers/whatever the
    // user tags them as also surface. The matcher's AI step pairs by
    // unit number anyway.
    res = await fetch('https://api.keeptruckin.com/v2/assets?per_page=50', {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      next: { revalidate: 0 },
    });
  } catch (err) {
    console.error('Motive trailers fetch error:', err);
    return NextResponse.json({ error: 'Failed to reach Motive API' }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('Motive trailers API error:', res.status, text);
    return NextResponse.json({ error: `Motive API responded ${res.status}` }, { status: 502 });
  }

  const json = await res.json() as { assets?: MotiveAssetRow[] };
  const trailers: MotiveTrailer[] = (json.assets ?? []).map(a => ({
    id:     String(a.asset.id),
    number: a.asset.properties?.identifier ?? a.asset.name ?? '',
    year:   a.asset.properties?.year   ?? null,
    make:   a.asset.properties?.make   ?? null,
    model:  a.asset.properties?.model  ?? null,
    type:   a.asset.asset_type         ?? null,
  }));

  return NextResponse.json({ trailers });
}
