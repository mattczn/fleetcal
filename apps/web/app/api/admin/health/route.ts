/**
 * GET /api/admin/health
 *
 * Operational health snapshot for the /admin/health dashboard.
 * Reads the most-recent cron_runs row per job_name (the heartbeat
 * tracker maintained by apps/api/src/lib/cronRun.ts), plus per-job
 * success-rate counts over the last 24h.
 *
 * Super-admin gated. Non-admins get a 404.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';
import { isSuperAdmin } from '@/lib/superAdmin';

interface CronRunRow {
  id:            number;
  job_name:      string;
  started_at:    string;
  finished_at:   string | null;
  duration_ms:   number | null;
  success:       boolean;
  error_code:    string | null;
  error_message: string | null;
  meta:          Record<string, unknown> | null;
}

// Known cron jobs — used to surface "missing job" (never reported)
// rows. Adding a new cron? Add its job_name here too so the
// dashboard knows to expect a heartbeat.
const KNOWN_JOBS = [
  'auto-deliver-sweep',
  'confirm-reminders',
  'motive-sync',
  'odometer-snapshot',
  'fuel-auto-match',
  'ai-usage-sweep',
];

export async function GET() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const db = getSupabaseServer();

  // Latest row per job — pull last 100 rows per known job and keep
  // the first. PostgREST doesn't have a clean "distinct on" without
  // raw SQL, so we fetch a window and reduce client-side. 6 jobs ×
  // (15 min tick × 4/hour × 24h ≈ 144 rows/day) = ~864 rows worst
  // case — small.
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentRes = await db
    .from('cron_runs')
    .select('id, job_name, started_at, finished_at, duration_ms, success, error_code, error_message, meta')
    .gte('started_at', last24h)
    .order('started_at', { ascending: false })
    .limit(2000);
  if (recentRes.error) {
    console.error('[admin/health] cron_runs query failed:', recentRes.error.message);
    return NextResponse.json({ error: recentRes.error.message }, { status: 500 });
  }
  const rows = (recentRes.data ?? []) as CronRunRow[];

  // Group: { jobName: { lastRun, successCount, failureCount } }
  interface JobSummary {
    jobName:         string;
    lastRun:         CronRunRow | null;
    successCount24h: number;
    failureCount24h: number;
    avgDurationMs:   number | null;
  }
  const byJob = new Map<string, JobSummary>();
  for (const j of KNOWN_JOBS) {
    byJob.set(j, {
      jobName:         j,
      lastRun:         null,
      successCount24h: 0,
      failureCount24h: 0,
      avgDurationMs:   null,
    });
  }
  // Also accept unknown job_names so a renamed/added job shows up
  // even if we forgot to add it to KNOWN_JOBS.
  for (const row of rows) {
    let s = byJob.get(row.job_name);
    if (!s) {
      s = {
        jobName:         row.job_name,
        lastRun:         null,
        successCount24h: 0,
        failureCount24h: 0,
        avgDurationMs:   null,
      };
      byJob.set(row.job_name, s);
    }
    // Rows came in DESC order, so the first hit is the latest run.
    if (!s.lastRun) s.lastRun = row;
    if (row.success) s.successCount24h++;
    else             s.failureCount24h++;
  }
  // Average duration over the 24h window (success runs only).
  for (const [jobName, s] of byJob) {
    const successRows = rows.filter(r => r.job_name === jobName && r.success && r.duration_ms != null);
    if (successRows.length > 0) {
      s.avgDurationMs = Math.round(
        successRows.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0) / successRows.length
      );
    }
  }

  // Top-line summary for the KPI strip.
  const totalRuns      = rows.length;
  const totalFailures  = rows.filter(r => !r.success).length;
  const errorRate      = totalRuns === 0 ? 0 : totalFailures / totalRuns;
  const jobsWithFailure = Array.from(byJob.values()).filter(j => j.failureCount24h > 0).length;
  // "Healthy" = ran at least once in the last 24h AND last run was a success.
  const jobsHealthy    = Array.from(byJob.values()).filter(j => j.lastRun && j.lastRun.success).length;

  return NextResponse.json({
    summary: {
      totalRuns,
      totalFailures,
      errorRate,
      jobsHealthy,
      jobsWithFailure,
      jobsTotal: byJob.size,
    },
    jobs:    Array.from(byJob.values()),
    recent:  rows.slice(0, 100), // most-recent 100 across all jobs for the timeline view
  });
}
