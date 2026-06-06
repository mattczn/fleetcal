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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCheck2, Loader2, Flag, CheckCircle2, Clock, Play, Check, Star, X, MessageSquare, Search } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useAuth, useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import Link from 'next/link';
import type { Load, CalendarEvent } from '@/lib/types';
import AppShell from '@/components/nav/AppShell';
import { displayBrokerName } from '@/lib/customerMatch';
import ReviewQueue from './ReviewQueue';
import { FlagModal, type FlagReason } from './FlagModal';
import InternalNotesModal from './InternalNotesModal';
import FollowUpModal from './FollowUpModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import { AccessorialsCell, FastTooltip } from '@/components/queue/QueueTablePrimitives';

type Tab = 'pending' | 'flagged' | 'all' | 'released';

// Maps the closeout UI's bucket name to the API tab. `released` (UI) →
// `released_all` (API) — the API name is more specific to avoid
// colliding with the accounting page's narrower `released` bucket
// which means just billing_status='verified'.
const API_TAB: Record<Tab, 'pending' | 'flagged' | 'all' | 'released_all'> = {
  pending:  'pending',
  flagged:  'flagged',
  all:      'all',
  released: 'released_all',
};

// Server dedups by load_id (one event per load returned, pickup leg
// preferred). The client-side dedup memo below is now a defensive
// no-op — kept so a stale-server response (mid-deploy) doesn't
// double-render a load.
//
// The page fetches the whole bucket in one go (BUCKET_LIMIT) and lets
// OpsTable paginate at PAGE_SIZE locally. That way the Customer /
// Driver / Delivered filter chips operate across every load, not just
// the 50 on screen. BUCKET_LIMIT matches the API's in-memory
// candidate caps (CANDIDATE_CAP=2000 for pending/flagged/all,
// NARROW_CAP=5000 for released_all) so a single request covers the
// full bucket.
const PAGE_SIZE     = 50;
const BUCKET_LIMIT  = 5000;

interface CacheEntry {
  loads: CalendarEvent[];
  docCounts: Record<string, Record<string, number>>;
  total: number;
  fetchedAt: number;
}

// (Per-column sort + filter state lives inside OpsTable now — see the
// columns + filters arrays passed to <OpsTable> below.)

// Default column widths in px — passed to OpsTable so the dispatcher
// gets a sensible starting layout. OpsTable persists user hide/show
// choices per persistKey; widths aren't user-resizable yet (deferred
// from v1 of the port).
const DEFAULT_COL_WIDTHS = {
  age:          80,
  pickedUp:     100,
  delivered:    100,
  internalId:   110,
  loadNum:      120,
  title:        280,
  customer:     170,
  driver:       140,
  truck:        80,
  stops:        65,
  miles:        70,
  rpm:          75,
  rate:         110,
  accessorials: 130,
  total:        120,
  billingStatus: 110,
  docs:         260,
  flags:        80,
  actions:      170,
};

