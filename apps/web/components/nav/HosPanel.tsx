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
  Plus, Trash2,
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

const SHIFT_WINDOW_SECONDS = 14 * 3600;

type DayState = {
  headline: string;
  sub: string | null;
  tone: 'green' | 'amber' | 'red' | 'neutral';
  /** Fraction of the 14-hour window consumed, for the bar. */
  windowPct: number | null;
  /**
   * Both paths available to an off-duty driver mid-window. Present ONLY
   * when both genuinely exist — a dispatcher shown "resets at 1am" alone
   * will park a driver who could legally be working right now, and one
   * shown "can work until 8pm" alone won't notice the alternative gets
   * them a full fresh 14.
   */
  choice: { workUntil: string; workLeft: string; resetAt: string; resetIn: string } | null;
};

/**
 * What this driver's day looks like right now.
 *
 * Deliberately daily, not weekly. The 70/8 cycle is a planning number
 * for later in the week; the question at dispatch time is "how much has
 * this driver got left today", and that's the 14-hour window and the
 * 10-hour reset.
 */
function dayState(d: HosBoardDriver, timeZone: string): DayState {
  if (d.status === 'on_duty') {
    if (d.stale) {
      return {
        headline: 'Shift open past 14 hours',
        sub: 'Almost certainly a missed clock-out — needs correcting',
        tone: 'red', windowPct: 1, choice: null,
      };
    }
    const left = d.windowRemainingSeconds ?? 0;
    return {
      headline: `${fmtHours(left)} left on duty`,
      sub: d.windowExpiresAt ? `14 hour window ends ${fmtClock(d.windowExpiresAt, timeZone)}` : null,
      tone: left <= 3600 ? 'red' : left <= 3 * 3600 ? 'amber' : 'green',
      windowPct: Math.min(1, 1 - left / SHIFT_WINDOW_SECONDS),
      choice: null,
    };
  }

  // Off duty, but the window is still running — the two-option case.
  if (d.canResumeWithinWindow && d.windowExpiresAt) {
    const workLeft = Math.max(0, (new Date(d.windowExpiresAt).getTime() - Date.now()) / 1000);
    return {
      headline: `Can work ${fmtHours(workLeft)} more today`,
      sub: d.availableAt ? `or reset by ${fmtDayClock(d.availableAt, timeZone)}` : null,
      tone: workLeft <= 2 * 3600 ? 'amber' : 'green',
      windowPct: Math.min(1, 1 - workLeft / SHIFT_WINDOW_SECONDS),
      choice: {
        workUntil: fmtClock(d.windowExpiresAt, timeZone),
        workLeft: fmtHours(workLeft),
        resetAt: d.availableAt ? fmtDayClock(d.availableAt, timeZone) : '—',
        resetIn: fmtHours(d.restRemainingSeconds),
      },
    };
  }

  // Window expired, reset incomplete — one path only.
  if (d.availableAt) {
    return {
      headline: `Available ${fmtDayClock(d.availableAt, timeZone)}`,
      sub: `${fmtHours(d.restRemainingSeconds)} left of the 10 hour reset`,
      tone: 'amber', windowPct: null, choice: null,
    };
  }

  if (d.restartInProgressCompletesAt) {
    return {
      headline: 'Rested — full 14 hours available',
      sub: `34 hour cycle reset completes ${fmtDayClock(d.restartInProgressCompletesAt, timeZone)}`,
      tone: 'green', windowPct: null, choice: null,
    };
  }

  return {
    headline: 'Rested — full 14 hours available',
    sub: null, tone: 'green', windowPct: null, choice: null,
  };
}

