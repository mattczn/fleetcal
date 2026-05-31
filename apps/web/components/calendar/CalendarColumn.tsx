'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { Asset, CalendarEvent as EventType } from '@/lib/types';
import { hoursToTimeStr, timeToPixels, timeHeightPixels, naiveHomeToView, naiveViewToHome } from '@/lib/time-utils';
import { dateKeyInTz } from '@/lib/lifecycle';
import { clusterMovements } from '@/lib/clusterMovements';

import CalendarEvent from './CalendarEvent';
import MovementCardView from './MovementCard';
import AssetDetailModal from './AssetDetailModal';

interface Props {
  asset: Asset;
  compact?: boolean;
  onSmartAssign?: (eventId: string) => void;
}

interface LayoutEvent {
  event: EventType;
  colIdx: number;
  totalCols: number;
  top?: number;
}

function computeLayout(colEvents: EventType[], dateStr: string, rowH: number, viewTz: string): LayoutEvent[] {
  if (colEvents.length === 0) return [];

  const items = colEvents.map(e => {
    // Layout in view-tz space — matches the positions CalendarEvent
    // will paint, so overlap detection lines up with what users see.
    const vs = naiveHomeToView(e.start, viewTz);
    const ve = naiveHomeToView(e.end,   viewTz);
    const top = vs.split('T')[0] < dateStr ? 0 : timeToPixels(vs, rowH);
    const h = timeHeightPixels(vs, ve, dateStr, rowH);
    return { event: e, top, bottom: top + h };
  });

  items.sort((a, b) => a.top - b.top);

  // Greedy column slot assignment
  const slots: number[] = []; // bottom px of last event in each slot column
  const colAssign: number[] = new Array(items.length).fill(0);

  for (let i = 0; i < items.length; i++) {
    const { top, bottom } = items[i];
    let placed = false;
    for (let c = 0; c < slots.length; c++) {
      if (slots[c] <= top + 2) {
        colAssign[i] = c;
        slots[c] = bottom;
        placed = true;
        break;
      }
    }
    if (!placed) {
      colAssign[i] = slots.length;
      slots.push(bottom);
    }
  }

  // totalCols: start with max colIdx among directly overlapping events + 1
  const totalColsArr = items.map((_, i) => {
    const { top: iTop, bottom: iBottom } = items[i];
    let maxCol = colAssign[i];
    for (let j = 0; j < items.length; j++) {
      if (j === i) continue;
      const { top: jTop, bottom: jBottom } = items[j];
      if (jTop < iBottom - 2 && jBottom > iTop + 2) maxCol = Math.max(maxCol, colAssign[j]);
    }
    return maxCol + 1;
  });

  // Propagate totalCols through overlapping pairs — prevents inconsistent widths when
  // an event reuses a vacated slot but overlaps a neighbor with a wider cluster.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const { top: iTop, bottom: iBottom } = items[i];
        const { top: jTop, bottom: jBottom } = items[j];
        if (jTop < iBottom - 2 && jBottom > iTop + 2) {
          const mx = Math.max(totalColsArr[i], totalColsArr[j]);
          if (totalColsArr[i] !== mx) { totalColsArr[i] = mx; changed = true; }
          if (totalColsArr[j] !== mx) { totalColsArr[j] = mx; changed = true; }
        }
      }
    }
  }

  return items.map(({ event }, i) => ({ event, colIdx: colAssign[i], totalCols: totalColsArr[i] }));
}

