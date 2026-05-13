'use client';

import { useState, useRef } from 'react';
import { Star, CheckCircle2, FileCheck2 } from 'lucide-react';
import { CalendarEvent as EventType, Asset, Driver, EventStatus } from '@/lib/types';
import { CARD_FIELD_DEFS } from '@/lib/cardFields';
import { timeToPixels, timeHeightPixels, localDateStr } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';

const STATUS_CONFIG: Record<EventStatus, { dot: string; label: string }> = {
  scheduled:  { dot: 'rgba(255,255,255,0.55)', label: 'Scheduled'  },
  assigned:   { dot: '#c4b5fd',                label: 'Assigned'   },
  dispatched: { dot: '#93c5fd',                label: 'Dispatched' },
  en_route:   { dot: '#fbbf24',                label: 'En Route'   },
  picked_up:  { dot: '#7dd3fc',                label: 'Picked Up'  },
  delivered:  { dot: '#86efac',                label: 'Delivered'  },
  cancelled:  { dot: '#fca5a5',                label: 'Cancelled'  },
  tonu:       { dot: '#fde68a',                label: 'TONU'       },
  problem:    { dot: '#fdba74',                label: 'Problem'    },
};

interface Props {
  event: EventType;
  asset: Asset;
  colIdx: number;
  totalCols: number;
  compact?: boolean;
  overrideTop?: number;
  overrideHeight?: number;
  onSmartAssign?: (eventId: string) => void;
}


function driverDisplayName(d: Driver): string {
  const full = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
  return full || d.name;
}

