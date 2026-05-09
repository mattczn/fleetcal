'use client';

/**
 * /closeout — POD verification + release queue.
 *
 * Tabs:
 *  Pending     — loads delivered/due that haven't been verified yet
 *  Flagged     — held back pending follow-up (missing POD, rate dispute, …)
 *  Verified    — released for invoicing, awaiting accounting batch
 *  Invoiced    — sent to broker, awaiting payment
 *  Paid        — closed out
 *
 * Default is Pending, sorted oldest delivery first. Click a row → opens
 * the existing event modal (the focused review-queue mode is the next
 * iteration). Fetched events are merged into the calendar store so the
 * modal can find them even when they're outside the calendar's loaded
 * window.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCheck2, Loader2, Flag, CheckCircle2, Clock, Play, Copy, Check, FileText, ChevronLeft, ChevronRight, Star, ArrowUp, ArrowDown, X } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useAuth, useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import type { Load, CalendarEvent } from '@/lib/types';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { displayBrokerName } from '@/lib/customerMatch';
import ReviewQueue from './ReviewQueue';
import { FlagModal, type FlagReason } from './FlagModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';

type Tab = 'pending' | 'flagged' | 'verified' | 'invoiced' | 'paid';

const PAGE_SIZE = 50;

interface CacheEntry {
  loads: CalendarEvent[];
  docCounts: Record<string, Record<string, number>>;
  total: number;
  fetchedAt: number;
}

// Column keys used by the sort + filter system. Must match the
// Th `sortKey` values in the table head and the row-projection
// function below (`projectRowForCol`).
type ColKey =
  | 'age'
  | 'delivered'
  | 'loadNum'
  | 'title'
  | 'customer'
  | 'driver'
  | 'rate'
  | 'accessorials';

interface SortState { key: ColKey | null; dir: 'asc' | 'desc' }

type FilterState = Partial<Record<ColKey, string>>;

const TABS: { value: Tab; label: string }[] = [
  { value: 'pending',  label: 'Pending'   },
  { value: 'flagged',  label: 'Flagged'   },
  { value: 'verified', label: 'Verified'  },
  { value: 'invoiced', label: 'Invoiced'  },
  { value: 'paid',     label: 'Paid'      },
];

function ageDays(deliveredEnd: string): number {
  const t = new Date(deliveredEnd).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function ageColor(days: number): { bg: string; fg: string } {
  if (days <= 1) return { bg: '#dcfce7', fg: '#15803d' };
  if (days <= 3) return { bg: '#fef3c7', fg: '#92400e' };
  if (days <= 7) return { bg: '#fed7aa', fg: '#9a3412' };
  return { bg: '#fee2e2', fg: '#991b1b' };
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface QueueRow extends CalendarEvent { /* alias for clarity */ }

