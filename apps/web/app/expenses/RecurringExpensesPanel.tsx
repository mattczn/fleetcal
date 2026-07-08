'use client';

/**
 * Recurring rules CRUD.
 *
 * Each rule picks a bucket from the user-editable bucket tree +
 * writes a free-text "kind" tag for their own labeling.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Square, Trash2, X, Check } from 'lucide-react';
import { railway } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import BucketSelect, { invalidateBucketCache } from './BucketSelect';
import type {
  RecurringExpense, RecurringExpenseCadence, ExpenseBucketTreeNode,
} from '@fleetcal/types';

const fmtMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

const todayIso = () => new Date().toISOString().slice(0, 10);

interface DraftForm {
  bucketId: string;
  kind: string;
  label: string;
  amount: string;
  cadence: RecurringExpenseCadence;
  effectiveFrom: string;
  effectiveTo: string;
  notes: string;
}

const EMPTY_DRAFT: DraftForm = {
  bucketId: '',
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
    bucketId: rule.bucketId,
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
  const [tree, setTree]           = useState<ExpenseBucketTreeNode[]>([]);
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
      invalidateBucketCache();
      const [rulesRes, bucketsRes] = await Promise.all([
        railway.listRecurringExpenses({ includeEnded }),
        railway.listExpenseBuckets(),
      ]);
      setRules(rulesRes.recurringExpenses);
      setTree(bucketsRes.tree);
    } catch (e) {
      console.error('[recurring-expenses] load failed:', e);
      setErr('Failed to load recurring expenses.');
    } finally {
      setLoading(false);
    }
  }, [includeEnded]);
  useEffect(() => { void reload(); }, [reload]);

  const openNew  = () => {
    const firstBucket = tree[0]?.bucket.id ?? '';
    setEditingId('new');
    setDraft({ ...EMPTY_DRAFT, bucketId: firstBucket });
  };
  const openEdit = (rule: RecurringExpense) => {
    setEditingId(rule.id); setDraft(draftFrom(rule));
  };
  const cancel   = () => { setEditingId(null); setDraft(null); };

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.bucketId) { alert('Pick a bucket.'); return; }
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
          bucketId: draft.bucketId,
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
          bucketId: draft.bucketId,
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

  // Group by bucketId + preserve tree ordering.
  const byBucket = useMemo(() => {
    const g = new Map<string, RecurringExpense[]>();
    for (const r of rules) {
      const arr = g.get(r.bucketId) ?? [];
      arr.push(r);
      g.set(r.bucketId, arr);
    }
    return g;
  }, [rules]);

  const orderedBucketIds = useMemo(() => {
    const ids: string[] = [];
    for (const node of tree) {
      ids.push(node.bucket.id);
      for (const child of node.children) ids.push(child.id);
    }
    return ids;
  }, [tree]);

  const bucketNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const node of tree) {
      m.set(node.bucket.id, node.bucket.name);
      for (const child of node.children) m.set(child.id, `${node.bucket.name} → ${child.name}`);
    }
    return m;
  }, [tree]);

  return (
    <div className="max-w-4xl">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-[18px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            Recurring Expenses
          </h2>
          <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
            Rules that post the same amount on a fixed cadence. Feed the corresponding tile on the
            <a href="/expenses" style={{ textDecoration: 'underline' }}> Expenses dashboard</a>.
          </p>
        </div>
        <button
          onClick={openNew}
          disabled={tree.length === 0}
          className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
          style={{
            borderColor: 'var(--gc-border)', background: 'var(--gc-surface)',
            color: 'var(--gc-text-1)',
            cursor: tree.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          <Plus size={14} /> Add rule
        </button>
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs" style={{ color: 'var(--gc-text-3)' }}>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={includeEnded}
                 onChange={e => setIncludeEnded(e.target.checked)} />
          Show ended rules
        </label>
      </div>

      {err && (
        <div className="rounded-lg border p-4 mb-3 text-sm"
             style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>{err}</div>
      )}

      {tree.length === 0 && !loading && (
        <div className="rounded-lg border p-6 text-center mb-4"
             style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}>
          No buckets yet. <a href="/expenses/buckets" style={{ textDecoration: 'underline' }}>Create buckets</a> before adding recurring rules.
        </div>
      )}

      {editingId === 'new' && draft && (
        <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                    saving={saving} title="New rule" />
      )}

      {orderedBucketIds.map(bucketId => {
        const items = byBucket.get(bucketId) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={bucketId} className="mb-6">
            <div className="text-[11px] font-bold uppercase tracking-wider mb-2"
                 style={{ color: 'var(--gc-text-3)' }}>
              {bucketNameById.get(bucketId) ?? '(unknown bucket)'}
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
      {!loading && rules.length === 0 && !editingId && tree.length > 0 && (
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
          <BucketSelect
            value={draft.bucketId}
            onChange={id => setDraft({ ...draft, bucketId: id })}
            style={{ width: '100%' }}
          />
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
          <input type="text"
            value={draft.label}
            onChange={e => setDraft({ ...draft, label: e.target.value })}
            placeholder="Anna — office admin"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Category tag (optional)</label>
          <input type="text"
            value={draft.kind}
            onChange={e => setDraft({ ...draft, kind: e.target.value })}
            placeholder="admin_salary, yard_rent, cell_phone, whatever…"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Amount ($)</label>
          <input type="number" step="0.01" min="0"
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
          <input type="date"
            value={draft.effectiveFrom}
            onChange={e => setDraft({ ...draft, effectiveFrom: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Effective to (optional)</label>
          <input type="date"
            value={draft.effectiveTo}
            onChange={e => setDraft({ ...draft, effectiveTo: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Notes (optional)</label>
          <input type="text"
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
