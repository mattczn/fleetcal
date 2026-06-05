'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronUp, ChevronDown, Layers, Truck, User, LayoutDashboard, EyeOff, Eye } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useModules } from '@/lib/useModules';
import { sanitizeTimezone, parseNaiveIsoInTz } from '@/lib/time-utils';
import type { CalendarEvent, EventStatus, Asset } from '@/lib/types';
import CopyChip from '@/components/ui/CopyChip';
import WindowTimeline from '@/components/ui/WindowTimeline';
import Tooltip from '@/components/ui/Tooltip';

// ── Status helpers ─────────────────────────────────────────────────────────────

type StatusMeta = { label: string; bg: string; color: string; border: string };

const STATUS_META: Record<string, StatusMeta> = {
  upcoming:    { label: 'Upcoming',    bg: '#f1f3f4', color: '#5f6368', border: '#dadce0' },
  in_progress: { label: 'In Progress', bg: '#e8f0fe', color: '#1a73e8', border: '#c5d8fd' },
  completed:   { label: 'Completed',   bg: '#e6f4ea', color: '#137333', border: '#b7dfbf' },
  assigned:    { label: 'Assigned',    bg: '#ede9fe', color: '#5b21b6', border: '#c4b5fd' },
  dispatched:  { label: 'Dispatched',  bg: '#e8f0fe', color: '#1558d6', border: '#c5d8fd' },
  picked_up:   { label: 'Picked Up',   bg: '#f3e8fd', color: '#7627bb', border: '#ddb9f7' },
  delivered:   { label: 'Delivered',   bg: '#e6f4ea', color: '#137333', border: '#b7dfbf' },
  tonu:        { label: 'TONU',        bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
  cancelled:   { label: 'Cancelled',   bg: '#fce8e6', color: '#c5221f', border: '#f5c6c5' },
  problem:     { label: 'Problem',     bg: '#fef0e6', color: '#b85c00', border: '#fcd7a6' },
};

type FilterKey = 'all' | 'upcoming' | 'in_progress' | 'completed';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all',         label: 'All'         },
  { key: 'upcoming',    label: 'Upcoming'    },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed',   label: 'Completed'   },
];

// Event start/end are naive ISO ("YYYY-MM-DDTHH:mm", no zone) meant
// to be read in the org's dispatch timezone. JavaScript's Date parser
// interprets naive ISO as the BROWSER's local zone — so a dispatcher
// in ET viewing an MT-based org sees an offset shift on every
// comparison. parseNaiveIsoInTz fixes that by binding the wall-time
// to the org's tz before producing UTC ms. When tz is undefined we
// fall back to native parsing (orgs with no tz set).
function derivedKey(ev: CalendarEvent, tz?: string): string {
  const now = Date.now();
  if (parseNaiveIsoInTz(ev.start, tz) > now) return 'upcoming';
  if (parseNaiveIsoInTz(ev.end,   tz) < now) return 'completed';
  return 'in_progress';
}

function statusKey(ev: CalendarEvent, tz?: string): string {
  const manual: EventStatus[] = ['dispatched', 'picked_up', 'delivered', 'tonu', 'cancelled', 'problem'];
  if (ev.status && manual.includes(ev.status)) return ev.status;
  return derivedKey(ev, tz);
}

const WINDOW_HOURS = 12;
const STEP_HOURS   = 12;

function isInWindow(ev: CalendarEvent, start: Date, end: Date, tz?: string): boolean {
  return parseNaiveIsoInTz(ev.start, tz) < end.getTime()
      && parseNaiveIsoInTz(ev.end,   tz) > start.getTime();
}

function fmtBound(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });
}

// Format the pivot timestamp shown in the tray header (e.g.
// "Thu, May 14 3:04 PM"). Falls back to the browser's local zone only
// when the org hasn't configured a timezone in Settings → Timezone.
function fmtPivot(d: Date, tz?: string): string {
  // Pull minutes IN the requested tz so the omit-zero-minutes
  // optimization stays correct for half-hour offsets (India, etc.).
  const minute = tz
    ? Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric' })
        .formatToParts(d)
        .find(p => p.type === 'minute')?.value ?? '0')
    : d.getMinutes();
  return d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: minute ? '2-digit' : undefined, hour12: true });
}

