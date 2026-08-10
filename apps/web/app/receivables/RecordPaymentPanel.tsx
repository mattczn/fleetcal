'use client';

/**
 * RecordPaymentPanel — the drawer behind every row on /receivables.
 *
 * Two jobs, in the order an operator actually does them:
 *   1. Record that money arrived (amount, date, method).
 *   2. Say how you know — attach a remittance/bank line, or pick one
 *      that's already sitting unapplied.
 *
 * Step 2 is optional and reversible. Marking paid on trust is a normal
 * Tuesday; the remittance shows up Thursday and gets attached then. What
 * the panel refuses to do is hide the difference — an unbacked payment
 * says so.
 *
 * Variance: when the amount entered differs from the invoice balance by
 * more than half a percent, the panel surfaces the delta and asks what
 * it was. A 1.5–3.5% shortfall pre-selects Quick Pay, since that's the
 * standard broker early-payment discount and by far the most common
 * explanation. The reason rides on THIS allocation, so a lumper deducted
 * against one load in a fourteen-load payment stays attached to that
 * load.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Paperclip, Trash2, FileText, AlertTriangle, Check, Flag, CalendarClock } from 'lucide-react';
import { railway } from '@/lib/railway';
import type {
  ReceivableInvoice, InvoicePayment, PaymentProof,
  PaymentMethod, PaymentVarianceReason, PaymentProofKind, InvoiceFlagReason,
} from '@fleetcal/types';
import { INVOICE_FLAG_REASONS, INVOICE_FLAG_LABEL } from '@fleetcal/types';

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const todayISO = () => new Date().toISOString().slice(0, 10);

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'ach',       label: 'ACH' },
  { value: 'check',     label: 'Check' },
  { value: 'wire',      label: 'Wire' },
  { value: 'factoring', label: 'Factoring' },
  { value: 'other',     label: 'Other' },
];

const VARIANCE_REASONS: { value: PaymentVarianceReason; label: string }[] = [
  { value: 'quick_pay',   label: 'Quick Pay (broker discount)' },
  { value: 'short_pay',   label: 'Short Pay' },
  { value: 'deduction',   label: 'Deduction / Chargeback' },
  { value: 'overpayment', label: 'Overpayment' },
  { value: 'other',       label: 'Other' },
];

const PROOF_KINDS: { value: PaymentProofKind; label: string }[] = [
  { value: 'remittance',       label: 'Remittance advice' },
  { value: 'bank_transaction', label: 'Bank transaction' },
  { value: 'check',            label: 'Check' },
  { value: 'other',            label: 'Other' },
];

/** Half a cent — same tolerance the server settles on. */
const CENT = 0.005;

/** Pre-selects the most likely explanation for a delta. Under by
 *  1.5–3.5% is almost always the broker's quick-pay discount; anything
 *  else short is a short pay until a human says otherwise. */
function suggestReason(variance: number, balance: number): PaymentVarianceReason {
  if (variance > 0) return 'overpayment';
  const pct = balance > 0 ? Math.abs(variance / balance) * 100 : 0;
  return pct >= 1.5 && pct <= 3.5 ? 'quick_pay' : 'short_pay';
}

export interface RecordPaymentPanelProps {
  row:      ReceivableInvoice;
  /** Fired after any write so the parent can refresh its rows. */
  onSaved:  () => void;
  onClose:  () => void;
}

