'use client';

import { useEffect, useState } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { localDateStr, nowInTz, todayStrInTz } from '@/lib/time-utils';

function isTodayVisible(currentDate: Date, viewMode: 'day' | 'week', tz: string): boolean {
  const today = todayStrInTz(tz);
  if (viewMode === 'day') return localDateStr(currentDate) === today;
  const dow = currentDate.getDay();
  const mon = new Date(currentDate);
  mon.setDate(currentDate.getDate() - ((dow + 6) % 7));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return today >= localDateStr(mon) && today <= localDateStr(sun);
}

export default function NowLine() {
  const rowHeight        = useCalendarStore(s => s.rowHeight);
  const currentDate      = useCalendarStore(s => s.currentDate);
  const viewMode         = useCalendarStore(s => s.viewMode);
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const [top, setTop] = useState<number | null>(null);

  useEffect(() => {
    const update = () => {
      const now = nowInTz(calendarTimezone);
      setTop((now.getHours() + now.getMinutes() / 60) * rowHeight);
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [rowHeight, calendarTimezone]);

  if (top === null || !isTodayVisible(currentDate, viewMode, calendarTimezone)) return null;

  return (
    <div
      className="absolute left-0 right-0 pointer-events-none z-20"
      style={{ top }}
    >
      <div className="relative flex items-center">
        <div className="w-3 h-3 rounded-full shrink-0 -ml-1.5" style={{ background: 'var(--gc-red)' }} />
        <div className="flex-1 h-px" style={{ background: 'var(--gc-red)' }} />
      </div>
    </div>
  );
}
