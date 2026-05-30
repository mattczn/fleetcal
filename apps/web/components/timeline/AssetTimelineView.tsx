'use client';

/**
 * Asset timeline — side-by-side day view of scheduled events vs.
 * actual movements for one truck.
 *
 * Time axis runs 0:00 → 24:00 in org TZ, fixed for v1 (we'll auto-fit
 * to activity later). Both columns scroll on the same axis so a
 * dispatcher can scan left↔right at any time and see "schedule said X,
 * truck actually did Y."
 *
 * Display only in this PR — clicking is informational. PR 3 adds:
 *   - Click a movement → edit its link
 *   - "+ Add manual movement" — manual movement creation
 *   - "Re-link" — AI auto-link endpoint
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, ArrowLeft,
  Truck, MapPin, Clock, Sparkles,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import { railway, type TimelinePayload, type TimelineEvent, type TimelineMovement, type TimelineLink } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';

// ── Geometry ───────────────────────────────────────────────────────────

const HOUR_HEIGHT_PX = 60;
const TOTAL_HEIGHT   = 24 * HOUR_HEIGHT_PX;

/** Minutes-of-day for a UTC ISO timestamp, viewed in `tz`. Anchors
 *  the timeline to org wall-clock so 8am org-local lands at the same
 *  Y regardless of where the viewer is. */
function minutesOfDayInTz(iso: string, tz: string): number {
  // formatToParts gives us org-local hour/minute cleanly.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h === 24 ? 0 : h) * 60 + m;
}

/** Returns the org-local YYYY-MM-DD a UTC ISO falls on. */
function dateKeyInTz(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
  return parts; // 'en-CA' yields YYYY-MM-DD directly
}

function fmtTimeInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit',
  });
}

