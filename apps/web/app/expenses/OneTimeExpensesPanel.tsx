'use client';

/**
 * One-off / ad-hoc expense entries. Sibling to RecurringExpensesPanel.
 *
 * These land in the dashboard's Payroll & People / Insurance & Claims /
 * Capex / Taxes / Owner Draws / Software & Overhead buckets depending
 * on kind. See routes/expenses.ts for the mapping.
 *
 * Default view: last 90 days, all kinds, newest first.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import type { ExpenseEntry, ExpenseEntryKind } from '@fleetcal/types';

const KIND_LABELS: Record<ExpenseEntryKind, string> = {
  owner_op_payout:    'Owner-op payout (Sophia/Luis)',
  claim_payout:       'Insurance claim payout',
  truck_purchase:     'Truck purchase (Capex)',
  equipment_purchase: 'Equipment purchase (Capex)',
  tax:                'Tax payment (IRP/IFTA/income/state)',
  owner_draw:         'Owner draw (Chase Sapphire / withdrawal)',
  subscription:       'Subscription (one-off)',
  misc:               'Misc',
};

const KIND_BUCKET: Record<ExpenseEntryKind, string> = {
  owner_op_payout:    'Payroll & People',
  claim_payout:       'Insurance & Claims',
  truck_purchase:     'Capex',
  equipment_purchase: 'Capex',
  tax:                'Taxes',
  owner_draw:         'Owner Draws',
  subscription:       'Software & Overhead',
  misc:               'Software & Overhead',
};

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

interface DraftForm {
  kind:   ExpenseEntryKind;
  date:   string;
  amount: string;
  label:  string;
  notes:  string;
}

const EMPTY_DRAFT: DraftForm = {
  kind: 'owner_op_payout',
  date: todayIso(),
  amount: '',
  label: '',
  notes: '',
};

function draftFrom(e: ExpenseEntry): DraftForm {
  return {
    kind: e.kind,
    date: e.date,
    amount: String(e.amount),
    label: e.label,
    notes: e.notes ?? '',
  };
}

export default function OneTimeExpensesPanel() {
  const [entries, setEntries]     = useState<ExpenseEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<DraftForm | null>(null);
  const [saving, setSaving]       = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | ExpenseEntryKind>('all');
  const [windowDays, setWindowDays] = useState<number>(90);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await railway.listExpenseEntries({
        from: daysAgoIso(windowDays),
        to:   todayIso(),
        kind: kindFilter === 'all' ? undefined : kindFilter,
        limit: 1000,
      });
      setEntries(r.expenseEntries);
    } catch (e) {
      console.error('[one-time] load failed:', e);
      setErr('Failed to load one-time expenses.');
    } finally {
      setLoading(false);
    }
  }, [kindFilter, windowDays]);
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
          kind:   draft.kind,
          date:   draft.date,
          amount,
          label:  draft.label.trim(),
          notes:  draft.notes.trim() || undefined,
        });
      } else if (editingId) {
        await railway.updateExpenseEntry(editingId, {
          kind:   draft.kind,
          date:   draft.date,
          amount,
          label:  draft.label.trim(),
          notes:  draft.notes.trim() || null,
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
    if (!confirm('Delete this entry? Historical dashboard windows already computed will not change; this entry stops contributing going forward.')) return;
    try {
      await railway.deleteExpenseEntry(id);
      await reload();
    } catch (e) {
      alert('Failed to delete.');
    }
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
            Variable-amount and one-off entries — Sophia/Luis weekly payouts, Penske wire transfers,
            claim payouts, tax payments, Jon/Mike owner draws from the Chase Sapphire card, etc.
            These land in the matching bucket on the <a href="/expenses" style={{ textDecoration: 'underline' }}>dashboard</a>.
          </p>
        </div>
        <button
          onClick={openNew}
          className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{
            borderColor: 'var(--gc-border)',
            background:  'var(--gc-surface)',
            color:       'var(--gc-text-1)',
          }}
        >
          <Plus size={14} /> Add entry
        </button>
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs">
        <label className="inline-flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
          Kind
          <StyledSelect
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value as 'all' | ExpenseEntryKind)}
            style={{ fontSize: 12 }}
          >
            <option value="all">All kinds</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </StyledSelect>
        </label>
        <label className="inline-flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
          Window
          <StyledSelect
            value={String(windowDays)}
            onChange={e => setWindowDays(Number(e.target.value))}
            style={{ fontSize: 12 }}
          >
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
             style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
          {err}
        </div>
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
                      {KIND_BUCKET[entry.kind]}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                    {KIND_LABELS[entry.kind]}
                    {entry.notes ? ` · ${entry.notes}` : ''}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                  {fmtMoney(entry.amount)}
                </div>
                <button
                  onClick={() => openEdit(entry)}
                  className="p-1.5 rounded hover:bg-black/5"
                  style={{ color: 'var(--gc-text-2)' }}
                  title="Edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => deleteEntry(entry.id)}
                  className="p-1.5 rounded hover:bg-red-50"
                  style={{ color: '#dc2626' }}
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
        {loading && entries.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            Loading…
          </div>
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
           style={{ color: 'var(--gc-text-3)' }}>
        {title}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Kind</label>
          <StyledSelect
            value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value as ExpenseEntryKind })}
            style={{ width: '100%' }}
          >
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </StyledSelect>
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Date</label>
          <input
            type="date"
            value={draft.date}
            onChange={e => setDraft({ ...draft, date: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
          />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Label</label>
          <input
            type="text"
            value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })}
            placeholder="Penske wire — Truck #0812"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
          />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Amount ($)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={draft.amount}
            onChange={e => setDraft({ ...draft, amount: e.target.value })}
            placeholder="45000.00"
            className="w-full px-3 py-1.5 rounded border text-sm tabular-nums"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
          />
        </div>
        <div />
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Notes (optional)</label>
          <input
            type="text"
            value={draft.notes}
            onChange={e => setDraft({ ...draft, notes: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
          />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
        >
          <X size={13} /> Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="text-xs font-semibold px-3 py-1.5 rounded inline-flex items-center gap-1.5"
          style={{ background: '#1a73e8', color: 'white', cursor: saving ? 'wait' : 'pointer' }}
        >
          <Check size={13} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
