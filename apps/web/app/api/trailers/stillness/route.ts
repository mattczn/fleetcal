/**
 * GET /api/trailers/stillness
 *
 * How long each trailer has been sitting where it is, derived from the
 * trailer_location_samples history that the hourly sweep in apps/api
 * writes. Paired with the live positions from
 * /api/motive/trailer-locations, which answer "where" and "was the
 * tracker heard from recently" but cannot answer "for how long".
 *
 * WINDOW. Reads LOOKBACK_DAYS of history. A park longer than the
 * window comes back with truncated=true rather than a wrong number —
 * the honest answer is "at least this long". Same flag covers the
 * first days after collection starts, when every trailer's run runs
 * off the end of the data.
 *
 * PAGINATION IS NOT OPTIONAL. PostgREST silently caps a response at
 * 1000 rows, so a .limit() above that is a lie and the failure mode is
 * not a short list — it is a confident wrong answer, because dropping
 * the OLDEST samples shortens every park. ~27 trailers x ~5 fixes a
 * day x 21 days is roughly 2,800 rows, already past the cap on day
 * one. Hence the explicit pager, ordered by id so pages can't overlap
 * or skip.
 */
import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { computeStillness, type LocationSample, type Stillness } from '@/lib/trailerStillness';

const LOOKBACK_DAYS = 21;
const PAGE = 1000;
const CACHE_TTL = 5 * 60 * 1000;

interface Payload {
  /** Keyed by trailers.id as a string, for JSON. */
  stillness: Record<string, Stillness>;
  /**
   * Oldest fix in the window, across the fleet. The UI uses this to
   * say "still collecting" instead of showing confident short parks
   * in the first 48 hours after the sweep goes live.
   */
  historyStartedAt: string | null;
  sampleCount: number;
}

const cache = new Map<string, { payload: Payload; fetchedAt: number }>();

interface DbSampleRow {
  trailer_id: number;
  lat:        number;
  lon:        number;
  located_at: string;
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cached.payload);
  }

  const db = getSupabaseServer();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const rows: DbSampleRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      // The table post-dates the generated Supabase types; see the
      // same note in apps/api/src/jobs/trailerLocationSweep.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('trailer_location_samples' as any)
      .select('trailer_id, lat, lon, located_at')
      .eq('org_id', orgId)
      .gte('located_at', since)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // A missing table means the migration hasn't run yet. That's a
      // deploy-ordering state, not a failure the dispatcher should see
      // as a red banner: the map still works, there is just no history
      // to report.
      console.error('[trailers/stillness] read failed:', error.message);
      const empty: Payload = { stillness: {}, historyStartedAt: null, sampleCount: 0 };
      return NextResponse.json(empty);
    }
    const page = (data ?? []) as unknown as DbSampleRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // Group, then sort each trailer's fixes newest-first — the order
  // computeStillness walks.
  const byTrailer = new Map<number, LocationSample[]>();
  let oldest: string | null = null;
  for (const r of rows) {
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') continue;
    const list = byTrailer.get(r.trailer_id) ?? [];
    list.push({ lat: r.lat, lon: r.lon, locatedAt: r.located_at });
    byTrailer.set(r.trailer_id, list);
    if (oldest == null || r.located_at < oldest) oldest = r.located_at;
  }

  const stillness: Record<string, Stillness> = {};
  for (const [trailerId, list] of byTrailer) {
    list.sort((a, b) => b.locatedAt.localeCompare(a.locatedAt));
    stillness[String(trailerId)] = computeStillness(list);
  }

  const payload: Payload = {
    stillness,
    historyStartedAt: oldest,
    sampleCount: rows.length,
  };
  cache.set(orgId, { payload, fetchedAt: Date.now() });
  return NextResponse.json(payload);
}

export type TrailerStillnessPayload = Payload;
