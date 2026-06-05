'use client';

/**
 * Asset timeline — side-by-side day view of scheduled events vs.
 * actual movements for one truck.
 *
 * Two columns share a 24h time axis (org TZ). Click any chip to open
 * a side panel with full details. PR 3 adds editing controls inside
 * that panel — for now it's read-only display.
 *
 * Time-axis conventions used by this view:
 *   - Events come from the DB as NAIVE ISO strings ("YYYY-MM-DDTHH:mm:ss")
 *     meant to be interpreted in the org's dispatch zone. They use
 *     naive helpers below — no TZ math is needed because the value
 *     already IS org-local.
 *   - Movements come from the DB as proper UTC TIMESTAMPTZ ("…+00:00").
 *     They use the TZ-aware helpers so a viewer in PT sees a CT-org
 *     movement at the right wall-clock hour.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Calendar as CalendarIcon, ArrowLeft,
  Truck, MapPin, Clock, Sparkles, X, Plus, Pencil, Trash2, Loader2,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import {
  railway,
  type TimelinePayload, type TimelineEvent, type TimelineLink,
  type TimelineLinkRole, type AssertLinkRequest, type CreateMovementRequest,
  type TimelineProfitability, type TimelineProfitabilityLoad,
  type WeekSummary,
} from '@/lib/railway';
import WeekStrip from './WeekStrip';
import WeekRevenuePanel from './WeekRevenuePanel';
import {
  clusterTimelineMovements, computeDwells, findSavedLocation,
  type TimelineCluster, type TimelineDwell,
} from '@/lib/timelineClusters';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';
import type { SavedLocation } from '@/lib/types';
import TimelineMap from './TimelineMap';

// ── Font scale helper ─────────────────────────────────────────────────
//
// Matches CalendarEvent's fs() — multiplies the base px size by the
// user's cardFontScale setting and rounds to the nearest 0.5px so the
// rendered text stays crisp. Bound at call site, not via context.
function makeFs(scale: number) {
  return (basePx: number) => Math.round(basePx * scale * 2) / 2;
}

// ── Geometry ───────────────────────────────────────────────────────────

const HOUR_HEIGHT_PX = 60;
const TOTAL_HEIGHT   = 24 * HOUR_HEIGHT_PX;

// ── NAIVE helpers (for event timestamps) ───────────────────────────────
//
// Events in this system are stored naive in the org's dispatch zone.
// Parsing them through `new Date()` would interpret them as device-local
// and skew the rendered time by whatever the viewer's TZ offset is.
// These helpers operate on the string directly.

function naiveDateKey(naive: string): string {
  return naive.slice(0, 10); // 'YYYY-MM-DD'
}

function naiveMinutesOfDay(naive: string): number {
  const m = naive.match(/T(\d{2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function fmtNaiveTime(naive: string): string {
  const m = naive.match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mm} ${ampm}`;
}

// ── TZ helpers (for UTC movement timestamps) ───────────────────────────

function utcDateKeyInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function utcMinutesOfDayInTz(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h === 24 ? 0 : h) * 60 + m;
}

function fmtUtcTimeInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
  });
}

// ── Header date format ────────────────────────────────────────────────

function fmtDateHeader(dayKey: string, tz: string): string {
  const naiveMid = `${dayKey}T12:00:00`;
  const epoch = parseNaiveIsoInTz(naiveMid, tz);
  const today = utcDateKeyInTz(new Date().toISOString(), tz);
  const tmrw  = shiftDateKey(today, 1);
  const yest  = shiftDateKey(today, -1);
  const pretty = new Date(epoch).toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    year: new Date(epoch).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
  if (dayKey === today) return `Today · ${pretty}`;
  if (dayKey === tmrw)  return `Tomorrow · ${pretty}`;
  if (dayKey === yest)  return `Yesterday · ${pretty}`;
  return pretty;
}

function shiftDateKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Saturday on or before the given dayKey — the org's week starts on
 *  Saturday and runs through Friday. Used to anchor the week strip. */
