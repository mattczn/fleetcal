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

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, ArrowLeft,
  Truck, MapPin, Clock, Sparkles, X, Plus, Pencil, Trash2, Loader2,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import {
  railway,
  type TimelinePayload, type TimelineEvent, type TimelineLink,
  type TimelineLinkRole, type AssertLinkRequest, type CreateMovementRequest,
} from '@/lib/railway';
import { clusterTimelineMovements, type TimelineCluster } from '@/lib/timelineClusters';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';

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
  const { calendarTimezone, assets } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';

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

  // Reset selection when switching truck or day so the panel doesn't
  // hang around showing a stale row from the previous view.
  useEffect(() => {
    setSelection(null);
  }, [effectiveAssetId, dayKey]);

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

  // A cluster's link is the link on any of its members — the AI writes
  // identical links to every member, so the first one with a link wins.
  const linkForCluster = (cl: TimelineCluster): TimelineLink | undefined => {
    for (const m of cl.members) {
      const l = linkByMovementId.get(m.id);
      if (l) return l;
    }
    return undefined;
  };

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

          {/* Header actions */}
          {effectiveAssetId != null ? (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={runAutoLink}
                disabled={autoLinking}
                className="text-[12px] font-semibold px-3 py-1.5 rounded flex items-center gap-1.5"
                style={{
                  background: autoLinking ? 'var(--gc-surface-2)' : 'var(--gc-purple, #a142f4)',
                  color: autoLinking ? 'var(--gc-text-3)' : '#fff',
                }}
                title="Claude classifies each movement on this day's window (skips manually-linked rows)"
              >
                {autoLinking ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {autoLinking ? 'Linking…' : 'Re-link with AI'}
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

        {/* Day nav */}
        <div
          className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
        >
          <button
            onClick={() => setDayKey((k) => shiftDateKey(k, -1))}
            className="w-7 h-7 rounded flex items-center justify-center hover:bg-black/5"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="flex-1 flex items-center gap-2">
            <CalendarIcon size={14} style={{ color: 'var(--gc-text-3)' }} />
            <input
              type="date"
              value={dayKey}
              onChange={(e) => setDayKey(e.target.value || todayKey)}
              className="text-[14px] font-semibold bg-transparent border-0 outline-none"
              style={{ color: 'var(--gc-text-1)' }}
            />
            <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {fmtDateHeader(dayKey, tz)}
            </span>
          </div>
          <button
            onClick={() => setDayKey(todayKey)}
            className="text-[11px] font-semibold px-2 py-1 rounded"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
          >
            TODAY
          </button>
          <button
            onClick={() => setDayKey((k) => shiftDateKey(k, 1))}
            className="w-7 h-7 rounded flex items-center justify-center hover:bg-black/5"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Body + inline detail column. The detail column is a sticky
            right-side pane that replaces the old fixed overlay — content
            on the left no longer gets covered by an open panel. */}
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0">
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
                {/* Column headers */}
                <div className="grid grid-cols-[60px_1fr_1fr] border-b" style={{ borderColor: 'var(--gc-border)' }}>
                  <div className="px-2 py-2 text-[10px] uppercase font-semibold tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                    Time
                  </div>
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold tracking-wider border-l" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border)' }}>
                    Scheduled · {visibleEvents.length} event{visibleEvents.length !== 1 ? 's' : ''}
                  </div>
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold tracking-wider border-l" style={{ color: 'var(--gc-text-3)', borderColor: 'var(--gc-border)' }}>
                    Actual · {visibleClusters.length} trip{visibleClusters.length !== 1 ? 's' : ''}
                    {visibleMovements.length !== visibleClusters.length ? (
                      <span className="ml-1 normal-case font-normal" style={{ color: 'var(--gc-text-3)' }}>
                        ({visibleMovements.length} raw fragments)
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* Time-axis body */}
                <div className="grid grid-cols-[60px_1fr_1fr] relative" style={{ height: TOTAL_HEIGHT }}>
                  {/* Hour ruler */}
                  <div className="relative" style={{ background: 'var(--gc-surface-2)' }}>
                    {Array.from({ length: 24 }, (_, h) => {
                      const hh   = h % 12 || 12;
                      const ampm = h >= 12 ? 'PM' : 'AM';
                      return (
                        <div
                          key={h}
                          className="absolute left-0 right-0 px-2"
                          style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                        >
                          <span className="text-[10px] font-medium" style={{ color: 'var(--gc-text-3)' }}>
                            {hh}{h === 0 ? '' : ` ${ampm}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Events column */}
                  <div className="relative border-l" style={{ borderColor: 'var(--gc-border)' }}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute left-0 right-0"
                        style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                      />
                    ))}
                    {visibleEvents.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                        No scheduled events
                      </div>
                    ) : (
                      visibleEvents.map((e) => (
                        <EventBlock
                          key={e.id}
                          event={e}
                          dayKey={dayKey}
                          color={assetColor}
                          onClick={() => setSelection({ kind: 'event', event: e })}
                          isSelected={selection?.kind === 'event' && selection.event.id === e.id}
                        />
                      ))
                    )}
                    <NowLine dayKey={dayKey} tz={tz} />
                  </div>

                  {/* Movements column — renders CLUSTERS (one chip per
                      logical trip), not raw Motive fragments. */}
                  <div className="relative border-l" style={{ borderColor: 'var(--gc-border)' }}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className="absolute left-0 right-0"
                        style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                      />
                    ))}
                    {visibleClusters.length === 0 ? (
                      <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                        No movements
                      </div>
                    ) : (
                      visibleClusters.map((cl) => {
                        const link = linkForCluster(cl);
                        return (
                          <ClusterBlock
                            key={cl.id}
                            cluster={cl}
                            link={link}
                            eventLookup={eventById}
                            dayKey={dayKey}
                            tz={tz}
                            onClick={() => setSelection({ kind: 'cluster', cluster: cl, link })}
                            isSelected={selection?.kind === 'cluster' && selection.cluster.id === cl.id}
                          />
                        );
                      })
                    )}
                    <NowLine dayKey={dayKey} tz={tz} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Persistent detail column — always rendered, with an empty
              state when nothing is selected. No more covering the
              calendar with an overlay tray. */}
          <div
            className="w-[400px] flex-shrink-0 rounded-lg overflow-hidden sticky top-4"
            style={{
              background: 'var(--gc-surface)',
              border: '1px solid var(--gc-border)',
              maxHeight: 'calc(100vh - 32px)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <DetailPanel
              selection={selection}
              tz={tz}
              assetColor={assetColor}
              events={data?.events ?? []}
              eventLookup={eventById}
              onClose={() => setSelection(null)}
              onMutated={() => setRefreshTick((t) => t + 1)}
            />
          </div>
        </div>

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

function EventBlock({
  event, dayKey, color, onClick, isSelected,
}: {
  event: TimelineEvent;
  dayKey: string;
  color: string;
  onClick: () => void;
  isSelected: boolean;
}) {
  const pos = positionForEvent(event.start, event.end, dayKey);
  const isNonRev = event.eventKind === 'non_revenue';

  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-1 right-1 rounded-md p-2 overflow-hidden text-left text-[11px] transition-shadow"
      style={{
        top:        pos.topPx,
        height:     pos.heightPx,
        background: isNonRev ? '#fef7e0' : color,
        color:      isNonRev ? '#202124' : '#ffffff',
        borderLeft: `3px solid ${isNonRev ? '#f9ab00' : '#202124'}`,
        boxShadow:  isSelected ? '0 0 0 2px var(--gc-blue)' : undefined,
        cursor:     'pointer',
      }}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="font-semibold truncate">
          {event.title ?? (isNonRev ? event.nonRevenueType ?? 'Non-revenue' : 'Untitled')}
        </div>
        <div className="text-[10px] tabular-nums whitespace-nowrap opacity-90">
          {fmtNaiveTime(event.start)} – {fmtNaiveTime(event.end)}
        </div>
      </div>
      {event.driverName ? (
        <div className="truncate opacity-90">{event.driverName}</div>
      ) : null}
      {/* All stops, ordered. Pickup green pin, delivery red pin, others
          gray. The chip grows with the event's duration; for short events
          the side panel shows the full list when clicked. */}
      {event.stops.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {event.stops.map((s, i) => {
            const pin =
              s.type === 'pickup'                                ? '#16a34a' :
              s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook' ? '#dc2626' :
                                                                   '#9ca3af';
            return (
              <div key={s.id ?? i} className="flex items-start gap-1.5">
                <MapPin size={10} style={{ color: pin, marginTop: 2 }} />
                <div className="flex-1 truncate opacity-95">
                  <span className="font-semibold mr-1">
                    {s.sequence != null ? `${s.sequence}.` : ''}{s.type ? ` ${stopLabel(s.type)}:` : ''}
                  </span>
                  {s.city ?? '—'}{s.state ? `, ${s.state}` : ''}
                  {s.facilityName ? ` · ${s.facilityName}` : ''}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {pos.spansBefore || pos.spansAfter ? (
        <div className="absolute right-1 bottom-1 text-[9px] uppercase tracking-wider opacity-80">
          {pos.spansBefore ? 'starts earlier' : ''}{pos.spansBefore && pos.spansAfter ? ' · ' : ''}{pos.spansAfter ? 'continues' : ''}
        </div>
      ) : null}
    </button>
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

function ClusterBlock({
  cluster, link, eventLookup, dayKey, tz, onClick, isSelected,
}: {
  cluster: TimelineCluster;
  link: TimelineLink | undefined;
  eventLookup: Map<string, TimelineEvent>;
  dayKey: string;
  tz: string;
  onClick: () => void;
  isSelected: boolean;
}) {
  // Render against displayEndTime so short clusters paint as 30min
  // even if the real driving was 5 minutes.
  const pos = positionForMovement(cluster.startTime, cluster.displayEndTime, dayKey, tz);
  const role = link ? ROLE_COLORS[link.role] : null;
  // Source label — if the cluster mixes motive + manual fragments it
  // shows "Mixed" so the dispatcher knows part of this trip was hand-
  // entered. Practically almost always 'motive' alone.
  const sourceLabel = cluster.sources.length === 1
    ? SOURCE_BADGE[cluster.sources[0]]
    : { fg: '#5f6368', label: 'Mixed' };
  const isTall = pos.heightPx >= 56;
  const isMed  = pos.heightPx >= 36;

  const linkLabel = (() => {
    if (!link) return null;
    if (link.role === 'loaded') {
      const ev = link.loadedEventId ? eventLookup.get(link.loadedEventId) : null;
      return ev?.title ?? 'Loaded';
    }
    if (link.role === 'transition') {
      const fromEv = link.fromEventId ? eventLookup.get(link.fromEventId) : null;
      const toEv   = link.toEventId   ? eventLookup.get(link.toEventId)   : null;
      return `${fromEv?.title ?? 'yard'} → ${toEv?.title ?? 'yard'}`;
    }
    if (link.role === 'dwell') {
      const ev = link.loadedEventId ? eventLookup.get(link.loadedEventId) : null;
      return `At ${ev?.title ?? 'stop'}`;
    }
    return role?.label ?? null;
  })();

  // Time label uses the REAL endTime (not the padded display end) so
  // dispatchers see the actual trip times, not the display fudge.
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-1 right-1 rounded-md overflow-hidden text-left transition-shadow"
      style={{
        top:        pos.topPx,
        height:     pos.heightPx,
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
        boxShadow:  isSelected ? '0 0 0 2px var(--gc-blue)' : undefined,
        cursor:     'pointer',
        padding:    isTall ? 8 : isMed ? 6 : 3,
      }}
    >
      <div className="flex items-center gap-1.5 text-[11px] leading-tight">
        <Clock size={10} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
        <span className="font-semibold tabular-nums truncate" style={{ color: 'var(--gc-text-1)' }}>
          {fmtUtcTimeInTz(cluster.startTime, tz)}
          {cluster.endTime ? `–${fmtUtcTimeInTz(cluster.endTime, tz)}` : ''}
        </span>
        <span className="tabular-nums text-[10px]" style={{ color: 'var(--gc-text-2)' }}>
          · {cluster.miles.toFixed(1)}mi
        </span>
        {role ? (
          <span
            className="ml-auto px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide flex-shrink-0"
            style={{ background: role.bg, color: role.fg }}
          >
            {role.label}
          </span>
        ) : (
          <span
            className="ml-auto px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide flex-shrink-0"
            style={{ background: '#f1f3f4', color: '#9aa0a6' }}
          >
            Unlinked
          </span>
        )}
      </div>

      {isMed ? (
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] truncate" style={{ color: 'var(--gc-text-2)' }}>
          <span className="uppercase tracking-wider font-semibold" style={{ color: sourceLabel.fg }}>
            {sourceLabel.label}
          </span>
          {cluster.members.length > 1 ? (
            <span className="text-[9px]" style={{ color: 'var(--gc-text-3)' }}>
              · {cluster.members.length} fragments
            </span>
          ) : null}
          {linkLabel ? <span className="truncate">· {linkLabel}</span> : null}
        </div>
      ) : null}

      {isTall && (cluster.origin || cluster.destination) ? (
        <div className="flex items-start gap-1 mt-1 truncate text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
          <MapPin size={10} style={{ marginTop: 1, flexShrink: 0 }} />
          <span className="truncate">
            {(cluster.origin ?? '—').split(',')[0]} → {(cluster.destination ?? '—').split(',')[0]}
          </span>
        </div>
      ) : null}
    </button>
  );
}

// ── Detail panel (inline right-side column) ──────────────────────────
//
// Always rendered as part of the page grid (no longer a fixed overlay).
// Accepts a nullable selection and shows an empty state when nothing is
// selected so the right column doesn't pop in and out as the user clicks
// around.

function DetailPanel({
  selection, tz, assetColor, events, eventLookup, onClose, onMutated,
}: {
  selection: Selection;
  tz: string;
  assetColor: string;
  events: TimelineEvent[];
  eventLookup: Map<string, TimelineEvent>;
  onClose: () => void;
  onMutated: () => void;
}) {
  return (
    <>
      <div
        className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)' }}
      >
        <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {selection == null
            ? 'Details'
            : selection.kind === 'event' ? 'Scheduled event' : 'Trip'}
        </span>
        {selection != null ? (
          <button onClick={onClose} className="w-7 h-7 rounded flex items-center justify-center hover:bg-black/5" title="Clear selection">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <div className="p-4 space-y-3 overflow-y-auto" style={{ flex: 1 }}>
        {selection == null ? (
          <div className="text-center py-12 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            <div className="mb-1 font-semibold uppercase tracking-wider text-[10px]">No selection</div>
            <div>Click a scheduled event or a trip in the timeline to see details and edit its link here.</div>
          </div>
        ) : selection.kind === 'event' ? (
          <EventDetail event={selection.event} color={assetColor} />
        ) : (
          <ClusterDetail
            cluster={selection.cluster}
            link={selection.link}
            tz={tz}
            events={events}
            eventLookup={eventLookup}
            onMutated={onMutated}
          />
        )}
      </div>
    </>
  );
}

function EventDetail({ event, color }: { event: TimelineEvent; color: string }) {
  const isNonRev = event.eventKind === 'non_revenue';
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ background: isNonRev ? '#f9ab00' : color }} />
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          {event.title ?? (isNonRev ? event.nonRevenueType ?? 'Non-revenue' : 'Untitled')}
        </h2>
      </div>
      <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--gc-text-2)' }}>
        <Clock size={12} />
        <span className="tabular-nums">{fmtNaiveTime(event.start)} – {fmtNaiveTime(event.end)}</span>
        {event.status ? (
          <span className="ml-auto text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)' }}>
            {event.status}
          </span>
        ) : null}
      </div>
      {event.driverName ? (
        <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
          Driver: <span style={{ color: 'var(--gc-text-1)' }}>{event.driverName}</span>
        </div>
      ) : null}
      {event.loadPrice != null ? (
        <div className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
          Revenue: <span className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
            ${event.loadPrice.toLocaleString('en-US')}
          </span>
        </div>
      ) : null}
      {event.stops.length > 0 ? (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Stops ({event.stops.length})
          </div>
          <div className="space-y-2">
            {event.stops.map((s) => {
              const pin =
                s.type === 'pickup'                                ? '#16a34a' :
                s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook' ? '#dc2626' :
                                                                     '#9ca3af';
              return (
                <div key={s.id} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <MapPin size={12} style={{ color: pin }} />
                    <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                      {s.sequence != null ? `${s.sequence}. ` : ''}{stopLabel(s.type ?? 'stop')}
                    </span>
                  </div>
                  <div className="ml-5" style={{ color: 'var(--gc-text-2)' }}>
                    {s.facilityName ? <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{s.facilityName}</div> : null}
                    {s.address ? <div>{s.address}</div> : null}
                    <div>{s.city ?? '—'}{s.state ? `, ${s.state}` : ''}</div>
                    {s.apptStart ? (
                      <div className="mt-0.5 text-[11px]">
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
      ) : null}
    </>
  );
}

function ClusterDetail({
  cluster, link, tz, events, eventLookup, onMutated,
}: {
  cluster: TimelineCluster;
  link: TimelineLink | undefined;
  tz: string;
  events: TimelineEvent[];
  eventLookup: Map<string, TimelineEvent>;
  onMutated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const role = link ? ROLE_COLORS[link.role] : null;
  const sourceLabel = cluster.sources.length === 1
    ? SOURCE_BADGE[cluster.sources[0]]
    : { fg: '#5f6368', label: 'Mixed' };
  return (
    <>
      <div className="flex items-center gap-2">
        <Clock size={16} style={{ color: 'var(--gc-text-2)' }} />
        <h2 className="text-[16px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
          {fmtUtcTimeInTz(cluster.startTime, tz)}
          {cluster.endTime ? ` – ${fmtUtcTimeInTz(cluster.endTime, tz)}` : ''}
        </h2>
      </div>
      <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
        <span><span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{cluster.miles.toFixed(1)}</span> mi</span>
        <span><span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{cluster.durationMin}</span> min</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider font-semibold" style={{ color: sourceLabel.fg }}>
          {sourceLabel.label}
        </span>
      </div>
      {cluster.origin || cluster.destination ? (
        <div className="text-[12px]">
          <div className="flex items-start gap-1.5 mb-1" style={{ color: 'var(--gc-text-2)' }}>
            <MapPin size={12} style={{ color: '#16a34a', marginTop: 2 }} />
            <span>{cluster.origin ?? '—'}</span>
          </div>
          <div className="flex items-start gap-1.5" style={{ color: 'var(--gc-text-2)' }}>
            <MapPin size={12} style={{ color: '#dc2626', marginTop: 2 }} />
            <span>{cluster.destination ?? '—'}</span>
          </div>
        </div>
      ) : null}
      {cluster.members.length > 1 ? (
        <div className="text-[11px] p-2 rounded" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)' }}>
          Coalesced from <strong style={{ color: 'var(--gc-text-2)' }}>{cluster.members.length}</strong> Motive fragments
          {' '}— short adjacent driving periods get merged here the same way the calendar's Movements column merges them.
        </div>
      ) : null}

      <div className="pt-2" style={{ borderTop: '1px solid var(--gc-border)' }}>
        <div className="flex items-center mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            Current link
          </span>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="ml-auto text-[11px] font-semibold flex items-center gap-1 px-2 py-1 rounded"
              style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
            >
              <Pencil size={11} /> {link ? 'Change' : 'Assign'}
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
          <div className="space-y-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
            <div className="flex items-center gap-2">
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: role?.bg, color: role?.fg }}
              >
                {role?.label ?? link.role}
              </span>
              {link.confidence ? (
                <span className="text-[10px] uppercase tracking-wider font-semibold"
                  style={{
                    color:
                      link.confidence === 'high'   ? '#1e8e3e' :
                      link.confidence === 'medium' ? '#b06000' :
                                                     '#c5221f',
                  }}
                >
                  {link.confidence}
                </span>
              ) : null}
              <span className="ml-auto text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
                {link.source}
              </span>
            </div>
            {link.role === 'loaded' && link.loadedEventId ? (
              <div>Loaded for: <span style={{ color: 'var(--gc-text-1)' }}>
                {eventLookup.get(link.loadedEventId)?.title ?? link.loadedEventId.slice(0, 8)}
              </span></div>
            ) : null}
            {link.role === 'transition' ? (
              <div>
                From: <span style={{ color: 'var(--gc-text-1)' }}>
                  {link.fromEventId ? (eventLookup.get(link.fromEventId)?.title ?? link.fromEventId.slice(0, 8)) : 'yard / unknown'}
                </span><br />
                To: <span style={{ color: 'var(--gc-text-1)' }}>
                  {link.toEventId ? (eventLookup.get(link.toEventId)?.title ?? link.toEventId.slice(0, 8)) : 'yard / unknown'}
                </span>
              </div>
            ) : null}
            {link.role === 'dwell' && link.loadedEventId ? (
              <div>At stop on: <span style={{ color: 'var(--gc-text-1)' }}>
                {eventLookup.get(link.loadedEventId)?.title ?? link.loadedEventId.slice(0, 8)}
              </span></div>
            ) : null}
            {link.reasoning ? (
              <div className="mt-2 p-2 rounded text-[11px]"
                style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-3)' }}>
                {link.reasoning}
              </div>
            ) : null}
            <button
              onClick={async () => {
                setBusy(true);
                try {
                  // Cluster-level clear → fan out to every member so the
                  // link history stays consistent across fragments.
                  for (const m of cluster.members) {
                    await railway.clearMovementLink(m.id);
                  }
                  onMutated();
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
              className="text-[11px] flex items-center gap-1 px-2 py-1 rounded mt-2"
              style={{ background: '#fce8e6', color: '#c5221f' }}
            >
              <Trash2 size={11} /> Mark unrelated
            </button>
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
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
