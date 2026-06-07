/**
 * PeriodSelector — pill row + optional custom-date pickers for any
 * surface that scopes data by a time window.
 *
 * Behavior:
 *   • Pill row of the 6 PERIODS (week / month / 30d / 90d / YTD / custom).
 *   • When the user picks "Custom", a second row appears with two
 *     DatePicker inputs and a dash between them.
 *   • Below that, a small muted line shows the resolved range
 *     ("May 1 – May 27, 2026") so the dispatcher always knows what
 *     window the numbers above came from.
 *
 * Pure presentational — caller owns state. Pass in current values +
 * change handlers; we render and emit clicks.
 */

'use client';

import type { Period } from '@/lib/periodRange';
import { PERIODS, getPeriodRange, startedWeeksISO, currentWeekStartISO } from '@/lib/periodRange';
import DatePicker from '@/components/calendar/DatePicker';
import { LOAD_ACCENT } from '@/lib/loadAccent';
import { useMemo } from 'react';

export interface PeriodSelectorProps {
  period: Period;
  onPeriodChange: (p: Period) => void;
  customStart: string;     // YYYY-MM-DD
  customEnd:   string;     // YYYY-MM-DD
  onCustomStartChange: (iso: string) => void;
  onCustomEndChange:   (iso: string) => void;
  /** Selected week's Saturday for the 'week' period. When omitted,
   *  defaults to the current week. Pass + handle to enable picking
   *  any started week from the dropdown. */
  weekStart?:        string;
  onWeekStartChange?: (iso: string) => void;
  /** Render the date-range label under the pills (default true).
   *  Set false when the page already shows the range elsewhere. */
  showRangeLabel?: boolean;
}

export function PeriodSelector({
  period, onPeriodChange,
  customStart, customEnd, onCustomStartChange, onCustomEndChange,
  weekStart, onWeekStartChange,
  showRangeLabel = true,
}: PeriodSelectorProps) {
  const effectiveWeekStart = weekStart ?? currentWeekStartISO();
  const range = getPeriodRange(period, {
    startISO:      customStart,
    endISO:        customEnd,
    weekStartISO:  effectiveWeekStart,
  });
  const weeks = useMemo(() => startedWeeksISO(12), []);

  return (
    <div className="flex flex-col items-end gap-1.5 shrink-0">
      <div
        className="flex items-center rounded-full"
        style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-hover)', padding: 2 }}>
        {PERIODS.map(p => {
          const active = period === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => onPeriodChange(p.value)}
              // rounded-full to match the bar — `rounded-lg` left
              // square-ish corners inside a fully-rounded track, which
              // looked off against the outer pill shape.
              className="px-3 py-1 rounded-full text-[13px] font-medium transition-all"
              style={{
                background: active ? 'var(--gc-surface)' : 'transparent',
                color:      active ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                boxShadow:  active ? 'var(--shadow-1)' : 'none',
              }}>
              {p.label}
            </button>
          );
        })}
      </div>
      {period === 'week' && onWeekStartChange && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded"
          style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
          <select
            value={effectiveWeekStart}
            onChange={(e) => onWeekStartChange(e.target.value)}
            className="text-[13px] font-semibold bg-transparent border-0 outline-none cursor-pointer"
            style={{ color: 'var(--gc-text-1)' }}
          >
            {weeks.map((w) => (
              <option key={w.weekStart} value={w.weekStart}>{w.label}</option>
            ))}
          </select>
        </div>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5">
          <DatePicker
            value={customStart}
            onChange={onCustomStartChange}
            headerColor={LOAD_ACCENT}
          />
          <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>–</span>
          <DatePicker
            value={customEnd}
            onChange={onCustomEndChange}
            headerColor={LOAD_ACCENT}
            min={customStart || undefined}
          />
        </div>
      )}
      {showRangeLabel && (
        <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>
          {range.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' – '}
          {range.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      )}
    </div>
  );
}