export default function CalendarColumn({ asset, compact = false, onSmartAssign }: Props) {
  const { events, resourceWidth: rw, rowHeight, currentDate, openCreateModal, calendarTimezone, calendarMode, movementsByVehicle, movementsLoading } = useCalendarStore();
  // When a movement card is clicked, we open AssetDetailModal pre-
  // focused on that cluster — pass the first member's Motive period id
  // so the modal can find the right cluster after its own re-fetch.
  const [openMovementId, setOpenMovementId] = useState<number | null>(null);
  // dateKeyInTz (org tz), NOT localDateStr (browser tz). The event
  // filter below compares against eStart/eEnd derived via
  // naiveHomeToView which uses calendarTimezone — both sides must
  // agree on tz or users east of the org tz lose every event/cluster
  // across the midnight boundary. Same fix as MovementCard.
  const dateStr = dateKeyInTz(currentDate, calendarTimezone);
  const mode = calendarMode;

  // Movements mode — render Motive driving-period cards instead of
  // load events. Movements come keyed by Motive vehicleId (numeric)
  // so we map our asset's motive_vehicle_id (text) into that key.
  // Clustering folds noisy short periods together (see clusterMovements
  // for the rules) so the column reads cleanly instead of as a column
  // of unreadable 2-pixel slivers.
  const rawMovements = mode === 'movements' && asset.motiveVehicleId
    ? (movementsByVehicle[String(asset.motiveVehicleId)] ?? [])
    : [];
  const movementClusters = clusterMovements(rawMovements);

  const colEvents = mode === 'movements' ? [] : events.filter((e) => {
    if (e.assetId !== asset.id) return false;
    // Drop soft-deleted events. Most paths only put live events into
    // the store, but the search-bar dropdown for cancelled / deleted
    // loads merges those into events too so the modal can find them
    // on click. The column render shouldn't draw a bar for them.
    if (e.deletedAt) return false;
    // Filter against view-tz dates so events that straddle midnight in
    // home-tz but fall fully inside today in view-tz still render.
    const vs = naiveHomeToView(e.start, calendarTimezone);
    const ve = naiveHomeToView(e.end,   calendarTimezone);
    const eStart = vs.split('T')[0];
    const eEnd   = ve.split('T')[0];
    return eStart === dateStr || (eStart < dateStr && eEnd >= dateStr);
  });

  const layoutEvents = computeLayout(colEvents, dateStr, rowHeight, calendarTimezone);

  // In triage mode, position events at their real start time with a fixed 1-hour height.
  // Run the same overlap algorithm but using 1-hour bounds so side-by-side stacking works.
  const triageLayout: LayoutEvent[] | null = compact
    ? (() => {
        if (colEvents.length === 0) return [];
        const items = colEvents.map(e => {
          const vs = naiveHomeToView(e.start, calendarTimezone);
          const top = vs.split('T')[0] < dateStr ? 0 : timeToPixels(vs, rowHeight);
          return { event: e, top, bottom: top + rowHeight };
        });
        items.sort((a, b) => a.top - b.top);
        const slots: number[] = [];
        const colAssign: number[] = new Array(items.length).fill(0);
        for (let i = 0; i < items.length; i++) {
          const { top, bottom } = items[i];
          let placed = false;
          for (let c = 0; c < slots.length; c++) {
            if (slots[c] <= top + 2) { colAssign[i] = c; slots[c] = bottom; placed = true; break; }
          }
          if (!placed) { colAssign[i] = slots.length; slots.push(bottom); }
        }
        const totalColsArr = items.map((_, i) => {
          const { top: iTop, bottom: iBottom } = items[i];
          let maxCol = colAssign[i];
          for (let j = 0; j < items.length; j++) {
            if (j === i) continue;
            const { top: jTop, bottom: jBottom } = items[j];
            if (jTop < iBottom - 2 && jBottom > iTop + 2) maxCol = Math.max(maxCol, colAssign[j]);
          }
          return maxCol + 1;
        });
        let changed = true;
        while (changed) {
          changed = false;
          for (let i = 0; i < items.length; i++) {
            for (let j = i + 1; j < items.length; j++) {
              const { top: iTop, bottom: iBottom } = items[i];
              const { top: jTop, bottom: jBottom } = items[j];
              if (jTop < iBottom - 2 && jBottom > iTop + 2) {
                const mx = Math.max(totalColsArr[i], totalColsArr[j]);
                if (totalColsArr[i] !== mx) { totalColsArr[i] = mx; changed = true; }
                if (totalColsArr[j] !== mx) { totalColsArr[j] = mx; changed = true; }
              }
            }
          }
        }
        return items.map(({ event, top }, i) => ({ event, colIdx: colAssign[i], totalCols: totalColsArr[i], top }));
      })()
    : null;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (compact) return; // clicks handled by individual events in triage mode
    if (mode === 'movements') return; // movements column is read-only
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const rawHours  = Math.max(0, Math.min(23.75, y / rowHeight));
    const startH    = Math.floor(rawHours * 4) / 4;
    const endH      = Math.min(24, startH + 1);

    // Clicked position is in view-tz space; convert to HOME_TZ before
    // storing so the round-trip through naiveHomeToView lands back on
    // the user-clicked time.
    openCreateModal({
      assetId: asset.id,
      start: naiveViewToHome(`${dateStr}T${hoursToTimeStr(startH)}`, calendarTimezone),
      end:   naiveViewToHome(`${dateStr}T${hoursToTimeStr(endH)}`,   calendarTimezone),
    });
  };

  return (
    <div
      className={`relative border-r border-gray-100 shrink-0 group ${mode === 'movements' ? '' : 'cursor-pointer'}`}
      style={{ width: rw, minWidth: rw, height: 24 * rowHeight }}
      onClick={handleClick}
    >
      {mode !== 'movements' && (
        <div className="absolute inset-0 group-hover:bg-blue-50/20 transition-colors pointer-events-none" />
      )}
      {mode === 'movements' ? (
        // Telemetry view — render Motive driving periods, clustered.
        // No overlap algorithm needed since clusters don't conflict in
        // time. Asset color + dashed/solid border + 50% opacity in
        // MovementCard so it reads as "same truck, different layer."
        <>
          {movementClusters.map(c => (
            <MovementCardView
              key={c.id}
              cluster={c}
              assetColor={asset.color}
              onClick={() => setOpenMovementId(c.members[0].id)}
            />
          ))}
          {movementsLoading && movementClusters.length === 0 && (
            <div className="absolute inset-x-0 top-12 flex flex-col items-center gap-2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={18} className="animate-spin" />
              <span className="text-[11px] font-medium">Loading movements…</span>
            </div>
          )}
        </>
      ) : triageLayout
        ? triageLayout.map(({ event, colIdx, totalCols, top }) => (
            <CalendarEvent
              key={event.id}
              event={event}
              asset={asset}
              colIdx={colIdx}
              totalCols={totalCols}
              compact
              overrideTop={top}
              overrideHeight={rowHeight}
              onSmartAssign={onSmartAssign}
            />
          ))
        : layoutEvents.map(({ event, colIdx, totalCols }) => (
            <CalendarEvent key={event.id} event={event} asset={asset} colIdx={colIdx} totalCols={totalCols} onSmartAssign={onSmartAssign} />
          ))
      }
      {openMovementId !== null && (
        <AssetDetailModal
          asset={asset}
          location={null}
          initialMotivePeriodId={openMovementId}
          onClose={() => setOpenMovementId(null)}
        />
      )}
    </div>
  );
}
