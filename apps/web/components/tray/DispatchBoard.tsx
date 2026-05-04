'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X, Star, RefreshCw, Truck, User, MapPin, LayoutDashboard, ChevronDown, ChevronUp, EyeOff, Eye } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { calcDirections } from '@/lib/directions';
import type { CalendarEvent, EventStatus, Asset } from '@/lib/types';
import MapDrawer from './MapDrawer';
import CopyChip from '@/components/ui/CopyChip';
import ManagementHeader from '@/components/nav/ManagementHeader';
import WindowTimeline from '@/components/ui/WindowTimeline';
import Tooltip from '@/components/ui/Tooltip';

// ── Types ──────────────────────────────────────────────────────────────────────

type ColumnKey = 'upcoming' | 'dispatched' | 'in_transit' | 'delivered' | 'issues';

type MotiveLocation = {
  vehicleId: string;
  description: string;
  lat: number;
  lon: number;
  locatedAt: string;
};

type DistanceResult = {
  miles: number;
  durationSeconds: number;
  truckDescription: string;
  target: 'pickup' | 'delivery';
  stale?: boolean;
};

// ── Status chip config ─────────────────────────────────────────────────────────

type ChipMeta = { label: string; activeBg: string; activeColor: string; activeBorder: string };

const CHIP_META: Record<string, ChipMeta> = {
  dispatched: { label: 'Dispatched', activeBg: 'rgba(26,115,232,0.10)', activeColor: '#1558d6', activeBorder: 'rgba(26,115,232,0.25)' },
  picked_up:  { label: 'Picked Up',  activeBg: 'rgba(118,39,187,0.08)', activeColor: '#6b21a8', activeBorder: 'rgba(118,39,187,0.22)' },
  delivered:  { label: 'Delivered',  activeBg: 'rgba(19,115,51,0.08)',  activeColor: '#15803d', activeBorder: 'rgba(19,115,51,0.22)'  },
  tonu:       { label: 'TONU',       activeBg: 'rgba(180,83,9,0.08)',   activeColor: '#92400e', activeBorder: 'rgba(180,83,9,0.22)'   },
  cancelled:  { label: 'Cancelled',  activeBg: 'rgba(185,28,28,0.08)',  activeColor: '#b91c1c', activeBorder: 'rgba(185,28,28,0.22)'  },
  problem:    { label: 'Problem',    activeBg: 'rgba(194,65,12,0.08)',  activeColor: '#c2410c', activeBorder: 'rgba(194,65,12,0.22)'  },
};

const COLUMN_CONFIG: Record<ColumnKey, { label: string; accentColor: string; emptyText: string }> = {
  upcoming:   { label: 'Upcoming',   accentColor: '#64748b', emptyText: 'No upcoming loads'  },
  dispatched: { label: 'Dispatched', accentColor: '#1d4ed8', emptyText: 'No dispatched loads' },
  in_transit: { label: 'In Transit', accentColor: '#7c3aed', emptyText: 'No loads in transit' },
  delivered:  { label: 'Delivered',  accentColor: '#15803d', emptyText: 'No delivered loads'  },
  issues:     { label: 'Issues',     accentColor: '#b45309', emptyText: 'No issues'            },
};

const COLUMN_ORDER: ColumnKey[] = ['issues', 'upcoming', 'dispatched', 'in_transit', 'delivered'];

const PROGRESS_CHIPS:  { key: EventStatus }[] = [{ key: 'dispatched' }, { key: 'picked_up' }, { key: 'delivered' }];
const EXCEPTION_CHIPS: { key: EventStatus }[] = [{ key: 'tonu' }, { key: 'cancelled' }, { key: 'problem' }];

// ── Helpers ────────────────────────────────────────────────────────────────────

function derivedKey(ev: CalendarEvent): 'upcoming' | 'in_progress' | 'completed' {
  const now = Date.now();
  if (new Date(ev.start).getTime() > now) return 'upcoming';
  if (new Date(ev.end).getTime() < now)   return 'completed';
  return 'in_progress';
}