export default function CalendarEvent({ event, asset, colIdx, totalCols, compact = false, overrideTop, overrideHeight, onSmartAssign }: Props) {
  const {
    events, currentDate, dragState, setDragState, rowHeight,
    showStatusOverlay, showConfirmedOverlay, showPodOverlay, showBillingOverlay,
    drivers, openEditModal, cardFields, customers,
  } = useCalendarStore();
  const matchedDriver = event.driverName ? drivers.find(d => d.name === event.driverName) ?? null : null;
  const driverLabel = matchedDriver ? driverDisplayName(matchedDriver) : (event.driverName ?? null);
  const driverPhone = matchedDriver?.phone ?? null;

  const isRelay = !!event.relayGroupId;
  const relayRole = event.relayRole ?? (() => {
    if (!isRelay) return null;
    const partner = events.find(e => e.relayGroupId === event.relayGroupId && e.id !== event.id);
    return partner ? (event.start <= partner.start ? 'pickup' : 'delivery') : null;
  })();

  // TONU + cancelled loads render gray in the calendar — they didn't
  // actually run, so the asset's primary color would mislead the
  // at-a-glance scan. Cancelled also dims further (handled in `opacity`
  // below) so it reads as "not happening" regardless of the user's
  // status-overlay toggle.
  const isTonu = event.status === 'tonu';
  const isCancelled = event.status === 'cancelled';
  const color = isTonu || isCancelled ? '#9aa0a6' : asset.color;
  // Prefix the title so the at-a-glance scan reads what happened (or
  // didn't) even before the status chip is visible — and so it sticks
  // across compact + full views.
  const displayTitle = isTonu
    ? `TONU · ${event.title}`
    : isCancelled
      ? `CANCELLED · ${event.title}`
      : event.title;
  const dateStr = localDateStr(currentDate);
  const top    = overrideTop  ?? (event.start.split('T')[0] < dateStr ? 0 : timeToPixels(event.start, rowHeight));
  const height = overrideHeight ?? timeHeightPixels(event.start, event.end, dateStr, rowHeight);

  const startTime = event.start.split('T')[1]?.slice(0, 5) ?? '';
  const endTime   = event.end.split('T')[1]?.slice(0, 5)   ?? '';

  const isDragging = dragState?.eventId === event.id && dragState.hasMoved;
  const [showRelayNotice, setShowRelayNotice] = useState(false);
  const relayNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Overlap layout fractions
  const leftFrac  = colIdx / totalCols;
  const widthFrac = 1 / totalCols;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSmartAssign) return; // triage mode — let onClick handle it
    if (event.relayGroupId) {
      const startX = e.clientX;
      const startY = e.clientY;
      const onMove = (me: MouseEvent) => {
        if (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4) {
          cleanup();
          setShowRelayNotice(true);
          if (relayNoticeTimer.current) clearTimeout(relayNoticeTimer.current);
          relayNoticeTimer.current = setTimeout(() => setShowRelayNotice(false), 2500);
        }
      };
      const cleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', cleanup);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', cleanup);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    // For continuation events (started before current view date), grab offset is 0
    // since the event is clamped to the top of the column.
    const isContinuation = event.start.split('T')[0] < dateStr;
    const grabOffsetPx = isContinuation ? 0 : e.clientY - rect.top;

    const [sd, st] = event.start.split('T');
    const [ed, et] = event.end.split('T');
    const [sy, sm, sday] = sd.split('-').map(Number);
    const [sh, smin] = st.split(':').map(Number);
    const [ey, em, eday] = ed.split('-').map(Number);
    const [eh, emin] = et.split(':').map(Number);
    const durationMs = new Date(ey, em - 1, eday, eh, emin).getTime()
                     - new Date(sy, sm - 1, sday, sh, smin).getTime();

    setDragState({
      eventId: event.id,
      targetAssetId: asset.id,
      // Use event's actual start date so time is preserved when reassigning asset
      dateStr: sd,
      grabOffsetPx,
      durationMs,
      newStart: event.start,
      newEnd: event.end,
      hasMoved: false,
    });
  };

  return (
    <div
      className="absolute rounded overflow-hidden z-10"
      style={{
        top,
        height: Math.max(22, height - 2),
        left: `calc(${leftFrac * 100}% + 2px)`,
        width: `calc(${widthFrac * 100}% - 4px)`,
        backgroundColor: color,
        borderLeft: totalCols >= 3 ? '2px solid rgba(255,255,255,0.6)' : `3px solid ${color}`,
        borderRight: totalCols >= 3 ? '2px solid rgba(255,255,255,0.6)' : 'none',
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.3 : isCancelled ? 0.55 : 1,
        pointerEvents: isDragging ? 'none' : 'auto',
        transition: isDragging ? 'none' : 'filter 100ms ease, box-shadow 100ms ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => {
        if (!isDragging) {
          e.currentTarget.style.filter = 'brightness(0.92)';
          e.currentTarget.style.boxShadow = 'var(--shadow-1)';
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.filter = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
      onMouseDown={handleMouseDown}
      onClick={e => {
        e.stopPropagation();
        if (onSmartAssign) { onSmartAssign(event.id); return; }
        // Only relay events bypass the drag system entirely — all others are handled by mouseup
        if (isRelay) openEditModal(event.id);
      }}
      title={`${displayTitle} · ${startTime}–${endTime}`}
    >
      {/* Non-revenue stripe overlay */}
      {event.eventKind === 'non_revenue' && (
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
          backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.12) 4px, rgba(0,0,0,0.12) 6px)',
        }} />
      )}
      {compact ? (
        /* Compact / triage mode: just title + time in one tight row */
        <div className="px-1.5 flex items-center h-full gap-1 overflow-hidden">
          <div className="text-[10px] font-extrabold leading-none truncate flex-1 min-w-0" style={{ color: 'white' }}>
            {displayTitle}
          </div>
          <div className="text-[9px] font-semibold tabular-nums shrink-0" style={{ color: 'rgba(255,255,255,0.8)' }}>
            {startTime}
          </div>
        </div>
      ) : (
        <div className="px-1.5 pt-0.5 flex flex-col h-full overflow-hidden" style={{ paddingBottom: event.status && showStatusOverlay ? 14 : 2 }}>
          {/* Relay drag-blocked notice */}
          {showRelayNotice && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 20, borderRadius: 'inherit',
              background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '4px 6px', textAlign: 'center',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', lineHeight: 1.3 }}>
                Edit in modal to move relay legs
              </span>
            </div>
          )}
          {/* Priority star — top-right corner */}
          {event.priority && !isRelay && (
            <div style={{ position: 'absolute', top: 3, right: 4, pointerEvents: 'none' }}>
              <Star size={10} fill="#fbbf24" style={{ color: '#fbbf24', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }} />
            </div>
          )}
          {/* Layer overlays in the bottom-right corner. Stacked side-by-side
              when both apply so a confirmed + POD'd load shows both icons.
              Each gated on its toolbar toggle. */}
          {(() => {
            const podCount      = event.documentCounts?.pod ?? 0;
            const showCheck     = !isRelay && event.confirmedAt && showConfirmedOverlay;
            const showPod       = !isRelay && podCount > 0      && showPodOverlay;
            if (!showCheck && !showPod) return null;
            return (
              <div style={{
                position: 'absolute', bottom: 16, right: 4,
                display: 'flex', alignItems: 'center', gap: 3,
                pointerEvents: 'none',
              }}>
                {showPod && (
                  <span title="POD uploaded">
                    <FileCheck2 size={18} fill="#0f9d58" style={{ color: '#fff', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.45))' }} />
                  </span>
                )}
                {showCheck && (
                  <span title="Confirmed by driver">
                    <CheckCircle2 size={18} fill="#0f9d58" style={{ color: '#fff', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.45))' }} />
                  </span>
                )}
              </div>
            );
          })()}
          {/* Billing-status pill — top-left corner. Shows the closeout
              workflow state on the card so dispatchers can spot
              flagged / invoiced / paid loads at a glance. */}
          {!isRelay && showBillingOverlay && event.billingStatus && event.billingStatus !== 'pending' && (() => {
            const billingPalette: Record<NonNullable<EventType['billingStatus']>, { bg: string; fg: string; label: string }> = {
              pending:   { bg: 'rgba(255,255,255,0.35)', fg: '#1f2937', label: '·' },
              verified:  { bg: '#dbeafe',                fg: '#1e40af', label: 'V' },
              invoiced:  { bg: '#dcfce7',                fg: '#15803d', label: 'I' },
              paid:      { bg: '#d1fae5',                fg: '#065f46', label: 'P' },
              on_hold:   { bg: '#fee2e2',                fg: '#991b1b', label: '!' },
            };
            const p = billingPalette[event.billingStatus];
            return (
              <span title={`Billing: ${event.billingStatus.replace('_', ' ')}`}
                style={{
                  position: 'absolute', top: 3, left: 3,
                  fontSize: 9, fontWeight: 900,
                  width: 14, height: 14, lineHeight: '14px', textAlign: 'center',
                  borderRadius: 999, background: p.bg, color: p.fg,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                  pointerEvents: 'none',
                }}>
                {p.label}
              </span>
            );
          })()}
          {/* Relay overlay — top-right corner */}
          {isRelay && (
            <div style={{
              position: 'absolute', top: 4, right: 5,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            }}>
              <span style={{ fontSize: 16, fontWeight: 900, lineHeight: 1, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.4)' }}>⇄</span>
              {relayRole && (
                <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.9)', lineHeight: 1 }}>
                  {relayRole === 'pickup' ? 'Pickup' : 'Delivery'}
                </span>
              )}
            </div>
          )}
          {/* Title — always shown */}
          <div className="flex items-start gap-1">
            <div className="text-[11px] font-extrabold leading-tight break-words min-w-0" style={{ color: 'white', paddingRight: isRelay ? 22 : 0 }}>
              {displayTitle}
            </div>
          </div>
          {/* User-configured fields */}
          {cardFields.map((key, i) => {
            const def = CARD_FIELD_DEFS.find(d => d.key === key);
            if (!def) return null;
            const value = def.render(event, { driverLabel, customers });
            if (!value) return null;
            const minHeight = 20 + i * 14;
            if (height <= minHeight) return null;
            return (
              <div key={key} className="text-[10px] font-medium leading-tight truncate" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {value}
              </div>
            );
          })}
        </div>
      )}

      {!compact && event.status && showStatusOverlay && (() => {
        const s = STATUS_CONFIG[event.status];
        return (
          <div
            className="absolute bottom-0 left-0 right-0 flex items-center gap-1 px-1.5"
            style={{ height: 14, background: 'rgba(0,0,0,0.28)' }}
          >
            <div className="rounded-full shrink-0" style={{ width: 5, height: 5, background: s.dot }} />
            {height > 30 && (
              <span
                className="text-[9px] font-bold uppercase tracking-wide truncate"
                style={{ color: s.dot, lineHeight: 1 }}
              >
                {s.label}
              </span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
