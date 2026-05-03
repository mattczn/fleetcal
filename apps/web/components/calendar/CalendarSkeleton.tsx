'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { GUTTER_W, hoursToTimeStr } from '@/lib/time-utils';

/**
 * Placeholder grid shown while initial data is loading. Renders the same
 * hour gutter the real calendar uses plus N greyed-out asset columns
 * (where N is the persisted lastKnownAssetCount, defaulting to 8) sized
 * to fill the container width — same logic as CalendarView's auto-fit.
 *
 * Each column gets 3-5 deterministic faux event blocks so the page looks
 * populated rather than half-empty during the load window.
 */
export default function CalendarSkeleton() {
  const { rowHeight, lastKnownAssetCount } = useCalendarStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnWidth, setColumnWidth] = useState(120);

  const columnCount = lastKnownAssetCount > 0 ? lastKnownAssetCount : 8;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const containerW = el.clientWidth;
      if (!containerW) return;
      const fitted = Math.max(80, Math.floor((containerW - GUTTER_W) / columnCount));
      setColumnWidth(fitted);
    };
    compute();
    const obs = new ResizeObserver(compute);
    obs.observe(el);
    return () => obs.disconnect();
  }, [columnCount]);

  // Deterministic per-column event-block layouts. Seeded by column index
  // so the skeleton is stable across re-renders during the same load.
  const columnBlocks = useMemo(() => {
    return Array.from({ length: columnCount }).map((_, col) => {
      const blocks: Array<{ top: number; height: number }> = [];
      // Pseudo-random but deterministic from col index
      const seed = (col * 9301 + 49297) % 233280;
      const rand = (n: number) => (((seed * (n + 1)) ^ (col * 31)) % 100) / 100;
      const blockCount = 3 + (col % 3); // 3, 4, or 5 blocks
      let cursor = 5 + Math.floor(rand(0) * 3); // start hour 5-7
      for (let i = 0; i < blockCount && cursor < 23; i++) {
        const dur = 1 + Math.floor(rand(i + 1) * 3); // 1-3 hours
        const offset = Math.floor(rand(i + 7) * 30); // minutes
        blocks.push({
          top: cursor * rowHeight + offset + 4,
          height: dur * rowHeight - 8,
        });
        cursor += dur + 1 + Math.floor(rand(i + 13) * 2); // gap 1-2 hours
      }
      return blocks;
    });
  }, [columnCount, rowHeight]);

  const totalW = GUTTER_W + columnCount * columnWidth;

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-[var(--gc-bg)]" data-tour="calendar-skeleton">
      <div style={{ minWidth: totalW }}>
        {/* Header row */}
        <div className="sticky top-0 z-20 flex"
          style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border)' }}>
          <div style={{ width: GUTTER_W, height: 56 }} />
          {Array.from({ length: columnCount }).map((_, i) => (
            <div key={i} className="flex flex-col items-center justify-center"
              style={{ width: columnWidth, height: 56, gap: 6 }}>
              <div className="skeleton-pulse rounded-full" style={{ width: 32, height: 32 }} />
              <div className="skeleton-pulse rounded" style={{ width: Math.min(80, columnWidth * 0.55), height: 8 }} />
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

          {/* Faux asset columns */}
          {columnBlocks.map((blocks, col) => (
            <div key={col} className="relative shrink-0"
              style={{ width: columnWidth, borderRight: '1px solid var(--gc-border-light)' }}>
              {/* Hour rows */}
              {Array.from({ length: 24 }).map((_, h) => (
                <div key={h} style={{
                  height: rowHeight,
                  borderTop: h === 0 ? 'none' : '1px solid var(--gc-border-light)',
                  background: h % 2 === 0 ? 'var(--gc-bg)' : 'rgba(0,0,0,0.015)',
                }} />
              ))}
              {/* Faux event blocks */}
              {blocks.map((b, i) => (
                <div key={i} className="absolute skeleton-pulse rounded-md"
                  style={{ left: 4, right: 4, top: b.top, height: b.height }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
