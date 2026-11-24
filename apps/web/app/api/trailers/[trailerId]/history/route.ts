/**
 * GET /api/trailers/{trailerId}/history?days=7
 *
 * One trailer's recent life: the path it took, and that path split
 * into the places it sat and the runs between them.
 *
 * Returns both because they answer different questions. The segments
 * are the readable account ("sat at SLC Yard until Tuesday, ran to
 * Vegas in 6h"); the thinned sample list is what the map draws, since
 * a polyline through the actual fixes shows the route taken, which no
 * list of start/end pairs can.
 *
 * PAGINATION, again, is not optional: a trailer that worked all week
 * can hold well over PostgREST's silent 1000-row ceiling at the
 * 2-minute poll cadence, and the rows that would be dropped are the
 * oldest — which is to say the segmentation would quietly lose the
 * beginning of the week rather than fail.
 */
import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { segmentTrail, thinPath, type HistorySample, type TrailerSegment } from '@/lib/trailerHistory';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const PAGE = 1000;
// Enough to trace a week of interstate running without handing the
// browser a polyline it has to thin itself.
const MAX_PATH_POINTS = 1500;

export interface TrailerHistoryPayload {
  trailerId: number;
  days:      number;
  /** Thinned for drawing; oldest first. */
  path:      Array<{ lat: number; lon: number; at: string }>;
  segments:  TrailerSegment[];
  /** Fixes actually stored in the window, before thinning. */
  fixCount:  number;
}

interface DbRow { lat: number; lon: number; located_at: string; address: string | null }

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ trailerId: string }> },
) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { trailerId: raw } = await ctx.params;
  const trailerId = Number(raw);
  if (!Number.isInteger(trailerId)) {
    return NextResponse.json({ error: 'Bad trailer id' }, { status: 400 });
  }

  const days = Math.min(MAX_DAYS, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || DEFAULT_DAYS));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const db = getSupabaseServer();
  const rows: DbRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      // Table post-dates the generated Supabase types; same note as
      // apps/api/src/jobs/trailerLocationSweep.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from('trailer_location_samples' as any)
      .select('lat, lon, located_at, address')
      .eq('org_id', orgId)
      .eq('trailer_id', trailerId)
      .gte('located_at', since)
      // Oldest first is both the pagination key and the order
      // segmentTrail needs, so there is no re-sort and no chance of
      // the two disagreeing.
      .order('located_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // Most likely the migration hasn't run. An empty history is the
      // honest answer and the panel renders "no history yet" from it.
      console.error('[trailers/history] read failed:', error.message);
      const empty: TrailerHistoryPayload = { trailerId, days, path: [], segments: [], fixCount: 0 };
      return NextResponse.json(empty);
    }
    const page = (data ?? []) as unknown as DbRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const samples: HistorySample[] = rows
    .filter(r => typeof r.lat === 'number' && typeof r.lon === 'number')
    .map(r => ({ lat: r.lat, lon: r.lon, locatedAt: r.located_at, address: r.address }));

  // Segment from EVERY fix, then thin only what gets drawn. Thinning
  // first would move the stop boundaries around.
  const segments = segmentTrail(samples);
  const path = thinPath(samples, MAX_PATH_POINTS)
    .map(s => ({ lat: s.lat, lon: s.lon, at: s.locatedAt }));

  const payload: TrailerHistoryPayload = {
    trailerId, days, path,
    // Newest first: the panel reads top-down from "right now".
    segments: segments.slice().reverse(),
    fixCount: samples.length,
  };
  return NextResponse.json(payload);
}