const TONE = {
  green:   { bar: '#16a34a', text: '#166534', bg: '#f0fdf4', border: '#bbf7d0' },
  amber:   { bar: '#d97706', text: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  red:     { bar: '#dc2626', text: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
  neutral: { bar: 'var(--gc-border-light)', text: 'var(--gc-text-2)', bg: 'var(--gc-bg)', border: 'var(--gc-border-light)' },
} as const;

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

export default function HosPanel({ onClose, initialDriverId, focusNonce }: {
  onClose: () => void;
  /** Open focused on this driver — set when the panel is opened from a
   *  calendar column header rather than the top-bar button. */
  initialDriverId?: number | null;
  /** Changes on every open request, so asking for the same driver twice
   *  in a row still re-focuses rather than being a no-op. */
  focusNonce?: number;
}) {
  const [drivers, setDrivers] = useState<HosBoardDriver[]>([]);
  const [config, setConfig] = useState<{ cycle: '70_8' | '60_7'; timeZone: string }>(
    { cycle: '70_8', timeZone: 'America/Denver' },
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Bumped on every board load so the detail pane refetches its shift
  // list too. Without it, Refresh updated the left rail while the
  // right pane kept showing whatever it fetched when the driver was
  // first selected — new shifts never appeared.
  const [refreshKey, setRefreshKey] = useState(0);
  // Banner click-through. The counts named a problem but gave no way to
  // reach it — with 31 drivers in the rail, "3 shifts need a log" meant
  // scrolling and guessing which three.
  const [filter, setFilter] = useState<null | 'unverified' | 'review' | 'paper'>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    setRefreshKey(k => k + 1);
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

  // Focus the requested driver. Runs on nonce rather than id so opening
  // the panel twice on the same driver still re-selects them after the
  // user has clicked elsewhere in the rail.
  useEffect(() => {
    if (initialDriverId != null) setSelectedId(initialDriverId);
  }, [initialDriverId, focusNonce]);

  // Keep the board live while it's open. Every number here counts down
  // in real time — window remaining, time until a reset completes — so
  // a panel left open on a second monitor goes quietly stale, and a
  // dispatcher reading it has no cue that it should be refreshed.
  // Paused when the tab is hidden so a backgrounded board isn't polling
  // all afternoon.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = useMemo(() => {
    const matches = (d: HosBoardDriver) =>
      filter === 'unverified' ? d.unverifiedOtrCount > 0
      : filter === 'review'   ? d.needsReviewCount > 0
      : filter === 'paper'    ? d.paperLogWarning
      : true;
    return drivers.filter(matches).sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });
  }, [drivers, filter]);

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
                  {filter
                    ? `${sorted.length} shown · ${drivers.length} total`
                    : `${totals.onDuty} on duty · ${drivers.length} total`}
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
              <button
                type="button"
                onClick={() => setFilter(f => f === 'unverified' ? null : 'unverified')}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '8px 10px', borderRadius: 6,
                  background: '#fef2f2',
                  border: `1px solid ${filter === 'unverified' ? '#dc2626' : '#fecaca'}`,
                  color: '#991b1b', fontSize: 11.5, lineHeight: 1.4, fontWeight: 600,
                }}>
                {totals.unverifiedOtr} OTR shift{totals.unverifiedOtr === 1 ? '' : 's'} with no log confirmed
                {filter === 'unverified' && ' · showing only these'}
              </button>
            )}
            {totals.paperWarning > 0 && (
              <button
                type="button"
                onClick={() => setFilter(f => f === 'paper' ? null : 'paper')}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '8px 10px', borderRadius: 6,
                  background: '#fffbeb',
                  border: `1px solid ${filter === 'paper' ? '#d97706' : '#fde68a'}`,
                  color: '#92400e', fontSize: 11.5, lineHeight: 1.4, fontWeight: 600,
                }}>
                {totals.paperWarning} driver{totals.paperWarning === 1 ? '' : 's'} near the 8-day paper log limit
                {filter === 'paper' && ' · showing only these'}
              </button>
            )}
            {totals.needsReview > 0 && (
              <button
                type="button"
                onClick={() => setFilter(f => f === 'review' ? null : 'review')}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '8px 10px', borderRadius: 6,
                  background: 'var(--gc-bg)',
                  border: `1px solid ${filter === 'review' ? 'var(--gc-text-3)' : 'var(--gc-border-light)'}`,
                  color: 'var(--gc-text-2)', fontSize: 11.5, fontWeight: 600,
                }}>
                {totals.needsReview} shift{totals.needsReview === 1 ? '' : 's'} need a time corrected
                {filter === 'review' && ' · showing only these'}
              </button>
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
              refreshKey={refreshKey}
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
  // The headline is the DAY, not the week. What dispatch needs first is
  // "how much has this driver got left right now" — the 70/8 cycle is a
  // planning number for later in the week and is demoted to a footnote.
  const day = dayState(driver, timeZone);

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

      {/* Headline is the day: hours left on shift, or when they're
          back. The week is a footnote at the bottom. */}
      <div style={{
        fontSize: 13, fontWeight: 700, marginTop: 4,
        color: TONE[day.tone].text, fontVariantNumeric: 'tabular-nums',
      }}>
        {day.headline}
      </div>
      {day.sub && (
        <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>
          {day.sub}
        </div>
      )}

      {/* 14-hour window consumed. Only drawn when a window is actually
          running — a rested driver has nothing to show here. */}
      {day.windowPct != null && (
        <div style={{
          height: 4, borderRadius: 2, marginTop: 6,
          background: 'var(--gc-border-light)', overflow: 'hidden',
        }}>
          <div style={{ width: `${day.windowPct * 100}%`, height: '100%', background: TONE[day.tone].bar }} />
        </div>
      )}

      {/* The week, deliberately small. Useful context for planning a
          few days out, never the thing to read first. */}
      <div style={{
        fontSize: 10, color: 'var(--gc-text-3)', marginTop: 5,
        fontVariantNumeric: 'tabular-nums',
      }}>
        Week {Math.round(driver.cycleUsedSeconds / 360) / 10}/{Math.round(driver.cycleLimitSeconds / 3600)}h
        {driver.onDutySecondsToday > 0 ? ` · today ${fmtHours(driver.onDutySecondsToday)}` : ''}
      </div>
    </button>
  );
}

