'use client';

/**
 * HosDutyButton — top-bar affordance that opens the duty board.
 *
 * The badge counts OTR shifts with no confirmed log, NOT drivers on
 * duty. "How many people are working" is ambient information a
 * dispatcher already has; "how many OTR runs nobody has confirmed a
 * log for" is a number that should be zero and usually isn't. Badging
 * the actionable count is the difference between a button people learn
 * to ignore and one that earns its place.
 */

import { useCallback, useEffect, useState } from 'react';
import { Clock, AlertTriangle, X } from 'lucide-react';
import { railway, type HosBoardDriver } from '@/lib/railway';
import HosPanel from './HosPanel';
import { useHosPanel } from '@/lib/useHosPanel';

/**
 * Warn dispatch an hour before a driver's 14-hour window closes, so
 * there's time to get them parked or hand the run off — at 14:00 the
 * only remaining option is "stop driving now, wherever you are".
 */
const WARN_AT_SECONDS_LEFT = 3600;

function runningOut(drivers: HosBoardDriver[]): HosBoardDriver[] {
  return drivers
    .filter(d =>
      d.status === 'on_duty' &&
      !d.stale &&
      d.windowRemainingSeconds != null &&
      d.windowRemainingSeconds <= WARN_AT_SECONDS_LEFT,
    )
    .sort((a, b) => (a.windowRemainingSeconds ?? 0) - (b.windowRemainingSeconds ?? 0));
}

function fmtLeft(seconds: number | null): string {
  if (seconds == null) return '';
  const m = Math.max(0, Math.round(seconds / 60));
  if (m <= 0) return 'now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const POLL_MS = 5 * 60 * 1000;

export default function HosDutyButton() {
  // Open state is shared: the calendar's driver chip opens this same
  // panel focused on one driver, rather than mounting a second one.
  const open = useHosPanel(s => s.open);
  const requestedDriverId = useHosPanel(s => s.requestedDriverId);
  const focusNonce = useHosPanel(s => s.nonce);
  const openPanel = useHosPanel(s => s.openFor);
  const closePanel = useHosPanel(s => s.close);
  const setOpen = (v: boolean) => (v ? openPanel(null) : closePanel());
  const [attention, setAttention] = useState(0);
  const [available, setAvailable] = useState(true);
  const [expiring, setExpiring] = useState<HosBoardDriver[]>([]);
  // Dismissal is per driver, so silencing one warning doesn't hide the
  // next driver to hit the mark. Cleared when they go off duty.
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await railway.getHosBoard();
      setAttention(res.drivers.reduce(
        (n, d) => n + d.unverifiedOtrCount + d.needsReviewCount, 0,
      ));
      const low = runningOut(res.drivers);
      setExpiring(low);
      // Drop dismissals for anyone no longer running low, so the same
      // driver warns again on their next shift.
      setDismissed(prev => {
        const live = new Set(low.map(d => d.driverId));
        const next = new Set([...prev].filter(id => live.has(id)));
        return next.size === prev.size ? prev : next;
      });
      // An org with no HOS-enabled drivers has nothing to show.
      setAvailable(res.drivers.length > 0);
    } catch (err) {
      // Only hide when the feature genuinely isn't available to this
      // user. A server error must NOT hide the button: an earlier
      // version hid on any failure, so a broken endpoint was
      // indistinguishable from "not enabled" and the whole feature
      // appeared to vanish with nothing to click for an explanation.
      const status = (err as { status?: number }).status;
      setAvailable(status !== 403 && status !== 404);
      setAttention(0);
      setExpiring([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const visible = expiring.filter(d => !dismissed.has(d.driverId));

  if (!available) return null;

  return (
    <>
      <button
        type="button"
        aria-label={attention > 0 ? `Driver hours — ${attention} need attention` : 'Driver hours'}
        onClick={() => setOpen(true)}
        className="relative shrink-0 flex items-center justify-center"
        style={{
          width: 32, height: 32, borderRadius: 6,
          border: '1px solid var(--gc-border-light)',
          background: 'var(--gc-surface)',
          color: attention > 0 ? 'var(--gc-red, #dc2626)' : 'var(--gc-text-2)',
          cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-bg)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-surface)'; }}
      >
        <Clock size={16} />
        {attention > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute', top: -4, right: -4,
              minWidth: 16, height: 16, padding: '0 4px',
              borderRadius: 999, background: '#dc2626', color: '#fff',
              fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 0 2px var(--gc-surface)',
            }}
          >
            {attention > 99 ? '99+' : attention}
          </span>
        )}
      </button>

      {/* Hours warning, stacked in the top-right. A driver running out
          is the one HOS event that should interrupt whatever a
          dispatcher is doing, and a badge on an icon does not — but it
          sits out of the way of the calendar grid rather than over it.
          Per-driver dismissal so silencing one doesn't hide the next. */}
      {visible.length > 0 && (
        <div style={{
          position: 'fixed', top: 64, right: 16,
          zIndex: 55, display: 'flex', flexDirection: 'column', gap: 8,
          width: 380, maxWidth: 'calc(100vw - 32px)',
        }}>
          {visible.map(d => {
            const left = d.windowRemainingSeconds ?? 0;
            const critical = left <= 15 * 60;
            return (
              <div
                key={d.driverId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 12px', borderRadius: 8,
                  background: critical ? '#fef2f2' : '#fffbeb',
                  border: `1px solid ${critical ? '#dc2626' : '#f59e0b'}`,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                  color: critical ? '#991b1b' : '#92400e',
                }}
              >
                <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {d.name} runs out of hours in {fmtLeft(left)}
                  </div>
                  <div style={{ fontSize: 11.5, marginTop: 1, opacity: 0.9 }}>
                    {/* The actionable fact is the wall-clock time they
                        must stop driving, not the countdown. */}
                    14 hour window closes{d.windowExpiresAt
                      ? ` at ${new Date(d.windowExpiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                      : ''} · on duty since{d.dutyPeriodStart
                      ? ` ${new Date(d.dutyPeriodStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  style={{
                    padding: '5px 11px', borderRadius: 6, flexShrink: 0,
                    border: 'none', background: critical ? '#dc2626' : '#d97706',
                    color: '#fff', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  Review hours
                </button>
                <button
                  type="button"
                  aria-label={`Dismiss warning for ${d.name}`}
                  onClick={() => setDismissed(prev => new Set(prev).add(d.driverId))}
                  style={{
                    border: 'none', background: 'transparent', cursor: 'pointer',
                    color: 'inherit', opacity: 0.6, padding: 2, flexShrink: 0,
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <HosPanel
          initialDriverId={requestedDriverId}
          focusNonce={focusNonce}
          onClose={() => { closePanel(); void load(); }}
        />
      )}
    </>
  );
}
