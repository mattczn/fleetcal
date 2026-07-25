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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileCheck2, Loader2, Flag, CheckCircle2, Clock, Play, Check, Star, X, MessageSquare, Search, Info } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { naiveNowInTz } from '@/lib/time-utils';
import { useAuth, useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import Link from 'next/link';
import type { Load, CalendarEvent } from '@/lib/types';
import { buildRelayMilesMap } from '@/lib/legMiles';
import { byLegIndex } from '@fleetcal/types';
import AppShell from '@/components/nav/AppShell';
import { displayBrokerName } from '@/lib/customerMatch';
import ReviewQueue from './ReviewQueue';
import { FlagModal, type FlagReason } from './FlagModal';
import InternalNotesModal from './InternalNotesModal';
import FollowUpModal from './FollowUpModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import { AccessorialsCell, FastTooltip } from '@/components/queue/QueueTablePrimitives';
import Tooltip from '@/components/ui/Tooltip';

type Tab = 'all' | 'recent' | 'flagged' | 'released';

// Maps the closeout UI's bucket name to the API tab. `released` (UI) →
// `released_all` (API) — the API name is more specific to avoid
// colliding with the accounting page's narrower `released` bucket
// which means just billing_status='verified'. `recent` is a new
// time-based filter ("delivered in the last 24h"); it shares the
// same candidate set as `all` plus a window check.
const API_TAB: Record<Tab, 'recent' | 'flagged' | 'all' | 'released_all'> = {
  all:      'all',
  recent:   'recent',
  flagged:  'flagged',
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
  relayPartners?: Record<string, { driverName?: string; assetName?: string }>;
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

// Per-tab tile config. Tints align to the Closeout/Workspace handoff:
// All = brand blue, Recently Delivered = amber, Flagged = red, Released
// = green. `sep: true` puts a hairline divider before the tile so the
// Released history surface visually separates from the open queue.
const TABS: {
  value: Tab;
  label: string;
  subtitle: string;
  tint: string;
  /** Background of the tinted icon chip (12%-alpha tint). */
  tintLight: string;
  /** Slightly darker tint used for the active-state $ value. */
  tintText: string;
  formula: React.ReactNode;
  sep?: boolean;
}[] = [
  { value: 'all',      label: 'All',                subtitle: 'Delivered loads ready to release',     tint: '#1a73e8', tintLight: '#e8f0fe', tintText: '#1558d6',
    formula: <>Every delivered load not yet released for billing. Count is total loads; $ is sum of <strong>Total Billable</strong> (linehaul + billable accessorials) per load.</> },
  { value: 'recent',   label: 'Recently Delivered', subtitle: 'Delivered within the past 24 hours',   tint: '#e37400', tintLight: '#fef7e0', tintText: '#b06000',
    formula: <>Loads whose delivery leg ended in the last 24 hours and aren&rsquo;t yet released. $ = sum of <strong>Total Billable</strong> per load.</> },
  { value: 'flagged',  label: 'Flagged',            subtitle: 'Missing POD · pending acc · priority · manual', tint: '#d93025', tintLight: '#fce8e6', tintText: '#c5221f',
    formula: <>Delivered loads that need attention: missing POD, accessorial pending approval, marked priority, or manually flagged. $ = sum of <strong>Total Billable</strong> per load.</> },
  { value: 'released', label: 'Released',           subtitle: 'Released for billing',                 tint: '#188038', tintLight: '#e6f4ea', tintText: '#137333',
    sep:     true,
    formula: <>Loads already released to accounting. Count only — $ is hidden here so dispatchers without accounting access don&rsquo;t see revenue aggregates.</> },
];

function ageDays(deliveredEnd: string): number {
  const t = new Date(deliveredEnd).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// Age color scale per the Billing/Paperwork handoff: three bands —
// grey (≤2d, nothing to worry about), amber (3-5d, aging), red
// (≥6d, surface to the top of the eye). Color alone signals
// urgency (no icon). Mirrors `ageBg`/`ageFg` in /accounting.
function ageColor(days: number): { bg: string; fg: string } {
  if (days <= 2) return { bg: '#f1f3f4', fg: '#5f6368' };
  if (days <= 5) return { bg: '#fef7e0', fg: '#b06000' };
  return { bg: '#fce8e6', fg: '#c5221f' };
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface QueueRow extends CalendarEvent { /* alias for clarity */ }

export default function CloseoutView() {
  const router = useRouter();
  const customers = useCalendarStore(s => s.customers);
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const { user } = useUser();
  // Clerk readiness gate — without this, a hard refresh on /closeout
  // fires the queue request before RailwayClientProvider has a chance
  // to wire the token (its useEffect runs after children's effects),
  // so the API rejects with 401. Navigating from /calendar works
  // because the provider is already wired from the previous page.
  const { isLoaded: authLoaded, isSignedIn } = useAuth();

  const [tab, setTab] = useState<Tab>('all');
  // Live counts shown on bucket tiles. Pre-fetched on mount and
  // refreshed alongside the main queue fetch — keeps the inactive
  // tile's number accurate without forcing a tab switch.
  const [bucketTotals, setBucketTotals] = useState<Record<Tab, number>>({ all: 0, recent: 0, flagged: 0, released: 0 });
  // Sum of load values per bucket (mirrors /accounting's bucket tiles).
  // Server returns this in the queue response (deduped by loadId for
  // relays). Refreshed alongside the count totals.
  // NOTE: released bucket intentionally leaves load $ at 0 — the
  // released view is a history surface for dispatchers WITHOUT
  // accounting access, so we don't pre-aggregate billing $ on it.
  const [bucketLoadValue, setBucketLoadValue] = useState<Record<Tab, number>>({ all: 0, recent: 0, flagged: 0, released: 0 });
  // Per-bucket loading state. The global `loading` flag below only
  // tracks the active tab, so without this a user clicking a
  // not-yet-primed tile would see "0" with no indication that the
  // count is still on the wire. Mirrors /accounting's bucketLoading.
  const [bucketLoading, setBucketLoading] = useState<Set<Tab>>(new Set());
  // Counts-priming flag. Tracked separately from bucketLoading so a
  // count-refresh finishing first doesn't clobber an in-flight active-
  // tab table fetch. Tiles show their spinner when either signal is on.
  const [countsPriming, setCountsPriming] = useState(false);

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
  // Relay-partner sidecar from the API: { [loadId]: { driverName, assetName } }.
  // For relay loads where dedup dropped one leg, this tells the
  // driver/truck columns about the OTHER leg without a second fetch.
  const [relayPartners, setRelayPartners] = useState<Record<string, { driverName?: string; assetName?: string }>>({});
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
    setRelayPartners(cached.relayPartners ?? {});
    setTotal(cached.total);
    return true;
  };

  const fetchAndCache = useMemo(() => async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError(null);
    setBucketLoading(prev => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
    try {
      // Pull the whole bucket so OpsTable's filter chips (Customer /
      // Driver / Delivered) operate across every load, not just the
      // 50 currently visible. BUCKET_LIMIT matches the API's
      // in-memory candidate caps so a single request covers the
      // bucket without a second page fetch.
      const { loads, docCounts, relayPartners, total } = await railway.listCloseoutQueue(API_TAB[tab], {
        limit: BUCKET_LIMIT,
        q:     searchQuery || undefined,
        now:   naiveNowInTz(calendarTimezone),
      });
      const entry: CacheEntry = { loads, docCounts, total, fetchedAt: Date.now(), relayPartners };
      cacheRef.current.set(`${tab}:${searchQuery}`, entry);
      setRows(loads as QueueRow[]);
      setDocCounts(docCounts ?? {});
      setRelayPartners(relayPartners ?? {});
      setTotal(total ?? loads.length);
      mergeEvents(loads as QueueRow[]);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
      setBucketLoading(prev => {
        if (!prev.has(tab)) return prev;
        const next = new Set(prev);
        next.delete(tab);
        return next;
      });
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
    // Flag every tile as priming for the duration of the count fetch
    // so tiles that haven't been clicked yet still show "…loading"
    // instead of "0".
    setCountsPriming(true);
    try {
      const nowTz = naiveNowInTz(calendarTimezone);
      const [a, rc, f, rl] = await Promise.all([
        railway.listCloseoutQueue('all',          { limit: 1, now: nowTz }).catch(() => null),
        railway.listCloseoutQueue('recent',       { limit: 1, now: nowTz }).catch(() => null),
        railway.listCloseoutQueue('flagged',      { limit: 1, now: nowTz }).catch(() => null),
        railway.listCloseoutQueue('released_all', { limit: 1, now: nowTz }).catch(() => null),
      ]);
      setBucketTotals({
        all:      a?.total  ?? 0,
        recent:   rc?.total ?? 0,
        flagged:  f?.total  ?? 0,
        released: rl?.total ?? 0,
      });
      setBucketLoadValue({
        all:      a?.totalLoadValue  ?? 0,
        recent:   rc?.totalLoadValue ?? 0,
        flagged:  f?.totalLoadValue  ?? 0,
        // Intentionally 0 — released bucket doesn't surface aggregate $.
        released: 0,
      });
    } catch { /* best-effort */ }
    finally {
      setCountsPriming(false);
    }
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

  // Dedup relays — one row per load (the earliest leg present wins:
  // pickup when it's in the page, otherwise the first later leg).
  const dedup = useMemo(() => {
    const groups = new Map<string, QueueRow[]>();
    for (const r of rows) {
      if (!r.relayGroupId) continue;
      const arr = groups.get(r.relayGroupId);
      if (arr) arr.push(r); else groups.set(r.relayGroupId, [r]);
    }
    const keeperByGroup = new Map<string, string>(); // relayGroupId → event id
    for (const [gid, legs] of groups) {
      keeperByGroup.set(gid, [...legs].sort(byLegIndex)[0].id);
    }
    return rows.filter(r =>
      !r.relayGroupId || keeperByGroup.get(r.relayGroupId) === r.id,
    );
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
    // Any non-final relay leg (pickup OR transfer) ends at a handoff,
    // not the real delivery — swap in the delivery leg's end.
    if (load.relayGroupId && load.relayRole && load.relayRole !== 'delivery' && load.loadId) {
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
  // Collapses the bucket tiles' detail rows ($ value + subtitle) once
  // the user scrolls down inside the table — surfaces a few more rows
  // when the operator is focused on triage. Hysteresis on the
  // thresholds (40 px to collapse / 8 px to expand) keeps it from
  // flickering as the user noodles near the top.
  const [tilesCompact, setTilesCompact] = useState(false);
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

    // Pre-compute total loaded miles per relay group so the RPM column
    // can divide load price by ALL-LEGS miles instead of just this row's
    // own miles. Without this, a short delivery leg shows an inflated
    // RPM and a long pickup leg shows a deflated one — the RPM is
    // load-level, not leg-level, so it must use load-total miles.
    const relayMiles = buildRelayMilesMap(rows);
    const loadMilesFor = (r: QueueRow): number => {
      if (r.relayGroupId) return relayMiles.get(r.relayGroupId) ?? 0;
      return r.loadedMiles ?? 0;
    };

    // Star + Notes pinned LEFT — utility column. alwaysVisible so it
    // can't be hidden in the picker (dispatchers always need the
    // priority/notes affordances).
    cols.push({
      key: 'flags', header: '', width: DEFAULT_COL_WIDTHS.flags,
      pinned: 'left', alwaysVisible: true, pickerLabel: 'Star / notes',
      render: r => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <FastTooltip text={r.priority ? 'Remove priority' : 'Mark as priority'}>
            <button onClick={() => void handleTogglePriority(r)}
              className="rounded-full p-1 transition-colors"
              style={{
                background: r.priority ? '#fef9c3' : 'transparent',
                border: `1px solid ${r.priority ? '#eab308' : 'var(--gc-border)'}`,
                color: r.priority ? '#854d0e' : 'var(--gc-text-3)',
              }}>
              <Star size={11} fill={r.priority ? '#eab308' : 'none'} />
            </button>
          </FastTooltip>
          <NotesButton load={r} onOpen={() => setNotesTarget(r)} />
        </div>
      ),
    });

    cols.push({
      key: 'age', header: 'Age', width: DEFAULT_COL_WIDTHS.age,
      sortable: true,
      headerTooltip: 'Days since delivery.',
      sortValue: r => ageDays(effectiveDeliveryEnd(r)),
      render: r => {
        const days = ageDays(effectiveDeliveryEnd(r));
        const c = ageColor(days);
        const iso = effectiveDeliveryEnd(r);
        const cellTooltip = iso
          ? `Delivered ${fmtDate(iso)} — ${days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`}`
          : 'No delivery date';
        return (
          <span title={cellTooltip}
            style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
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
        // Try the local rows lookup first (works when the sibling legs
        // are in the visible page), then fall back to the server-provided
        // relayPartners sidecar for the common case where server-side
        // dedup dropped the partner legs before they reached the client.
        // NB: on 3+ leg loads the sidecar's driverName may itself be
        // several names joined with " · " — rendered verbatim.
        const drivers: string[] = [];
        if (r.driverName) drivers.push(r.driverName);
        if (r.relayGroupId) {
          const siblings = rows
            .filter(x => x.id !== r.id && x.relayGroupId === r.relayGroupId)
            .sort(byLegIndex);
          for (const s of siblings) {
            if (s.driverName && !drivers.includes(s.driverName)) drivers.push(s.driverName);
          }
          if (siblings.length === 0 && r.loadId) {
            const sidecar = relayPartners[r.loadId]?.driverName;
            if (sidecar && !drivers.includes(sidecar)) drivers.push(sidecar);
          }
        }
        if (drivers.length === 0) return <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>;
        if (drivers.length === 1) return <span>{drivers[0]}</span>;
        return (
          <div>
            <div className="text-[12.5px]">{drivers[0]}</div>
            <div className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>+ {drivers.slice(1).join(' · ')}</div>
          </div>
        );
      },
    });

    cols.push({
      key: 'truck', header: 'Truck', width: DEFAULT_COL_WIDTHS.truck,
      sortable: true,
      sortValue: r => r.assetName ?? '',
      render: r => {
        // Mirror the Driver column's relay-aware lookup so the other
        // legs' trucks show alongside this leg's. Local rows lookup
        // first (sibling legs visible on the same page); fall back to
        // the server-provided relayPartners sidecar for the common
        // case where server-side dedup dropped the partner legs before
        // they reached the client.
        const trucks: string[] = [];
        if (r.assetName) trucks.push(r.assetName);
        if (r.relayGroupId) {
          const siblings = rows
            .filter(x => x.id !== r.id && x.relayGroupId === r.relayGroupId)
            .sort(byLegIndex);
          for (const s of siblings) {
            if (s.assetName && !trucks.includes(s.assetName)) trucks.push(s.assetName);
          }
          if (siblings.length === 0 && r.loadId) {
            const sidecar = relayPartners[r.loadId]?.assetName;
            if (sidecar && !trucks.includes(sidecar)) trucks.push(sidecar);
          }
        }
        if (trucks.length === 0) return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        if (trucks.length === 1) {
          return <span className="font-semibold tabular-nums">{trucks[0]}</span>;
        }
        return (
          <div>
            <div className="text-[12.5px] font-semibold tabular-nums">{trucks[0]}</div>
            <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>+ {trucks.slice(1).join(' · ')}</div>
          </div>
        );
      },
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
        const m = loadMilesFor(r);
        return m > 0 && r.loadPrice != null ? r.loadPrice / m : 0;
      },
      render: r => {
        const m = loadMilesFor(r);
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
        // Lumper / Scale are conditionally required — only when the
        // load has a matching accessorial line item. Mirrors the
        // ReviewQueue's verification-chips logic so the badges and
        // the chips read the same.
        const accs = r.accessorials ?? [];
        const needsLumper = accs.some(a => a.category === 'lumper');
        const needsScale  = accs.some(a => a.category === 'scale_ticket');
        const lumperCount = counts.lumper ?? 0;
        const scaleCount  = counts.scale  ?? 0;
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
              {needsLumper && (
                <RequiredDocBadge
                  label="Lumper"
                  present={lumperCount > 0}
                  count={lumperCount}
                  presentTint={DOC_BADGE_TINT.Lumper}
                  missingTitle="No lumper receipt uploaded"
                />
              )}
              {needsScale && (
                <RequiredDocBadge
                  label="Scale"
                  present={scaleCount > 0}
                  count={scaleCount}
                  presentTint={DOC_BADGE_TINT.Scale}
                  missingTitle="No scale ticket uploaded"
                />
              )}
              {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol} />}
              {/* Lumper / Scale fall back to the plain DocBadge only when the
                  load has NO matching accessorial but still happens to have
                  the doc on file (rare — preserves the chip if it's there). */}
              {!needsLumper && lumperCount > 0 && <DocBadge label="Lumper"  count={lumperCount} />}
              {!needsScale  && scaleCount  > 0 && <DocBadge label="Scale"   count={scaleCount} />}
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
            <FastTooltip text="Open this load in the review queue">
              <button onClick={() => { setReviewStartIndex(Math.max(0, rowIdx)); setReviewOpen(true); }}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: '#15803d', color: '#fff' }}>
                <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
              </button>
            </FastTooltip>
            <FastTooltip text="Release for billing without opening the review queue">
              <button onClick={() => void handleVerify(r)}
                className="rounded-lg transition-colors inline-flex items-center justify-center"
                style={{
                  background: '#dcfce7', color: '#15803d',
                  border: '1px solid #86efac',
                  width: 26, height: 24,
                }}>
                <CheckCircle2 size={12} />
              </button>
            </FastTooltip>
            {!rowFlagged ? (
              <FastTooltip text="Flag — mark this load as needing follow-up">
                <button onClick={() => handleFlag(r)}
                  className="rounded-lg transition-colors inline-flex items-center justify-center"
                  style={{
                    background: '#fef3c7', color: '#92400e',
                    border: '1px solid #fde68a',
                    width: 26, height: 24,
                  }}>
                  <Flag size={12} />
                </button>
              </FastTooltip>
            ) : (
              <FastTooltip text="Follow up — log a note, approve/deny an accessorial, or clear the flag">
                <button onClick={() => setFollowUpTarget(r)}
                  className="rounded-lg transition-colors inline-flex items-center justify-center"
                  style={{
                    background: '#fff7ed', color: '#9a3412',
                    border: '1px solid #fed7aa',
                    width: 26, height: 24,
                  }}>
                  <MessageSquare size={12} />
                </button>
              </FastTooltip>
            )}
          </div>
        );
      },
    });

    // Default column order — drives the table's seed layout. Operator
    // reorders are persisted by OpsTable via the persistKey, so this
    // only affects the first time a user lands on a given tab (and
    // also any column that gets added later — mergeOrder slots new
    // ones in adjacent to their declared neighbour).
    const PAPERWORK_ORDER: string[] = [
      'flags',
      'age', 'loadNum', 'title', 'customer',
      'rate', 'accessorials', 'total', 'docs',
      'driver', 'truck',
      'internalId',
      'pickedUp', 'delivered',
      'stops', 'miles', 'rpm',
      'billingStatus',
      'actions',
    ];
    const rank = (k: string) => {
      const i = PAPERWORK_ORDER.indexOf(k);
      // Unranked columns push to the end without scrambling each other.
      return i === -1 ? PAPERWORK_ORDER.length : i;
    };
    return [...cols].sort((a, b) => rank(a.key) - rank(b.key));
    // Cell renderers capture handler closures via this scope —
    // exhaustive deps would be noisy because every state setter is
    // captured. The actual values that influence DISPLAY are listed
    // explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, rows, docCounts, tab, relayPartners]);

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
    // Accessorial filter — operator-centric presets rather than the
    // raw category list, since the common workflow is "show me all
    // loads that have anything to chase down". Per-category options
    // give a quick way to scope to e.g. just detentions or just
    // lumpers when a specific bucket is the focus.
    const accessorialOpts = [
      { value: '__any',        label: 'Has any accessorial' },
      { value: '__pending',    label: 'Has pending accessorial' },
      { value: '__none',       label: 'No accessorials' },
      { value: 'detention',    label: 'Detention' },
      { value: 'lumper',       label: 'Lumper' },
      { value: 'layover',      label: 'Layover' },
      { value: 'scale_ticket', label: 'Scale' },
      { value: 'extra_stop',   label: 'Extra stop' },
      { value: 'other',        label: 'Other' },
    ];
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
      { kind: 'select', key: 'accessorial', label: 'Accessorial',
        options: accessorialOpts,
        predicate: (r, v) => {
          const accs = r.accessorials ?? [];
          if (v === '__any')     return accs.length > 0;
          if (v === '__pending') return accs.some(a => a.status !== 'approved' && a.status !== 'denied');
          if (v === '__none')    return accs.length === 0;
          return accs.some(a => a.category === v);
        } },
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
    <AppShell title="Paperwork" icon={FileCheck2} noPageScroll>
      {/* Fixed-height content area — table claims the remaining space
          and scrolls inside its own viewport. Outer padding lives here.
          Bottom padding is tighter than top (pb-2 vs pt-5) so the table
          card extends close to the viewport edge; the page footer
          ("Showing X of Y records") gets the breathing room it needs
          via its own mt-3 and there's no value in stacking another
          20px of dead space underneath it. */}
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-2 gap-4">
        <div className="w-full min-h-0 flex-1 flex flex-col gap-3">

          {/* Purpose hint — keeps the split between Paperwork and
              Billing visible while users are still building muscle
              memory, and surfaces the auto-flag rules so users don't
              have to guess what put a load in the Flagged bucket. */}
          <div className="fleetcal-page-subtitle text-[12.5px] flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: 'var(--gc-text-3)' }}>
            <span>
              POD verification. Check paperwork and release loads for billing.
              Invoicing happens in <Link href="/accounting" className="font-semibold underline" style={{ color: 'var(--gc-blue)' }}>Billing</Link>.
            </span>
            <FastTooltip text="Flagged = POD missing 24h+ · Pending accessorial · Priority load · Manually flagged">
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md cursor-default"
                style={{
                  background: '#fff7ed',
                  color:      '#9a3412',
                  border:     '1px solid #fed7aa',
                  fontWeight: 600,
                }}
              >
                <Info size={11} /> What gets flagged?
              </span>
            </FastTooltip>
          </div>

          {/* Bucket tiles per the Billing/Paperwork redesign handoff.
              Mirrors /accounting's two-mode pattern so both surfaces
              feel like one product:
                - Full mode:  tinted icon chip + label + big count + $
                              + subtitle on a second row + 4px left
                              accent + soft elevation on the active
                              tile.
                - Compact:    single pill-row per bucket (color dot +
                              label + count + $; active = filled tint).
              NO chevrons here — Paperwork is verification-stage, not
              a left-to-right pipeline (handoff: "Skip chevrons on
              Paperwork"). A hairline divider before "Released"
              separates the open-queue tiles from the history surface.
              Released $ is intentionally blank — billing aggregates
              are role-gated to /accounting. */}
          {tilesCompact ? (
            <div className="fleetcal-buckets-compact flex items-center gap-2 flex-wrap">
              {TABS.map(b => {
                const active    = tab === b.value;
                const count     = bucketTotals[b.value];
                const value     = bucketLoadValue[b.value];
                const isPriming = countsPriming || bucketLoading.has(b.value);
                const showValue = b.value !== 'released';
                return (
                  <button key={b.value}
                    onClick={() => setTab(b.value)}
                    className="fleetcal-bucket-compact inline-flex items-center gap-2 transition-colors"
                    title={`${b.label} — ${b.subtitle}`}
                    style={{
                      height:       34,
                      padding:      '0 12px',
                      borderRadius: 999,
                      background:   active ? b.tint            : 'var(--gc-surface)',
                      color:        active ? '#fff'            : 'var(--gc-text-2)',
                      border:       active ? '1px solid transparent' : '1px solid var(--gc-border-light)',
                      fontSize:     12.5,
                      fontWeight:   700,
                      cursor:       'pointer',
                    }}>
                    <span style={{
                      width:        9,
                      height:       9,
                      borderRadius: 999,
                      background:   active ? '#fff' : b.tint,
                      flex:         'none',
                    }} />
                    {b.label}
                    {isPriming
                      ? <Loader2 size={12} className="animate-spin" style={{ color: active ? '#fff' : b.tint }} />
                      : <span style={{ fontWeight: 800 }}>{count.toLocaleString()}</span>}
                    {showValue && (
                      <span className="tabular-nums" style={{
                        color:      active ? 'rgba(255,255,255,0.85)' : 'var(--gc-text-3)',
                        fontWeight: 600,
                      }}>
                        {moneyFmt.format(value)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="fleetcal-buckets flex items-stretch gap-2">
              {TABS.map(b => {
                const active    = tab === b.value;
                const count     = bucketTotals[b.value];
                const value     = bucketLoadValue[b.value];
                const isPriming = countsPriming || bucketLoading.has(b.value);
                const showValue = b.value !== 'released';
                const Icon =
                  b.value === 'recent'   ? Clock :
                  b.value === 'flagged'  ? Flag  :
                  b.value === 'released' ? CheckCircle2 :
                                           FileCheck2;
                return (
                  <React.Fragment key={b.value}>
                    {/* Hairline divider before "Released". */}
                    {b.sep && (
                      <span style={{ width: 1, background: 'var(--gc-border-light)', margin: '6px 3px' }} />
                    )}
                    <button
                      onClick={() => setTab(b.value)}
                      className="fleetcal-bucket text-left rounded-2xl transition-all relative overflow-hidden flex-1 min-w-0"
                      style={{
                        background: 'var(--gc-surface)',
                        border:     active ? '1px solid transparent' : '1px solid var(--gc-border-light)',
                        boxShadow:  active ? 'var(--shadow-soft)' : 'var(--shadow-1)',
                        transform:  active ? 'translateY(-2px)' : 'translateY(0)',
                        padding:    '13px 15px',
                      }}>
                      {/* 4px left accent — visible only when active. */}
                      <span style={{
                        position:   'absolute',
                        left:       0,
                        top:        0,
                        bottom:     0,
                        width:      4,
                        background: active ? b.tint : 'transparent',
                      }} />
                      <div className="flex items-center gap-2.5">
                        <span style={{
                          width:        30,
                          height:       30,
                          borderRadius: 8,
                          display:      'grid',
                          placeItems:   'center',
                          background:   b.tintLight,
                          flex:         'none',
                        }}>
                          <Icon size={17} style={{ color: b.tint }} />
                        </span>
                        <span className="text-[13.5px] font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {b.label}
                        </span>
                        <Tooltip content={b.formula} placement="bottom">
                          <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
                        </Tooltip>
                        {isPriming ? (
                          <Loader2 size={14} className="ml-auto animate-spin" style={{ color: b.tint }} />
                        ) : (
                          <span className="ml-auto tabular-nums" style={{
                            fontSize:   22,
                            fontWeight: 800,
                            lineHeight: 1,
                            color:      'var(--gc-text-1)',
                          }}>
                            {count.toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-2 mt-2">
                        <span className="text-[11.5px] font-semibold truncate" style={{ color: 'var(--gc-text-3)' }}>
                          {b.subtitle}
                        </span>
                        {showValue && (
                          <span className="tabular-nums" style={{
                            fontSize:   13.5,
                            fontWeight: 800,
                            color:      active ? b.tintText : 'var(--gc-text-2)',
                          }}>
                            {moneyFmt.format(value)}
                          </span>
                        )}
                      </div>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          {/* Toolbar — search lives outside the table (it drives the
              server-paged query, not the in-memory filter). The
              client-side filter chips (Customer / Driver / Delivered),
              the column picker, and the bulk-action slot all live
              inside OpsTable below. The Review queue + Refresh
              buttons sit here so they're always reachable regardless
              of selection state. */}
          <div className="fleetcal-toolbar flex items-center gap-3 flex-wrap">
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
              {(tab === 'all' || tab === 'recent') && <span style={{ color: 'var(--gc-text-3)' }}>(including upcoming)</span>}
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
                onRowDoubleClick={r => {
                  // Jump to the full load page — every revenue load in
                  // closeout has an internalLoadId, but guard anyway.
                  if (r.internalLoadId != null) router.push(`/loads/${r.internalLoadId}`);
                }}
                defaultSort={{ key: 'age', dir: 'desc' }}
                priorityKey={r => !!r.priority}
                // Left-edge problem stripe per the Billing/Paperwork
                // redesign handoff. Paperwork is verification-stage,
                // so the signal is "what needs paperwork attention":
                //   red   — missing required RC/POD on a delivered
                //           load, or row is flagged (the existing
                //           priority/flag semantics already raise it
                //           at the cell-level; the stripe just
                //           carries the same urgency at the row).
                //   amber — aging 3–5 days since delivery.
                // Uses the same `docCounts` map the Docs column
                // reads, so the two views are consistent.
                rowAccent={r => {
                  const counts = docCounts[r.loadId ?? r.id] ?? {};
                  const rcCount  = Math.max(counts.rate_con ?? 0, r.rateConPdf ? 1 : 0);
                  const podCount = counts.pod ?? 0;
                  const missingRC  = rcCount === 0;
                  const missingPOD = !r.isTonu && podCount === 0;
                  if (missingRC || missingPOD) return '#d93025';
                  const days = ageDays(effectiveDeliveryEnd(r));
                  if (days >= 6) return '#d93025';
                  if (days >= 3) return '#e37400';
                  return null;
                }}
                columnPicker
                columnReorder
                persistKey={`closeout-${tab}`}
                selectable
                onSelectionChange={setSelectedIds}
                paginated
                pageSize={PAGE_SIZE}
                fillHeight
                onScrollChange={({ scrollTop }) => {
                  // Hysteresis prevents flicker as the user noodles
                  // near the top of the list.
                  if (scrollTop > 40 && !tilesCompact) setTilesCompact(true);
                  else if (scrollTop < 8 && tilesCompact) setTilesCompact(false);
                }}
                emptyLabel={searchQuery ? `No ${tab} loads match "${searchQuery}".` : `No ${tab} loads.`}
                // Floating dark bulk bar — Billing/Paperwork redesign.
                // The bar pins to the bottom of the table viewport and
                // wraps to inline-flex on phones via the responsive
                // pass.
                bulkBarMode="floating"
                bulkBarSummary={rows => {
                  // $ total mirrors the bucket-tile math (totalBillable
                  // → loadPrice fallback). Hidden on the Released
                  // history bucket where billing aggregates are
                  // role-gated to /accounting.
                  if (tab === 'released') return null;
                  const total = rows.reduce(
                    (s, r) => s + ((r.totalBillable ?? r.loadPrice ?? 0)),
                    0
                  );
                  return `· ${moneyFmt.format(total)}`;
                }}
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
  // Bare number — drop the `#` prefix so the column reads as the raw
  // identifier the operator pastes into broker portals.
  return <CopyableCell value={value} displayValue={value} title="Copy load #" />;
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
    <FastTooltip text={copied ? 'Copied!' : title}>
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
        onMouseEnter={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
        {copied ? (
          <>
            <Check size={12} style={{ color: '#15803d' }} />
            Copied!
          </>
        ) : displayValue}
      </button>
    </FastTooltip>
  );
}

function NotesButton({ load, onOpen }: { load: Load; onOpen: () => void }) {
  const count = (load.internalNotes ?? []).length;
  const has = count > 0;
  const tooltip = has
    ? `${count} internal note${count !== 1 ? 's' : ''} — click to view`
    : 'Add an internal note';
  return (
    <FastTooltip text={tooltip}>
      <button onClick={e => { e.stopPropagation(); onOpen(); }}
        className="rounded-full p-1.5 transition-colors relative"
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
    </FastTooltip>
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