// ── Right-pane detail ────────────────────────────────────────────────

function DriverDetail({ driver, timeZone, refreshKey, onChanged }: {
  driver: HosBoardDriver;
  timeZone: string;
  /** Changes whenever the board reloads, so Refresh pulls new shifts
   *  into this pane as well as updating the rail. */
  refreshKey: number;
  onChanged: () => void;
}) {
  const [shifts, setShifts] = useState<HosBoardShift[]>([]);
  const [events, setEvents] = useState<HosDutyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver.driverId, refreshKey]);

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

  const removeShift = async (shiftId: string) => {
    if (!window.confirm('Remove this shift? It stops counting toward hours immediately, but stays recoverable in the database.')) return;
    setBusyId(shiftId); setErr(null);
    try {
      await railway.deleteHosShift(shiftId);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message ?? 'Could not remove that shift');
    }
    setBusyId(null);
  };

  const addShift = async (body: { startedAt: string; endedAt: string | null; classification: 'local' | 'otr' }) => {
    setErr(null);
    try {
      await railway.createHosShift({ driverId: driver.driverId, ...body });
      setAdding(false);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message ?? 'Could not add that shift');
    }
  };

  const tone = cycleTone(driver.cycleUsedSeconds, driver.cycleLimitSeconds);
  const day = dayState(driver, timeZone);

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: 'var(--gc-bg)' }}>
      {/* Today, in words. This is the block a dispatcher reads before
          deciding whether to give someone a run. */}
      <div style={{
        padding: '14px 16px', background: 'var(--gc-surface)',
        borderBottom: '1px solid var(--gc-border-light)',
      }}>
        <div style={{
          padding: '12px 14px', borderRadius: 8,
          background: TONE[day.tone].bg, border: `1px solid ${TONE[day.tone].border}`,
        }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: TONE[day.tone].text }}>
            {day.headline}
          </div>

          {day.choice ? (
            // The two-option case: off duty, but the 14-hour window is
            // still open. Both paths are spelled out because picking
            // between them IS the dispatch decision — send them back out
            // on what's left of today, or park them for a fresh 14.
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr', marginTop: 10 }}>
              <div style={{ padding: '9px 11px', borderRadius: 7, background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>
                  Send out now
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                  {day.choice.workLeft} left
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginTop: 2, lineHeight: 1.4 }}>
                  Must be done by {day.choice.workUntil}. A short break does not
                  extend the window, so this is what remains of today.
                </div>
              </div>
              <div style={{ padding: '9px 11px', borderRadius: 7, background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>
                  Or reset first
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)', marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>
                  Ready {day.choice.resetAt}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginTop: 2, lineHeight: 1.4 }}>
                  {day.choice.resetIn} more off duty buys a fresh 14 hour window.
                </div>
              </div>
            </div>
          ) : day.sub ? (
            <div style={{ fontSize: 12.5, color: TONE[day.tone].text, marginTop: 4, opacity: 0.9 }}>
              {day.sub}
            </div>
          ) : null}
        </div>

        <div style={{
          marginTop: 10, display: 'grid', gap: 10,
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        }}>
          <Kpi label="On duty today" value={fmtHours(driver.onDutySecondsToday)} />
          <Kpi
            label="Paper log days (30d)"
            value={`${driver.paperLogDays} / ${driver.paperLogLimit}`}
            suffix={driver.paperLogWarning
              ? <span style={{ color: '#92400e', fontWeight: 700 }}> · near limit</span>
              : undefined}
          />
          <Kpi
            label={`Week (${Math.round(driver.cycleLimitSeconds / 3600)}h / 8 day)`}
            value={fmtHours(driver.cycleUsedSeconds)}
            suffix={<span style={{ color: tone.text, fontWeight: 700 }}> · {fmtHours(driver.cycleRemainingSeconds)} left</span>}
          />
        </div>
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
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ flex: 1, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>
            Shifts (last 14 days)
          </div>
          <button
            type="button"
            onClick={() => setAdding(v => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 9px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
              border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)',
              color: 'var(--gc-text-2)', cursor: 'pointer',
            }}
          >
            <Plus size={11} /> Add shift
          </button>
        </div>
        {adding && (
          <div style={{ marginBottom: 8 }}>
            <NewShiftForm
              timeZone={timeZone}
              defaultClassification={driver.defaultClassification}
              onCancel={() => setAdding(false)}
              onSave={(body) => void addShift(body)}
            />
          </div>
        )}
        {/* Spinner only on the FIRST load. The board polls every 60s,
            and swapping the list for a spinner on each tick would make
            it flicker under a dispatcher who is trying to read it. */}
        {loading && shifts.length === 0 ? (
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
                onDelete={() => void removeShift(s.id)}
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

function ShiftCard({ shift, timeZone, busy, events, onPatch, onDelete }: {
  shift: HosBoardShift;
  timeZone: string;
  busy: boolean;
  events: HosDutyEvent[];
  onPatch: (body: Parameters<typeof railway.updateHosShift>[1]) => void;
  onDelete: () => void;
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

        {/* Only shown once verified — before that, the verify buttons
            below capture the method, so offering it twice invites
            setting a method without confirming anything. */}
        {isOtr && shift.logVerifiedAt && (
          <SegToggle
            value={shift.logMethod}
            options={[
              { v: 'motive', label: 'Motive' },
              { v: 'paper', label: 'Paper' },
            ]}
            disabled={busy}
            onChange={(v) => onPatch({ logMethod: v as 'motive' | 'paper' })}
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
            // One click records HOW they're logging and that it was
            // checked. An earlier version disabled this until a method
            // was picked from the toggle above, which rendered a grey
            // unclickable button by default and read as broken — the
            // method is the answer to the question, so ask it here.
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#991b1b' }}>
                Log not confirmed —
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPatch({ logMethod: 'motive', verifyLog: true })}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                  border: 'none', background: '#dc2626', color: '#fff',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                On Motive
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPatch({ logMethod: 'paper', verifyLog: true })}
                style={{
                  padding: '5px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                  border: '1px solid #dc2626', background: 'var(--gc-surface)',
                  color: '#991b1b', cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                On paper
              </button>
            </div>
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

        {/* Soft delete — for a shift recorded wrongly rather than a
            shift that didn't happen. The row survives in the database. */}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="Remove this shift"
          aria-label="Remove this shift"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 27, height: 27, borderRadius: 6,
            border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
            color: '#b8261d', cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          <Trash2 size={12} />
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

      {/* Open shifts get the quick-adjust; a closed shift is history and
          should go through the full editor where both ends are visible. */}
      {!shift.endedAt && (
        <QuickAdjustStart
          shift={shift}
          timeZone={timeZone}
          busy={busy}
          onApply={(startedAt, note) => onPatch({ startedAt, note })}
        />
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
                  {/* The stated reason is the whole point of requiring
                      one — show it where the trail is actually read. */}
                  {e.note && (
                    <div style={{ paddingLeft: 12, opacity: 0.85, fontStyle: 'italic' }}>
                      {e.note}
                    </div>
                  )}
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

/**
 * Shift the recorded START time forward in fixed steps.
 *
 * The case this exists for: a driver clocks in when they reach the yard
 * rather than when they actually go on duty, so the recorded start runs
 * early and every downstream number — window remaining, hours today —
 * is wrong by the same amount.
 *
 * A reason is REQUIRED rather than optional. These rows are the
 * 395.1(e)(1)(v) employer time record for short-haul drivers, and
 * hos_duty_events keeps the original value alongside the correction
 * permanently. An edit with a stated reason is a correction; the same
 * edit with no reason is just an unexplained change to a duty record,
 * and the difference only matters when someone is reading it back
 * months later.
 */
function QuickAdjustStart({ shift, timeZone, busy, onApply }: {
  shift: HosBoardShift;
  timeZone: string;
  busy: boolean;
  onApply: (startedAt: string, note: string) => void;
}) {
  const [hours, setHours] = useState<number | null>(null);
  const [note, setNote] = useState('');

  const proposed = hours == null
    ? null
    : new Date(new Date(shift.startedAt).getTime() + hours * 3600_000);
  // Never past the end of the shift it belongs to, and never in the
  // future — either would invert or invent the record.
  const ceiling = shift.endedAt ? new Date(shift.endedAt).getTime() : Date.now();
  const invalid = proposed != null && proposed.getTime() >= ceiling;

  return (
    <div style={{
      padding: '9px 12px', borderTop: '1px solid var(--gc-border-light)',
      background: 'var(--gc-bg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--gc-text-2)', fontWeight: 600 }}>
          Start recorded {fmtDayClock(shift.startedAt, timeZone)} — move it later by
        </span>
        {[1, 2, 3].map(h => (
          <button
            key={h}
            type="button"
            disabled={busy}
            onClick={() => setHours(hours === h ? null : h)}
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
              border: `1px solid ${hours === h ? 'var(--gc-blue, #1a73e8)' : 'var(--gc-border-light)'}`,
              background: hours === h ? 'var(--gc-blue, #1a73e8)' : 'var(--gc-surface)',
              color: hours === h ? '#fff' : 'var(--gc-text-2)',
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            +{h}h
          </button>
        ))}
      </div>

      {proposed && (
        <div style={{ marginTop: 9 }}>
          <div style={{ fontSize: 12, color: 'var(--gc-text-1)', fontWeight: 600 }}>
            New start: {fmtDayClock(proposed.toISOString(), timeZone)}
            {invalid && (
              <span style={{ color: '#991b1b', fontWeight: 700 }}>
                {' '}— that is after the shift ended
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Reason — e.g. clocked in at the yard, started driving at 7:00"
              style={{
                flex: 1, padding: '6px 9px', borderRadius: 6, fontSize: 12,
                border: '1px solid var(--gc-border-light)',
                background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
              }}
            />
            <button
              type="button"
              disabled={busy || invalid || note.trim().length < 3}
              onClick={() => {
                if (!proposed) return;
                onApply(proposed.toISOString(), note.trim());
                setHours(null); setNote('');
              }}
              title={note.trim().length < 3 ? 'A reason is required' : undefined}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
                border: 'none', flexShrink: 0,
                background: (invalid || note.trim().length < 3)
                  ? 'var(--gc-border-light)' : 'var(--gc-blue, #1a73e8)',
                color: '#fff',
                cursor: (busy || invalid || note.trim().length < 3) ? 'not-allowed' : 'pointer',
              }}
            >
              Save correction
            </button>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 5 }}>
            The original time and this reason are both kept on the record.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Manually record a shift a driver never clocked.
 *
 * Leaving the end blank opens the shift — for a driver working right
 * now who forgot to clock in. The server's exclusion constraint treats
 * an open shift as running to infinity, so that correctly refuses if
 * anything is already recorded after the start.
 */
function NewShiftForm({ timeZone, defaultClassification, onCancel, onSave }: {
  timeZone: string;
  defaultClassification: 'local' | 'otr';
  onCancel: () => void;
  onSave: (body: { startedAt: string; endedAt: string | null; classification: 'local' | 'otr' }) => void;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [cls, setCls] = useState<'local' | 'otr'>(defaultClassification);

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 6, fontSize: 12,
    border: '1px solid var(--gc-border-light)',
    background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
  };

  return (
    <div style={{
      padding: '11px 12px', borderRadius: 8,
      background: 'var(--gc-surface)', border: '1px solid var(--gc-blue, #1a73e8)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-1)', marginBottom: 9 }}>
        Add a shift
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
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
        <SegToggle
          value={cls}
          options={[{ v: 'local', label: 'Local' }, { v: 'otr', label: 'OTR' }]}
          onChange={(v) => setCls(v as 'local' | 'otr')}
        />
        <span style={{ fontSize: 10.5, color: 'var(--gc-text-3)' }}>
          {timeZone.replace('_', ' ')} · leave End blank to open the shift
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onCancel}
          style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11.5, border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
          Cancel
        </button>
        <button
          type="button"
          disabled={!start}
          onClick={() => {
            const s = zonedInputToIso(start, timeZone);
            if (!s) return;
            onSave({ startedAt: s, endedAt: zonedInputToIso(end, timeZone) ?? null, classification: cls });
          }}
          style={{
            padding: '5px 12px', borderRadius: 6, fontSize: 11.5, fontWeight: 700,
            border: 'none', background: start ? 'var(--gc-blue, #1a73e8)' : 'var(--gc-border-light)',
            color: '#fff', cursor: start ? 'pointer' : 'not-allowed',
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Interpret a `datetime-local` value as a wall-clock time in `timeZone`.
 *
 * The browser's own zone is NOT the right frame: a dispatcher working
 * remotely from a Denver fleet must be entering Denver times, or every
 * shift they record is wrong by the offset. Applies the offset twice so
 * a value straddling a DST change resolves to the offset actually in
 * force at the answer rather than at the guess.
 */
function zonedInputToIso(value: string, timeZone: string): string | undefined {
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

  const fromLocalInput = (value: string) => zonedInputToIso(value, timeZone);

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
