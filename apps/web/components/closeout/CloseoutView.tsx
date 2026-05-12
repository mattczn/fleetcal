'use client';

/**
 * /closeout — POD verification + release.
 *
 * Workflow split (vs /accounting):
 *   - /closeout    = "is this paperwork correct?"  POD verification.
 *   - /accounting  = "let's bill and get paid."    Billing pipeline.
 *
 * Pending / Flagged are the actionable tabs — operations checks
 * paperwork and either Releases (sets billing_status='verified') or
 * flags for follow-up. Once released, the load is handed off to
 * accounting; the Released / Invoiced / Paid tabs here are
 * informational only (point users at /accounting for actions).
 *
 * Default is Pending, sorted oldest delivery first. Click a row →
 * opens the event modal. Fetched events are merged into the calendar
 * store so the modal can find them even when they're outside the
 * calendar's loaded window.
 */

import { useEffect, useMemo, useRef, useState, forwardRef } from 'react';
import { FileCheck2, Loader2, Flag, CheckCircle2, Clock, Play, Copy, Check, FileText, ChevronLeft, ChevronRight, Star, ArrowUp, ArrowDown, X, MessageSquare, Columns3, Search } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useAuth, useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import Link from 'next/link';
import type { Load, CalendarEvent } from '@/lib/types';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { displayBrokerName } from '@/lib/customerMatch';
import ReviewQueue from './ReviewQueue';
import { FlagModal, type FlagReason } from './FlagModal';
import InternalNotesModal from './InternalNotesModal';
import FollowUpModal from './FollowUpModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';

type Tab = 'pending' | 'flagged';

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
  | 'internalId'
  | 'loadNum'
  | 'title'
  | 'customer'
  | 'driver'
  | 'rate'
  | 'accessorials';

interface SortState { key: ColKey | null; dir: 'asc' | 'desc' }

// Each filterable column carries a list of selected values. An empty
// or absent array means "no filter on this column"; otherwise a row
// passes only if its formatted value matches one of the selections.
type FilterState = Partial<Record<ColKey, string[]>>;

// Toggleable columns. "actions" + "docs" are always rendered (they're
// where the user mutates state). The notes button lives inside actions
// so it follows the same rule.
type ToggleableCol =
  | 'age'
  | 'delivered'
  | 'internalId'
  | 'loadNum'
  | 'title'
  | 'customer'
  | 'driver'
  | 'rate'
  | 'accessorials'
  | 'docs';

const TOGGLEABLE_COLS: { key: ToggleableCol; label: string }[] = [
  { key: 'age',          label: 'Age'          },
  { key: 'delivered',    label: 'Delivered'    },
  { key: 'internalId',   label: 'Load ID / Invoice #' },
  { key: 'loadNum',      label: 'Load #'       },
  { key: 'title',        label: 'Title'        },
  { key: 'customer',     label: 'Customer'     },
  { key: 'driver',       label: 'Driver(s)'    },
  { key: 'rate',         label: 'Rate'         },
  { key: 'accessorials', label: 'Accessorials' },
  { key: 'docs',         label: 'Docs'         },
];

const COLS_STORAGE_KEY = 'closeout-cols-v1';

