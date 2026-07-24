'use client';

/**
 * ExpenseDetailPanel — the workspace's single detail surface.
 *
 * Opens as a centered modal (same idiom as the equipment page's
 * DetailPanel: backdrop, rounded card, color-dot header, Esc closes).
 * The body adapts to the ledger row's source:
 *
 *   ramp       receipt links, cardholder, memo, asset + bucket controls,
 *              "always file like this" rule creation
 *   entry      full edit form (this replaced /expenses/one-time)
 *   recurring  rule editor + proration math (replaced /expenses/recurring)
 *   payroll    read-only weekly summary + deep link to /payroll
 *   mudflap    read-only fuel purchase + deep link to the fuel tab
 *   create     "+ Expense" mode — one-time | recurring toggle
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X, Trash2, Square, ExternalLink, Receipt as ReceiptIcon, Sparkles, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import BucketSelect, { invalidateBucketCache } from './BucketSelect';
import type {
  LedgerRow, RampTransaction, RecurringExpenseCadence,
} from '@fleetcal/types';
import type { Asset } from '@/lib/types';

export type PanelMode =
  | { kind: 'row'; row: LedgerRow }
  | { kind: 'create' };

interface Trailer { id: number; name: string; trailerNumber?: string }

interface Props {
  mode: PanelMode;
  assets: Asset[];
  trailers: Trailer[];
  onClose: () => void;
  /** Refetch ledger + summary behind the panel. */
  onMutated: () => void;
}

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

const fmtDateLong = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString([], {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
  });

const todayIso = () => new Date().toISOString().slice(0, 10);

const SOURCE_META: Record<string, { color: string; title: string }> = {
  ramp:      { color: '#059669', title: 'Card transaction · Ramp' },
  mudflap:   { color: '#0891b2', title: 'Fuel purchase · Mudflap' },
  payroll:   { color: '#7c3aed', title: 'Driver payroll · weekly' },
  entry:     { color: '#6b7280', title: 'Manual expense' },
  recurring: { color: '#4f46e5', title: 'Recurring expense' },
  create:    { color: '#1a73e8', title: 'New expense' },
};

// ── shared field primitives ─────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
           style={{ color: 'var(--gc-text-3)' }}>{children}</label>
  );
}

const inputCls = 'w-full px-3 py-1.5 rounded border text-sm';
const inputStyle = { borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' } as const;

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b last:border-b-0"
         style={{ borderColor: 'var(--gc-border)' }}>
      <span className="text-[11px] font-bold uppercase tracking-wider shrink-0"
            style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      <span className="text-sm text-right min-w-0" style={{ color: 'var(--gc-text-1)' }}>{children}</span>
    </div>
  );
}

function AmountHeader({ amount, date }: { amount: number; date: string }) {
  return (
    <div className="flex items-baseline justify-between px-5 pt-4 pb-3">
      <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>{fmtDateLong(date)}</div>
      <div className="text-[28px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
        {fmtMoney(amount)}
      </div>
    </div>
  );
}

function PanelButton({
  onClick, disabled, danger, primary, children, title,
}: {
  onClick: () => void; disabled?: boolean; danger?: boolean; primary?: boolean;
  children: React.ReactNode; title?: string;
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
      style={{
        borderColor: danger ? '#fecaca' : primary ? '#1a73e8' : 'var(--gc-border)',
        background:  primary ? '#1a73e8' : 'var(--gc-surface)',
        color:       danger ? '#dc2626' : primary ? '#fff' : 'var(--gc-text-1)',
        cursor:      disabled ? 'not-allowed' : 'pointer',
        opacity:     disabled ? 0.6 : 1,
      }}>
      {children}
    </button>
  );
}

// ── ramp body ───────────────────────────────────────────────────────────

