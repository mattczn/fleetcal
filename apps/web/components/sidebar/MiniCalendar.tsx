'use client';

import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { localDateStr, todayStrInTz, dayAtNoon } from '@/lib/time-utils';

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export default function MiniCalendar() {
  const { currentDate, setCurrentDate, calendarTimezone } = useCalendarStore();

  const [viewYear,  setViewYear]  = useState(currentDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(currentDate.getMonth());

  // SSR can render at a different wall-clock time than the client's hydrate.
  // Withhold "today" + "selected" styling until after mount to avoid the
  // hydration mismatch. The plain day numbers still render server-side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Sync view when main calendar navigates to a different month
  useEffect(() => {
    setViewYear(currentDate.getFullYear());
    setViewMonth(currentDate.getMonth());
  }, [currentDate.getFullYear(), currentDate.getMonth()]);

  const todayStr    = todayStrInTz(calendarTimezone);
  const selectedStr = localDateStr(currentDate);

  const firstDOW    = new Date(viewYear, viewMonth, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Build grid: leading nulls + day numbers + trailing nulls to fill 7-col rows
  const cells: (number | null)[] = [
    ...Array<null>(firstDOW).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const goMonth = (delta: number) => {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0)  { m = 11; y--; }
    if (m > 11) { m = 0;  y++; }
    setViewMonth(m);
    setViewYear(y);
  };

  const selectDay = (day: number) => {
    setCurrentDate(dayAtNoon(viewYear, viewMonth, day));
  };

  return (
    <div className="px-2 pb-3 pt-1 select-none">
      {/* Month header */}
      <div className="flex items-center justify-between mb-1 px-1">
        <button
          onClick={() => goMonth(-1)}
          className="p-1 rounded-full transition-colors"
          style={{ color: 'var(--gc-text-2)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <ChevronLeft size={14} />
        </button>

        <button
          onClick={() => {
            const t = new Date(todayStr);
            setViewYear(t.getFullYear());
            setViewMonth(t.getMonth());
          }}
          className="text-[12px] font-semibold transition-colors rounded px-1"
          style={{ color: 'var(--gc-text-1)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--gc-blue)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-1)')}
        >
          {MONTHS[viewMonth]} {viewYear}
        </button>

        <button
          onClick={() => goMonth(1)}
          className="p-1 rounded-full transition-colors"
          style={{ color: 'var(--gc-text-2)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-0.5">
        {DOW.map((d, i) => (
          <div key={i} className="flex items-center justify-center"
            style={{ height: 24, fontSize: 10, fontWeight: 700, color: 'var(--gc-text-3)' }}>
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (!day) return <div key={i} style={{ height: 28 }} />;

          const pad    = (n: number) => String(n).padStart(2, '0');
          const dStr   = `${viewYear}-${pad(viewMonth + 1)}-${pad(day)}`;
          const isSel  = mounted && dStr === selectedStr;
          const isTday = mounted && dStr === todayStr;

          return (
            <button
              key={i}
              onClick={() => selectDay(day)}
              className="flex items-center justify-center rounded-full transition-colors mx-auto"
              style={{
                width: 28, height: 28,
                fontSize: 11,
                fontWeight: isSel || isTday ? 700 : 400,
                background: isSel ? 'var(--gc-blue)' : 'transparent',
                color: isSel ? 'white' : isTday ? 'var(--gc-blue)' : 'var(--gc-text-1)',
                outline: isTday && !isSel ? '1.5px solid var(--gc-blue)' : 'none',
                outlineOffset: -2,
              }}
              onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--gc-hover-strong)'; }}
              onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
