'use client';

/**
 * Client-side dashboard for /admin/ai-usage. The server page handles
 * the super-admin auth gate; this component owns the interactive UI:
 *
 *   - Month picker (UTC YYYY-MM)
 *   - 4-card KPI strip (cost MTD, calls MTD, top org, 24h error rate)
 *   - Orgs table sorted by cost desc (current month)
 *   - Recent failures table (last 24h)
 *   - Manual refresh button
 *
 * All data comes from GET /api/admin/ai-usage?ym=YYYY-MM, which is
 * already cross-org and Clerk-name-resolved. We just paint it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/nav/AppShell';
import { Activity, AlertCircle, DollarSign, Loader2, RefreshCw, Users } from 'lucide-react';
import Breadcrumbs from '../Breadcrumbs';

interface MonthlyRow {
  org_id:        string;
  org_name:      string | null;
  ym:            string;
  endpoint:      string;
  call_count:    number;
  input_tokens:  number;
  output_tokens: number;
  cost_usd:      number;
  flagged_at:    string | null;
  first_seen_at: string;
  last_seen_at:  string;
}

interface FailureRow {
  id:          number;
  org_id:      string | null;
  org_name:    string | null;
  user_id:     string | null;
  endpoint:    string;
  model:       string;
  pass:        number;
  error_code:  string | null;
  latency_ms:  number | null;
  created_at:  string;
}

interface ApiResponse {
  ym: string;
  summary: {
    totalCalls:        number;
    totalInputTokens:  number;
    totalOutputTokens: number;
    totalCostUsd:      number;
    topOrg:            { orgId: string; name: string | null; costUsd: number } | null;
    recentTotal:       number;
    recentFailures:    number;
    errorRate:         number;
  };
  monthly:  MonthlyRow[];
  failures: FailureRow[];
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
const numFmt   = new Intl.NumberFormat('en-US');
const pctFmt   = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** YYYY-MM key for "now" in UTC. Matches what the rollup trigger
 *  writes into ai_usage_monthly.ym. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function AiUsageDashboard() {
  const [ym, setYm] = useState<string>(currentYm());
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forYm: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/ai-usage?ym=${encodeURIComponent(forYm)}`);
      if (!res.ok) {
        // The route returns 404 for non-admins; we shouldn't see
        // that here since the server page already gated, but
        // surface a clean message if something else fails.
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(ym);
  }, [ym, load]);

  // Group monthly rows by org so the table reads "one row per org"
  // instead of "one row per (org, endpoint)". Sums endpoint costs
  // within each org. Endpoint breakdown is reserved for a future
  // org-detail drill-down.
  const orgsTable = useMemo(() => {
    if (!data) return [];
    const byOrg = new Map<string, {
      orgId:         string;
      orgName:       string | null;
      calls:         number;
      inputTokens:   number;
      outputTokens:  number;
      costUsd:       number;
      endpoints:     Set<string>;
      flaggedAt:     string | null;
      firstSeenAt:   string;
      lastSeenAt:    string;
    }>();
    for (const r of data.monthly) {
      const cur = byOrg.get(r.org_id) ?? {
        orgId:        r.org_id,
        orgName:      r.org_name,
        calls:        0,
        inputTokens:  0,
        outputTokens: 0,
        costUsd:      0,
        endpoints:    new Set<string>(),
        flaggedAt:    null,
        firstSeenAt:  r.first_seen_at,
        lastSeenAt:   r.last_seen_at,
      };
      cur.calls        += r.call_count;
      cur.inputTokens  += r.input_tokens;
      cur.outputTokens += r.output_tokens;
      cur.costUsd      += r.cost_usd;
      cur.endpoints.add(r.endpoint);
      // Flagged-at: latest non-null wins.
      if (r.flagged_at && (!cur.flaggedAt || r.flagged_at > cur.flaggedAt)) {
        cur.flaggedAt = r.flagged_at;
      }
      // Earliest first_seen, latest last_seen across endpoints.
      if (r.first_seen_at < cur.firstSeenAt) cur.firstSeenAt = r.first_seen_at;
      if (r.last_seen_at  > cur.lastSeenAt)  cur.lastSeenAt  = r.last_seen_at;
      byOrg.set(r.org_id, cur);
    }
    return Array.from(byOrg.values()).sort((a, b) => b.costUsd - a.costUsd);
  }, [data]);

  return (
    <AppShell title="AI Usage" icon={Activity}>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-6 gap-4 overflow-y-auto">
        <Breadcrumbs trail={[{ label: 'Admin', href: '/admin' }, { label: 'AI usage' }]} />
        {/* Header strip — title left, controls right. */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              AI usage — {ym}
            </div>
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              Cross-org Anthropic API spend, calls, and recent failures.
              {' '}Month bucket is UTC. Error rate is last 24h.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="month"
              value={ym}
              onChange={e => setYm(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 rounded-lg outline-none"
              style={{
                background: 'var(--gc-surface)',
                border:     '1px solid var(--gc-border)',
                color:      'var(--gc-text-1)',
              }} />
            <button onClick={() => void load(ym)}
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
        </div>

        {error && (
          <div className="text-[12.5px] px-3 py-2 rounded-lg"
            style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
            <AlertCircle size={12} className="inline mr-1" /> {error}
          </div>
        )}

        {/* KPI strip — four cards. Soft elevation matches the rest
            of the GC design. Numbers are big and tabular so they
            line up across cards. */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <KpiCard
            icon={<DollarSign size={16} style={{ color: '#137333' }} />}
            label="Cost (MTD)"
            value={data ? moneyFmt.format(data.summary.totalCostUsd) : '—'}
            sub={data ? `${numFmt.format(data.summary.totalCalls)} calls` : 'Loading…'} />
          <KpiCard
            icon={<Activity size={16} style={{ color: '#1558d6' }} />}
            label="Input tokens"
            value={data ? numFmt.format(data.summary.totalInputTokens) : '—'}
            sub={data ? `${numFmt.format(data.summary.totalOutputTokens)} output` : 'Loading…'} />
          <KpiCard
            icon={<Users size={16} style={{ color: '#6b21a8' }} />}
            label="Top org (cost)"
            value={data?.summary.topOrg
              ? moneyFmt.format(data.summary.topOrg.costUsd)
              : '—'}
            sub={data?.summary.topOrg
              ? (data.summary.topOrg.name ?? data.summary.topOrg.orgId.slice(0, 12) + '…')
              : 'No spend yet'} />
          <KpiCard
            icon={<AlertCircle size={16} style={{ color: data && data.summary.errorRate > 0.05 ? '#c5221f' : '#5f6368' }} />}
            label="Error rate (24h)"
            value={data ? pctFmt.format(data.summary.errorRate) : '—'}
            sub={data ? `${numFmt.format(data.summary.recentFailures)} / ${numFmt.format(data.summary.recentTotal)} calls` : 'Loading…'} />
        </div>

        {/* Orgs table — one row per org, sorted by cost desc. Manual
            sticky thead so we don't need OpsTable's full feature
            set here; the data set is small (one row per active org). */}
        <div className="rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="px-4 py-2.5 border-b text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border-light)' }}>
            Orgs · {orgsTable.length}
          </div>
          {!data && loading ? (
            <div className="flex items-center justify-center py-12 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Loading…
            </div>
          ) : orgsTable.length === 0 ? (
            <div className="text-center py-12 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              No usage recorded for {ym}.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    <Th>Org</Th>
                    <Th className="text-right">Calls</Th>
                    <Th className="text-right">Input</Th>
                    <Th className="text-right">Output</Th>
                    <Th className="text-right">Cost</Th>
                    <Th>Endpoints</Th>
                    <Th>Last activity</Th>
                  </tr>
                </thead>
                <tbody>
                  {orgsTable.map(r => (
                    <tr key={r.orgId} className="border-t" style={{ borderColor: 'var(--gc-border-light)' }}>
                      <Td>
                        <div className="font-semibold truncate" style={{ color: 'var(--gc-text-1)' }} title={r.orgId}>
                          {r.orgName ?? r.orgId}
                        </div>
                        <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--gc-text-3)' }} title={r.orgId}>
                          {r.orgId.length > 24 ? `${r.orgId.slice(0, 24)}…` : r.orgId}
                        </div>
                      </Td>
                      <Td className="text-right tabular-nums">{numFmt.format(r.calls)}</Td>
                      <Td className="text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{numFmt.format(r.inputTokens)}</Td>
                      <Td className="text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{numFmt.format(r.outputTokens)}</Td>
                      <Td className="text-right tabular-nums font-bold">{moneyFmt.format(r.costUsd)}</Td>
                      <Td>
                        <span style={{ color: 'var(--gc-text-2)' }}>{Array.from(r.endpoints).join(', ')}</span>
                      </Td>
                      <Td title={r.lastSeenAt}>{relativeTime(r.lastSeenAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent failures — last 24h, capped at 50 by the API. */}
        <div className="rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="px-4 py-2.5 border-b text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border-light)' }}>
            Recent failures · last 24h · {data?.failures.length ?? 0}
          </div>
          {data && data.failures.length === 0 ? (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              No failures in the last 24h.
            </div>
          ) : data && data.failures.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    <Th>Time</Th>
                    <Th>Org</Th>
                    <Th>Endpoint</Th>
                    <Th>Model</Th>
                    <Th>Pass</Th>
                    <Th>Error</Th>
                    <Th className="text-right">Latency</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.failures.map(f => (
                    <tr key={f.id} className="border-t" style={{ borderColor: 'var(--gc-border-light)' }}>
                      <Td title={f.created_at}>{relativeTime(f.created_at)}</Td>
                      <Td>
                        <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                          {f.org_name ?? f.org_id ?? '(system)'}
                        </span>
                      </Td>
                      <Td>{f.endpoint}</Td>
                      <Td className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
                        {f.model === 'none' ? '—' : f.model.replace(/^claude-/, '')}
                      </Td>
                      <Td>{f.pass}</Td>
                      <Td>
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded"
                          style={{ background: '#fce8e6', color: '#c5221f' }}>
                          {f.error_code ?? 'unknown'}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums">{f.latency_ms ? `${f.latency_ms} ms` : '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex items-center justify-center py-10 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {loading ? 'Loading…' : '—'}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── Bits ──────────────────────────────────────────────────────────

function KpiCard({ icon, label, value, sub }: {
  icon:  React.ReactNode;
  label: string;
  value: string;
  sub:   string;
}) {
  return (
    <div className="rounded-xl p-3.5" style={{
      background: 'var(--gc-surface)',
      border:     '1px solid var(--gc-border-light)',
      boxShadow:  'var(--shadow-1)',
    }}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--gc-text-3)' }}>
        {icon}
        {label}
      </div>
      <div className="mt-1.5 tabular-nums" style={{
        fontSize: 26, fontWeight: 800, lineHeight: 1, color: 'var(--gc-text-1)',
      }}>
        {value}
      </div>
      <div className="mt-1 text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
        {sub}
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={className}
      style={{
        textAlign:    className?.includes('text-right') ? 'right' : 'left',
        padding:      '8px 12px',
        fontSize:     10.5,
        fontWeight:   700,
        letterSpacing:'0.05em',
        textTransform:'uppercase',
        color:        'var(--gc-text-3)',
        borderBottom: '1px solid var(--gc-border)',
      }}>
      {children}
    </th>
  );
}

function Td({ children, className, style, title }: {
  children:   React.ReactNode;
  className?: string;
  style?:     React.CSSProperties;
  title?:     string;
}) {
  return (
    <td className={className}
      title={title}
      style={{
        textAlign: className?.includes('text-right') ? 'right' : 'left',
        padding:   '10px 12px',
        verticalAlign: 'middle',
        ...style,
      }}>
      {children}
    </td>
  );
}

/** Compact "5 min ago" / "2h ago" / "3d ago" for the dashboard's
 *  time columns. Falls back to a date string past 30 days. */
function relativeTime(iso: string): string {
  const t  = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const ms = Date.now() - t;
  const s  = Math.floor(ms / 1000);
  if (s < 60)     return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)     return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24)     return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)     return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
