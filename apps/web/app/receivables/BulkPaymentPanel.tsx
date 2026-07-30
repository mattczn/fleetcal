'use client';

/**
 * BulkPaymentPanel — record one payment against many invoices.
 *
 * This is the shape a broker payment actually arrives in: one ACH for
 * $47,300 covering fourteen loads, with one remittance advice explaining
 * it. So the proof is created ONCE and every allocation cites it. That's
 * the entire reason payment_proofs is a separate table from
 * invoice_payments — see migration 20260730_receivables.sql.
 *
 * Each selected invoice settles its OWN full balance. There is
 * deliberately no "total received" field to divide across the selection:
 * splitting a lump sum by invoice size is guesswork, and it is precisely
 * what made the predecessor system misstate every invoice in a payment
 * whenever a broker deducted against one load. If one invoice in the
 * batch was short-paid, it gets recorded on its own where the variance
 * can be classified against the load it was taken from.
 *
 * Used by both the ledger (expanded customer) and the customer view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { X, Paperclip, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { railway } from '@/lib/railway';
import type {
  ReceivableInvoice, PaymentProof, PaymentMethod, PaymentProofKind,
} from '@fleetcal/types';

const money2 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const todayISO = () => new Date().toISOString().slice(0, 10);

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'ach',       label: 'ACH' },
  { value: 'check',     label: 'Check' },
  { value: 'wire',      label: 'Wire' },
  { value: 'factoring', label: 'Factoring' },
  { value: 'other',     label: 'Other' },
];

const PROOF_KINDS: { value: PaymentProofKind; label: string }[] = [
  { value: 'remittance',       label: 'Remittance advice' },
  { value: 'bank_transaction', label: 'Bank transaction' },
  { value: 'check',            label: 'Check' },
  { value: 'other',            label: 'Other' },
];

export interface BulkPaymentPanelProps {
  invoices:     ReceivableInvoice[];
  customerId?:  string;
  customerName: string;
  onSaved:      () => void;
  onClose:      () => void;
}

export default function BulkPaymentPanel({
  invoices, customerId, customerName, onSaved, onClose,
}: BulkPaymentPanelProps) {
  const [proofs, setProofs] = useState<PaymentProof[]>([]);
  const [busy,   setBusy]   = useState(false);
  const [err,    setErr]    = useState<string | null>(null);
  const [done,   setDone]   = useState<number>(0);

  const [paidOn, setPaidOn] = useState(todayISO());
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [note,   setNote]   = useState('');

  const [proofMode, setProofMode] = useState<'none' | 'existing' | 'new'>('none');
  const [proofId,   setProofId]   = useState('');
  const [newKind,   setNewKind]   = useState<PaymentProofKind>('remittance');
  const [newRef,    setNewRef]    = useState('');
  const [newPayer,  setNewPayer]  = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [file,      setFile]      = useState<File | null>(null);

  const total = useMemo(
    () => Math.round(invoices.reduce((s, i) => s + i.balance, 0) * 100) / 100,
    [invoices],
  );

  const loadProofs = useCallback(async () => {
    try {
      const res = await railway.listPaymentProofs({
        unapplied: true,
        ...(customerId ? { customerId } : {}),
      });
      setProofs(res.proofs);
    } catch {
      setProofs([]);
    }
  }, [customerId]);

  useEffect(() => { void loadProofs(); }, [loadProofs]);

  async function handleApply() {
    if (!invoices.length || busy) return;
    setBusy(true);
    setErr(null);
    setDone(0);
    try {
      let attachProofId: string | undefined;

      if (proofMode === 'existing' && proofId) {
        attachProofId = proofId;
      } else if (proofMode === 'new') {
        const created = await railway.createPaymentProof({
          kind:       newKind,
          source:     file ? 'upload' : 'manual',
          occurredOn: paidOn,
          // Defaults to the batch total, which is the common case for a
          // single ACH. Editable because a remittance often covers more
          // than what's selected here — the remainder then shows up in
          // the unapplied queue rather than silently vanishing.
          amount:     newAmount.trim() === '' ? total : Number(newAmount),
          reference:  newRef.trim()   || undefined,
          payerRaw:   newPayer.trim() || undefined,
          ...(customerId ? { customerId } : {}),
        });
        attachProofId = created.proof.id;
        if (file) await railway.uploadProofAttachment(created.proof.id, file);
      }

      // Sequential: each write recomputes its invoice server-side, and a
      // failure on one shouldn't abandon the rest of the batch.
      const failed: string[] = [];
      for (const inv of invoices) {
        try {
          await railway.createInvoicePayment(inv.id, {
            amount: inv.balance,
            paidOn,
            ...(method ? { method } : {}),
            ...(attachProofId ? { proofId: attachProofId } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          });
          setDone(d => d + 1);
        } catch (e) {
          failed.push(inv.invoiceNumber);
          console.warn('[bulk payment] failed for', inv.invoiceNumber, e);
        }
      }

      onSaved();
      if (failed.length) {
        setErr(`${failed.length} of ${invoices.length} could not be recorded: ${failed.join(', ')}`);
      } else {
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setBusy(false);
    }
  }

  const selectedProof = proofs.find(p => p.id === proofId);

  return (
    <>
      <div className="fixed inset-0" style={{ zIndex: 60, background: 'rgba(0,0,0,.35)' }} onClick={busy ? undefined : onClose} />
      <aside className="fixed top-0 right-0 h-full flex flex-col" style={{
        zIndex: 61, width: 460, maxWidth: '100vw',
        background: 'var(--gc-surface)', borderLeft: '1px solid var(--gc-border)',
        boxShadow: '0 0 32px rgba(0,0,0,.18)',
      }}>
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start justify-between gap-3"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
              Record a payment
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
              {invoices.length} invoice{invoices.length === 1 ? '' : 's'} · {customerName}
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-1 rounded shrink-0"
                  style={{ color: 'var(--gc-text-3)' }} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {/* What's about to be written */}
          <div className="rounded-lg border p-3 mb-4" style={{ borderColor: 'var(--gc-border)' }}>
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>Total across selection</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                {money2(total)}
              </span>
            </div>
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--gc-text-3)' }}>
              Each invoice is settled for its own balance in full. If one was short-paid,
              record that one on its own so the shortfall lands on the right load.
            </div>
          </div>

          <div className="max-h-32 overflow-y-auto mb-4 rounded-lg border" style={{ borderColor: 'var(--gc-border)' }}>
            {invoices.map(inv => (
              <div key={inv.id} className="flex items-center justify-between px-2.5 py-1.5"
                   style={{ borderBottom: '1px solid var(--gc-border-light)', fontSize: 12 }}>
                <span style={{ fontWeight: 700, color: '#1967d2' }}>{inv.invoiceNumber}</span>
                <span className="tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{money2(inv.balance)}</span>
              </div>
            ))}
          </div>

          {err && (
            <div className="rounded-lg border p-3 mb-4 text-xs"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {err}
            </div>
          )}

          <SectionLabel>Record a payment</SectionLabel>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <Field label="Date">
              <input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Method">
              <select value={method} onChange={e => setMethod(e.target.value as PaymentMethod | '')} style={inputStyle}>
                <option value="">—</option>
                {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Note (applied to every invoice)">
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="optional" style={inputStyle} />
          </Field>

          <div style={{ height: 14 }} />

          <SectionLabel>How do you know?</SectionLabel>
          <div className="flex gap-1.5 mb-2">
            <ModeChip active={proofMode === 'none'}     onClick={() => setProofMode('none')}     label="No proof yet" />
            <ModeChip active={proofMode === 'existing'} onClick={() => setProofMode('existing')} label={`Existing (${proofs.length})`} />
            <ModeChip active={proofMode === 'new'}      onClick={() => setProofMode('new')}      label="Add new" />
          </div>
          <div className="text-[11px] mb-2" style={{ color: 'var(--gc-text-3)' }}>
            One proof, cited by all {invoices.length} — a single remittance covering the batch.
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
                      {proofId === p.id ? <Check size={13} style={{ color: '#1a73e8' }} /> : <span style={{ width: 13 }} />}
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {PROOF_KINDS.find(k => k.value === p.kind)?.label ?? p.kind}
                          {p.reference ? ` · ${p.reference}` : ''}
                        </span>
                        <span className="block text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          {p.occurredOn} · {money2(p.amount)}
                          {remaining !== p.amount ? ` · ${money2(remaining)} unapplied` : ''}
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
                  <select value={newKind} onChange={e => setNewKind(e.target.value as PaymentProofKind)} style={inputStyle}>
                    {PROOF_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                  </select>
                </Field>
                <Field label="Reference">
                  <input value={newRef} onChange={e => setNewRef(e.target.value)} placeholder="check # / trace" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <Field label="Payer as shown">
                  <input value={newPayer} onChange={e => setNewPayer(e.target.value)} placeholder="optional" style={inputStyle} />
                </Field>
                <Field label={`Proof total (blank = ${money2(total)})`}>
                  <input type="number" step="0.01" value={newAmount}
                         onChange={e => setNewAmount(e.target.value)}
                         placeholder={total.toFixed(2)} style={inputStyle} />
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
            <div className="text-[11px] mb-3 inline-flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
              {selectedProof.amount + 0.005 < total && <AlertTriangle size={11} style={{ color: '#b45309' }} />}
              Applying {money2(total)} against a {money2(selectedProof.amount)} proof.
            </div>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 flex items-center justify-end gap-2"
             style={{ borderTop: '1px solid var(--gc-border)' }}>
          {busy && (
            <span className="text-[11px] mr-auto" style={{ color: 'var(--gc-text-3)' }}>
              {done} of {invoices.length} recorded…
            </span>
          )}
          <button onClick={onClose} disabled={busy}
            className="text-xs font-semibold px-3 py-1.5 rounded border"
            style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
            Cancel
          </button>
          <button onClick={() => void handleApply()}
            disabled={busy || !invoices.length || (proofMode === 'existing' && !proofId)}
            className="text-xs font-semibold px-3 py-1.5 rounded inline-flex items-center gap-1.5"
            style={{
              background: busy ? 'var(--gc-border)' : '#1a73e8', color: '#fff',
              cursor: busy ? 'default' : 'pointer',
            }}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            Mark {invoices.length} paid · {money2(total)}
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
    <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      {children}
    </label>
  );
}

function ModeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} className="text-[11px] font-semibold px-2 py-1 rounded border"
      style={{
        borderColor: active ? '#1a73e8' : 'var(--gc-border)',
        background:  active ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent',
        color:       active ? '#1a73e8' : 'var(--gc-text-3)',
      }}>
      {label}
    </button>
  );
}
