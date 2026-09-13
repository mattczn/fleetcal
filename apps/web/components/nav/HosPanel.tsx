'use client';

/**
 * HosPanel — the duty board. Centered full-height overlay, same shape
 * as SafetyPanel: driver list on the left rail, detail on the right.
 *
 * The board answers "who can I use, and who needs chasing". Hours are
 * the substrate, but the product is the enforcement loop — so the two
 * things a dispatcher can act on lead:
 *
 *   Unverified OTR logs. A driver on an OTR run must be keeping a RODS
 *   somewhere (Motive or paper) and someone has to confirm it. Nothing
 *   else in the business records that, and an unconfirmed OTR day is a
 *   roadside problem waiting to happen.
 *
 *   Paper-log days. A driver may keep paper RODS on at most 8 days in
 *   any rolling 30 before an ELD is legally required. With OTR slots
 *   rotating across the fleet, crossing that line is invisible without
 *   a counter.
 *
 * Sorting is by usefulness, not alphabet: on-duty OTR first (the ones
 * with a live compliance obligation), then on-duty local, then off-duty
 * ordered by who frees up soonest. "Who can I use next" is the question
 * the left rail should answer by being read top to bottom.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Loader2, Clock, AlertTriangle, Check, RefreshCw, CircleAlert, Pencil,
} from 'lucide-react';
import { railway, type HosBoardDriver, type HosBoardShift, type HosDutyEvent } from '@/lib/railway';

// ── formatting ───────────────────────────────────────────────────────

function fmtHours(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtClock(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit',
  });
}

function fmtDayClock(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date().toLocaleDateString('en-CA', { timeZone });
  const that = d.toLocaleDateString('en-CA', { timeZone });
  const prefix = that === today
    ? ''
    : `${d.toLocaleDateString('en-US', { timeZone, weekday: 'short' })} `;
  return `${prefix}${fmtClock(iso, timeZone)}`;
}

/** Cycle bar colour. Thresholds are operational judgement, not
 *  regulation — they exist to give dispatch warning before a driver
 *  becomes unusable, not to mark a legal line. */
function cycleTone(used: number, limit: number): { bar: string; text: string } {
  const pct = limit > 0 ? used / limit : 0;
  if (pct >= 0.93) return { bar: '#dc2626', text: '#991b1b' };
  if (pct >= 0.85) return { bar: '#d97706', text: '#92400e' };
  return { bar: '#16a34a', text: '#166534' };
}

// ── sorting ──────────────────────────────────────────────────────────

function sortKey(d: HosBoardDriver): [number, number, string] {
  // Group: on-duty OTR (live log obligation) → on-duty local → off duty.
  const group = d.status === 'on_duty'
    ? (d.classification === 'otr' ? 0 : 1)
    : 2;
  // Within on-duty, least window left first — closest to a problem.
  // Within off-duty, soonest available first, with drivers who can
  // resume inside an open window sorted as available right now.
  const rank = d.status === 'on_duty'
    ? (d.windowRemainingSeconds ?? Number.MAX_SAFE_INTEGER)
    : d.canResumeWithinWindow || d.fullyRested
      ? 0
      : d.availableAt
        ? new Date(d.availableAt).getTime()
        : Number.MAX_SAFE_INTEGER;
  return [group, rank, d.name];
}

