/**
 * Aggregator for the /admin pulse card.
 *
 * Fans out Sentry + Supabase reads in parallel and rolls them up
 * into a single small payload. Designed for one HTTP call from the
 * dashboard so the client doesn't need to know about Sentry, the
 * cron_runs table, or the AI usage rollup.
 *
 * Everything degrades gracefully — any source returning null leaves
 * its slot null in the payload, and the UI renders "—" rather than
 * blowing up the card.
 */

import { getSupabaseServer } from './supabase-server';
import { fetchErrorStats, fetchLastRelease, type SentryErrorStats, type SentryRelease } from './sentryApi';

export interface PulseMetrics {
  /** ISO timestamp the payload was generated. The client uses this
   *  to render "live X seconds ago". */
  generatedAt: string;
  errors24h:   SentryErrorStats | null;
  release:     SentryRelease    | null;
  crons:       CronHealthSummary;
  aiSpend24h:  number | null;
  aiCalls24h:  number | null;
}

export interface CronHealthSummary {
  /** Jobs whose most-recent run succeeded. */
  healthy:        number;
  /** Jobs whose most-recent run failed. */
  failingNow:     number;
  /** Jobs that haven't reported a heartbeat in the last 24h at all. */
  silent:         number;
  /** Total known jobs (healthy + failing + silent). */
  total:          number;
  /** Sum of failed runs across all jobs in the last 24h, regardless
   *  of whether the latest run recovered. Useful for "5 failures
   *  today" while still reporting all-green if they recovered. */
  failuresLast24h: number;
}

// Mirror of KNOWN_JOBS in /api/admin/health/route.ts — duplicated
// rather than imported because route files shouldn't be importable
// from library code (Next would flag it). Keep these in sync.
const KNOWN_JOBS = [
  'auto-deliver-sweep',
  'confirm-reminders',
  'motive-sync',
  'odometer-snapshot',
  'fuel-auto-match',
  'ai-usage-sweep',
];

export async function getPulseMetrics(): Promise<PulseMetrics> {
  const [errors24h, release, crons, aiTotals] = await Promise.all([
    fetchErrorStats(24).catch((err): SentryErrorStats | null => {
      console.warn('[adminMetrics] errors24h:', err);
      return null;
    }),
    fetchLastRelease().catch((err): SentryRelease | null => {
      console.warn('[adminMetrics] release:', err);
      return null;
    }),
    fetchCronHealth().catch(() => emptyCronSummary()),
    fetchAiSpend24h().catch((): AiTotals => ({ spend: null, calls: null })),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    errors24h:   errors24h ?? null,
    release:     release   ?? null,
    crons,
    aiSpend24h:  aiTotals.spend,
    aiCalls24h:  aiTotals.calls,
  };
}

// ─── Cron health ──────────────────────────────────────────────────

async function fetchCronHealth(): Promise<CronHealthSummary> {
  const db = getSupabaseServer();
  const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Fetch a wide enough window that every job has at least one row
  // if it's been firing. Same pattern as /api/admin/health — we
  // need the FULL set to compute "latest per job" client-side and
  // the failure count.
  const res = await db
    .from('cron_runs')
    .select('job_name, started_at, success')
    .gte('started_at', last24hIso)
    .order('started_at', { ascending: false })
    .limit(2000);

  if (res.error) {
    console.warn('[adminMetrics] cron_runs query failed:', res.error.message);
    return emptyCronSummary();
  }
  const rows = (res.data ?? []) as Array<{ job_name: string; started_at: string; success: boolean }>;

  // Group by job, capture latest + failure count.
  const seen = new Map<string, { latestSuccess: boolean | null; failures: number; runs: number }>();
  for (const j of KNOWN_JOBS) {
    seen.set(j, { latestSuccess: null, failures: 0, runs: 0 });
  }
  for (const row of rows) {
    let entry = seen.get(row.job_name);
    if (!entry) {
      entry = { latestSuccess: null, failures: 0, runs: 0 };
      seen.set(row.job_name, entry);
    }
    // Rows are DESC by started_at → first encounter is latest.
    if (entry.latestSuccess === null) entry.latestSuccess = row.success;
    entry.runs += 1;
    if (!row.success) entry.failures += 1;
  }

  let healthy = 0, failingNow = 0, silent = 0, failuresLast24h = 0;
  for (const entry of seen.values()) {
    failuresLast24h += entry.failures;
    if (entry.latestSuccess === null) silent      += 1;
    else if (entry.latestSuccess)     healthy     += 1;
    else                              failingNow  += 1;
  }

  return {
    healthy,
    failingNow,
    silent,
    total:           seen.size,
    failuresLast24h,
  };
}

function emptyCronSummary(): CronHealthSummary {
  return {
    healthy:         0,
    failingNow:      0,
    silent:          KNOWN_JOBS.length,
    total:           KNOWN_JOBS.length,
    failuresLast24h: 0,
  };
}

// ─── AI spend ─────────────────────────────────────────────────────

interface AiTotals {
  spend: number | null;
  calls: number | null;
}

async function fetchAiSpend24h(): Promise<AiTotals> {
  const db = getSupabaseServer();
  const last24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Sum cost_usd across every org in the last 24h. The (created_at
  // DESC) index makes this an index-only scan. We pull cost_usd into
  // application memory rather than asking PostgREST to aggregate —
  // PostgREST doesn't expose SUM() without an RPC, and 24h of
  // ai_usage_logs rows fits comfortably in a single page.
  const res = await db
    .from('ai_usage_logs')
    .select('cost_usd')
    .gte('created_at', last24hIso)
    .limit(50_000);

  if (res.error) {
    console.warn('[adminMetrics] ai_usage_logs query failed:', res.error.message);
    return { spend: null, calls: null };
  }
  const rows = (res.data ?? []) as Array<{ cost_usd: number | string | null }>;
  const spend = rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);
  return { spend, calls: rows.length };
}