function weekStartFor(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  const dow = d.getUTCDay();           // 0=Sun, 1=Mon, ..., 6=Sat
  const daysBack = (dow - 6 + 7) % 7;  // 0 when dayKey is Sat
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

// ── Block positioning ────────────────────────────────────────────────

interface Pos { topPx: number; heightPx: number; spansBefore: boolean; spansAfter: boolean; }

/** Position for a NAIVE-time event. Both endpoints interpreted as
 *  org-local wall-clock; no TZ math involved. */
function positionForEvent(startNaive: string, endNaive: string, dayKey: string): Pos {
  const sk = naiveDateKey(startNaive);
  const ek = naiveDateKey(endNaive);
  const spansBefore = sk < dayKey;
  const spansAfter  = ek > dayKey;
  const topMin = spansBefore ? 0 : naiveMinutesOfDay(startNaive);
  const botMin = spansAfter  ? 24 * 60 : naiveMinutesOfDay(endNaive);
  const topPx    = (topMin / 60) * HOUR_HEIGHT_PX;
  const heightPx = Math.max(28, ((botMin - topMin) / 60) * HOUR_HEIGHT_PX);
  return { topPx, heightPx, spansBefore, spansAfter };
}

/** Position for a UTC movement timestamp. */
function positionForMovement(startIso: string, endIso: string | undefined, dayKey: string, tz: string): Pos {
  const sk = utcDateKeyInTz(startIso, tz);
  const ek = endIso ? utcDateKeyInTz(endIso, tz) : sk;
  const spansBefore = sk < dayKey;
  const spansAfter  = ek > dayKey;
  const topMin = spansBefore ? 0 : utcMinutesOfDayInTz(startIso, tz);
  const botMin = spansAfter
    ? 24 * 60
    : (endIso ? utcMinutesOfDayInTz(endIso, tz) : topMin + 5);
  const topPx    = (topMin / 60) * HOUR_HEIGHT_PX;
  // Min 24px so even a 1-min movement is clickable.
  const heightPx = Math.max(24, ((botMin - topMin) / 60) * HOUR_HEIGHT_PX);
  return { topPx, heightPx, spansBefore, spansAfter };
}

// ── Now line ─────────────────────────────────────────────────────────

function NowLine({ dayKey, tz }: { dayKey: string; tz: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (utcDateKeyInTz(now.toISOString(), tz) !== dayKey) return null;
  const top = (utcMinutesOfDayInTz(now.toISOString(), tz) / 60) * HOUR_HEIGHT_PX;
  return (
    <div
      className="absolute left-0 right-0 pointer-events-none z-10 flex items-center"
      style={{ top }}
    >
      <div className="w-2 h-2 rounded-full bg-red-500 -ml-1" />
      <div className="flex-1 h-px bg-red-500/70" />
    </div>
  );
}

// ── Role / source labels ──────────────────────────────────────────────

const ROLE_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  loaded:     { bg: '#e6f4ea', fg: '#1e8e3e', label: 'Loaded' },
  transition: { bg: '#fef7e0', fg: '#b06000', label: 'Deadhead' },
  dwell:      { bg: '#e8f0fe', fg: '#1967d2', label: 'Dwell' },
  rest:       { bg: '#f1f3f4', fg: '#5f6368', label: 'Rest' },
  unrelated:  { bg: '#fce8e6', fg: '#c5221f', label: 'Unrelated' },
};

const SOURCE_BADGE: Record<string, { fg: string; label: string }> = {
  motive:  { fg: '#5f6368', label: 'Motive' },
  manual:  { fg: '#1967d2', label: 'Manual' },
  derived: { fg: '#a142f4', label: 'Derived' },
};

// ── Selection state for the detail column ────────────────────────────
//
// Movements are clustered before display, so the unit a dispatcher can
// click on is a CLUSTER (one logical trip), not a raw Motive fragment.
// The link looked up for a cluster is the link on any one of its
// members — they're written identically by the AI / cluster-level edit.

type Selection =
  | { kind: 'event';   event:   TimelineEvent }
  | { kind: 'cluster'; cluster: TimelineCluster; link?: TimelineLink }
  | null;

// ── Main view ─────────────────────────────────────────────────────────

export default function AssetTimelineView({ assetId }: { assetId: number | null }) {
  const router = useRouter();
  const { calendarTimezone, assets, savedLocations, fetchSavedLocations, cardFontScale } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';
  const fs = useMemo(() => makeFs(cardFontScale), [cardFontScale]);

  // Saved locations are loaded lazily by the settings page — the timeline
  // page can land cold, so fetch on mount if the store is empty.
  // Without these the dwell chips can't resolve "At Yard" labels and
  // fall back to raw address strings, which is fine but less useful.
  useEffect(() => {
    if (savedLocations.length === 0) {
      void fetchSavedLocations();
    }
  }, [savedLocations.length, fetchSavedLocations]);

  // Truck picker — visible-and-active assets sorted by store order.
  // The URL drives the selection (router.replace on change), so back/
  // forward + bookmarking work and the dispatcher can deep-link to a
  // specific truck-day.
  const truckOptions = useMemo(
    () => assets.filter((a) => !a.hidden).sort((a, b) => a.sortOrder - b.sortOrder),
    [assets],
  );
  const fallbackAssetId = truckOptions[0]?.id ?? null;
  const effectiveAssetId = assetId ?? fallbackAssetId;

  const storeAsset = effectiveAssetId != null
    ? assets.find((a) => a.id === effectiveAssetId)
    : undefined;
  const assetColor = storeAsset?.color ?? '#1a73e8';

  // When the URL has no assetId and we picked a fallback, replace the
  // URL so the truck picker reflects what's actually being shown.
  useEffect(() => {
    if (assetId == null && fallbackAssetId != null) {
      router.replace(`/timeline?assetId=${fallbackAssetId}`);
    }
  }, [assetId, fallbackAssetId, router]);

  function switchAsset(newId: number) {
    router.replace(`/timeline?assetId=${newId}`);
  }

  const todayKey = utcDateKeyInTz(new Date().toISOString(), tz);
  const [dayKey, setDayKey] = useState<string>(todayKey);

  // When the Week-total card on the strip is clicked, this flips true
  // and the per-day Revenue Analysis swaps to the week-aggregate panel.
  // Switching weeks (or clicking a day card) resets it to false.
  const [weekTotalSelected, setWeekTotalSelected] = useState<boolean>(false);

  // Started-weeks list for the Week dropdown — Saturdays going back
  // from the current week. Each option labels its Sat → Fri range.
  // Capped at 12 weeks back for a reasonable dropdown size; if a
  // dispatcher needs to audit something older they can deep-link.
  const currentWeekStart = useMemo(() => weekStartFor(todayKey), [todayKey]);
  const startedWeeks = useMemo(() => {
    const items: { weekStart: string; label: string }[] = [];
    let cur = currentWeekStart;
    for (let i = 0; i < 12; i++) {
      const fri = shiftDateKey(cur, 6);
      const [satY, satM, satD] = cur.split('-').map(Number);
      const [friY, friM, friD] = fri.split('-').map(Number);
      const satDate = new Date(satY, satM - 1, satD);
      const friDate = new Date(friY, friM - 1, friD);
      const sameMonth = satDate.getMonth() === friDate.getMonth();
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const left  = `${monthNames[satDate.getMonth()]} ${satD}`;
      const right = sameMonth
        ? `${friD}`
        : `${monthNames[friDate.getMonth()]} ${friD}`;
      let label = `${left} – ${right}`;
      if (cur === currentWeekStart) label = `This week (${label})`;
      else if (i === 1)             label = `Last week (${label})`;
      items.push({ weekStart: cur, label });
      cur = shiftDateKey(cur, -7);
    }
    return items;
  }, [currentWeekStart]);

  /** Switch the displayed week. If the user picks the current week we
   *  jump to today; otherwise we jump to the selected week's Saturday
   *  so the dispatcher lands on a sensible day inside the new week. */
  function selectWeek(weekStart: string) {
    if (weekStart === currentWeekStart) {
      setDayKey(todayKey);
    } else {
      setDayKey(weekStart);
    }
    setWeekTotalSelected(false);
  }

  const [data, setData]       = useState<TimelinePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [selection, setSelection] = useState<Selection>(null);
  // Bump to force a refetch after editing links / creating manual
  // movements. Cheaper than threading invalidate calls through every
  // child editor.
  const [refreshTick, setRefreshTick] = useState(0);

  const [showCreateMovement, setShowCreateMovement] = useState(false);
  const [autoLinking, setAutoLinking] = useState(false);
  const [autoLinkResult, setAutoLinkResult] = useState<{
    linksWritten: number; manualSkipped: number; totalMovements: number; message?: string;
  } | null>(null);

  // Bulk-week AI state — separate from single-day so the existing
  // single-day path keeps working unchanged.
  const [weekLinking, setWeekLinking]   = useState(false);
  const [weekProgress, setWeekProgress] = useState<{ done: number; total: number } | null>(null);
  const [weekLinkResult, setWeekLinkResult] = useState<{
    daysLinked: number; totalLinksWritten: number; totalManualSkipped: number; failures: number;
    /** Per-day failure reason for the result banner — surfaces WHY a
     *  day failed so the user can tell rate-limit from data-shape. */
    failureDetails?: Array<{ day: string; reason: string }>;
  } | null>(null);

  // Week-summary fetch state (per-day P&L for the week strip).
  const [weekSummary, setWeekSummary]       = useState<WeekSummary | null>(null);
  const [weekSummaryLoading, setWeekSummaryLoading] = useState(false);

  async function runAutoLink() {
    if (effectiveAssetId == null) return;
    setAutoLinking(true);
    setAutoLinkResult(null);
    try {
      const result = await railway.autoLinkAssetTimeline(effectiveAssetId, fetchWindow.from, fetchWindow.to);
      setAutoLinkResult({
        linksWritten:   result.linksWritten,
        manualSkipped:  result.manualSkipped,
        totalMovements: result.totalMovements,
        message:        result.message,
      });
      setRefreshTick((t) => t + 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Auto-link failed');
    } finally {
      setAutoLinking(false);
    }
  }

  /** Run AI auto-link for every day in the visible week (Sat → Fri) in
   *  parallel. Each day uses its own padded ±6h UTC window. Failures
   *  are tallied but don't abort the rest. */
  async function runWeekAutoLink() {
    if (effectiveAssetId == null) return;
    const weekStart = weekStartFor(dayKey);
    setWeekLinking(true);
    setWeekLinkResult(null);
    setWeekProgress({ done: 0, total: 7 });

    const dayKeys = Array.from({ length: 7 }, (_, i) => shiftDateKey(weekStart, i));
    const pad = 6 * 60 * 60 * 1000;
    const windows = dayKeys.map((k) => {
      const startEpoch = parseNaiveIsoInTz(`${k}T00:00:00`, tz);
      const endEpoch   = parseNaiveIsoInTz(`${k}T23:59:59`, tz);
      return {
        from: new Date(startEpoch - pad).toISOString(),
        to:   new Date(endEpoch   + pad).toISOString(),
      };
    });

    let done = 0;
    let totalLinks = 0;
    let totalSkipped = 0;
    let failures = 0;
    const failureDetails: Array<{ day: string; reason: string }> = [];
    const results = await Promise.allSettled(
      windows.map(async (w, i) => {
        try {
          return { ok: true as const, day: dayKeys[i], value: await railway.autoLinkAssetTimeline(effectiveAssetId!, w.from, w.to) };
        } catch (err) {
          // Wrap the failure with the dayKey so the result banner can
          // show "Tue 6/3 — rate_limit" instead of just a counter.
          return { ok: false as const, day: dayKeys[i], reason: err instanceof Error ? err.message : String(err) };
        }
      }).map((p) => p.finally(() => {
        done++;
        setWeekProgress({ done, total: 7 });
      })),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) {
        totalLinks   += r.value.value.linksWritten;
        totalSkipped += r.value.value.manualSkipped;
      } else {
        failures++;
        const day    = r.status === 'fulfilled' ? r.value.day    : 'unknown';
        const reason = r.status === 'fulfilled' && !r.value.ok ? r.value.reason : 'Promise rejected';
        failureDetails.push({ day, reason });
      }
    }

    setWeekLinkResult({
      daysLinked:         7 - failures,
      totalLinksWritten:  totalLinks,
      totalManualSkipped: totalSkipped,
      failures,
      failureDetails:     failureDetails.length > 0 ? failureDetails : undefined,
    });
    setWeekLinking(false);
    setWeekProgress(null);
    setRefreshTick((t) => t + 1);
  }

  // Window: 6h before day start → 6h after day end, in UTC.
  const fetchWindow = useMemo(() => {
    const startEpoch = parseNaiveIsoInTz(`${dayKey}T00:00:00`, tz);
    const endEpoch   = parseNaiveIsoInTz(`${dayKey}T23:59:59`, tz);
    const padMs = 6 * 60 * 60 * 1000;
    return {
      from: new Date(startEpoch - padMs).toISOString(),
      to:   new Date(endEpoch   + padMs).toISOString(),
    };
  }, [dayKey, tz]);

  useEffect(() => {
    if (effectiveAssetId == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Don't clear selection on refresh — preserves the open side panel
    // after a link edit. Reset only on truck/day change.
    railway.getAssetTimeline(effectiveAssetId, fetchWindow.from, fetchWindow.to)
      .then((res) => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [effectiveAssetId, fetchWindow.from, fetchWindow.to, refreshTick]);

  // Fetch the week-summary whenever the asset or week changes. The
  // single useState + cancelled-guard pattern matches the timeline
  // fetch above — stale responses for an earlier week don't overwrite.
  const weekStartKey = useMemo(() => weekStartFor(dayKey), [dayKey]);
  useEffect(() => {
    if (effectiveAssetId == null) return;
    let cancelled = false;
    setWeekSummaryLoading(true);
    railway.getWeekSummary(effectiveAssetId, weekStartKey, tz)
      .then((res) => { if (!cancelled) { setWeekSummary(res); setWeekSummaryLoading(false); } })
      .catch(() => { if (!cancelled) setWeekSummaryLoading(false); });
    return () => { cancelled = true; };
  }, [effectiveAssetId, weekStartKey, tz, refreshTick]);

  // Reset selection when switching truck or day so the panel doesn't
  // hang around showing a stale row from the previous view.
  useEffect(() => {
    setSelection(null);
  }, [effectiveAssetId, dayKey]);

  // Keyboard click-through across the day's trips when a cluster is
  // selected — mirrors AssetDetailModal's ← / → shortcuts. Wires to
  // the same setSelection used by the in-panel prev/next buttons so
  // there's only one nav code path.
  useEffect(() => {
    if (selection?.kind !== 'cluster') return;
    const handler = (e: KeyboardEvent) => {
      // Don't hijack arrow keys while a text input or date input is focused.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Same-tick re-read of visibleClusters via closure — only the
      // currently-selected cluster id matters for finding the index.
      const idx = visibleClustersRef.current.findIndex((c) => c.id === selection.cluster.id);
      if (idx < 0) return;
      const nextIdx = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= visibleClustersRef.current.length) return;
      const next = visibleClustersRef.current[nextIdx];
      const linkFor = (cl: TimelineCluster): TimelineLink | undefined => {
        for (const m of cl.members) {
          const l = linkByMovementIdRef.current.get(m.id);
          if (l) return l;
        }
        return undefined;
      };
      e.preventDefault();
      setSelection({ kind: 'cluster', cluster: next, link: linkFor(next) });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection]);
  // Refs so the keyboard handler sees the freshest clusters / link map
  // without having to subscribe and recreate itself on every change.
  const visibleClustersRef     = useRef<TimelineCluster[]>([]);
  const linkByMovementIdRef    = useRef<Map<string, TimelineLink>>(new Map());

  const linkByMovementId = useMemo(() => {
    const m = new Map<string, TimelineLink>();
    for (const l of data?.links ?? []) m.set(l.movementId, l);
    return m;
  }, [data?.links]);

  const eventById = useMemo(() => {
    const m = new Map<string, TimelineEvent>();
    for (const e of data?.events ?? []) m.set(e.id, e);
    return m;
  }, [data?.events]);

  // Visible items for the current day.
  const visibleEvents = useMemo(() => {
    return (data?.events ?? []).filter((e) => {
      const sk = naiveDateKey(e.start);
      const ek = naiveDateKey(e.end);
      return sk <= dayKey && ek >= dayKey;
    });
  }, [data?.events, dayKey]);

  const visibleMovements = useMemo(() => {
    return (data?.movements ?? []).filter((m) => {
      const sk = utcDateKeyInTz(m.startTime, tz);
      const ek = m.endTime ? utcDateKeyInTz(m.endTime, tz) : sk;
      return sk <= dayKey && ek >= dayKey;
    });
  }, [data?.movements, dayKey, tz]);

  // Coalesce raw Motive fragments into logical-trip clusters using the
  // SAME rules the calendar's Movements column uses (see
  // clusterTimelineMovements). After this, sub-mile yard noise is gone,
  // adjacent short fragments of one trip are merged, and the displayed
  // unit matches what the AI auto-link reasons about.
  const visibleClusters = useMemo(
    () => clusterTimelineMovements(visibleMovements),
    [visibleMovements],
  );

  // Dwell chips fill the GAPS between consecutive clusters — that's
  // where the truck is parked at a yard / customer / hotel. Matched
  // against saved_locations so addresses resolve to known names.
  const visibleDwells = useMemo(
    () => computeDwells(visibleClusters, savedLocations),
    [visibleClusters, savedLocations],
  );

  // Mirror to refs so the global keydown handler reads the freshest
  // clusters + link map without rebinding on every render.
  useEffect(() => { visibleClustersRef.current  = visibleClusters;  }, [visibleClusters]);
  useEffect(() => { linkByMovementIdRef.current = linkByMovementId; }, [linkByMovementId]);

  // A cluster's link is the link on any of its members — the AI writes
  // identical links to every member, so the first one with a link wins.
  // Declared HERE (above visibleProfitability) because the useMemo
  // below captures it via closure — TDZ-safe ordering matters with
  // const arrow functions (they don't hoist like `function` decls).
  const linkForCluster = (cl: TimelineCluster): TimelineLink | undefined => {
    for (const m of cl.members) {
      const l = linkByMovementId.get(m.id);
      if (l) return l;
    }
    return undefined;
  };

  // Revenue analysis filtered to the *visible* day.
  //
  // The server computes profitability over every event in the fetch
  // window (which is padded by ±6h so boundary movements get caught).
  // That means a Wednesday 4am load shows up in Tuesday's profitability
  // block — wrong from the dispatcher's "what did this day earn?" lens.
  // We refilter to events that actually intersect dayKey (same filter
  // visibleEvents uses) and rebuild the day rollup. The movement-side
  // stats (yard return / unattributed / total miles) get re-derived
  // from visibleClusters so they reflect only this day's driving.
  const visibleProfitability = useMemo((): TimelineProfitability | null => {
    if (!data?.profitability) return null;
    const visibleEventIds = new Set(visibleEvents.map((e) => e.id));

    const loads = data.profitability.loads.filter((l) => visibleEventIds.has(l.eventId));

    const totalRevenue    = loads.reduce((s, l) => s + l.revenue, 0);
    const totalDriverPay  = loads.reduce((s, l) => s + l.driverPay, 0);
    const loadedMiles     = loads.reduce((s, l) => s + l.loadedMiles, 0);
    const inboundDhMiles  = loads.reduce((s, l) => s + l.inboundDhMiles, 0);
    const attributedMiles = loadedMiles + inboundDhMiles;

    // Re-derive yard-return + unattributed miles by walking THIS day's
    // visible clusters. A movement linked to a load OUTSIDE the visible
    // day (e.g. Tue late-night deadhead toward Wed's pickup) falls into
    // unattributed for this day — physically the driving happened today
    // but it doesn't belong to any load on today's books.
    let yardReturnMiles   = 0;
    let unattributedMiles = 0;
    for (const cl of visibleClusters) {
      const link = linkForCluster(cl);
      const miles = cl.miles;
      if (!link) { unattributedMiles += miles; continue; }
      if (link.role === 'loaded' && link.loadedEventId && visibleEventIds.has(link.loadedEventId)) {
        // already aggregated through the load's loadedMiles
      } else if (link.role === 'transition' && link.toEventId && visibleEventIds.has(link.toEventId)) {
        // already aggregated through the load's inboundDhMiles
      } else if (link.role === 'transition' && link.fromEventId && !link.toEventId) {
        yardReturnMiles += miles;
      } else {
        unattributedMiles += miles;
      }
    }

    const totalMiles = attributedMiles + yardReturnMiles + unattributedMiles;

    return {
      loads,
      day: {
        totalRevenue,
        totalDriverPay,
        netToTruck:        totalRevenue - totalDriverPay,
        loadedMiles,
        inboundDhMiles,
        attributedMiles,
        yardReturnMiles,
        unattributedMiles,
        totalMiles,
        dayRpm:            attributedMiles > 0 ? totalRevenue / attributedMiles : null,
        dayRpmTotal:       totalMiles      > 0 ? totalRevenue / totalMiles      : null,
        deadheadPctOfDay:  totalMiles      > 0 ? (inboundDhMiles + yardReturnMiles) / totalMiles : null,
      },
    };
  // linkForCluster reads linkByMovementId; safe to depend on the map.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.profitability, visibleEvents, visibleClusters, linkByMovementId]);

  const asset = data?.asset;

  return (
    <AppShell>
      <div className="max-w-[1800px] mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <Link
            href="/calendar"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
          >
            <ArrowLeft size={16} />
          </Link>
          <Truck size={20} style={{ color: assetColor }} />
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>
            Timeline
          </h1>

          {/* Truck picker — pre-filled from URL, changeable inline. */}
          <div className="flex items-center gap-2 ml-2 px-2 py-1 rounded"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: assetColor }} />
            <select
              value={effectiveAssetId ?? ''}
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) switchAsset(v); }}
              className="text-[14px] font-semibold bg-transparent border-0 outline-none cursor-pointer"
              style={{ color: 'var(--gc-text-1)' }}
            >
              {truckOptions.length === 0 ? <option value="">No trucks</option> : null}
              {truckOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.unit ? ` · #${a.unit}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Week selector — list of started weeks (Sat → Fri). Picking
              one sets dayKey to today (current week) or to that week's
              Saturday. The WeekStrip below + the day cards inside it
              handle finer navigation. */}
          <div className="flex items-center gap-2 px-2 py-1 rounded"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
            <CalendarIcon size={12} style={{ color: 'var(--gc-text-3)' }} />
            <select
              value={weekStartFor(dayKey)}
              onChange={(e) => selectWeek(e.target.value)}
              className="text-[13px] font-semibold bg-transparent border-0 outline-none cursor-pointer"
              style={{ color: 'var(--gc-text-1)' }}
            >
              {startedWeeks.map((w) => (
                <option key={w.weekStart} value={w.weekStart}>{w.label}</option>
              ))}
            </select>
          </div>

          {/* Header actions */}
          {effectiveAssetId != null ? (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={runAutoLink}
                disabled={autoLinking || weekLinking}
                className="text-[12px] font-semibold px-3 py-1.5 rounded flex items-center gap-1.5"
                style={{
                  background: (autoLinking || weekLinking) ? 'var(--gc-surface-2)' : 'var(--gc-purple, #a142f4)',
                  color: (autoLinking || weekLinking) ? 'var(--gc-text-3)' : '#fff',
                }}
                title="Claude classifies each movement on this day's window (skips manually-linked rows)"
              >
                {autoLinking ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {autoLinking ? 'Linking…' : 'Re-link day'}
              </button>
              <button
                onClick={runWeekAutoLink}
                disabled={autoLinking || weekLinking}
                className="text-[12px] font-semibold px-3 py-1.5 rounded flex items-center gap-1.5"
                style={{
                  background: (autoLinking || weekLinking) ? 'var(--gc-surface-2)' : 'var(--gc-purple, #a142f4)',
                  color: (autoLinking || weekLinking) ? 'var(--gc-text-3)' : '#fff',
                  opacity: weekLinking ? 1 : 0.9,
                }}
                title="Fires AI classification for every day in this Sat → Fri week in parallel"
              >
                {weekLinking ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {weekLinking
                  ? `Linking week… ${weekProgress?.done ?? 0} / ${weekProgress?.total ?? 7}`
                  : 'Re-link week'}
              </button>
              <button
                onClick={() => setShowCreateMovement(true)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded flex items-center gap-1.5"
                style={{ background: 'var(--gc-blue)', color: '#fff' }}
              >
                <Plus size={14} /> Add manual movement
              </button>
            </div>
          ) : null}
        </div>

        {/* Auto-link result banner */}
        {autoLinkResult ? (
          <div
            className="mb-3 px-3 py-2 rounded-lg text-[12px] flex items-center gap-2"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
          >
            <Sparkles size={14} style={{ color: '#a142f4' }} />
            <span>
              {autoLinkResult.message ?? `Wrote ${autoLinkResult.linksWritten} link${autoLinkResult.linksWritten === 1 ? '' : 's'}`}
              {autoLinkResult.manualSkipped > 0 ? `; skipped ${autoLinkResult.manualSkipped} manual` : ''}
              {' '}({autoLinkResult.totalMovements} movement{autoLinkResult.totalMovements === 1 ? '' : 's'} in window)
            </span>
            <button
              onClick={() => setAutoLinkResult(null)}
              className="ml-auto w-5 h-5 rounded flex items-center justify-center hover:bg-black/5"
            >
              <X size={12} />
            </button>
          </div>
        ) : null}

        {/* Week-link result banner */}
        {weekLinkResult ? (
          <div
            className="mb-3 px-3 py-2 rounded-lg text-[12px]"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
          >
            <div className="flex items-center gap-2">
              <Sparkles size={14} style={{ color: '#a142f4' }} />
              <span>
                Week relink: {weekLinkResult.daysLinked} of 7 days · {weekLinkResult.totalLinksWritten} links written
                {weekLinkResult.totalManualSkipped > 0 ? `; ${weekLinkResult.totalManualSkipped} manual skipped` : ''}
                {weekLinkResult.failures > 0 ? `; ${weekLinkResult.failures} day(s) failed` : ''}
              </span>
              <button
                onClick={() => setWeekLinkResult(null)}
                className="ml-auto w-5 h-5 rounded flex items-center justify-center hover:bg-black/5"
              >
                <X size={12} />
              </button>
            </div>
            {weekLinkResult.failureDetails && weekLinkResult.failureDetails.length > 0 ? (
              <details className="mt-2 ml-5">
                <summary className="cursor-pointer text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  Show {weekLinkResult.failureDetails.length} failure detail{weekLinkResult.failureDetails.length === 1 ? '' : 's'}
                </summary>
                <div className="mt-1 space-y-0.5 text-[11px] font-mono" style={{ color: 'var(--gc-text-2)' }}>
                  {weekLinkResult.failureDetails.map((f, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="shrink-0" style={{ color: 'var(--gc-text-3)' }}>{f.day}</span>
                      <span className="break-all">{f.reason}</span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {/* Week strip — primary day-level navigation. Clicking a day
            card sets dayKey; clicking the Week-total card flips
            weekTotalSelected and the per-day analysis swaps to the
            week-aggregate panel. */}
        {weekSummary ? (
          <WeekStrip
            summary={weekSummary}
            activeDayKey={dayKey}
            weekTotalSelected={weekTotalSelected}
            todayKey={todayKey}
            assetColor={assetColor}
            onSelectDay={(k) => {
              setDayKey(k);
              setWeekTotalSelected(false);
            }}
            onSelectWeekTotal={() => setWeekTotalSelected(true)}
            fs={fs}
          />
        ) : weekSummaryLoading ? (
          <div className="mt-1 mb-3 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            Loading week summary…
          </div>
        ) : null}

        {/* Week-aggregate analysis — replaces per-day Revenue Analysis
            + the entire timeline body when the user zooms out. */}
        {weekTotalSelected && weekSummary ? (
          <WeekRevenuePanel
            summary={weekSummary}
            assetColor={assetColor}
            onSelectDay={(k) => {
              setDayKey(k);
              setWeekTotalSelected(false);
            }}
            fs={fs}
          />
        ) : visibleProfitability && visibleProfitability.loads.length > 0 ? (
          <RevenueAnalysisStrip profitability={visibleProfitability} assetColor={assetColor} fs={fs} />
        ) : null}

        {/* Body: schedule/actual columns + map. Hidden in week-aggregate
            mode since the day-scoped layout doesn't have a coherent
            week-scope rendering. */}
        {weekTotalSelected ? null : (
          <>
        {/* items-stretch (default) lets the right column match the
            left column's full natural height — the calendar grid
            anchors the height, the map + details fill the same span. */}
        <div className="flex gap-3 mt-3">
          {/* Schedule + Actual columns — flex-1 so they grow as the
              viewport widens. min-w-[480px] keeps them legible on
              smaller screens. Time ruler 44px to claw back chip width. */}
          <div className="flex-1 min-w-[480px]">
            {loading ? (
              <div className="py-20 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
                Loading timeline…
              </div>
            ) : error ? (
              <div className="py-20 text-center text-sm" style={{ color: 'var(--gc-red)' }}>
                {error}
              </div>
            ) : (
              <div
                className="rounded-lg overflow-hidden"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
              >
                <div className="grid grid-cols-[44px_1fr_1fr] border-b" style={{ borderColor: 'var(--gc-border)' }}>
                  <div className="px-1.5 py-2 uppercase font-semibold tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
                    Time
                  </div>
                  <div className="px-2 py-2 uppercase font-semibold tracking-wider border-l" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border)', fontSize: fs(10) }}>
                    Scheduled · {visibleEvents.length}
                  </div>
                  <div className="px-2 py-2 uppercase font-semibold tracking-wider border-l" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border)', fontSize: fs(10) }}>
                    Actual · {visibleClusters.length}
                  </div>
                </div>

                <div className="grid grid-cols-[44px_1fr_1fr] relative" style={{ height: TOTAL_HEIGHT }}>
                  <div className="relative" style={{ background: 'var(--gc-surface-2)' }}>
                    {Array.from({ length: 24 }, (_, h) => {
                      const hh   = h % 12 || 12;
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      return (
                        <div
                          key={h}
                          className="absolute left-0 right-0 px-1.5"
                          style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                        >
                          <span className="font-medium" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
                            {hh}{h === 0 ? '' : ` ${ampm}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="relative border-l" style={{ borderColor: 'var(--gc-border)' }}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute left-0 right-0"
                        style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                      />
                    ))}
                    {visibleEvents.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
                        No scheduled events
                      </div>
                    ) : (
                      visibleEvents.map((e) => (
                        <EventBlock
                          key={e.id}
                          event={e}
                          dayKey={dayKey}
                          color={assetColor}
                          fs={fs}
                          onClick={() => setSelection({ kind: 'event', event: e })}
                          isSelected={selection?.kind === 'event' && selection.event.id === e.id}
                        />
                      ))
                    )}
                    <NowLine dayKey={dayKey} tz={tz} />
                  </div>

                  <div className="relative border-l" style={{ borderColor: 'var(--gc-border)' }}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute left-0 right-0"
                        style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                      />
                    ))}
                    {visibleClusters.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
                        No movements
                      </div>
                    ) : (
                      <>
                        {visibleDwells.map((d) => (
                          <DwellBlock key={d.id} dwell={d} dayKey={dayKey} tz={tz} fs={fs} />
                        ))}
                        {visibleClusters.map((cl) => {
                          const link = linkForCluster(cl);
                          return (
                            <ClusterBlock
                              key={cl.id}
                              cluster={cl}
                              link={link}
                              eventLookup={eventById}
                              dayKey={dayKey}
                              tz={tz}
                              fs={fs}
                              onClick={() => setSelection({ kind: 'cluster', cluster: cl, link })}
                              isSelected={selection?.kind === 'cluster' && selection.cluster.id === cl.id}
                            />
                          );
                        })}
                      </>
                    )}
                    <NowLine dayKey={dayKey} tz={tz} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Map + detail column — RIGHT side. Map on TOP with the
              click-through footer overlay; details below. */}
          <div className="flex-1 min-w-[480px] flex flex-col gap-3">
            <TimelineMap
              clusters={visibleClusters}
              linkByMovementId={linkByMovementId}
              eventLookup={eventById}
              tz={tz}
              selection={(() => {
                if (!selection) return null;
                if (selection.kind === 'event') return { kind: 'event', eventId: selection.event.id };
                return { kind: 'cluster', clusterId: selection.cluster.id };
              })()}
              assetColor={assetColor}
              height={520}
              onSelectCluster={(clusterId) => {
                const cl = visibleClusters.find((c) => c.id === clusterId);
                if (cl) setSelection({ kind: 'cluster', cluster: cl, link: linkForCluster(cl) });
              }}
              onClearSelection={() => setSelection(null)}
            />

            <div
              className="rounded-lg overflow-hidden flex flex-col flex-1 min-h-0"
              style={{
                background: 'var(--gc-surface)',
                border: '1px solid var(--gc-border)',
              }}
            >
              <DetailPanel
                selection={selection}
                tz={tz}
                assetColor={assetColor}
                events={data?.events ?? []}
                eventLookup={eventById}
                clusters={visibleClusters}
                linkByMovementId={linkByMovementId}
                fs={fs}
                onClose={() => setSelection(null)}
                onMutated={() => setRefreshTick((t) => t + 1)}
                onSelect={(s) => setSelection(s)}
              />
            </div>
          </div>
        </div>

          </>
        )}

      </div>

      {/* Manual movement create modal */}
      {showCreateMovement && effectiveAssetId != null ? (
        <CreateMovementModal
          assetId={effectiveAssetId}
          dayKey={dayKey}
          tz={tz}
          events={data?.events ?? []}
          onClose={() => setShowCreateMovement(false)}
          onCreated={() => {
            setShowCreateMovement(false);
            setRefreshTick((t) => t + 1);
          }}
        />
      ) : null}
    </AppShell>
  );
}

