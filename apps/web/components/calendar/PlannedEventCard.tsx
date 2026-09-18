'use client';

import { Search, Clock, MoveRight, User } from 'lucide-react';
import type { PlannedEvent, PlannedPurpose } from '@fleetcal/types';
import { PLANNED_PURPOSE_LABEL } from '@fleetcal/types';
import type { Asset } from '@/lib/types';
import { timeToPixels, timeHeightPixels, localDateStr, naiveHomeToView } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';

const PURPOSE_ICON: Record<PlannedPurpose, typeof Search> = {
  find_load:     Search,
  expected_load: Clock,
  reposition:    MoveRight,
};

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(107,114,128,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

interface Props {
  plan: PlannedEvent;
  asset: Asset;
  colIdx: number;
  totalCols: number;
}

/**
 * A planned placeholder on a truck's column. Deliberately the opposite
 * of a load card: no fill, a dashed outline and diagonal hatching in
 * the truck's color, so it can never be mistaken for booked work at a
 * glance. Expired plans (24h past their end with no load attached)
 * fade out but stay until someone deletes them.
 *
 * Drags like a load card (drop on another truck/time to move it);
 * a click opens it in the event modal.
 */
export default function PlannedEventCard({ plan, asset, colIdx, totalCols }: Props) {
  const { currentDate, rowHeight, calendarTimezone, cardFontScale, openPlanModal, dragState, setDragState } = useCalendarStore();
  const { can } = usePermissions();
  const canDrag = can('planning.access');
  const dragId = `plan:${plan.id}`;
  const isDragging = dragState?.eventId === dragId && dragState.hasMoved;

  const scale = cardFontScale ?? 1.0;
  const fs = (px: number) => Math.round(px * scale * 2) / 2;

  const viewStart = naiveHomeToView(plan.start, calendarTimezone);
  const viewEnd   = naiveHomeToView(plan.end,   calendarTimezone);
  const dateStr = localDateStr(currentDate);
  const top    = viewStart.split('T')[0] < dateStr ? 0 : timeToPixels(viewStart, rowHeight);
  const height = timeHeightPixels(viewStart, viewEnd, dateStr, rowHeight);

  const color = asset.color || '#6b7280';
  const Icon = PURPOSE_ICON[plan.purpose] ?? Search;
  const label = PLANNED_PURPOSE_LABEL[plan.purpose] ?? 'Planned';
  const startTime = viewStart.split('T')[1]?.slice(0, 5) ?? '';
  const endTime   = viewEnd.split('T')[1]?.slice(0, 5) ?? '';

  return (
    <div
      role="button"
      tabIndex={0}
      className="absolute rounded overflow-hidden z-10"
      style={{
        top,
        height: Math.max(22, height - 2),
        left:  `calc(${(colIdx / totalCols) * 100}% + 2px)`,
        width: `calc(${(1 / totalCols) * 100}% - 4px)`,
        backgroundColor: 'var(--gc-surface)',
        backgroundImage: `repeating-linear-gradient(135deg, transparent 0 7px, ${hexToRgba(color, 0.14)} 7px 9px)`,
        border: `1.5px dashed ${color}`,
        opacity: isDragging ? 0.3 : plan.expired ? 0.5 : 1,
        cursor: isDragging ? 'grabbing' : canDrag ? 'grab' : 'pointer',
        pointerEvents: isDragging ? 'none' : 'auto',
        userSelect: 'none',
      }}
      // Same drag system as load cards (calendar/index.tsx): a drop on
      // a new truck/time saves the plan; a mouseup without movement is
      // a click and opens it in the event modal.
      onMouseDown={(e) => {
        e.stopPropagation();
        if (!canDrag) return;
        setDragState({
          eventId: dragId,
          planId: plan.id,
          targetAssetId: asset.id,
          newStart: viewStart,
          newEnd: viewEnd,
          hasMoved: false,
          pointerStartX: e.clientX,
          pointerStartY: e.clientY,
          originAssetId: asset.id,
          originStart: viewStart,
          originEnd: viewEnd,
        });
      }}
      onClick={(e) => { e.stopPropagation(); if (!canDrag) openPlanModal(plan.id); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPlanModal(plan.id); } }}
      title={`${label} · ${plan.title} · ${startTime}–${endTime}${plan.expired ? ' · Expired' : ''}`}
    >
      <div className="px-1.5 pt-1 flex flex-col gap-0.5 h-full overflow-hidden">
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="inline-flex items-center gap-1 rounded px-1 font-bold uppercase tracking-wide shrink-0"
            style={{ fontSize: fs(8.5), lineHeight: '14px', color, background: hexToRgba(color, 0.12) }}
          >
            <Icon size={Math.round(fs(9))} strokeWidth={2.6} />
            {plan.expired ? 'Expired' : label}
          </span>
        </div>
        <div
          className="font-extrabold leading-tight break-words"
          style={{ color: 'var(--gc-text-1)', fontSize: fs(11) }}
        >
          {plan.title}
        </div>
        {plan.driverName && (
          <div className="flex items-center gap-1 truncate font-medium" style={{ color: 'var(--gc-text-2)', fontSize: fs(10) }}>
            <User size={Math.round(fs(9))} style={{ flexShrink: 0, opacity: 0.75 }} />
            <span className="truncate">{plan.driverName}</span>
          </div>
        )}
        {plan.notes && (
          <div className="leading-tight break-words" style={{ color: 'var(--gc-text-2)', fontSize: fs(10) }}>
            {plan.notes}
          </div>
        )}
      </div>
    </div>
  );
}
