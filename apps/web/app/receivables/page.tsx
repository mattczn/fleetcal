'use client';

/**
 * /receivables — collections. Where we stand, then one broker at a time.
 *
 * Layout follows Billing and Paperwork: aging tiles across the top that
 * double as filters, then a single ledger card underneath.
 *
 * The ledger is one row PER CUSTOMER, not per invoice. At ~150 invoices
 * a week across 100+ brokers, a per-invoice table is 640 open rows and
 * unreadable; the same book collapses to ~112 customer rows, each
 * carrying its own aging mix, and any row opens into its invoices in
 * place.
 *
 * One fetch, filtered client-side. `/v1/payments/receivables` is called
 * with `scope` only — never with bucket/customer/search — so the tiles
 * and the per-customer rollups are always computed over the whole scope.
 * Clicking a tile narrows what you're looking at without rewriting the
 * numbers you were just reading. It also means expanding a customer
 * needs no round trip: their invoices are already here.
 *
 * Why this doesn't use OpsTable: the ledger needs master-detail
 * expansion, which OpsTable has no notion of, and teaching it would
 * change a primitive that Billing, Paperwork, Equipment and Payroll all
 * depend on. The grid below is deliberately local to this page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import React from 'react';
import {
  HandCoins, Wallet, CircleCheckBig, Clock, OctagonAlert, Inbox,
  ChevronRight, ChevronDown, ChevronLeft, MoreVertical, Search,
  ArrowDownWideNarrow, ArrowRightLeft, Download, Mail, Info, Loader2,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import Tooltip from '@/components/ui/Tooltip';
import { CopyableCell, CopyableLoadNum } from '@/components/queue/QueueTablePrimitives';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import RecordPaymentPanel from './RecordPaymentPanel';
import type {
  ReceivableInvoice, ReceivableCustomerSummary, ReceivablesTotals, AgingBucket,
} from '@fleetcal/types';

// ── formatting ────────────────────────────────────────────────────────

const money0 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const money2 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: '2-digit', year: '2-digit' });

/** Age colouring, matching Billing's two-step: amber once past terms,
 *  red past 30 days over. */
const ageColor = (d: number | null) =>
  d === null || d <= 0 ? 'var(--gc-text-3)' : d <= 30 ? '#b06000' : '#c5221f';

const ageLabel = (d: number | null) =>
  d === null ? '—' : d <= 0 ? `${Math.abs(d)}d left` : `${d}d over`;

// ── buckets ───────────────────────────────────────────────────────────

type TileKey = AgingBucket | 'all' | 'to_apply';

interface TileDef {
  key:       TileKey;
  label:     string;
  icon:      React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  tint:      string;
  tintLight: string;
  tintText:  string;
  subtitle:  string;
  formula:   string;
  /** Hairline divider before this tile. */
  sep?:      boolean;
  /** Renders the count in red — the only tile that colors it. */
  redCount?: boolean;
}

const TILES: TileDef[] = [
  { key: 'all',      label: 'All open',   icon: Wallet,         tint: '#1a73e8', tintLight: '#e8f0fe', tintText: '#1558d6',
    subtitle: 'Every unsettled invoice', formula: 'Every invoice with a balance owing, whatever its age. Void invoices are excluded — no money is expected on those.' },
  { key: 'current',  label: 'Current',    icon: CircleCheckBig, tint: '#188038', tintLight: '#e6f4ea', tintText: '#137333',
    subtitle: 'Not due yet', formula: 'Balance owing where the due date has not passed. Invoices with no due date count here — we do not chase terms we never set.' },
  { key: 'd1_30',    label: '1–30 days',  icon: Clock,          tint: '#b06000', tintLight: '#fef7e0', tintText: '#b06000',
    subtitle: 'Just past terms', formula: '1 to 30 days past the due date. Usually a broker on their normal pay cycle rather than a problem.' },
  { key: 'd31_plus', label: '31+ days',   icon: OctagonAlert,   tint: '#c5221f', tintLight: '#fce8e6', tintText: '#c5221f',
    subtitle: 'Over a month late', formula: 'More than 30 days past the due date. Past any normal broker pay cycle — someone needs to pick up the phone.', redCount: true },
  { key: 'to_apply', label: 'To apply',   icon: Inbox,          tint: '#1a73e8', tintLight: '#e8f0fe', tintText: '#1558d6',
    subtitle: 'Money not yet matched', formula: 'Payment evidence recorded but not fully applied to invoices — remittances and bank lines still to be matched.', sep: true },
];