// ── EventBlock ─────────────────────────────────────────────────────────

// EventBlock — styled 1:1 with CalendarEvent: asset-color background,
// white extrabold title flush with the top, supporting fields stacked
// underneath in white at 85% opacity. Mirrors the calendar's chip so
// the timeline reads as the same visual language.
function EventBlock({
  event, dayKey, color, fs, onClick, isSelected,
}: {
  event: TimelineEvent;
  dayKey: string;
  color: string;
  fs: (px: number) => number;
  onClick: () => void;
  isSelected: boolean;
}) {
  const pos = positionForEvent(event.start, event.end, dayKey);
  const isNonRev = event.eventKind === 'non_revenue';
  const fsTitle = fs(11);
  const fsField = fs(10);

  // Same set + render order the calendar's default field config uses:
  // time → load# → $price → loaded miles. Hidden if the chip isn't tall
  // enough to fit (same "minHeight per row" math as CalendarEvent).
  const fields: string[] = [];
  const t1 = event.start.split('T')[1]?.slice(0, 5);
  const t2 = event.end.split('T')[1]?.slice(0, 5);
  if (t1 && t2) fields.push(`${shortTime(t1)}–${shortTime(t2)}`);
  if (event.loadNum)            fields.push(`#${event.loadNum}`);
  // Show total billable when it differs from linehaul (i.e., there's at
  // least one billable accessorial); else show bare linehaul. The chip
  // text only carries one money number to stay readable.
  if ((event.totalBillable ?? event.loadPrice) != null) {
    fields.push(`$${(event.totalBillable ?? event.loadPrice!).toLocaleString()}`);
  }
  if (event.loadedMiles != null) fields.push(`${event.loadedMiles.toLocaleString()} mi`);
  if (event.driverName)         fields.push(event.driverName);

  return (
    <div
      onClick={onClick}
      className="absolute rounded overflow-hidden z-10"
      style={{
        top:        pos.topPx,
        height:     Math.max(22, pos.heightPx - 2),
        left:       2,
        right:      2,
        background: isNonRev ? '#fef7e0' : color,
        border:     `2px solid ${isNonRev ? '#f9ab00' : color}`,
        boxShadow:  isSelected ? '0 0 0 2px var(--gc-blue)' : undefined,
        cursor:     'pointer',
        userSelect: 'none',
      }}
    >
      <div className="px-1.5 pt-0.5 flex flex-col h-full overflow-hidden">
        <div className="flex items-start gap-1">
          <div
            className="font-extrabold leading-tight break-words min-w-0 flex-1"
            style={{ color: isNonRev ? '#202124' : '#ffffff', fontSize: fsTitle }}
          >
            {event.title ?? (isNonRev ? event.nonRevenueType ?? 'Non-revenue' : 'Untitled')}
          </div>
          {event.relayRole ? (
            <span
              className="font-extrabold uppercase tracking-wider px-1 rounded flex-shrink-0"
              style={{
                fontSize:   fs(9),
                color:      '#ffffff',
                background: 'rgba(0,0,0,0.25)',
                marginTop:  1,
              }}
              title={event.relayRole === 'pickup' ? 'Pickup leg of a relay load' : 'Delivery leg of a relay load'}
            >
              {event.relayRole === 'pickup' ? 'PU LEG' : 'DEL LEG'}
            </span>
          ) : null}
        </div>
        {fields.map((line, i) => {
          // Mirror CalendarEvent's stop-rendering-when-too-tall logic:
          // ~14px per line plus 20px for the title.
          const minHeight = 20 + i * 14;
          if (pos.heightPx <= minHeight) return null;
          return (
            <div
              key={i}
              className="font-medium leading-tight truncate"
              style={{
                color:    isNonRev ? 'rgba(32,33,36,0.85)' : 'rgba(255,255,255,0.85)',
                fontSize: fsField,
              }}
            >
              {line}
            </div>
          );
        })}
      </div>
      {pos.spansBefore || pos.spansAfter ? (
        <div
          className="absolute right-1 bottom-1 uppercase tracking-wider"
          style={{
            fontSize: fs(9),
            color:    isNonRev ? 'rgba(32,33,36,0.7)' : 'rgba(255,255,255,0.75)',
          }}
        >
          {pos.spansBefore ? 'starts earlier' : ''}{pos.spansBefore && pos.spansAfter ? ' · ' : ''}{pos.spansAfter ? 'continues' : ''}
        </div>
      ) : null}
    </div>
  );
}

