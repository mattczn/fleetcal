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
import { Loader2, Pencil, Trash2, Check, X } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { railway } from '@/lib/railway';
import { errorToast } from '@/lib/errorToast';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  vehicleId: number;
  color:     string;
  /** Days of history to show. Matches the asset modal's range chips. */
  days:      number;
}

interface Reading {
  id:        number;
  capturedAt: string;
  miles:     number | null;
  trueMiles: number | null;
  source:    string | null;
}

interface Point {
  /** Epoch ms — recharts plots numerically and lets us format on demand. */
  t: number;
  miles: number | null;
  trueMiles: number | null;
}

export default function OdometerChart({ vehicleId, color, days }: Props) {
  const { calendarTimezone } = useCalendarStore();
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  // Manage-readings UI state — toggled by header button.
  const [manageOpen, setManageOpen]   = useState(false);
  const [editingId, setEditingId]     = useState<number | null>(null);
  const [editValue, setEditValue]     = useState<string>('');
  const [savingId, setSavingId]       = useState<number | null>(null);
  const [deletingId, setDeletingId]   = useState<number | null>(null);
  const [confirmDelId, setConfirmDelId] = useState<number | null>(null);

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
        const rs: Reading[] = (res.readings ?? []).map(r => ({
          id:         r.id,
          capturedAt: r.captured_at,
          miles:      r.odometer_miles,
          trueMiles:  r.true_odometer_miles,
          source:     r.source,
        }));
        setReadings(rs);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load odometer');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vehicleId, days]);

  const points: Point[] = useMemo(() => readings.map(r => ({
    t:         new Date(r.capturedAt).getTime(),
    miles:     r.miles,
    trueMiles: r.trueMiles,
  })), [readings]);

  const handleSaveEdit = async (id: number) => {
    const val = editValue.trim();
    if (val === '') return;
    const miles = Number(val.replace(/,/g, ''));
    if (!Number.isFinite(miles) || miles < 0) {
      errorToast(new Error('Must be a non-negative number'), 'Invalid odometer value');
      return;
    }
    setSavingId(id);
    try {
      const res = await railway.updateOdometerReading(id, { odometerMiles: miles });
      setReadings(prev => prev.map(r => r.id === id ? {
        ...r,
        miles:     res.reading.odometer_miles,
        trueMiles: res.reading.true_odometer_miles,
      } : r));
      setEditingId(null);
    } catch (err) {
      errorToast(err, 'Could not save reading');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await railway.deleteOdometerReading(id);
      setReadings(prev => prev.filter(r => r.id !== id));
      setConfirmDelId(null);
    } catch (err) {
      errorToast(err, 'Could not delete reading');
    } finally {
      setDeletingId(null);
    }
  };

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

  // Sort newest-first for the manage list so a recently-bogus reading
  // is at the top where the user is looking.
  const sortedReadings = useMemo(
    () => [...readings].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [readings],
  );

  const fmtFullDate = (iso: string) => new Intl.DateTimeFormat('en-US', {
    timeZone: calendarTimezone,
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));

  const fmtDay = (t: number) => new Intl.DateTimeFormat('en-US', {
    timeZone: calendarTimezone, month: 'numeric', day: 'numeric',
  }).format(new Date(t));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 shrink-0 flex items-center justify-between gap-3">
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
        {readings.length > 0 && (
          <button type="button" onClick={() => setManageOpen(o => !o)}
            className="text-[11px] font-semibold px-2 py-1 rounded transition-colors shrink-0"
            style={{
              color: manageOpen ? 'var(--gc-text-1)' : 'var(--gc-blue)',
              background: manageOpen ? 'var(--gc-hover)' : 'transparent',
              border: '1px solid var(--gc-border-light)',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = manageOpen ? 'var(--gc-hover)' : 'transparent')}>
            {manageOpen ? 'Hide log' : 'Edit log'}
          </button>
        )}
      </div>

      {/* Manage panel — toggled by header button. Newest readings first
          so a recently-bogus row (e.g. fresh-install ELD overshoot) is
          at the top. Inline edit for miles; trash button for delete.
          Source pill ("motive" vs "manual") helps the user identify
          where each row came from. */}
      {manageOpen && (
        <div className="shrink-0 px-3 pb-3" style={{ maxHeight: 260, overflowY: 'auto', borderBottom: '1px solid var(--gc-border-light)' }}>
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
                <th className="text-left font-semibold py-1.5 pl-1">Captured</th>
                <th className="text-right font-semibold py-1.5">Miles</th>
                <th className="text-left font-semibold py-1.5 pl-2">Source</th>
                <th className="text-right font-semibold py-1.5 pr-1" style={{ width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {sortedReadings.map(r => {
                const isEditing = editingId === r.id;
                const isSaving  = savingId === r.id;
                const isDeleting = deletingId === r.id;
                const isConfirming = confirmDelId === r.id;
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                    <td className="py-1.5 pl-1" style={{ color: 'var(--gc-text-2)' }}>{fmtFullDate(r.capturedAt)}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          inputMode="numeric"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') void handleSaveEdit(r.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          style={{
                            width: 90, textAlign: 'right', padding: '2px 4px',
                            border: '1px solid var(--gc-blue)', borderRadius: 4,
                            background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
                            fontSize: 11,
                          }} />
                      ) : (
                        <span style={{ color: 'var(--gc-text-1)' }}>
                          {r.miles != null ? Math.round(r.miles).toLocaleString() : '—'}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pl-2">
                      <span
                        className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded"
                        style={{
                          background: r.source === 'motive' ? '#e8f0fe' : '#f3e8fd',
                          color:      r.source === 'motive' ? '#1558d6' : '#6b21a8',
                        }}>
                        {r.source ?? 'manual'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-1 text-right">
                      {isEditing ? (
                        <span className="inline-flex gap-1">
                          <button type="button" onClick={() => void handleSaveEdit(r.id)} disabled={isSaving}
                            className="inline-flex items-center justify-center"
                            style={{ width: 22, height: 22, borderRadius: 4, background: '#1e8e3e', color: 'white', border: 'none' }}>
                            {isSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                          </button>
                          <button type="button" onClick={() => setEditingId(null)} disabled={isSaving}
                            className="inline-flex items-center justify-center"
                            style={{ width: 22, height: 22, borderRadius: 4, background: 'transparent', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
                            <X size={11} />
                          </button>
                        </span>
                      ) : isConfirming ? (
                        <span className="inline-flex gap-1">
                          <button type="button" onClick={() => void handleDelete(r.id)} disabled={isDeleting}
                            className="inline-flex items-center px-1.5"
                            style={{ height: 22, borderRadius: 4, background: '#d93025', color: 'white', border: 'none', fontSize: 9, fontWeight: 700, textTransform: 'uppercase' }}>
                            {isDeleting ? <Loader2 size={10} className="animate-spin" /> : 'Delete'}
                          </button>
                          <button type="button" onClick={() => setConfirmDelId(null)} disabled={isDeleting}
                            className="inline-flex items-center justify-center"
                            style={{ width: 22, height: 22, borderRadius: 4, background: 'transparent', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
                            <X size={11} />
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex gap-1">
                          <button type="button"
                            onClick={() => { setEditingId(r.id); setEditValue(r.miles != null ? String(Math.round(r.miles)) : ''); }}
                            className="inline-flex items-center justify-center transition-colors"
                            title="Edit miles"
                            style={{ width: 22, height: 22, borderRadius: 4, background: 'transparent', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            <Pencil size={11} />
                          </button>
                          <button type="button"
                            onClick={() => setConfirmDelId(r.id)}
                            className="inline-flex items-center justify-center transition-colors"
                            title="Delete reading"
                            style={{ width: 22, height: 22, borderRadius: 4, background: 'transparent', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = '#fee2e2'; e.currentTarget.style.color = '#d93025'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                            <Trash2 size={11} />
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
            Editing or deleting a reading updates the chart above immediately. Motive cron-captured rows will re-appear on the next daily snapshot if you delete a real one.
          </div>
        </div>
      )}

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