const TABS: { value: Tab; label: string; subtitle: string; tint: string }[] = [
  { value: 'pending',  label: 'Pending',  subtitle: 'Awaiting POD',           tint: '#1a73e8' },
  { value: 'flagged',  label: 'Flagged',  subtitle: 'Needs follow-up',        tint: '#b45309' },
  { value: 'all',      label: 'All',      subtitle: 'All pending and flagged', tint: '#5f6368' },
  { value: 'released', label: 'Released', subtitle: 'Done & beyond',          tint: '#15803d' },
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
  // Live counts shown on bucket tiles. Pre-fetched on mount and
  // refreshed alongside the main queue fetch — keeps the inactive
  // tile's number accurate without forcing a tab switch.
  const [bucketTotals, setBucketTotals] = useState<Record<Tab, number>>({ pending: 0, flagged: 0, all: 0, released: 0 });
  // Sum of load values per bucket (mirrors /accounting's bucket tiles).
  // Server returns this in the queue response (deduped by loadId for
  // relays). Refreshed alongside the count totals.
  // NOTE: released bucket intentionally leaves load $ at 0 — the
  // released view is a history surface for dispatchers WITHOUT
  // accounting access, so we don't pre-aggregate billing $ on it.
  const [bucketLoadValue, setBucketLoadValue] = useState<Record<Tab, number>>({ pending: 0, flagged: 0, all: 0, released: 0 });

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

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [docCounts, setDocCounts] = useState<Record<string, Record<string, number>>>({});
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewStartIndex, setReviewStartIndex] = useState(0);
  const [flagTarget, setFlagTarget] = useState<Load | null>(null);
  // Selection state mirrored from OpsTable via onSelectionChange.
  // We keep it locally so the bulk-flag modal (which is a separate
  // sibling component) knows what to apply against. Reset on tab /
  // search change so a Release queued on Pending can't accidentally
  // fire on a Flagged row the user switched to.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Bulk-flag modal target — when truthy, applies the chosen reason
  // to every selected row.
  const [bulkFlagOpen, setBulkFlagOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<null | 'release' | 'flag'>(null);
  // Versioned key forces OpsTable to clear its internal selection set
  // on tab/search change (remounting flushes its useState).
  const [selectionResetKey, setSelectionResetKey] = useState(0);
  useEffect(() => {
    setSelectedIds([]);
    setSelectionResetKey(k => k + 1);
  }, [tab, searchQuery]);
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  // In-memory cache keyed by `${tab}:${searchQuery}`. Tab switches
  // show cached data instantly while a background refetch updates it.
  // Cleared per-tab when an action mutates that tab's contents
  // (verify / flag / etc). Pagination is OpsTable-local now, so the
  // cache key no longer needs a page index.
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  // Cache key includes the search query so search results don't trip
  // over plain-queue results in the cache (and vice versa).
  const cacheKey = `${tab}:${searchQuery}`;

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
      // Pull the whole bucket so OpsTable's filter chips (Customer /
      // Driver / Delivered) operate across every load, not just the
      // 50 currently visible. BUCKET_LIMIT matches the API's
      // in-memory candidate caps so a single request covers the
      // bucket without a second page fetch.
      const { loads, docCounts, total } = await railway.listCloseoutQueue(API_TAB[tab], {
        limit: BUCKET_LIMIT,
        q:     searchQuery || undefined,
      });
      const entry: CacheEntry = { loads, docCounts, total, fetchedAt: Date.now() };
      cacheRef.current.set(`${tab}:${searchQuery}`, entry);
      setRows(loads as QueueRow[]);
      setDocCounts(docCounts ?? {});
      setTotal(total ?? loads.length);
      mergeEvents(loads as QueueRow[]);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [tab, searchQuery, mergeEvents]);

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
      const [p, f, a, r] = await Promise.all([
        railway.listCloseoutQueue('pending',      { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('flagged',      { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('all',          { limit: 1 }).catch(() => null),
        railway.listCloseoutQueue('released_all', { limit: 1 }).catch(() => null),
      ]);
      setBucketTotals({
        pending:  p?.total ?? 0,
        flagged:  f?.total ?? 0,
        all:      a?.total ?? 0,
        released: r?.total ?? 0,
      });
      setBucketLoadValue({
        pending:  p?.totalLoadValue ?? 0,
        flagged:  f?.totalLoadValue ?? 0,
        all:      a?.totalLoadValue ?? 0,
        // Intentionally 0 — released bucket doesn't surface aggregate $.
        released: 0,
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

  // Sort + per-column filter state now lives inside OpsTable (it owns
  // the sort header clicks + filter chips). The `visible` array here
  // is just the deduped server page, and OpsTable applies the user's
  // chosen sort/filter on top.
  //
  // Two row-shape adjustments we still want to do BEFORE handing the
  // data to OpsTable, because they affect identity rather than
  // display:
  //   1. Priority row pinning (matched rows float to top) — handled
  //      via OpsTable's `priorityKey` prop further down.
  //   2. Relay dedup — already done above in `dedup`.
  // So `visible` is just an alias for `dedup` now; we keep it for
  // backwards compatibility with the ReviewQueue overlay (which
  // walks the rendered ordered list).
  const visible = dedup;

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

  // ── Bulk actions ───────────────────────────────────────────────────
  // The selection set holds event ids (matches rowKey), but the
  // closeout endpoint keys off the parent load id — resolve through
  // the rows list before sending. Dedup so a relay's pickup +
  // delivery legs don't double-fire the action against the same
  // load row in the DB.
  function selectedTargetLoadIds(ids: string[] = selectedIds): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const row = rows.find(r => r.id === id);
      if (!row) continue;
      const target = row.loadId ?? row.id;
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
    return out;
  }

  async function handleBulkRelease(ids: string[] = selectedIds) {
    const targets = selectedTargetLoadIds(ids);
    if (targets.length === 0) return;
    const ok = window.confirm(`Release ${targets.length} load${targets.length === 1 ? '' : 's'} for billing?`);
    if (!ok) return;
    setBulkBusy('release');
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    try {
      // Serial — keeps the API gentle and lets one failure surface
      // before the rest fire (vs Promise.all hiding partial errors).
      for (const id of targets) {
        await railway.updateLoadCloseout(id, { action: 'verify', actorName });
      }
      setSelectedIds([]);
      setSelectionResetKey(k => k + 1);
      await refresh();
    } finally {
      setBulkBusy(null);
    }
  }

  async function confirmBulkFlag(reason: FlagReason, note: string) {
    const targets = selectedTargetLoadIds();
    if (targets.length === 0) { setBulkFlagOpen(false); return; }
    setBulkBusy('flag');
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    try {
      for (const id of targets) {
        await railway.updateLoadCloseout(id, { action: 'flag', flagReason: reason, flagNote: note, actorName });
      }
      setSelectedIds([]);
      setSelectionResetKey(k => k + 1);
      setBulkFlagOpen(false);
      await refresh();
    } finally {
      setBulkBusy(null);
    }
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

  // Column visibility persistence is OpsTable's responsibility now
  // (via the persistKey prop further down). Sort persistence too.

  // ── OpsTable column config ──────────────────────────────────────────
  // Cells capture state setters via closures so each row's buttons can
  // fire actions (open modal, flag, follow up, etc.) without prop-
  // drilling. The columns array is rebuilt when `tab` changes so the
  // Released bucket can swap the Total column for Billing — those two
  // are mutually exclusive per-tab and we keep them out of each
  // other's column picker by simply not including the wrong one.
  const tableColumns = useMemo<OpsColumn<QueueRow>[]>(() => {
    const cols: OpsColumn<QueueRow>[] = [];

    // Star + Notes pinned LEFT — utility column. alwaysVisible so it
    // can't be hidden in the picker (dispatchers always need the
    // priority/notes affordances).
    cols.push({
      key: 'flags', header: '', width: DEFAULT_COL_WIDTHS.flags,
      pinned: 'left', alwaysVisible: true, pickerLabel: 'Star / notes',
      render: r => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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
        </div>
      ),
    });

    cols.push({
      key: 'age', header: 'Age', width: DEFAULT_COL_WIDTHS.age,
      sortable: true,
      sortValue: r => ageDays(effectiveDeliveryEnd(r)),
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

    cols.push({
      key: 'pickedUp', header: 'Picked up', width: DEFAULT_COL_WIDTHS.pickedUp,
      sortable: true,
      // `start` is the leg's pickup time — for relays this is the
      // pickup leg's start; the delivery leg is dedup'd out earlier.
      sortValue: r => r.start ?? '',
      render: r => fmtDate(r.start) || '—',
    });

    cols.push({
      key: 'delivered', header: 'Delivered', width: DEFAULT_COL_WIDTHS.delivered,
      sortable: true,
      sortValue: r => effectiveDeliveryEnd(r),
      render: r => fmtDate(effectiveDeliveryEnd(r)) || '—',
    });

    cols.push({
      key: 'internalId', header: 'ID / Inv #', width: DEFAULT_COL_WIDTHS.internalId,
      sortable: true,
      sortValue: r => r.internalLoadId ?? 0,
      render: r => r.internalLoadId != null
        ? <CopyableCell value={String(r.internalLoadId)} displayValue={String(r.internalLoadId)} title="Copy ID / invoice #" />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    cols.push({
      key: 'loadNum', header: 'Load #', width: DEFAULT_COL_WIDTHS.loadNum,
      sortable: true,
      sortValue: r => r.loadNum ?? '',
      render: r => r.loadNum
        ? <CopyableLoadNum value={r.loadNum} />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    cols.push({
      key: 'title', header: 'Title', width: DEFAULT_COL_WIDTHS.title,
      sortable: true,
      sortValue: r => r.title ?? '',
      render: r => (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); void openLoadInModal(r); }}
          className="text-left font-bold hover:underline truncate"
          style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
          title="Open load details">{r.title}</button>
      ),
    });

    cols.push({
      key: 'customer', header: 'Customer', width: DEFAULT_COL_WIDTHS.customer,
      sortable: true,
      sortValue: r => displayBrokerName(r.broker, customers) ?? '',
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

    cols.push({
      key: 'driver', header: 'Driver(s)', width: DEFAULT_COL_WIDTHS.driver,
      sortable: true,
      sortValue: r => r.driverName ?? '',
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

    cols.push({
      key: 'truck', header: 'Truck', width: DEFAULT_COL_WIDTHS.truck,
      sortable: true,
      sortValue: r => r.assetName ?? '',
      render: r => r.assetName
        ? <span className="font-semibold tabular-nums">{r.assetName}</span>
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    cols.push({
      key: 'stops', header: 'Stops', width: DEFAULT_COL_WIDTHS.stops,
      align: 'right', sortable: true,
      sortValue: r => (r.stops ?? []).length,
      render: r => {
        const n = (r.stops ?? []).length;
        return n === 0
          ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
          : <span className="tabular-nums">{n}</span>;
      },
    });

    cols.push({
      key: 'miles', header: 'Miles', width: DEFAULT_COL_WIDTHS.miles,
      align: 'right', sortable: true,
      sortValue: r => r.loadedMiles ?? 0,
      render: r => r.loadedMiles != null && r.loadedMiles > 0
        ? <span className="tabular-nums">{Math.round(r.loadedMiles).toLocaleString()}</span>
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    cols.push({
      key: 'rpm', header: 'RPM', width: DEFAULT_COL_WIDTHS.rpm,
      align: 'right', sortable: true,
      // Revenue per mile — linehaul ÷ loaded miles. Tonu / 0-mile loads
      // and missing-mile rows sort to the bottom (0). Coloured against
      // common book rates: <$1.75 red, $1.75–$2.25 amber, >$2.25 green.
      sortValue: r => {
        const m = r.loadedMiles ?? 0;
        return m > 0 && r.loadPrice != null ? r.loadPrice / m : 0;
      },
      render: r => {
        const m = r.loadedMiles ?? 0;
        if (m <= 0 || r.loadPrice == null) {
          return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        }
        const rpm = r.loadPrice / m;
        const fg =
          rpm >= 2.25 ? '#15803d' :
          rpm >= 1.75 ? '#92400e' :
                        '#991b1b';
        return (
          <span className="tabular-nums font-semibold" style={{ color: fg }}>
            ${rpm.toFixed(2)}
          </span>
        );
      },
    });

    cols.push({
      key: 'rate', header: 'Linehaul', width: DEFAULT_COL_WIDTHS.rate,
      align: 'right', sortable: true,
      sortValue: r => r.loadPrice ?? 0,
      render: r => (
        <span className="tabular-nums">
          {r.loadPrice != null ? moneyFmt.format(r.loadPrice) : '—'}
        </span>
      ),
    });

    cols.push({
      key: 'accessorials', header: 'Accessorials', width: DEFAULT_COL_WIDTHS.accessorials,
      align: 'right', sortable: true,
      sortValue: r => (r.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0),
      render: r => <AccessorialsCell items={r.accessorials} />,
    });

    // Total / Billing are mutually exclusive per tab — Released loads
    // hide Total to keep billing-revenue numbers off the page for
    // non-accounting roles; non-Released loads have nothing meaningful
    // to show in Billing yet.
    if (tab === 'released') {
      cols.push({
        key: 'billingStatus', header: 'Billing', width: DEFAULT_COL_WIDTHS.billingStatus,
        align: 'left', sortable: true,
        sortValue: r => r.billingStatus ?? '',
        render: r => {
          const bs = r.billingStatus;
          const tint =
            bs === 'verified' ? { bg: '#dcfce7', fg: '#166534', label: 'Released'  } :
            bs === 'invoiced' ? { bg: '#dbeafe', fg: '#1d4ed8', label: 'Invoiced'  } :
            bs === 'paid'     ? { bg: '#dcfce7', fg: '#15803d', label: 'Paid'      } :
                                null;
          if (!tint) return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
          return (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-wider"
              style={{ background: tint.bg, color: tint.fg }}>
              {tint.label}
            </span>
          );
        },
      });
    } else {
      cols.push({
        key: 'total', header: 'Total', width: DEFAULT_COL_WIDTHS.total,
        align: 'right', sortable: true,
        // Prefer the server-computed total_billable (trigger-maintained
        // for every load row); fall back to inline math for any legacy
        // row that somehow lacks it. The fallback matches the same
        // math the trigger uses, so the sort key stays consistent.
        sortValue: r => r.totalBillable
                       ?? (r.loadPrice ?? 0) + (r.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0),
        render: r => {
          const accSum = (r.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
          const tot = r.totalBillable ?? (r.loadPrice ?? 0) + accSum;
          if (r.loadPrice == null && accSum === 0) {
            return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
          }
          return (
            <span className="font-extrabold tabular-nums">{moneyFmt.format(tot)}</span>
          );
        },
      });
    }

    cols.push({
      key: 'docs', header: 'Docs', width: DEFAULT_COL_WIDTHS.docs,
      render: r => {
        const counts = docCounts[r.loadId ?? r.id] ?? {};
        const rcCount = Math.max(counts.rate_con ?? 0, r.rateConPdf ? 1 : 0);
        const podCount = counts.pod ?? 0;
        return (
          <div>
            <div className="flex flex-wrap items-center gap-1">
              <RequiredDocBadge
                label="RC"
                present={rcCount > 0}
                count={rcCount}
                presentTint={DOC_BADGE_TINT.RC}
                missingTitle="No rate confirmation uploaded"
              />
              {!r.isTonu && (
                <RequiredDocBadge
                  label="POD"
                  present={podCount > 0}
                  count={podCount}
                  presentTint={DOC_BADGE_TINT.POD}
                  missingTitle="No POD uploaded"
                />
              )}
              {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol} />}
              {(counts.lumper       ?? 0) > 0 && <DocBadge label="Lumper"  count={counts.lumper} />}
              {(counts.scale        ?? 0) > 0 && <DocBadge label="Scale"   count={counts.scale} />}
              {(counts.receipt      ?? 0) > 0 && <DocBadge label="Receipt" count={counts.receipt} />}
              {(counts.driver_sheet ?? 0) > 0 && <DocBadge label="Driver"  count={counts.driver_sheet} />}
              {((counts.invoice ?? 0) > 0 || r.billingStatus === 'invoiced' || r.billingStatus === 'paid') && (
                <DocBadge label="Invoice" count={Math.max(counts.invoice ?? 0, 1)} />
              )}
              {(counts.other        ?? 0) > 0 && <DocBadge label="Other"   count={counts.other} />}
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

    // Primary actions pinned RIGHT — Review / Release / Flag stay at
    // the right edge during horizontal scroll. alwaysVisible since
    // these are the page's whole point.
    cols.push({
      key: 'actions', header: '', width: DEFAULT_COL_WIDTHS.actions,
      align: 'right', pinned: 'right', alwaysVisible: true, pickerLabel: 'Actions',
      render: r => {
        const counts = docCounts[r.loadId ?? r.id] ?? {};
        const rowFlagged = tab === 'flagged' || (tab === 'all' && computeFlagReasons(r, counts).length > 0);
        // Index against `visible` (the deduped list ReviewQueue
        // iterates), NOT `rows` (the raw server page). They diverge
        // once dedup drops delivery legs.
        const rowIdx = visible.findIndex(x => x.id === r.id);
        return (
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setReviewStartIndex(Math.max(0, rowIdx)); setReviewOpen(true); }}
              className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
              style={{ background: '#15803d', color: '#fff' }}
              title="Open in review queue">
              <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
            </button>
            <button onClick={() => void handleVerify(r)}
              className="rounded-lg transition-colors inline-flex items-center justify-center"
              style={{
                background: '#dcfce7', color: '#15803d',
                border: '1px solid #86efac',
                width: 26, height: 24,
              }}
              title="Release without opening review queue">
              <CheckCircle2 size={12} />
            </button>
            {!rowFlagged ? (
              <button onClick={() => handleFlag(r)}
                className="rounded-lg transition-colors inline-flex items-center justify-center"
                style={{
                  background: '#fef3c7', color: '#92400e',
                  border: '1px solid #fde68a',
                  width: 26, height: 24,
                }}
                title="Flag — needs follow-up">
                <Flag size={12} />
              </button>
            ) : (
              <button onClick={() => setFollowUpTarget(r)}
                className="rounded-lg transition-colors inline-flex items-center justify-center"
                style={{
                  background: '#fff7ed', color: '#9a3412',
                  border: '1px solid #fed7aa',
                  width: 26, height: 24,
                }}
                title="Log a follow-up + optionally update accessorial status / clear flag">
                <MessageSquare size={12} />
              </button>
            )}
          </div>
        );
      },
    });

    return cols;
    // Cell renderers capture handler closures via this scope —
    // exhaustive deps would be noisy because every state setter is
    // captured. The actual values that influence DISPLAY are listed
    // explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, rows, docCounts, tab]);

  // ── OpsTable filters — Customer + Driver multi-select chips + a
  // Delivered date-range chip. Options come from the current page's
  // rows so the user only ever picks values that actually exist.
  const tableFilters = useMemo<OpsFilter<QueueRow>[]>(() => {
    const customerOpts = Array.from(new Set(
      dedup.map(r => displayBrokerName(r.broker, customers)).filter(Boolean) as string[],
    )).sort().map(v => ({ value: v, label: v }));
    const driverOpts = Array.from(new Set(
      dedup.map(r => r.driverName ?? '').filter(Boolean),
    )).sort().map(v => ({ value: v, label: v }));
    const truckOpts = Array.from(new Set(
      dedup.map(r => r.assetName ?? '').filter(Boolean),
    )).sort().map(v => ({ value: v, label: v }));
    return [
      { kind: 'select', key: 'customer', label: 'Customer',
        options: customerOpts,
        predicate: (r, v) => displayBrokerName(r.broker, customers) === v },
      { kind: 'select', key: 'driver',   label: 'Driver',
        options: driverOpts,
        predicate: (r, v) => (r.driverName ?? '') === v },
      { kind: 'select', key: 'truck',    label: 'Truck',
        options: truckOpts,
        predicate: (r, v) => (r.assetName ?? '') === v },
      { kind: 'date-range', key: 'pickedUp', label: 'Picked up',
        getDate: r => r.start ?? '' },
      { kind: 'date-range', key: 'delivered', label: 'Delivered',
        getDate: r => effectiveDeliveryEnd(r) },
    ];
    // effectiveDeliveryEnd is a closure over deliveryEndByLoadId
    // (already in deps) — the lint rule can't see through that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dedup, customers, deliveryEndByLoadId]);

  const rowKey = useCallback((r: QueueRow) => r.id, []);

  return (
    <AppShell title="Paperwork" icon={FileCheck2}>
      {/* Fixed-height content area — table claims the remaining space
          and scrolls inside its own viewport. Outer padding lives here. */}
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">
        <div className="w-full min-h-0 flex-1 flex flex-col gap-4">

          {/* Purpose hint — keeps the split between Paperwork and
              Billing visible while users are still building muscle
              memory. */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            POD verification. Check paperwork and release loads for billing.
            Billing happens in <Link href="/accounting" className="font-semibold underline" style={{ color: 'var(--gc-blue)' }}>Billing</Link>.
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
              const Icon =
                b.value === 'pending'  ? Clock :
                b.value === 'flagged'  ? Flag  :
                b.value === 'released' ? CheckCircle2 :
                                         FileCheck2;
              // The Released bucket is a history surface for dispatchers
              // who don't have accounting.access — billing $ aggregates
              // would leak revenue data outside the accounting role.
              // Keep the row spacing consistent by always reserving the
              // line; just blank the text on Released.
              const showValue = b.value !== 'released';
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
                    {showValue ? moneyFmt.format(value) : ' '}
                  </div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                    {b.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar — search lives outside the table (it drives the
              server-paged query, not the in-memory filter). The
              client-side filter chips (Customer / Driver / Delivered),
              the column picker, and the bulk-action slot all live
              inside OpsTable below. The Review queue + Refresh
              buttons sit here so they're always reachable regardless
              of selection state. */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: searchQuery ? 'var(--gc-blue)' : 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder={`Search ${tab} loads — customer, load #, ID, title, driver, notes…`}
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

          {/* Body — OpsTable owns filter chips, column picker, sort,
              selection, AND pagination now. The page fetches the
              whole bucket up front (BUCKET_LIMIT) so OpsTable's
              filter chips (Customer / Driver / Delivered) operate
              across every load, not just the 50 currently visible.
              key={tab}-bound resetKey flushes OpsTable's selection
              state across tab/search changes. */}
          {error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 flex">
              <OpsTable<QueueRow>
                key={`closeout-${tab}-${selectionResetKey}`}
                data={visible}
                columns={tableColumns}
                filters={tableFilters}
                rowKey={rowKey}
                loading={loading}
                defaultSort={{ key: 'age', dir: 'desc' }}
                priorityKey={r => !!r.priority}
                columnPicker
                columnReorder
                persistKey={`closeout-${tab}`}
                selectable
                onSelectionChange={setSelectedIds}
                paginated
                pageSize={PAGE_SIZE}
                fillHeight
                emptyLabel={searchQuery ? `No ${tab} loads match "${searchQuery}".` : `No ${tab} loads.`}
                bulkActions={({ selectedIds: ids, clearSelection }) => (
                  <div className="flex items-center gap-2">
                    <button type="button"
                      onClick={() => void handleBulkRelease(ids)}
                      disabled={bulkBusy !== null}
                      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
                      style={{
                        background: '#dcfce7', color: '#15803d',
                        border: '1px solid #86efac',
                        opacity: bulkBusy !== null ? 0.6 : 1,
                        cursor: bulkBusy !== null ? 'default' : 'pointer',
                      }}>
                      {bulkBusy === 'release'
                        ? <Loader2 size={12} className="animate-spin" />
                        : <CheckCircle2 size={12} />}
                      Release selected
                    </button>
                    <button type="button"
                      onClick={() => setBulkFlagOpen(true)}
                      disabled={bulkBusy !== null}
                      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
                      style={{
                        background: '#fef3c7', color: '#92400e',
                        border: '1px solid #fde68a',
                        opacity: bulkBusy !== null ? 0.6 : 1,
                        cursor: bulkBusy !== null ? 'default' : 'pointer',
                      }}>
                      {bulkBusy === 'flag'
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Flag size={12} />}
                      Flag selected
                    </button>
                    {/* clearSelection — wired up implicitly via the
                        Clear button OpsTable renders on the right of
                        the bulk-actions row, so we don't add another. */}
                    <span className="hidden">{ids.length}</span>
                    {void clearSelection}
                  </div>
                )}
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

      {/* Bulk flag modal — same reasons + note, applied across every
          selected row in one pass. */}
      {bulkFlagOpen && (
        <FlagModal
          loadLabel={`${selectedIds.length} selected load${selectedIds.length === 1 ? '' : 's'}`}
          onCancel={() => setBulkFlagOpen(false)}
          onConfirm={confirmBulkFlag}
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
    </AppShell>
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
  const countSuffix = count && count > 1 ? ` (×${count})` : '';
  return (
    <FastTooltip text={`${label} — Present${countSuffix}`}>
      <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
        style={{
          background: bg,
          color:      '#fff',
          boxShadow:  '0 1px 2px rgba(0,0,0,0.08)',
        }}>
        {label}{count && count > 1 ? ` ×${count}` : ''}
      </span>
    </FastTooltip>
  );
}

/**
 * Required-doc slot — always renders, even when the doc is missing.
 *
 * Present  → opaque tint + white text (visually identical to DocBadge).
 * Missing  → transparent background, dashed red border + red text. The
 *            slot reads as "expected but not uploaded yet" without
 *            adding a separate FlagChip line.
 *
 * Used for RC on every row and POD on every non-TONU row in the
 * Paperwork loads table.
 */
function RequiredDocBadge({
  label, present, count, presentTint,
}: {
  label: string;
  present: boolean;
  count?: number;
  presentTint: string;
  /** Retained on the call site for backwards-compatibility but no longer
   *  rendered — the hover state is uniformly "{label} — Present/Missing". */
  missingTitle?: string;
}) {
  if (present) {
    const countSuffix = count && count > 1 ? ` (×${count})` : '';
    return (
      <FastTooltip text={`${label} — Present${countSuffix}`}>
        <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
          style={{
            background: presentTint,
            color:      '#fff',
            boxShadow:  '0 1px 2px rgba(0,0,0,0.08)',
          }}>
          {label}{count && count > 1 ? ` ×${count}` : ''}
        </span>
      </FastTooltip>
    );
  }
  return (
    <FastTooltip text={`${label} — Missing`}>
      <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold tabular-nums"
        style={{
          background: 'transparent',
          color:      '#991b1b',
          border:     '1px dashed #991b1b',
          // Subtract the 1px border so the missing chip lines up at the
          // same height as the opaque present chips (which have no
          // border but do have the same vertical padding).
          padding:    '1px 7px',
        }}>
        {label}
      </span>
    </FastTooltip>
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
      className="font-semibold inline-flex items-center gap-1 text-[13px] rounded px-1.5 py-0.5 transition-colors tabular-nums w-full"
      style={{
        color:      copied ? '#15803d' : 'var(--gc-text-1)',
        background: copied ? '#dcfce7' : 'transparent',
        justifyContent: 'flex-start',
      }}
      title={copied ? 'Copied!' : title}
      onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      {displayValue}
      {copied
        ? <Check size={11} style={{ color: '#15803d' }} />
        : null}
    </button>
  );
}

function NotesButton({ load, onOpen }: { load: Load; onOpen: () => void }) {
  const count = (load.internalNotes ?? []).length;
  const has = count > 0;
  return (
    <button onClick={e => { e.stopPropagation(); onOpen(); }}
      className="rounded-full p-1.5 transition-colors relative"
      title={has ? `${count} internal note${count !== 1 ? 's' : ''}` : 'Add internal note'}
      style={{
        background: has ? '#dbeafe' : 'transparent',
        border:     `1px solid ${has ? '#1a73e8' : 'var(--gc-border)'}`,
        color:      has ? '#1a73e8' : 'var(--gc-text-3)',
        overflow:   'visible',
      }}>
      <MessageSquare size={12} fill={has ? '#1a73e8' : 'none'} stroke={has ? '#1a73e8' : 'currentColor'} />
      {has && (
        <span
          className="absolute text-[9.5px] font-bold rounded-full tabular-nums flex items-center justify-center"
          style={{
            // Anchor INSIDE the button's top-right corner so the badge
            // can never clip the row's vertical bounds. Earlier
            // negative offsets popped the badge 3-5px above the
            // button — fine in isolation, but the first row of the
            // OpsTable sits at the top of the body's overflow:auto
            // viewport, which would clip anything spilling above.
            // The button's p-1.5 padding leaves enough room for the
            // 14px badge to overlap the icon's top-right corner
            // without losing legibility, and the white ring keeps
            // the badge distinct from the button background.
            top:        0,
            right:      0,
            minWidth:   14,
            height:     14,
            padding:    '0 3px',
            background: '#1a73e8',
            color:      '#fff',
            boxShadow:  '0 0 0 1.5px var(--gc-surface)',
            lineHeight: 1,
          }}>
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
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
  // Missing POD is surfaced by the always-rendered POD slot in the Docs
  // column (red + transparent when absent, opaque green when present),
  // so we no longer emit a duplicate FlagChip for it. Server-side
  // flagged-bucket placement is unchanged.
  // Pending accessorials are surfaced via the Accessorials column's
  // hover popover (status pill per line item). They used to render as
  // green FlagChips under the docs badges, but that stacked noisy chips
  // on every load with a pending detention/lumper request — duplicating
  // info that the dedicated Accessorials column already carries.
  return out;
}

function FlagChip({ reason }: { reason: ImpedimentReason }) {
  // Tone per chip type — keeps the row readable when several are
  // stacked. Manual flag in amber and pending accessorial in
  // green-ish still get the pill treatment (they're additive info).
  // Missing POD renders as plain red text only — stacking pink pills
  // for Missing POD + Missing RC + manual flags reads as noise.
  const label =
    reason.kind === 'manual'      ? reason.label
    : reason.kind === 'missing_pod' ? 'Missing POD'
                                    : `${ACCESSORIAL_LABELS[reason.category] ?? 'Accessorial'} ${moneyShort(reason.amount)}`;
  if (reason.kind === 'missing_pod') {
    return (
      <span className="flex items-center gap-1 text-[10px] font-semibold"
        style={{ color: '#991b1b' }}>
        <Flag size={9} /> {label}
      </span>
    );
  }
  const tone = reason.kind === 'manual'
    ? { bg: '#fef3c7', fg: '#92400e' }
    : { bg: '#dcfce7', fg: '#166534' };
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] font-semibold"
      style={{ background: tone.bg, color: tone.fg }}>
      <Flag size={9} /> {label}
    </span>
  );
}

// (Empty-state / column-menu helpers removed — OpsTable owns its own
// empty messaging and column picker now.)