// ── row metrics ───────────────────────────────────────────────────────

type SortBy = 'pastDue' | 'balance' | 'oldest' | 'name';

const SORT_LABEL: Record<SortBy, string> = {
  pastDue: 'Past due $',
  balance: 'Balance',
  oldest:  'Oldest first',
  name:    'A–Z',
};

/** One density. The prototype offered Compact / Comfortable / Detail;
 *  in practice only this middle tier earned its keep, so the segmented
 *  control is gone and its numbers are inlined here. The behaviour line
 *  ("pays in 41d on average") was Detail-only and rides along, since
 *  without a Detail tier there is nowhere else for it to live and it's
 *  the most useful thing the row knows about a broker. */
const ROW_H     = 46;
const BAR_H     = 8;
const NAME_SIZE = 13.5;
const BAL_SIZE  = 15;
const PAGE_SIZE = 15;

/** Aging ramp — cool to hot, left to right. */
const SEG_COLOR: Record<AgingBucket, string> = {
  current: '#c6dafc', d1_30: '#fddc9a', d31_plus: '#c5221f',
};
const ORDERED: AgingBucket[] = ['current', 'd1_30', 'd31_plus'];

const EMPTY_TOTALS: ReceivablesTotals = {
  openCount: 0, openBalance: 0, overdueCount: 0, overdueBalance: 0,
  collected30d: 0, unbackedPaidCount: 0,
  byBucket: {
    current: { count: 0, balance: 0 }, d1_30: { count: 0, balance: 0 },
    d31_plus: { count: 0, balance: 0 },
  },
};

const NO_CUSTOMER = '__none__';
const LS_SORT = 'receivables-v2:sort';

type Scope = 'open' | 'paid' | 'all';

