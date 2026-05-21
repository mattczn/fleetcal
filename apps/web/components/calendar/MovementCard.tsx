/**
 * MovementCard — renders one (clustered) Motive driving block on the
 * calendar. Reads as "same truck, different data layer" via dashed
 * border + 50% opacity over the asset color.
 *
 * Takes a MovementCluster (possibly a single period, possibly merged
 * short ones). Enforces a 30-min visual minimum height so short
 * blocks remain readable.
 */
'use client';

import React from 'react';
import { extractCity, type MovementCluster } from '@/lib/clusterMovements';
import { useCalendarStore } from '@/store/useCalendarStore';
import { localDateStr, timeToPixels } from '@/lib/time-utils';

const MIN_HEIGHT_MIN = 30;

interface Props {
  cluster: MovementCluster;
  assetColor: string;
  onClick?: () => void;
}

export default function MovementCardView({ cluster, assetColor, onClick }: Props) {
  const { rowHeight, currentDate, calendarTimezone } = useCalendarStore();
  const dateStr = localDateStr(currentDate);

  // Convert start/end (UTC ISO) → view-tz YYYY-MM-DDTHH:mm so the same
  // timeToPixels math used by load cards lines up exactly.
  const startNaive = isoToNaiveTz(cluster.startTime, calendarTimezone);
  const endNaive   = cluster.endTime && cluster.endTime !== cluster.startTime
    ? isoToNaiveTz(cluster.endTime, calendarTimezone)
    : startNaive;

  if (!startNaive) return null;

  const startDay = startNaive.split('T')[0];
  const endDay   = endNaive.split('T')[0];
  if (endDay < dateStr || startDay > dateStr) return null;

  const top     = startDay < dateStr ? 0 : timeToPixels(startNaive, rowHeight);
  const realBottom = endDay > dateStr ? 24 * rowHeight : timeToPixels(endNaive, rowHeight);
  // Floor at 30 min so short blocks stay legible. We anchor to the
  // real start time and extend downward — the dispatcher knows the
  // start is accurate; the displayed end may be padded.
  const minPixelHeight = (MIN_HEIGHT_MIN / 60) * rowHeight;
  const bottom = Math.max(realBottom, top + minPixelHeight);
  const height = Math.max(20, bottom - top);

  const miles    = cluster.miles ? `${cluster.miles.toFixed(1)} mi` : '';
  const duration = cluster.durationMin
    ? `${Math.floor(cluster.durationMin / 60)}h ${cluster.durationMin % 60}m`.replace(/^0h /, '')
    : '';
  const meta = [miles, duration].filter(Boolean).join(' · ');
  const count = cluster.members.length;
  const isClustered = count > 1;
  const isPaddedShort = realBottom - top < minPixelHeight;

  // Title = cities, not full addresses. The detail panel keeps the
  // raw strings for dispatchers who need the exact destination.
  const oCity = extractCity(cluster.origin);
  const dCity = extractCity(cluster.destination);
  const sameCity = oCity && dCity && oCity.toLowerCase() === dCity.toLowerCase();
  const route = oCity && dCity
    ? (sameCity ? oCity : `${oCity} → ${dCity}`)
    : (oCity ?? dCity ?? '');
  const title = isClustered
    ? (route ? `${count} moves · ${sameCity ? `around ${oCity}` : route}` : `${count} short moves`)
    : route;

  return (
    <div
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className="absolute rounded overflow-hidden z-[5]"
      style={{
        top,
        height,
        left: 2, right: 2,
        background: assetColor,
        opacity: isPaddedShort ? 0.4 : 0.5, // faded so padded blocks read as "less precise"
        border: `1.5px ${isClustered ? 'solid' : 'dashed'} ${assetColor}`,
        cursor: onClick ? 'pointer' : 'default',
        pointerEvents: onClick ? 'auto' : 'none',
      }}
    >
      <div
        className="absolute inset-0 flex flex-col px-1.5 py-1 text-[11px] font-semibold leading-tight"
        style={{
          color: '#ffffff',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
        }}
      >
        <div className="flex items-center gap-1 min-w-0">
          <span className="truncate flex-1">{title}</span>
        </div>
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