function fmtDateHeader(dateKey: string, tz: string): string {
  // Build a midday timestamp for the date so the formatter doesn't slip
  // into the prior/next day on TZ conversion.
  const naiveMid = `${dateKey}T12:00:00`;
  const epoch = parseNaiveIsoInTz(naiveMid, tz);
  const today = dateKeyInTz(new Date().toISOString(), tz);
  const tmrw  = (() => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const yest = (() => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const pretty = new Date(epoch).toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    year: new Date(epoch).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
  if (dateKey === today) return `Today · ${pretty}`;
  if (dateKey === tmrw)  return `Tomorrow · ${pretty}`;
  if (dateKey === yest)  return `Yesterday · ${pretty}`;
  return pretty;
}

function shiftDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Block positioning ──────────────────────────────────────────────────

/** Vertical span in pixels for an item that may extend outside the day.
 *  If the item's day key !== current day, the top/bottom get clipped
 *  to the day edges; we mark spansBefore/After so the chip can show a
 *  "continues" hint. */
function positionFor(startIso: string, endIso: string | undefined, dayKey: string, tz: string): {
  topPx: number; heightPx: number; spansBefore: boolean; spansAfter: boolean;
} {
  const startKey = dateKeyInTz(startIso, tz);
  const endKey   = endIso ? dateKeyInTz(endIso, tz) : startKey;
  const spansBefore = startKey < dayKey;
  const spansAfter  = endKey   > dayKey;

  const topMin = spansBefore ? 0 : minutesOfDayInTz(startIso, tz);
  const botMin = spansAfter
    ? 24 * 60
    : (endIso ? minutesOfDayInTz(endIso, tz) : topMin + 30);
  const topPx    = (topMin / 60) * HOUR_HEIGHT_PX;
  const heightPx = Math.max(24, ((botMin - topMin) / 60) * HOUR_HEIGHT_PX);
  return { topPx, heightPx, spansBefore, spansAfter };
}

// ── Now line ───────────────────────────────────────────────────────────

function NowLine({ dayKey, tz }: { dayKey: string; tz: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (dateKeyInTz(now.toISOString(), tz) !== dayKey) return null;
  const top = (minutesOfDayInTz(now.toISOString(), tz) / 60) * HOUR_HEIGHT_PX;
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

// ── Role / source labels ───────────────────────────────────────────────

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

// ── Main view ──────────────────────────────────────────────────────────

export default function AssetTimelineView({ assetId }: { assetId: number }) {
  const { calendarTimezone } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';

  const todayKey = dateKeyInTz(new Date().toISOString(), tz);
  const [dayKey, setDayKey] = useState<string>(todayKey);

  const [data, setData]       = useState<TimelinePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Window: 6h before day start → 6h after day end, in UTC, so we
  // catch overflowing events/movements that the day view should still
  // partially render. Wider than the visible 24h on purpose.
  const window = useMemo(() => {
    const startEpoch = parseNaiveIsoInTz(`${dayKey}T00:00:00`, tz);
    const endEpoch   = parseNaiveIsoInTz(`${dayKey}T23:59:59`, tz);
    const padMs = 6 * 60 * 60 * 1000;
    return {
      from: new Date(startEpoch - padMs).toISOString(),
      to:   new Date(endEpoch   + padMs).toISOString(),
    };
  }, [dayKey, tz]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.getAssetTimeline(assetId, window.from, window.to)
      .then((res) => { if (!cancelled) { setData(res); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [assetId, window.from, window.to]);

  // Index links by movement_id (current truth only — server already
  // filters superseded_at IS NULL).
  const linkByMovementId = useMemo(() => {
    const m = new Map<string, TimelineLink>();
    for (const l of data?.links ?? []) m.set(l.movementId, l);
    return m;
  }, [data?.links]);

  // Index events by id for link-target lookups (so a movement linked
  // to Load X can show "→ Load X" with the load's title).
  const eventById = useMemo(() => {
    const m = new Map<string, TimelineEvent>();
    for (const e of data?.events ?? []) m.set(e.id, e);
    return m;
  }, [data?.events]);

  // Filter to items that intersect the visible day.
  const visibleEvents = useMemo(() => {
    return (data?.events ?? []).filter((e) => {
      const sk = dateKeyInTz(e.start, tz);
      const ek = dateKeyInTz(e.end,   tz);
      return sk <= dayKey && ek >= dayKey;
    });
  }, [data?.events, dayKey, tz]);

  const visibleMovements = useMemo(() => {
    return (data?.movements ?? []).filter((m) => {
      const sk = dateKeyInTz(m.startTime, tz);
      const ek = m.endTime ? dateKeyInTz(m.endTime, tz) : sk;
      return sk <= dayKey && ek >= dayKey;
    });
  }, [data?.movements, dayKey, tz]);

  const asset = data?.asset;

  return (
    <AppShell>
      <div className="max-w-[1400px] mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <Link
            href="/calendar"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
          >
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2">
            <Truck size={20} style={{ color: 'var(--gc-blue)' }} />
            <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>
              {asset ? `${asset.name}${asset.unit ? ` · #${asset.unit}` : ''}` : 'Loading…'}
            </h1>
          </div>
        </div>

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

        {/* Body */}
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
                Actual · {visibleMovements.length} movement{visibleMovements.length !== 1 ? 's' : ''}
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
                  visibleEvents.map((e) => <EventBlock key={e.id} event={e} dayKey={dayKey} tz={tz} />)
                )}
                <NowLine dayKey={dayKey} tz={tz} />
              </div>

              {/* Movements column */}
              <div className="relative border-l" style={{ borderColor: 'var(--gc-border)' }}>
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0"
                    style={{ top: h * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX, borderTop: h === 0 ? 'none' : '1px solid var(--gc-border)' }}
                  />
                ))}
                {visibleMovements.length === 0 ? (
                  <div className="absolute inset-0 flex items-center justify-center text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                    No movements
                  </div>
                ) : (
                  visibleMovements.map((m) => (
                    <MovementBlock
                      key={m.id}
                      movement={m}
                      link={linkByMovementId.get(m.id)}
                      eventLookup={eventById}
                      dayKey={dayKey}
                      tz={tz}
                    />
                  ))
                )}
                <NowLine dayKey={dayKey} tz={tz} />
              </div>
            </div>
          </div>
        )}

        {/* Footer hints — coming-soon affordances so the page reads
            as "v1 of N" instead of feeling unfinished. */}
        <div className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
          <Sparkles size={14} />
          AI auto-link, manual movement creation, and click-to-edit links land in PR 3.
        </div>
      </div>
    </AppShell>
  );
}

// ── EventBlock ─────────────────────────────────────────────────────────

function EventBlock({ event, dayKey, tz }: { event: TimelineEvent; dayKey: string; tz: string }) {
  const pos = positionFor(event.start, event.end, dayKey, tz);
  const pickup   = event.stops.find((s) => s.type === 'pickup');
  const delivery = [...event.stops].reverse().find(
    (s) => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook',
  );
  const isNonRev = event.eventKind === 'non_revenue';

  return (
    <div
      className="absolute left-1 right-1 rounded-md p-2 overflow-hidden text-[11px]"
      style={{
        top:        pos.topPx,
        height:     pos.heightPx,
        background: isNonRev ? '#fef7e0' : '#e8f0fe',
        borderLeft: `3px solid ${isNonRev ? '#f9ab00' : '#1a73e8'}`,
      }}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
          {event.title ?? (isNonRev ? event.nonRevenueType ?? 'Non-revenue' : 'Untitled')}
        </div>
        <div className="text-[10px] tabular-nums whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
          {fmtTimeInTz(event.start, tz)} – {fmtTimeInTz(event.end, tz)}
        </div>
      </div>
      {event.driverName ? (
        <div className="truncate" style={{ color: 'var(--gc-text-2)' }}>{event.driverName}</div>
      ) : null}
      {pickup || delivery ? (
        <div className="mt-1 space-y-0.5">
          {pickup ? (
            <div className="flex items-start gap-1.5">
              <MapPin size={10} style={{ color: '#16a34a', marginTop: 2 }} />
              <div className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                <span className="font-semibold">P:</span> {pickup.city ?? '—'}{pickup.state ? `, ${pickup.state}` : ''}
                {pickup.facilityName ? ` · ${pickup.facilityName}` : ''}
              </div>
            </div>
          ) : null}
          {delivery ? (
            <div className="flex items-start gap-1.5">
              <MapPin size={10} style={{ color: '#dc2626', marginTop: 2 }} />
              <div className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                <span className="font-semibold">D:</span> {delivery.city ?? '—'}{delivery.state ? `, ${delivery.state}` : ''}
                {delivery.facilityName ? ` · ${delivery.facilityName}` : ''}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {pos.spansBefore || pos.spansAfter ? (
        <div className="absolute right-1 bottom-1 text-[9px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {pos.spansBefore ? 'starts earlier' : ''}{pos.spansBefore && pos.spansAfter ? ' · ' : ''}{pos.spansAfter ? 'continues' : ''}
        </div>
      ) : null}
    </div>
  );
}

// ── MovementBlock ──────────────────────────────────────────────────────

function MovementBlock({
  movement, link, eventLookup, dayKey, tz,
}: {
  movement: TimelineMovement;
  link: TimelineLink | undefined;
  eventLookup: Map<string, TimelineEvent>;
  dayKey: string;
  tz: string;
}) {
  const pos = positionFor(movement.startTime, movement.endTime, dayKey, tz);
  const role = link ? ROLE_COLORS[link.role] : null;
  const source = SOURCE_BADGE[movement.source];

  // For transitions, show "From X → To Y" where possible
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
    return ROLE_COLORS[link.role]?.label ?? null;
  })();

  return (
    <div
      className="absolute left-1 right-1 rounded-md p-2 overflow-hidden text-[11px]"
      style={{
        top:        pos.topPx,
        height:     pos.heightPx,
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
      }}
    >
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <Clock size={10} style={{ color: 'var(--gc-text-3)' }} />
          <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
            {fmtTimeInTz(movement.startTime, tz)}
            {movement.endTime ? `–${fmtTimeInTz(movement.endTime, tz)}` : ''}
          </span>
        </div>
        {source ? (
          <span className="text-[9px] uppercase tracking-wider" style={{ color: source.fg }}>
            {source.label}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 mb-1" style={{ color: 'var(--gc-text-2)' }}>
        {typeof movement.miles === 'number' ? <span className="tabular-nums">{movement.miles.toFixed(1)} mi</span> : null}
        {movement.durationMin ? <span className="tabular-nums">· {movement.durationMin} min</span> : null}
      </div>
      {movement.origin || movement.destination ? (
        <div className="flex items-start gap-1 truncate" style={{ color: 'var(--gc-text-3)' }}>
          <MapPin size={10} style={{ marginTop: 2 }} />
          <span className="truncate">
            {(movement.origin ?? '—').split(',')[0]} → {(movement.destination ?? '—').split(',')[0]}
          </span>
        </div>
      ) : null}

      {/* Link chip */}
      {link ? (
        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
            style={{ background: role?.bg, color: role?.fg }}
          >
            {role?.label ?? link.role}
          </span>
          {linkLabel ? (
            <span className="truncate text-[10px]" style={{ color: 'var(--gc-text-2)' }}>
              {linkLabel}
            </span>
          ) : null}
          {link.confidence ? (
            <span
              className="text-[9px] uppercase tracking-wider"
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
        </div>
      ) : (
        <div className="mt-1.5">
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
            style={{ background: '#f1f3f4', color: '#5f6368' }}
          >
            Unlinked
          </span>
        </div>
      )}

      {pos.spansBefore || pos.spansAfter ? (
        <div className="absolute right-1 bottom-1 text-[9px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {pos.spansBefore ? 'started earlier' : ''}{pos.spansBefore && pos.spansAfter ? ' · ' : ''}{pos.spansAfter ? 'continues' : ''}
        </div>
      ) : null}
    </div>
  );
}