function ReceivablesPageInner() {
  const [rows,      setRows]      = useState<ReceivableInvoice[]>([]);
  const [customers, setCustomers] = useState<ReceivableCustomerSummary[]>([]);
  const [totals,    setTotals]    = useState<ReceivablesTotals>(EMPTY_TOTALS);
  const [toApply,   setToApply]   = useState<{ count: number; total: number } | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [err,       setErr]       = useState<string | null>(null);

  const [scope,      setScope]      = useState<Scope>('open');
  const [bucket,     setBucket]     = useState<AgingBucket | null>(null);
  const [search,     setSearch]     = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy,     setSortBy]     = useState<SortBy>('pastDue');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAllFor, setShowAllFor] = useState<string | null>(null);
  const [page,       setPage]       = useState(0);
  const [tilesCompact, setTilesCompact] = useState(false);
  const [sortOpen,   setSortOpen]   = useState(false);
  const [active,     setActive]     = useState<ReceivableInvoice | null>(null);

  // EventModal keys on calendar events, so opening a load means making
  // sure its legs are in the calendar store first. Same fetch-on-demand
  // fallback Billing and Paperwork use.
  const mergeEvents   = useCalendarStore(s => s.mergeEvents);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  const openLoadInModal = useCallback(async (inv: ReceivableInvoice) => {
    if (!inv.pickupEventId) return;
    const inStore = useCalendarStore.getState().events.some(e => e.id === inv.pickupEventId);
    if (!inStore) {
      try {
        const { loads: legs } = await railway.getLoad(inv.loadId);
        mergeEvents(legs);
      } catch (e) {
        console.error('[receivables] failed to load legs for modal:', e);
        return;
      }
    }
    openEditModal(inv.pickupEventId);
  }, [mergeEvents, openEditModal]);

  // Restore persisted view prefs. An effect rather than a lazy useState
  // initializer on purpose: reading localStorage during render makes the
  // server and client disagree on first paint. Same treatment as
  // AppSidebar's collapse state.
  useEffect(() => {
    try {
      const s = window.localStorage.getItem(LS_SORT);
      if (s === 'pastDue' || s === 'balance' || s === 'oldest' || s === 'name') setSortBy(s);
    } catch { /* private mode — defaults are fine */ }
  }, []);

  const chooseSort = (s: SortBy) => {
    setSortBy(s); setSortOpen(false); setPage(0);
    try { window.localStorage.setItem(LS_SORT, s); } catch { /* ignore */ }
  };

  // Scope is the ONLY server-side filter — see the file header.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, proofs] = await Promise.all([
        railway.listReceivables({ scope }),
        railway.listPaymentProofs({ unapplied: true }).catch(() => ({ proofs: [] })),
      ]);
      setRows(res.invoices);
      setCustomers(res.customers);
      setTotals(res.totals);
      setToApply({
        count: proofs.proofs.length,
        total: proofs.proofs.reduce((s, p) => s + (p.amount - (p.appliedAmount ?? 0)), 0),
      });
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load receivables');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => { setSearchTerm(search.trim().toLowerCase()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // Invoices grouped by customer, for expansion. Built once per fetch
  // rather than filtered per render — at 640 rows across 112 customers
  // a linear scan per open row is wasted work.
  const invoicesByCustomer = useMemo(() => {
    const m = new Map<string, ReceivableInvoice[]>();
    for (const inv of rows) {
      const key = inv.customerId ?? NO_CUSTOMER;
      const list = m.get(key) ?? [];
      list.push(inv);
      m.set(key, list);
    }
    // Oldest first — the ones being chased belong at the top.
    for (const list of m.values()) {
      list.sort((a, b) => (b.agingDays ?? -99999) - (a.agingDays ?? -99999));
    }
    return m;
  }, [rows]);

  /** An invoice-number search hit should surface its customer even
   *  though the query doesn't match the customer's name. */
  const invoiceMatchCustomers = useMemo(() => {
    if (!searchTerm) return null;
    const hits = new Set<string>();
    for (const inv of rows) {
      if (inv.invoiceNumber.toLowerCase().includes(searchTerm)) {
        hits.add(inv.customerId ?? NO_CUSTOMER);
      }
    }
    return hits;
  }, [rows, searchTerm]);

  const filtered = useMemo(() => {
    let list = customers.filter(c => c.openCount > 0 || scope !== 'open');
    if (bucket) list = list.filter(c => (c.byBucket?.[bucket] ?? 0) > 0.005);
    if (searchTerm) {
      list = list.filter(c =>
        c.customerName.toLowerCase().includes(searchTerm) ||
        invoiceMatchCustomers?.has(c.customerId ?? NO_CUSTOMER));
    }
    const sorted = [...list];
    sorted.sort((a, b) =>
      sortBy === 'balance' ? b.openBalance - a.openBalance
      : sortBy === 'oldest' ? (b.oldestAgingDays ?? -99999) - (a.oldestAgingDays ?? -99999)
      : sortBy === 'name'   ? a.customerName.localeCompare(b.customerName)
      : b.overdueBalance - a.overdueBalance);
    return sorted;
  }, [customers, bucket, searchTerm, invoiceMatchCustomers, sortBy, scope]);

  const pageCount  = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, pageCount - 1);
  const pageRows   = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const shownTotal = filtered.reduce((s, c) => s + c.openBalance, 0);

  const grid = '24px minmax(180px,1fr) 210px 84px 64px 108px 132px 30px';

  const tileStats = (key: TileKey): { count: number; total: number } => {
    if (key === 'all')      return { count: totals.openCount, total: totals.openBalance };
    if (key === 'to_apply') return { count: toApply?.count ?? 0, total: toApply?.total ?? 0 };
    const cell = totals.byBucket[key];
    return { count: cell.count, total: cell.balance };
  };

  function exportAging() {
    const head = ['Customer', 'Open invoices', 'Oldest days over', 'Current', '1-30', '31+', 'Past due', 'Balance'];
    const body = filtered.map(c => [
      `"${c.customerName.replace(/"/g, '""')}"`,
      c.openCount,
      c.oldestAgingDays ?? '',
      c.byBucket?.current ?? 0,
      c.byBucket?.d1_30 ?? 0,
      c.byBucket?.d31_plus ?? 0,
      c.overdueBalance,
      c.openBalance,
    ].join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `receivables-aging-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const rightSlot = (
    <div className="flex items-center gap-2">
      <button onClick={exportAging}
        className="inline-flex items-center gap-1.5"
        style={{
          height: 32, padding: '0 12px', border: '1px solid var(--gc-border)',
          borderRadius: 8, background: 'var(--gc-surface)',
          fontSize: 12, fontWeight: 700, color: 'var(--gc-text-2)',
        }}>
        <Download size={13} /> Export aging
      </button>
      {/* Inert this pass — the remittance-matching workspace it opens
          isn't built yet. Rendered so the affordance is in place. */}
      <Tooltip content="Remittance matching isn't wired up yet — record payments from an invoice row for now." placement="bottom">
        <span className="inline-flex items-center gap-1.5"
          style={{
            height: 32, padding: '0 12px', borderRadius: 8,
            background: '#1a73e8', color: '#fff',
            fontSize: 12, fontWeight: 700, opacity: 0.55, cursor: 'default',
          }}>
          <ArrowRightLeft size={13} /> Apply a payment
        </span>
      </Tooltip>
    </div>
  );

  return (
    <AppShell title="Receivables" icon={HandCoins} rightSlot={rightSlot} noPageScroll>
      {/* Hydrates the calendar store that EventModal reads from — the
          Title column opens a load in it. */}
      <DataLoader />
      <div className="flex-1 flex flex-col min-h-0" style={{ padding: '18px 24px', gap: 14 }}>

        {/* 1 — subtitle */}
        <div className="fleetcal-page-subtitle" style={{ flex: 'none', fontSize: 12.5, color: 'var(--gc-text-3)' }}>
          Collections view.{' '}
          <span style={{ color: 'var(--gc-text-2)', fontWeight: 700 }}>{money0(totals.openBalance)}</span>
          {' '}across {totals.openCount.toLocaleString()} open invoice{totals.openCount === 1 ? '' : 's'} from{' '}
          {customers.filter(c => c.openCount > 0).length.toLocaleString()} customers · aging as of{' '}
          {new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
        </div>

        {/* 2 — bucket tiles */}
        <div style={{ flex: 'none' }}>
          {tilesCompact ? (
            <div className="fleetcal-buckets-compact flex items-center gap-2 flex-wrap">
              {TILES.map(b => {
                const activeTile = b.key === 'all' ? bucket === null : bucket === b.key;
                const s = tileStats(b.key);
                return (
                  <button key={b.key}
                    onClick={() => { if (b.key !== 'to_apply') { setBucket(b.key === 'all' ? null : b.key as AgingBucket); setPage(0); } }}
                    className="fleetcal-bucket-compact inline-flex items-center gap-2 transition-colors"
                    title={`${b.label} — ${b.subtitle}`}
                    style={{
                      height: 34, padding: '0 12px', borderRadius: 999,
                      background: activeTile ? b.tint : 'var(--gc-surface)',
                      color:      activeTile ? '#fff' : 'var(--gc-text-2)',
                      border:     activeTile ? '1px solid transparent' : '1px solid var(--gc-border-light)',
                      fontSize: 12.5, fontWeight: 700,
                      cursor: b.key === 'to_apply' ? 'default' : 'pointer',
                      opacity: b.key === 'to_apply' ? 0.75 : 1,
                    }}>
                    <span style={{ width: 9, height: 9, borderRadius: 999, background: activeTile ? '#fff' : b.tint, flex: 'none' }} />
                    {b.label}
                    {loading
                      ? <Loader2 size={12} className="animate-spin" style={{ color: activeTile ? '#fff' : b.tint }} />
                      : <span style={{ fontWeight: 800 }}>{s.count.toLocaleString()}</span>}
                    <span className="tabular-nums" style={{ color: activeTile ? 'rgba(255,255,255,0.85)' : 'var(--gc-text-3)', fontWeight: 600 }}>
                      {money0(s.total)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="fleetcal-buckets flex items-stretch gap-2">
              {TILES.map((b, i) => {
                const activeTile = b.key === 'all' ? bucket === null : bucket === b.key;
                const s    = tileStats(b.key);
                const Icon = b.icon;
                const next = TILES[i + 1];
                const inert = b.key === 'to_apply';
                return (
                  <React.Fragment key={b.key}>
                    {b.sep && <span style={{ width: 1, background: 'var(--gc-border-light)', margin: '6px 3px' }} />}
                    <button
                      onClick={() => { if (!inert) { setBucket(b.key === 'all' ? null : b.key as AgingBucket); setPage(0); } }}
                      className="fleetcal-bucket text-left rounded-2xl transition-all relative overflow-hidden flex-1 min-w-0"
                      style={{
                        background: 'var(--gc-surface)',
                        border:     activeTile ? '1px solid transparent' : '1px solid var(--gc-border-light)',
                        boxShadow:  activeTile ? 'var(--shadow-soft)' : 'var(--shadow-1)',
                        transform:  activeTile ? 'translateY(-2px)' : 'translateY(0)',
                        padding:    '13px 15px',
                        cursor:     inert ? 'default' : 'pointer',
                      }}>
                      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: activeTile ? b.tint : 'transparent' }} />
                      <div className="flex items-center gap-2.5">
                        <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: b.tintLight, flex: 'none' }}>
                          <Icon size={17} style={{ color: b.tint }} />
                        </span>
                        <span className="text-[13.5px] font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {b.label}
                        </span>
                        <Tooltip content={b.formula} placement="bottom">
                          <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
                        </Tooltip>
                        {loading ? (
                          <Loader2 size={14} className="ml-auto animate-spin" style={{ color: b.tint }} />
                        ) : (
                          <span className="ml-auto tabular-nums" style={{
                            fontSize: 22, fontWeight: 800, lineHeight: 1,
                            color: b.redCount ? '#c5221f' : 'var(--gc-text-1)',
                          }}>
                            {s.count.toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-2 mt-2">
                        <span className="text-[11.5px] font-semibold truncate" style={{ color: 'var(--gc-text-3)' }}>
                          {b.subtitle}
                        </span>
                        <span className="tabular-nums" style={{
                          fontSize: 13.5, fontWeight: 800,
                          color: activeTile ? b.tintText : 'var(--gc-text-2)',
                        }}>
                          {money0(s.total)}
                        </span>
                      </div>
                    </button>
                    {next && !next.sep && (
                      <span className="fleetcal-chevron hidden md:flex items-center justify-center"
                            style={{ width: 18, color: 'var(--gc-border)', flex: 'none' }}>
                        <ChevronRight size={16} />
                      </span>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>

        {err && (
          <div style={{
            flex: 'none', borderRadius: 12, background: '#fee2e2',
            border: '1px solid #fecaca', color: '#991b1b', fontSize: 14, padding: 14,
          }}>
            {err}
          </div>
        )}

        {/* 3 — ledger card */}
        <div className="flex flex-col" style={{
          flex: 1, minHeight: 0, background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border-light)', borderRadius: 14,
          boxShadow: '0 1px 2px rgba(60,64,67,.1)', overflow: 'hidden',
        }}>

          {/* toolbar */}
          <div className="flex items-center" style={{
            height: 50, flex: 'none', padding: '0 14px', gap: 10,
            borderBottom: '1px solid var(--gc-border-light)',
          }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--gc-text-1)' }}>By customer</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
              {filtered.length.toLocaleString()} with an open balance · showing {pageRows.length}
            </span>
            <div style={{ flex: 1 }} />

            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--gc-text-3)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Customer or invoice #"
                style={{
                  height: 30, paddingLeft: 26, paddingRight: 10, width: 190,
                  border: '1px solid var(--gc-border)', borderRadius: 8,
                  fontSize: 12, color: 'var(--gc-text-1)', outline: 'none',
                  background: 'var(--gc-surface)',
                }} />
            </div>

            <div className="relative">
              <button onClick={() => setSortOpen(o => !o)}
                className="inline-flex items-center gap-1.5"
                style={{
                  height: 30, padding: '0 10px', border: '1px solid var(--gc-border)',
                  borderRadius: 8, fontSize: 12, fontWeight: 700, color: 'var(--gc-text-2)',
                  background: 'var(--gc-surface)',
                }}>
                <ArrowDownWideNarrow size={13} /> {SORT_LABEL[sortBy]}
              </button>
              {sortOpen && (
                <>
                  <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 mt-1 rounded-lg border overflow-hidden" style={{
                    zIndex: 41, minWidth: 150, borderColor: 'var(--gc-border)',
                    background: 'var(--gc-surface)', boxShadow: 'var(--shadow-2, 0 8px 24px rgba(0,0,0,0.15))',
                  }}>
                    {(Object.keys(SORT_LABEL) as SortBy[]).map(s => (
                      <button key={s} onClick={() => chooseSort(s)}
                        className="w-full text-left"
                        style={{
                          padding: '7px 11px', fontSize: 12,
                          fontWeight: sortBy === s ? 700 : 600,
                          color: sortBy === s ? '#1a73e8' : 'var(--gc-text-2)',
                          background: sortBy === s ? 'var(--gc-blue-light, #e8f0fe)' : 'transparent',
                        }}>
                        {SORT_LABEL[s]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="flex rounded border overflow-hidden" style={{ borderColor: 'var(--gc-border)', height: 30 }}>
              {(['open', 'paid', 'all'] as Scope[]).map(s => (
                <button key={s} onClick={() => { setScope(s); setBucket(null); setPage(0); }}
                  style={{
                    padding: '0 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
                    background: scope === s ? '#1a73e8' : 'transparent',
                    color:      scope === s ? '#fff' : 'var(--gc-text-3)',
                  }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* header row */}
          <div style={{
            display: 'grid', gridTemplateColumns: grid, gap: 12, padding: '0 14px',
            height: 36, flex: 'none', alignItems: 'center',
            borderBottom: '1px solid var(--gc-border-light)',
            fontSize: 11, fontWeight: 700, letterSpacing: '.05em',
            textTransform: 'uppercase', color: 'var(--gc-text-3)',
          }}>
            <span />
            <span>Customer</span>
            <span>Aging mix</span>
            <span style={{ textAlign: 'right' }}>Oldest</span>
            <span style={{ textAlign: 'right' }}>Open</span>
            <span style={{ textAlign: 'right' }}>Past due</span>
            <span style={{ textAlign: 'right' }}>Balance</span>
            <span />
          </div>

          {/* body — the page's only scroll container */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
               onScroll={e => {
                 const y = e.currentTarget.scrollTop;
                 if (y > 40 && !tilesCompact) setTilesCompact(true);
                 else if (y < 8 && tilesCompact) setTilesCompact(false);
               }}>
            {loading ? (
              <div style={{ padding: 24, fontSize: 12.5, color: 'var(--gc-text-3)' }}>Loading…</div>
            ) : pageRows.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: 'var(--gc-text-3)' }}>
                {scope === 'open'
                  ? 'Nothing outstanding — every invoice in this view is settled.'
                  : 'No customers match the current filters.'}
              </div>
            ) : pageRows.map(c => {
              const key       = c.customerId ?? NO_CUSTOMER;
              const expanded  = expandedId === key;
              const bb        = c.byBucket ?? { current: 0, d1_30: 0, d31_plus: 0 };
              const pct = (v: number) => (c.openBalance > 0 ? `${(v / c.openBalance * 100).toFixed(1)}%` : '0%');
              const all       = invoicesByCustomer.get(key) ?? [];
              const showAll   = showAllFor === key;
              const shown     = showAll ? all : all.slice(0, 5);
              const notDue    = all.filter(i => (i.agingDays ?? -1) <= 0).length;

              return (
                <div key={key} style={expanded ? { background: '#f8fbff', boxShadow: 'inset 3px 0 0 #1a73e8' } : undefined}>
                  {/* customer row */}
                  <div
                    onClick={() => { setExpandedId(expanded ? null : key); setShowAllFor(null); }}
                    className="cursor-pointer"
                    style={{
                      display: 'grid', gridTemplateColumns: grid, gap: 12, padding: '0 14px',
                      height: ROW_H, alignItems: 'center',
                      borderBottom: '1px solid #f1f3f4',
                    }}
                    onMouseOver={e => { if (!expanded) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}>

                    {expanded
                      ? <ChevronDown size={15} style={{ color: '#1a73e8' }} />
                      : <ChevronRight size={15} style={{ color: 'var(--gc-text-3)' }} />}

                    <div className="min-w-0">
                      <div className="truncate" style={{ fontSize: NAME_SIZE, fontWeight: 700, color: 'var(--gc-blue-text)' }}>
                        {c.customerName}
                      </div>
                      {(
                        <div className="truncate" style={{ fontSize: 11, fontWeight: 600, color: 'var(--gc-text-3)' }}>
                          {c.openCount} open · {c.overdueBalance > 0 ? `${money0(c.overdueBalance)} past due` : 'nothing past due'}
                          {c.termsDays ? ` · net ${c.termsDays}` : ''}
                        </div>
                      )}
                    </div>

                    {/* aging mix */}
                    <div className="flex flex-col" style={{ gap: 4 }}>
                      <div className="flex" style={{ height: BAR_H, borderRadius: 999, overflow: 'hidden', gap: 2 }}>
                        {ORDERED.map(k => (
                          <span key={k} style={{ width: pct(bb[k]), background: SEG_COLOR[k], flex: 'none' }} />
                        ))}
                      </div>
                      {(
                        <div className="truncate" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
                          {c.avgDaysToPay != null ? `pays in ${c.avgDaysToPay}d on average` : 'no payment history yet'}
                          {c.termsDays ? ` · terms net ${c.termsDays}` : ''}
                        </div>
                      )}
                    </div>

                    <span className="tabular-nums" style={{
                      textAlign: 'right', fontSize: 12.5, fontWeight: 800, color: ageColor(c.oldestAgingDays),
                    }}>
                      {c.oldestAgingDays == null ? '—' : `${Math.max(c.oldestAgingDays, 0)}d`}
                    </span>

                    <span style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-2)' }}>
                      {c.openCount}
                    </span>

                    <span className="tabular-nums" style={{
                      textAlign: 'right', fontSize: 12.5, fontWeight: 700,
                      color: c.overdueBalance > 0 ? '#c5221f' : 'var(--gc-text-3)',
                    }}>
                      {c.overdueBalance > 0 ? money0(c.overdueBalance) : '—'}
                    </span>

                    <span className="tabular-nums" style={{
                      textAlign: 'right', fontSize: BAL_SIZE, fontWeight: 800, color: 'var(--gc-text-1)',
                    }}>
                      {money0(c.openBalance)}
                    </span>

                    <span style={{ textAlign: 'right' }}>
                      <MoreVertical size={15} style={{ color: 'var(--gc-text-3)' }} />
                    </span>
                  </div>

                  {/* expanded invoices */}
                  {expanded && (
                    <div style={{ padding: '0 14px 14px 40px' }}>
                      <div style={{
                        border: '1px solid var(--gc-border-light)', borderRadius: 10,
                        background: 'var(--gc-surface)', overflow: 'hidden',
                      }}>
                        <div style={{
                          display: 'grid', gridTemplateColumns: INNER_GRID, gap: 10, padding: '0 12px',
                          height: 34, alignItems: 'center', background: 'var(--gc-bg)',
                          borderBottom: '1px solid var(--gc-border-light)',
                          fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '.05em', color: 'var(--gc-text-3)',
                        }}>
                          <span />
                          <span>Inv #</span>
                          <span>Load #</span>
                          <span>Title</span>
                          <span>Issued</span>
                          <span>Due</span>
                          <span style={{ textAlign: 'right' }}>Age</span>
                          <span style={{ textAlign: 'right' }}>Total</span>
                          <span style={{ textAlign: 'right' }}>Balance</span>
                          <span style={{ textAlign: 'center' }}>Status</span>
                        </div>

                        {shown.map(inv => {
                          const age    = inv.agingDays;
                          const stripe = age != null && age > 30 ? '#c5221f' : age != null && age > 0 ? '#e37400' : 'transparent';
                          const st     = statusOf(inv);
                          return (
                            <div key={inv.id}
                              onClick={() => setActive(inv)}
                              className="cursor-pointer"
                              title="Record a payment against this invoice"
                              style={{
                                display: 'grid', gridTemplateColumns: INNER_GRID, gap: 10, padding: '0 12px',
                                height: 40, alignItems: 'center', fontSize: 12.5,
                                borderBottom: '1px solid #f1f3f4',
                                boxShadow: stripe === 'transparent' ? undefined : `inset 3px 0 0 ${stripe}`,
                              }}
                              onMouseOver={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                              onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}>
                              <span style={{
                                width: 15, height: 15, border: '1.5px solid var(--gc-border)', borderRadius: 3,
                              }} />
                              {/* Same copy-to-clipboard primitives Billing uses, so
                                  the paste payload is identical across pages. */}
                              <span onClick={e => e.stopPropagation()}>
                                <CopyableCell value={inv.invoiceNumber} displayValue={inv.invoiceNumber}
                                  title="Copy invoice #" />
                              </span>
                              <span onClick={e => e.stopPropagation()}>
                                {inv.loadNum
                                  ? <CopyableLoadNum value={inv.loadNum} />
                                  : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </span>
                              <button type="button"
                                onClick={e => { e.stopPropagation(); void openLoadInModal(inv); }}
                                className="text-left font-semibold hover:underline truncate"
                                style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
                                title="Open load details">
                                {inv.title ?? (inv.internalLoadId != null ? `#${inv.internalLoadId}` : '—')}
                              </button>
                              <span style={{ color: 'var(--gc-text-3)' }}>{shortDate(inv.issuedAt)}</span>
                              <span style={{ color: 'var(--gc-text-3)' }}>{inv.dueAt ? shortDate(inv.dueAt) : '—'}</span>
                              <span className="tabular-nums" style={{ textAlign: 'right', fontWeight: 800, color: ageColor(age) }}>
                                {ageLabel(age)}
                              </span>
                              <span className="tabular-nums" style={{ textAlign: 'right' }}>{money2(inv.total)}</span>
                              <span className="tabular-nums" style={{ textAlign: 'right', fontWeight: 800 }}>{money2(inv.balance)}</span>
                              <span style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
                                  background: st.bg, color: st.fg,
                                }}>
                                  {st.label}
                                </span>
                              </span>
                            </div>
                          );
                        })}

                        <div className="flex items-center gap-2" style={{
                          padding: '9px 12px', background: 'var(--gc-bg)', fontSize: 11.5,
                        }}>
                          <span style={{ fontWeight: 600, color: 'var(--gc-text-3)' }}>
                            Showing {shown.length} of {all.length}
                            {notDue > 0 ? ` · ${notDue} current, not due` : ''}
                          </span>
                          {!showAll && all.length > shown.length && (
                            <button onClick={e => { e.stopPropagation(); setShowAllFor(key); }}
                              style={{ fontWeight: 700, color: '#1967d2' }}>
                              Show all
                            </button>
                          )}
                          <div style={{ flex: 1 }} />
                          <span className="inline-flex items-center gap-1.5" style={{
                            height: 28, padding: '0 10px', border: '1px solid var(--gc-border)',
                            borderRadius: 8, fontSize: 11.5, fontWeight: 700, color: 'var(--gc-text-2)',
                            opacity: 0.55, cursor: 'default',
                          }}>
                            <Mail size={12} /> Statement
                          </span>
                          <span className="inline-flex items-center gap-1.5" style={{
                            height: 28, padding: '0 10px', borderRadius: 8,
                            background: '#1a73e8', color: '#fff', fontSize: 11.5, fontWeight: 700,
                            opacity: 0.55, cursor: 'default',
                          }}>
                            <ArrowRightLeft size={12} /> Apply a payment
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* card footer */}
          <div className="flex items-center" style={{
            height: 42, flex: 'none', padding: '0 14px', background: 'var(--gc-bg)',
            borderTop: '1px solid var(--gc-border-light)',
          }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
              {filtered.length === 0
                ? 'No customers'
                : `Showing ${safePage * PAGE_SIZE + 1}–${safePage * PAGE_SIZE + pageRows.length} of ${filtered.length} customers · ${money0(shownTotal)} outstanding`}
            </span>
            <div style={{ flex: 1 }} />
            <div className="flex items-center gap-2">
              <PagerButton disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>
                <ChevronLeft size={14} />
              </PagerButton>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--gc-text-2)' }}>
                Page {safePage + 1} of {pageCount}
              </span>
              <PagerButton disabled={safePage >= pageCount - 1} onClick={() => setPage(p => p + 1)}>
                <ChevronRight size={14} />
              </PagerButton>
            </div>
          </div>
        </div>
      </div>

      {/* Recording a payment still lives here: the redesign's "Apply a
          payment" workspace isn't built, so an invoice row opens the
          existing panel rather than leaving no way to record money. */}
      {active && (
        <RecordPaymentPanel
          row={active}
          onSaved={() => void load()}
          onClose={() => setActive(null)}
        />
      )}
    </AppShell>
  );
}

