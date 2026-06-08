'use client';

/**
 * Client dashboard for /admin/orgs.
 *
 * Shows every org in Clerk, joined with last 30 days of load
 * activity from Supabase. Sorted by loads-created-30d desc.
 * Each row gets a risk flag (never_activated / idle / churning)
 * that bubbles to the top via a "Show flagged only" filter.
 *
 * No drill-down yet — that's a future PR (per-org detail page).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/nav/AppShell';
import { AlertCircle, Building2, DollarSign, Loader2, RefreshCw, Users } from 'lucide-react';
import Breadcrumbs from '../Breadcrumbs';

interface OrgRow {
  orgId:                string;
  orgName:              string;
  createdAt:            number;     // Clerk createdAt (epoch ms)
  membersCount:         number;
  truckCount:           number;
  tier:                 'fleet' | 'growth' | 'owner_op' | 'none';
  tierLabel:            string;
  planPeriod:           'month' | 'annual' | null;
  subscriptionStatus:   string | null;
  loadsCreated30d:      number;
  loadsVerified30d:     number;
  revenue30d:           number;
  lastLoadCreated:      string | null;
  ageDaysSinceLastLoad: number | null;
  flag:                 'never_activated' | 'idle' | 'churning' | null;
}

interface ApiResponse {
  summary: {
    totalOrgs:        number;
    activeOrgs:       number;
    flaggedOrgs:      number;
    totalLoads30d:    number;
    totalRevenue30d:  number;
  };
  orgs: OrgRow[];
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
const numFmt   = new Intl.NumberFormat('en-US');

export default function OrgsDashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/orgs');
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

  const visibleOrgs = useMemo(() => {
    if (!data) return [];
    return showFlaggedOnly ? data.orgs.filter(o => o.flag !== null) : data.orgs;
  }, [data, showFlaggedOnly]);

  return (
    <AppShell title="Orgs" icon={Building2}>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-6 gap-4 overflow-y-auto">
        <Breadcrumbs trail={[{ label: 'Admin', href: '/admin' }, { label: 'Orgs activity' }]} />
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Orgs activity — last 30 days
            </div>
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              Every Clerk org joined with recent load activity. Flags surface inactive / churn-risk orgs.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-3 py-1.5 rounded-lg cursor-pointer"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
              <input type="checkbox" checked={showFlaggedOnly} onChange={e => setShowFlaggedOnly(e.target.checked)} />
              Show flagged only
            </label>
            <button onClick={() => void load()}
              disabled={loading}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-60"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
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

        {/* KPI strip */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <KpiCard
            icon={<Building2 size={16} style={{ color: '#5f6368' }} />}
            label="Total orgs"
            value={data ? numFmt.format(data.summary.totalOrgs) : '—'}
            sub={data ? `${numFmt.format(data.summary.activeOrgs)} active (30d)` : 'Loading…'} />
          <KpiCard
            icon={<AlertCircle size={16} style={{ color: data && data.summary.flaggedOrgs > 0 ? '#c5221f' : '#5f6368' }} />}
            label="Flagged"
            value={data ? numFmt.format(data.summary.flaggedOrgs) : '—'}
            sub="Idle, never-activated, or churning" />
          <KpiCard
            icon={<Users size={16} style={{ color: '#1558d6' }} />}
            label="Loads (30d)"
            value={data ? numFmt.format(data.summary.totalLoads30d) : '—'}
            sub="Across all orgs" />
          <KpiCard
            icon={<DollarSign size={16} style={{ color: '#137333' }} />}
            label="Revenue (30d)"
            value={data ? moneyFmt.format(data.summary.totalRevenue30d) : '—'}
            sub="Sum of total_billable" />
        </div>

        {/* Orgs table */}
        <div className="rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="px-4 py-2.5 border-b text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border-light)' }}>
            Orgs · {visibleOrgs.length}
          </div>
          {!data && loading ? (
            <div className="flex items-center justify-center py-12 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Loading…
            </div>
          ) : visibleOrgs.length === 0 ? (
            <div className="text-center py-12 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              {showFlaggedOnly ? 'No flagged orgs.' : 'No orgs found.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)' }}>
                    <Th>Org</Th>
                    <Th>Tier</Th>
                    <Th>Flag</Th>
                    <Th className="text-right">Trucks</Th>
                    <Th className="text-right">Members</Th>
                    <Th className="text-right">Loads (30d)</Th>
                    <Th className="text-right">Verified</Th>
                    <Th className="text-right">Revenue (30d)</Th>
                    <Th>Last load</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrgs.map(o => (
                    <tr key={o.orgId} className="border-t" style={{ borderColor: 'var(--gc-border-light)' }}>
                      <Td>
                        <div className="font-semibold truncate" style={{ color: 'var(--gc-text-1)' }} title={o.orgId}>
                          {o.orgName}
                        </div>
                        <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                          {o.createdAt
                            ? `Created ${new Date(o.createdAt).toLocaleDateString()}`
                            : o.orgId.slice(0, 16) + '…'}
                        </div>
                      </Td>
                      <Td>
                        <TierBadge tier={o.tier} label={o.tierLabel} period={o.planPeriod} status={o.subscriptionStatus} />
                      </Td>
                      <Td>
                        <FlagBadge flag={o.flag} />
                      </Td>
                      <Td className="text-right tabular-nums">{numFmt.format(o.truckCount)}</Td>
                      <Td className="text-right tabular-nums">{numFmt.format(o.membersCount)}</Td>
                      <Td className="text-right tabular-nums font-bold">{numFmt.format(o.loadsCreated30d)}</Td>
                      <Td className="text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{numFmt.format(o.loadsVerified30d)}</Td>
                      <Td className="text-right tabular-nums font-bold">
                        {o.revenue30d > 0 ? moneyFmt.format(o.revenue30d) : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                      </Td>
                      <Td title={o.lastLoadCreated ?? undefined}>
                        {o.lastLoadCreated
                          ? `${o.ageDaysSinceLastLoad}d ago`
                          : <span style={{ color: 'var(--gc-text-3)' }}>never</span>}
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

function TierBadge({ tier, label, period, status }: {
  tier:   OrgRow['tier'];
  label:  string;
  period: OrgRow['planPeriod'];
  status: OrgRow['subscriptionStatus'];
}) {
  if (tier === 'none') {
    return <span className="text-[11px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>—</span>;
  }
  // Color the chip by tier so the page is glanceable. Past-due
  // status gets a red outline overriding the per-tier hue so a
  // failed payment is visible at first glance.
  const isPastDue = status === 'past_due' || status === 'unpaid';
  const palette = isPastDue
    ? { bg: '#fce8e6', fg: '#c5221f' }
    : tier === 'fleet'    ? { bg: '#e8f0fe', fg: '#1558d6' }
    : tier === 'growth'   ? { bg: '#e6f4ea', fg: '#137333' }
    :                       { bg: '#f3e8fd', fg: '#6b21a8' };
  const periodSuffix = period === 'annual' ? ' · yr' : period === 'month' ? ' · mo' : '';
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded inline-flex items-center gap-1"
      style={{ background: palette.bg, color: palette.fg }}
      title={status ? `Subscription status: ${status}` : undefined}>
      {label.toUpperCase()}{periodSuffix}
    </span>
  );
}

function FlagBadge({ flag }: { flag: OrgRow['flag'] }) {
  if (flag === null) {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#e6f4ea', color: '#137333' }}>ACTIVE</span>;
  }
  if (flag === 'never_activated') {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fef7e0', color: '#b06000' }} title="Org > 7d old, no loads created yet">NEVER ACTIVATED</span>;
  }
  if (flag === 'idle') {
    return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fef7e0', color: '#b06000' }} title="Last load > 14 days ago">IDLE</span>;
  }
  return <span className="text-[11px] font-bold px-2 py-0.5 rounded" style={{ background: '#fce8e6', color: '#c5221f' }} title="Org > 30d old, 0 loads in last 30 days">CHURNING</span>;
}

// ── Bits ──

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

function Td({ children, className, title, style }: { children: React.ReactNode; className?: string; title?: string; style?: React.CSSProperties }) {
  return (
    <td className={className} title={title} style={{
      textAlign:     className?.includes('text-right') ? 'right' : 'left',
      padding:       '10px 12px',
      verticalAlign: 'middle',
      ...style,
    }}>{children}</td>
  );
}