function getColumn(ev: CalendarEvent): ColumnKey {
  const s = ev.status;
  if (s === 'tonu' || s === 'cancelled' || s === 'problem') return 'issues';
  if (s === 'delivered') return 'delivered';
  if (s === 'dispatched') return 'dispatched';
  if (s === 'picked_up' || s === 'en_route') return 'in_transit';
  const dk = derivedKey(ev);
  if (dk === 'completed') return 'delivered';
  if (dk === 'in_progress') return 'in_transit';
  return 'upcoming';
}

const WINDOW_HOURS = 12;
const STEP_HOURS   = 12;

function isInWindow(ev: CalendarEvent, start: Date, end: Date): boolean {
  return new Date(ev.start) < end && new Date(ev.end) > start;
}

function fmtBound(d: Date): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const date    = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time    = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });
  return `${weekday} ${date}, ${time}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours(), m = d.getMinutes();
  const hh = h % 12 || 12, ap = h >= 12 ? 'p' : 'a';
  return m === 0 ? `${hh}${ap}` : `${hh}:${String(m).padStart(2, '0')}${ap}`;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtEta(seconds: number, timezone?: string): string {
  const arrival = new Date(Date.now() + seconds * 1000);
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return arrival.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ── Star button with tooltip ───────────────────────────────────────────────────

function PriorityStar({ priority, onToggle, white: onWhite }: { priority?: boolean; onToggle: () => void; white?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const idleColor = onWhite ? 'rgba(255,255,255,0.5)' : 'var(--gc-text-3)';
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onToggle(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
      >
        <Star
          size={13}
          fill={priority ? '#f59e0b' : 'none'}
          style={{ color: priority ? '#f59e0b' : idleColor, transition: 'color 120ms' }}
        />
      </button>
      {hovered && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', right: 0,
          background: 'rgba(0,0,0,0.75)', color: '#fff',
          fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
          padding: '3px 8px', borderRadius: 6, pointerEvents: 'none', zIndex: 9999,
        }}>
          {priority ? 'Remove priority' : 'Mark as priority'}
        </div>
      )}
    </div>
  );
}

// ── Load card ──────────────────────────────────────────────────────────────────

function LoadCard({
  ev, asset, distance, onStatusChange, onPriorityToggle, onOpenLoad, onOpenMap, onHide,
}: {
  ev: CalendarEvent;
  asset: Asset | undefined;
  distance: DistanceResult | null;
  onStatusChange: (id: string, status: EventStatus | undefined) => void;
  onPriorityToggle: (id: string, priority: boolean) => void;
  onOpenLoad: (id: string) => void;
  onOpenMap: (id: string) => void;
  onHide: () => void;
}) {
  const eldLocations = useCalendarStore(s => s.eldLocations);
  const [statusOpen, setStatusOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const cardRef   = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  // Track card width to switch between compact / full location display
  useEffect(() => {
    if (!cardRef.current) return;
    const ro = new ResizeObserver(entries => {
      setCompact((entries[0]?.contentRect.width ?? 999) < 300);
    });
    ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!statusOpen) return;
    const handler = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [statusOpen]);

  const handleChip = (chipKey: EventStatus) => {
    onStatusChange(ev.id, ev.status === chipKey ? undefined : chipKey);
    setStatusOpen(false);
  };

  const assetColor = asset?.color ?? '#64748b';

  // Truck's current location from ELD (for all cards)
  const truckLoc = asset?.motiveVehicleId
    ? eldLocations.find(l => l.vehicleId === asset.motiveVehicleId) ?? null
    : null;

  // Timezone of the target stop for ETA display
  const targetTimezone = (() => {
    if (!distance) return undefined;
    const stops = ev.stops ?? [];
    const stop = distance.target === 'pickup'
      ? stops.find(s => s.type === 'pickup')
      : [...stops].reverse().find(s => s.type === 'delivery' || s.type === 'drop_hook' || s.type === 'drop');
    return stop?.timezone;
  })();

  const isManual = ['dispatched', 'picked_up', 'delivered', 'tonu', 'cancelled', 'problem'].includes(ev.status ?? '');

  // All text/icons are white on the colored card
  const white          = 'rgba(255,255,255,1)';
  const whiteMuted     = 'rgba(255,255,255,0.7)';
  const whiteDim       = 'rgba(255,255,255,0.45)';
  const chipIdle       = 'rgba(255,255,255,0.15)';
  const chipIdleBorder = 'rgba(255,255,255,0.25)';
  const chipActive     = 'rgba(255,255,255,0.9)';

  return (
    <div
      ref={cardRef}
      style={{
        background: assetColor,
        border: ev.priority ? '2px solid #fbbf24' : '1px solid rgba(255,255,255,0.15)',
        borderRadius: 10,
        boxShadow: ev.priority
          ? '0 0 0 3px rgba(251,191,36,0.25), 0 2px 8px rgba(0,0,0,0.25)'
          : '0 2px 6px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>

        {/* Row 1: truck name · [wide: location] | relay | driver | star */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Truck size={13} style={{ color: white, flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: white, whiteSpace: 'nowrap' }}>
            {asset?.name ?? '—'}{asset?.unit ? ` #${asset.unit}` : ''}
          </span>
          {/* Wide: full city/state + time ago in row 1 */}
          {truckLoc && !compact && (
            <>
              <span style={{ color: whiteDim, fontSize: 12, flexShrink: 0 }}>·</span>
              <button type="button" onClick={() => onOpenMap(ev.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0, flex: 1, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
                <MapPin size={11} style={{ color: whiteMuted, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: whiteMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textUnderlineOffset: 2 }}>
                  {truckLoc.description}
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, color: whiteDim, flexShrink: 0, whiteSpace: 'nowrap' }}>· {timeAgo(truckLoc.locatedAt)}</span>
              </button>
            </>
          )}
          {(!truckLoc || compact) && <div style={{ flex: 1 }} />}
          {ev.relayGroupId && (
            <span style={{
              flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              padding: '2px 6px', borderRadius: 6,
              background: 'rgba(255,255,255,0.18)', color: white,
              border: '1px solid rgba(255,255,255,0.3)', whiteSpace: 'nowrap',
            }}>
              ⇄ {ev.relayRole === 'pickup' ? 'Pickup' : ev.relayRole === 'delivery' ? 'Delivery' : 'Relay'}
            </span>
          )}
          {ev.driverName && (
            <>
              <User size={12} style={{ color: whiteMuted, flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: whiteMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 80 }}>
                {ev.driverName}
              </span>
            </>
          )}
          <PriorityStar priority={ev.priority} onToggle={() => onPriorityToggle(ev.id, !ev.priority)} white />
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onHide(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px', display: 'flex', alignItems: 'center', gap: 3, color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}
            onMouseEnter={e => {
              e.currentTarget.style.color = 'rgba(255,255,255,0.9)';
              const label = e.currentTarget.querySelector('.hide-label') as HTMLElement | null;
              if (label) label.style.display = 'inline';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.color = 'rgba(255,255,255,0.45)';
              const label = e.currentTarget.querySelector('.hide-label') as HTMLElement | null;
              if (label) label.style.display = 'none';
            }}
          >
            <EyeOff size={13} />
            <span className="hide-label" style={{ display: 'none', fontSize: 11, fontWeight: 600 }}>Hide</span>
          </button>
        </div>

        {/* Row 2: title → opens full modal (max 2 lines) */}
        <button
          type="button"
          onClick={() => onOpenLoad(ev.id)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', display: 'block', width: '100%' }}
        >
          <span style={{
            fontSize: 15, fontWeight: 700, color: white, lineHeight: 1.3,
            textDecoration: 'underline', textUnderlineOffset: 2, textDecorationColor: 'rgba(255,255,255,0.4)',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>
            {ev.title}
          </span>
        </button>

        {/* Row 3: load# · time range */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {ev.loadNum && (
            <CopyChip value={ev.loadNum} style={{ fontSize: 12, fontWeight: 700, color: whiteMuted }} />
          )}
          {ev.loadNum && <span style={{ fontSize: 12, color: whiteDim }}>·</span>}
          <span style={{ fontSize: 12, fontWeight: 600, color: whiteDim }}>
            {fmtTime(ev.start)}–{fmtTime(ev.end)}
          </span>
        </div>

        {/* Row 4: ETA line (only when ELD distance available) */}
        {distance && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: whiteMuted }}>
              {distance.miles} mi · {fmtDuration(distance.durationSeconds)} to {distance.target} · ETA {fmtEta(distance.durationSeconds, targetTimezone)}
            </span>
          </div>
        )}

        {/* Status row: status selector + [compact: pin + time ago aligned right] */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div ref={statusRef} style={{ position: 'relative', alignSelf: 'flex-start' }}>
          <button
            type="button"
            onClick={() => setStatusOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
              background: ev.status ? chipActive : chipIdle,
              color: ev.status ? assetColor : whiteMuted,
              border: `1px solid ${ev.status ? 'transparent' : chipIdleBorder}`,
              transition: 'all 120ms',
            }}
            onMouseEnter={e => { if (!ev.status) e.currentTarget.style.background = 'rgba(255,255,255,0.28)'; }}
            onMouseLeave={e => { if (!ev.status) e.currentTarget.style.background = chipIdle; }}
          >
            {ev.status ? CHIP_META[ev.status]?.label ?? ev.status
              : derivedKey(ev) === 'completed' ? 'Completed'
              : derivedKey(ev) === 'in_progress' ? 'In Transit'
              : 'Scheduled'}
            <ChevronDown size={11} style={{ opacity: 0.7 }} />
          </button>

          {statusOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 5px)', left: 0,
              background: 'var(--gc-surface)', borderRadius: 10,
              boxShadow: '0 4px 20px rgba(0,0,0,0.22)', border: '1px solid var(--gc-border-light)',
              zIndex: 60, minWidth: 155, overflow: 'hidden',
            }}>
              {([...PROGRESS_CHIPS, ...EXCEPTION_CHIPS] as { key: EventStatus }[]).map(({ key }, i) => {
                const active = ev.status === key;
                const meta = CHIP_META[key];
                const isException = i >= PROGRESS_CHIPS.length;
                return (
                  <button key={key} type="button" onClick={() => handleChip(key)}
                    style={{
                      width: '100%', textAlign: 'left', padding: '8px 13px',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'block',
                      background: active ? meta.activeBg : 'transparent',
                      color: active ? meta.activeColor : 'var(--gc-text-1)',
                      borderTop: i === PROGRESS_CHIPS.length ? '1px solid var(--gc-border-light)' : 'none',
                      border: 'none',
                      transition: 'background 100ms',
                    }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = active ? meta.activeBg : 'transparent'; }}
                  >
                    {meta.label}
                  </button>
                );
              })}
              {isManual && (
                <button type="button"
                  onClick={() => { onStatusChange(ev.id, undefined); setStatusOpen(false); }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '7px 13px',
                    fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'block',
                    background: 'transparent', color: '#9ca3af',
                    borderTop: '1px solid var(--gc-border-light)', border: 'none',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  ✕ Clear status
                </button>
              )}
            </div>
          )}
        </div>
          {/* Compact: pin + time ago, right-aligned */}
          {truckLoc && compact && (
            <button type="button" onClick={() => onOpenMap(ev.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', padding: 0, cursor: 'pointer', marginLeft: 'auto', flexShrink: 0 }}>
              <MapPin size={11} style={{ color: whiteMuted }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: whiteDim, whiteSpace: 'nowrap' }}>{timeAgo(truckLoc.locatedAt)}</span>
            </button>
          )}
        </div> {/* end status row */}
      </div>
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────────

function Column({
  columnKey, loads, assetMap, distances, onStatusChange, onPriorityToggle, onOpenLoad, onOpenMap,
  isDragOver, onDragStart, onDragOver, onDrop, hiddenIds, onHide,
}: {
  columnKey: ColumnKey;
  loads: CalendarEvent[];
  assetMap: Map<number, Asset>;
  distances: Map<string, DistanceResult>;
  onStatusChange: (id: string, status: EventStatus | undefined) => void;
  onPriorityToggle: (id: string, priority: boolean) => void;
  onOpenLoad: (id: string) => void;
  onOpenMap: (id: string) => void;
  isDragOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  hiddenIds: Set<string>;
  onHide: (id: string) => void;
}) {
  const cfg = COLUMN_CONFIG[columnKey];
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const sorted = [...loads].sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    return a.start.localeCompare(b.start);
  });
  const visible = sorted.filter(ev => !hiddenIds.has(ev.id));
  const hidden  = sorted.filter(ev =>  hiddenIds.has(ev.id));

  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--gc-bg)',
        border: isDragOver ? `2px dashed ${cfg.accentColor}` : '1px solid var(--gc-border-light)',
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'border 150ms',
        opacity: isDragOver ? 0.85 : 1,
      }}
    >
      {/* Header — drag handle */}
      <div
        draggable
        onDragStart={onDragStart}
        style={{
          padding: '10px 14px',
          borderBottom: `2px solid ${cfg.accentColor}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--gc-surface)',
          flexShrink: 0,
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Drag dots */}
          <svg width="8" height="12" viewBox="0 0 8 12" fill="none" style={{ opacity: 0.35, flexShrink: 0 }}>
            <circle cx="2" cy="2"  r="1.5" fill="currentColor"/>
            <circle cx="6" cy="2"  r="1.5" fill="currentColor"/>
            <circle cx="2" cy="6"  r="1.5" fill="currentColor"/>
            <circle cx="6" cy="6"  r="1.5" fill="currentColor"/>
            <circle cx="2" cy="10" r="1.5" fill="currentColor"/>
            <circle cx="6" cy="10" r="1.5" fill="currentColor"/>
          </svg>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: cfg.accentColor }}>
            {cfg.label}
          </span>
        </div>
        <span
          style={{
            fontSize: 11, fontWeight: 700, minWidth: 20, textAlign: 'center',
            padding: '1px 6px', borderRadius: 10,
            background: loads.length > 0 ? `${cfg.accentColor}14` : 'var(--gc-hover)',
            color: loads.length > 0 ? cfg.accentColor : 'var(--gc-text-3)',
          }}
        >
          {loads.length}
        </span>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        {visible.length === 0 && hidden.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 32, fontSize: 12, color: 'var(--gc-text-3)' }}>
            {cfg.emptyText}
          </div>
        ) : (
          <>
            {visible.map(ev => (
              <LoadCard
                key={ev.id}
                ev={ev}
                asset={assetMap.get(ev.assetId)}
                distance={distances.get(ev.id) ?? null}
                onStatusChange={onStatusChange}
                onPriorityToggle={onPriorityToggle}
                onOpenLoad={onOpenLoad}
                onOpenMap={onOpenMap}
                onHide={() => onHide(ev.id)}
              />
            ))}

            {/* Hidden cards section */}
            {hidden.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setHiddenExpanded(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    width: '100%', padding: '5px 8px', borderRadius: 7,
                    background: 'var(--gc-hover)', border: '1px solid var(--gc-border-light)',
                    cursor: 'pointer', color: 'var(--gc-text-3)', fontSize: 11, fontWeight: 600,
                  }}
                >
                  {hiddenExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  Hidden ({hidden.length})
                </button>
                {hiddenExpanded && hidden.map(ev => (
                  <div key={ev.id} style={{ opacity: 0.65 }}>
                    <LoadCard
                      ev={ev}
                      asset={assetMap.get(ev.assetId)}
                      distance={distances.get(ev.id) ?? null}
                      onStatusChange={onStatusChange}
                      onPriorityToggle={onPriorityToggle}
                      onOpenLoad={onOpenLoad}
                      onOpenMap={onOpenMap}
                      onHide={() => onHide(ev.id)}
                    />
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main board ─────────────────────────────────────────────────────────────────

export default function DispatchBoard({ onClose }: { onClose?: () => void }) {
  const { events, assets, updateEvent, openEditModal, eldLocations } = useCalendarStore();
  const router = useRouter();
  const handleClose = onClose ?? (() => router.push('/calendar'));

  const [mapDrawerId,   setMapDrawerId]   = useState<string | null>(null);
  const [distances,     setDistances]     = useState<Map<string, DistanceResult>>(new Map());
  const [eldLoading,    setEldLoading]    = useState(false);
  const [eldLastUpdate, setEldLastUpdate] = useState<Date | null>(null);
  const [eldError,      setEldError]      = useState(false);
  const distFetchRef = useRef<AbortController | null>(null);

  const [pivotTime,    setPivotTime]    = useState<Date>(() => new Date());
  const [columnOrder,  setColumnOrder]  = useState<ColumnKey[]>(COLUMN_ORDER);
  const [hiddenIds,    setHiddenIds]    = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('dispatch-board-hidden-ids');
      if (saved) return new Set<string>(JSON.parse(saved));
    } catch { /* ignore */ }
    return new Set<string>();
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem('dispatch-board-column-order');
      if (saved) {
        const parsed: ColumnKey[] = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === COLUMN_ORDER.length && parsed.every(k => COLUMN_ORDER.includes(k)))
          setColumnOrder(parsed);
      }
    } catch { /* ignore */ }
  }, []);

  const toggleHide = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('dispatch-board-hidden-ids', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [draggingCol,  setDraggingCol]  = useState<ColumnKey | null>(null);
  const [dragOverCol,  setDragOverCol]  = useState<ColumnKey | null>(null);

  const handleColDragStart = (col: ColumnKey) => setDraggingCol(col);
  const handleColDragOver  = (e: React.DragEvent, col: ColumnKey) => {
    e.preventDefault();
    if (draggingCol && draggingCol !== col) setDragOverCol(col);
  };
  const handleColDrop = (col: ColumnKey) => {
    if (!draggingCol || draggingCol === col) { setDraggingCol(null); setDragOverCol(null); return; }
    setColumnOrder(prev => {
      const next = [...prev];
      const from = next.indexOf(draggingCol);
      const to   = next.indexOf(col);
      next.splice(from, 1);
      next.splice(to, 0, draggingCol);
      try { localStorage.setItem('dispatch-board-column-order', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setDraggingCol(null);
    setDragOverCol(null);
  };

  const windowStart = useMemo(() => new Date(pivotTime.getTime() - WINDOW_HOURS * 3600 * 1000), [pivotTime]);
  const windowEnd   = useMemo(() => new Date(pivotTime.getTime() + WINDOW_HOURS * 3600 * 1000), [pivotTime]);
  const isAtNow     = Math.abs(pivotTime.getTime() - Date.now()) < 5 * 60 * 1000;

  const shiftPivot = (hours: number) =>
    setPivotTime(p => new Date(p.getTime() + hours * 3600 * 1000));

  const todayLoads = useMemo(() =>
    events.filter(ev => isInWindow(ev, windowStart, windowEnd))
          .sort((a, b) => a.start.localeCompare(b.start)),
  [events, windowStart, windowEnd]);

  const assetMap = useMemo(() => {
    const m = new Map<number, Asset>();
    for (const a of assets) m.set(a.id, a);
    return m;
  }, [assets]);

  const columnedLoads = useMemo(() => {
    const cols: Record<ColumnKey, CalendarEvent[]> = { upcoming: [], dispatched: [], in_transit: [], delivered: [], issues: [] };
    for (const ev of todayLoads) cols[getColumn(ev)].push(ev);
    return cols;
  }, [todayLoads]);

  // ── ELD + distance ─────────────────────────────────────────────────────────

  const calcDistances = useCallback(async (locs: MotiveLocation[], loads: CalendarEvent[]) => {
    if (!Array.isArray(locs) || locs.length === 0) return;
    if (distFetchRef.current) distFetchRef.current.abort();
    distFetchRef.current = new AbortController();
    const locMap = new Map<string, MotiveLocation>();
    for (const l of locs) locMap.set(l.vehicleId, l);

    const results = await Promise.all(
      loads.filter(ev => ['dispatched', 'in_transit'].includes(getColumn(ev))).map(async ev => {
        const asset = assetMap.get(ev.assetId);
        if (!asset?.motiveVehicleId) return null;
        const loc = locMap.get(asset.motiveVehicleId);
        if (!loc) return null;

        const stops = ev.stops ?? [];
        const isDispatched = getColumn(ev) === 'dispatched';
        let targetStop = isDispatched
          ? stops.find(s => s.type === 'pickup' && s.lat != null && s.lng != null)
          : [...stops].reverse().find(s => (s.type === 'delivery' || s.type === 'drop_hook' || s.type === 'drop') && s.lat != null && s.lng != null);
        if (!targetStop) targetStop = isDispatched
          ? stops.find(s => s.lat != null)
          : [...stops].reverse().find(s => s.lat != null);
        if (!targetStop?.lat || !targetStop?.lng) return null;

        const dir = await calcDirections([{ lat: loc.lat, lng: loc.lon }, { lat: targetStop.lat, lng: targetStop.lng }]);
        if (dir == null) return null;
        const stale = (Date.now() - new Date(loc.locatedAt).getTime()) > 30 * 60 * 1000;
        return { id: ev.id, result: { miles: dir.miles, durationSeconds: dir.durationSeconds, truckDescription: loc.description, target: isDispatched ? 'pickup' : 'delivery', stale } as DistanceResult };
      })
    );

    const map = new Map<string, DistanceResult>();
    for (const r of results) { if (r) map.set(r.id, r.result); }
    setDistances(map);
  }, [assetMap]);

  const { setEldLocations } = useCalendarStore.getState();

  const fetchEld = useCallback(async () => {
    setEldLoading(true); setEldError(false);
    try {
      const res = await fetch('/api/motive/locations');
      if (!res.ok) throw new Error();
      const body = await res.json();
      const locs: MotiveLocation[] = Array.isArray(body) ? body : (Array.isArray(body?.locations) ? body.locations : []);
      setEldLocations(locs);
      setEldLastUpdate(new Date());
      return locs;
    } catch {
      setEldError(true);
      return eldLocations;
    } finally {
      setEldLoading(false);
    }
  }, [eldLocations, setEldLocations]);

  // On mount: run calcDistances with whatever's already in the store, then fetch fresh ELD
  useEffect(() => {
    if (eldLocations.length > 0) calcDistances(eldLocations, todayLoads);
    fetchEld().then(locs => calcDistances(locs, todayLoads));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run calcDistances whenever EldSync (or manual refresh) updates the store
  useEffect(() => {
    if (eldLocations.length > 0) calcDistances(eldLocations, todayLoads);
  }, [eldLocations]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run when tab becomes visible (ELD may have updated while hidden)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && eldLocations.length > 0)
        calcDistances(eldLocations, todayLoads);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [eldLocations, todayLoads, calcDistances]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleStatusChange = useCallback((id: string, status: EventStatus | undefined) =>
    updateEvent(id, { status: status ?? 'scheduled' }), [updateEvent]);

  const handlePriorityToggle = useCallback((id: string, priority: boolean) =>
    updateEvent(id, { priority }), [updateEvent]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [handleClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--gc-bg)', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ flexShrink: 0 }}>
        <ManagementHeader
          title="Command Center"
          icon={LayoutDashboard}
          onBack={handleClose}
        />

        {/* Row 2: window navigation + ELD controls */}
        <div style={{
          height: 36, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px',
          borderTop: '1px solid var(--gc-border-light)',
          background: 'var(--gc-bg)',
        }}>
          {/* Window nav: [−12h] Showing loads from … to … [+12h] [Now] */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={() => shiftPivot(-STEP_HOURS)}
              style={{ fontSize: 12, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >−12 hours</button>
            <WindowTimeline start={windowStart} end={windowEnd} />
            <button type="button" onClick={() => shiftPivot(STEP_HOURS)}
              style={{ fontSize: 12, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >+12 hours</button>
            {!isAtNow && (
              <button type="button" onClick={() => setPivotTime(new Date())}
                style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: '#1558d6' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(26,115,232,0.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >Now</button>
            )}
          </div>

          <div style={{ flex: 1 }} />

          {/* ELD controls */}
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#e8f0fe', color: '#1558d6' }}>
            {todayLoads.length} loads
          </span>
          {eldError && (
            <span style={{ fontSize: 12, color: '#b91c1c' }}>ELD unavailable</span>
          )}
          {!eldError && eldLastUpdate && (
            <span style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>ELD · {timeAgo(eldLastUpdate.toISOString())}</span>
          )}
          <Tooltip content="Pull latest truck locations from ELD" placement="bottom">
            <button
              type="button"
              onClick={() => fetchEld().then(locs => calcDistances(locs, todayLoads))}
              disabled={eldLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600,
                padding: '4px 10px', borderRadius: 9999, cursor: eldLoading ? 'default' : 'pointer',
                background: 'transparent', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)',
                opacity: eldLoading ? 0.55 : 1,
              }}
              onMouseEnter={e => { if (!eldLoading) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <RefreshCw size={11} style={{ animation: eldLoading ? 'spin 1s linear infinite' : 'none' }} />
              Refresh ELD
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Columns */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, padding: 14, overflow: 'hidden' }}>
        {columnOrder.map(col => (
          <Column
            key={col}
            columnKey={col}
            loads={columnedLoads[col]}
            assetMap={assetMap}
            distances={distances}
            onStatusChange={handleStatusChange}
            onPriorityToggle={handlePriorityToggle}
            onOpenLoad={id => openEditModal(id)}
            onOpenMap={id => setMapDrawerId(id)}
            isDragOver={dragOverCol === col}
            onDragStart={() => handleColDragStart(col)}
            onDragOver={e => handleColDragOver(e, col)}
            onDrop={() => handleColDrop(col)}
            hiddenIds={hiddenIds}
            onHide={toggleHide}
          />
        ))}
      </div>

      {/* Map drawer */}
      {mapDrawerId && (() => {
        const ev = todayLoads.find(e => e.id === mapDrawerId);
        if (!ev) return null;
        const asset = assetMap.get(ev.assetId);
        const truckLoc = asset?.motiveVehicleId
          ? (eldLocations.find(l => l.vehicleId === asset.motiveVehicleId) ?? null)
          : null;
        return (
          <MapDrawer
            ev={ev}
            asset={asset}
            truckLoc={truckLoc}
            onClose={() => setMapDrawerId(null)}
            onOpenLoad={id => { setMapDrawerId(null); openEditModal(id); }}
            onStatusChange={handleStatusChange}
            onPriorityToggle={handlePriorityToggle}
          />
        );
      })()}

    </div>
  );
}
