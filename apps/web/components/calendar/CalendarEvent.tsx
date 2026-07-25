'use client';

import { useState, useRef } from 'react';
import { Star, CheckCircle2, FileCheck2 } from 'lucide-react';
import { CalendarEvent as EventType, Asset, Driver, EventStatus } from '@/lib/types';
import { legRoleFor, legLabel, legShortLabel } from '@fleetcal/types';
import { legPositionFor } from '@/lib/legDisplay';
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
    drivers, openEditModal, cardFields, cardFieldIcons, customers, calendarTimezone,
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
  // Leg position from data (legIndex/legCount, or siblings in the
  // store) — no more inferring role from start-time ordering, which
  // broke whenever legs were dragged out of chronological order and
  // can't represent N-leg loads at all.
  const legPos = isRelay ? legPositionFor(event, events) : null;
  const relayRole = event.relayRole
    ?? (legPos ? legRoleFor(legPos.index, legPos.count) ?? null : null);

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
    // Drag operates in view-tz space because the block was positioned
    // using viewStart/viewEnd (see top of component). The save handler
    // in calendar/index.tsx converts back to HOME_TZ before persisting.
    //
    // No grab-offset / dateStr anchor anymore — the mousemove handler
    // works in pure pointer-delta space (Google Calendar style), which
    // is correct for both single-day and multi-day events. Without it,
    // dragging the tail of a cross-day event used to slam the event
    // back to the previous day at whatever hour the pointer was over.
    setDragState({
      eventId: event.id,
      targetAssetId: asset.id,
      newStart: viewStart,
      newEnd: viewEnd,
      hasMoved: false,
      // Anchor for the slop-distance check AND the move-delta math in
      // calendar/index.tsx. Tiny jitter stays a click; intentional
      // drag arms past DRAG_SLOP_PX and produces a clean dy → dt map.
      pointerStartX: e.clientX,
      pointerStartY: e.clientY,
      // Snapshot the original asset + times so the save handler can
      // verify the drag actually moved the event before committing.
      originAssetId: asset.id,
      originStart:   viewStart,
      originEnd:     viewEnd,
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
                - POD icon renders on the FINAL (delivery) leg only.
                  Upstream drivers haven't dropped yet when the POD
                  goes up, so a POD badge on an earlier leg would
                  mis-suggest "this leg is done". Same `documentCounts`
                  data is on every leg (shared via load_id), we just
                  only surface it on the last one. */}
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
          {/* Relay overlay — top-right corner.
              Compact leg-position chip ("Leg 1/3") in a white badge
              with a purple outline so it reads as RELAY at a glance
              no matter what color the card underneath is (truck
              colors vary, so a transparent purple label would
              disappear on some cards). Purple tone matches the
              canonical relay color #7c3aed used across EventModal,
              RouteMapPanel, ReviewQueue, etc. Native title tooltip
              carries the full "Leg 1 · Pickup" label for dispatchers
              learning the convention. */}
          {isRelay && legPos && (
            <div
              title={legLabel(legPos.index, legPos.count)}
              style={{
                position: 'absolute', top: 4, right: 4,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: 15,
                padding: '0 4px',
                background: '#fff',
                border: '1.5px solid #7c3aed',
                borderRadius: 5,
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                pointerEvents: 'auto',
              }}>
              <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: '0.02em', color: '#7c3aed', lineHeight: 1, whiteSpace: 'nowrap' }}>
                {legShortLabel(legPos.index, legPos.count)}
              </span>
            </div>
          )}
          {/* Height-budget allocation for title + fields.
              Each renderable field is single-line (truncated). Fields
              get first claim on vertical space in priority order; the
              title takes whatever's left and wraps into as many lines
              as fit (1-line minimum). This prevents a long broker
              title from pushing the time/driver/$ rows off the bottom
              of a short event card — a real bug visible on 30-60 min
              loads where the title would wrap to 3 lines and the
              entire bottom row clipped past the card border. */}
          {(() => {
            // Build the renderable-fields list once: skip null values
            // (e.g. no broker on this load) and role-restricted ones
            // (price/driverPay capabilities). i isn't the cardFields
            // index anymore — it's the visible-row index after filtering.
            const visible = cardFields.flatMap(key => {
              const def = CARD_FIELD_DEFS.find(d => d.key === key);
              if (!def) return [];
              if (key === 'loadPrice' && !canDo('loads.view_price')) return [];
              if (key === 'totalBillable' && !canDo('loads.view_price')) return [];
              if (key === 'driverPay' && !canDo('loads.view_driver_pay')) return [];
              if (key === 'driver' && !canDo('drivers.view')) return [];
              if (key === 'broker' && !canDo('customers.view')) return [];
              const value = def.render(event, { driverLabel, customers });
              if (!value) return [];
              return [{ key, def, value }];
            });

            // Line heights match `leading-tight` (~1.15 of fontSize).
            const titleLineH = Math.ceil(fsTitle * 1.15);
            const fieldLineH = Math.ceil(fsField * 1.15);
            // px-1.5 pt-0.5 → 2px top; paddingBottom 14 if status overlay else 2.
            const padTop    = 2;
            const padBottom = event.status && showStatusOverlay ? 14 : 2;
            const usableH   = Math.max(0, height - padTop - padBottom);

            // Reserve 1 title line first, then fit as many field rows
            // as the budget allows. If even one title line doesn't fit,
            // titleLines becomes 0 and we'd render only the truncated
            // title via maxHeight — but in practice CalendarColumn
            // clamps minimum card height well above this floor.
            const budgetAfterTitle = usableH - titleLineH;
            const fieldCount = Math.max(0, Math.min(
              visible.length,
              Math.floor(budgetAfterTitle / fieldLineH),
            ));
            const fieldsHeight = fieldCount * fieldLineH;
            // Title can claim everything that isn't taken by fields —
            // grows naturally when the card is tall enough that the
            // title wants to wrap (e.g. relay legs with prefix:route).
            const titleMaxH    = Math.max(titleLineH, usableH - fieldsHeight);
            const titleLines   = Math.max(1, Math.floor(titleMaxH / titleLineH));

            return (
              <>
                {/* Title — always shown, line-clamped to fit budget. */}
                <div className="flex items-start gap-1">
                  <div
                    className="font-extrabold leading-tight break-words min-w-0"
                    style={{
                      color: 'white',
                      paddingRight: isRelay ? 42 : 0,
                      fontSize: fsTitle,
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: titleLines,
                      overflow: 'hidden',
                    } as React.CSSProperties}
                  >
                    {displayTitle}
                  </div>
                </div>
                {/* User-configured fields — single-line, priority order. */}
                {visible.slice(0, fieldCount).map(({ key, def, value }) => {
                  const Icon = def.icon;
                  // Per-field icon visibility — empty / true = on (default),
                  // explicit false from the org setting hides this glyph.
                  const showIcon = cardFieldIcons[key] !== false;
                  // Icon sized just below the text so it sits visually
                  // centered against the cap-height. Tighter gap (3px) +
                  // smaller icon ratio (0.75) so the icon reads as a label
                  // glyph rather than a separate column — every pixel goes
                  // to the actual driver name / customer / time range.
                  const iconSize = Math.max(8, Math.round(fsField * 0.75));
                  return (
                    <div key={key} className="font-medium leading-tight truncate flex items-center" style={{ color: 'rgba(255,255,255,0.85)', fontSize: fsField }}>
                      {Icon && showIcon && (
                        <Icon
                          size={iconSize}
                          style={{ flexShrink: 0, opacity: 0.75, marginRight: 3 }}
                        />
                      )}
                      <span className="truncate">{value}</span>
                    </div>
                  );
                })}
              </>
            );
          })()}
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
