/**
 * OdometerChart — line chart of daily odometer snapshots for one
 * vehicle. Data comes from /v1/movements/odometer (one row per day,
 * captured by the hourly idempotent cron). Uses recharts.
 *
 * Rendered inside AssetDetailModal's right panel when the user
 * clicks the Odometer tab.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  vehicleId: number;
  color:     string;
  /** Days of history to show. Matches the asset modal's range chips. */
  days:      number;
}

interface Point {
  /** Epoch ms — recharts plots numerically and lets us format on demand. */
  t: number;
  miles: number | null;
  trueMiles: number | null;
}

export default function OdometerChart({ vehicleId, color, days }: Props) {
  const { calendarTimezone } = useCalendarStore();
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [points, setPoints]   = useState<Point[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const nowMs   = Date.now();
        const fromIso = new Date(nowMs - days * 86_400_000).toISOString();
        const res     = await railway.listOdometer(vehicleId, fromIso, new Date(nowMs).toISOString());
        if (cancelled) return;
        const pts: Point[] = (res.readings ?? []).map(r => ({
          t:         new Date(r.captured_at).getTime(),
          miles:     r.odometer_miles,
          trueMiles: r.true_odometer_miles,
        }));
        setPoints(pts);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load odometer');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vehicleId, days]);

  // Compute the total miles driven across the window (last − first).
  const summary = useMemo(() => {
    if (points.length === 0) return null;
    const valid = points.filter(p => p.miles != null).map(p => p.miles as number);
    if (valid.length < 2) return null;
    const first = valid[0];
    const last  = valid[valid.length - 1];
    return {
      first,
      last,
      delta: last - first,
      readings: valid.length,
    };
  }, [points]);

  const fmtDay = (t: number) => new Intl.DateTimeFormat('en-US', {
    timeZone: calendarTimezone, month: 'numeric', day: 'numeric',
  }).format(new Date(t));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        {summary ? (
          <div className="flex items-baseline gap-2 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            <span>
              <strong style={{ color: 'var(--gc-text-1)' }}>{Math.round(summary.first).toLocaleString()}</strong>
              {' '}→{' '}
              <strong style={{ color: 'var(--gc-text-1)' }}>{Math.round(summary.last).toLocaleString()}</strong>
              {' '}mi
            </span>
            <span>·</span>
            <span>
              <strong style={{ color: 'var(--gc-text-1)' }}>+{Math.round(summary.delta).toLocaleString()}</strong> in window
            </span>
            <span>·</span>
            <span>{summary.readings} reading{summary.readings === 1 ? '' : 's'}</span>
          </div>
        ) : (
          <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            Odometer snapshots are captured daily — line chart accumulates over time.
          </div>
        )}
      </div>

      {/* Chart area */}
      <div className="flex-1 px-2 pb-4 min-h-0">
        {loading && (
          <div className="flex items-center justify-center h-full gap-2 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {!loading && error && (
          <div className="text-center py-8 text-[12px]" style={{ color: '#d93025' }}>{error}</div>
        )}
        {!loading && !error && points.length === 0 && (
          <div className="text-center py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            No odometer readings yet. The daily snapshot cron captures one row per day —
            check back tomorrow, or hit the Backfill button in Settings → Integrations →
            Motive to grab today&apos;s reading immediately.
          </div>
        )}
        {!loading && !error && points.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 10, right: 16, left: 16, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--gc-border-light)" />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={['dataMin', 'dataMax']}
                tickFormatter={fmtDay}
                stroke="var(--gc-text-3)"
                tick={{ fontSize: 10 }}
                minTickGap={30}
              />
              <YAxis
                domain={['dataMin - 50', 'dataMax + 50']}
                tickFormatter={(v) => Math.round(v).toLocaleString()}
                stroke="var(--gc-text-3)"
                tick={{ fontSize: 10 }}
                width={56}
              />
              <Tooltip
                labelFormatter={(t) => fmtDay(Number(t))}
                formatter={(value) => [
                  `${Math.round(Number(value)).toLocaleString()} mi`,
                  'Odometer',
                ]}
                contentStyle={{
                  background: 'var(--gc-surface)',
                  border: '1px solid var(--gc-border)',
                  borderRadius: 6,
                  fontSize: 11,
                }}
              />
              <Line
                type="monotone"
                dataKey="miles"
                stroke={color}
                strokeWidth={2}
                dot={{ r: 3, fill: color, stroke: 'white', strokeWidth: 1 }}
                activeDot={{ r: 5 }}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
