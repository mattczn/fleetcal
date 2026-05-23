/**
 * GET /api/motive/trailers
 *
 * Lists all assets from the org's Motive (gomotive.com) account.
 * The /v1/assets endpoint returns the mixed fleet — vehicles AND
 * trailers/equipment side-by-side, each tagged with asset_type. We
 * pass the whole list through to the AI matcher in /match-trailers
 * which filters to trailers based on the asset_type field plus name
 * heuristics.
 *
 * Why return everything instead of filtering server-side: Motive
 * orgs sometimes register trailers with non-obvious asset_type
 * values ("Refrigerated Trailer", "Container", etc.) — letting the
 * AI inspect the full list with the type field gives it the best
 * shot at correct classification rather than us guessing at the
 * exact strings Motive uses.
 *
 * Used by the trailer-matcher in Settings → Integrations. Returns
 * 400 if motive_api_key isn't configured.
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
  type:   string | null;   // asset_type from Motive — "Trailer", "Container", "Vehicle", etc.
}

/** Raw asset shape from Motive's /v1/assets — only the fields we use. */
interface MotiveAssetRow {
  asset: {
    id:          number;
    name?:       string | null;
    asset_type?: string | null;
    properties?: {
      identifier?: string | null;
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
    res = await fetch('https://api.gomotive.com/v1/assets?per_page=100', {
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