// Compact range display for load rows (e.g. "7a-6p" / "12:30p-6p").
// Extracts hour+minute in the supplied timezone via formatToParts —
// .getHours() / .getMinutes() return values in the browser's local
// zone which is what we're explicitly trying to NOT use here.
function fmtTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  let h: number;
  let m: number;
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(d);
    h = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
    m = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
  } else {
    h = d.getHours();
    m = d.getMinutes();
  }
  const ampm = h >= 12 ? 'p' : 'a';
  const hh = h % 12 || 12;
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, '0')}${ampm}`;
}

// ── Chip definitions ────────────────────────────────────────────────────────────

type Chip = { key: EventStatus; label: string; group: 'progress' | 'exception' };

const CHIPS: Chip[] = [
  { key: 'dispatched', label: 'Dispatched', group: 'progress'  },
  { key: 'picked_up',  label: 'Picked Up',  group: 'progress'  },
  { key: 'delivered',  label: 'Delivered',  group: 'progress'  },
  { key: 'tonu',       label: 'TONU',       group: 'exception' },
  { key: 'cancelled',  label: 'Cancelled',  group: 'exception' },
  { key: 'problem',    label: 'Problem',    group: 'exception' },
];

const PROGRESS_CHIPS  = CHIPS.filter(c => c.group === 'progress');
const EXCEPTION_CHIPS = CHIPS.filter(c => c.group === 'exception');

// ── Load row ───────────────────────────────────────────────────────────────────

function LoadRow({
  ev, asset, selected, batchMode, onToggleSelect, onStatusChange, onOpenLoad, onHide, isHidden, orgTz,
}: {
  ev: CalendarEvent;
  asset: Asset | undefined;
  selected: boolean;
  batchMode: boolean;
  onToggleSelect: () => void;
  onStatusChange: (id: string, status: EventStatus | undefined) => void;
  onOpenLoad: (id: string) => void;
  onHide: () => void;
  isHidden?: boolean;
  orgTz?: string;
}) {
  const sk       = statusKey(ev, orgTz);
  const meta     = STATUS_META[sk] ?? STATUS_META.upcoming;
  const isManual = ['dispatched', 'picked_up', 'delivered', 'tonu', 'cancelled', 'problem'].includes(sk);

  const handleChip = (chipKey: EventStatus) => {
    onStatusChange(ev.id, ev.status === chipKey ? undefined : chipKey);
  };

  return (
    <div
      className="flex items-center gap-3 px-4 border-b"
      style={{
        borderColor: 'var(--gc-border-light)',
        background: selected ? '#eef2fd' : 'transparent',
        minWidth: 0,
        height: 40,
      }}
    >
      {/* Checkbox / color dot */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onToggleSelect(); }}
        className="shrink-0 flex items-center justify-center"
        style={{ width: 18, height: 18, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
      >
        {batchMode ? (
          selected
            ? <svg width="16" height="16" viewBox="0 0 16 16" fill="#1a73e8"><rect rx="2" width="16" height="16"/><path d="M4 8l3 3 5-5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
            : <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect rx="2" width="16" height="16" stroke="var(--gc-border)" strokeWidth="1.5"/></svg>
        ) : (
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: asset?.color ?? '#94a3b8', display: 'block', flexShrink: 0 }} />
        )}
      </button>

      {/* Asset name + unit */}
      <span className="shrink-0 text-xs font-semibold" style={{ color: 'var(--gc-text-1)', whiteSpace: 'nowrap', width: 100, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {asset?.name ?? '—'}{asset?.unit ? <span style={{ color: 'var(--gc-text-3)', fontWeight: 500 }}> #{asset.unit}</span> : null}
      </span>

      {/* Driver */}
      <span className="shrink-0 text-xs" style={{ color: 'var(--gc-text-2)', whiteSpace: 'nowrap', width: 90, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {ev.driverName || '—'}
      </span>

      {/* Load # (revenue) or non-revenue type pill */}
      <span style={{ width: 76, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        {ev.eventKind === 'non_revenue' && ev.nonRevenueType ? (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: '#7c3aed', borderRadius: 9999, padding: '1px 8px', whiteSpace: 'nowrap' }}>
            {ev.nonRevenueType}
          </span>
        ) : ev.loadNum ? (
          <CopyChip value={ev.loadNum} style={{ fontSize: 11, fontWeight: 700, color: '#1a73e8' }} />
        ) : null}
      </span>

      {/* Time range */}
      <span className="shrink-0 text-[11px] font-medium tabular-nums" style={{ color: 'var(--gc-text-3)', whiteSpace: 'nowrap', width: 72 }}>
        {fmtTime(ev.start, orgTz)}–{fmtTime(ev.end, orgTz)}
      </span>

      {/* Title → opens modal */}
      <button
        type="button"
        onClick={() => onOpenLoad(ev.id)}
        className="text-xs font-bold truncate text-left"
        style={{ color: 'var(--gc-text-1)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, flex: 1, minWidth: 0, textDecoration: 'underline', textDecorationColor: 'var(--gc-border)', textUnderlineOffset: 3 }}
        onMouseEnter={e => { e.currentTarget.style.color = '#1a73e8'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-1)'; }}
      >
        {ev.title}
      </button>


      {/* Progress chips */}
      <div className="flex items-center gap-1 shrink-0">
        {PROGRESS_CHIPS.map(chip => {
          const active = ev.status === chip.key;
          const cm = STATUS_META[chip.key];
          return (
            <button key={chip.key} type="button" onClick={e => { e.stopPropagation(); handleChip(chip.key); }}
              className="text-[11px] font-medium px-2 py-0.5 rounded-lg transition-all"
              style={{ background: active ? cm.bg : 'transparent', color: active ? cm.color : 'var(--gc-text-3)', border: `1px solid ${active ? cm.border : 'var(--gc-border)'}`, cursor: 'pointer' }}
              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = cm.bg; e.currentTarget.style.color = cm.color; e.currentTarget.style.borderColor = cm.border; } }}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.borderColor = 'var(--gc-border)'; } }}>
              {chip.label}
            </button>
          );
        })}
      </div>

      <div style={{ width: 1, height: 18, background: 'var(--gc-border)', flexShrink: 0 }} />

      {/* Exception chips */}
      <div className="flex items-center gap-1 shrink-0">
        {EXCEPTION_CHIPS.map(chip => {
          const active = ev.status === chip.key;
          const cm = STATUS_META[chip.key];
          return (
            <button key={chip.key} type="button" onClick={e => { e.stopPropagation(); handleChip(chip.key); }}
              className="text-[11px] font-medium px-2 py-0.5 rounded-lg transition-all"
              style={{ background: active ? cm.bg : 'transparent', color: active ? cm.color : 'var(--gc-text-3)', border: `1px solid ${active ? cm.border : 'var(--gc-border)'}`, cursor: 'pointer' }}
              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = cm.bg; e.currentTarget.style.color = cm.color; e.currentTarget.style.borderColor = cm.border; } }}
              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.borderColor = 'var(--gc-border)'; } }}>
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Clear manual */}
      {isManual && (
        <button type="button" onClick={e => { e.stopPropagation(); onStatusChange(ev.id, undefined); }}
          className="shrink-0 text-[10px] px-1.5 rounded transition-colors"
          style={{ color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: '20px' }}
          title="Clear manual status"
          onMouseEnter={e => { e.currentTarget.style.color = '#c5221f'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
          ✕
        </button>
      )}

      {/* Hide / unhide */}
      <Tooltip content={isHidden ? 'Unhide' : 'Hide'}>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onHide(); }}
          className="shrink-0"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', display: 'flex', alignItems: 'center', color: 'var(--gc-text-3)' }}
          onMouseEnter={e => { e.currentTarget.style.color = isHidden ? '#1a73e8' : 'var(--gc-text-1)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; }}
        >
          {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </Tooltip>
    </div>
  );
}

// ── Main tray ──────────────────────────────────────────────────────────────────

export default function TodaysTray() {
  const { events, assets, updateEvent, openEditModal, setTrayOpen, calendarTimezone, cardFontScale } = useCalendarStore();
  // Gates the inline "Command Center" jump button on the tray header.
  // The /board route itself is RequireCap-protected; this hides the
  // dead-end link from MVP orgs that don't have dispatch_board enabled.
  const { enabled: moduleEnabled } = useModules();
  const showCommandCenterButton = moduleEnabled('dispatch_board');
  // Org's configured timezone — drives the header pivot timestamp +
  // every load row's time range. Stored as a raw IANA string in
  // store.calendarTimezone (NOT promptVariables.timezone, which holds
  // a verbose label like "Mountain Time (America/Denver)" used by
  // the AI rate-con prompt). sanitize is a defensive net for legacy
  // values + any non-IANA garbage so Intl.DateTimeFormat can't throw.
  const orgTz = sanitizeTimezone(calendarTimezone);
  const router = useRouter();
  const [expanded,        setExpanded]        = useState(false);
  const [batchMode,       setBatchMode]       = useState(false);
  const [selected,        setSelected]        = useState<Set<string>>(new Set());
  const [filter,          setFilter]          = useState<FilterKey>('all');
  const [pivotTime,       setPivotTime]       = useState<Date>(() => new Date());
  const [hiddenIds,       setHiddenIds]       = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('dispatch-board-hidden-ids');
      if (saved) return new Set<string>(JSON.parse(saved));
    } catch { /* ignore */ }
    return new Set<string>();
  });
  const [hiddenExpanded,  setHiddenExpanded]  = useState(false);

  const windowStart = useMemo(() => new Date(pivotTime.getTime() - WINDOW_HOURS * 3600 * 1000), [pivotTime]);
  const windowEnd   = useMemo(() => new Date(pivotTime.getTime() + WINDOW_HOURS * 3600 * 1000), [pivotTime]);
  const isAtNow     = Math.abs(pivotTime.getTime() - Date.now()) < 5 * 60 * 1000;
  const shiftPivot  = (hours: number) => setPivotTime(p => new Date(p.getTime() + hours * 3600 * 1000));

  const todayLoads = useMemo(() =>
    events.filter(ev => isInWindow(ev, windowStart, windowEnd, orgTz))
          .sort((a, b) => a.start.localeCompare(b.start)),
  [events, windowStart, windowEnd, orgTz]);

  const filteredLoads = useMemo(() => {
    if (filter === 'all') return todayLoads;
    return todayLoads.filter(ev => derivedKey(ev, orgTz) === filter);
  }, [todayLoads, filter, orgTz]);

  const filterCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = { all: todayLoads.length, upcoming: 0, in_progress: 0, completed: 0 };
    for (const ev of todayLoads) {
      const dk = derivedKey(ev, orgTz) as FilterKey;
      if (dk in counts) counts[dk]++;
    }
    return counts;
  }, [todayLoads, orgTz]);

  const assetMap = useMemo(() => {
    const m = new Map<number, Asset>();
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets]);

  const handleStatusChange = useCallback((id: string, status: EventStatus | undefined) => {
    updateEvent(id, { status: status ?? 'scheduled' });
  }, [updateEvent]);

  const handleBatchApply = (status: EventStatus) => {
    for (const id of selected) updateEvent(id, { status });
    setSelected(new Set());
    setBatchMode(false);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    setTrayOpen(next);
  };
  const toggleBatchMode = () => { setBatchMode(b => !b); setSelected(new Set()); };

  const toggleHide = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('dispatch-board-hidden-ids', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const visibleLoads = filteredLoads.filter(ev => !hiddenIds.has(ev.id));
  const hiddenLoads  = filteredLoads.filter(ev =>  hiddenIds.has(ev.id));

  if (todayLoads.length === 0) return null;

  const EXCEPTION_KEYS: EventStatus[] = ['tonu', 'cancelled', 'problem'];
  const exceptionCount  = todayLoads.filter(ev => ev.status && EXCEPTION_KEYS.includes(ev.status)).length;
  const inProgressCount = todayLoads.filter(ev => statusKey(ev, orgTz) === 'in_progress').length;

  return (
    <div
      className="ui-scale-scope fixed bottom-0 left-0 right-0 z-40 flex flex-col"
      style={{
        background: 'var(--gc-surface)',
        borderTop: '1px solid var(--gc-border)',
        boxShadow: '0 -2px 8px rgba(0,0,0,.08)',
        overflow: 'hidden',
        // Drawer caps at 32% of viewport height so the grid above stays
        // workable on smaller (laptop) screens. The expanded panel below
        // pairs this with its own internal maxHeight so the content
        // scrolls instead of pushing the cap.
        maxHeight: '32vh',
        // Opt into Settings → Appearance scale (CSS overrides in
        // globals.css multiply text utilities by --ui-scale).
        ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1,
      } as React.CSSProperties}
    >
      {/* Collapsed / header bar */}
      <div className="flex items-center gap-3 px-5"
        style={{ height: 48, paddingBottom: 8, background: '#1a73e8' }}>
        {/* Clickable toggle area */}
        <div role="button" tabIndex={0} onClick={toggleExpanded}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggleExpanded(); }}
          className="flex items-center gap-3 flex-1 cursor-pointer min-w-0">
          <Layers size={15} style={{ color: 'rgba(255,255,255,0.8)', flexShrink: 0 }} />
          <span className="text-sm font-semibold" style={{ color: '#fff' }}>{isAtNow ? "Today's Loads" : fmtPivot(pivotTime, orgTz)}</span>
          <span className="text-xs font-medium px-2 py-0.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}>
            {todayLoads.length}
          </span>
          {inProgressCount > 0 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.18)', color: '#fff' }}>
              {inProgressCount} in progress
            </span>
          )}
          {exceptionCount > 0 && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-lg"
              style={{ background: 'rgba(255,200,150,0.25)', color: '#ffe0b2' }}>
              {exceptionCount} exception{exceptionCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        {showCommandCenterButton && (
          <button
            type="button"
            onClick={() => router.push('/board')}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors shrink-0"
            style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.25)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
          >
            <LayoutDashboard size={12} />
            Command Center
          </button>
        )}
        <div role="button" tabIndex={0} onClick={toggleExpanded}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') toggleExpanded(); }}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
          {expanded
            ? <ChevronDown size={16} style={{ color: 'rgba(255,255,255,0.8)', flexShrink: 0 }} />
            : <ChevronUp   size={16} style={{ color: 'rgba(255,255,255,0.8)', flexShrink: 0 }} />
          }
        </div>
      </div>

      {/* Expanded panel — internal maxHeight clamped to the smaller of
          a fixed pixel ceiling and a viewport-relative cap so laptop
          screens stay workable above the drawer. The outer wrapper
          enforces a 32vh hard cap on top of this. */}
      {expanded && (
        <div style={{ maxHeight: 'min(320px, calc(32vh - 48px))', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--gc-border-light)' }}>

          {/* Toolbar: filters + date + batch */}
          <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
            {/* Filter tabs */}
            <div className="flex items-center gap-1">
              {FILTERS.map(f => {
                const active = filter === f.key;
                const count  = filterCounts[f.key];
                return (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                    className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg transition-all"
                    style={{
                      background: active ? '#1a73e8' : 'transparent',
                      color:      active ? '#fff'     : 'var(--gc-text-2)',
                      border:     `1px solid ${active ? '#1a73e8' : 'var(--gc-border)'}`,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                    {f.label}
                    <span className="text-[10px] font-medium opacity-75">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1" />

            {/* Window nav: [−12h] Showing loads from … to … [+12h] [Now] */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button type="button" onClick={() => shiftPivot(-STEP_HOURS)}
                style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >−12 hours</button>
              <WindowTimeline start={windowStart} end={windowEnd} />
              <button type="button" onClick={() => shiftPivot(STEP_HOURS)}
                style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >+12 hours</button>
              {!isAtNow && (
                <button type="button" onClick={() => setPivotTime(new Date())}
                  style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: '#1558d6' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(26,115,232,0.08)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >Now</button>
              )}
            </div>

            {/* Batch toggle */}
            <button type="button" onClick={toggleBatchMode}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              style={{
                background: batchMode ? '#e8f0fe' : 'transparent',
                color:      batchMode ? '#1a73e8' : 'var(--gc-text-2)',
                border:     `1px solid ${batchMode ? '#c5d8fd' : 'var(--gc-border)'}`,
                cursor: 'pointer',
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="4" height="4" rx="1"/><rect x="3" y="13" width="4" height="4" rx="1"/>
                <line x1="10" y1="7" x2="21" y2="7"/><line x1="10" y1="15" x2="21" y2="15"/>
              </svg>
              Batch
            </button>
          </div>

          {/* Load rows */}
          <div style={{ overflowY: 'auto', flex: 1, paddingBottom: 8 }}>
            {visibleLoads.length === 0 && hiddenLoads.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm" style={{ color: 'var(--gc-text-3)' }}>
                No {filter === 'all' ? '' : FILTERS.find(f => f.key === filter)?.label.toLowerCase() + ' '}loads today
              </div>
            ) : (
              <>
                {visibleLoads.map(ev => (
                  <LoadRow
                    key={ev.id}
                    ev={ev}
                    asset={assetMap.get(ev.assetId)}
                    selected={selected.has(ev.id)}
                    batchMode={batchMode}
                    onToggleSelect={() => toggleSelect(ev.id)}
                    onStatusChange={handleStatusChange}
                    onOpenLoad={openEditModal}
                    onHide={() => toggleHide(ev.id)}
                    orgTz={orgTz}
                  />
                ))}

                {/* Hidden loads section */}
                {hiddenLoads.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setHiddenExpanded(e => !e)}
                      className="flex items-center gap-2 w-full px-4"
                      style={{ height: 32, background: 'var(--gc-hover, #f1f3f4)', border: 'none', borderTop: '1px solid var(--gc-border-light)', cursor: 'pointer', color: 'var(--gc-text-3)', fontSize: 11, fontWeight: 600 }}
                    >
                      {hiddenExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      Hidden ({hiddenLoads.length})
                    </button>
                    {hiddenExpanded && hiddenLoads.map(ev => (
                      <LoadRow
                        key={ev.id}
                        ev={ev}
                        asset={assetMap.get(ev.assetId)}
                        selected={selected.has(ev.id)}
                        batchMode={batchMode}
                        onToggleSelect={() => toggleSelect(ev.id)}
                        onStatusChange={handleStatusChange}
                        onOpenLoad={openEditModal}
                        onHide={() => toggleHide(ev.id)}
                        isHidden
                        orgTz={orgTz}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Batch action bar */}
          {batchMode && selected.size > 0 && (
            <div className="flex items-center gap-2 px-4 py-2.5 shrink-0"
              style={{ borderTop: '1px solid var(--gc-border)', background: 'var(--gc-bg, #f8f9fa)' }}>
              <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                Apply to {selected.size} load{selected.size > 1 ? 's' : ''}:
              </span>
              {CHIPS.map(chip => {
                const cm = STATUS_META[chip.key];
                return (
                  <button key={chip.key} type="button" onClick={() => handleBatchApply(chip.key)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: cm.bg, color: cm.color, border: `1px solid ${cm.border}`, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '0.75'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}>
                    {chip.label}
                  </button>
                );
              })}
              <button type="button" onClick={() => setSelected(new Set())}
                className="ml-auto text-xs px-2 py-1 rounded"
                style={{ color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