export default function CloseoutView() {
  const customers = useCalendarStore(s => s.customers);
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const { user } = useUser();
  // Clerk readiness gate — without this, a hard refresh on /closeout
  // fires the queue request before RailwayClientProvider has a chance
  // to wire the token (its useEffect runs after children's effects),
  // so the API rejects with 401. Navigating from /calendar works
  // because the provider is already wired from the previous page.
  const { isLoaded: authLoaded, isSignedIn } = useAuth();

  const [tab, setTab] = useState<Tab>('pending');
  // Per-tab page state — switching tabs preserves where you were.
  const [pageByTab, setPageByTab] = useState<Record<Tab, number>>({
    pending: 0, flagged: 0, verified: 0, invoiced: 0, paid: 0,
  });
  const page = pageByTab[tab];
  const setPage = (next: number) => setPageByTab(p => ({ ...p, [tab]: next }));

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [docCounts, setDocCounts] = useState<Record<string, Record<string, number>>>({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewStartIndex, setReviewStartIndex] = useState(0);
  const [flagTarget, setFlagTarget] = useState<Load | null>(null);
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  // In-memory cache keyed by `${tab}:${page}`. Tab switches and page
  // changes show cached data instantly while a background refetch
  // updates it. Cleared per-tab when an action mutates that tab's
  // contents (verify / flag / etc).
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  const cacheKey = `${tab}:${page}`;

  const renderFromCache = (key: string): boolean => {
    const cached = cacheRef.current.get(key);
    if (!cached) return false;
    setRows(cached.loads as QueueRow[]);
    setDocCounts(cached.docCounts);
    setTotal(cached.total);
    return true;
  };

  const fetchAndCache = useMemo(() => async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const offset = page * PAGE_SIZE;
      const { loads, docCounts, total } = await railway.listCloseoutQueue(tab, { limit: PAGE_SIZE, offset });
      const entry: CacheEntry = { loads, docCounts, total, fetchedAt: Date.now() };
      cacheRef.current.set(`${tab}:${page}`, entry);
      // Only update view state if user is still on this tab/page —
      // background refetches for previous pages shouldn't clobber the
      // current view.
      if (tab === tab && page === page) {
        setRows(loads as QueueRow[]);
        setDocCounts(docCounts ?? {});
        setTotal(total ?? loads.length);
      }
      mergeEvents(loads as QueueRow[]);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [tab, page, mergeEvents]);

  // Invalidate every cached page for the active tab — call after any
  // action that mutates membership (verify, flag, reopen).
  const invalidateTab = (t: Tab) => {
    for (const k of Array.from(cacheRef.current.keys())) {
      if (k.startsWith(`${t}:`)) cacheRef.current.delete(k);
    }
  };

  // Render cached data on tab/page change, then refresh in the background.
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    const had = renderFromCache(cacheKey);
    void fetchAndCache(!had);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, authLoaded, isSignedIn]);

  const refresh = async () => {
    invalidateTab(tab);
    await fetchAndCache(false);
  };

  // Dedup relays — one row per load (the pickup leg wins).
  const dedup = useMemo(() => {
    const pickupGroups = new Set(
      rows.filter(r => r.relayGroupId && r.relayRole === 'pickup').map(r => r.relayGroupId!),
    );
    return rows.filter(r => {
      if (!r.relayGroupId) return true;
      if (r.relayRole === 'pickup') return true;
      if (r.relayRole === 'delivery') return !pickupGroups.has(r.relayGroupId);
      return true;
    });
  }, [rows]);

  // Per-column sort + filter state. Resets when changing tabs since
  // tabs have different shapes/actions. Filters apply to the current
  // page only — a known limitation now that the queue is paginated.
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'asc' });
  const [filters, setFilters] = useState<FilterState>({});
  // Reset sort/filter when tab changes — different tabs surface
  // different relevant signals.
  useEffect(() => { setSort({ key: null, dir: 'asc' }); setFilters({}); }, [tab]);

  // Project a row to its sortable value for a given column. Numbers
  // for numeric columns so the comparator orders them naturally.
  const projectRowForCol = (row: QueueRow, col: ColKey): string | number => {
    switch (col) {
      case 'age':       return ageDays(row.end);
      case 'delivered': return row.end;
      case 'loadNum':   return row.loadNum ?? '';
      case 'title':     return row.title ?? '';
      case 'customer':  return displayBrokerName(row.broker, customers) ?? '';
      case 'driver':    return row.driverName ?? '';
      case 'rate':      return row.loadPrice ?? 0;
      case 'accessorials':
        return (row.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
    }
  };

  // The filter dropdowns work on the same human-readable string the
  // cell renders — that way the option list mirrors what the user is
  // actually looking at. Match is exact since the user picks from a
  // closed set of values.
  const formatRowForCol = (row: QueueRow, col: ColKey): string => {
    switch (col) {
      case 'age': {
        const d = ageDays(row.end);
        return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
      }
      case 'delivered': return fmtDate(row.end) || '—';
      case 'loadNum':   return row.loadNum ?? '';
      case 'title':     return row.title ?? '';
      case 'customer':  return displayBrokerName(row.broker, customers) ?? '';
      case 'driver':    return row.driverName ?? '';
      // Rate + accessorials don't get filter dropdowns — these branches
      // are unused but kept exhaustive for future-proofing.
      case 'rate':         return row.loadPrice != null ? moneyFmt.format(row.loadPrice) : '';
      case 'accessorials': return moneyFmt.format((row.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0));
    }
  };

  // Per-column option lists for the filter selects. Built from the
  // current page's data so the user only ever picks values that exist.
  const filterableCols: ColKey[] = ['age', 'delivered', 'loadNum', 'title', 'customer', 'driver'];
  const filterOptions = useMemo(() => {
    const opts: Partial<Record<ColKey, string[]>> = {};
    for (const col of filterableCols) {
      const set = new Set<string>();
      for (const row of dedup) {
        const v = formatRowForCol(row, col);
        if (v) set.add(v);
      }
      opts[col] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dedup, customers]);

  // Apply filters → then sort, but always pin priority rows to the
  // top so dispatchers' high-priority work stays visible regardless
  // of the user's chosen sort.
  const visible = useMemo(() => {
    let out = dedup;
    const activeFilters = (Object.entries(filters) as [ColKey, string][]).filter(([, v]) => v && v.trim() !== '');
    if (activeFilters.length > 0) {
      out = out.filter(row => {
        return activeFilters.every(([col, q]) => formatRowForCol(row, col) === q);
      });
    }
    if (sort.key) {
      const k = sort.key;
      const mul = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = projectRowForCol(a, k);
        const bv = projectRowForCol(b, k);
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
        return String(av).localeCompare(String(bv)) * mul;
      });
    }
    // Priority pin is non-negotiable — always first.
    return [...out].sort((a, b) => Number(!!b.priority) - Number(!!a.priority));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dedup, sort, filters, customers]);

  const onSortClick = (key: ColKey) => {
    setSort(prev => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: 'asc' }; // third click clears
    });
  };
  const setFilter = (key: ColKey, val: string) => setFilters(f => ({ ...f, [key]: val }));
  const clearAllFilters = () => setFilters({});
  const activeFilterCount = Object.values(filters).filter(v => v && v.trim() !== '').length;

  const tabCount = (t: Tab) => t === tab ? dedup.length : null;

  async function handleVerify(load: Load) {
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    // PATCH /v1/closeout/loads/:id keys off the loads-table uuid, not
    // the event uuid. Each row in the queue is an event, so we have to
    // resolve the parent load id before sending the action.
    const targetId = load.loadId ?? load.id;
    await railway.updateLoadCloseout(targetId, { action: 'verify', actorName });
    await refresh();
  }

  function handleFlag(load: Load) {
    setFlagTarget(load);
  }

  async function confirmFlag(reason: FlagReason, note: string) {
    if (!flagTarget) return;
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    const targetId = flagTarget.loadId ?? flagTarget.id;
    await railway.updateLoadCloseout(targetId, { action: 'flag', flagReason: reason, flagNote: note, actorName });
    setFlagTarget(null);
    await refresh();
  }

  async function handleTogglePriority(load: Load) {
    const targetId = load.loadId ?? load.id;
    const next = !load.priority;
    await railway.updateLoadCloseout(targetId, { action: next ? 'set_priority' : 'clear_priority' });
    await refresh();
  }

  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Closeout" icon={FileCheck2} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1600px] mx-auto space-y-4">

          {/* Tab pills */}
          <div className="flex items-center gap-1.5">
            {TABS.map(({ value, label }) => {
              const active = tab === value;
              const count = tabCount(value);
              return (
                <button key={value} onClick={() => setTab(value)}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-semibold transition-colors"
                  style={{
                    border: `1px solid ${active ? '#1a73e8' : 'var(--gc-border)'}`,
                    background: active ? '#1a73e8' : 'var(--gc-surface)',
                    color: active ? '#fff' : 'var(--gc-text-2)',
                  }}>
                  {label}
                  {count != null && (
                    <span style={{
                      background: active ? 'rgba(255,255,255,0.22)' : 'var(--gc-border-light)',
                      color: active ? '#fff' : 'var(--gc-text-3)',
                      padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                    }}>{count}</span>
                  )}
                </button>
              );
            })}
            <div className="flex-1" />
            {(tab === 'pending' || tab === 'flagged') && visible.length > 0 && (
              <button onClick={() => { setReviewStartIndex(0); setReviewOpen(true); }}
                className="flex items-center gap-1.5 text-[13px] font-bold px-4 py-1.5 rounded-full text-white transition-colors"
                style={{ background: '#15803d' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#166534')}
                onMouseLeave={e => (e.currentTarget.style.background = '#15803d')}>
                <Play size={13} fill="currentColor" /> Review queue ({visible.length})
              </button>
            )}
            <button onClick={() => void refresh()}
              className="text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
              Refresh
            </button>
          </div>

          {/* Body */}
          {loading ? (
            <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState tab={tab} hasFilters={activeFilterCount > 0} onClearFilters={clearAllFilters} />
          ) : (
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
              <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <SortableTh label="Age"          sortKey="age"          sort={sort} onSort={onSortClick} />
                    <SortableTh label="Delivered"    sortKey="delivered"    sort={sort} onSort={onSortClick} />
                    <SortableTh label="Load #"       sortKey="loadNum"      sort={sort} onSort={onSortClick} />
                    <SortableTh label="Title"        sortKey="title"        sort={sort} onSort={onSortClick} />
                    <SortableTh label="Customer"     sortKey="customer"     sort={sort} onSort={onSortClick} />
                    <SortableTh label="Driver(s)"    sortKey="driver"       sort={sort} onSort={onSortClick} />
                    <SortableTh label="Rate"         sortKey="rate"         align="right" sort={sort} onSort={onSortClick} />
                    <SortableTh label="Accessorials" sortKey="accessorials" align="right" sort={sort} onSort={onSortClick} />
                    <Th>Docs</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <SelectFilterTh col="age"       value={filters.age       ?? ''} onChange={setFilter} options={filterOptions.age       ?? []} label="Age" />
                    <SelectFilterTh col="delivered" value={filters.delivered ?? ''} onChange={setFilter} options={filterOptions.delivered ?? []} label="Date" />
                    <SelectFilterTh col="loadNum"   value={filters.loadNum   ?? ''} onChange={setFilter} options={filterOptions.loadNum   ?? []} label="#" />
                    <SelectFilterTh col="title"     value={filters.title     ?? ''} onChange={setFilter} options={filterOptions.title     ?? []} label="Title" />
                    <SelectFilterTh col="customer"  value={filters.customer  ?? ''} onChange={setFilter} options={filterOptions.customer  ?? []} label="Customer" />
                    <SelectFilterTh col="driver"    value={filters.driver    ?? ''} onChange={setFilter} options={filterOptions.driver    ?? []} label="Driver" />
                    {/* Rate + Accessorials skipped — numeric ranges aren't dropdown-friendly. */}
                    <Th align="right" />
                    <Th align="right" />
                    <Th>{activeFilterCount > 0 && (
                      <button onClick={clearAllFilters}
                        className="flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                        style={{ background: 'var(--gc-border-light)', color: 'var(--gc-text-2)' }}
                        title="Clear all filters">
                        <X size={9} /> clear ({activeFilterCount})
                      </button>
                    )}</Th>
                    <Th align="right">{/* spacer */}</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((load, rowIdx) => {
                    const days = ageDays(load.end);
                    const ac   = ageColor(days);
                    const cust = displayBrokerName(load.broker, customers);
                    // Customer profile lookup — need the canonical id, not the raw name
                    const matchedCustomer = customers.find(c =>
                      c.name === load.broker || (c.aliases ?? []).includes(load.broker ?? ''),
                    );
                    // For relays, surface BOTH drivers
                    const relayPartner = load.relayGroupId
                      ? rows.find(r => r.id !== load.id && r.relayGroupId === load.relayGroupId)
                      : null;
                    const drivers: string[] = [];
                    if (load.driverName) drivers.push(load.driverName);
                    if (relayPartner?.driverName && relayPartner.driverName !== load.driverName) drivers.push(relayPartner.driverName);
                    const accessorialsSum = (load.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
                    const accessorialsCount = (load.accessorials ?? []).length;
                    const targetLoadId = load.loadId ?? load.id;
                    const counts = docCounts[targetLoadId] ?? {};
                    const hasRC = !!load.rateConPdf;
                    return (
                      <tr key={load.id}
                        style={{
                          borderBottom: '1px solid var(--gc-border-light)',
                          // Priority loads stand out — soft yellow band so
                          // the dispatcher can scan and find them instantly.
                          background: load.priority ? '#fefce8' : undefined,
                          borderLeft: load.priority ? '3px solid #eab308' : '3px solid transparent',
                        }}
                        className="hover:bg-[var(--gc-hover)]">
                        <Td>
                          <span style={{ background: ac.bg, color: ac.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                            {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
                          </span>
                        </Td>
                        <Td>{fmtDate(load.end)}</Td>
                        {/* Load # — copyable with visual confirmation */}
                        <Td>
                          {load.loadNum
                            ? <CopyableLoadNum value={load.loadNum} />
                            : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                        </Td>
                        {/* Title — opens event modal with full load data */}
                        <Td>
                          <button type="button"
                            onClick={e => { e.stopPropagation(); openEditModal(load.id); }}
                            className="text-left font-bold hover:underline truncate max-w-[320px]"
                            style={{ color: 'var(--gc-blue)' }}
                            title="Open load details">
                            {load.title}
                          </button>
                        </Td>
                        {/* Customer — opens broker profile */}
                        <Td>
                          {matchedCustomer ? (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); setBrokerProfileId(matchedCustomer.id); }}
                              className="hover:underline"
                              style={{ color: 'var(--gc-blue)' }}
                              title="Open customer profile">
                              {cust}
                            </button>
                          ) : (
                            <span style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>{cust || '—'}</span>
                          )}
                        </Td>
                        {/* Driver(s) */}
                        <Td>
                          {drivers.length === 0
                            ? <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>
                            : drivers.length === 1
                              ? <span>{drivers[0]}</span>
                              : (
                                <div>
                                  <div className="text-[13px]">{drivers[0]}</div>
                                  <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>+ {drivers[1]}</div>
                                </div>
                              )}
                        </Td>
                        {/* Total rate */}
                        <Td align="right" className="font-semibold tabular-nums">
                          {load.loadPrice != null ? moneyFmt.format(load.loadPrice) : '—'}
                        </Td>
                        {/* Total accessorials */}
                        <Td align="right" className="tabular-nums">
                          {accessorialsCount === 0
                            ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                            : (
                              <div>
                                <div className="font-semibold">{moneyFmt.format(accessorialsSum)}</div>
                                <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>{accessorialsCount} item{accessorialsCount !== 1 ? 's' : ''}</div>
                              </div>
                            )}
                        </Td>
                        {/* Docs — only show kinds actually present. Empty when nothing uploaded. */}
                        <Td>
                          <div className="flex flex-wrap items-center gap-1">
                            {hasRC                       && <DocBadge label="RC"     count={1} />}
                            {(counts.pod    ?? 0) > 0    && <DocBadge label="POD"    count={counts.pod} />}
                            {(counts.bol    ?? 0) > 0    && <DocBadge label="BOL"    count={counts.bol} />}
                            {(counts.lumper ?? 0) > 0    && <DocBadge label="Lumper" count={counts.lumper} />}
                            {(counts.scale  ?? 0) > 0    && <DocBadge label="Scale"  count={counts.scale} />}
                            {(counts.other  ?? 0) > 0    && <DocBadge label="Other"  count={counts.other} />}
                            {!hasRC && Object.keys(counts).length === 0 && (
                              <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>—</span>
                            )}
                          </div>
                          {load.flaggedReason && (
                            <div className="mt-1">
                              <FlagChip reason={load.flaggedReason} />
                            </div>
                          )}
                        </Td>
                        {/* Actions */}
                        <Td align="right" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Priority toggle — visible on every tab so a
                                load can be flagged/unflagged anywhere. */}
                            <button onClick={() => void handleTogglePriority(load)}
                              className="rounded-full p-1 transition-colors"
                              title={load.priority ? 'Unmark priority' : 'Mark as priority'}
                              style={{
                                background: load.priority ? '#fef9c3' : 'transparent',
                                border:     `1px solid ${load.priority ? '#eab308' : 'var(--gc-border)'}`,
                                color:      load.priority ? '#854d0e' : 'var(--gc-text-3)',
                              }}>
                              <Star size={11} fill={load.priority ? '#eab308' : 'none'} />
                            </button>
                            {tab === 'pending' || tab === 'flagged' ? (
                              <>
                                <button onClick={() => { setReviewStartIndex(rowIdx); setReviewOpen(true); }}
                                  className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                  style={{ background: '#15803d', color: '#fff' }}
                                  title="Open in review queue">
                                  <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
                                </button>
                                <button onClick={() => void handleVerify(load)}
                                  className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                  style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}
                                  title="Release without opening review queue">
                                  <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 3 }} /> Release
                                </button>
                                {tab === 'pending' && (
                                  <button onClick={() => handleFlag(load)}
                                    className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                    style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                                    <Flag size={11} style={{ display: 'inline', marginRight: 3 }} /> Flag
                                  </button>
                                )}
                              </>
                            ) : null}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* Pagination footer — only shown when total exceeds one page */}
              {total > PAGE_SIZE && (
                <PaginationFooter
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onPrev={() => setPage(Math.max(0, page - 1))}
                  onNext={() => setPage(page + 1)}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Customer profile modal */}
      {brokerProfileId && (
        <BrokerProfileModal initialBrokerId={brokerProfileId} onClose={() => setBrokerProfileId(null)} />
      )}

      {/* Focused review queue overlay */}
      {reviewOpen && (
        <ReviewQueue
          loads={visible}
          startIndex={reviewStartIndex}
          onClose={() => { setReviewOpen(false); void refresh(); }}
          onLoadResolved={() => { /* refresh happens on close */ }}
        />
      )}

      {/* Inline flag modal (used from row buttons; review queue has its own) */}
      {flagTarget && (
        <FlagModal
          loadLabel={`${flagTarget.title}${flagTarget.loadNum ? ` · #${flagTarget.loadNum}` : ''}`}
          onCancel={() => setFlagTarget(null)}
          onConfirm={confirmFlag}
        />
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider"
      style={{ color: 'var(--gc-text-3)', textAlign: align }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', className, onClick }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <td className={`px-3 py-2.5 ${className ?? ''}`} style={{ textAlign: align, color: 'var(--gc-text-1)' }} onClick={onClick}>
      {children}
    </td>
  );
}

function DocBadge({ label, count }: { label: string; count?: number }) {
  return (
    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums"
      title={`${count ?? ''} ${label}`.trim()}
      style={{
        background: '#dcfce7',
        color:      '#15803d',
        border:     '1px solid #86efac',
      }}>
      {label}{count && count > 1 ? ` ×${count}` : ''}
    </span>
  );
}

/** Load # button with a 1.5s "Copied" confirmation flip. */
function CopyableLoadNum({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button"
      onClick={async e => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard API blocked — silent */ }
      }}
      className="font-semibold inline-flex items-center gap-1 text-[13px] rounded px-1.5 py-0.5 transition-colors"
      style={{
        color:      copied ? '#15803d' : 'var(--gc-text-1)',
        background: copied ? '#dcfce7' : 'transparent',
      }}
      title={copied ? 'Copied!' : 'Copy load #'}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      #{value}
      {copied
        ? <Check size={11} style={{ color: '#15803d' }} />
        : <Copy  size={11} style={{ color: 'var(--gc-text-3)' }} />}
    </button>
  );
}

function PaginationFooter({
  page, pageSize, total, onPrev, onNext,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end   = Math.min((page + 1) * pageSize, total);
  const atStart = page === 0;
  const atEnd   = end >= total;
  return (
    <div className="flex items-center justify-between px-4 py-3"
      style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <div className="text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
        Showing <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{start.toLocaleString()}–{end.toLocaleString()}</span>
        {' '}of <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{total.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={atStart}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-full transition-colors"
          style={{
            border:     '1px solid var(--gc-border)',
            background: 'var(--gc-surface)',
            color:      atStart ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
            opacity:    atStart ? 0.5 : 1,
            cursor:     atStart ? 'not-allowed' : 'pointer',
          }}>
          <ChevronLeft size={13} /> Prev
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={atEnd}
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-full transition-colors"
          style={{
            border:     '1px solid var(--gc-border)',
            background: 'var(--gc-surface)',
            color:      atEnd ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
            opacity:    atEnd ? 0.5 : 1,
            cursor:     atEnd ? 'not-allowed' : 'pointer',
          }}>
          Next <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

function FlagChip({ reason }: { reason: string }) {
  const label = ({
    missing_pod:        'Missing POD',
    awaiting_rate_con:  'Rate-con pending',
    detention_pending:  'Detention pending',
    lumper_pending:     'Lumper pending',
    rate_mismatch:      'Rate mismatch',
    other:              'Other',
  } as Record<string, string>)[reason] ?? reason;
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
      style={{ background: '#fef3c7', color: '#92400e' }}>
      <Flag size={9} /> {label}
    </span>
  );
}

function EmptyState({ tab, hasFilters, onClearFilters }: { tab: Tab; hasFilters?: boolean; onClearFilters?: () => void }) {
  // Filter-cleared case takes precedence — the "all caught up" message
  // is misleading when the user has just filtered everything out.
  if (hasFilters) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: 'var(--gc-text-3)' }}>
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>No matches</div>
        <div className="text-sm mb-3">Filters hide every load on this page.</div>
        <button onClick={onClearFilters}
          className="text-xs font-semibold px-3 py-1.5 rounded-full"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
          Clear filters
        </button>
      </div>
    );
  }
  const messages: Record<Tab, { icon: React.ReactNode; title: string; sub: string }> = {
    pending:  { icon: <CheckCircle2 size={28} style={{ color: '#15803d' }} />, title: 'All caught up', sub: 'Every overdue load has been verified or flagged.' },
    flagged:  { icon: <Flag         size={28} style={{ color: '#92400e' }} />, title: 'No flagged loads', sub: 'Anything that needs follow-up will show here.' },
    verified: { icon: <Clock        size={28} style={{ color: '#1a73e8' }} />, title: 'Nothing waiting on accounting', sub: 'Verified loads ready to invoice will land here.' },
    invoiced: { icon: <FileText     size={28} style={{ color: 'var(--gc-text-3)' }} />, title: 'No invoiced loads', sub: 'Loads sent to brokers but unpaid will show here.' },
    paid:     { icon: <CheckCircle2 size={28} style={{ color: '#15803d' }} />, title: 'No paid loads in view', sub: 'Closed-out loads will show here.' },
  };
  const m = messages[tab];
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: 'var(--gc-text-3)' }}>
      <div className="mb-3">{m.icon}</div>
      <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>{m.title}</div>
      <div className="text-sm">{m.sub}</div>
    </div>
  );
}

function SortableTh({
  label, sortKey, sort, onSort, align = 'left',
}: {
  label: string;
  sortKey: ColKey;
  sort: SortState;
  onSort: (key: ColKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider select-none cursor-pointer"
      style={{ color: active ? 'var(--gc-text-1)' : 'var(--gc-text-3)', textAlign: align }}
      onClick={() => onSort(sortKey)}
      title="Click to sort">
      <span className="inline-flex items-center gap-1" style={{ flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        {active ? (
          sort.dir === 'asc'
            ? <ArrowUp   size={11} style={{ color: 'var(--gc-blue)' }} />
            : <ArrowDown size={11} style={{ color: 'var(--gc-blue)' }} />
        ) : (
          <span style={{ width: 11, height: 11, opacity: 0.2 }}>
            <ArrowUp size={11} />
          </span>
        )}
      </span>
    </th>
  );
}

function SelectFilterTh({
  col, value, onChange, options, label,
}: {
  col: ColKey;
  value: string;
  onChange: (col: ColKey, val: string) => void;
  options: string[];
  /** Shown as the "All …" placeholder option, e.g. "All Customers". */
  label: string;
}) {
  const active = value !== '';
  return (
    <th className="px-2 pb-2" style={{ textAlign: 'left' }}>
      <select
        value={value}
        onChange={e => onChange(col, e.target.value)}
        className="w-full text-[11px] px-2 py-1 rounded-md outline-none cursor-pointer"
        style={{
          background: 'var(--gc-surface)',
          border:     `1px solid ${active ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
          color:      active ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
          fontWeight: active ? 600 : 400,
        }}
        title={active ? `Filtered: ${value}` : `Filter by ${label}`}>
        <option value="">All {label}</option>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </th>
  );
}