const TABS: { value: Tab; label: string; subtitle: string; tint: string }[] = [
  { value: 'pending', label: 'Pending', subtitle: 'Awaiting POD',     tint: '#1a73e8' },
  { value: 'flagged', label: 'Flagged', subtitle: 'Needs follow-up',  tint: '#b45309' },
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
    pending: 0, flagged: 0,
  });
  // Live counts shown on both bucket tiles. Pre-fetched on mount and
  // refreshed alongside the main queue fetch — keeps the inactive
  // tile's number accurate without forcing a tab switch.
  const [bucketTotals, setBucketTotals] = useState<Record<Tab, number>>({ pending: 0, flagged: 0 });
  const page = pageByTab[tab];
  const setPage = (next: number) => setPageByTab(p => ({ ...p, [tab]: next }));

  // Search across all loads in the current tab (not just the page on
  // screen). Live input lives in `searchInput`; the debounced value
  // (`searchQuery`) is what feeds the fetch + cache key so we don't
  // pummel the API on every keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  useEffect(() => {
    const trimmed = searchInput.trim();
    // The API ignores <2-char queries; normalize that here too so the
    // cache key + fetch don't churn while the user is mid-typing.
    const effective = trimmed.length >= 2 ? trimmed : '';
    const t = setTimeout(() => setSearchQuery(effective), 250);
    return () => clearTimeout(t);
  }, [searchInput]);
  // New search → reset to page 0 in the active tab; the user expects
  // results to start from the top, not from wherever they were
  // paginated to before searching.
  useEffect(() => { setPage(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [searchQuery]);

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

  // Cache key includes the search query so search results don't trip
  // over plain-queue results in the cache (and vice versa).
  const cacheKey = `${tab}:${page}:${searchQuery}`;

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
      const { loads, docCounts, total } = await railway.listCloseoutQueue(tab, {
        limit:  PAGE_SIZE,
        offset,
        q:      searchQuery || undefined,
      });
      const entry: CacheEntry = { loads, docCounts, total, fetchedAt: Date.now() };
      cacheRef.current.set(`${tab}:${page}:${searchQuery}`, entry);
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
  }, [tab, page, searchQuery, mergeEvents]);

  // Invalidate every cached page for the active tab — call after any
  // action that mutates membership (verify, flag, reopen). Search
  // results for this tab are wiped too since their membership might
  // have changed as well.
  const invalidateTab = (t: Tab) => {
    for (const k of Array.from(cacheRef.current.keys())) {
      if (k.startsWith(`${t}:`)) cacheRef.current.delete(k);
    }
  };

  // Pull live counts for BOTH buckets in parallel. Cheap (limit: 1
  // per call, the totals come from the count metadata not the row
  // payload). Called on mount + after every mutation so the inactive
  // tile's count doesn't get stale.
  async function refreshBucketTotals() {
    try {
      const [p, f] = await Promise.all([
        railway.listCloseoutQueue('pending', { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('flagged', { limit: 1 }).catch(() => null),
      ]);
      setBucketTotals({
        pending: p?.total ?? 0,
        flagged: f?.total ?? 0,
      });
    } catch { /* best-effort */ }
  }

  // Render cached data on tab/page/search change, then refresh in the
  // background.
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    const had = renderFromCache(cacheKey);
    void fetchAndCache(!had);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, authLoaded, isSignedIn]);

  // Pre-fetch counts on first ready render so both bucket tiles
  // display real numbers immediately.
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    void refreshBucketTotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn]);

  const refresh = async () => {
    invalidateTab(tab);
    await Promise.all([fetchAndCache(false), refreshBucketTotals()]);
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

  // For relay loads the kept row is the pickup leg, but its `end` is
  // the handoff time — not the actual delivery date. Build a lookup
  // from rows (which always contains both legs from the API) so we
  // can swap in the delivery leg's end when computing Age + Delivered
  // for relays.
  const deliveryEndByLoadId = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.relayRole === 'delivery' && r.loadId && r.end) {
        m.set(r.loadId, r.end);
      }
    }
    return m;
  }, [rows]);
  const effectiveDeliveryEnd = (load: QueueRow): string => {
    if (load.relayGroupId && load.relayRole === 'pickup' && load.loadId) {
      return deliveryEndByLoadId.get(load.loadId) ?? load.end;
    }
    return load.end;
  };

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
      case 'age':        return ageDays(effectiveDeliveryEnd(row));
      case 'delivered':  return effectiveDeliveryEnd(row);
      case 'internalId': return row.internalLoadId ?? 0;
      case 'loadNum':    return row.loadNum ?? '';
      case 'title':      return row.title ?? '';
      case 'customer':   return displayBrokerName(row.broker, customers) ?? '';
      case 'driver':     return row.driverName ?? '';
      case 'rate':       return row.loadPrice ?? 0;
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
        const d = ageDays(effectiveDeliveryEnd(row));
        return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
      }
      case 'delivered':  return fmtDate(effectiveDeliveryEnd(row)) || '—';
      case 'internalId': return row.internalLoadId != null ? String(row.internalLoadId) : '';
      case 'loadNum':    return row.loadNum ?? '';
      case 'title':      return row.title ?? '';
      case 'customer':   return displayBrokerName(row.broker, customers) ?? '';
      case 'driver':     return row.driverName ?? '';
      // Rate + accessorials don't get filter dropdowns — these branches
      // are unused but kept exhaustive for future-proofing.
      case 'rate':         return row.loadPrice != null ? moneyFmt.format(row.loadPrice) : '';
      case 'accessorials': return moneyFmt.format((row.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0));
    }
  };

  // Per-column option lists for the filter dropdowns. Built from the
  // current page's data so the user only ever picks values that exist.
  // Age, Title, and Load# intentionally skipped — Age is better expressed
  // by the Delivered date filter, and Title/Load# values are essentially
  // unique per load so a dropdown doesn't help.
  const filterableCols: ColKey[] = ['delivered', 'customer', 'driver'];
  const isFilterable = (c: ColKey) => filterableCols.includes(c);
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
    const activeFilters = (Object.entries(filters) as [ColKey, string[] | undefined][])
      .filter(([, vs]) => vs && vs.length > 0) as [ColKey, string[]][];
    if (activeFilters.length > 0) {
      out = out.filter(row => {
        return activeFilters.every(([col, vals]) => vals.includes(formatRowForCol(row, col)));
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
  // Toggle a single value in the column's selection list. Adds when
  // missing, removes when present. Empty array → no filter on that col.
  const toggleFilterValue = (key: ColKey, val: string) => {
    setFilters(f => {
      const current = f[key] ?? [];
      const next = current.includes(val)
        ? current.filter(v => v !== val)
        : [...current, val];
      return { ...f, [key]: next };
    });
  };
  const clearColFilter = (key: ColKey) => setFilters(f => ({ ...f, [key]: [] }));
  const setColFilterAll = (key: ColKey, options: string[]) =>
    setFilters(f => ({ ...f, [key]: [...options] }));
  const clearAllFilters = () => setFilters({});
  const activeFilterCount = Object.values(filters).filter(v => v && v.length > 0).length;

  // tabCount removed — the bucket tiles use the pre-fetched
  // bucketTotals instead, so the inactive tile shows a real number
  // even before the user clicks into it.

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

  // Invoice viewing lives on /accounting now — closeout only handles
  // pre-release work (POD verification + flagging).

  async function handleTogglePriority(load: Load) {
    const targetId = load.loadId ?? load.id;
    const next = !load.priority;
    await railway.updateLoadCloseout(targetId, { action: next ? 'set_priority' : 'clear_priority' });
    await refresh();
  }

  // For relay loads, the closeout queue can return either leg depending
  // on what's matched the date filter. Without this, opening a relay
  // sometimes lands on the delivery leg whose pickup-time asset isn't
  // shown — confusing because the modal looks "empty". Always resolve
  // to the pickup leg before opening; if the pickup leg isn't already
  // in the calendar store, fetch the load and merge it in first so the
  // modal renders with full data.
  async function openLoadInModal(load: QueueRow) {
    // Non-relay → just open the row's event directly.
    if (!load.relayGroupId) {
      openEditModal(load.id);
      return;
    }
    const loadId = load.loadId;
    if (!loadId) {
      openEditModal(load.id);
      return;
    }
    // Pickup leg already in the row set we rendered? Use it.
    const pickupRow = rows.find(r => r.loadId === loadId && r.relayRole === 'pickup');
    if (pickupRow) {
      openEditModal(pickupRow.id);
      return;
    }
    // Pickup leg in the broader calendar store?
    const storeEvents = useCalendarStore.getState().events;
    const pickupFromStore = storeEvents.find(e => e.loadId === loadId && e.relayRole === 'pickup');
    if (pickupFromStore) {
      openEditModal(pickupFromStore.id);
      return;
    }
    // Last resort — fetch all legs of the load, merge, then open pickup.
    try {
      const { loads: legs } = await railway.getLoad(loadId);
      mergeEvents(legs as CalendarEvent[]);
      const pickup = legs.find(l => l.relayRole === 'pickup');
      openEditModal(pickup?.id ?? load.id);
    } catch (err) {
      console.error('[closeout] failed to resolve pickup leg:', err);
      openEditModal(load.id);
    }
  }

  // Internal notes panel
  const [notesTarget, setNotesTarget] = useState<Load | null>(null);
  // Follow-up modal target — opened from a row's Follow-up button on
  // the Flagged bucket.
  const [followUpTarget, setFollowUpTarget] = useState<Load | null>(null);

  // Column show/hide menu — persisted to localStorage so the user's
  // layout sticks across sessions.
  const [visibleCols, setVisibleCols] = useState<Record<ToggleableCol, boolean>>(() => {
    if (typeof window === 'undefined') {
      return Object.fromEntries(TOGGLEABLE_COLS.map(c => [c.key, true])) as Record<ToggleableCol, boolean>;
    }
    try {
      const stored = window.localStorage.getItem(COLS_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, boolean>;
        // Re-build with defaults for any new column added since the
        // user last saved their preferences.
        const out: Record<ToggleableCol, boolean> = {} as Record<ToggleableCol, boolean>;
        for (const c of TOGGLEABLE_COLS) out[c.key] = parsed[c.key] ?? true;
        return out;
      }
    } catch { /* fall through to default */ }
    return Object.fromEntries(TOGGLEABLE_COLS.map(c => [c.key, true])) as Record<ToggleableCol, boolean>;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(visibleCols));
  }, [visibleCols]);
  const toggleCol = (key: ToggleableCol) => setVisibleCols(v => ({ ...v, [key]: !v[key] }));

  // Click-outside dismissal for the columns menu.
  const [colsMenuOpen, setColsMenuOpen] = useState(false);
  const colsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (colsMenuRef.current && !colsMenuRef.current.contains(e.target as Node)) {
        setColsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [colsMenuOpen]);

  // Per-column header menu — combined sort + filter popover anchored to
  // the clicked column header. Replaces the prior always-visible filter
  // row, which felt cramped.
  const [openHeaderCol, setOpenHeaderCol] = useState<ColKey | null>(null);
  const headerRefs = useRef<Partial<Record<ColKey, HTMLTableCellElement | null>>>({});
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openHeaderCol) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (headerMenuRef.current?.contains(target)) return;
      const inAnyHeader = Object.values(headerRefs.current).some(el => el?.contains(target));
      if (inAnyHeader) return; // header click toggles via its own onClick
      setOpenHeaderCol(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openHeaderCol]);

  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Closeout" icon={FileCheck2} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1600px] mx-auto space-y-4">

          {/* Purpose hint — keeps the split between Closeout and
              Accounting visible while users are still building muscle
              memory. */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            POD verification. Check paperwork and release loads for billing.
            Billing happens in <Link href="/accounting" className="font-semibold underline" style={{ color: 'var(--gc-blue)' }}>Accounting</Link>.
          </div>

          {/* Search bar — searches all loads in the active tab, not
              just the page on screen. Hits /v1/closeout/queue?q=…
              after a 250ms debounce. When the query is set, the
              pending tab lifts its end<=now filter so upcoming loads
              are reachable too. */}
          <div>
            <div className="relative">
              <Search size={16}
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: searchQuery ? 'var(--gc-blue)' : 'var(--gc-text-2)', pointerEvents: 'none' }} />
              <input
                type="text"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder={`Search ${tab} loads — broker, load #, ID / invoice #, title, driver, notes…`}
                className="w-full text-[13px] rounded-full outline-none"
                style={{
                  background: 'var(--gc-surface)',
                  border:     `1px solid ${searchQuery ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                  color:      'var(--gc-text-1)',
                  height:     38,
                  paddingLeft:  40,
                  paddingRight: searchInput ? 36 : 14,
                }}
              />
              {searchInput && (
                <button onClick={() => setSearchInput('')}
                  className="rounded-full"
                  title="Clear search"
                  style={{
                    position:  'absolute',
                    right:     8,
                    top:       '50%',
                    transform: 'translateY(-50%)',
                    width:     22,
                    height:    22,
                    display:   'flex',
                    alignItems:     'center',
                    justifyContent: 'center',
                    color:      'var(--gc-text-2)',
                    background: 'var(--gc-hover)',
                  }}>
                  <X size={13} />
                </button>
              )}
            </div>
            {searchInput && !searchQuery && searchInput.trim().length < 2 && (
              <div className="text-[11px] mt-1.5 ml-3" style={{ color: 'var(--gc-text-3)' }}>
                Type at least 2 characters to search.
              </div>
            )}
            {searchQuery && (
              <div className="text-[11px] mt-1.5 ml-3 flex items-center gap-1.5" style={{ color: 'var(--gc-text-2)' }}>
                <Search size={10} style={{ color: 'var(--gc-blue)' }} /> Showing {tab} loads matching <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>&ldquo;{searchQuery}&rdquo;</span>
                {tab === 'pending' && <span style={{ color: 'var(--gc-text-3)' }}>(including upcoming)</span>}
              </div>
            )}
          </div>

          {/* Bucket tiles — same visual rhythm as /accounting. Each
              tile shows live count + subtitle and toggles which queue
              the table below is showing. */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            {TABS.map(b => {
              const active = tab === b.value;
              const count = bucketTotals[b.value];
              const Icon = b.value === 'pending' ? Clock : Flag;
              return (
                <button key={b.value}
                  onClick={() => setTab(b.value)}
                  className="text-left px-4 py-3 rounded-xl transition-all"
                  style={{
                    background: 'var(--gc-surface)',
                    border: active ? `2px solid ${b.tint}` : '1px solid var(--gc-border-light)',
                    boxShadow: active ? '0 4px 12px rgba(26,115,232,0.12)' : 'var(--shadow-1)',
                  }}>
                  <div className="flex items-center gap-2">
                    <Icon size={16} style={{ color: b.tint }} />
                    <span className="text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>{b.label}</span>
                    <span className="ml-auto text-[16px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{count.toLocaleString()}</span>
                  </div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                    {b.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar — review queue, columns, refresh */}
          <div className="flex items-center gap-1.5">
            <div className="flex-1" />
            {(tab === 'pending' || tab === 'flagged') && visible.length > 0 && (
              <button onClick={() => { setReviewStartIndex(0); setReviewOpen(true); }}
                className="flex items-center gap-1.5 text-[13px] font-bold px-4 py-1.5 rounded-lg text-white transition-colors"
                style={{ background: '#15803d' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#166534')}
                onMouseLeave={e => (e.currentTarget.style.background = '#15803d')}>
                <Play size={13} fill="currentColor" /> Review queue ({visible.length})
              </button>
            )}
            {/* Columns visibility menu */}
            <div className="relative" ref={colsMenuRef}>
              <button onClick={() => setColsMenuOpen(o => !o)}
                className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
                <Columns3 size={12} /> Columns
              </button>
              {colsMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 rounded-xl py-1.5"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', minWidth: 180 }}>
                  {TOGGLEABLE_COLS.map(c => (
                    <label key={c.key}
                      className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--gc-hover)]"
                      style={{ color: 'var(--gc-text-1)' }}>
                      <input type="checkbox"
                        checked={visibleCols[c.key]}
                        onChange={() => toggleCol(c.key)}
                        style={{ accentColor: '#1a73e8' }} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => void refresh()}
              className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
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
                    {visibleCols.age          && <MenuTh col="age"          label="Age"          align="left"  sort={sort} selectedCount={(filters.age          ?? []).length} setHeaderRef={el => { headerRefs.current.age = el; }}          onClick={() => setOpenHeaderCol(p => p === 'age'          ? null : 'age')} />}
                    {visibleCols.delivered    && <MenuTh col="delivered"    label="Delivered"    align="left"  sort={sort} selectedCount={(filters.delivered    ?? []).length} setHeaderRef={el => { headerRefs.current.delivered = el; }}    onClick={() => setOpenHeaderCol(p => p === 'delivered'    ? null : 'delivered')} />}
                    {visibleCols.internalId   && <MenuTh col="internalId"   label="ID / Inv #"   align="left"  sort={sort} selectedCount={(filters.internalId   ?? []).length} setHeaderRef={el => { headerRefs.current.internalId = el; }}   onClick={() => setOpenHeaderCol(p => p === 'internalId'   ? null : 'internalId')} />}
                    {visibleCols.loadNum      && <MenuTh col="loadNum"      label="Load #"       align="left"  sort={sort} selectedCount={(filters.loadNum      ?? []).length} setHeaderRef={el => { headerRefs.current.loadNum = el; }}      onClick={() => setOpenHeaderCol(p => p === 'loadNum'      ? null : 'loadNum')} />}
                    {visibleCols.title        && <MenuTh col="title"        label="Title"        align="left"  sort={sort} selectedCount={(filters.title        ?? []).length} setHeaderRef={el => { headerRefs.current.title = el; }}        onClick={() => setOpenHeaderCol(p => p === 'title'        ? null : 'title')} />}
                    {visibleCols.customer     && <MenuTh col="customer"     label="Customer"     align="left"  sort={sort} selectedCount={(filters.customer     ?? []).length} setHeaderRef={el => { headerRefs.current.customer = el; }}     onClick={() => setOpenHeaderCol(p => p === 'customer'     ? null : 'customer')} />}
                    {visibleCols.driver       && <MenuTh col="driver"       label="Driver(s)"    align="left"  sort={sort} selectedCount={(filters.driver       ?? []).length} setHeaderRef={el => { headerRefs.current.driver = el; }}       onClick={() => setOpenHeaderCol(p => p === 'driver'       ? null : 'driver')} />}
                    {visibleCols.rate         && <MenuTh col="rate"         label="Rate"         align="right" sort={sort} selectedCount={(filters.rate         ?? []).length} setHeaderRef={el => { headerRefs.current.rate = el; }}         onClick={() => setOpenHeaderCol(p => p === 'rate'         ? null : 'rate')} />}
                    {visibleCols.accessorials && <MenuTh col="accessorials" label="Accessorials" align="right" sort={sort} selectedCount={(filters.accessorials ?? []).length} setHeaderRef={el => { headerRefs.current.accessorials = el; }} onClick={() => setOpenHeaderCol(p => p === 'accessorials' ? null : 'accessorials')} />}
                    {visibleCols.docs && (
                      <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider"
                        style={{ color: 'var(--gc-text-3)', textAlign: 'left' }}>
                        Docs
                        {activeFilterCount > 0 && (
                          <button onClick={clearAllFilters}
                            className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-lg"
                            style={{ background: 'var(--gc-border-light)', color: 'var(--gc-text-2)' }}
                            title="Clear all filters">
                            <X size={9} /> clear ({activeFilterCount})
                          </button>
                        )}
                      </th>
                    )}
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((load, rowIdx) => {
                    const dvDate = effectiveDeliveryEnd(load);
                    const days   = ageDays(dvDate);
                    const ac     = ageColor(days);
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
                        {visibleCols.age && (
                          <Td>
                            <span style={{ background: ac.bg, color: ac.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                              {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
                            </span>
                          </Td>
                        )}
                        {visibleCols.delivered && <Td>{fmtDate(dvDate)}</Td>}
                        {/* Internal load ID — per-org sequence number,
                            distinct from the broker-assigned load_num.
                            Doubles as the invoice number, so it's
                            copyable just like load #. */}
                        {visibleCols.internalId && (
                          <Td>
                            {load.internalLoadId != null
                              ? <CopyableCell
                                  value={String(load.internalLoadId)}
                                  displayValue={String(load.internalLoadId)}
                                  title="Copy ID / invoice #"
                                />
                              : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                          </Td>
                        )}
                        {/* Load # — copyable with visual confirmation */}
                        {visibleCols.loadNum && (
                          <Td>
                            {load.loadNum
                              ? <CopyableLoadNum value={load.loadNum} />
                              : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                          </Td>
                        )}
                        {/* Title — opens event modal with full load data */}
                        {visibleCols.title && (
                          <Td>
                            <button type="button"
                              onClick={e => { e.stopPropagation(); void openLoadInModal(load); }}
                              className="text-left font-bold hover:underline truncate max-w-[320px]"
                              style={{ color: 'var(--gc-blue)' }}
                              title="Open load details">
                              {load.title}
                            </button>
                          </Td>
                        )}
                        {/* Customer — opens broker profile. Truncate so long
                            names like "TCI Global Logistics" don't wrap. */}
                        {visibleCols.customer && (
                          <Td>
                            {matchedCustomer ? (
                              <button type="button"
                                onClick={e => { e.stopPropagation(); setBrokerProfileId(matchedCustomer.id); }}
                                className="text-left hover:underline truncate block max-w-[160px]"
                                style={{ color: 'var(--gc-blue)' }}
                                title={`Open customer profile — ${cust}`}>
                                {cust}
                              </button>
                            ) : (
                              <span className="truncate block max-w-[160px]"
                                title={cust || undefined}
                                style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                                {cust || '—'}
                              </span>
                            )}
                          </Td>
                        )}
                        {/* Driver(s) */}
                        {visibleCols.driver && (
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
                        )}
                        {/* Total rate */}
                        {visibleCols.rate && (
                          <Td align="right" className="font-semibold tabular-nums">
                            {load.loadPrice != null ? moneyFmt.format(load.loadPrice) : '—'}
                          </Td>
                        )}
                        {/* Total accessorials */}
                        {visibleCols.accessorials && (
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
                        )}
                        {/* Docs — only show kinds actually present. Empty when nothing uploaded. */}
                        {visibleCols.docs && (
                          <Td>
                            <div className="flex flex-wrap items-center gap-1">
                              {/* RC chip: shows count from load_documents
                                  (rate_con kind) but always at least 1
                                  if rate_con_pdf is set on the load. */}
                              {(hasRC || (counts.rate_con ?? 0) > 0) && <DocBadge label="RC"     count={Math.max(counts.rate_con ?? 0, hasRC ? 1 : 0)} />}
                              {(counts.pod          ?? 0) > 0 && <DocBadge label="POD"     count={counts.pod} />}
                              {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol} />}
                              {(counts.lumper       ?? 0) > 0 && <DocBadge label="Lumper"  count={counts.lumper} />}
                              {(counts.scale        ?? 0) > 0 && <DocBadge label="Scale"   count={counts.scale} />}
                              {(counts.receipt      ?? 0) > 0 && <DocBadge label="Receipt" count={counts.receipt} />}
                              {(counts.driver_sheet ?? 0) > 0 && <DocBadge label="Driver"  count={counts.driver_sheet} />}
                              {/* Invoice badge: either a real load_documents
                                  invoice (Phase 4 PDF), or — for now — a
                                  generated invoice row inferred from the
                                  load's billing_status. */}
                              {((counts.invoice ?? 0) > 0 || load.billingStatus === 'invoiced' || load.billingStatus === 'paid') && (
                                <DocBadge label="Invoice" count={Math.max(counts.invoice ?? 0, 1)} />
                              )}
                              {(counts.other        ?? 0) > 0 && <DocBadge label="Other"   count={counts.other} />}
                              {!hasRC && Object.keys(counts).length === 0 && (
                                <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>—</span>
                              )}
                            </div>
                            {/* Multi-reason chips — derived from data. A
                                load can have several impediments at once
                                (manual flag + missing POD + pending
                                accessorials). The single FlagChip we used
                                to show only captured the manual reason. */}
                            {(() => {
                              const reasons = computeFlagReasons(load, counts);
                              if (reasons.length === 0) return null;
                              return (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {reasons.map((r, i) => <FlagChip key={i} reason={r} />)}
                                </div>
                              );
                            })()}
                          </Td>
                        )}
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
                            {/* Internal notes — opens a small thread modal.
                                Filled icon when at least one note exists. */}
                            <NotesButton load={load} onOpen={() => setNotesTarget(load)} />
                            {tab === 'pending' || tab === 'flagged' ? (
                              <>
                                <button onClick={() => { setReviewStartIndex(rowIdx); setReviewOpen(true); }}
                                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                                  style={{ background: '#15803d', color: '#fff' }}
                                  title="Open in review queue">
                                  <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
                                </button>
                                <button onClick={() => void handleVerify(load)}
                                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                                  style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}
                                  title="Release without opening review queue">
                                  <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 3 }} /> Release
                                </button>
                                {tab === 'pending' && (
                                  <button onClick={() => handleFlag(load)}
                                    className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                                    style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                                    <Flag size={11} style={{ display: 'inline', marginRight: 3 }} /> Flag
                                  </button>
                                )}
                                {tab === 'flagged' && (
                                  <button onClick={() => setFollowUpTarget(load)}
                                    className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                                    style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}
                                    title="Log a follow-up + optionally update accessorial status / clear flag">
                                    <MessageSquare size={11} style={{ display: 'inline', marginRight: 3 }} /> Follow up
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

      {/* Combined sort + filter popover for the active column header */}
      {openHeaderCol && (
        <HeaderMenu
          ref={headerMenuRef}
          col={openHeaderCol}
          anchorEl={headerRefs.current[openHeaderCol] ?? null}
          sort={sort}
          filterable={isFilterable(openHeaderCol)}
          selected={filters[openHeaderCol] ?? []}
          options={filterOptions[openHeaderCol] ?? []}
          onSort={(dir) => {
            if (dir === null) setSort({ key: null, dir: 'asc' });
            else setSort({ key: openHeaderCol, dir });
          }}
          onToggleValue={(val) => toggleFilterValue(openHeaderCol, val)}
          onClearFilter={() => clearColFilter(openHeaderCol)}
          onSelectAll={() => setColFilterAll(openHeaderCol, filterOptions[openHeaderCol] ?? [])}
          onClose={() => setOpenHeaderCol(null)}
        />
      )}

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
          onOpenLoadModal={(load) => {
            // EventModal sits at z-[200], review queue at z-180, so the
            // load detail stacks ON TOP of the review queue without
            // dismissing it. Closing the load modal returns the user
            // to their original review-queue position.
            void openLoadInModal(load as QueueRow);
          }}
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

      {/* Internal notes thread */}
      {followUpTarget && (
        <FollowUpModal
          load={followUpTarget}
          docCounts={docCounts[followUpTarget.loadId ?? followUpTarget.id]}
          actorName={user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined}
          onClose={() => setFollowUpTarget(null)}
          onSaved={async () => {
            await refresh();
            // Re-pull the load from the refreshed rows so the modal
            // reflects the new follow-up + any status changes.
            const next = rows.find(r => (r.loadId ?? r.id) === (followUpTarget.loadId ?? followUpTarget.id));
            if (next) setFollowUpTarget(next as Load);
            else setFollowUpTarget(null);
          }}
        />
      )}
      {notesTarget && (
        <InternalNotesModal
          load={notesTarget}
          actorName={user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined}
          onClose={() => setNotesTarget(null)}
          onSaved={async () => { await refresh(); }}
        />
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className="px-3 py-2.5 font-extrabold text-[11px] uppercase tracking-wider"
      style={{ color: 'var(--gc-text-2)', textAlign: align }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', className, onClick }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <td className={`px-3 py-2.5 font-medium ${className ?? ''}`} style={{ textAlign: align, color: 'var(--gc-text-1)' }} onClick={onClick}>
      {children}
    </td>
  );
}

// Doc-presence chip in the table. Each kind uses the same solid +
// white-text palette as the doc-tabs in the review queue, so the
// closeout chrome reads as one coherent surface.
const DOC_BADGE_TINT: Record<string, string> = {
  RC:       '#5b21b6', // Rate Con — Indigo
  POD:      '#188038', // Green
  BOL:      '#1a73e8', // Blue
  Scale:    '#e37400', // Orange
  Lumper:   '#a16207', // Amber
  Receipt:  '#c2185b', // Pink
  Driver:   '#00838f', // Teal — driver_sheet
  Invoice:  '#7b1fa2', // Purple
  Other:    '#5f6368', // Gray
};
function DocBadge({ label, count }: { label: string; count?: number }) {
  const bg = DOC_BADGE_TINT[label] ?? DOC_BADGE_TINT.Other;
  return (
    <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
      title={`${count ?? ''} ${label}`.trim()}
      style={{
        background: bg,
        color:      '#fff',
        boxShadow:  '0 1px 2px rgba(0,0,0,0.08)',
      }}>
      {label}{count && count > 1 ? ` ×${count}` : ''}
    </span>
  );
}

/** Load # button with a 1.5s "Copied" confirmation flip. */
function CopyableLoadNum({ value }: { value: string }) {
  return <CopyableCell value={value} displayValue={`#${value}`} title="Copy load #" />;
}

/** Click-to-copy text cell with a 1.5s "Copied!" green flip. Used for
 *  load # and internal load id (which doubles as the invoice number). */
function CopyableCell({
  value, displayValue, title,
}: {
  value: string;
  /** What's shown inside the button — usually `value` with a "#" prefix. */
  displayValue: string;
  /** Hover title in the default state. */
  title: string;
}) {
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
      className="font-semibold inline-flex items-center gap-1 text-[13px] rounded px-1.5 py-0.5 transition-colors tabular-nums"
      style={{
        color:      copied ? '#15803d' : 'var(--gc-text-1)',
        background: copied ? '#dcfce7' : 'transparent',
      }}
      title={copied ? 'Copied!' : title}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      {displayValue}
      {copied
        ? <Check size={11} style={{ color: '#15803d' }} />
        : <Copy  size={11} style={{ color: 'var(--gc-text-3)' }} />}
    </button>
  );
}