function RampBody({
  tx: initial, assets, trailers, onMutated,
}: {
  tx: RampTransaction; assets: Asset[]; trailers: Trailer[]; onMutated: () => void;
}) {
  const [tx, setTx] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [ruleMsg, setRuleMsg] = useState<string | null>(null);

  const assetValue =
    tx.assetId != null ? `asset:${tx.assetId}` :
    tx.trailerId != null ? `trailer:${tx.trailerId}` :
    tx.matchStatus === 'not_applicable' ? 'na' : '';

  const changeBucket = useCallback(async (bucketId: string) => {
    setBusy(true);
    try {
      const r = await railway.setRampTransactionBucket(tx.id, bucketId || null);
      setTx(r.rampTransaction);
      onMutated();
    } catch { alert('Failed to update bucket.'); }
    finally { setBusy(false); }
  }, [tx.id, onMutated]);

  const changeAsset = useCallback(async (value: string) => {
    setBusy(true);
    try {
      let updated: RampTransaction;
      if (value === 'na') {
        updated = (await railway.markRampTransactionNotApplicable(tx.id)).rampTransaction;
      } else if (value === '') {
        updated = (await railway.matchRampTransaction(tx.id, { assetId: null, trailerId: null })).rampTransaction;
      } else if (value.startsWith('asset:')) {
        updated = (await railway.matchRampTransaction(tx.id, { assetId: Number(value.slice(6)) })).rampTransaction;
      } else {
        updated = (await railway.matchRampTransaction(tx.id, { trailerId: Number(value.slice(8)) })).rampTransaction;
      }
      setTx(updated);
      onMutated();
    } catch { alert('Failed to update asset link.'); }
    finally { setBusy(false); }
  }, [tx.id, onMutated]);

  const createRule = useCallback(async () => {
    if (!tx.skCategoryName || !tx.bucketId) return;
    setBusy(true);
    setRuleMsg(null);
    try {
      await railway.createRampCategoryRule({
        pattern:  tx.skCategoryName,
        isRegex:  false,
        bucketId: tx.bucketId,
        priority: 10,
        notes:    `created from txn at ${tx.merchantName ?? 'unknown merchant'}`,
      });
      setRuleMsg(`Rule saved — "${tx.skCategoryName}" will always file here.`);
    } catch { setRuleMsg('Failed to save rule.'); }
    finally { setBusy(false); }
  }, [tx]);

  const receipts = (tx.receipts ?? []).filter(r => r.url);

  return (
    <>
      <AmountHeader amount={tx.amount} date={tx.transactedAt} />
      <div className="px-5 pb-4">
        <div className="rounded-lg border px-4 py-2 mb-4"
             style={{ borderColor: 'var(--gc-border)' }}>
          <InfoRow label="Merchant">{tx.merchantName ?? '—'}</InfoRow>
          <InfoRow label="Cardholder">{tx.cardholderName ?? '—'}</InfoRow>
          <InfoRow label="Memo">{tx.memo || <span style={{ color: '#c026d3' }}>No memo</span>}</InfoRow>
          <InfoRow label="Ramp category">{tx.skCategoryName ?? '—'}</InfoRow>
          <InfoRow label="Receipt">
            {receipts.length === 0
              ? <span style={{ color: '#c026d3' }}>Missing</span>
              : receipts.map((r, i) => (
                  <a key={i} href={r.url} target="_blank" rel="noreferrer"
                     className="inline-flex items-center gap-1 underline mr-2"
                     style={{ color: '#1a73e8' }}>
                    <ReceiptIcon size={12} /> View{receipts.length > 1 ? ` #${i + 1}` : ''}
                  </a>
                ))}
          </InfoRow>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <FieldLabel>Bucket</FieldLabel>
            <BucketSelect
              value={tx.bucketId ?? ''}
              onChange={id => void changeBucket(id)}
              includeUncategorized
              disabled={busy}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <FieldLabel>Truck / Trailer</FieldLabel>
            <StyledSelect
              value={assetValue}
              onChange={e => void changeAsset(e.target.value)}
              disabled={busy}
              style={{ width: '100%' }}>
              <option value="">— Unmatched —</option>
              <option value="na">Not equipment-related</option>
              <optgroup label="Trucks">
                {assets.map(a => (
                  <option key={a.id} value={`asset:${a.id}`}>{a.name}</option>
                ))}
              </optgroup>
              <optgroup label="Trailers">
                {trailers.map(t => (
                  <option key={t.id} value={`trailer:${t.id}`}>
                    {t.trailerNumber ? `#${t.trailerNumber}` : t.name}
                  </option>
                ))}
              </optgroup>
            </StyledSelect>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <PanelButton
            onClick={() => void createRule()}
            disabled={busy || !tx.skCategoryName || !tx.bucketId}
            title={!tx.bucketId
              ? 'Pick a bucket first'
              : `Every future "${tx.skCategoryName}" txn files into this bucket automatically`}>
            <Sparkles size={13} /> Always file like this
          </PanelButton>
          {ruleMsg && <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{ruleMsg}</span>}
        </div>
      </div>
    </>
  );
}

