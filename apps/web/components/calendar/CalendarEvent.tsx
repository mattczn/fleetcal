'use client';

import { useState, useRef } from 'react';
import { Star, CheckCircle2, FileCheck2 } from 'lucide-react';
import { CalendarEvent as EventType, Asset, Driver, EventStatus } from '@/lib/types';
import { CARD_FIELD_DEFS } from '@/lib/cardFields';
import { timeToPixels, timeHeightPixels, localDateStr, naiveHomeToView } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';

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
    drivers, openEditModal, cardFields, customers, calendarTimezone,
    cardFontScale,
  } = useCalendarStore();

  // Apply the user's preferred card font-scale (Settings → Appearance
  // → Calendar card text). Compact / Default / Large / Extra Large
  // map to scales 0.9 / 1.0 / 1.15 / 1.3 in the panel. Each individual
  // size below is rounded to the nearest 0.5px so character anti-
  // aliasing stays crisp.
  const scale = cardFontScale ?? 1.0;
  const fs = (basePx: number) => Math.round(basePx * scale * 2) / 2;
  const fsTitle        = fs(11);  // main title
  const fsField        = fs(10);  // user-configured row fields (route, broker, etc.)
  const fsStatus       = fs(9);   // status overlay text
  const fsCompactTitle = fs(10);  // triage-mode title
  const fsCompactTime  = fs(9);   // triage-mode time
  const fsRelayNotice  = fs(10);  // "Edit in modal to move relay legs"
  // Event times are stored in HOME_TZ; shift to view tz for display +
  // positioning so they track the user's timezone selector alongside
  // NowLine. See lib/time-utils.ts for the conversion rationale.
  const viewStart = naiveHomeToView(event.start, calendarTimezone);
  const viewEnd   = naiveHomeToView(event.end,   calendarTimezone);
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
  const top    = overrideTop  ?? (viewStart.split('T')[0] < dateStr ? 0 : timeToPixels(viewStart, rowHeight));
  const height = overrideHeight ?? timeHeightPixels(viewStart, viewEnd, dateStr, rowHeight);

  const startTime = viewStart.split('T')[1]?.slice(0, 5) ?? '';
  const endTime   = viewEnd.split('T')[1]?.slice(0, 5)   ?? '';

  const isDragging = dragState?.eventId === event.id && dragState.hasMoved;
  const [showRelayNotice, setShowRelayNotice] = useState(false);
  const relayNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read-only roles (maintenance for revenue loads, anyone for events
  // they can't modify) can click to open the modal but must not be
  // able to drag — every drag-end fires a PATCH /v1/loads (or /events)
  // that the API would 403. Show a 'pointer' cursor instead of 'grab'
  // so the affordance matches what's actually possible.
  const { can: canDo } = usePermissions();
  const canDragThis = event.eventKind === 'non_revenue'
    ? canDo('nonRevenueEvents.edit')
    : canDo('loads.edit');

  // Overlap layout fractions
  const leftFrac  = colIdx / totalCols;
  const widthFrac = 1 / totalCols;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onSmartAssign) return; // triage mode — let onClick handle it
    // Read-only role for this event kind: don't initiate drag. The
    // onClick handler still fires (mouseup → click) so they can open
    // the modal to view details, just not move the event.
    if (!canDragThis) return;
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
    // Drag operates in view-tz space because the block was positioned
    // using viewStart/viewEnd (see top of component). The save handler
    // in calendar/index.tsx converts back to HOME_TZ before persisting.
    const isContinuation = viewStart.split('T')[0] < dateStr;
    const grabOffsetPx = isContinuation ? 0 : e.clientY - rect.top;

    const [sd, st] = viewStart.split('T');
    const [ed, et] = viewEnd.split('T');
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
      newStart: viewStart,
      newEnd: viewEnd,
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
        cursor: isDragging ? 'grabbing' : canDragThis ? 'grab' : 'pointer',
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
        // Two paths bypass the drag system and open the modal via
        // plain onClick: relay events (handled separately because the
        // drag system can't split a relay), and read-only roles whose
        // drag-start was suppressed (maintenance opening a revenue
        // load — they still need to see the details).
        if (isRelay || !canDragThis) openEditModal(event.id);
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
          <div className="font-extrabold leading-none truncate flex-1 min-w-0" style={{ color: 'white', fontSize: fsCompactTitle }}>
            {displayTitle}
          </div>
          <div className="font-semibold tabular-nums shrink-0" style={{ color: 'rgba(255,255,255,0.8)', fontSize: fsCompactTime }}>
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
              <span style={{ fontSize: fsRelayNotice, fontWeight: 700, color: '#fff', lineHeight: 1.3 }}>
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
              Each gated on its toolbar toggle.
              Relay behaviour:
                - Confirmed checkmark renders on BOTH legs independently —
                  `event.confirmedAt` is per-event, so each driver's own
                  confirmation lights up only their leg.
                - POD icon renders on the DELIVERY leg only. The pickup
                  driver hasn't dropped yet when the POD goes up, so a
                  POD badge on the pickup card would mis-suggest "this
                  leg is done". Same `documentCounts` data is on both
                  legs (shared via load_id), we just don't surface it
                  on the pickup card. */}
          {(() => {
            const podCount      = event.documentCounts?.pod ?? 0;
            const showCheck     = event.confirmedAt && showConfirmedOverlay;
            const podAllowedHere = !isRelay || relayRole === 'delivery';
            const showPod       = podAllowedHere && podCount > 0 && showPodOverlay;
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
          {/* Billing-status overlay removed for now; deciding whether
              to do it via a left-edge stripe (asset-color stays on
              card body) or some other treatment. The store flag
              showBillingOverlay is preserved for easy re-enable. */}
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
            <div className="font-extrabold leading-tight break-words min-w-0" style={{ color: 'white', paddingRight: isRelay ? 22 : 0, fontSize: fsTitle }}>
              {displayTitle}
            </div>
          </div>
          {/* User-configured fields */}
          {cardFields.map((key, i) => {
            const def = CARD_FIELD_DEFS.find(d => d.key === key);
            if (!def) return null;
            // Hide $-amount fields from roles that lack the visibility
            // cap. Maintenance opening a calendar should see route +
            // driver + status but not the rate.
            if (key === 'loadPrice' && !canDo('loads.view_price')) return null;
            if (key === 'driverPay' && !canDo('loads.view_driver_pay')) return null;
            const value = def.render(event, { driverLabel, customers });
            if (!value) return null;
            const minHeight = 20 + i * 14;
            if (height <= minHeight) return null;
            return (
              <div key={key} className="font-medium leading-tight truncate" style={{ color: 'rgba(255,255,255,0.85)', fontSize: fsField }}>
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
                className="font-bold uppercase tracking-wide truncate"
                style={{ color: s.dot, lineHeight: 1, fontSize: fsStatus }}
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