export default function RecordPaymentPanel({ row, onSaved, onClose }: RecordPaymentPanelProps) {
  const [payments, setPayments] = useState<InvoicePayment[]>([]);
  const [proofs,   setProofs]   = useState<PaymentProof[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);

  // ── Payment form ──────────────────────────────────────────────────
  const [amountStr, setAmountStr] = useState('');
  const [paidOn,    setPaidOn]    = useState(todayISO());
  const [method,    setMethod]    = useState<PaymentMethod | ''>('');
  const [note,      setNote]      = useState('');
  // '' means "use the suggestion" — the reason is derived during render
  // rather than synced by an effect, so it re-suggests automatically as
  // the amount changes and stops the moment the operator picks one.
  const [reason,    setReason]    = useState<PaymentVarianceReason | ''>('');

  // ── Follow-up ─────────────────────────────────────────────────────
  // Separate from the payment form on purpose: flagging is what you do
  // when money has NOT arrived, and making it share a Save button with
  // "record a payment" would mean picking an amount to say "still chasing".
  const [flagReason,  setFlagReason]  = useState<InvoiceFlagReason | ''>(row.flaggedReason ?? '');
  const [flagNote,    setFlagNote]    = useState(row.flaggedNote ?? '');
  const [promisedOn,  setPromisedOn]  = useState(row.promisedPayDate ?? '');
  const [flagBusy,    setFlagBusy]    = useState(false);

  const flagDirty =
    (flagReason || '') !== (row.flaggedReason ?? '') ||
    flagNote.trim()    !== (row.flaggedNote ?? '') ||
    (promisedOn || '') !== (row.promisedPayDate ?? '');

  async function saveFlag() {
    setFlagBusy(true); setErr(null);
    try {
      await railway.flagInvoice(row.id, {
        flaggedReason:   flagReason || null,
        flaggedNote:     flagReason ? (flagNote.trim() || null) : null,
        promisedPayDate: promisedOn || null,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the follow-up');
    } finally {
      setFlagBusy(false);
    }
  }

  // ── Proof selection ───────────────────────────────────────────────
  // 'none' = record without evidence; 'existing' = apply an unapplied
  // proof; 'new' = create one inline.
  const [proofMode,  setProofMode]  = useState<'none' | 'existing' | 'new'>('none');
  const [proofId,    setProofId]    = useState('');
  const [newKind,    setNewKind]    = useState<PaymentProofKind>('remittance');
  const [newRef,     setNewRef]     = useState('');
  const [newPayer,   setNewPayer]   = useState('');
  const [newAmount,  setNewAmount]  = useState('');
  const [file,       setFile]       = useState<File | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, pr] = await Promise.all([
        railway.listInvoicePayments(row.id),
        // Unapplied evidence for this customer is the useful candidate
        // set — a remittance from a different broker is never the
        // answer, and the full list would be unusable at volume.
        railway.listPaymentProofs({
          unapplied: true,
          ...(row.customerId ? { customerId: row.customerId } : {}),
        }),
      ]);
      setPayments(p.payments);
      setProofs(pr.proofs);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, [row.id, row.customerId]);

  useEffect(() => { void load(); }, [load]);

  // Applied-so-far comes from the fetched allocations rather than the
  // row prop, so the panel stays right after its own writes without
  // waiting for the parent list to refetch.
  const applied = useMemo(
    () => payments.reduce((s, p) => s + p.amount, 0),
    [payments],
  );
  const balance = useMemo(
    () => Math.round((row.total - applied) * 100) / 100,
    [row.total, applied],
  );

  // Empty amount means "settle the balance" — the default, and the
  // reason the field starts blank rather than pre-filled.
  const amount = amountStr.trim() === '' ? balance : Number(amountStr);
  const amountValid = Number.isFinite(amount) && amount !== 0;
  const variance = amountValid ? Math.round((amount - balance) * 100) / 100 : 0;
  const hasVariance = amountValid && Math.abs(variance) > CENT;

  const effectiveReason: PaymentVarianceReason = reason || suggestReason(variance, balance);

  const selectedProof = proofs.find(p => p.id === proofId);

  async function handleRecord() {
    if (!amountValid) { setErr('Enter a non-zero amount'); return; }
    setBusy(true);
    setErr(null);
    try {
      let attachProofId: string | undefined;

      if (proofMode === 'existing' && proofId) {
        attachProofId = proofId;
      } else if (proofMode === 'new') {
        const created = await railway.createPaymentProof({
          kind:       newKind,
          source:     file ? 'upload' : 'manual',
          occurredOn: paidOn,
          // The proof's own total defaults to what's being applied, but
          // stays editable: one remittance often covers more than this
          // invoice, and that difference is what marks it partially
          // applied in the unapplied queue.
          amount:     newAmount.trim() === '' ? amount : Number(newAmount),
          reference:  newRef.trim()   || undefined,
          payerRaw:   newPayer.trim() || undefined,
          ...(row.customerId ? { customerId: row.customerId } : {}),
        });
        attachProofId = created.proof.id;
        if (file) {
          await railway.uploadProofAttachment(created.proof.id, file);
        }
      }

      await railway.createInvoicePayment(row.id, {
        amount,
        paidOn,
        ...(method ? { method } : {}),
        ...(attachProofId ? { proofId: attachProofId } : {}),
        ...(hasVariance ? { varianceReason: effectiveReason } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      // Reset the form but keep the panel open — recording a second
      // partial against the same invoice is a normal next action.
      setAmountStr(''); setNote(''); setMethod('');
      setProofMode('none'); setProofId(''); setFile(null);
      setNewRef(''); setNewPayer(''); setNewAmount('');
      setReason('');
      await load();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(paymentId: string) {
    if (!confirm('Reverse this payment? The invoice will recompute and may leave Paid.')) return;
    setBusy(true);
    try {
      await railway.deleteInvoicePayment(row.id, paymentId);
      await load();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to reverse payment');
    } finally {
      setBusy(false);
    }
  }

  async function openAttachment(id: string) {
    try {
      const { url } = await railway.proofAttachmentUrl(id);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setErr('Could not open the attachment');
    }
  }

  const settled = balance <= CENT;

  return (
    <>
      <div className="fixed inset-0" style={{ zIndex: 60, background: 'rgba(0,0,0,.35)' }}
           onClick={onClose} />
      <aside
        className="fixed top-0 right-0 h-full flex flex-col"
        style={{
          zIndex: 61, width: 460, maxWidth: '100vw',
          background: 'var(--gc-surface)', borderLeft: '1px solid var(--gc-border)',
          boxShadow: '0 0 32px rgba(0,0,0,.18)',
        }}>
        {/* Header */}
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start justify-between gap-3"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
              Invoice {row.invoiceNumber}
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
              {row.customerName ?? 'No customer'}
              {row.loadNum ? ` · Load ${row.loadNum}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded shrink-0"
                  style={{ color: 'var(--gc-text-3)' }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {/* Settlement summary */}
          <div className="rounded-lg border p-3 mb-4" style={{ borderColor: 'var(--gc-border)' }}>
            <SummaryLine label="Invoice total" value={fmtMoney(row.total)} />
            <SummaryLine label="Paid so far"   value={fmtMoney(applied)} />
            <div className="mt-1.5 pt-1.5 flex items-center justify-between"
                 style={{ borderTop: '1px solid var(--gc-border)' }}>
              <span className="text-xs font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                Balance
              </span>
              <span className="text-sm font-bold tabular-nums"
                    style={{ color: settled ? '#188038' : 'var(--gc-text-1)' }}>
                {fmtMoney(balance)}
              </span>
            </div>
          </div>

          {err && (
            <div className="rounded-lg border p-3 mb-4 text-xs"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {err}
            </div>
          )}

          {/* Existing payments */}
          <SectionLabel>Payments</SectionLabel>
          {loading ? (
            <div className="text-xs py-2" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
          ) : payments.length === 0 ? (
            <div className="text-xs py-2" style={{ color: 'var(--gc-text-3)' }}>
              Nothing recorded yet.
            </div>
          ) : (
            <div className="mb-4">
              {payments.map(p => (
                <div key={p.id} className="flex items-start gap-2 py-2"
                     style={{ borderBottom: '1px solid var(--gc-border-light, var(--gc-border))' }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                        {fmtMoney(p.amount)}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                        {p.paidOn}{p.method ? ` · ${p.method.toUpperCase()}` : ''}
                      </span>
                    </div>
                    {p.varianceReason && (
                      <div className="text-[11px] mt-0.5" style={{ color: '#b45309' }}>
                        {VARIANCE_REASONS.find(r => r.value === p.varianceReason)?.label}
                      </div>
                    )}
                    {p.note && (
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{p.note}</div>
                    )}
                    {p.proof ? (
                      <button
                        onClick={() => p.proof?.storagePath
                          ? void openAttachment(p.proof.id)
                          : undefined}
                        disabled={!p.proof.storagePath}
                        className="text-[11px] mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                        style={{
                          background: '#e6f4ea', color: '#137333',
                          cursor: p.proof.storagePath ? 'pointer' : 'default',
                        }}>
                        <FileText size={11} />
                        {PROOF_KINDS.find(k => k.value === p.proof?.kind)?.label ?? p.proof.kind}
                        {p.proof.reference ? ` · ${p.proof.reference}` : ''}
                        {p.proof.storagePath ? ' · view' : ''}
                      </button>
                    ) : (
                      <div className="text-[11px] mt-1 inline-flex items-center gap-1"
                           style={{ color: '#b45309' }}>
                        <AlertTriangle size={11} /> No proof attached
                      </div>
                    )}
                  </div>
                  <button onClick={() => void handleDelete(p.id)} disabled={busy}
                          className="p-1 rounded shrink-0" style={{ color: '#c5221f' }}
                          aria-label="Reverse payment">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Record form */}
          {/* ── Follow-up ────────────────────────────────────────────
              Sits ABOVE "record a payment" because when you open this
              drawer on an overdue invoice, the likeliest reason is that
              the money has NOT arrived and you want to note why.

              A promised date does NOT change the aging. The 31+ bucket
              keeps meaning "31+ days late" rather than "…except the ones
              someone said they'd pay" — a promise from a party who has
              already not paid is context, not evidence. */}
          <SectionLabel>Follow-up</SectionLabel>
          <div className="rounded-lg border p-3 mb-4"
               style={{
                 borderColor: row.flaggedAt ? '#f6aea9' : 'var(--gc-border)',
                 background:  row.flaggedAt ? '#fef7f7' : undefined,
               }}>
            <div className="flex items-center gap-1.5 mb-2">
              <Flag size={12} style={{ color: flagReason ? '#c5221f' : 'var(--gc-text-3)' }} />
              <select value={flagReason} disabled={flagBusy}
                      onChange={e => setFlagReason(e.target.value as InvoiceFlagReason | '')}
                      style={{ ...inputStyle, flex: 1 }}>
                <option value="">Not flagged</option>
                {INVOICE_FLAG_REASONS.map(r => (
                  <option key={r} value={r}>{INVOICE_FLAG_LABEL[r]}</option>
                ))}
              </select>
            </div>

            {flagReason && (
              <input value={flagNote} disabled={flagBusy}
                     onChange={e => setFlagNote(e.target.value)}
                     placeholder="What are you waiting on? Who did you speak to?"
                     style={{ ...inputStyle, width: '100%', marginBottom: 8 }} />
            )}

            <div className="flex items-center gap-2">
              <CalendarClock size={12} style={{ color: 'var(--gc-text-3)' }} className="shrink-0" />
              <span className="text-[11px] shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                Payment promised
              </span>
              <input type="date" value={promisedOn} disabled={flagBusy}
                     onChange={e => setPromisedOn(e.target.value)}
                     style={{ ...inputStyle, flex: 1 }} />
            </div>

            {row.flaggedAt && (
              <div className="text-[10.5px] mt-2" style={{ color: 'var(--gc-text-3)' }}>
                Flagged {new Date(row.flaggedAt).toLocaleDateString([], { month: 'short', day: '2-digit', year: '2-digit' })}
                {row.flaggedBy ? ` · ${row.flaggedBy}` : ''}
              </div>
            )}

            {flagDirty && (
              <button onClick={() => { void saveFlag(); }} disabled={flagBusy}
                      className="mt-2.5 text-[11.5px] font-semibold px-3 py-1.5 rounded w-full"
                      style={{ background: '#1a73e8', color: '#fff', cursor: 'pointer' }}>
                {flagBusy ? 'Saving…' : flagReason || promisedOn ? 'Save follow-up' : 'Clear follow-up'}
              </button>
            )}
          </div>

          <SectionLabel>Record a payment</SectionLabel>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Field label={`Amount (blank = ${fmtMoney(balance)})`}>
              <input type="number" step="0.01" value={amountStr}
                     onChange={e => setAmountStr(e.target.value)}
                     placeholder={balance.toFixed(2)} style={inputStyle} />
            </Field>
            <Field label="Date">
              <input type="date" value={paidOn}
                     onChange={e => setPaidOn(e.target.value)} style={inputStyle} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Field label="Method">
              <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod | '')}
                      style={inputStyle}>
                <option value="">—</option>
                {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Note">
              <input value={note} onChange={e => setNote(e.target.value)}
                     placeholder="optional" style={inputStyle} />
            </Field>
          </div>

          {hasVariance && (
            <div className="rounded-lg border p-3 mb-3"
                 style={{ borderColor: '#f59e0b', background: '#fffbeb' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold" style={{ color: '#92400e' }}>
                  {variance < 0 ? 'Short by' : 'Over by'} {fmtMoney(Math.abs(variance))}
                </span>
                <span className="text-[11px]" style={{ color: '#92400e' }}>
                  {balance > 0 ? `${Math.abs(variance / balance * 100).toFixed(2)}%` : ''}
                </span>
              </div>
              <select value={effectiveReason}
                      onChange={e => setReason(e.target.value as PaymentVarianceReason)}
                      style={inputStyle}>
                {VARIANCE_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          )}

          {/* Proof */}
          <SectionLabel>How do you know?</SectionLabel>
          <div className="flex gap-1.5 mb-2">
            <ModeChip active={proofMode === 'none'}     onClick={() => setProofMode('none')}     label="No proof yet" />
            <ModeChip active={proofMode === 'existing'} onClick={() => setProofMode('existing')} label={`Existing (${proofs.length})`} />
            <ModeChip active={proofMode === 'new'}      onClick={() => setProofMode('new')}      label="Add new" />
          </div>

          {proofMode === 'existing' && (
            proofs.length === 0 ? (
              <div className="text-xs py-2 mb-2" style={{ color: 'var(--gc-text-3)' }}>
                No unapplied evidence for this customer.
              </div>
            ) : (
              <div className="mb-3 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--gc-border)' }}>
                {proofs.map(p => {
                  const remaining = Math.round((p.amount - (p.appliedAmount ?? 0)) * 100) / 100;
                  return (
                    <button key={p.id} onClick={() => setProofId(p.id === proofId ? '' : p.id)}
                            className="w-full text-left px-2.5 py-2 flex items-center gap-2"
                            style={{
                              background: proofId === p.id ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent',
                              borderBottom: '1px solid var(--gc-border)',
                            }}>
                      {proofId === p.id
                        ? <Check size={13} style={{ color: '#1a73e8' }} />
                        : <span style={{ width: 13 }} />}
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {PROOF_KINDS.find(k => k.value === p.kind)?.label ?? p.kind}
                          {p.reference ? ` · ${p.reference}` : ''}
                        </span>
                        <span className="block text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          {p.occurredOn} · {fmtMoney(p.amount)}
                          {remaining !== p.amount ? ` · ${fmtMoney(remaining)} unapplied` : ''}
                        </span>
                      </span>
                      {p.storagePath && <Paperclip size={12} style={{ color: 'var(--gc-text-3)' }} />}
                    </button>
                  );
                })}
              </div>
            )
          )}

          {proofMode === 'new' && (
            <div className="mb-3 rounded-lg border p-3" style={{ borderColor: 'var(--gc-border)' }}>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Field label="Kind">
                  <select value={newKind} onChange={e => setNewKind(e.target.value as PaymentProofKind)}
                          style={inputStyle}>
                    {PROOF_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </Field>
                <Field label="Reference">
                  <input value={newRef} onChange={e => setNewRef(e.target.value)}
                         placeholder="check # / trace" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Field label="Payer as shown">
                  <input value={newPayer} onChange={e => setNewPayer(e.target.value)}
                         placeholder="optional" style={inputStyle} />
                </Field>
                <Field label="Proof total (blank = this payment)">
                  <input type="number" step="0.01" value={newAmount}
                         onChange={e => setNewAmount(e.target.value)}
                         placeholder={amountValid ? amount.toFixed(2) : ''} style={inputStyle} />
                </Field>
              </div>
              <Field label="File (PDF or image, optional)">
                <input type="file" accept="application/pdf,image/*"
                       onChange={e => setFile(e.target.files?.[0] ?? null)}
                       className="text-xs" style={{ color: 'var(--gc-text-2)' }} />
              </Field>
            </div>
          )}

          {proofMode === 'existing' && selectedProof && (
            <div className="text-[11px] mb-3" style={{ color: 'var(--gc-text-3)' }}>
              Applying {fmtMoney(amountValid ? amount : 0)} of this {fmtMoney(selectedProof.amount)} proof.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 flex items-center justify-end gap-2"
             style={{ borderTop: '1px solid var(--gc-border)' }}>
          <button onClick={onClose} className="text-xs font-semibold px-3 py-1.5 rounded border"
                  style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
            Close
          </button>
          <button
            onClick={() => void handleRecord()}
            disabled={busy || !amountValid || (proofMode === 'existing' && !proofId)}
            className="text-xs font-semibold px-3 py-1.5 rounded"
            style={{
              background: busy || !amountValid ? 'var(--gc-border)' : '#1a73e8',
              color: '#fff',
              cursor: busy || !amountValid ? 'default' : 'pointer',
            }}>
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </div>
      </aside>
    </>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--gc-border)', background: 'var(--gc-surface)',
  color: 'var(--gc-text-1)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5"
         style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      <span className="text-xs tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{value}</span>
    </div>
  );
}

function ModeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
            className="text-[11px] font-semibold px-2 py-1 rounded border"
            style={{
              borderColor: active ? '#1a73e8' : 'var(--gc-border)',
              background:  active ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent',
              color:       active ? '#1a73e8' : 'var(--gc-text-3)',
            }}>
      {label}
    </button>
  );
}
