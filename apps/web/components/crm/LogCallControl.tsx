'use client';

/**
 * LogCallControl — one-click call logging, shared by the leads list, the
 * lead drawer, and the outbox. A "Log call" button opens a popover with
 * the six outcome buttons, an optional note, and an optional "call back
 * on" date. Clicking an outcome calls POST /crm/leads/:id/call-outcome,
 * which records a `call` activity, bumps call_attempts, and applies the
 * outcome -> status mapping (No answer / Voicemail keep the lead in place).
 *
 * The popover is `position: fixed`, anchored to the trigger's rect, so it
 * escapes the leads table's `overflow: auto` clip. It closes on outside
 * click, scroll, or resize (rather than trying to re-anchor live).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Phone, Loader2, ChevronDown } from 'lucide-react';
import { railway } from '@/lib/railway';
import { OUTCOME_META } from './crmMeta';
import { CRM_CALL_OUTCOMES, type CrmCallOutcome, type CrmLead } from '@fleetcal/types';

const WIDTH = 262;

export default function LogCallControl({
  leadId,
  phone,
  cellPhone,
  onLogged,
  compact = false,
}: {
  leadId: string;
  phone?: string;
  cellPhone?: string;
  /** Fired with the server's updated lead + the outcome just logged, so
   *  the caller can update its row without a full refetch. */
  onLogged?: (lead: CrmLead, outcome: CrmCallOutcome) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [busy, setBusy] = useState<CrmCallOutcome | null>(null);
  const [note, setNote] = useState('');
  const [callback, setCallback] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setPos({
        top: r.bottom + 4,
        left: Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8)),
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDoc = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, place]);

  async function log(outcome: CrmCallOutcome) {
    setBusy(outcome);
    try {
      const res = await railway.crmLogCall(leadId, {
        outcome,
        note: note.trim() || undefined,
        // Noon local so the callback date doesn't slip a day across tz.
        nextActionAt: callback ? new Date(`${callback}T12:00:00`).toISOString() : undefined,
      });
      onLogged?.(res.lead, outcome);
      setOpen(false);
      setNote('');
      setCallback('');
    } catch {
      /* Leave the popover open — a failed log should be retried, not lost. */
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="inline-flex items-center gap-1 rounded-lg font-semibold transition-colors hover:bg-[var(--gc-hover)]"
        style={{
          fontSize: compact ? 11 : 12,
          padding: compact ? '3px 7px' : '5px 9px',
          background: 'var(--gc-surface)',
          color: '#1a73e8',
          border: '1px solid var(--gc-border-light)',
        }}
      >
        <Phone size={compact ? 11 : 12} /> Log call <ChevronDown size={compact ? 10 : 11} />
      </button>

      {open && (
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 rounded-xl p-2.5"
          style={{
            top: pos.top,
            left: pos.left,
            width: WIDTH,
            background: 'var(--gc-surface)',
            border: '1px solid var(--gc-border-light)',
            boxShadow: 'var(--shadow-3)',
          }}
        >
          {(phone || cellPhone) && (
            <div className="flex flex-col gap-0.5 mb-2 px-0.5">
              {phone && (
                <a href={`tel:${phone}`} className="text-[13px] font-semibold" style={{ color: '#1a73e8' }}>
                  {phone}
                </a>
              )}
              {cellPhone && cellPhone !== phone && (
                <a href={`tel:${cellPhone}`} className="text-[12px]" style={{ color: '#1a73e8' }}>
                  {cellPhone} · cell
                </a>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5">
            {CRM_CALL_OUTCOMES.map((o) => {
              const m = OUTCOME_META[o];
              return (
                <button
                  key={o}
                  type="button"
                  disabled={busy != null}
                  onClick={() => void log(o)}
                  className="inline-flex items-center justify-center gap-1 rounded-lg text-[11.5px] font-semibold py-1.5 transition-opacity disabled:opacity-50"
                  style={{ background: m.tintLight, color: m.tint }}
                >
                  {busy === o ? <Loader2 size={11} className="animate-spin" /> : null}
                  {m.label}
                </button>
              );
            })}
          </div>

          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="w-full mt-2 text-[12px] px-2 py-1.5 rounded-lg outline-none"
            style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
          />
          <label className="flex items-center justify-between gap-2 mt-1.5 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
            Call back on
            <input
              type="date"
              value={callback}
              onChange={(e) => setCallback(e.target.value)}
              className="text-[11.5px] px-1.5 py-1 rounded-lg outline-none"
              style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
            />
          </label>
        </div>
      )}
    </>
  );
}
