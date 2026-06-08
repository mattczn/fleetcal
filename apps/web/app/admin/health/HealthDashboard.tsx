'use client';

/**
 * Client-side health dashboard for /admin/health.
 *
 *   - 4-card KPI strip (jobs healthy, failures 24h, error rate, total runs)
 *   - Per-job status table (last run, last success, error rate, avg duration)
 *   - Recent runs timeline (last 100 across all jobs)
 *
 * Data from GET /api/admin/health — single payload, no pagination
 * because cron data is small.
 */

import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/nav/AppShell';
import Breadcrumbs from '../Breadcrumbs';
import { Activity, AlertCircle, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

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

interface JobSummary {
  jobName:         string;
  lastRun:         CronRunRow | null;
  successCount24h: number;
  failureCount24h: number;
  avgDurationMs:   number | null;
}

interface ApiResponse {
  summary: {
    totalRuns:       number;
    totalFailures:   number;
    errorRate:       number;
    jobsHealthy:     number;
    jobsWithFailure: number;
    jobsTotal:       number;
  };
  jobs:   JobSummary[];
  recent: CronRunRow[];
}

const numFmt = new Intl.NumberFormat('en-US');
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function HealthDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/health');
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      setData(await res.json() as ApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppShell title="Health" icon={ShieldAlert}>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-6 gap-4 overflow-y-auto">
        <Breadcrumbs trail={[{ label: 'Admin', href: '/admin' }, { label: 'Operational health' }]} />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Operational health
            </div>
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              In-process cron heartbeats, last 24h. Source: <code>cron_runs</code>.
            </div>
          </div>
          <button onClick={() => void load()}
            disabled={loading}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-60"
            style={{
              background: 'var(--gc-surface)',
              border:     '1px solid var(--gc-border)',
              color:      'var(--gc-text-2)',
            }}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>

        {error && (
          <div className="text-[12.5px] px-3 py-2 rounded-lg"
            style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
            <AlertCircle size={12} className="inline mr-1" /> {error}
          </div>
        )}

        {/* KPI strip */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <KpiCard
            icon={<CheckCircle2 size={16} style={{ color: '#137333' }} />}
            label="Jobs healthy"
            value={data ? `${data.summary.jobsHealthy} / ${data.summary.jobsTotal}` : '—'}
            sub="Last run was a success" />
          <KpiCard
            icon={<AlertCircle size={16} style={{ color: data && data.summary.totalFailures > 0 ? '#c5221f' : '#5f6368' }} />}
            label="Failures (24h)"
            value={data ? numFmt.format(data.summary.totalFailures) : '—'}
            sub={data ? `${data.summary.jobsWithFailure} job${data.summary.jobsWithFailure === 1 ? '' : 's'} affected` : 'Loading…'} />
          <KpiCard
            icon={<Activity size={16} style={{ color: data && data.summary.errorRate > 0.05 ? '#c5221f' : '#1558d6' }} />}
            label="Error rate (24h)"
            value={data ? pctFmt.format(data.summary.errorRate) : '—'}
            sub={data ? `${numFmt.format(data.summary.totalRuns)} runs` : 'Loading…'} />
          <KpiCard
            icon={<Activity size={16} style={{ color: '#5f6368' }} />}
            label="Total runs (24h)"
            value={data ? numFmt.format(data.summary.totalRuns) : '—'}
            sub="All jobs combined" />
        </div>

        {/* Jobs table */}
        <div className="rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="px-4 py-2.5 border-b text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border-light)' }}>
            Cron jobs · {data?.jobs.length ?? 0}
          </div>
          {!data && loading ? (
            <div className="flex items-center justify-center py-12 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    <Th>Job</Th>
                    <Th>Status</Th>
                    <Th>Last run</Th>
                    <Th className="text-right">Successes</Th>
                    <Th className="text-right">Failures</Th>
                    <Th className="text-right">Avg duration</Th>
                    <Th>Last error</Th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.jobs ?? []).map(j => (
                    <tr key={j.jobName} className="border-t" style={{ borderColor: 'var(--gc-border-light)' }}>
                      <Td>
                        <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{j.jobName}</div>
                      </Td>
                      <Td>
                        <StatusBadge job={j} />
                      </Td>
                      <Td title={j.lastRun?.started_at}>
                        {j.lastRun ? relativeTime(j.lastRun.started_at) : <span style={{ color: 'var(--gc-text-3)' }}>never</span>}
                      </Td>
                      <Td className="text-right tabular-nums">{numFmt.format(j.successCount24h)}</Td>
                      <Td className="text-right tabular-nums" style={{ color: j.failureCount24h > 0 ? '#c5221f' : 'var(--gc-text-2)' }}>
                        {numFmt.format(j.failureCount24h)}
                      </Td>
                      <Td className="text-right tabular-nums">{j.avgDurationMs != null ? `${numFmt.format(j.avgDurationMs)} ms` : '—'}</Td>
                      <Td>
                        {j.lastRun && !j.lastRun.success ? (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fce8e6', color: '#c5221f' }}
                            title={j.lastRun.error_message ?? undefined}>
                            {j.lastRun.error_code ?? 'failed'}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent timeline */}
        <div className="rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="px-4 py-2.5 border-b text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border-light)' }}>
            Recent runs · {data?.recent.length ?? 0}
          </div>
          {data && data.recent.length === 0 ? (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              No runs recorded yet. Heartbeats start logging on the next cron tick.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    <Th>Time</Th>
                    <Th>Job</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Duration</Th>
                    <Th>Error</Th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.recent ?? []).map(r => (
                    <tr key={r.id} className="border-t" style={{ borderColor: 'var(--gc-border-light)' }}>
                      <Td title={r.started_at}>{relativeTime(r.started_at)}</Td>
                      <Td>{r.job_name}</Td>
                      <Td>
                        {r.success
                          ? <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#e6f4ea', color: '#137333' }}>OK</span>
                          : <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fce8e6', color: '#c5221f' }}>FAIL</span>}
                      </Td>
                      <Td className="text-right tabular-nums">{r.duration_ms != null ? `${numFmt.format(r.duration_ms)} ms` : '—'}</Td>
                      <Td>
                        {!r.success && (
                          <span className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }} title={r.error_message ?? undefined}>
                            {r.error_code ?? 'unknown'}
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function StatusBadge({ job }: { job: JobSummary }) {
  if (!job.lastRun) {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#f1f3f4', color: '#5f6368' }}>NO HEARTBEAT</span>;
  }
  if (job.lastRun.success && job.failureCount24h === 0) {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#e6f4ea', color: '#137333' }}>HEALTHY</span>;
  }
  if (!job.lastRun.success) {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fce8e6', color: '#c5221f' }}>FAILED</span>;
  }
  return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fef7e0', color: '#b06000' }}>RECOVERING</span>;
}

// ── Bits (same as AiUsageDashboard — small enough to duplicate, no shared module yet) ──

function KpiCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl p-3.5" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)' }}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
        {icon} {label}
      </div>
      <div className="mt-1.5 tabular-nums" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: 'var(--gc-text-1)' }}>
        {value}
      </div>
      <div className="mt-1 text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>{sub}</div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={className} style={{
      textAlign:     className?.includes('text-right') ? 'right' : 'left',
      padding:       '8px 12px',
      fontSize:      10.5,
      fontWeight:    700,
      letterSpacing: '0.05em',
      textTransform: 'uppercase',
      color:         'var(--gc-text-3)',
      borderBottom:  '1px solid var(--gc-border)',
    }}>{children}</th>
  );
}

function Td({ children, className, title }: { children: React.ReactNode; className?: string; title?: string; style?: React.CSSProperties }) {
  return (
    <td className={className} title={title} style={{
      textAlign:     className?.includes('text-right') ? 'right' : 'left',
      padding:       '10px 12px',
      verticalAlign: 'middle',
    }}>{children}</td>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const ms = Date.now() - t;
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
