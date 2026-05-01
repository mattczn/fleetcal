'use client';

import { GUTTER_W, formatHour } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function HourGutter() {
  const rowHeight = useCalendarStore(s => s.rowHeight);
  const gridH = 24 * rowHeight;

  return (
    <div
      className="sticky left-0 z-10 shrink-0 select-none"
      style={{
        width: GUTTER_W,
        minWidth: GUTTER_W,
        height: gridH,
        background: 'var(--gc-surface)',
        borderRight: '1px solid var(--gc-border-light)',
      }}
    >
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          className="relative"
          style={{ height: rowHeight }}
        >
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
  );
}
