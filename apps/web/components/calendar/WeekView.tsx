'use client';

import { Fragment } from 'react';
import { Truck } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { CalendarEvent } from '@/lib/types';
import { localDateStr, todayStrInTz, naiveHomeToView, naiveViewToHome } from '@/lib/time-utils';
import { isActiveInRange, dateKeyInTz } from '@/lib/lifecycle';
import { legPositionFor } from '@/lib/legDisplay';
import { legShortLabel, legLabel } from '@fleetcal/types';

const ASSET_GUTTER = 140;
const HEADER_H     = 68;
const HOUR_TICKS   = [6, 12, 18]; // vertical grid lines + labels

function getWeekDays(date: Date): Date[] {
  const dow = date.getDay();
  const mon = new Date(date);
  mon.setDate(date.getDate() - ((dow + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

function timeToFrac(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h * 60 + m) / (24 * 60);
}

function fmtHour(h: number): string {
  if (h === 0)  return '12a';
  if (h < 12)   return `${h}a`;
  if (h === 12) return '12p';
  return `${h - 12}p`;
}

function fmtTime(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'p' : 'a';
  const hr = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hr}${period}` : `${hr}:${String(m).padStart(2, '0')}${period}`;
}

interface WeekEventLayout {
  event: CalendarEvent;
  leftFrac: number;
  rightFrac: number;
  lane: number;
}

function computeWeekLayout(events: CalendarEvent[], weekDayStrs: string[], viewTz: string): WeekEventLayout[] {
  const weekStart = weekDayStrs[0];
  const weekEnd   = weekDayStrs[6];

  // Shift events to view-tz before laying them out so a "MT 23:00" event
  // that lands on Tuesday in MT but Wednesday in ET appears in the right
  // column when the user switches their setting.
  const shifted = events.map(e => ({
    event: e,
    viewStart: naiveHomeToView(e.start, viewTz),
    viewEnd:   naiveHomeToView(e.end,   viewTz),
  }));

  const relevant = shifted
    .filter(s => s.viewStart.split('T')[0] <= weekEnd && s.viewEnd.split('T')[0] >= weekStart)
    .sort((a, b) => a.viewStart.localeCompare(b.viewStart));

  const withFrac = relevant.map(({ event, viewStart, viewEnd }) => {
    const eStartDate = viewStart.split('T')[0];
    const eEndDate   = viewEnd.split('T')[0];
    const eStartTime = viewStart.split('T')[1]?.slice(0, 5) ?? '00:00';
    const eEndTime   = viewEnd.split('T')[1]?.slice(0, 5)   ?? '00:00';

    const startsBefore = eStartDate < weekStart;
    const endsAfter    = eEndDate   > weekEnd;

    let startDayIdx = 0;
    if (!startsBefore) {
      for (let i = 0; i < 7; i++) {
        if (weekDayStrs[i] === eStartDate) { startDayIdx = i; break; }
      }
    }
    let endDayIdx = 6;
    if (!endsAfter) {
      for (let i = 6; i >= 0; i--) {
        if (weekDayStrs[i] === eEndDate) { endDayIdx = i; break; }
      }
    }

    const leftFrac  = startsBefore ? 0 : (startDayIdx + timeToFrac(eStartTime)) / 7;
    const rightFrac = endsAfter    ? 1 : (endDayIdx   + timeToFrac(eEndTime))   / 7;

    return { event, leftFrac, rightFrac: Math.max(leftFrac + 0.002, rightFrac) };
  });

  // Greedy lane assignment by actual time overlap
  const laneRights: number[] = [];
  return withFrac.map(item => {
    let lane = laneRights.findIndex(r => r <= item.leftFrac + 0.001);
    if (lane === -1) lane = laneRights.length;
    laneRights[lane] = item.rightFrac;
    return { ...item, lane };
  });
}

export default function WeekView() {
  const { assets: allAssets, events, currentDate, rowHeight, openEditModal, openCreateModal, activeCategoryFilter, showUnassigned, unassignedAssetId, calendarTimezone } = useCalendarStore();
  const unassignedAsset = showUnassigned && unassignedAssetId !== null ? allAssets.find(a => a.id === unassignedAssetId) ?? null : null;

  const weekDays    = getWeekDays(currentDate);
  const weekDayStrs = weekDays.map(d => localDateStr(d));
  // Filter assets to those active any day in the visible week. A
  // truck retired mid-week still shows so its loads stay visible.
  // Computed in the ORG'S tz (not browser) so the Mon-Sun boundary
  // matches the dispatcher's clock around midnight edges.
  const { weekStart, weekEnd } = (() => {
    const todayKey = dateKeyInTz(currentDate, calendarTimezone);
    const anchor = new Date(`${todayKey}T12:00:00`);
    const dow = anchor.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(anchor); mon.setDate(anchor.getDate() + mondayOffset);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { weekStart: fmt(mon), weekEnd: fmt(sun) };
  })();

  const assets = [
    ...(unassignedAsset ? [unassignedAsset] : []),
    ...allAssets.filter(a =>
      !a.hidden
      && a.id !== unassignedAssetId
      && (activeCategoryFilter === null || a.type === activeCategoryFilter)
      && isActiveInRange(a, weekStart, weekEnd)
    ),
  ];
  const todayStr    = todayStrInTz(calendarTimezone);

  return (
    <div className="flex-1 overflow-auto select-none" style={{ background: 'var(--gc-surface)' }}>
      <div style={{ minHeight: '100%', minWidth: ASSET_GUTTER + 7 * 120, display: 'flex', flexDirection: 'column' }}>

        {/* Sticky header */}
        <div
          className="sticky top-0 z-20 flex shrink-0"
          style={{ height: HEADER_H, borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
        >
          {/* Corner */}
          <div
            className="sticky left-0 z-30 shrink-0"
            style={{ width: ASSET_GUTTER, minWidth: ASSET_GUTTER, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}
          />

          {/* Day columns */}
          {weekDays.map((d, i) => {
            const dStr    = weekDayStrs[i];
            const isToday = dStr === todayStr;
            const dow     = d.toLocaleDateString('en-US', { weekday: 'short' });
            return (
              <div
                key={dStr}
                className="flex-1 flex flex-col overflow-hidden"
                style={{ borderRight: '1px solid var(--gc-border-light)', minWidth: 0 }}
              >
                {/* Day name + date */}
                <div className="flex items-center gap-1 px-2 pt-1.5">
                  <span
                    className="text-[11px] font-medium uppercase tracking-wider"
                    style={{ color: isToday ? 'var(--gc-blue)' : 'var(--gc-text-3)' }}
                  >
                    {dow}
                  </span>
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[13px] font-medium shrink-0"
                    style={{
                      background: isToday ? 'var(--gc-blue)' : 'transparent',
                      color:      isToday ? 'white'          : 'var(--gc-text-1)',
                    }}
                  >
                    {d.getDate()}
                  </div>
                </div>

                {/* Hour tick labels */}
                <div className="relative flex-1">
                  {HOUR_TICKS.map(h => (
                    <span
                      key={h}
                      className="absolute text-[9px] bottom-1"
                      style={{
                        left:      `${(h / 24) * 100}%`,
                        transform: 'translateX(-50%)',
                        color:     'var(--gc-text-3)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmtHour(h)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Asset rows — flex-1 fills viewport; minHeight = rowHeight controls minimum/slider size */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {assets.map(asset => {
            // Drop soft-deleted — see CalendarColumn for the full
            // explanation of why these end up in the events store.
            const assetEvents = events.filter(e => e.assetId === asset.id && !e.deletedAt);
            const layout      = computeWeekLayout(assetEvents, weekDayStrs, calendarTimezone);
            const numLanes    = layout.length === 0 ? 1 : Math.max(...layout.map(l => l.lane)) + 1;

            return (
              <div
                key={asset.id}
                className="flex"
                style={{ flex: 1, minHeight: rowHeight, borderBottom: '1px solid var(--gc-border-light)' }}
              >
                {/* Asset label */}
                <div
                  className="sticky left-0 z-10 flex items-center gap-2.5 px-3 shrink-0"
                  style={{
                    background:  'var(--gc-surface)',
                    width:       ASSET_GUTTER,
                    minWidth:    ASSET_GUTTER,
                    borderRight: '1px solid var(--gc-border-light)',
                  }}
                >
                  <Truck size={28} style={{ color: asset.color, flexShrink: 0 }} />
                  <div className="flex flex-col min-w-0" style={{ gap: 1 }}>
                    <span className="text-[13px] font-semibold truncate leading-tight" style={{ color: 'var(--gc-text-1)' }}>
                      {asset.name}
                    </span>
                    {asset.unit && (
                      <span className="text-[11px] font-medium truncate leading-tight" style={{ color: 'var(--gc-text-3)' }}>
                        #{asset.unit}
                      </span>
                    )}
                  </div>
                </div>

                {/* Event area */}
                <div className="relative flex-1">

                  {/* Grid lines: day boundaries + hour ticks */}
                  {weekDays.map((_, i) => (
                    <Fragment key={i}>
                      <div
                        className="absolute top-0 bottom-0 pointer-events-none"
                        style={{ left: `${(i / 7) * 100}%`, width: 1, background: 'var(--gc-border-light)' }}
                      />
                      {HOUR_TICKS.map(h => (
                        <div
                          key={h}
                          className="absolute top-0 bottom-0 pointer-events-none"
                          style={{
                            left:       `${((i + h / 24) / 7) * 100}%`,
                            width:      1,
                            background: 'var(--gc-border-light)',
                            opacity:    0.6,
                          }}
                        />
                      ))}
                    </Fragment>
                  ))}

                  {/* Clickable day cells */}
                  {weekDayStrs.map((dStr, i) => (
                    <div
                      key={dStr}
                      className="absolute top-0 bottom-0 group cursor-pointer"
                      style={{ left: `${(i / 7) * 100}%`, width: `${(1 / 7) * 100}%` }}
                      onClick={() => openCreateModal({
                        assetId: asset.id,
                        // Clicked day is in view-tz; convert to HOME_TZ for storage.
                        start: naiveViewToHome(`${dStr}T08:00`, calendarTimezone),
                        end:   naiveViewToHome(`${dStr}T17:00`, calendarTimezone),
                      })}
                    >
                      <div className="absolute inset-0 group-hover:bg-blue-50/20 transition-colors pointer-events-none" />
                    </div>
                  ))}

                  {/* Events */}
                  {layout.map(({ event, leftFrac, rightFrac, lane }) => {
                    const topPct    = (lane / numLanes) * 100;
                    const heightPct = (1 / numLanes) * 100;
                    const startTime = naiveHomeToView(event.start, calendarTimezone).split('T')[1]?.slice(0, 5) ?? '';
                    const endTime   = naiveHomeToView(event.end,   calendarTimezone).split('T')[1]?.slice(0, 5) ?? '';
                    const widthFrac = rightFrac - leftFrac;

                    return (
                      <div
                        key={event.id}
                        className="absolute rounded overflow-hidden cursor-pointer z-10"
                        style={{
                          left:            `calc(${leftFrac * 100}% + 2px)`,
                          width:           `calc(${widthFrac * 100}% - 4px)`,
                          top:             `calc(${topPct}% + 3px)`,
                          height:          `calc(${heightPct}% - 6px)`,
                          backgroundColor: asset.color,
                          borderLeft:      `3px solid ${asset.color}`,
                          filter:          'brightness(0.9)',
                          transition:      'filter 100ms, box-shadow 100ms',
                          minWidth:        24,
                        }}
                        onClick={e => { e.stopPropagation(); openEditModal(event.id); }}
                        onMouseEnter={e => {
                          e.currentTarget.style.filter    = 'brightness(0.78)';
                          e.currentTarget.style.boxShadow = 'var(--shadow-1)';
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.filter    = 'brightness(0.9)';
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      >
                        {event.eventKind === 'non_revenue' && (
                          <div style={{
                            position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
                            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.12) 4px, rgba(0,0,0,0.12) 6px)',
                          }} />
                        )}
                        <div className="flex items-center justify-center h-full px-1.5 overflow-hidden gap-1 min-w-0" style={{ position: 'relative' }}>
                          <span className="text-[11px] font-extrabold text-white truncate leading-tight" style={{ paddingRight: event.relayGroupId ? 22 : 0 }}>
                            {event.title}
                          </span>
                          {event.relayGroupId && (() => {
                            const pos = legPositionFor(event, events);
                            return (
                              <div
                                title={pos ? legLabel(pos.index, pos.count) : 'Relay leg'}
                                style={{ position: 'absolute', top: 2, right: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                <span style={{ fontSize: 16, fontWeight: 900, lineHeight: 1, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.4)' }}>⇄</span>
                                {pos && (
                                  <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.9)', lineHeight: 1, whiteSpace: 'nowrap' }}>
                                    {legShortLabel(pos.index, pos.count)}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
