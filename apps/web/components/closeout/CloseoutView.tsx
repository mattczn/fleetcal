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

import { useCallback, useEffect, useMemo, useRef, useState, forwardRef } from 'react';
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
import { QueueTable, QueueColumnsButton, usePersistedColumnPrefs, type QueueColumn } from '@/components/queue/QueueTable';

type Tab = 'pending' | 'flagged' | 'all';

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
// Per-column filter value: string[] for multi-select, string for text
// search, or { from?, to? } for the date-range picker (delivered date).
type FilterValue = string | string[] | { from?: string; to?: string };
type FilterState = Partial<Record<ColKey, FilterValue>>;

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

// Default column widths in px. Used as the initial / fallback width
// when the user hasn't resized a column yet. table-layout: fixed makes
// these strict, so the user can resize freely in either direction.
const DEFAULT_COL_WIDTHS: Record<ToggleableCol, number> = {
  age:          80,
  delivered:    100,
  internalId:   100,
  loadNum:      110,
  title:        260,
  customer:     150,
  driver:       130,
  rate:         100,
  accessorials: 120,
  docs:         220,
};
const ACTIONS_COL_WIDTH = 240;

const COLS_STORAGE_KEY = 'closeout-cols-v1';

const TABS: { value: Tab; label: string; subtitle: string; tint: string }[] = [
  { value: 'pending', label: 'Pending', subtitle: 'Awaiting POD',     tint: '#1a73e8' },
  { value: 'flagged', label: 'Flagged', subtitle: 'Needs follow-up',  tint: '#b45309' },
  { value: 'all',     label: 'All',     subtitle: 'Everything',       tint: '#5f6368' },
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
    pending: 0, flagged: 0, all: 0,
  });
  // Live counts shown on both bucket tiles. Pre-fetched on mount and
  // refreshed alongside the main queue fetch — keeps the inactive
  // tile's number accurate without forcing a tab switch.
  const [bucketTotals, setBucketTotals] = useState<Record<Tab, number>>({ pending: 0, flagged: 0, all: 0 });
  // Sum of load values per bucket (mirrors /accounting's bucket tiles).
  // Server returns this in the queue response (deduped by loadId for
  // relays). Refreshed alongside the count totals.
  const [bucketLoadValue, setBucketLoadValue] = useState<Record<Tab, number>>({ pending: 0, flagged: 0, all: 0 });
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
      const [p, f, a] = await Promise.all([
        railway.listCloseoutQueue('pending', { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('flagged', { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('all',     { limit: 1 }).catch(() => null),
      ]);
      setBucketTotals({
        pending: p?.total ?? 0,
        flagged: f?.total ?? 0,
        all:     a?.total ?? 0,
      });
      setBucketLoadValue({
        pending: p?.totalLoadValue ?? 0,
        flagged: f?.totalLoadValue ?? 0,
        all:     a?.totalLoadValue ?? 0,
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
  // Customer filter lives in the toolbar (CustomerFilterDropdown) — sourcing
  // the option list from the full customers state, not just rows on screen.
  // Keeping it out of the column header lets users follow one broker across
  // pages / buckets without re-picking. Driver + delivered remain in-header.
  const filterableCols: ColKey[] = ['delivered', 'driver'];
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
    // Filters can be string[] (multi), string (text), or
    // { from?, to? } (date-range). Apply each per-row.
    const activeEntries = Object.entries(filters).filter(([, v]) => {
      if (v == null) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'string') return v.trim() !== '';
      const r = v as { from?: string; to?: string };
      return !!r.from || !!r.to;
    });
    if (activeEntries.length > 0) {
      out = out.filter(row => {
        for (const [col, val] of activeEntries) {
          const colKey = col as ColKey;
          if (Array.isArray(val)) {
            if (!val.includes(formatRowForCol(row, colKey))) return false;
          } else if (typeof val === 'string') {
            if (!formatRowForCol(row, colKey).toLowerCase().includes(val.toLowerCase())) return false;
          } else {
            // date range
            const range = val as { from?: string; to?: string };
            const iso = String(projectRowForCol(row, colKey) ?? '');
            if (!iso) return false;
            const day = iso.slice(0, 10);
            if (range.from && day < range.from) return false;
            if (range.to && day > range.to) return false;
          }
        }
        return true;
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
  // (toggleFilterValue / clearColFilter / setColFilterAll removed —
  // QueueTable's header filter inputs own per-column filter state now.)
  const clearAllFilters = () => setFilters({});
  const activeFilterCount = Object.values(filters).filter(v => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim() !== '';
    const r = v as { from?: string; to?: string };
    return !!r.from || !!r.to;
  }).length;

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

  // Persisted column prefs — hidden / order / widths / pinned.
  const {
    hidden: hiddenCols, setHidden: setHiddenCols,
    order: colOrder, setOrder: setColOrder,
    widths: colWidths, setWidths: setColWidths,
    pinned: pinnedCols, setPinned: setPinnedCols,
  } = usePersistedColumnPrefs('closeout-cols-v2',
    new Set(Object.entries(visibleCols).filter(([, v]) => !v).map(([k]) => k)),
  );
  const [tablePageSize, setTablePageSize] = useState(PAGE_SIZE);

  // ── QueueTable column config ────────────────────────────────────────
  // Closures capture state setters above so cell renderers can fire
  // their own actions (open modal, flag, follow up, etc.) without
  // prop-drilling through QueueTable.
  const tableColumns = useMemo<QueueColumn<QueueRow>[]>(() => {
    // Pinned-left columns — stay anchored during horizontal scroll.
    const PIN_LEFT: Set<string> = new Set(['internalId', 'loadNum', 'customer', 'rate', 'docs']);
    const PRIORITY = (load: QueueRow) => !!load.priority;

    const sortVal = (key: ColKey, r: QueueRow): string | number | null => {
      switch (key) {
        case 'age':          return ageDays(effectiveDeliveryEnd(r));
        case 'delivered':    return effectiveDeliveryEnd(r);
        case 'internalId':   return r.internalLoadId ?? '';
        case 'loadNum':      return r.loadNum ?? '';
        case 'title':        return r.title ?? '';
        case 'customer':     return displayBrokerName(r.broker, customers);
        case 'driver':       return r.driverName ?? '';
        case 'rate':         return r.loadPrice ?? 0;
        case 'accessorials': return (r.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
      }
    };

    const filterCustomerOpts = Array.from(new Set(
      rows.map(r => displayBrokerName(r.broker, customers)).filter(Boolean),
    )).sort();

    const cols: QueueColumn<QueueRow>[] = [];

    // age
    cols.push({
      key: 'age', label: 'Age', width: DEFAULT_COL_WIDTHS.age,
      sortable: true, pinLeft: PIN_LEFT.has('age'),
      sortValue: r => sortVal('age', r),
      render: r => {
        const days = ageDays(effectiveDeliveryEnd(r));
        const c = ageColor(days);
        return (
          <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
            {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
          </span>
        );
      },
    });

    // delivered
    cols.push({
      key: 'delivered', label: 'Delivered', width: DEFAULT_COL_WIDTHS.delivered,
      sortable: true, pinLeft: PIN_LEFT.has('delivered'),
      filter: { kind: 'date-range' },
      sortValue: r => sortVal('delivered', r),
      filterValue: r => effectiveDeliveryEnd(r),
      render: r => fmtDate(effectiveDeliveryEnd(r)) || '—',
    });

    // internalId
    cols.push({
      key: 'internalId', label: 'ID / Inv #', width: DEFAULT_COL_WIDTHS.internalId,
      sortable: true, pinLeft: PIN_LEFT.has('internalId'),
      filter: { kind: 'text' },
      sortValue: r => sortVal('internalId', r),
      filterValue: r => String(r.internalLoadId ?? ''),
      render: r => r.internalLoadId != null
        ? <CopyableCell value={String(r.internalLoadId)} displayValue={String(r.internalLoadId)} title="Copy ID / invoice #" />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    // loadNum
    cols.push({
      key: 'loadNum', label: 'Load #', width: DEFAULT_COL_WIDTHS.loadNum,
      sortable: true, pinLeft: PIN_LEFT.has('loadNum'),
      filter: { kind: 'text' },
      sortValue: r => sortVal('loadNum', r),
      filterValue: r => r.loadNum ?? '',
      render: r => r.loadNum
        ? <CopyableLoadNum value={r.loadNum} />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    // title
    cols.push({
      key: 'title', label: 'Title', width: DEFAULT_COL_WIDTHS.title,
      sortable: true, pinLeft: PIN_LEFT.has('title'),
      filter: { kind: 'text' },
      sortValue: r => sortVal('title', r),
      filterValue: r => r.title ?? '',
      render: r => (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); void openLoadInModal(r); }}
          className="text-left font-bold hover:underline truncate"
          style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
          title="Open load details">{r.title}</button>
      ),
    });

    // customer
    cols.push({
      key: 'customer', label: 'Customer', width: DEFAULT_COL_WIDTHS.customer,
      sortable: true, pinLeft: PIN_LEFT.has('customer'),
      filter: { kind: 'multi', options: filterCustomerOpts },
      sortValue: r => sortVal('customer', r),
      filterValue: r => displayBrokerName(r.broker, customers),
      render: r => {
        const cust = displayBrokerName(r.broker, customers);
        const matched = customers.find(c =>
          c.name === r.broker || (c.aliases ?? []).includes(r.broker ?? ''),
        );
        return matched ? (
          <button type="button"
            onClick={(e) => { e.stopPropagation(); setBrokerProfileId(matched.id); }}
            className="text-left hover:underline truncate block"
            style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
            title={`Open customer profile — ${cust}`}>{cust}</button>
        ) : (
          <span className="truncate block"
            title={cust || undefined}
            style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)', maxWidth: '100%' }}>
            {cust || '—'}
          </span>
        );
      },
    });

    // driver
    cols.push({
      key: 'driver', label: 'Driver(s)', width: DEFAULT_COL_WIDTHS.driver,
      sortable: true, pinLeft: PIN_LEFT.has('driver'),
      filter: { kind: 'text' },
      sortValue: r => sortVal('driver', r),
      filterValue: r => r.driverName ?? '',
      render: r => {
        const partner = r.relayGroupId
          ? rows.find(x => x.id !== r.id && x.relayGroupId === r.relayGroupId)
          : null;
        const drivers: string[] = [];
        if (r.driverName) drivers.push(r.driverName);
        if (partner?.driverName && partner.driverName !== r.driverName) drivers.push(partner.driverName);
        if (drivers.length === 0) return <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>;
        if (drivers.length === 1) return <span>{drivers[0]}</span>;
        return (
          <div>
            <div className="text-[12.5px]">{drivers[0]}</div>
            <div className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>+ {drivers[1]}</div>
          </div>
        );
      },
    });

    // rate
    cols.push({
      key: 'rate', label: 'Rate', width: DEFAULT_COL_WIDTHS.rate,
      align: 'right', sortable: true, pinLeft: PIN_LEFT.has('rate'),
      sortValue: r => sortVal('rate', r),
      render: r => (
        <span className="font-semibold tabular-nums">
          {r.loadPrice != null ? moneyFmt.format(r.loadPrice) : '—'}
        </span>
      ),
    });

    // accessorials
    cols.push({
      key: 'accessorials', label: 'Accessorials', width: DEFAULT_COL_WIDTHS.accessorials,
      align: 'right', sortable: true, pinLeft: PIN_LEFT.has('accessorials'),
      sortValue: r => sortVal('accessorials', r),
      render: r => {
        const accSum = (r.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
        const accCount = (r.accessorials ?? []).length;
        return accCount === 0
          ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
          : (
            <div>
              <div className="font-semibold tabular-nums">{moneyFmt.format(accSum)}</div>
              <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>{accCount} item{accCount !== 1 ? 's' : ''}</div>
            </div>
          );
      },
    });

    // docs (+ flag chips)
    cols.push({
      key: 'docs', label: 'Docs', width: DEFAULT_COL_WIDTHS.docs,
      pinLeft: PIN_LEFT.has('docs'),
      render: r => {
        const counts = docCounts[r.loadId ?? r.id] ?? {};
        const hasRC = !!r.rateConPdf;
        return (
          <div>
            <div className="flex flex-wrap items-center gap-1">
              {(hasRC || (counts.rate_con ?? 0) > 0) && <DocBadge label="RC"      count={Math.max(counts.rate_con ?? 0, hasRC ? 1 : 0)} />}
              {(counts.pod          ?? 0) > 0 && <DocBadge label="POD"     count={counts.pod} />}
              {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol} />}
              {(counts.lumper       ?? 0) > 0 && <DocBadge label="Lumper"  count={counts.lumper} />}
              {(counts.scale        ?? 0) > 0 && <DocBadge label="Scale"   count={counts.scale} />}
              {(counts.receipt      ?? 0) > 0 && <DocBadge label="Receipt" count={counts.receipt} />}
              {(counts.driver_sheet ?? 0) > 0 && <DocBadge label="Driver"  count={counts.driver_sheet} />}
              {((counts.invoice ?? 0) > 0 || r.billingStatus === 'invoiced' || r.billingStatus === 'paid') && (
                <DocBadge label="Invoice" count={Math.max(counts.invoice ?? 0, 1)} />
              )}
              {(counts.other        ?? 0) > 0 && <DocBadge label="Other"   count={counts.other} />}
              {!hasRC && Object.keys(counts).length === 0 && (
                <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>—</span>
              )}
            </div>
            {(() => {
              const reasons = computeFlagReasons(r, counts);
              const showTonu = r.isTonu;
              if (reasons.length === 0 && !showTonu) return null;
              return (
                <div className="mt-1 flex flex-wrap gap-1">
                  {reasons.map((rs, i) => <FlagChip key={i} reason={rs} />)}
                  {showTonu && (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] font-semibold"
                      style={{ background: '#eff6ff', color: '#1d4ed8' }}
                      title="Truck Order Not Used — POD not required">
                      TONU
                    </span>
                  )}
                </div>
              );
            })()}
          </div>
        );
      },
    });

    // Actions — non-sortable, non-filterable, hardcoded sticky-right
    // at the far end so Star / Notes / Review / Release / Flag stay
    // accessible while the rest of the table scrolls horizontally.
    // No label per spec; not togglable in the Columns dropdown.
    cols.push({
      key: 'actions', label: '', width: 260, align: 'right',
      pinRight: true,
      pinned: true,
      render: r => {
        const counts = docCounts[r.loadId ?? r.id] ?? {};
        const rowFlagged = tab === 'flagged' || (tab === 'all' && computeFlagReasons(r, counts).length > 0);
        const rowIdx = rows.findIndex(x => x.id === r.id);
        // Suppressing TS for the inline handlers - they pull from
        // surrounding closure scope.
        return (
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => void handleTogglePriority(r)}
              className="rounded-full p-1 transition-colors"
              title={r.priority ? 'Unmark priority' : 'Mark as priority'}
              style={{
                background: r.priority ? '#fef9c3' : 'transparent',
                border: `1px solid ${r.priority ? '#eab308' : 'var(--gc-border)'}`,
                color: r.priority ? '#854d0e' : 'var(--gc-text-3)',
              }}>
              <Star size={11} fill={r.priority ? '#eab308' : 'none'} />
            </button>
            <NotesButton load={r} onOpen={() => setNotesTarget(r)} />
            <button onClick={() => { setReviewStartIndex(rowIdx); setReviewOpen(true); }}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
              style={{ background: '#15803d', color: '#fff' }}
              title="Open in review queue">
              <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
            </button>
            <button onClick={() => void handleVerify(r)}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
              style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}
              title="Release without opening review queue">
              <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 3 }} /> Release
            </button>
            {!rowFlagged ? (
              <button onClick={() => handleFlag(r)}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                <Flag size={11} style={{ display: 'inline', marginRight: 3 }} /> Flag
              </button>
            ) : (
              <button onClick={() => setFollowUpTarget(r)}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}
                title="Log a follow-up + optionally update accessorial status / clear flag">
                <MessageSquare size={11} style={{ display: 'inline', marginRight: 3 }} /> Follow up
              </button>
            )}
          </div>
        );
      },
    });

    // Priority highlight applied per row, not per cell. Mark in helper later.
    void PRIORITY;
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, rows, docCounts, tab]);

  const rowKey = useCallback((r: QueueRow) => r.id, []);

  return (
    <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Closeout" icon={FileCheck2} />
      {/* Fixed-height content area — table claims the remaining space
          and scrolls inside its own viewport. Outer padding lives here. */}
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">
        <div className="mx-auto w-full min-h-0 flex-1 flex flex-col gap-4" style={{ maxWidth: 1800 }}>

          {/* Purpose hint — keeps the split between Closeout and
              Accounting visible while users are still building muscle
              memory. */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            POD verification. Check paperwork and release loads for billing.
            Billing happens in <Link href="/accounting" className="font-semibold underline" style={{ color: 'var(--gc-blue)' }}>Accounting</Link>.
          </div>

          {/* Bucket tiles — same visual rhythm as /accounting. Each
              tile shows live count + subtitle and toggles which queue
              the table below is showing. Five-column grid is shared
              with /accounting so cards stay the same width across
              both pages (this view fills 3 of 5; right two slots are
              spacers). */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {TABS.map(b => {
              const active = tab === b.value;
              const count = bucketTotals[b.value];
              const value = bucketLoadValue[b.value];
              const Icon = b.value === 'pending' ? Clock : b.value === 'flagged' ? Flag : FileCheck2;
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
                  <div className="mt-1.5 text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                    {moneyFmt.format(value)}
                  </div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                    {b.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar — search on the left, actions on the right.
              Mirrors /accounting's layout so the two pages feel
              consistent. Search hits /v1/closeout/queue?q=… after a
              250ms debounce; when query is set the pending tab lifts
              its end<=now filter so upcoming loads are reachable. */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: searchQuery ? 'var(--gc-blue)' : 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder={`Search ${tab} loads — broker, load #, ID, title, driver, notes…`}
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{
                  width: 320,
                  background: 'var(--gc-surface)',
                  border: `1px solid ${searchQuery ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                  color: 'var(--gc-text-1)',
                }} />
              {searchInput && (
                <button onClick={() => setSearchInput('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex-1" />
            {visible.length > 0 && (
              <button onClick={() => { setReviewStartIndex(0); setReviewOpen(true); }}
                className="flex items-center gap-1.5 text-[13px] font-bold px-4 py-1.5 rounded-lg text-white transition-colors"
                style={{ background: '#15803d' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#166534')}
                onMouseLeave={e => (e.currentTarget.style.background = '#15803d')}>
                <Play size={13} fill="currentColor" /> Review queue ({visible.length})
              </button>
            )}
            <QueueColumnsButton
              columns={tableColumns}
              hiddenColumns={hiddenCols}
              onHiddenColumnsChange={setHiddenCols}
              columnOrder={colOrder.length > 0 ? colOrder : tableColumns.map(c => c.key)}
              onColumnOrderChange={setColOrder}
              pinnedColumns={pinnedCols}
              onPinnedColumnsChange={setPinnedCols}
            />
            <button onClick={() => void refresh()}
              className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
              Refresh
            </button>
          </div>
          {/* Search status row — kept thin so it doesn't push the
              table down when idle. */}
          {searchInput && !searchQuery && searchInput.trim().length < 2 && (
            <div className="text-[11px] -mt-2 ml-1" style={{ color: 'var(--gc-text-3)' }}>
              Type at least 2 characters to search.
            </div>
          )}
          {searchQuery && (
            <div className="text-[11px] -mt-2 ml-1 flex items-center gap-1.5" style={{ color: 'var(--gc-text-2)' }}>
              <Search size={10} style={{ color: 'var(--gc-blue)' }} /> Showing {tab} loads matching <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>&ldquo;{searchQuery}&rdquo;</span>
              {tab === 'pending' && <span style={{ color: 'var(--gc-text-3)' }}>(including upcoming)</span>}
            </div>
          )}

          {/* Body — fills remaining vertical space, scrolls internally. */}
          {error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 flex">
              <QueueTable<QueueRow>
                rows={visible}
                columns={tableColumns}
                rowKey={rowKey}
                sort={sort as { key: string | null; dir: 'asc' | 'desc' }}
                onSortChange={(next) => setSort(next as { key: ColKey | null; dir: 'asc' | 'desc' })}
                filters={filters as Record<string, FilterValue>}
                onFiltersChange={(next) => setFilters(next as FilterState)}
                page={page}
                pageSize={tablePageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(n) => { setTablePageSize(n); setPage(0); }}
                hiddenColumns={hiddenCols}
                onHiddenColumnsChange={setHiddenCols}
                columnOrder={colOrder}
                onColumnOrderChange={setColOrder}
                columnWidths={colWidths}
                onColumnWidthsChange={setColWidths}
                pinnedColumns={pinnedCols}
                onPinnedColumnsChange={setPinnedCols}
                rowClassName={(r) => r.priority ? 'bg-[#fefce8]' : ''}
                isLoading={loading}
                emptyMessage={searchQuery ? `No ${tab} loads match "${searchQuery}".` : `No ${tab} loads.`}
              />
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
    <th className="px-2.5 py-2 font-extrabold text-[10.5px] uppercase tracking-wider whitespace-nowrap"
      style={{ color: 'var(--gc-text-2)', textAlign: align }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', className, onClick }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <td className={`px-2.5 py-2 font-medium ${className ?? ''}`}
      style={{
        textAlign: align,
        color: 'var(--gc-text-1)',
        // With table-layout: fixed, cells overflow visibly when the
        // column is narrower than the content. Clip cleanly so a
        // resized-narrow column shows a truncation rather than
        // bleeding into the next cell.
        overflow: 'hidden',
      }}
      onClick={onClick}>
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
  load:   { flaggedReason?: string; isTonu?: boolean; accessorials?: Array<{ id: string; category: string; amount: number; status?: 'requested' | 'approved' | 'denied' }> },
  counts: Record<string, number>,
): ImpedimentReason[] {
  const out: ImpedimentReason[] = [];
  // Manual flag wins the first slot for visibility.
  if (load.flaggedReason) {
    out.push({ kind: 'manual', label: MANUAL_FLAG_LABELS[load.flaggedReason] ?? load.flaggedReason });
  }
  // Missing POD — count comes from the closeout queue's docCounts.
  // TONU loads don't need POD, so we skip this check entirely. The
  // server applies the 24h grace-period before flagging; the row
  // wouldn't be in the Flagged bucket if it weren't already past
  // that threshold, so the chip just mirrors the server's decision.
  if (!load.isTonu && (counts.pod ?? 0) === 0) {
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
    all:     { icon: <FileCheck2   size={28} style={{ color: '#5f6368' }} />, title: 'Nothing to close out', sub: 'No loads are awaiting release or follow-up.' },
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

/** Column header. Inner button is the sort/filter trigger so it doesn't
 *  fight with the resize handle on the right edge. */

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
