'use client';

import { useEffect, useState } from 'react';
import Tooltip from '@/components/ui/Tooltip';

interface WindowTimelineProps {
  start: Date;
  end: Date;
}

/** "12 hours ago" / "12 hours from now" / "now". Rounds to the nearest unit. */
function relTime(d: Date, now: Date): string {
  const ms = d.getTime() - now.getTime();
  const absMs = Math.abs(ms);
  if (absMs < 5 * 60_000) return 'now';

  let n: number;
  let unit: string;
  if (absMs >= 24 * 3_600_000) {
    n = Math.round(absMs / (24 * 3_600_000));
    unit = n === 1 ? 'day' : 'days';
  } else if (absMs >= 3_600_000) {
    n = Math.round(absMs / 3_600_000);
    unit = n === 1 ? 'hour' : 'hours';
  } else {
    n = Math.max(1, Math.round(absMs / 60_000));
    unit = n === 1 ? 'minute' : 'minutes';
  }
  return ms < 0 ? `${n} ${unit} ago` : `${n} ${unit} from now`;
}

function fmtAbsolute(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined, hour12: true });
}

/**
 * Plain-language description of the time window the loads list is showing.
 *
 *   "Showing loads from 12 hours ago to 12 hours from now"
 *
 * Hover tooltip reveals the exact start/end timestamps. Self-ticks every
 * 60s so phrasing stays current as time passes.
 */
export default function WindowTimeline({ start, end }: WindowTimelineProps) {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const startRel = relTime(start, now);
  const endRel   = relTime(end, now);
  const tooltip  = `${fmtAbsolute(start)} → ${fmtAbsolute(end)}`;

  return (
    <Tooltip content={tooltip}>
      <span style={{ fontSize: 12, color: 'var(--gc-text-2)', whiteSpace: 'nowrap' }}>
        Showing loads from{' '}
        <strong style={{ color: 'var(--gc-text-1)', fontWeight: 700 }}>{startRel}</strong>
        {' to '}
        <strong style={{ color: 'var(--gc-text-1)', fontWeight: 700 }}>{endRel}</strong>
      </span>
    </Tooltip>
  );
}
