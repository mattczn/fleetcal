'use client';

import { useEffect, useState } from 'react';
import Tooltip from '@/components/ui/Tooltip';

interface WindowTimelineProps {
  start: Date;
  end: Date;
  railColor?: string;
  nowColor?: string;
}

function fmtBound(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });
}

function fmtTimeOnly(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });
}

/**
 * Visual representation of a time window with a "now" marker — used in the
 * loads tray + command center to make it instantly clear what range of
 * loads the user is looking at and where the current moment falls in it.
 *
 *   Mon Mar 5, 2:30 AM  ──●─────  2:30 PM
 *
 * Same-day windows abbreviate the right label (just time). Multi-day
 * windows show the full date on both sides. The dot is hidden when the
 * window is shifted entirely into the past or future, with a small text
 * hint instead so the user understands the window has moved off "now".
 */
export default function WindowTimeline({
  start,
  end,
  railColor = 'var(--gc-border)',
  nowColor = '#1a73e8',
}: WindowTimelineProps) {
  // Tick every 60s so the dot drifts right with real time.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const total   = end.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();
  const nowPct  = total > 0 ? Math.max(0, Math.min(100, (elapsed / total) * 100)) : 50;
  const nowInside = elapsed >= 0 && elapsed <= total;

  const sameDay   = start.toDateString() === end.toDateString();
  const startLabel = fmtBound(start);
  const endLabel   = sameDay ? fmtTimeOnly(end) : fmtBound(end);

  // Hint when "now" is outside the window so the missing dot isn't confusing.
  let outsideHint: string | null = null;
  if (!nowInside) {
    const ms = elapsed < 0 ? -elapsed : (now.getTime() - end.getTime());
    const hrs = Math.round(ms / 3_600_000);
    if (hrs >= 24) {
      const days = Math.round(hrs / 24);
      outsideHint = elapsed < 0 ? `now in ${days}d` : `now ${days}d ago`;
    } else if (hrs >= 1) {
      outsideHint = elapsed < 0 ? `now in ${hrs}h` : `now ${hrs}h ago`;
    } else {
      outsideHint = elapsed < 0 ? 'now soon' : 'now just past';
    }
  }

  const tooltipContent = `Now · ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;

  return (
    <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
      <span style={{ fontSize: 11, color: 'var(--gc-text-3)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {startLabel}
      </span>
      <div className="relative" style={{ flex: '1 1 0', minWidth: 80, maxWidth: 240, height: 12 }}>
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full"
          style={{ height: 3, background: railColor }} />
        {nowInside && (
          <div className="absolute top-1/2"
            style={{ left: `${nowPct}%`, transform: 'translate(-50%, -50%)' }}>
            <Tooltip content={tooltipContent}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%',
                background: nowColor,
                boxShadow: '0 0 0 2px white, 0 0 4px rgba(0,0,0,.2)',
                cursor: 'default',
              }} />
            </Tooltip>
          </div>
        )}
      </div>
      <span style={{ fontSize: 11, color: 'var(--gc-text-3)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {endLabel}
      </span>
      {outsideHint && (
        <span style={{ fontSize: 10, color: 'var(--gc-text-3)', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
          ({outsideHint})
        </span>
      )}
    </div>
  );
}
