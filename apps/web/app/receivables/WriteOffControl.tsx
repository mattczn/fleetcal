'use client';

/**
 * WriteOffControl — close out the remainder on an invoice that was paid short.
 *
 * The gap this fills: variance_reason rides on an allocation at CREATION
 * time, so once a short payment is recorded there is no way to say why it
 * was short. The only route was to delete and re-record it, which nobody
 * does, so the invoices just sat open — 43 of them on Curzon, $2,783.59,
 * not one carrying a reason.
 *
 * So this tags the allocation that is already there. recomputeInvoicePaid
 * sees the reason and closes the invoice; the single-writer rule is intact
 * because this never touches invoices.status itself.
 *
 * WHAT IT IS NOT: a write-off in the accounting sense. paid_amount stays
 * exactly what the customer sent and the difference stays visible as the
 * gap to total. Nothing is erased — the invoice stops claiming the money is
 * still coming, which is a different statement.
 *
 * The reason matters more than the closing. "What do deductions cost us"
 * and "what does quick pay cost us" are answerable only if these are told
 * apart, which is why there is no unlabelled option.
 */

import { useEffect, useRef, useState } from 'react';
import { CircleOff, Loader2, X } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { PaymentVarianceReason } from '@fleetcal/types';

/** The reasons an invoice can be CLOSED short for. `overpayment` is absent
 *  — it closes on its own — and so is a blank option: an unexplained
 *  write-off is indistinguishable from a mistake six months later. */
export const WRITE_OFF_REASONS: {
  value: PaymentVarianceReason; label: string; hint: string;
}[] = [
  { value: 'deduction',        label: 'Deduction / chargeback',
    hint: 'They took something off — lumper, claim, detention clawback.' },
  { value: 'quick_pay',        label: 'Quick pay discount',
    hint: 'Their early-payment fee. Set a rate on the customer and these close automatically.' },
  { value: 'rate_discrepancy', label: 'Rate discrepancy',
    hint: 'We billed a different rate than was booked. Nobody to call — fix it upstream.' },
  { value: 'short_pay',        label: 'Short paid, no reason given',
    hint: 'They just paid less. Worth flagging as disputed if you intend to chase it.' },
  { value: 'other',            label: 'Other',
    hint: 'Use the note to say what happened.' },
];

export interface WriteOffControlProps {
  /** The allocation to tag — normally the largest on the invoice, since
   *  that is the one the shortfall came out of. */
  paymentId:  string;
  invoiceId:  string;
  /** What is still owing, for the label and the note. */
  remaining:  number;
  onDone:     () => void;
  direction?: 'up' | 'down';
}

const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

export default function WriteOffControl({
  paymentId, invoiceId, remaining, onDone, direction = 'down',
}: WriteOffControlProps) {
  const [open,   setOpen]   = useState(false);
  const [reason, setReason] = useState<PaymentVarianceReason>('deduction');
  const [note,   setNote]   = useState('');
  const [chase,  setChase]  = useState(false);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const hint = WRITE_OFF_REASONS.find(r => r.value === reason)?.hint ?? '';

  async function apply() {
    setBusy(true); setErr(null);
    try {
      await railway.updateInvoicePayment(invoiceId, paymentId, {
        varianceReason: reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      // Closing and chasing aren't opposites — see RecordPaymentPanel. The
      // invoice leaves the aging report either way; the flag decides whether
      // the difference stays on the follow-up list.
      if (chase) {
        try {
          await railway.flagInvoice(invoiceId, {
            flaggedReason: 'disputed',
            flaggedNote: `Closed short ${money(remaining)} — still chasing`,
          });
        } catch { /* the close already landed; a failed flag must not undo it */ }
      }
      setOpen(false);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not close it out');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)} disabled={busy}
              className="inline-flex items-center gap-1.5"
              style={{
                height: 28, padding: '0 10px', borderRadius: 8,
                border: `1px solid ${open ? '#b06000' : 'var(--gc-border)'}`,
                background: open ? '#fef7e0' : 'var(--gc-surface)',
                color: open ? '#b06000' : 'var(--gc-text-2)',
                fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
              }}>
        <CircleOff size={12} /> Close out {money(remaining)}
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, width: 320, zIndex: 50,
          [direction === 'up' ? 'bottom' : 'top']: 34,
          background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
          borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 12,
        }}>
          <div className="flex items-center justify-between mb-1">
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--gc-text-1)' }}>
              Close out {money(remaining)}
            </span>
            <button onClick={() => setOpen(false)} style={{ color: 'var(--gc-text-3)' }}>
              <X size={14} />
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--gc-text-3)', lineHeight: 1.45, marginBottom: 8 }}>
            The invoice settles at what they actually sent. The {money(remaining)}
            {' '}stays visible as the gap — nothing is erased.
          </div>

          <select value={reason} disabled={busy} style={FIELD}
                  onChange={e => setReason(e.target.value as PaymentVarianceReason)}>
            {WRITE_OFF_REASONS.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 4, lineHeight: 1.4 }}>
            {hint}
          </div>

          <input value={note} disabled={busy} onChange={e => setNote(e.target.value)}
                 placeholder="Note (optional)" style={{ ...FIELD, marginTop: 8 }} />

          <label className="flex items-start gap-2 mt-2 cursor-pointer"
                 style={{ fontSize: 11.5, color: 'var(--gc-text-2)' }}>
            <input type="checkbox" checked={chase} className="mt-0.5"
                   onChange={e => setChase(e.target.checked)} />
            <span>Still chasing it — flag as disputed</span>
          </label>

          {err && <div style={{ fontSize: 11, color: '#c5221f', marginTop: 6 }}>{err}</div>}

          <button onClick={() => { void apply(); }} disabled={busy}
                  className="inline-flex items-center justify-center gap-1.5 w-full"
                  style={{
                    marginTop: 10, height: 30, borderRadius: 8, fontSize: 12, fontWeight: 700,
                    background: '#1a73e8', color: '#fff', cursor: busy ? 'default' : 'pointer',
                  }}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {busy ? 'Closing…' : 'Close it out'}
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