/** Short 12h time like the calendar's "3p" / "3:45p". */
function shortTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const h12  = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

/** Filter an event's stops to only those relevant to its relay leg.
 *  Whole loads (no relayRole) show every stop. Pickup legs show pickup
 *  stops; delivery legs show delivery / drop / drop_hook stops. */
function stopsForLeg(event: TimelineEvent): TimelineEvent['stops'] {
  if (!event.relayRole) return event.stops;
  if (event.relayRole === 'pickup') {
    return event.stops.filter((s) => s.type === 'pickup');
  }
  return event.stops.filter(
    (s) => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook',
  );
}

function stopLabel(type: string): string {
  switch (type) {
    case 'pickup':    return 'Pickup';
    case 'delivery':  return 'Delivery';
    case 'drop':      return 'Drop';
    case 'drop_hook': return 'Drop & hook';
    case 'stop':      return 'Stop';
    default:          return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

// ── ClusterBlock ──────────────────────────────────────────────────────
//
// Renders one chip per logical trip (coalesced cluster of Motive
// fragments). Uses displayEndTime so 5-min sub-trips still hit the
// 30-min visual minimum without overlapping the next cluster.

// ClusterBlock — chip styling: role-colored background with a 2px
// wide border in the same accent (no separate left stripe). Two rows
// of content top-aligned: the load/linked title on top, then time +
// miles + origin→destination INLINE on the second row. Matches the
// calendar's chip language (wide border, top-aligned text).
function ClusterBlock({
  cluster, link, eventLookup, dayKey, tz, fs, onClick, isSelected,
}: {
  cluster: TimelineCluster;
  link: TimelineLink | undefined;
  eventLookup: Map<string, TimelineEvent>;
  dayKey: string;
  tz: string;
  fs: (px: number) => number;
  onClick: () => void;
  isSelected: boolean;
}) {
  const pos = positionForMovement(cluster.startTime, cluster.displayEndTime, dayKey, tz);
  const role = link ? ROLE_COLORS[link.role] : null;
  const isMed  = pos.heightPx >= 32;            // enough for a 2nd row

  const loadedEv  = link?.loadedEventId ? eventLookup.get(link.loadedEventId) : null;
  const fromEv    = link?.fromEventId   ? eventLookup.get(link.fromEventId)   : null;
  const toEv      = link?.toEventId     ? eventLookup.get(link.toEventId)     : null;

  const palette = role
    ? { bg: role.bg, fg: role.fg, border: role.fg, label: role.label }
    : { bg: '#ffffff', fg: 'var(--gc-text-1)', border: 'var(--gc-border)', label: 'Unlinked' };

  // Headline: the load this trip is doing. Inline-only on the title row.
  const headline: string = (() => {
    if (!link) return 'Unlinked';
    if (link.role === 'loaded')     return loadedEv?.title ?? 'Loaded';
    if (link.role === 'transition') return `${fromEv?.title ?? 'yard'} → ${toEv?.title ?? 'yard'}`;
    if (link.role === 'dwell')      return `At ${loadedEv?.title ?? 'stop'}`;
    return palette.label;
  })();

  const originCity = (cluster.origin ?? '').split(',')[0].trim();
  const destCity   = (cluster.destination ?? '').split(',')[0].trim();
  const route = (originCity || destCity)
    ? `${originCity || '—'} → ${destCity || '—'}`
    : '';

  return (
    <div
      onClick={onClick}
      className="absolute rounded overflow-hidden z-[6]"
      style={{
        top:         pos.topPx,
        height:      pos.heightPx,
        left:        2,
        right:       2,
        background:  palette.bg,
        border:      `2px solid ${palette.border}`,
        boxShadow:   isSelected ? '0 0 0 2px var(--gc-blue)' : undefined,
        cursor:      'pointer',
        userSelect:  'none',
      }}
    >
      <div className="px-1.5 pt-0.5 flex flex-col h-full overflow-hidden">
        {/* Top row: headline (load name) + role badge on the right.
            Same flex-start alignment the calendar uses. */}
        <div className="flex items-start gap-1">
          <div
            className="font-extrabold leading-tight break-words min-w-0 flex-1"
            style={{ color: palette.fg, fontSize: fs(11) }}
            title={headline}
          >
            {headline}
          </div>
          <span
            className="font-semibold uppercase tracking-wide flex-shrink-0 px-1 rounded"
            style={{
              fontSize:   fs(9),
              color:      palette.fg,
              background: 'rgba(255,255,255,0.5)',
              marginTop:  1,
            }}
          >
            {palette.label}
          </span>
        </div>

        {/* Second row — time, miles, AND origin→destination INLINE. */}
        {isMed ? (
          <div
            className="font-medium leading-tight truncate"
            style={{ color: palette.fg, opacity: 0.85, fontSize: fs(10) }}
          >
            <span className="tabular-nums">
              {fmtUtcTimeInTz(cluster.startTime, tz)}
              {cluster.endTime ? `–${fmtUtcTimeInTz(cluster.endTime, tz)}` : ''}
            </span>
            <span className="tabular-nums">{' · '}{cluster.miles.toFixed(1)}mi</span>
            {route ? <>{' · '}{route}</> : null}
            {cluster.members.length > 1 ? (
              <span style={{ opacity: 0.75 }}>{' · '}×{cluster.members.length}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── DwellBlock ────────────────────────────────────────────────────────
//
// Rendered between two consecutive clusters when the truck has been
// stationary for >= 15min. Saved-location matches render in blue
// ("At Yard", "At ACME DC"); unmatched dwells render in a softer gray
// with the closest available raw city string.

function DwellBlock({
  dwell, dayKey, tz, fs,
}: {
  dwell: TimelineDwell;
  dayKey: string;
  tz: string;
  fs: (px: number) => number;
}) {
  const pos = positionForMovement(dwell.startTime, dwell.endTime, dayKey, tz);
  if (pos.heightPx < 14) return null;

  const isSaved = dwell.savedLocation != null;
  const palette = isSaved
    ? { bg: '#e8f0fe', fg: '#1967d2', border: '#1967d2' }
    : { bg: '#f1f3f4', fg: '#5f6368', border: '#9aa0a6' };

  const durMs = new Date(dwell.endTime).getTime() - new Date(dwell.startTime).getTime();
  const durMin = Math.round(durMs / 60_000);
  const durLabel = durMin >= 60
    ? `${Math.floor(durMin / 60)}h${durMin % 60 ? ` ${durMin % 60}m` : ''}`
    : `${durMin}m`;

  const label = dwell.savedLocation?.name
    ?? (dwell.location ? (dwell.location.split(',')[1]?.trim() || dwell.location.split(',')[0]) : 'Dwell');

  return (
    <div
      className="absolute rounded overflow-hidden flex items-center gap-1.5 px-1.5"
      style={{
        top:           pos.topPx,
        height:        pos.heightPx,
        left:          2,
        right:         2,
        background:    palette.bg,
        border:        `2px solid ${palette.border}`,
        color:         palette.fg,
        fontSize:      fs(10),
        pointerEvents: 'none',
      }}
      title={`${isSaved ? 'At ' : 'Dwell at '}${label} · ${durLabel}`}
    >
      <MapPin size={Math.max(8, fs(10))} style={{ flexShrink: 0 }} />
      <span className="font-semibold truncate">
        {isSaved ? 'At ' : ''}{label}
      </span>
      <span className="ml-auto tabular-nums flex-shrink-0" style={{ fontSize: fs(9), opacity: 0.75 }}>
        {durLabel}
      </span>
    </div>
  );
}

// ── Detail panel (inline right-side column) ──────────────────────────
//
// Always rendered as part of the page grid (no longer a fixed overlay).
// Accepts a nullable selection and shows an empty state when nothing is
// selected so the right column doesn't pop in and out as the user clicks
// around.

function DetailPanel({
  selection, tz, assetColor, events, eventLookup, clusters, linkByMovementId,
  fs, onClose, onMutated, onSelect,
}: {
  selection: Selection;
  tz: string;
  assetColor: string;
  events: TimelineEvent[];
  eventLookup: Map<string, TimelineEvent>;
  clusters: TimelineCluster[];
  linkByMovementId: Map<string, TimelineLink>;
  fs: (px: number) => number;
  onClose: () => void;
  onMutated: () => void;
  /** Jump to a different selection — used by the in-panel "linked load"
   *  chips so the user can click through the graph without leaving the
   *  detail column. */
  onSelect: (s: Selection) => void;
}) {
  return (
    <>
      <div
        className="flex items-center gap-1 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)' }}
      >
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(12) }}>
          {selection == null
            ? 'Details'
            : selection.kind === 'event' ? 'Scheduled event' : 'Trip'}
        </span>

        {/* Prev/next nav moved to the map's bottom-overlay footer so
            the header here stays compact. Keyboard ← / → still handled
            at the page level. */}
        <span className="ml-auto" />
        {selection != null ? (
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center hover:bg-black/5" title="Clear selection">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <div className="p-4 space-y-3 overflow-y-auto" style={{ flex: 1 }}>
        {selection == null ? (
          <div className="text-center py-12" style={{ color: 'var(--gc-text-3)', fontSize: fs(12) }}>
            <div className="mb-1 font-semibold uppercase tracking-wider" style={{ fontSize: fs(10) }}>No selection</div>
            <div>Click a scheduled event or a trip in the timeline to see details and edit its link here.</div>
          </div>
        ) : selection.kind === 'event' ? (
          <EventDetail
            event={selection.event}
            color={assetColor}
            clusters={clusters}
            linkByMovementId={linkByMovementId}
            tz={tz}
            fs={fs}
            onSelect={onSelect}
          />
        ) : (
          <ClusterDetail
            cluster={selection.cluster}
            link={selection.link}
            tz={tz}
            events={events}
            eventLookup={eventLookup}
            fs={fs}
            onMutated={onMutated}
            onSelect={onSelect}
          />
        )}
      </div>
    </>
  );
}

function EventDetail({
  event, color, clusters, linkByMovementId, tz, fs, onSelect,
}: {
  event: TimelineEvent;
  color: string;
  clusters: TimelineCluster[];
  linkByMovementId: Map<string, TimelineLink>;
  tz: string;
  fs: (px: number) => number;
  onSelect: (s: Selection) => void;
}) {
  const isNonRev = event.eventKind === 'non_revenue';

  // Find every visible cluster whose link references THIS event — so
  // the panel can show "this load was driven by these N trips" and
  // jump to any of them on click. Captures all three roles where this
  // event might appear (loaded, transition.from, transition.to).
  const linkedClusters = useMemo(() => {
    return clusters
      .map((cl) => {
        for (const m of cl.members) {
          const l = linkByMovementId.get(m.id);
          if (!l) continue;
          if (
            l.loadedEventId === event.id ||
            l.fromEventId   === event.id ||
            l.toEventId     === event.id
          ) {
            return { cluster: cl, link: l };
          }
        }
        return null;
      })
      .filter((x): x is { cluster: TimelineCluster; link: TimelineLink } => x !== null);
  }, [clusters, linkByMovementId, event.id]);

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ background: isNonRev ? '#f9ab00' : color }} />
        <h2 className="font-semibold flex-1 min-w-0" style={{ color: 'var(--gc-text-1)', fontSize: fs(16) }}>
          {event.title ?? (isNonRev ? event.nonRevenueType ?? 'Non-revenue' : 'Untitled')}
        </h2>
        {event.relayRole ? (
          <span
            className="uppercase tracking-wider font-bold px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              fontSize:   fs(10),
              background: color,
              color:      '#ffffff',
            }}
            title={event.relayRole === 'pickup' ? 'Pickup leg of a relay load' : 'Delivery leg of a relay load'}
          >
            {event.relayRole === 'pickup' ? 'Pickup leg' : 'Delivery leg'}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2" style={{ color: 'var(--gc-text-2)', fontSize: fs(12) }}>
        <Clock size={Math.max(10, fs(12))} />
        <span className="tabular-nums">{fmtNaiveTime(event.start)} – {fmtNaiveTime(event.end)}</span>
        {event.status ? (
          <span className="ml-auto uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)', fontSize: fs(10) }}>
            {event.status}
          </span>
        ) : null}
      </div>
      {event.driverName ? (
        <div style={{ color: 'var(--gc-text-2)', fontSize: fs(12) }}>
          Driver: <span style={{ color: 'var(--gc-text-1)' }}>{event.driverName}</span>
        </div>
      ) : null}
      {(event.totalBillable ?? event.loadPrice) != null ? (
        <div style={{ color: 'var(--gc-text-2)', fontSize: fs(12) }}>
          {/* Detail panel — "Revenue" line shows total billable when it
              differs from linehaul, tooltipped with the breakdown. */}
          Revenue: <span className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}
            title={event.totalBillable != null && event.loadPrice != null && event.totalBillable !== event.loadPrice
              ? `Linehaul $${event.loadPrice.toLocaleString('en-US')} + accessorials = $${event.totalBillable.toLocaleString('en-US')}`
              : undefined}>
            ${(event.totalBillable ?? event.loadPrice!).toLocaleString('en-US')}
          </span>
          {event.driverPay != null ? (
            <>
              {' '}· Pay: <span className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                ${event.driverPay.toLocaleString('en-US')}
              </span>
            </>
          ) : null}
          {event.loadedMiles != null ? (
            <>
              {' '}· Quoted: <span className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                {event.loadedMiles.toFixed(0)}mi
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Linked trips — clickable chips that pivot the panel to the
          cluster. This is the back-half of the cross-column nav: from
          a load to "what trips are doing it." */}
      {linkedClusters.length > 0 ? (
        <div>
          <div className="font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
            Linked trips ({linkedClusters.length})
          </div>
          <div className="space-y-1.5">
            {linkedClusters.map(({ cluster, link }) => {
              const palette = ROLE_COLORS[link.role] ?? { bg: '#f1f3f4', fg: '#5f6368', label: link.role };
              return (
                <button
                  key={cluster.id}
                  type="button"
                  onClick={() => onSelect({ kind: 'cluster', cluster, link })}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left"
                  style={{ background: palette.bg, color: palette.fg, fontSize: fs(11), border: `1px solid ${palette.fg}33` }}
                >
                  <span className="font-semibold tabular-nums">
                    {fmtUtcTimeInTz(cluster.startTime, tz)}
                  </span>
                  <span className="tabular-nums" style={{ opacity: 0.85 }}>
                    · {cluster.miles.toFixed(1)}mi
                  </span>
                  <span className="ml-auto uppercase tracking-wide font-semibold" style={{ fontSize: fs(9) }}>
                    {palette.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {(() => {
        // For relay legs, show only the stops relevant to this side
        // of the relay (pickups for the pickup leg, deliveries for the
        // delivery leg). Whole loads keep showing every stop.
        const visibleStops = stopsForLeg(event);
        if (visibleStops.length === 0) return null;
        const legNote = event.relayRole === 'pickup' ? ' · pickup leg'
                      : event.relayRole === 'delivery' ? ' · delivery leg'
                      : '';
        return (
        <div>
          <div className="font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
            Stops ({visibleStops.length}{legNote})
          </div>
          <div className="space-y-2">
            {visibleStops.map((s) => {
              const pin =
                s.type === 'pickup'                                ? '#16a34a' :
                s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook' ? '#dc2626' :
                                                                     '#9ca3af';
              return (
                <div key={s.id} style={{ fontSize: fs(12) }}>
                  <div className="flex items-center gap-2">
                    <MapPin size={Math.max(10, fs(12))} style={{ color: pin }} />
                    <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                      {s.sequence != null ? `${s.sequence}. ` : ''}{stopLabel(s.type ?? 'stop')}
                    </span>
                  </div>
                  <div className="ml-5" style={{ color: 'var(--gc-text-2)' }}>
                    {s.facilityName ? <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{s.facilityName}</div> : null}
                    {s.address ? <div>{s.address}</div> : null}
                    <div>{s.city ?? '—'}{s.state ? `, ${s.state}` : ''}</div>
                    {s.apptStart ? (
                      <div className="mt-0.5" style={{ fontSize: fs(11) }}>
                        Appt: <span className="tabular-nums">{fmtNaiveTime(s.apptStart)}</span>
                        {s.apptEnd ? <> – <span className="tabular-nums">{fmtNaiveTime(s.apptEnd)}</span></> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        );
      })()}
    </>
  );
}

function ClusterDetail({
  cluster, link, tz, events, eventLookup, fs, onMutated, onSelect,
}: {
  cluster: TimelineCluster;
  link: TimelineLink | undefined;
  tz: string;
  events: TimelineEvent[];
  eventLookup: Map<string, TimelineEvent>;
  fs: (px: number) => number;
  onMutated: () => void;
  onSelect: (s: Selection) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const role = link ? ROLE_COLORS[link.role] : null;
  const sourceLabel = cluster.sources.length === 1
    ? SOURCE_BADGE[cluster.sources[0]]
    : { fg: '#5f6368', label: 'Mixed' };

  /** Inline button that jumps the panel to a linked event. Used for
   *  the "Loaded for" / "From" / "To" references so the user can hop
   *  from a trip into the load it belongs to and back. */
  const EventRef = ({ eventId, fallback }: { eventId: string | undefined; fallback: string }) => {
    if (!eventId) return <span style={{ color: 'var(--gc-text-1)' }}>{fallback}</span>;
    const ev = eventLookup.get(eventId);
    if (!ev) return <span style={{ color: 'var(--gc-text-1)' }}>{fallback}</span>;
    return (
      <button
        type="button"
        onClick={() => onSelect({ kind: 'event', event: ev })}
        className="underline underline-offset-2 hover:no-underline"
        style={{ color: 'var(--gc-blue)', fontWeight: 600 }}
      >
        {ev.title ?? fallback}
      </button>
    );
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Clock size={Math.max(12, fs(16))} style={{ color: 'var(--gc-text-2)' }} />
        <h2 className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)', fontSize: fs(16) }}>
          {fmtUtcTimeInTz(cluster.startTime, tz)}
          {cluster.endTime ? ` – ${fmtUtcTimeInTz(cluster.endTime, tz)}` : ''}
        </h2>
      </div>
      <div className="flex items-center gap-3" style={{ color: 'var(--gc-text-2)', fontSize: fs(12) }}>
        <span><span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{cluster.miles.toFixed(1)}</span> mi</span>
        <span><span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{cluster.durationMin}</span> min</span>
        <span className="ml-auto uppercase tracking-wider font-semibold" style={{ color: sourceLabel.fg, fontSize: fs(10) }}>
          {sourceLabel.label}
        </span>
      </div>
      {cluster.origin || cluster.destination ? (
        <div style={{ fontSize: fs(12) }}>
          <div className="flex items-start gap-1.5 mb-1" style={{ color: 'var(--gc-text-2)' }}>
            <MapPin size={Math.max(10, fs(12))} style={{ color: '#16a34a', marginTop: 2 }} />
            <span>{cluster.origin ?? '—'}</span>
          </div>
          <div className="flex items-start gap-1.5" style={{ color: 'var(--gc-text-2)' }}>
            <MapPin size={Math.max(10, fs(12))} style={{ color: '#dc2626', marginTop: 2 }} />
            <span>{cluster.destination ?? '—'}</span>
          </div>
        </div>
      ) : null}
      {cluster.members.length > 1 ? (
        <div className="p-2 rounded" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)', fontSize: fs(11) }}>
          Coalesced from <strong style={{ color: 'var(--gc-text-2)' }}>{cluster.members.length}</strong> Motive fragments
          {' '}— short adjacent driving periods get merged here the same way the calendar's Movements column merges them.
        </div>
      ) : null}

      <div className="pt-2" style={{ borderTop: '1px solid var(--gc-border)' }}>
        <div className="flex items-center mb-2">
          <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
            Current link
          </span>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="ml-auto font-semibold flex items-center gap-1 px-2 py-1 rounded"
              style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)', fontSize: fs(11) }}
            >
              <Pencil size={Math.max(10, fs(11))} /> {link ? 'Change' : 'Assign'}
            </button>
          ) : null}
        </div>
        {editing ? (
          <LinkEditor
            memberIds={cluster.members.map((m) => m.id)}
            current={link}
            events={events}
            busy={busy}
            setBusy={setBusy}
            onDone={(mutated) => {
              setEditing(false);
              if (mutated) onMutated();
            }}
          />
        ) : link ? (
          <div className="space-y-1.5" style={{ color: 'var(--gc-text-2)', fontSize: fs(12) }}>
            <div className="flex items-center gap-2">
              <span
                className="px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide"
                style={{ background: role?.bg, color: role?.fg, fontSize: fs(10) }}
              >
                {role?.label ?? link.role}
              </span>
              {link.confidence ? (
                <span className="uppercase tracking-wider font-semibold"
                  style={{
                    fontSize: fs(10),
                    color:
                      link.confidence === 'high'   ? '#1e8e3e' :
                      link.confidence === 'medium' ? '#b06000' :
                                                     '#c5221f',
                  }}
                >
                  {link.confidence}
                </span>
              ) : null}
              <span className="ml-auto" style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
                {link.source}
              </span>
            </div>
            {link.role === 'loaded' ? (
              <div>Loaded for: <EventRef eventId={link.loadedEventId} fallback={link.loadedEventId?.slice(0, 8) ?? '?'} /></div>
            ) : null}
            {link.role === 'transition' ? (
              <div>
                From: <EventRef eventId={link.fromEventId} fallback="yard / unknown" /><br />
                To: <EventRef eventId={link.toEventId} fallback="yard / unknown" />
              </div>
            ) : null}
            {link.role === 'dwell' ? (
              <div>At stop on: <EventRef eventId={link.loadedEventId} fallback={link.loadedEventId?.slice(0, 8) ?? '?'} /></div>
            ) : null}
            {link.reasoning ? (
              <div className="mt-2 p-2 rounded"
                style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)', fontSize: fs(11) }}>
                {link.reasoning}
              </div>
            ) : null}
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  for (const m of cluster.members) {
                    await railway.clearMovementLink(m.id);
                  }
                  onMutated();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded mt-2"
              style={{ background: '#fce8e6', color: '#c5221f', fontSize: fs(11) }}
            >
              <Trash2 size={Math.max(10, fs(11))} /> Mark unrelated
            </button>
          </div>
        ) : (
          <div style={{ color: 'var(--gc-text-3)', fontSize: fs(12) }}>
            No link yet. Click <strong style={{ color: 'var(--gc-text-2)' }}>Assign</strong> to set one.
          </div>
        )}
      </div>
    </>
  );
}

// ── Link editor (used in ClusterDetail) ───────────────────────────────
//
// Writes the same link to every member of the cluster — that's what
// "this trip was a loaded run to Denver" means: every Motive fragment
// inside the cluster carries the same role/event refs.

function LinkEditor({
  memberIds, current, events, busy, setBusy, onDone,
}: {
  memberIds: string[];
  current: TimelineLink | undefined;
  events: TimelineEvent[];
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (mutated: boolean) => void;
}) {
  const [role, setRole] = useState<TimelineLinkRole>(current?.role ?? 'loaded');
  const [loadedEventId, setLoadedEventId] = useState<string>(current?.loadedEventId ?? '');
  const [fromEventId, setFromEventId]     = useState<string>(current?.fromEventId   ?? '');
  const [toEventId, setToEventId]         = useState<string>(current?.toEventId     ?? '');
  const [reasoning, setReasoning]         = useState<string>('');

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => a.start.localeCompare(b.start)),
    [events],
  );

  async function save() {
    // Validate role-refs combo client-side for instant feedback before
    // we fan out the write across cluster members.
    if (role === 'loaded' && !loadedEventId) { alert('Pick a load for this loaded trip.'); return; }
    if (role === 'dwell'  && !loadedEventId) { alert('Pick a load for this dwell.'); return; }
    if (role === 'transition' && !fromEventId && !toEventId) {
      alert('Pick a From or To load for this deadhead.'); return;
    }

    setBusy(true);
    try {
      // Cluster-level save → identical link written to every member
      // movement. Each member ends up with its own row in movement_links
      // so per-movement readers (analytics, dashboards) stay accurate.
      for (const movementId of memberIds) {
        const body: AssertLinkRequest = {
          movementId, role, source: 'manual',
          reasoning: reasoning.trim() || undefined,
        };
        if (role === 'loaded' || role === 'dwell') body.loadedEventId = loadedEventId || undefined;
        if (role === 'transition') {
          body.fromEventId = fromEventId || undefined;
          body.toEventId   = toEventId   || undefined;
        }
        await railway.assertMovementLink(body);
      }
      onDone(true);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-[12px]">
      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
          Role
        </label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as TimelineLinkRole)}
          className="w-full px-2 py-1.5 rounded"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
        >
          <option value="loaded">Loaded — under load</option>
          <option value="transition">Deadhead — between loads</option>
          <option value="dwell">Dwell — at shipper/receiver</option>
          <option value="rest">Rest — driver break</option>
          <option value="unrelated">Unrelated — yard shuffle / PC</option>
        </select>
      </div>

      {(role === 'loaded' || role === 'dwell') ? (
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            Load
          </label>
          <select
            value={loadedEventId}
            onChange={(e) => setLoadedEventId(e.target.value)}
            className="w-full px-2 py-1.5 rounded"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
          >
            <option value="">— pick a load —</option>
            {sortedEvents.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.title ?? '(no title)'} · {ev.start.slice(11, 16)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {role === 'transition' ? (
        <>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
              From load
            </label>
            <select
              value={fromEventId}
              onChange={(e) => setFromEventId(e.target.value)}
              className="w-full px-2 py-1.5 rounded"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            >
              <option value="">— yard / start of day —</option>
              {sortedEvents.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.title ?? '(no title)'} · {ev.start.slice(11, 16)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
              To load
            </label>
            <select
              value={toEventId}
              onChange={(e) => setToEventId(e.target.value)}
              className="w-full px-2 py-1.5 rounded"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            >
              <option value="">— yard / end of day —</option>
              {sortedEvents.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.title ?? '(no title)'} · {ev.start.slice(11, 16)}</option>
              ))}
            </select>
          </div>
        </>
      ) : null}

      <div>
        <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
          Note (optional)
        </label>
        <input
          type="text"
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          placeholder="Why this link — short explainer for future you / agents"
          className="w-full px-2 py-1.5 rounded text-[12px]"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={busy}
          className="text-[12px] font-semibold px-3 py-1.5 rounded"
          style={{ background: 'var(--gc-blue)', color: '#fff' }}
        >
          {busy ? 'Saving…' : 'Save link'}
        </button>
        <button
          onClick={() => onDone(false)}
          disabled={busy}
          className="text-[12px] px-3 py-1.5 rounded"
          style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Create movement modal ─────────────────────────────────────────────

function CreateMovementModal({
  assetId, dayKey, tz, events, onClose, onCreated,
}: {
  assetId: number;
  dayKey: string;
  tz: string;
  events: TimelineEvent[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // Defaults: 8 AM → 9 AM in org TZ on the selected day. The naive
  // strings the user types in the form represent org wall-clock.
  const [startTime, setStartTime]   = useState<string>(`${dayKey}T08:00`);
  const [endTime, setEndTime]       = useState<string>(`${dayKey}T09:00`);
  const [miles, setMiles]           = useState<string>('');
  const [origin, setOrigin]         = useState<string>('');
  const [destination, setDestination] = useState<string>('');
  const [notes, setNotes]           = useState<string>('');
  const [busy, setBusy]             = useState<boolean>(false);

  // Optional link to set in the same flow — saves a click for the
  // common case of "I just deadheaded from Load A to Load B."
  const [role, setRole]             = useState<TimelineLinkRole | ''>('');
  const [loadedEventId, setLoadedEventId] = useState<string>('');
  const [fromEventId, setFromEventId]     = useState<string>('');
  const [toEventId, setToEventId]         = useState<string>('');

  async function save() {
    if (!startTime) { alert('Start time required'); return; }
    const body: CreateMovementRequest = {
      assetId,
      // Convert datetime-local (naive) → UTC ISO anchored to org TZ.
      startTime: new Date(parseNaiveIsoInTz(`${startTime}:00`, tz)).toISOString(),
      endTime:   endTime ? new Date(parseNaiveIsoInTz(`${endTime}:00`, tz)).toISOString() : undefined,
      miles:       miles ? Number(miles) : undefined,
      origin:      origin.trim() || undefined,
      destination: destination.trim() || undefined,
      notes:       notes.trim() || undefined,
    };
    setBusy(true);
    try {
      const { movement } = await railway.createManualMovement(body);
      // Optionally assert a link in the same go.
      if (role) {
        const linkBody: AssertLinkRequest = {
          movementId: movement.id,
          role,
          source: 'manual',
        };
        if (role === 'loaded' || role === 'dwell') linkBody.loadedEventId = loadedEventId || undefined;
        if (role === 'transition') {
          linkBody.fromEventId = fromEventId || undefined;
          linkBody.toEventId   = toEventId   || undefined;
        }
        // Server validates role/ref combo and 400s if invalid; surface
        // that gracefully but still keep the movement we just created.
        try { await railway.assertMovementLink(linkBody); } catch (err) {
          alert(`Movement created, but link save failed: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
      onCreated();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => a.start.localeCompare(b.start)),
    [events],
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={onClose}
    >
      <div
        className="w-[480px] max-h-[90vh] overflow-y-auto rounded-lg shadow-xl"
        style={{ background: 'var(--gc-surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <span className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            Add manual movement
          </span>
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center hover:bg-black/5">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                Start (org TZ)
              </label>
              <input
                type="datetime-local" value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-2 py-1.5 rounded"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                End (org TZ)
              </label>
              <input
                type="datetime-local" value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-2 py-1.5 rounded"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
              Miles
            </label>
            <input
              type="number" min="0" step="0.1" value={miles}
              onChange={(e) => setMiles(e.target.value)}
              placeholder="e.g. 250"
              className="w-full px-2 py-1.5 rounded"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                Origin
              </label>
              <input
                type="text" value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder="Denver, CO"
                className="w-full px-2 py-1.5 rounded"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                Destination
              </label>
              <input
                type="text" value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="Salt Lake City, UT"
                className="w-full px-2 py-1.5 rounded"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
              Notes
            </label>
            <input
              type="text" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What is this movement? (free text)"
              className="w-full px-2 py-1.5 rounded"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            />
          </div>

          {/* Optional in-line link */}
          <div className="pt-2" style={{ borderTop: '1px dashed var(--gc-border)' }}>
            <div className="text-[10px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
              Link this movement (optional)
            </div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as TimelineLinkRole | '')}
              className="w-full px-2 py-1.5 rounded mb-2"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
            >
              <option value="">— skip linking, set it later —</option>
              <option value="loaded">Loaded</option>
              <option value="transition">Deadhead</option>
              <option value="dwell">Dwell</option>
              <option value="rest">Rest</option>
              <option value="unrelated">Unrelated</option>
            </select>
            {(role === 'loaded' || role === 'dwell') ? (
              <select
                value={loadedEventId}
                onChange={(e) => setLoadedEventId(e.target.value)}
                className="w-full px-2 py-1.5 rounded"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              >
                <option value="">— pick a load —</option>
                {sortedEvents.map((ev) => (
                  <option key={ev.id} value={ev.id}>{ev.title ?? '(no title)'} · {ev.start.slice(11, 16)}</option>
                ))}
              </select>
            ) : null}
            {role === 'transition' ? (
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={fromEventId}
                  onChange={(e) => setFromEventId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
                >
                  <option value="">From: yard / start</option>
                  {sortedEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>From: {ev.title ?? '(no title)'}</option>
                  ))}
                </select>
                <select
                  value={toEventId}
                  onChange={(e) => setToEventId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
                >
                  <option value="">To: yard / end</option>
                  {sortedEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>To: {ev.title ?? '(no title)'}</option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--gc-border)' }}>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-[13px] px-3 py-1.5 rounded"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="text-[13px] font-semibold px-3 py-1.5 rounded"
            style={{ background: 'var(--gc-blue)', color: '#fff' }}
          >
            {busy ? 'Saving…' : 'Create movement'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Revenue Analysis strip ────────────────────────────────────────────
//
// Per-load + per-day revenue-per-mile readout, fed by the server-side
// computeProfitability(). Each card shows revenue, attributed miles
// (loaded + inbound deadhead), the two RPM lenses (loaded-only vs
// all-in), deadhead %, and driver pay → net-to-truck. The day card
// at the right rolls everything up and exposes the "total RPM" lens
// that includes the yard-return overhead — useful for honest fleet-
// level comparisons.

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtRpm(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}/mi`;
}
function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}
function fmtMi(n: number): string {
  return `${n.toFixed(1)}mi`;
}

function RevenueAnalysisStrip({
  profitability, assetColor, fs,
}: {
  profitability: TimelineProfitability;
  assetColor: string;
  fs: (px: number) => number;
}) {
  const { loads, day } = profitability;
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
          Revenue analysis
        </span>
        <span style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>
          · inbound attribution · {loads.length} load{loads.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {loads.map((l) => (
          <LoadProfitCard key={l.eventId} load={l} accent={assetColor} fs={fs} />
        ))}
        <DayProfitCard day={day} fs={fs} />
      </div>
    </div>
  );
}

function LoadProfitCard({
  load, accent, fs,
}: {
  load: TimelineProfitabilityLoad;
  accent: string;
  fs: (px: number) => number;
}) {
  const noMiles = load.attributedMiles === 0;
  return (
    <div
      className="flex-shrink-0 rounded-lg p-3"
      style={{
        width:      260,
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div className="font-semibold truncate" style={{ color: 'var(--gc-text-1)', fontSize: fs(12) }} title={load.title ?? ''}>
        {load.title ?? '(no title)'}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)', fontSize: fs(20) }}>
          {fmtMoney(load.revenue)}
        </span>
        <span className="tabular-nums" style={{ color: noMiles ? 'var(--gc-text-3)' : '#1e8e3e', fontSize: fs(12) }}>
          {fmtRpm(load.rpmAllIn)} all-in
        </span>
      </div>
      <div className="tabular-nums mt-0.5" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
        {fmtRpm(load.rpmLoaded)} loaded · {fmtPct(load.deadheadPct)} dh
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5" style={{ color: 'var(--gc-text-2)', fontSize: fs(11) }}>
        <span>Loaded</span>
        <span className="text-right tabular-nums">{fmtMi(load.loadedMiles)}</span>
        <span>Inbound dh</span>
        <span className="text-right tabular-nums">{fmtMi(load.inboundDhMiles)}</span>
        <span style={{ color: 'var(--gc-text-3)' }}>Attributed</span>
        <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMi(load.attributedMiles)}</span>
      </div>

      {load.driverPay > 0 || load.revenue > 0 ? (
        <div className="mt-2 pt-2 grid grid-cols-2 gap-x-2 gap-y-0.5" style={{ borderTop: '1px dashed var(--gc-border)', color: 'var(--gc-text-2)', fontSize: fs(11) }}>
          <span>Driver pay</span>
          <span className="text-right tabular-nums">{fmtMoney(load.driverPay)}</span>
          <span style={{ color: 'var(--gc-text-3)' }}>Net to truck</span>
          <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(load.netToTruck)}</span>
        </div>
      ) : null}
    </div>
  );
}

function DayProfitCard({
  day, fs,
}: {
  day: TimelineProfitability['day'];
  fs: (px: number) => number;
}) {
  return (
    <div
      className="flex-shrink-0 rounded-lg p-3"
      style={{
        width:      280,
        background: 'var(--gc-surface-2)',
        border:     '1px solid var(--gc-border)',
      }}
    >
      <div className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
        Day total
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)', fontSize: fs(20) }}>
          {fmtMoney(day.totalRevenue)}
        </span>
        <span className="tabular-nums" style={{ color: '#1e8e3e', fontSize: fs(12) }}>
          {fmtRpm(day.dayRpm)} attr
        </span>
      </div>
      <div className="tabular-nums mt-0.5" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
        {fmtRpm(day.dayRpmTotal)} total · {fmtPct(day.deadheadPctOfDay)} dh
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5" style={{ color: 'var(--gc-text-2)', fontSize: fs(11) }}>
        <span>Loaded</span>
        <span className="text-right tabular-nums">{fmtMi(day.loadedMiles)}</span>
        <span>Inbound dh</span>
        <span className="text-right tabular-nums">{fmtMi(day.inboundDhMiles)}</span>
        <span>Yard return</span>
        <span className="text-right tabular-nums">{fmtMi(day.yardReturnMiles)}</span>
        {day.unattributedMiles > 0 ? (
          <>
            <span style={{ color: 'var(--gc-text-3)' }}>Unattributed</span>
            <span className="text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{fmtMi(day.unattributedMiles)}</span>
          </>
        ) : null}
        <span style={{ color: 'var(--gc-text-3)' }}>Total miles</span>
        <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMi(day.totalMiles)}</span>
      </div>

      <div className="mt-2 pt-2 grid grid-cols-2 gap-x-2 gap-y-0.5" style={{ borderTop: '1px dashed var(--gc-border)', color: 'var(--gc-text-2)', fontSize: fs(11) }}>
        <span>Driver pay</span>
        <span className="text-right tabular-nums">{fmtMoney(day.totalDriverPay)}</span>
        <span style={{ color: 'var(--gc-text-3)' }}>Net to truck</span>
        <span className="text-right tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(day.netToTruck)}</span>
      </div>
    </div>
  );
}
