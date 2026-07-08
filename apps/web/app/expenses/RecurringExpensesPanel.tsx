'use client';

/**
 * Recurring rules CRUD.
 *
 * Each rule picks a bucket (fixed 8) + writes a free-text "category"
 * tag for their own labeling. Rules are prorated into any dashboard
 * window at query time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Square, Trash2, X, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import type {
  RecurringExpense, RecurringExpenseCadence, ExpenseBucketKey,
} from '@fleetcal/types';
import {
  EXPENSE_BUCKET_KEYS, EXPENSE_BUCKET_LABELS,
  RECURRING_EXPENSE_KIND_SUGGESTIONS,
} from '@fleetcal/types';

const PRIMARY_BUCKETS = EXPENSE_BUCKET_KEYS;

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

const todayIso = () => new Date().toISOString().slice(0, 10);

interface DraftForm {
  bucketKey: ExpenseBucketKey;
  kind: string;
  label: string;
  amount: string;
  cadence: RecurringExpenseCadence;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

const EMPTY_DRAFT: DraftForm = {
  bucketKey: 'payroll_people',
  kind: '',
  label: '',
  amount: '',
  cadence: 'weekly',
  effectiveFrom: todayIso(),
  effectiveTo: '',
  notes: '',
};

function draftFrom(rule: RecurringExpense): DraftForm {
  return {
    bucketKey: rule.bucketKey,
    kind: rule.kind ?? '',
    label: rule.label,
    amount: String(rule.amount),
    cadence: rule.cadence,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo ?? '',
    notes: rule.notes ?? '',
  };
}

export default function RecurringExpensesPanel() {
  const [rules, setRules]         = useState<RecurringExpense[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<DraftForm | null>(null);
  const [saving, setSaving]       = useState(false);
  const [includeEnded, setIncludeEnded] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await railway.listRecurringExpenses({ includeEnded });
      setRules(r.recurringExpenses);
    } catch (e) {
      console.error('[recurring-expenses] load failed:', e);
      setErr('Failed to load recurring expenses.');
    } finally {
      setLoading(false);
    }
  }, [includeEnded]);
  useEffect(() => { void reload(); }, [reload]);

  const openNew  = () => { setEditingId('new'); setDraft({ ...EMPTY_DRAFT }); };
  const openEdit = (rule: RecurringExpense) => {
    setEditingId(rule.id); setDraft(draftFrom(rule));
  };
  const cancel   = () => { setEditingId(null); setDraft(null); };

  const save = useCallback(async () => {
    if (!draft) return;
    const amount = Number(draft.amount);
    if (!draft.label.trim()) { alert('Label is required.'); return; }
    if (!isFinite(amount) || amount <= 0) { alert('Amount must be greater than 0.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom)) {
      alert('Effective from must be a valid date.'); return;
    }
    if (draft.effectiveTo && !/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveTo)) {
      alert('Effective to must be a valid date or blank.'); return;
    }
    setSaving(true);
    try {
      if (editingId === 'new') {
        await railway.createRecurringExpense({
          bucketKey: draft.bucketKey,
          kind: draft.kind.trim() || undefined,
          label: draft.label.trim(),
          amount,
          cadence: draft.cadence,
          effectiveFrom: draft.effectiveFrom,
          effectiveTo: draft.effectiveTo || undefined,
          notes: draft.notes.trim() || undefined,
        });
      } else if (editingId) {
        await railway.updateRecurringExpense(editingId, {
          bucketKey: draft.bucketKey,
          kind: draft.kind.trim() || null,
          label: draft.label.trim(),
          amount,
          cadence: draft.cadence,
          effectiveFrom: draft.effectiveFrom,
          effectiveTo: draft.effectiveTo ? draft.effectiveTo : null,
          notes: draft.notes.trim() || null,
        });
      }
      setEditingId(null);
      setDraft(null);
      await reload();
    } catch (e) {
      console.error('[recurring-expenses] save failed:', e);
      alert('Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [draft, editingId, reload]);

  const endRule = useCallback(async (id: string) => {
    if (!confirm('End this recurring rule as of today?')) return;
    try { await railway.endRecurringExpense(id); await reload(); }
    catch { alert('Failed to end rule.'); }
  }, [reload]);

  const deleteRule = useCallback(async (id: string) => {
    if (!confirm('Permanently delete this recurring rule?')) return;
    try { await railway.deleteRecurringExpense(id); await reload(); }
    catch { alert('Failed to delete rule.'); }
  }, [reload]);

  const isActive = (r: RecurringExpense) =>
    !r.effectiveTo || r.effectiveTo >= todayIso();

  const byBucket = useMemo(() => {
    const groups = new Map<ExpenseBucketKey, RecurringExpense[]>();
    for (const r of rules) {
      const arr = groups.get(r.bucketKey) ?? [];
      arr.push(r);
      groups.set(r.bucketKey, arr);
    }
    return groups;
  }, [rules]);

  return (
    <div className="max-w-4xl">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-[18px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            Recurring Expenses
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
            Weekly salaries, monthly rent + insurance, subscriptions — anything that
            posts on a fixed cadence for a fixed amount. Feed the corresponding tile
            on the <a href="/expenses" style={{ textDecoration: 'underline' }}>Expenses dashboard</a>.
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
          <Plus size={14} /> Add rule
        </button>
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs" style={{ color: 'var(--gc-text-3)' }}>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={includeEnded}
            onChange={e => setIncludeEnded(e.target.checked)}
          />
          Show ended rules
        </label>
      </div>

      {err && (
        <div className="rounded-lg border p-4 mb-3 text-sm"
             style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
          {err}
        </div>
      )}

      {editingId === 'new' && draft && (
        <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                    saving={saving} title="New rule" />
      )}

      {PRIMARY_BUCKETS.map(bucketKey => {
        const items = byBucket.get(bucketKey) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={bucketKey} className="mb-6">
            <div className="text-[11px] font-bold uppercase tracking-wider mb-2"
                 style={{ color: 'var(--gc-text-3)' }}>
              {EXPENSE_BUCKET_LABELS[bucketKey]}
            </div>
            <div className="rounded-lg border overflow-hidden"
                 style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
              {items.map(rule => (
                <div key={rule.id}>
                  {editingId === rule.id && draft ? (
                    <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                                saving={saving} title="Edit rule" />
                  ) : (
                    <div className="px-4 py-3 border-b flex items-center gap-3 last:border-b-0"
                         style={{ borderColor: 'var(--gc-border)' }}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>
                            {rule.label}
                          </span>
                          {rule.kind && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                                  style={{ background: '#eef2ff', color: '#4f46e5' }}>
                              {rule.kind}
                            </span>
                          )}
                          {!isActive(rule) && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                                  style={{ background: '#f3f4f6', color: '#6b7280' }}>
                              Ended
                            </span>
                          )}
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                          {fmtMoney(rule.amount)} · {rule.cadence}
                          {' · '}{rule.effectiveFrom}
                          {rule.effectiveTo ? ` → ${rule.effectiveTo}` : ' → open'}
                          {rule.notes ? ` · ${rule.notes}` : ''}
                        </div>
                      </div>
                      <button onClick={() => openEdit(rule)}
                              className="p-1.5 rounded hover:bg-black/5"
                              style={{ color: 'var(--gc-text-2)' }} title="Edit">
                        <Pencil size={14} />
                      </button>
                      {isActive(rule) && (
                        <button onClick={() => endRule(rule.id)}
                                className="p-1.5 rounded hover:bg-black/5"
                                style={{ color: 'var(--gc-text-2)' }} title="End as of today">
                          <Square size={14} />
                        </button>
                      )}
                      <button onClick={() => deleteRule(rule.id)}
                              className="p-1.5 rounded hover:bg-red-50"
                              style={{ color: '#dc2626' }} title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {loading && rules.length === 0 && (
        <div className="text-sm py-6 text-center" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
      )}
      {!loading && rules.length === 0 && !editingId && (
        <div className="rounded-lg border p-8 text-center"
             style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)' }}>
          <div className="text-sm mb-3" style={{ color: 'var(--gc-text-2)' }}>No recurring rules yet.</div>
          <button onClick={openNew}
                  className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                  style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
            <Plus size={14} /> Add first rule
          </button>
        </div>
      )}
    </div>
  );
}

function RuleEditor({
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
                 style={{ color: 'var(--gc-text-3)' }}>Cadence</label>
          <StyledSelect
            value={draft.cadence}
            onChange={e => setDraft({ ...draft, cadence: e.target.value as RecurringExpenseCadence })}
            style={{ width: '100%' }}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </StyledSelect>
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Label</label>
          <input
            type="text"
            value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })}
            placeholder="Anna — office admin"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Category tag (optional)</label>
          <input
            type="text"
            list="recurring-kind-suggestions"
            value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value })}
            placeholder="payroll_admin, yard_rent, cell_phone, whatever…"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
          <datalist id="recurring-kind-suggestions">
            {RECURRING_EXPENSE_KIND_SUGGESTIONS.map(k => (
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
            placeholder="1500.00"
            className="w-full px-3 py-1.5 rounded border text-sm tabular-nums"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div />
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Effective from</label>
          <input
            type="date"
            value={draft.effectiveFrom}
            onChange={e => setDraft({ ...draft, effectiveFrom: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Effective to (optional)</label>
          <input
            type="date"
            value={draft.effectiveTo}
            onChange={e => setDraft({ ...draft, effectiveTo: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Notes (optional)</label>
          <input
            type="text"
            value={draft.notes}
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
