/**
 * GET /api/admin/errors
 *
 * Paginated read of the `api_errors` table for the /admin/errors
 * dashboard. Filters: status family (4xx/5xx/all), since window,
 * org/path/method substring.
 *
 * Super-admin gated. Non-admins get a 404 (same as siblings).
 *
 * Why no per-org gate even though we have org_id on rows:
 *   - This surface IS cross-org by design. The whole point is
 *     spotting a single org hammering 402s before they raise a
 *     ticket. The super-admin allowlist is the gate.
 *   - We don't filter to the requester's own org because the
 *     requester might not even have an active org context — the
 *     admin user can be in any org when they hit this URL.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/superAdmin';

interface ErrorRow {
  id:           string;
  occurred_at:  string;
  org_id:       string | null;
  user_id:      string | null;
  method:       string;
  path:         string;
  status:       number;
  error_code:   string | null;
  detail:       string | null;
  body_snippet: string | null;
  user_agent:   string | null;
  duration_ms:  number | null;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

const SINCE_WINDOWS: Record<string, number> = {
  '1h':  60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7  * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = new URL(req.url);
  // Filters. All optional; missing = "no constraint."
  const statusFamily = url.searchParams.get('statusFamily') ?? '';        // '4xx' | '5xx' | ''
  const since        = url.searchParams.get('since')        ?? '24h';     // 1h | 24h | 7d | 30d
  const orgFilter    = (url.searchParams.get('org')    ?? '').trim();
  const pathFilter   = (url.searchParams.get('path')   ?? '').trim();
  const methodFilter = (url.searchParams.get('method') ?? '').trim().toUpperCase();
  const limitRaw     = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit        = Number.isFinite(limitRaw)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  const sinceMs = SINCE_WINDOWS[since] ?? SINCE_WINDOWS['24h'];
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();

  const db = getSupabaseServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db
    .from('api_errors')
    .select('id, occurred_at, org_id, user_id, method, path, status, error_code, detail, body_snippet, user_agent, duration_ms', { count: 'exact' })
    .gte('occurred_at', sinceIso)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (statusFamily === '4xx') q = q.gte('status', 400).lt('status', 500);
  if (statusFamily === '5xx') q = q.gte('status', 500);
  if (orgFilter)    q = q.eq('org_id', orgFilter);
  if (methodFilter) q = q.eq('method', methodFilter);
  if (pathFilter)   q = q.ilike('path', `%${pathFilter}%`);

  const { data, error, count } = await q;
  if (error) {
    console.error('[admin/errors] query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Headline numbers — same window, no other filters. Cheaper to issue
  // two count queries than to client-side aggregate, since we already
  // limited the fetch above to `limit` rows.
  const [c4xx, c5xx, byEndpoint] = await Promise.all([
    db.from('api_errors').select('*', { count: 'exact', head: true })
      .gte('occurred_at', sinceIso).gte('status', 400).lt('status', 500),
    db.from('api_errors').select('*', { count: 'exact', head: true })
      .gte('occurred_at', sinceIso).gte('status', 500),
    // Top 5 endpoints by error count. Postgres-side group-by needs
    // raw SQL via Supabase RPC; aggregating client-side from the
    // returned rows is good enough at this scale.
    db.from('api_errors').select('path, status')
      .gte('occurred_at', sinceIso)
      .order('occurred_at', { ascending: false })
      .limit(2000),
  ]);

  // Aggregate top endpoints from the byEndpoint sample.
  const endpointCounts = new Map<string, number>();
  for (const r of (byEndpoint.data ?? []) as Array<{ path: string }>) {
    endpointCounts.set(r.path, (endpointCounts.get(r.path) ?? 0) + 1);
  }
  const topEndpoints = Array.from(endpointCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path, n]) => ({ path, count: n }));

  return NextResponse.json({
    rows:           (data ?? []) as ErrorRow[],
    totalMatching:  count ?? 0,
    window:         since,
    headline: {
      count4xx:    c4xx.count ?? 0,
      count5xx:    c5xx.count ?? 0,
      topEndpoints,
    },
  });
}
