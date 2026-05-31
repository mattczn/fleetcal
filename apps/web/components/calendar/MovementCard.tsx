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
import { timeToPixels } from '@/lib/time-utils';
import { dateKeyInTz } from '@/lib/lifecycle';

interface Props {
  cluster: MovementCluster;
  assetColor: string;
  onClick?: () => void;
}

export default function MovementCardView({ cluster, assetColor, onClick }: Props) {
  const { rowHeight, currentDate, calendarTimezone } = useCalendarStore();
  // CRITICAL: dateKeyInTz, not localDateStr. The cluster startDay/endDay
  // below are computed in calendarTimezone (org tz). If we use
  // localDateStr (browser tz), users whose browser is east of the org
  // tz get a one-day mismatch and the filter wholesale-drops every
  // cluster — confirmed via the [movements/card] trace where viewRange
  // was 2026-05-26 but dateStr(browser) was 2026-05-27.
  const dateStr = dateKeyInTz(currentDate, calendarTimezone);

  // Convert start/end (UTC ISO) → view-tz YYYY-MM-DDTHH:mm so the same
  // timeToPixels math used by load cards lines up exactly. We use the
  // cluster's displayEndTime (padded but capped at next cluster's
  // start) for the rendered bottom, so blocks never overlap.
  const startNaive   = isoToNaiveTz(cluster.startTime, calendarTimezone);
  const displayNaive = isoToNaiveTz(cluster.displayEndTime, calendarTimezone);
  const realEndNaive = isoToNaiveTz(cluster.endTime, calendarTimezone);

  if (!startNaive) return null;

  const startDay = startNaive.split('T')[0];
  const endDay   = displayNaive.split('T')[0];
  if (endDay < dateStr || startDay > dateStr) return null;

  const top    = startDay < dateStr ? 0 : timeToPixels(startNaive, rowHeight);
  const bottom = endDay > dateStr ? 24 * rowHeight : timeToPixels(displayNaive, rowHeight);
  const height = Math.max(20, bottom - top);

  // realBottom (un-padded) used purely to render the "padded short"
  // visual hint — slightly more transparent so dispatchers know the
  // block was inflated for legibility.
  const realBottom = realEndNaive
    ? (realEndNaive.split('T')[0] > dateStr ? 24 * rowHeight : timeToPixels(realEndNaive, rowHeight))
    : bottom;

  const miles    = cluster.miles ? `${cluster.miles.toFixed(1)} mi` : '';
  const duration = cluster.durationMin
    ? `${Math.floor(cluster.durationMin / 60)}h ${cluster.durationMin % 60}m`.replace(/^0h /, '')
    : '';
  const meta = [miles, duration].filter(Boolean).join(' · ');
  const count = cluster.members.length;
  const isClustered = count > 1;
  const isPaddedShort = realBottom < bottom - 1;

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
        opacity: isPaddedShort ? 0.7 : 0.8, // faded so padded blocks read as "less precise"
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
