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
import { Clock } from 'lucide-react';
import { railway } from '@/lib/railway';
import HosPanel from './HosPanel';

const POLL_MS = 5 * 60 * 1000;

export default function HosDutyButton() {
  const [open, setOpen] = useState(false);
  const [attention, setAttention] = useState(0);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await railway.getHosBoard();
      setAttention(res.drivers.reduce(
        (n, d) => n + d.unverifiedOtrCount + d.needsReviewCount, 0,
      ));
      setAvailable(true);
    } catch {
      // HOS may not be enabled for this org, or the endpoint may not be
      // deployed yet. Hide rather than showing a button that errors.
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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

      {open && <HosPanel onClose={() => { setOpen(false); void load(); }} />}
    </>
  );
}