// ── entry body (edit) ───────────────────────────────────────────────────

function EntryBody({ row, onMutated, onClose }: { row: LedgerRow; onMutated: () => void; onClose: () => void }) {
  const e = row.entry!;
  const [form, setForm] = useState({
    bucketId: e.bucketId, kind: e.kind ?? '', date: e.date,
    amount: String(e.amount), label: e.label, notes: e.notes ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const amount = Number(form.amount);
    if (!form.label.trim() || !isFinite(amount) || amount <= 0) { alert('Label and a positive amount are required.'); return; }
    setBusy(true);
    try {
      await railway.updateExpenseEntry(e.id, {
        bucketId: form.bucketId,
        kind:     form.kind.trim() || null,
        date:     form.date,
        amount,
        label:    form.label.trim(),
        notes:    form.notes.trim() || null,
      });
      onMutated(); onClose();
    } catch { alert('Failed to save.'); setBusy(false); }
  };
  const del = async () => {
    if (!confirm('Delete this expense entry?')) return;
    setBusy(true);
    try { await railway.deleteExpenseEntry(e.id); onMutated(); onClose(); }
    catch { alert('Failed to delete.'); setBusy(false); }
  };

  return (
    <>
      <AmountHeader amount={Number(form.amount) || e.amount} date={form.date} />
      <div className="px-5 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <div><FieldLabel>Bucket</FieldLabel>
            <BucketSelect value={form.bucketId} onChange={id => setForm({ ...form, bucketId: id })} style={{ width: '100%' }} /></div>
          <div><FieldLabel>Date</FieldLabel>
            <input type="date" value={form.date} onChange={ev => setForm({ ...form, date: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div className="col-span-2"><FieldLabel>Label</FieldLabel>
            <input type="text" value={form.label} onChange={ev => setForm({ ...form, label: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div><FieldLabel>Amount ($)</FieldLabel>
            <input type="number" step="0.01" min="0" value={form.amount}
                   onChange={ev => setForm({ ...form, amount: ev.target.value })}
                   className={`${inputCls} tabular-nums`} style={inputStyle} /></div>
          <div><FieldLabel>Category tag</FieldLabel>
            <input type="text" value={form.kind} onChange={ev => setForm({ ...form, kind: ev.target.value })}
                   placeholder="tax, owner_draw, …" className={inputCls} style={inputStyle} /></div>
          <div className="col-span-2"><FieldLabel>Notes</FieldLabel>
            <input type="text" value={form.notes} onChange={ev => setForm({ ...form, notes: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <PanelButton onClick={() => void del()} disabled={busy} danger><Trash2 size={13} /> Delete</PanelButton>
          <PanelButton onClick={() => void save()} disabled={busy} primary><Check size={13} /> {busy ? 'Saving…' : 'Save'}</PanelButton>
        </div>
      </div>
    </>
  );
}

// ── recurring body (rule edit) ──────────────────────────────────────────

function RecurringBody({ row, onMutated, onClose }: { row: LedgerRow; onMutated: () => void; onClose: () => void }) {
  const r = row.recurring!;
  const [form, setForm] = useState({
    bucketId: r.bucketId, kind: r.kind ?? '', label: r.label,
    amount: String(r.amount), cadence: r.cadence,
    effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo ?? '', notes: r.notes ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const amount = Number(form.amount);
    if (!form.label.trim() || !isFinite(amount) || amount <= 0) { alert('Label and a positive amount are required.'); return; }
    setBusy(true);
    try {
      await railway.updateRecurringExpense(r.id, {
        bucketId: form.bucketId,
        kind:     form.kind.trim() || null,
        label:    form.label.trim(),
        amount,
        cadence:  form.cadence,
        effectiveFrom: form.effectiveFrom,
        effectiveTo:   form.effectiveTo || null,
        notes:    form.notes.trim() || null,
      });
      onMutated(); onClose();
    } catch { alert('Failed to save.'); setBusy(false); }
  };
  const end = async () => {
    if (!confirm('End this rule as of today? It stops posting into future periods.')) return;
    setBusy(true);
    try { await railway.endRecurringExpense(r.id); onMutated(); onClose(); }
    catch { alert('Failed to end rule.'); setBusy(false); }
  };
  const del = async () => {
    if (!confirm('Permanently delete this recurring rule?')) return;
    setBusy(true);
    try { await railway.deleteRecurringExpense(r.id); onMutated(); onClose(); }
    catch { alert('Failed to delete.'); setBusy(false); }
  };

  return (
    <>
      <AmountHeader amount={r.prorated} date={row.date} />
      <div className="px-5 pb-4">
        <div className="rounded-lg border px-3 py-2 mb-4 text-xs"
             style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-3)' }}>
          {fmtMoney(r.amount)} / {r.cadence === 'weekly' ? 'week' : 'month'} · posts {r.cadence === 'weekly' ? 'every 7 days' : 'monthly'} from{' '}
          {r.effectiveFrom} · this posting: <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(r.prorated)}</span> on {row.date}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><FieldLabel>Bucket</FieldLabel>
            <BucketSelect value={form.bucketId} onChange={id => setForm({ ...form, bucketId: id })} style={{ width: '100%' }} /></div>
          <div><FieldLabel>Cadence</FieldLabel>
            <StyledSelect value={form.cadence}
                          onChange={ev => setForm({ ...form, cadence: ev.target.value as RecurringExpenseCadence })}
                          style={{ width: '100%' }}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </StyledSelect></div>
          <div className="col-span-2"><FieldLabel>Label</FieldLabel>
            <input type="text" value={form.label} onChange={ev => setForm({ ...form, label: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div><FieldLabel>Amount ($)</FieldLabel>
            <input type="number" step="0.01" min="0" value={form.amount}
                   onChange={ev => setForm({ ...form, amount: ev.target.value })}
                   className={`${inputCls} tabular-nums`} style={inputStyle} /></div>
          <div><FieldLabel>Category tag</FieldLabel>
            <input type="text" value={form.kind} onChange={ev => setForm({ ...form, kind: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div><FieldLabel>Effective from</FieldLabel>
            <input type="date" value={form.effectiveFrom}
                   onChange={ev => setForm({ ...form, effectiveFrom: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div><FieldLabel>Effective to</FieldLabel>
            <input type="date" value={form.effectiveTo}
                   onChange={ev => setForm({ ...form, effectiveTo: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
          <div className="col-span-2"><FieldLabel>Notes</FieldLabel>
            <input type="text" value={form.notes} onChange={ev => setForm({ ...form, notes: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PanelButton onClick={() => void del()} disabled={busy} danger><Trash2 size={13} /> Delete</PanelButton>
            <PanelButton onClick={() => void end()} disabled={busy}><Square size={13} /> End today</PanelButton>
          </div>
          <PanelButton onClick={() => void save()} disabled={busy} primary><Check size={13} /> {busy ? 'Saving…' : 'Save'}</PanelButton>
        </div>
      </div>
    </>
  );
}

// ── payroll / mudflap read-only bodies ──────────────────────────────────

function PayrollBody({ row }: { row: LedgerRow }) {
  const p = row.payroll!;
  const router = useRouter();
  return (
    <>
      <AmountHeader amount={p.loadPay + p.adjustments} date={row.date} />
      <div className="px-5 pb-4">
        <div className="rounded-lg border px-4 py-2 mb-4" style={{ borderColor: 'var(--gc-border)' }}>
          <InfoRow label="Driver">{p.driverName}</InfoRow>
          <InfoRow label="Week">wk of {p.weekStart} (Sat–Fri)</InfoRow>
          <InfoRow label="Load pay"><span className="tabular-nums">{fmtMoney(p.loadPay)}</span> · {p.loadCount} load{p.loadCount === 1 ? '' : 's'}</InfoRow>
          <InfoRow label="Adjustments"><span className="tabular-nums">{fmtMoney(p.adjustments)}</span></InfoRow>
        </div>
        <PanelButton onClick={() => router.push('/payroll')}>
          <ExternalLink size={13} /> Open payroll for the load-level breakdown
        </PanelButton>
      </div>
    </>
  );
}

function MudflapBody({ row }: { row: LedgerRow }) {
  const m = row.mudflap!;
  const router = useRouter();
  return (
    <>
      <AmountHeader amount={row.amount} date={row.date} />
      <div className="px-5 pb-4">
        <div className="rounded-lg border px-4 py-2 mb-4" style={{ borderColor: 'var(--gc-border)' }}>
          <InfoRow label="Location">{m.location ?? '—'}</InfoRow>
          <InfoRow label="Driver">{m.driverName ?? '—'}</InfoRow>
          <InfoRow label="Diesel">{m.gallons != null ? `${m.gallons.toFixed(1)} gal` : '—'}</InfoRow>
        </div>
        <PanelButton onClick={() => router.push('/equipment?tab=fuel')}>
          <ExternalLink size={13} /> Open the Fuel tab for matching + receipts
        </PanelButton>
      </div>
    </>
  );
}

// ── create body ─────────────────────────────────────────────────────────

function CreateBody({ onMutated, onClose }: { onMutated: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<'one-time' | 'recurring'>('one-time');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    bucketId: '', kind: '', label: '', amount: '', notes: '',
    date: todayIso(),
    cadence: 'weekly' as RecurringExpenseCadence,
    effectiveFrom: todayIso(), effectiveTo: '',
  });

  const save = async () => {
    const amount = Number(form.amount);
    if (!form.bucketId) { alert('Pick a bucket.'); return; }
    if (!form.label.trim() || !isFinite(amount) || amount <= 0) { alert('Label and a positive amount are required.'); return; }
    setBusy(true);
    try {
      if (tab === 'one-time') {
        await railway.createExpenseEntry({
          bucketId: form.bucketId,
          kind:     form.kind.trim() || undefined,
          date:     form.date,
          amount,
          label:    form.label.trim(),
          notes:    form.notes.trim() || undefined,
        });
      } else {
        await railway.createRecurringExpense({
          bucketId: form.bucketId,
          kind:     form.kind.trim() || undefined,
          label:    form.label.trim(),
          amount,
          cadence:  form.cadence,
          effectiveFrom: form.effectiveFrom,
          effectiveTo:   form.effectiveTo || undefined,
          notes:    form.notes.trim() || undefined,
        });
      }
      invalidateBucketCache();
      onMutated(); onClose();
    } catch { alert('Failed to save.'); setBusy(false); }
  };

  const tabBtn = (t: 'one-time' | 'recurring', label: string) => (
    <button
      onClick={() => setTab(t)}
      className="px-3 py-1.5 text-xs font-semibold rounded-full"
      style={{
        background: tab === t ? '#1a73e8' : 'var(--gc-surface-2, #f3f4f6)',
        color:      tab === t ? '#fff' : 'var(--gc-text-2)',
      }}>
      {label}
    </button>
  );

  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-2 mb-4">
        {tabBtn('one-time', 'One-time')}
        {tabBtn('recurring', 'Recurring')}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><FieldLabel>Bucket</FieldLabel>
          <BucketSelect value={form.bucketId} onChange={id => setForm({ ...form, bucketId: id })}
                        includeUncategorized={false} style={{ width: '100%' }} /></div>
        {tab === 'one-time' ? (
          <div><FieldLabel>Date</FieldLabel>
            <input type="date" value={form.date} onChange={ev => setForm({ ...form, date: ev.target.value })}
                   className={inputCls} style={inputStyle} /></div>
        ) : (
          <div><FieldLabel>Cadence</FieldLabel>
            <StyledSelect value={form.cadence}
                          onChange={ev => setForm({ ...form, cadence: ev.target.value as RecurringExpenseCadence })}
                          style={{ width: '100%' }}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </StyledSelect></div>
        )}
        <div className="col-span-2"><FieldLabel>Label</FieldLabel>
          <input type="text" value={form.label} onChange={ev => setForm({ ...form, label: ev.target.value })}
                 placeholder={tab === 'one-time' ? 'Penske wire — Truck #0812' : 'Progressive — commercial auto'}
                 className={inputCls} style={inputStyle} /></div>
        <div><FieldLabel>Amount ($)</FieldLabel>
          <input type="number" step="0.01" min="0" value={form.amount}
                 onChange={ev => setForm({ ...form, amount: ev.target.value })}
                 className={`${inputCls} tabular-nums`} style={inputStyle} /></div>
        <div><FieldLabel>Category tag (optional)</FieldLabel>
          <input type="text" value={form.kind} onChange={ev => setForm({ ...form, kind: ev.target.value })}
                 className={inputCls} style={inputStyle} /></div>
        {tab === 'recurring' && (
          <>
            <div><FieldLabel>Effective from</FieldLabel>
              <input type="date" value={form.effectiveFrom}
                     onChange={ev => setForm({ ...form, effectiveFrom: ev.target.value })}
                     className={inputCls} style={inputStyle} /></div>
            <div><FieldLabel>Effective to (optional)</FieldLabel>
              <input type="date" value={form.effectiveTo}
                     onChange={ev => setForm({ ...form, effectiveTo: ev.target.value })}
                     className={inputCls} style={inputStyle} /></div>
          </>
        )}
        <div className="col-span-2"><FieldLabel>Notes (optional)</FieldLabel>
          <input type="text" value={form.notes} onChange={ev => setForm({ ...form, notes: ev.target.value })}
                 className={inputCls} style={inputStyle} /></div>
      </div>
      <div className="mt-4 flex justify-end">
        <PanelButton onClick={() => void save()} disabled={busy} primary>
          <Check size={13} /> {busy ? 'Saving…' : 'Save expense'}
        </PanelButton>
      </div>
    </div>
  );
}

// ── shell ───────────────────────────────────────────────────────────────

export default function ExpenseDetailPanel({ mode, assets, trailers, onClose, onMutated }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = useMemo(() => {
    if (mode.kind === 'create') return SOURCE_META.create;
    return SOURCE_META[mode.row.source] ?? SOURCE_META.entry;
  }, [mode]);

  if (!mounted) return null;

  const body = mode.kind === 'create'
    ? <CreateBody onMutated={onMutated} onClose={onClose} />
    : mode.row.source === 'ramp' && mode.row.ramp
    ? <RampBody tx={mode.row.ramp} assets={assets} trailers={trailers} onMutated={onMutated} />
    : mode.row.source === 'entry' && mode.row.entry
    ? <EntryBody row={mode.row} onMutated={onMutated} onClose={onClose} />
    : mode.row.source === 'recurring' && mode.row.recurring
    ? <RecurringBody row={mode.row} onMutated={onMutated} onClose={onClose} />
    : mode.row.source === 'payroll' && mode.row.payroll
    ? <PayrollBody row={mode.row} />
    : mode.row.source === 'mudflap' && mode.row.mudflap
    ? <MudflapBody row={mode.row} />
    : <div className="p-5 text-sm" style={{ color: 'var(--gc-text-3)' }}>No detail available.</div>;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', zIndex: 1000, padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden shrink-0"
        style={{
          width: 'min(94vw, 640px)',
          maxHeight: 'min(90vh, 860px)',
          background: 'var(--gc-surface)',
          boxShadow: 'var(--shadow-3, 0 20px 50px rgba(0,0,0,0.3))',
        }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 shrink-0"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{meta.title}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5"
                  style={{ color: 'var(--gc-text-2)' }} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{body}</div>
      </div>
    </div>,
    document.body,
  );
}