export default function HosPanel({ onClose }: { onClose: () => void }) {
  const [drivers, setDrivers] = useState<HosBoardDriver[]>([]);
  const [config, setConfig] = useState<{ cycle: '70_8' | '60_7'; timeZone: string }>(
    { cycle: '70_8', timeZone: 'America/Denver' },
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await railway.getHosBoard();
      setDrivers(res.drivers);
      setConfig(res.config);
      setSelectedId(prev =>
        prev != null && res.drivers.some(d => d.driverId === prev)
          ? prev
          : res.drivers.length > 0 ? [...res.drivers].sort((a, b) => {
              const ka = sortKey(a), kb = sortKey(b);
              return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
            })[0].driverId : null,
      );
    } catch (err) {
      setError((err as Error).message ?? 'Could not load the duty board');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(() => [...drivers].sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
  }), [drivers]);

  const selected = sorted.find(d => d.driverId === selectedId) ?? null;

  // Fleet-level counts drive the banner. These are the two numbers the
  // whole feature exists to keep at zero.
  const totals = useMemo(() => ({
    unverifiedOtr: drivers.reduce((n, d) => n + d.unverifiedOtrCount, 0),
    needsReview:   drivers.reduce((n, d) => n + d.needsReviewCount, 0),
    paperWarning:  drivers.filter(d => d.paperLogWarning).length,
    onDuty:        drivers.filter(d => d.status === 'on_duty').length,
  }), [drivers]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, background: 'rgba(0,0,0,0.4)',
      }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: 1280, height: '88vh',
        display: 'flex', borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.28)',
        background: 'var(--gc-surface)',
      }}>

        {/* ── Left rail: driver list ── */}
        <div style={{
          width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--gc-border-light)',
        }}>
          <div style={{
            padding: '14px 16px', borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                Driver hours
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--gc-text-3)', marginLeft: 6 }}>
                  {totals.onDuty} on duty · {drivers.length} total
                </span>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                style={{ fontSize: 11, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                Refresh
              </button>
            </div>

            {/* The two actionable fleet numbers. Rendered only when
                non-zero so an empty board stays quiet. */}
            {totals.unverifiedOtr > 0 && (
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b',
                fontSize: 11.5, lineHeight: 1.4, fontWeight: 600,
              }}>
                {totals.unverifiedOtr} OTR shift{totals.unverifiedOtr === 1 ? '' : 's'} with no log confirmed
              </div>
            )}
            {totals.paperWarning > 0 && (
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
                fontSize: 11.5, lineHeight: 1.4, fontWeight: 600,
              }}>
                {totals.paperWarning} driver{totals.paperWarning === 1 ? '' : 's'} near the 8-day paper log limit
              </div>
            )}
            {totals.needsReview > 0 && (
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)',
                color: 'var(--gc-text-2)', fontSize: 11.5, fontWeight: 600,
              }}>
                {totals.needsReview} shift{totals.needsReview === 1 ? '' : 's'} need a time corrected
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading && drivers.length === 0 && (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
                <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
              </div>
            )}
            {error && (
              <div style={{ padding: 16, fontSize: 12, color: '#dc2626' }}>{error}</div>
            )}
            {sorted.map((d, i) => {
              const prev = sorted[i - 1];
              const group = (x: HosBoardDriver) =>
                x.status === 'on_duty' ? (x.classification === 'otr' ? 'On duty · OTR' : 'On duty · Local') : 'Off duty';
              const showHeader = !prev || group(prev) !== group(d);
              return (
                <div key={d.driverId}>
                  {showHeader && (
                    <div style={{
                      padding: '10px 16px 6px', fontSize: 10.5, fontWeight: 700,
                      letterSpacing: 0.4, textTransform: 'uppercase',
                      color: 'var(--gc-text-3)', background: 'var(--gc-bg)',
                      borderBottom: '1px solid var(--gc-border-light)',
                    }}>
                      {group(d)}
                    </div>
                  )}
                  <DriverRow
                    driver={d}
                    timeZone={config.timeZone}
                    selected={d.driverId === selectedId}
                    onSelect={() => setSelectedId(d.driverId)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: selected driver detail ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            {selected ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                  {selected.name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>
                  {selected.status === 'on_duty' ? 'On duty' : 'Off duty'}
                  {' · '}{selected.classification === 'otr' ? 'OTR' : 'Local'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>Pick a driver</div>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              aria-label="Close panel"
              onClick={onClose}
              style={{
                width: 28, height: 28, border: 'none', background: 'transparent',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--gc-text-2)',
              }}
            >
              <X size={16} />
            </button>
          </div>

          {selected ? (
            <DriverDetail
              driver={selected}
              timeZone={config.timeZone}
              onChanged={() => void load()}
            />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gc-text-3)', fontSize: 13 }}>
              No driver selected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Left-rail row ────────────────────────────────────────────────────

function DriverRow({ driver, timeZone, selected, onSelect }: {
  driver: HosBoardDriver; timeZone: string; selected: boolean; onSelect: () => void;
}) {
  const tone = cycleTone(driver.cycleUsedSeconds, driver.cycleLimitSeconds);
  const pct = driver.cycleLimitSeconds > 0
    ? Math.min(1, driver.cycleUsedSeconds / driver.cycleLimitSeconds)
    : 0;

  // One line of "what do I need to know about this driver right now".
  const note = driver.status === 'on_duty'
    ? driver.stale
      ? 'Shift open past 14h — needs a correction'
      : `${fmtHours(driver.windowRemainingSeconds)} left in window`
    : driver.canResumeWithinWindow
      ? `Can resume until ${fmtClock(driver.windowExpiresAt, timeZone)}`
      : driver.availableAt
        ? `Available ${fmtDayClock(driver.availableAt, timeZone)}`
        : driver.restartInProgressCompletesAt
          ? `Restarts ${fmtDayClock(driver.restartInProgressCompletesAt, timeZone)}`
          : 'Rested';

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        width: '100%', textAlign: 'left', display: 'block',
        padding: '10px 16px',
        border: 'none', borderBottom: '1px solid var(--gc-border-light)',
        borderLeft: selected ? '3px solid var(--gc-blue, #1a73e8)' : '3px solid transparent',
        background: selected ? 'var(--gc-bg)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{
          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
          background: driver.status === 'on_duty' ? '#16a34a' : 'var(--gc-border-light)',
        }} />
        <span style={{
          fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
        }}>
          {driver.name}
        </span>
        {driver.unverifiedOtrCount > 0 && (
          <span title="OTR shifts with no log confirmed" style={{
            padding: '1px 5px', borderRadius: 3, background: '#fef2f2',
            color: '#991b1b', fontSize: 9.5, fontWeight: 700,
          }}>
            {driver.unverifiedOtrCount} LOG
          </span>
        )}
        {driver.paperLogWarning && (
          <span title={`${driver.paperLogDays} of ${driver.paperLogLimit} paper-log days used in the last 30`} style={{
            padding: '1px 5px', borderRadius: 3, background: '#fffbeb',
            color: '#92400e', fontSize: 9.5, fontWeight: 700,
          }}>
            {driver.paperLogDays}/{driver.paperLogLimit}
          </span>
        )}
        {driver.needsReviewCount > 0 && (
          <span title="Shifts with a time that needs correcting" style={{
            padding: '1px 5px', borderRadius: 3, background: 'var(--gc-bg)',
            border: '1px solid var(--gc-border-light)',
            color: 'var(--gc-text-2)', fontSize: 9.5, fontWeight: 700,
          }}>
            FIX {driver.needsReviewCount}
          </span>
        )}
      </div>

      <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 3 }}>
        {note}
      </div>

      {/* Cycle bar. The denominator matters — "58h" alone doesn't get
          read, "58 / 70" does. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
        <div style={{
          flex: 1, height: 4, borderRadius: 2,
          background: 'var(--gc-border-light)', overflow: 'hidden',
        }}>
          <div style={{ width: `${pct * 100}%`, height: '100%', background: tone.bar }} />
        </div>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: tone.text, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(driver.cycleUsedSeconds / 360) / 10}/{Math.round(driver.cycleLimitSeconds / 3600)}h
        </span>
      </div>
    </button>
  );
}

// ── Right-pane detail ────────────────────────────────────────────────

function DriverDetail({ driver, timeZone, onChanged }: {
  driver: HosBoardDriver; timeZone: string; onChanged: () => void;
}) {
  const [shifts, setShifts] = useState<HosBoardShift[]>([]);
  const [events, setEvents] = useState<HosDutyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await railway.getHosDriverShifts(driver.driverId, 14);
      setShifts(res.shifts);
      setEvents(res.events);
    } catch (e) {
      setErr((e as Error).message ?? 'Could not load shifts');
    }
    setLoading(false);
  }, [driver.driverId]);

  useEffect(() => { void load(); }, [load]);

  const patch = async (shiftId: string, body: Parameters<typeof railway.updateHosShift>[1]) => {
    setBusyId(shiftId); setErr(null);
    try {
      await railway.updateHosShift(shiftId, body);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message ?? 'Update failed');
    }
    setBusyId(null);
  };

  const tone = cycleTone(driver.cycleUsedSeconds, driver.cycleLimitSeconds);

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--gc-bg)' }}>
      {/* KPI strip */}
      <div style={{
        padding: '14px 16px', display: 'grid', gap: 10,
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        background: 'var(--gc-surface)', borderBottom: '1px solid var(--gc-border-light)',
      }}>
        <Kpi label="On duty today" value={fmtHours(driver.onDutySecondsToday)} />
        <Kpi
          label={`Cycle (${Math.round(driver.cycleLimitSeconds / 3600)}h / 8 day)`}
          value={fmtHours(driver.cycleUsedSeconds)}
          suffix={<span style={{ color: tone.text, fontWeight: 700 }}> · {fmtHours(driver.cycleRemainingSeconds)} left</span>}
        />
        <Kpi
          label="14h window"
          value={driver.status === 'on_duty' ? fmtHours(driver.windowRemainingSeconds) : '—'}
          suffix={driver.windowExpiresAt && driver.status === 'on_duty'
            ? <span style={{ color: 'var(--gc-text-3)' }}> · to {fmtClock(driver.windowExpiresAt, timeZone)}</span>
            : undefined}
        />
        <Kpi
          label="Paper log days (30d)"
          value={`${driver.paperLogDays} / ${driver.paperLogLimit}`}
          suffix={driver.paperLogWarning
            ? <span style={{ color: '#92400e', fontWeight: 700 }}> · near limit</span>
            : undefined}
        />
      </div>

      {/* Restart status. With slow weekends most drivers reset without
          planning it, so the useful signal is who did NOT. */}
      <div style={{ padding: '10px 16px 0' }}>
        {driver.lastRestartAt ? (
          <Callout tone="good" icon={<RefreshCw size={13} />}>
            Cycle reset {fmtDayClock(driver.lastRestartAt, timeZone)} after 34 hours off.
          </Callout>
        ) : driver.restartInProgressCompletesAt ? (
          <Callout tone="neutral" icon={<Clock size={13} />}>
            Off duty now — cycle resets {fmtDayClock(driver.restartInProgressCompletesAt, timeZone)} if they stay off.
          </Callout>
        ) : (
          <Callout tone="warn" icon={<CircleAlert size={13} />}>
            No 34-hour reset in this cycle — hours are still accumulating from{' '}
            {fmtHours(driver.cycleUsedSeconds)} used.
          </Callout>
        )}
      </div>

      {err && (
        <div style={{ margin: '10px 16px 0', padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12 }}>
          {err}
        </div>
      )}

      {/* Shift list */}
      <div style={{ padding: 16 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--gc-text-3)', marginBottom: 8 }}>
          Shifts (last 14 days)
        </div>
        {loading ? (
          <div style={{ padding: 20, display: 'flex', justifyContent: 'center' }}>
            <Loader2 size={18} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
          </div>
        ) : shifts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--gc-text-3)', padding: '8px 0' }}>
            No shifts recorded.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shifts.map(s => (
              <ShiftCard
                key={s.id}
                shift={s}
                timeZone={timeZone}
                busy={busyId === s.id}
                onPatch={(body) => void patch(s.id, body)}
                events={events.filter(e =>
                  // Trail entries whose timestamps sit inside this shift.
                  new Date(e.occurred_at).getTime() >= new Date(s.startedAt).getTime() - 3600_000 &&
                  (!s.endedAt || new Date(e.occurred_at).getTime() <= new Date(s.endedAt).getTime() + 3600_000),
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, suffix }: { label: string; value: string; suffix?: React.ReactNode }) {
  return (
    <div style={{
      padding: '9px 11px', borderRadius: 8,
      background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
        {value}{suffix}
      </div>
    </div>
  );
}

function Callout({ tone, icon, children }: {
  tone: 'good' | 'warn' | 'neutral'; icon: React.ReactNode; children: React.ReactNode;
}) {
  const palette = tone === 'good'
    ? { bg: '#f0fdf4', border: '#bbf7d0', ink: '#166534' }
    : tone === 'warn'
      ? { bg: '#fffbeb', border: '#fde68a', ink: '#92400e' }
      : { bg: 'var(--gc-surface)', border: 'var(--gc-border-light)', ink: 'var(--gc-text-2)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 11px', borderRadius: 8,
      background: palette.bg, border: `1px solid ${palette.border}`,
      color: palette.ink, fontSize: 12, fontWeight: 600,
    }}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

// ── One shift ────────────────────────────────────────────────────────

function ShiftCard({ shift, timeZone, busy, events, onPatch }: {
  shift: HosBoardShift;
  timeZone: string;
  busy: boolean;
  events: HosDutyEvent[];
  onPatch: (body: Parameters<typeof railway.updateHosShift>[1]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showTrail, setShowTrail] = useState(false);

  const isOtr = shift.classification === 'otr';
  const unverified = isOtr && !shift.logVerifiedAt;
  const corrections = events.filter(e => e.corrects_event_id != null);

  return (
    <div style={{
      borderRadius: 8, background: 'var(--gc-surface)',
      border: `1px solid ${unverified ? '#fecaca' : shift.needsReview ? '#fde68a' : 'var(--gc-border-light)'}`,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 170 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtDayClock(shift.startedAt, timeZone)} – {shift.endedAt ? fmtClock(shift.endedAt, timeZone) : 'open'}
          </div>
          <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>
            {fmtHours(shift.onDutySeconds)}
            {shift.autoClosed && ' · estimated end'}
          </div>
        </div>

        {/* Classification toggle — this is what raises the OTR flag in
            the first place, so it lives on every row. */}
        <SegToggle
          value={shift.classification}
          options={[{ v: 'local', label: 'Local' }, { v: 'otr', label: 'OTR' }]}
          disabled={busy}
          onChange={(v) => onPatch({ classification: v as 'local' | 'otr' })}
        />

        {isOtr && (
          <SegToggle
            value={shift.logMethod}
            options={[
              { v: 'none', label: 'No log' },
              { v: 'motive', label: 'Motive' },
              { v: 'paper', label: 'Paper' },
            ]}
            disabled={busy}
            onChange={(v) => onPatch({ logMethod: v as 'none' | 'motive' | 'paper' })}
          />
        )}

        <div style={{ flex: 1 }} />

        {isOtr && (
          shift.logVerifiedAt ? (
            <span
              title={`Verified by ${shift.logVerifiedBy ?? 'dispatch'} on ${fmtDayClock(shift.logVerifiedAt, timeZone)}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, fontWeight: 700, color: '#166534',
              }}
            >
              <Check size={13} /> Log verified
            </span>
          ) : (
            <button
              type="button"
              disabled={busy || shift.logMethod === 'none'}
              onClick={() => onPatch({ verifyLog: true })}
              title={shift.logMethod === 'none' ? 'Pick how this driver is logging first' : undefined}
              style={{
                padding: '5px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                border: '1px solid #dc2626',
                background: shift.logMethod === 'none' ? 'var(--gc-bg)' : '#dc2626',
                color: shift.logMethod === 'none' ? 'var(--gc-text-3)' : '#fff',
                cursor: busy || shift.logMethod === 'none' ? 'not-allowed' : 'pointer',
              }}
            >
              Verify log
            </button>
          )
        )}

        <button
          type="button"
          onClick={() => setEditing(v => !v)}
          disabled={busy}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '5px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
            border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
            color: 'var(--gc-text-2)', cursor: 'pointer',
          }}
        >
          <Pencil size={11} /> Times
        </button>
      </div>

      {shift.needsReview && (
        <div style={{
          padding: '6px 12px', background: '#fffbeb', borderTop: '1px solid #fde68a',
          fontSize: 11.5, color: '#92400e', fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <AlertTriangle size={12} />
          {shift.reviewReason === 'auto_closed_estimate'
            ? 'Closed automatically with an estimated end time'
            : shift.reviewReason === 'exceeded_14h_window'
              ? 'Longer than a 14 hour window allows'
              : shift.reviewReason === 'implausibly_short'
                ? 'Unusually short — may be a mis-tap'
                : 'Needs review'}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            disabled={busy}
            onClick={() => onPatch({ clearReview: true })}
            style={{
              border: 'none', background: 'transparent', color: '#92400e',
              fontSize: 11.5, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            Looks right
          </button>
        </div>
      )}

      {editing && (
        <TimeEditor
          shift={shift}
          timeZone={timeZone}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(body) => { setEditing(false); onPatch(body); }}
        />
      )}

      {corrections.length > 0 && (
        <div style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button
            type="button"
            onClick={() => setShowTrail(v => !v)}
            style={{
              width: '100%', textAlign: 'left', padding: '6px 12px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 11, color: 'var(--gc-text-3)',
            }}
          >
            {showTrail ? 'Hide' : 'Show'} edit history ({corrections.length})
          </button>
          {showTrail && (
            <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {events.map(e => (
                <div key={e.id} style={{
                  fontSize: 11, color: e.voided_at ? 'var(--gc-text-4, #a4abb4)' : 'var(--gc-text-2)',
                  textDecoration: e.voided_at ? 'line-through' : 'none',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {e.status === 'on_duty' ? 'Start' : 'End'} {fmtDayClock(e.occurred_at, timeZone)}
                  {' · '}{e.source === 'dispatch_edit' ? 'dispatch' : e.source === 'auto_close' ? 'auto' : 'driver'}
                  {e.created_by_name ? ` (${e.created_by_name})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SegToggle({ value, options, disabled, onChange }: {
  value: string;
  options: Array<{ v: string; label: string }>;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--gc-border-light)' }}>
      {options.map(o => {
        const active = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            disabled={disabled}
            onClick={() => { if (!active) onChange(o.v); }}
            style={{
              padding: '4px 9px', fontSize: 11, fontWeight: active ? 700 : 500,
              border: 'none',
              background: active ? 'var(--gc-blue, #1a73e8)' : 'var(--gc-surface)',
              color: active ? '#fff' : 'var(--gc-text-2)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** datetime-local inputs, pre-filled in the ORG's timezone rather than
 *  the browser's — a dispatcher in a different zone editing a Denver
 *  fleet's hours must be entering Denver times, or the correction is
 *  wrong by the offset. */
function TimeEditor({ shift, timeZone, busy, onCancel, onSave }: {
  shift: HosBoardShift;
  timeZone: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { startedAt?: string; endedAt?: string }) => void;
}) {
  const toLocalInput = (iso: string | null): string => {
    if (!iso) return '';
    // en-CA gives YYYY-MM-DD; pair it with a 24h time for the input.
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-CA', { timeZone });
    const time = d.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
    return `${date}T${time}`;
  };

  /** Interpret a wall-clock string as a moment in `timeZone`. Applies
   *  the offset twice so a value straddling a DST change resolves to
   *  the offset actually in force at the answer. */
  const fromLocalInput = (value: string): string | undefined => {
    if (!value) return undefined;
    const [datePart, timePart] = value.split('T');
    if (!datePart || !timePart) return undefined;
    const [y, mo, d] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, hh, mm);
    const offsetAt = (ms: number) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date(ms));
      const f: Record<string, number> = {};
      for (const p of parts) if (p.type !== 'literal') f[p.type] = Number(p.value);
      const hour = f.hour === 24 ? 0 : f.hour;
      return Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second) - ms;
    };
    const first = guess - offsetAt(guess);
    return new Date(guess - offsetAt(first)).toISOString();
  };

  const [start, setStart] = useState(() => toLocalInput(shift.startedAt));
  const [end, setEnd] = useState(() => toLocalInput(shift.endedAt));

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 6, fontSize: 12,
    border: '1px solid var(--gc-border-light)',
    background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
  };

  return (
    <div style={{
      padding: '10px 12px', borderTop: '1px solid var(--gc-border-light)',
      background: 'var(--gc-bg)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <label style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
        Start
        <input type="datetime-local" value={start} onChange={e => setStart(e.target.value)}
          style={{ ...inputStyle, marginLeft: 6 }} />
      </label>
      <label style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
        End
        <input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)}
          style={{ ...inputStyle, marginLeft: 6 }} />
      </label>
      <span style={{ fontSize: 10.5, color: 'var(--gc-text-3)' }}>
        {timeZone.replace('_', ' ')}
      </span>
      <div style={{ flex: 1 }} />
      <button type="button" onClick={onCancel} disabled={busy}
        style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11.5, border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
        Cancel
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const body: { startedAt?: string; endedAt?: string } = {};
          const s = fromLocalInput(start);
          const e = fromLocalInput(end);
          if (s && s !== shift.startedAt) body.startedAt = s;
          if (e && e !== shift.endedAt) body.endedAt = e;
          if (body.startedAt || body.endedAt) onSave(body);
          else onCancel();
        }}
        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, border: 'none', background: 'var(--gc-blue, #1a73e8)', color: '#fff', cursor: 'pointer' }}
      >
        Save
      </button>
    </div>
  );
}
