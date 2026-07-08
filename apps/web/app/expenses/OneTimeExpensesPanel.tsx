'use client';

/**
 * One-off / ad-hoc entries. Each entry picks a bucket (fixed 8) + free-
 * text category tag. Feeds the matching tile on the dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import type { ExpenseEntry, ExpenseBucketKey } from '@fleetcal/types';
import {
  EXPENSE_BUCKET_KEYS, EXPENSE_BUCKET_LABELS,
  EXPENSE_ENTRY_KIND_SUGGESTIONS,
} from '@fleetcal/types';

const PRIMARY_BUCKETS = EXPENSE_BUCKET_KEYS;

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

interface DraftForm {
  bucketKey: ExpenseBucketKey;
  kind:      string;
  date:      string;
  amount:    string;
  label:     string;
  notes:     string;
}

const EMPTY_DRAFT: DraftForm = {
  bucketKey: 'payroll_people',
  kind: '',
  date: todayIso(),
  amount: '',
  label: '',
  notes: '',
};

function draftFrom(e: ExpenseEntry): DraftForm {
  return {
    bucketKey: e.bucketKey,
    kind:      e.kind ?? '',
    date:      e.date,
    amount:    String(e.amount),
    label:     e.label,
    notes:     e.notes ?? '',
  };
}

export default function OneTimeExpensesPanel() {
  const [entries, setEntries]     = useState<ExpenseEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<DraftForm | null>(null);
  const [saving, setSaving]       = useState(false);
  const [bucketFilter, setBucketFilter] = useState<'all' | ExpenseBucketKey>('all');
  const [windowDays, setWindowDays]     = useState<number>(90);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await railway.listExpenseEntries({
        from: daysAgoIso(windowDays),
        to:   todayIso(),
        bucketKey: bucketFilter === 'all' ? undefined : bucketFilter,
        limit: 1000,
      });
      setEntries(r.expenseEntries);
    } catch (e) {
      console.error('[one-time] load failed:', e);
      setErr('Failed to load one-time expenses.');
    } finally {
      setLoading(false);
    }
  }, [bucketFilter, windowDays]);
  useEffect(() => { void reload(); }, [reload]);

  const openNew  = () => { setEditingId('new'); setDraft({ ...EMPTY_DRAFT }); };
  const openEdit = (e: ExpenseEntry) => { setEditingId(e.id); setDraft(draftFrom(e)); };
  const cancel   = () => { setEditingId(null); setDraft(null); };

  const save = useCallback(async () => {
    if (!draft) return;
    const amount = Number(draft.amount);
    if (!draft.label.trim()) { alert('Label is required.'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('Amount must be greater than 0.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) { alert('Date must be valid.'); return; }
    setSaving(true);
    try {
      if (editingId === 'new') {
        await railway.createExpenseEntry({
          bucketKey: draft.bucketKey,
          kind:      draft.kind.trim() || undefined,
          date:      draft.date,
          amount,
          label:     draft.label.trim(),
          notes:     draft.notes.trim() || undefined,
        });
      } else if (editingId) {
        await railway.updateExpenseEntry(editingId, {
          bucketKey: draft.bucketKey,
          kind:      draft.kind.trim() || null,
          date:      draft.date,
          amount,
          label:     draft.label.trim(),
          notes:     draft.notes.trim() || null,
        });
      }
      setEditingId(null);
      setDraft(null);
      await reload();
    } catch (e) {
      console.error('[one-time] save failed:', e);
      alert('Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [draft, editingId, reload]);

  const deleteEntry = useCallback(async (id: string) => {
    if (!confirm('Delete this entry?')) return;
    try { await railway.deleteExpenseEntry(id); await reload(); }
    catch { alert('Failed to delete.'); }
  }, [reload]);

  const total = useMemo(
    () => entries.reduce((s, e) => s + e.amount, 0),
    [entries],
  );

  return (
    <div className="max-w-4xl">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-[18px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            One-time Expenses
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
            Variable-amount and one-off entries — owner-op weekly payouts, wire transfers for
            equipment, claim payouts, quarterly taxes, personal-biz card charges. Feed the matching
            tile on the <a href="/expenses" style={{ textDecoration: 'underline' }}>dashboard</a>.
          </p>
        </div>
        <button onClick={openNew}
                className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{
                  borderColor: 'var(--gc-border)',
                  background:  'var(--gc-surface)',
                  color:       'var(--gc-text-1)',
                }}>
          <Plus size={14} /> Add entry
        </button>
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs">
        <label className="inline-flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
          Bucket
          <StyledSelect
            value={bucketFilter}
            onChange={e => setBucketFilter(e.target.value as 'all' | ExpenseBucketKey)}
            style={{ fontSize: 12 }}>
            <option value="all">All buckets</option>
            {PRIMARY_BUCKETS.map(k => (
              <option key={k} value={k}>{EXPENSE_BUCKET_LABELS[k]}</option>
            ))}
          </StyledSelect>
        </label>
        <label className="inline-flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
          Window
          <StyledSelect
            value={String(windowDays)}
            onChange={e => setWindowDays(Number(e.target.value))}
            style={{ fontSize: 12 }}>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last year</option>
            <option value="3650">All time</option>
          </StyledSelect>
        </label>
        <span className="ml-auto tabular-nums" style={{ color: 'var(--gc-text-2)' }}>
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {fmtMoney(total)}
        </span>
      </div>

      {err && (
        <div className="rounded-lg border p-4 mb-3 text-sm"
             style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>{err}</div>
      )}

      {editingId === 'new' && draft && (
        <EntryEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                     saving={saving} title="New entry" />
      )}

      <div className="rounded-lg border overflow-hidden"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
        {entries.length === 0 && !loading && !editingId && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            No entries in this window.
          </div>
        )}
        {entries.map(entry => (
          <div key={entry.id}>
            {editingId === entry.id && draft ? (
              <EntryEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                           saving={saving} title="Edit entry" />
            ) : (
              <div className="px-4 py-3 border-b flex items-center gap-3 last:border-b-0"
                   style={{ borderColor: 'var(--gc-border)' }}>
                <div className="text-xs tabular-nums" style={{ color: 'var(--gc-text-3)', width: 88 }}>
                  {new Date(`${entry.date}T12:00:00Z`).toLocaleDateString([], {
                    month: 'short', day: 'numeric', year: 'numeric',
                  })}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>
                      {entry.label}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                          style={{ background: '#f3f4f6', color: '#6b7280' }}>
                      {EXPENSE_BUCKET_LABELS[entry.bucketKey]}
                    </span>
                    {entry.kind && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: '#eef2ff', color: '#4f46e5' }}>
                        {entry.kind}
                      </span>
                    )}
                  </div>
                  {entry.notes && (
                    <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{entry.notes}</div>
                  )}
                </div>
                <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(entry.amount)}
                </div>
                <button onClick={() => openEdit(entry)}
                        className="p-1.5 rounded hover:bg-black/5"
                        style={{ color: 'var(--gc-text-2)' }} title="Edit">
                  <Pencil size={14} />
                </button>
                <button onClick={() => deleteEntry(entry.id)}
                        className="p-1.5 rounded hover:bg-red-50"
                        style={{ color: '#dc2626' }} title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
        {loading && entries.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
        )}
      </div>
    </div>
  );
}

function EntryEditor({
  draft, setDraft, onSave, onCancel, saving, title,
}: {
  draft: DraftForm;
  setDraft: (d: DraftForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  title: string;
}) {
  return (
    <div className="rounded-lg border p-4 mb-4"
         style={{ borderColor: 'var(--gc-accent, #1a73e8)', background: 'var(--gc-surface)' }}>
      <div className="text-[11px] font-bold uppercase tracking-wider mb-3"
           style={{ color: 'var(--gc-text-3)' }}>{title}</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Bucket</label>
          <StyledSelect
            value={draft.bucketKey}
            onChange={e => setDraft({ ...draft, bucketKey: e.target.value as ExpenseBucketKey })}
            style={{ width: '100%' }}>
            {PRIMARY_BUCKETS.map(k => (
              <option key={k} value={k}>{EXPENSE_BUCKET_LABELS[k]}</option>
            ))}
          </StyledSelect>
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Date</label>
          <input
            type="date" value={draft.date}
            onChange={e => setDraft({ ...draft, date: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Label</label>
          <input
            type="text" value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })}
            placeholder="Penske wire — Truck #0812"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Category tag (optional)</label>
          <input
            type="text" list="one-time-kind-suggestions"
            value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value })}
            placeholder="owner_op_payout, truck_purchase, or anything…"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
          <datalist id="one-time-kind-suggestions">
            {EXPENSE_ENTRY_KIND_SUGGESTIONS.map(k => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Amount ($)</label>
          <input
            type="number" step="0.01" min="0"
            value={draft.amount}
            onChange={e => setDraft({ ...draft, amount: e.target.value })}
            placeholder="45000.00"
            className="w-full px-3 py-1.5 rounded border text-sm tabular-nums"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div />
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Notes (optional)</label>
          <input
            type="text" value={draft.notes}
            onChange={e => setDraft({ ...draft, notes: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button onClick={onCancel} disabled={saving}
                className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
          <X size={13} /> Cancel
        </button>
        <button onClick={onSave} disabled={saving}
                className="text-xs font-semibold px-3 py-1.5 rounded inline-flex items-center gap-1.5"
                style={{ background: '#1a73e8', color: 'white', cursor: saving ? 'wait' : 'pointer' }}>
          <Check size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
