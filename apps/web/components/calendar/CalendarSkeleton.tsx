'use client';

import { useCalendarStore } from '@/store/useCalendarStore';
import { GUTTER_W, hoursToTimeStr } from '@/lib/time-utils';

/**
 * Placeholder grid shown while initial data is loading. Renders the same
 * hour gutter the real calendar uses plus a few greyed-out asset columns
 * with a pulse animation so the page doesn't flash blank.
 */
export default function CalendarSkeleton() {
  const { resourceWidth: rw, rowHeight } = useCalendarStore();
  const skeletonColumns = 5;
  const totalW = GUTTER_W + skeletonColumns * rw;

  return (
    <div className="flex-1 overflow-auto bg-[var(--gc-bg)]" data-tour="calendar-skeleton">
      <div style={{ minWidth: totalW }}>
        {/* Header row */}
        <div className="sticky top-0 z-20 flex"
          style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border)' }}>
          <div style={{ width: GUTTER_W, height: 56 }} />
          {Array.from({ length: skeletonColumns }).map((_, i) => (
            <div key={i} className="flex flex-col items-center justify-center"
              style={{ width: rw, height: 56, gap: 6 }}>
              <div className="skeleton-pulse rounded-full" style={{ width: 32, height: 32 }} />
              <div className="skeleton-pulse rounded" style={{ width: rw * 0.55, height: 8 }} />
            </div>
          ))}
        </div>

        {/* Body: hour gutter + faux columns */}
        <div className="flex relative" style={{ height: 24 * rowHeight }}>
          {/* Hour gutter — real, doesn't need data */}
          <div className="sticky left-0 z-10 shrink-0"
            style={{ width: GUTTER_W, background: 'var(--gc-bg)', borderRight: '1px solid var(--gc-border)' }}>
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h}
                className="flex items-start justify-end pr-2 text-[10px] tabular-nums"
                style={{ height: rowHeight, color: 'var(--gc-text-3)', borderTop: h === 0 ? 'none' : '1px solid var(--gc-border-light)' }}>
                {hoursToTimeStr(h)}
              </div>
            ))}
          </div>

          {/* Faux asset columns with pulsing skeleton blocks */}
          {Array.from({ length: skeletonColumns }).map((_, col) => (
            <div key={col} className="relative shrink-0"
              style={{ width: rw, borderRight: '1px solid var(--gc-border-light)' }}>
              {/* Hour rows */}
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} style={{
                  height: rowHeight,
                  borderTop: h === 0 ? 'none' : '1px solid var(--gc-border-light)',
                  background: h % 2 === 0 ? 'var(--gc-bg)' : 'rgba(0,0,0,0.015)',
                }} />
              ))}
              {/* A couple of fake event blocks per column */}
              {col % 2 === 0 && (
                <div className="absolute skeleton-pulse rounded-md"
                  style={{
                    left: 4, right: 4,
                    top: rowHeight * 8 + 4,
                    height: rowHeight * 3 - 8,
                  }} />
              )}
              {col % 3 === 0 && (
                <div className="absolute skeleton-pulse rounded-md"
                  style={{
                    left: 4, right: 4,
                    top: rowHeight * 14 + 4,
                    height: rowHeight * 2 - 8,
                  }} />
              )}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
