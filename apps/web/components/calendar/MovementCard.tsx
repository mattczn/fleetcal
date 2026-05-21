/**
 * MovementCard — renders one Motive driving period on the calendar in
 * the same vertical lane that load events use. Reads as "same truck,
 * different data layer" via a dashed border + 50% opacity over the
 * asset color (dispatcher-picked decision from prototype kickoff).
 *
 * Read-only: the calendar's Movements mode is a telemetry view. No
 * click-to-edit. The card just labels what actually moved.
 */
'use client';

import React from 'react';
import type { MovementCard as MovementCardData } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { localDateStr, timeToPixels } from '@/lib/time-utils';

interface Props {
  movement: MovementCardData;
  assetColor: string;
}

export default function MovementCardView({ movement, assetColor }: Props) {
  const { rowHeight, currentDate, calendarTimezone } = useCalendarStore();
  const dateStr = localDateStr(currentDate);

  // Convert start/end (UTC ISO) → view-tz YYYY-MM-DDTHH:mm so the same
  // timeToPixels math used by load cards lines up exactly.
  const startNaive = isoToNaiveTz(movement.startTime, calendarTimezone);
  const endNaive   = movement.endTime
    ? isoToNaiveTz(movement.endTime, calendarTimezone)
    : startNaive; // in-progress periods don't render a height

  if (!startNaive) return null;

  const startDay = startNaive.split('T')[0];
  const endDay   = endNaive.split('T')[0];
  if (endDay < dateStr || startDay > dateStr) return null;

  const top = startDay < dateStr ? 0 : timeToPixels(startNaive, rowHeight);
  const bottom = endDay > dateStr ? 24 * rowHeight : timeToPixels(endNaive, rowHeight);
  const height = Math.max(20, bottom - top);

  const miles    = movement.miles != null ? `${movement.miles.toFixed(1)} mi` : '';
  const duration = movement.durationMin != null
    ? `${Math.floor(movement.durationMin / 60)}h ${movement.durationMin % 60}m`.replace(/^0h /, '')
    : '';
  const meta = [miles, duration].filter(Boolean).join(' · ');

  return (
    <div
      className="absolute rounded overflow-hidden z-[5]"
      style={{
        top,
        height,
        left: 2, right: 2,
        background: assetColor,
        opacity: 0.5,
        border: `1.5px dashed ${assetColor}`,
        cursor: 'default',
        pointerEvents: 'none',
      }}
    >
      <div
        className="absolute inset-0 flex flex-col px-1.5 py-1 text-[11px] font-semibold leading-tight"
        style={{
          color: '#ffffff',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        }}
      >
        <span className="truncate">
          {movement.origin ?? ''}
          {movement.origin && movement.destination ? ' → ' : ''}
          {movement.destination ?? ''}
        </span>
        {meta && <span className="text-[10px] opacity-90 truncate">{meta}</span>}
      </div>
    </div>
  );
}

/** Convert an absolute ISO (UTC) to "YYYY-MM-DDTHH:mm" interpreted in
 *  the given IANA timezone. Mirrors the inverse of naiveHomeToView but
 *  takes UTC rather than naive-home time. */
function isoToNaiveTz(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