const INNER_GRID = '34px 104px 108px 1fr 92px 92px 88px 104px 104px 100px';

/** Status pill. Part-paid outranks age — "we got something" is the more
 *  useful fact than "it's late". Overdue starts past 30 days so the pill
 *  agrees with the row's red stripe. */
function statusOf(inv: ReceivableInvoice): { label: string; bg: string; fg: string } {
  if (inv.paidAmount > 0.005 && inv.balance > 0.005) {
    return { label: 'Part paid', bg: '#e6f4ea', fg: '#137333' };
  }
  const a = inv.agingDays;
  if (a != null && a > 30) return { label: 'Overdue', bg: '#fce8e6', fg: '#c5221f' };
  if (a != null && a > 0)  return { label: 'Due',     bg: '#f1f3f4', fg: '#5f6368' };
  return { label: 'Current', bg: '#f1f3f4', fg: '#5f6368' };
}

function PagerButton({ disabled, onClick, children }: {
  disabled: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="grid place-items-center"
      style={{
        width: 26, height: 26, border: '1px solid var(--gc-border)', borderRadius: 7,
        background: 'var(--gc-surface)', color: 'var(--gc-text-2)',
        opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer',
      }}>
      {children}
    </button>
  );
}

export default function ReceivablesPage() {
  return (
    <RequireCap cap="receivables.access" module="receivables">
      <ReceivablesPageInner />
    </RequireCap>
  );
}
