'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { GUTTER_W, formatHour } from '@/lib/time-utils';

/** Best-effort container-width estimate before we can measure the ref.
 *  Subtracts the asset sidebar (Tailwind w-56 = 224px) from window width.
 *  Refined by the useLayoutEffect below once the ref is mounted. */
function estimateContainerWidth(): number {
  if (typeof window === 'undefined') return 1200;
  return Math.max(400, window.innerWidth - 224);
}

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
  const columnCount = lastKnownAssetCount > 0 ? lastKnownAssetCount : 8;

  // Seed columnWidth from a window-based estimate so the very first paint
  // already fills the screen instead of using a 120px default that left
  // the columns bunched on the left for one frame.
  const [columnWidth, setColumnWidth] = useState(() =>
    Math.max(80, Math.floor((estimateContainerWidth() - GUTTER_W) / columnCount)),
  );

  // Refine via the actual container ref before the first paint
  // (useLayoutEffect runs synchronously between commit and paint).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const containerW = el.clientWidth;
      if (!containerW) return;
      const fitted = Math.max(80, Math.floor((containerW - GUTTER_W) / columnCount));
      setColumnWidth(prev => (prev === fitted ? prev : fitted));
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
    <div
      ref={containerRef}
      className="flex-1 overflow-auto"
      style={{ background: 'var(--gc-surface)' }}
      data-tour="calendar-skeleton"
    >
      <div style={{ minWidth: totalW }}>
        {/* Header row */}
        <div className="sticky top-0 z-20 flex"
          style={{ background: 'var(--gc-surface)', borderBottom: '1px solid var(--gc-border)' }}>
          <div style={{ width: GUTTER_W, height: 56 }} />
          {Array.from({ length: columnCount }).map((_, i) => (
            <div key={i} className="flex flex-col items-center justify-center"
              style={{ width: columnWidth, height: 56, gap: 6 }}>
              <div className="skeleton-pulse rounded-full" style={{ width: 32, height: 32 }} />
              <div className="skeleton-pulse rounded" style={{ width: Math.min(80, columnWidth * 0.55), height: 8 }} />
            </div>
          ))}
        </div>

        {/* Body: hour gutter + columns */}
        <div className="flex">
          {/* Hour gutter — matches the real HourGutter layout + labels (12-hour, 12a/6a/12p/6p). */}
          <div className="sticky left-0 z-10 shrink-0 select-none"
            style={{ width: GUTTER_W, height: 24 * rowHeight, background: 'var(--gc-surface)', borderRight: '1px solid var(--gc-border-light)' }}>
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className="relative" style={{ height: rowHeight }}>
                {h > 0 && (
                  <span
                    className="absolute -top-2.5 right-2 text-[11px] font-medium tabular-nums leading-none"
                    style={{ color: 'var(--gc-text-2)' }}
                  >
                    {formatHour(h)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* Grid body — matches the real calendar exactly: plain columns
              with hour + half-hour overlay lines, faux event blocks on top. */}
          <div className="relative flex z-0" style={{ height: 24 * rowHeight }}>
            {Array.from({ length: 25 }).map((_, h) => (
              <div key={`h-${h}`} className="absolute left-0 right-0 pointer-events-none gc-grid-line"
                style={{ top: h * rowHeight }} />
            ))}
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={`hh-${h}`} className="absolute left-0 right-0 pointer-events-none gc-grid-line-half"
                style={{ top: (h + 0.5) * rowHeight }} />
            ))}

            {columnBlocks.map((blocks, col) => (
              <div key={col} className="relative border-r border-gray-100 shrink-0"
                style={{ width: columnWidth, height: 24 * rowHeight }}>
                {blocks.map((b, i) => (
                  <div key={i} className="absolute skeleton-pulse rounded-md"
                    style={{ left: 4, right: 4, top: b.top, height: b.height }} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
