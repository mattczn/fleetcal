'use client';

/**
 * /crm — internal sales CRM, Phase 1: leads table.
 *
 * FleetCal-internal only. Triple gate (matching the API's middleware
 * stack in apps/api/src/routes/crm.ts):
 *   1. RequireCap cap="crm.access" module="crm"
 *   2. RequireInternalOrg (Clerk org id on the internal allowlist)
 *
 * Layout follows /accounting: AppShell + status pills across the top
 * (counts from /v1/crm/stats, click filters), a filter toolbar, and a
 * server-paginated table (50/page — the list endpoint does the
 * filtering + paging, unlike accounting's client-side OpsTable, so we
 * render a plain table with the shared Th/Td primitives).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Target, Search, X, Loader2, ChevronLeft, ChevronRight, RefreshCw,
  Mail, MailX, Settings as SettingsIcon, ListOrdered, Inbox, ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import AppShell from '@/components/nav/AppShell';
import RequireCap from '@/components/auth/RequireCap';
import RequireInternalOrg from '@/components/crm/RequireInternalOrg';
import LeadDetailDrawer from '@/components/crm/LeadDetailDrawer';
import { STATUS_META, StatusChip, VerificationBadge, isLocalLead } from '@/components/crm/crmMeta';
import { Th, Td, fmtShortDate, FastTooltip } from '@/components/queue/QueueTablePrimitives';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { usePermissions } from '@/lib/usePermissions';
import { railway, RailwayError } from '@/lib/railway';
import type { CrmLead, CrmLeadStatus, CrmStats } from '@fleetcal/types';
import { CRM_LEAD_STATUSES } from '@fleetcal/types';

const PAGE_SIZE = 50;

export default function CrmPage() {
  return (
    <RequireCap cap="crm.access" module="crm">
      <RequireInternalOrg>
        <CrmPageInner />
      </RequireInternalOrg>
    </RequireCap>
  );
}

function CrmPageInner() {
  const { can } = usePermissions();
  const canManage = can('crm.manage');

  // ── Filters ─────────────────────────────────────────────────────────
  const [status,   setStatus]   = useState<CrmLeadStatus | ''>('');
  const [state,    setState]    = useState('');
  const [puMin,    setPuMin]    = useState('');
  const [puMax,    setPuMax]    = useState('');
  const [hasEmail, setHasEmail] = useState<'' | 'true' | 'false'>('');
  const [verification, setVerification] = useState<'' | 'unverified' | 'valid' | 'invalid' | 'catchall' | 'disposable' | 'unknown'>('');
  const [localOnly, setLocalOnly] = useState(false);
  const [search,   setSearch]   = useState('');
  const [page,     setPage]     = useState(0);

  // Debounced copies of the text filters so we don't fire a request
  // per keystroke. 300ms matches the app's other live-search boxes.
  const [debounced, setDebounced] = useState({ state: '', q: '', puMin: '', puMax: '' });
  useEffect(() => {
    const t = window.setTimeout(
      () => setDebounced({ state: state.trim(), q: search.trim(), puMin: puMin.trim(), puMax: puMax.trim() }),
      300,
    );
    return () => window.clearTimeout(t);
  }, [state, search, puMin, puMax]);

  // Any filter change resets to page 0.
  useEffect(() => { setPage(0); }, [status, hasEmail, verification, localOnly, debounced]);

  // ── Data ────────────────────────────────────────────────────────────
  const [leads,   setLeads]   = useState<CrmLead[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [stats,   setStats]   = useState<CrmStats | null>(null);
  // Monotonic fetch id — a stale response from a slower earlier
  // request must not clobber the newest filter state.
  const fetchId = useRef(0);

  const fetchLeads = useCallback(async () => {
    const id = ++fetchId.current;
    setLoading(true);
    try {
      const res = await railway.crmListLeads({
        status:   status || undefined,
        state:    debounced.state || undefined,
        puMin:    debounced.puMin ? Number(debounced.puMin) : undefined,
        puMax:    debounced.puMax ? Number(debounced.puMax) : undefined,
        hasEmail: hasEmail === '' ? undefined : hasEmail === 'true',
        verification: verification || undefined,
        local:    localOnly || undefined,
        q:        debounced.q || undefined,
        limit:    PAGE_SIZE,
        offset:   page * PAGE_SIZE,
      });
      if (id !== fetchId.current) return;
      setLeads(res.leads);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      if (id !== fetchId.current) return;
      setError(e instanceof RailwayError ? `Failed to load leads (${e.status})` : 'Failed to load leads.');
    } finally {
      if (id === fetchId.current) setLoading(false);
    }
  }, [status, hasEmail, verification, localOnly, debounced, page]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await railway.crmGetStats();
      setStats(res.stats);
    } catch { /* stats are decorative — the table is the source of truth */ }
  }, []);

  useEffect(() => { void fetchLeads(); }, [fetchLeads]);
  useEffect(() => { void fetchStats(); }, [fetchStats]);

  // ── Sync ────────────────────────────────────────────────────────────
  const [syncing,    setSyncing]    = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const { result } = await railway.crmSync();
      setSyncResult(
        `+${result.inserted} new lead${result.inserted === 1 ? '' : 's'}`
        + ` (${result.fetched} fetched, ${result.duplicates} dupes, ${result.disqualified} disqualified)`,
      );
      void fetchLeads();
      void fetchStats();
    } catch (e) {
      setSyncResult(e instanceof RailwayError ? `Sync failed (${e.status})` : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  // ── Verify emails (Phase 2.5) ───────────────────────────────────────
  const [verifying,     setVerifying]     = useState(false);
  const [verifyResult,  setVerifyResult]  = useState<string | null>(null);

  async function handleVerify(count: number) {
    if (verifying) return;
    setVerifying(true); setVerifyResult(null);
    try {
      const { result } = await railway.crmVerifyEmails({ count });
      if (result.aborted) {
        setVerifyResult(`Aborted: ${result.aborted}`);
      } else {
        const bits = Object.entries(result.byVerdict).map(([k, v]) => `${v} ${k}`).join(', ');
        setVerifyResult(`Verified ${result.attempted} · ${bits || 'no verdicts'}${result.routedToCallQueue ? ` · ${result.routedToCallQueue} → call queue` : ''}`);
      }
      void fetchLeads();
      void fetchStats();
    } catch (e) {
      setVerifyResult(e instanceof RailwayError ? `Verify failed (${e.status})` : 'Verify failed.');
    } finally {
      setVerifying(false);
    }
  }

  // ── Detail drawer ───────────────────────────────────────────────────
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const handleLeadUpdated = useCallback((updated: CrmLead) => {
    setLeads(prev => prev.map(l => (l.id === updated.id ? updated : l)));
    void fetchStats();
  }, [fetchStats]);

  // ── Derived ─────────────────────────────────────────────────────────
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to   = Math.min(total, (page + 1) * PAGE_SIZE);
  const allCount = stats?.totalLeads ?? total;
  const lastSync = stats?.lastSyncAt
    ? new Date(stats.lastSyncAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  const filterInputStyle: React.CSSProperties = {
    background: 'var(--gc-surface)',
    border:     '1px solid var(--gc-border)',
    color:      'var(--gc-text-1)',
  };

  return (
    <AppShell title="CRM" icon={Target} noPageScroll
      rightSlot={
        <div className="flex items-center gap-1">
          <Link href="/crm/sequences"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--gc-hover)]"
            style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
            <ListOrdered size={13} /> Sequences
          </Link>
          <Link href="/crm/outbox"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--gc-hover)]"
            style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
            <Inbox size={13} /> Outbox
          </Link>
          <Link href="/crm/settings"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--gc-hover)]"
            style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
            <SettingsIcon size={13} /> CRM settings
          </Link>
        </div>
      }>
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">
        <div className="w-full min-h-0 flex-1 flex flex-col gap-4">

          {/* Header row — lead count, sync button, last-sync stamp. */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="fleetcal-page-subtitle text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              <strong style={{ color: 'var(--gc-text-1)' }}>{allCount.toLocaleString()}</strong> leads
              in the pipeline. FMCSA census ingest → email outreach → call queue.
            </div>
            <div className="flex-1" />
            {syncResult && (
              <span className="text-[12px] font-semibold px-2.5 py-1 rounded-lg"
                style={syncResult.startsWith('+')
                  ? { background: '#e6f4ea', color: '#188038' }
                  : { background: '#fee2e2', color: '#991b1b' }}>
                {syncResult}
              </span>
            )}
            {lastSync && (
              <span className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
                Last sync {lastSync}
              </span>
            )}
            {canManage && (
              <>
                {verifyResult && (
                  <span className="text-[12px] font-semibold px-2.5 py-1 rounded-lg"
                    style={verifyResult.startsWith('Verified')
                      ? { background: '#e6f4ea', color: '#188038' }
                      : { background: '#fee2e2', color: '#991b1b' }}>
                    {verifyResult}
                  </span>
                )}
                <button onClick={() => void handleVerify(100)} disabled={verifying}
                  title="Verify the next 100 unverified email addresses via NeverBounce. Non-'valid' verdicts route to the call queue."
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                  style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}>
                  {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  Verify 100
                </button>
                <button onClick={() => void handleSync()} disabled={syncing}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Sync FMCSA
                </button>
              </>
            )}
          </div>

          {/* Status pills — compact-bucket style from /accounting.
              12 statuses don't fit as full tiles; the pill row wraps. */}
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill
              label="All" tint="#5f6368"
              count={allCount}
              active={status === ''}
              onClick={() => setStatus('')}
            />
            {CRM_LEAD_STATUSES.map(s => (
              <StatusPill
                key={s}
                label={STATUS_META[s].label}
                tint={STATUS_META[s].tint}
                count={stats?.byStatus?.[s] ?? 0}
                active={status === s}
                onClick={() => setStatus(prev => (prev === s ? '' : s))}
              />
            ))}
          </div>

          {/* Filter toolbar */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder="Search name, DBA, DOT#…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{ width: 260, ...filterInputStyle }} />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>
            <StyledSelect
              value={status}
              onChange={e => setStatus(e.target.value as CrmLeadStatus | '')}
              style={{ ...filterInputStyle, borderRadius: 8, padding: '7px 10px', fontSize: 12.5 }}>
              <option value="">Any status</option>
              {CRM_LEAD_STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </StyledSelect>
            <input type="text"
              placeholder="State"
              value={state}
              maxLength={2}
              onChange={e => setState(e.target.value.toUpperCase())}
              className="text-[13px] px-2.5 py-1.5 rounded-lg outline-none uppercase"
              style={{ width: 64, ...filterInputStyle }} />
            <input type="number"
              placeholder="PU min"
              value={puMin}
              min={0}
              onChange={e => setPuMin(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 rounded-lg outline-none"
              style={{ width: 84, ...filterInputStyle }} />
            <input type="number"
              placeholder="PU max"
              value={puMax}
              min={0}
              onChange={e => setPuMax(e.target.value)}
              className="text-[13px] px-2.5 py-1.5 rounded-lg outline-none"
              style={{ width: 84, ...filterInputStyle }} />
            <StyledSelect
              value={hasEmail}
              onChange={e => setHasEmail(e.target.value as '' | 'true' | 'false')}
              style={{ ...filterInputStyle, borderRadius: 8, padding: '7px 10px', fontSize: 12.5 }}>
              <option value="">Email: any</option>
              <option value="true">Has email</option>
              <option value="false">No email</option>
            </StyledSelect>
            <StyledSelect
              value={verification}
              onChange={e => setVerification(e.target.value as typeof verification)}
              style={{ ...filterInputStyle, borderRadius: 8, padding: '7px 10px', fontSize: 12.5 }}>
              <option value="">Verify: any</option>
              <option value="unverified">Unverified</option>
              <option value="valid">Verified valid</option>
              <option value="invalid">Invalid</option>
              <option value="catchall">Catchall</option>
              <option value="disposable">Disposable</option>
              <option value="unknown">Unknown</option>
            </StyledSelect>
            <label className="inline-flex items-center gap-1.5 text-[12.5px] font-medium cursor-pointer select-none"
              style={{ color: 'var(--gc-text-2)' }}>
              <input type="checkbox"
                checked={localOnly}
                onChange={e => setLocalOnly(e.target.checked)}
                style={{ accentColor: '#1a73e8' }} />
              Local only
            </label>
            <div className="flex-1" />
            <button onClick={() => { void fetchLeads(); void fetchStats(); }}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ ...filterInputStyle }}>
              Refresh
            </button>
          </div>

          {/* Table */}
          {error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
              <div className="flex-1 min-h-0 overflow-auto">
                <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                  <thead className="sticky top-0" style={{ background: 'var(--gc-surface)', zIndex: 2, boxShadow: '0 1px 0 var(--gc-border-light)' }}>
                    <tr>
                      <Th>Carrier</Th>
                      <Th>DOT#</Th>
                      <Th>City / State</Th>
                      <Th align="right">PU</Th>
                      <Th align="right">Drivers</Th>
                      <Th>Radius</Th>
                      <Th>Email</Th>
                      <Th>Status</Th>
                      <Th>Added</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading && leads.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-16 text-center" style={{ color: 'var(--gc-text-3)' }}>
                          <Loader2 size={18} className="animate-spin inline" />
                        </td>
                      </tr>
                    ) : leads.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-16 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                          No leads match the current filters.
                        </td>
                      </tr>
                    ) : leads.map(l => (
                      <tr key={l.id}
                        onClick={() => setOpenLeadId(l.id)}
                        className="cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
                        style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                        <Td>
                          <div className="font-semibold truncate max-w-[280px]" style={{ color: 'var(--gc-text-1)' }}>
                            {l.legalName}
                          </div>
                          {l.dbaName && (
                            <div className="text-[11px] truncate max-w-[280px]" style={{ color: 'var(--gc-text-3)' }}>
                              DBA {l.dbaName}
                            </div>
                          )}
                        </Td>
                        <Td><span className="tabular-nums">{l.dotNumber ?? '—'}</span></Td>
                        <Td>
                          <span className="truncate">
                            {[l.phyCity, l.phyState].filter(Boolean).join(', ') || '—'}
                          </span>
                        </Td>
                        <Td align="right"><span className="tabular-nums">{l.powerUnits ?? '—'}</span></Td>
                        <Td align="right"><span className="tabular-nums">{l.totalDrivers ?? '—'}</span></Td>
                        <Td>
                          {isLocalLead(l) && (
                            <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold"
                              style={{ background: '#e6f4ea', color: '#188038' }}>
                              Local
                            </span>
                          )}
                        </Td>
                        <Td>
                          {l.email ? (
                            <div className="inline-flex items-center gap-1.5">
                              <FastTooltip text={l.email}>
                                <Mail size={14} style={{ color: '#188038' }} />
                              </FastTooltip>
                              <VerificationBadge status={l.emailVerificationStatus} />
                            </div>
                          ) : (
                            <FastTooltip text="No email on file">
                              <MailX size={14} style={{ color: 'var(--gc-text-3)', opacity: 0.5 }} />
                            </FastTooltip>
                          )}
                        </Td>
                        <Td><StatusChip status={l.status} /></Td>
                        <Td>
                          <span className="tabular-nums whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                            {fmtShortDate(l.createdAt)}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination footer — server-side 50/page. */}
              <div className="flex items-center justify-between px-3 py-2"
                style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                <span className="text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                  {total === 0 ? 'No leads' : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
                  {loading && <Loader2 size={11} className="animate-spin inline ml-2" />}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="p-1.5 rounded-md transition-colors hover:bg-[var(--gc-hover)] disabled:opacity-35 disabled:cursor-default"
                    style={{ color: 'var(--gc-text-2)' }}
                    title="Previous page">
                    <ChevronLeft size={15} />
                  </button>
                  <span className="text-[12px] tabular-nums px-1" style={{ color: 'var(--gc-text-2)' }}>
                    {page + 1} / {pageCount}
                  </span>
                  <button
                    onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                    disabled={page >= pageCount - 1}
                    className="p-1.5 rounded-md transition-colors hover:bg-[var(--gc-hover)] disabled:opacity-35 disabled:cursor-default"
                    style={{ color: 'var(--gc-text-2)' }}
                    title="Next page">
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {openLeadId && (
        <LeadDetailDrawer
          leadId={openLeadId}
          onClose={() => setOpenLeadId(null)}
          onLeadUpdated={handleLeadUpdated}
        />
      )}
    </AppShell>
  );
}

// ── Status pill (compact bucket style, cf. /accounting tilesCompact) ──

function StatusPill({
  label, tint, count, active, onClick,
}: {
  label:   string;
  tint:    string;
  count:   number;
  active:  boolean;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-2 transition-colors"
      style={{
        height:       30,
        padding:      '0 11px',
        borderRadius: 999,
        background:   active ? tint : 'var(--gc-surface)',
        color:        active ? '#fff' : 'var(--gc-text-2)',
        border:       active ? '1px solid transparent' : '1px solid var(--gc-border-light)',
        fontSize:     12,
        fontWeight:   700,
        cursor:       'pointer',
      }}>
      <span style={{
        width:        8,
        height:       8,
        borderRadius: 999,
        background:   active ? '#fff' : tint,
        flex:         'none',
      }} />
      {label}
      <span className="tabular-nums" style={{ fontWeight: 800, opacity: active ? 1 : 0.75 }}>
        {count.toLocaleString()}
      </span>
    </button>
  );
}