function NotesButton({ load, onOpen }: { load: Load; onOpen: () => void }) {
  const count = (load.internalNotes ?? []).length;
  const has = count > 0;
  return (
    <button onClick={e => { e.stopPropagation(); onOpen(); }}
      className="rounded-full p-1 transition-colors relative"
      title={has ? `${count} internal note${count !== 1 ? 's' : ''}` : 'Add internal note'}
      style={{
        background: has ? '#dbeafe' : 'transparent',
        border:     `1px solid ${has ? '#1a73e8' : 'var(--gc-border)'}`,
        color:      has ? '#1a73e8' : 'var(--gc-text-3)',
      }}>
      <MessageSquare size={11} fill={has ? '#1a73e8' : 'none'} stroke={has ? '#1a73e8' : 'currentColor'} />
      {has && count > 1 && (
        <span className="absolute -top-1 -right-1 text-[8px] font-bold rounded-lg px-1 leading-3 tabular-nums"
          style={{ background: '#1a73e8', color: '#fff', minWidth: 12, textAlign: 'center' }}>
          {count}
        </span>
      )}
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
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
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
          className="flex items-center gap-1 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
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

// ImpedimentReason — one chip on a flagged row. Several can show on
// the same row when multiple things are blocking closeout. Named
// distinctly from the manual-flag `FlagReason` enum (which is the
// dropdown values in FlagModal) so the two don't shadow each other.
export type ImpedimentReason =
  | { kind: 'manual';      label: string }
  | { kind: 'missing_pod' }
  | { kind: 'accessorial'; accessorialId: string; category: string; amount: number };

const MANUAL_FLAG_LABELS: Record<string, string> = {
  missing_pod:        'Missing POD',
  awaiting_rate_con:  'Rate-con pending',
  detention_pending:  'Detention pending',
  lumper_pending:     'Lumper pending',
  rate_mismatch:      'Rate mismatch',
  other:              'Flagged',
};

const ACCESSORIAL_LABELS: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale',
  extra_stop:   'Extra stop',
  other:        'Accessorial',
};

const moneyShort = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Derive the impediment chips for a row from load data + doc counts.
 *  Mirrors the server's loadIsFlagged() — keeps the row chips in sync
 *  with what the server uses to slot rows into the Flagged bucket. */
export function computeFlagReasons(
  load:   { flaggedReason?: string; accessorials?: Array<{ id: string; category: string; amount: number; status?: 'requested' | 'approved' | 'denied' }> },
  counts: Record<string, number>,
): ImpedimentReason[] {
  const out: ImpedimentReason[] = [];
  // Manual flag wins the first slot for visibility.
  if (load.flaggedReason) {
    out.push({ kind: 'manual', label: MANUAL_FLAG_LABELS[load.flaggedReason] ?? load.flaggedReason });
  }
  // Missing POD — count comes from the closeout queue's docCounts.
  if ((counts.pod ?? 0) === 0) {
    out.push({ kind: 'missing_pod' });
  }
  // Pending accessorials — one chip per item still in flux.
  for (const a of load.accessorials ?? []) {
    if (a.status !== 'approved' && a.status !== 'denied') {
      out.push({ kind: 'accessorial', accessorialId: a.id, category: a.category, amount: a.amount });
    }
  }
  return out;
}

function FlagChip({ reason }: { reason: ImpedimentReason }) {
  // Tone per chip type — keeps the row readable when several are
  // stacked. Manual flag in amber (existing convention), missing POD
  // in red (POD blocks billing entirely), pending accessorial in
  // green-ish (it's money, kind of) with the amount inline.
  const tone =
    reason.kind === 'manual'      ? { bg: '#fef3c7', fg: '#92400e' }
    : reason.kind === 'missing_pod' ? { bg: '#fee2e2', fg: '#991b1b' }
                                    : { bg: '#dcfce7', fg: '#166534' };
  const label =
    reason.kind === 'manual'      ? reason.label
    : reason.kind === 'missing_pod' ? 'Missing POD'
                                    : `${ACCESSORIAL_LABELS[reason.category] ?? 'Accessorial'} ${moneyShort(reason.amount)}`;
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] font-semibold"
      style={{ background: tone.bg, color: tone.fg }}>
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
          className="text-xs font-semibold px-3 py-1.5 rounded-lg"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
          Clear filters
        </button>
      </div>
    );
  }
  const messages: Record<Tab, { icon: React.ReactNode; title: string; sub: string }> = {
    pending: { icon: <CheckCircle2 size={28} style={{ color: '#15803d' }} />, title: 'All caught up', sub: 'Every overdue load has been released or flagged.' },
    flagged: { icon: <Flag         size={28} style={{ color: '#92400e' }} />, title: 'No flagged loads', sub: 'Anything that needs follow-up will show here.' },
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

/** Column header that opens a sort + filter popover when clicked. */
function MenuTh({
  col, label, align, sort, selectedCount, setHeaderRef, onClick,
}: {
  col: ColKey;
  label: string;
  align: 'left' | 'right';
  sort: SortState;
  /** How many filter values are currently selected for this column. */
  selectedCount: number;
  setHeaderRef: (el: HTMLTableCellElement | null) => void;
  onClick: () => void;
}) {
  const sortActive   = sort.key === col;
  const filterActive = selectedCount > 0;
  const anyActive    = sortActive || filterActive;
  return (
    <th
      ref={setHeaderRef}
      onClick={onClick}
      className="px-3 py-2.5 font-extrabold text-[11px] uppercase tracking-wider select-none cursor-pointer hover:bg-[var(--gc-hover)] transition-colors"
      style={{
        color:      anyActive ? 'var(--gc-text-1)' : 'var(--gc-text-2)',
        textAlign:  align,
        background: anyActive ? 'rgba(26,115,232,0.06)' : undefined,
      }}
      title="Click for sort + filter">
      <span className="inline-flex items-center gap-1" style={{ flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        {sortActive ? (
          sort.dir === 'asc'
            ? <ArrowUp   size={11} style={{ color: 'var(--gc-blue)' }} />
            : <ArrowDown size={11} style={{ color: 'var(--gc-blue)' }} />
        ) : null}
        {filterActive && (
          <span title={`${selectedCount} selected`}
            className="text-[9px] font-bold tabular-nums px-1 rounded-lg"
            style={{ background: 'var(--gc-blue)', color: '#fff', minWidth: 14, textAlign: 'center', lineHeight: '14px' }}>
            {selectedCount}
          </span>
        )}
      </span>
    </th>
  );
}

/** Combined sort + filter popover. Anchored to the clicked header via
 *  getBoundingClientRect, repositioned on resize/scroll. Rendered with
 *  fixed positioning so it escapes the table's overflow-hidden ancestor.
 *
 *  Filter is multi-select: clicking an option toggles it in/out of the
 *  selection. Empty selection = no filter active. Helpers for "Select
 *  all" / "Clear" are provided in the filter header. */
const HeaderMenu = forwardRef<HTMLDivElement, {
  col: ColKey;
  anchorEl: HTMLElement | null;
  sort: SortState;
  filterable: boolean;
  selected: string[];
  options: string[];
  onSort: (dir: 'asc' | 'desc' | null) => void;
  onToggleValue: (val: string) => void;
  onClearFilter: () => void;
  onSelectAll: () => void;
  onClose: () => void;
}>(function HeaderMenu({
  col, anchorEl, sort, filterable, selected, options, onSort, onToggleValue, onClearFilter, onSelectAll, onClose,
}, ref) {
  const [pos, setPos]   = useState<{ left: number; top: number } | null>(null);
  const [search, setSearch] = useState('');
  // Re-position on mount + on resize/scroll. Closing on scroll would be
  // jarring (the user might scroll the table to see options), so we
  // just reposition.
  useEffect(() => {
    if (!anchorEl) { setPos(null); return; }
    const update = () => {
      const r = anchorEl.getBoundingClientRect();
      setPos({ left: r.left, top: r.bottom });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorEl]);
  if (!pos) return null;

  const filteredOptions = search.trim() === ''
    ? options
    : options.filter(o => o.toLowerCase().includes(search.toLowerCase()));
  const selectedSet = new Set(selected);
  const allSelected = options.length > 0 && options.every(o => selectedSet.has(o));

  return (
    <div
      ref={ref}
      className="rounded-xl py-1.5"
      style={{
        position:   'fixed',
        left:       pos.left,
        top:        pos.top + 4,
        zIndex:     50,
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
        boxShadow:  '0 12px 32px rgba(0,0,0,0.15)',
        minWidth:   240,
        maxWidth:   340,
      }}>
      {/* Sort group */}
      <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: 'var(--gc-text-3)' }}>
        Sort
      </div>
      <MenuRow
        active={sort.key === col && sort.dir === 'asc'}
        icon={<ArrowUp size={12} />}
        label="Ascending"
        onClick={() => { onSort('asc'); }}
      />
      <MenuRow
        active={sort.key === col && sort.dir === 'desc'}
        icon={<ArrowDown size={12} />}
        label="Descending"
        onClick={() => { onSort('desc'); }}
      />
      {sort.key === col && (
        <MenuRow
          icon={<X size={12} />}
          label="Clear sort"
          onClick={() => { onSort(null); }}
          muted
        />
      )}

      {/* Multi-select filter */}
      {filterable && (
        <>
          <div className="my-1" style={{ borderTop: '1px solid var(--gc-border-light)' }} />
          <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wider font-semibold flex items-center justify-between"
            style={{ color: 'var(--gc-text-3)' }}>
            <span>Filter {selected.length > 0 && (
              <span className="ml-1 text-[10px] font-semibold normal-case tracking-normal" style={{ color: 'var(--gc-text-2)' }}>
                ({selected.length})
              </span>
            )}</span>
            <span className="flex items-center gap-2">
              <button onClick={() => { allSelected ? onClearFilter() : onSelectAll(); }}
                className="text-[10px] font-semibold normal-case tracking-normal"
                style={{ color: 'var(--gc-blue)' }}>
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
              {selected.length > 0 && !allSelected && (
                <button onClick={() => { onClearFilter(); }}
                  className="text-[10px] font-semibold normal-case tracking-normal"
                  style={{ color: 'var(--gc-text-2)' }}>
                  Clear
                </button>
              )}
            </span>
          </div>
          {options.length > 8 && (
            <div className="px-2 pb-1.5">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="w-full text-[11px] px-2 py-1 rounded-md outline-none"
                style={{
                  background: 'var(--gc-bg)',
                  border:     '1px solid var(--gc-border-light)',
                  color:      'var(--gc-text-1)',
                }}
              />
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-2 text-[12px] italic" style={{ color: 'var(--gc-text-3)' }}>
                No options
              </div>
            ) : (
              filteredOptions.map(opt => (
                <CheckboxMenuRow
                  key={opt}
                  checked={selectedSet.has(opt)}
                  label={opt}
                  onToggle={() => onToggleValue(opt)}
                />
              ))
            )}
          </div>
          {/* Done button — gives the user an explicit way out of the
              multi-select panel since clicking a checkbox doesn't auto-
              close (you'd lose the ability to pick multiple). */}
          <div className="px-2 pt-1.5 pb-1" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button onClick={onClose}
              className="w-full text-[12px] font-semibold py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
});

function MenuRow({
  icon, label, onClick, active, muted, truncate,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  muted?: boolean;
  truncate?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-[var(--gc-hover)]"
      style={{
        background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
        color:      muted
                      ? 'var(--gc-text-3)'
                      : active ? 'var(--gc-blue)' : 'var(--gc-text-1)',
        fontWeight: active ? 600 : 400,
      }}>
      {icon && <span className="flex-none">{icon}</span>}
      <span className={truncate ? 'truncate flex-1' : 'flex-1'}>{label}</span>
      {active && <Check size={12} className="flex-none" />}
    </button>
  );
}

function CheckboxMenuRow({
  checked, label, onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <label
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
      style={{ color: 'var(--gc-text-1)' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="flex-none"
        style={{ accentColor: '#1a73e8' }}
      />
      <span className="truncate flex-1">{label}</span>
    </label>
  );
}
