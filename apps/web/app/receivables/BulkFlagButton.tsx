'use client';

/**
 * BulkFlagButton — flag a whole selection for follow-up in one go.
 *
 * Chasing is a per-CUSTOMER activity, not a per-invoice one. You ring a
 * broker about the four invoices they haven't paid, not about one; making
 * the operator open four drawers and type the same note four times is how a
 * follow-up system stops getting used by the second week.
 *
 * Shared by the ledger's selection bar and the customer page's footer so
 * the two can't drift into different vocabularies for the same act.
 *
 * Writes are sequential and independent: one failure is reported by count
 * rather than abandoning the rest, because a partly-applied flag is a
 * nuisance and a lost one is a missed collection.
 */

import { useEffect, useRef, useState } from 'react';
import { Flag, Loader2, X } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { InvoiceFlagReason } from '@fleetcal/types';
import { INVOICE_FLAG_REASONS, INVOICE_FLAG_LABEL } from '@fleetcal/types';

export interface BulkFlagButtonProps {
  invoiceIds: string[];
  /** Fired after the writes land so the caller can refetch. */
  onDone: () => void;
  /** 'up' opens the sheet above the button — for a bar pinned to the
   *  bottom of the viewport, where a downward sheet would be off-screen. */
  direction?: 'up' | 'down';
}

export default function BulkFlagButton({ invoiceIds, onDone, direction = 'up' }: BulkFlagButtonProps) {
  const [open,   setOpen]   = useState(false);
  const [reason, setReason] = useState<InvoiceFlagReason | ''>('awaiting_payment');
  const [note,   setNote]   = useState('');
  const [when,   setWhen]   = useState('');
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Esc. Registered only while open so the
  // listeners aren't live for the whole page's lifetime.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function apply() {
    setBusy(true); setErr(null);
    let failed = 0;
    for (const id of invoiceIds) {
      try {
        await railway.flagInvoice(id, {
          flaggedReason:   reason || null,
          flaggedNote:     reason ? (note.trim() || null) : null,
          promisedPayDate: when || null,
        });
      } catch { failed += 1; }
    }
    setBusy(false);
    if (failed) {
      setErr(`${failed} of ${invoiceIds.length} couldn't be flagged`);
      onDone();
      return;
    }
    setOpen(false); setNote(''); setWhen('');
    onDone();
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} disabled={busy}
              className="inline-flex items-center gap-1.5"
              style={{
                height: 30, padding: '0 10px', borderRadius: 8,
                border: `1px solid ${open ? '#c5221f' : 'var(--gc-border)'}`,
                background: open ? '#fce8e6' : 'var(--gc-surface)',
                color: open ? '#c5221f' : 'var(--gc-text-2)',
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
              }}>
        <Flag size={12} /> Flag {invoiceIds.length}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, width: 300, zIndex: 50,
          [direction === 'up' ? 'bottom' : 'top']: 38,
          background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
          borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 12,
        }}>
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--gc-text-1)' }}>
              Flag {invoiceIds.length} invoice{invoiceIds.length === 1 ? '' : 's'}
            </span>
            <button onClick={() => setOpen(false)} style={{ color: 'var(--gc-text-3)' }}>
              <X size={14} />
            </button>
          </div>

          <select value={reason} disabled={busy} style={FIELD}
                  onChange={e => setReason(e.target.value as InvoiceFlagReason | '')}>
            <option value="">Clear the flag</option>
            {INVOICE_FLAG_REASONS.map(r => (
              <option key={r} value={r}>{INVOICE_FLAG_LABEL[r]}</option>
            ))}
          </select>

          {reason && (
            <input value={note} disabled={busy} onChange={e => setNote(e.target.value)}
                   placeholder="Who did you speak to? What did they say?"
                   style={{ ...FIELD, marginTop: 6 }} />
          )}

          <label className="block" style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 8 }}>
            Payment promised (optional)
            <input type="date" value={when} disabled={busy}
                   onChange={e => setWhen(e.target.value)}
                   style={{ ...FIELD, marginTop: 3 }} />
          </label>
          <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 4 }}>
            A promised date is a note, not a reprieve — these stay exactly as
            overdue as they are.
          </div>

          {err && (
            <div style={{ fontSize: 11, color: '#c5221f', marginTop: 6 }}>{err}</div>
          )}

          <button onClick={() => { void apply(); }} disabled={busy}
                  className="inline-flex items-center justify-center gap-1.5 w-full"
                  style={{
                    marginTop: 10, height: 30, borderRadius: 8, fontSize: 12, fontWeight: 700,
                    background: '#1a73e8', color: '#fff', cursor: busy ? 'default' : 'pointer',
                  }}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {busy ? 'Saving…' : reason ? `Flag ${invoiceIds.length}` : `Clear ${invoiceIds.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

const FIELD: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--gc-border)', fontSize: 12,
  color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none',
};
