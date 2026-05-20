'use client';

import { useEffect, useRef, useState } from 'react';
import { useCalendarStore, DragState } from '@/store/useCalendarStore';
import { GUTTER_W, hoursToTimeStr, addMsToNaiveDatetime, naiveViewToHome } from '@/lib/time-utils';
import { isActiveInRange, dateKeyInTz } from '@/lib/lifecycle';
import CalendarHeader from './CalendarHeader';
import CalendarColumn from './CalendarColumn';
import HourGutter from './HourGutter';
import NowLine from './NowLine';
// SmartAssignDrawer + triage compress mode removed for now. Component
// still on disk — re-add the import + <SmartAssignDrawer /> render
// below and the triage button in CalendarHeader to bring it back.
// import SmartAssignDrawer from './SmartAssignDrawer';

interface DragPreview {
  assetId: number;
  top: number;
  height: number;
  color: string;
  title: string;
  newStart: string;
  newEnd: string;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function CalendarView() {
  const { assets: allAssets, resourceWidth: rw, rowHeight, dragState, activeCategoryFilter, showUnassigned, unassignedAssetId, resourceWidthLocked, currentDate, viewMode, calendarTimezone } = useCalendarStore();
  const unassignedAsset = showUnassigned && unassignedAssetId !== null ? allAssets.find(a => a.id === unassignedAssetId) ?? null : null;
  // Date range the calendar is currently displaying, computed in the
  // ORG'S tz — not the browser's — so the day boundary matches what
  // the dispatcher considers "today." Around midnight (when browser
  // and org tz can disagree on which day it is), this picks the org's
  // day. Assets retired before this range, or not yet started, are
  // filtered out.
  const viewRange = (() => {
    const todayKey = dateKeyInTz(currentDate, calendarTimezone);
    if (viewMode === 'week') {
      // Build the Mon-Sun containing `todayKey` using string-date math
      // (noon anchor) to avoid DST edge drift.
      const anchor = new Date(`${todayKey}T12:00:00`);
      const dow = anchor.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const mon = new Date(anchor); mon.setDate(anchor.getDate() + mondayOffset);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { start: fmt(mon), end: fmt(sun) };
    }
    return { start: todayKey, end: todayKey };
  })();
  const assets = [
    ...(unassignedAsset ? [unassignedAsset] : []),
    ...allAssets.filter(a =>
      !a.hidden
      && a.id !== unassignedAssetId
      && (activeCategoryFilter === null || a.type === activeCategoryFilter)
      && isActiveInRange(a, viewRange.start, viewRange.end)
    ),
  ];
  const scrollRef  = useRef<HTMLDivElement>(null);
  const gridBodyRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(dragState);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  // Keep ref in sync with store (without re-subscribing the drag effect)
  useEffect(() => { dragStateRef.current = dragState; }, [dragState]);

  // Fill the container width: recompute column width whenever the container, asset count, or lock state changes.
  // Skips update if the user has manually locked the width via the slider.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const { resourceWidthLocked, resourceWidth: cur, setResourceWidth } = useCalendarStore.getState();
      if (resourceWidthLocked) return;
      const containerW = el.clientWidth;
      if (!containerW) return;
      const count = assets.length || 1;
      const fitted = Math.max(80, Math.floor((containerW - GUTTER_W) / count));
      if (fitted !== cur) setResourceWidth(fitted);
    };
    compute();
    const obs = new ResizeObserver(compute);
    obs.observe(el);
    return () => obs.disconnect();
  }, [assets.length, resourceWidthLocked]); // re-runs when lock is released

  // Scroll to 7 AM on mount or when rowHeight changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 7 * rowHeight;
    }
  }, [rowHeight]);

  // Global drag handlers — set up once
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds || !gridBodyRef.current) return;

      const { assets: allAssets, resourceWidth: rw, rowHeight: hourH, setDragState, events, activeCategoryFilter: catFilter, showUnassigned: su, unassignedAssetId: uaid, currentDate: dragCurrentDate, viewMode: dragViewMode, calendarTimezone: dragTz } = useCalendarStore.getState();
      const unassignedInDrag = su && uaid !== null ? allAssets.find(a => a.id === uaid) ?? null : null;
      // Same date-range filter as the render path so drag-target
      // resolution stays in sync with what's visually showing.
      const dragRange = (() => {
        const todayKey = dateKeyInTz(dragCurrentDate, dragTz);
        if (dragViewMode === 'week') {
          const anchor = new Date(`${todayKey}T12:00:00`);
          const dow = anchor.getDay();
          const mondayOffset = dow === 0 ? -6 : 1 - dow;
          const mon = new Date(anchor); mon.setDate(anchor.getDate() + mondayOffset);
          const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
          const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          return { start: fmt(mon), end: fmt(sun) };
        }
        return { start: todayKey, end: todayKey };
      })();
      const assets = [
        ...(unassignedInDrag ? [unassignedInDrag] : []),
        ...allAssets.filter(a =>
          !a.hidden
          && a.id !== uaid
          && (catFilter === null || a.type === catFilter)
          && isActiveInRange(a, dragRange.start, dragRange.end)
        ),
      ];
      const gridRect = gridBodyRef.current.getBoundingClientRect();
      const xInGrid  = e.clientX - gridRect.left;
      const yInGrid  = e.clientY - gridRect.top;

      const assetIndex  = Math.max(0, Math.min(assets.length - 1, Math.floor(xInGrid / rw)));
      const targetAsset = assets[assetIndex];

      const rawTopPx     = Math.max(0, yInGrid - ds.grabOffsetPx);
      const snappedHours = Math.min(23.75, Math.round((rawTopPx / hourH) * 4) / 4);
      const newStart     = `${ds.dateStr}T${hoursToTimeStr(snappedHours)}`;
      const newEnd       = addMsToNaiveDatetime(newStart, ds.durationMs);

      const updated: DragState = { ...ds, targetAssetId: targetAsset.id, newStart, newEnd, hasMoved: true };
      dragStateRef.current = updated;

      // Only update store once (to trigger ghost render in CalendarEvent)
      if (!ds.hasMoved) {
        setDragState(updated);
      }

      const event      = events.find(ev => ev.id === ds.eventId);
      const eventAsset = assets.find(a => a.id === event?.assetId);

      setDragPreview({
        assetId: targetAsset.id,
        top:     snappedHours * hourH,
        height:  Math.max(22, (ds.durationMs / 3600000) * hourH),
        color:   eventAsset?.color ?? targetAsset.color,
        title:   event?.title ?? '',
        newStart,
        newEnd,
      });
    };

    const handleMouseUp = () => {
      const ds = dragStateRef.current;
      if (ds) {
        const { updateEvent, openEditModal, setDragState, calendarTimezone } = useCalendarStore.getState();
        if (ds.hasMoved) {
          const { driverPrefs, driverPrefsSecondary, drivers } = useCalendarStore.getState();
          // On drag, the column's preferred driver wins over the old
          // driver — otherwise the load ends up with a driver who
          // doesn't match the new asset. Primary pref first; secondary
          // is a fallback for trucks that share a driver pair (e.g.
          // sleeper team). If neither is set, the existing driver is
          // kept (no change), since clearing the driver on every drag
          // would be more disruptive than leaving a mismatch the
          // dispatcher can correct in the modal.
          const primaryId   = driverPrefs[ds.targetAssetId];
          const secondaryId = driverPrefsSecondary[ds.targetAssetId];
          const prefDriverId = primaryId ?? secondaryId;
          const prefDriver = prefDriverId != null
            ? drivers.find(d => d.id === prefDriverId)
            : undefined;
          // ds.newStart/newEnd are in view-tz space (drag operates on
          // view-positioned blocks — see CalendarEvent.tsx). Convert
          // back to HOME_TZ before persisting so the round-trip is
          // stable.
          updateEvent(ds.eventId, {
            assetId:    ds.targetAssetId,
            start:      naiveViewToHome(ds.newStart, calendarTimezone),
            end:        naiveViewToHome(ds.newEnd,   calendarTimezone),
            ...(prefDriver ? { driverName: prefDriver.name } : {}),
          });
          // Prevent the upcoming click from firing the column create handler
          document.addEventListener('click', (ce) => { ce.stopPropagation(); }, {
            capture: true, once: true,
          });
        } else {
          openEditModal(ds.eventId);
        }
        dragStateRef.current = null;
        setDragState(null);
      }
      setDragPreview(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const totalW = assets.length * rw + GUTTER_W;

  return (
    <>
    {/* <SmartAssignDrawer />  removed with triage compress mode */}
    <div
      ref={scrollRef}
      className="flex-1 overflow-auto"
      id="cal-scroll"
      style={{
        background:  'var(--gc-surface)',
        userSelect:  dragState ? 'none' : undefined,
        cursor:      dragState?.hasMoved ? 'grabbing' : undefined,
      }}
    >
      <div style={{ minWidth: totalW }}>
        <CalendarHeader />

        <div className="flex">
          <HourGutter />

          {/* Grid body */}
          <div ref={gridBodyRef} data-tour="calendar-grid" className="relative flex z-0" style={{ height: 24 * rowHeight }}>
            {/* Hour lines */}
            {Array.from({ length: 25 }, (_, h) => (
              <div
                key={h}
                className="absolute left-0 right-0 pointer-events-none gc-grid-line"
                style={{ top: h * rowHeight }}
              />
            ))}
            {/* Half-hour lines */}
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={`hh${h}`}
                className="absolute left-0 right-0 pointer-events-none gc-grid-line-half"
                style={{ top: (h + 0.5) * rowHeight }}
              />
            ))}

            {assets.map((asset) => (
              <CalendarColumn key={asset.id} asset={asset} />
            ))}

            <NowLine />

            {/* Drag preview */}
            {dragPreview && (() => {
              const ai = assets.findIndex(a => a.id === dragPreview.assetId);
              if (ai < 0) return null;
              const startLabel = dragPreview.newStart.split('T')[1] ?? '';
              const endLabel   = dragPreview.newEnd.split('T')[1]   ?? '';
              return (
                <div
                  className="absolute rounded pointer-events-none z-50 overflow-hidden"
                  style={{
                    top:             dragPreview.top,
                    height:          dragPreview.height,
                    left:            ai * rw + 2,
                    width:           rw - 4,
                    backgroundColor: hexToRgba(dragPreview.color, 0.9),
                    borderLeft:      `3px solid ${dragPreview.color}`,
                    boxShadow:       '0 4px 16px rgba(0,0,0,0.3)',
                  }}
                >
                  <div className="px-1.5 pt-0.5">
                    <div className="text-[11px] font-bold text-white truncate leading-tight">
                      {dragPreview.title}
                    </div>
                    {dragPreview.height > 28 && (
                      <div className="text-[10px] font-semibold tabular-nums" style={{ color: 'rgba(255,255,255,0.85)' }}>
                        {startLabel}–{endLabel}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
