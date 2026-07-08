'use client';

/**
 * /expenses/rules — CRUD for the Ramp category rules the sync uses to
 * auto-assign a bucket to each new card txn based on Ramp's own
 * sk_category_name.
 *
 * Rules match in ascending priority order (lower first). "Seed defaults"
 * inserts the FleetCal starter set at priority 100 so custom rules at
 * priority 10 win.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2, X, Check, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { railway } from '@/lib/railway';
import type { RampCategoryRule } from '@fleetcal/types';
import BucketSelect, { invalidateBucketCache } from '../BucketSelect';

interface DraftForm {
  pattern:  string;
  isRegex:  boolean;
  bucketId: string;
  priority: string;
  notes:    string;
}
const EMPTY_DRAFT: DraftForm = {
  pattern: '', isRegex: true, bucketId: '', priority: '100', notes: '',
};
function draftFrom(r: RampCategoryRule): DraftForm {
  return {
    pattern:  r.pattern,
    isRegex:  r.isRegex,
    bucketId: r.bucketId,
    priority: String(r.priority),
    notes:    r.notes ?? '',
  };
}

function RulesPageInner() {
  const router = useRouter();
  const [rules, setRules]         = useState<RampCategoryRule[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState<DraftForm | null>(null);
  const [saving, setSaving]       = useState(false);
  const [seedMsg, setSeedMsg]     = useState<string | null>(null);
  const [seedBusy, setSeedBusy]   = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await railway.listRampCategoryRules();
      setRules(r.rules);
    } catch (e) {
      console.error('[rules] load failed:', e);
      setErr('Failed to load rules.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const openNew  = () => { setEditingId('new'); setDraft({ ...EMPTY_DRAFT }); };
  const openEdit = (r: RampCategoryRule) => { setEditingId(r.id); setDraft(draftFrom(r)); };
  const cancel   = () => { setEditingId(null); setDraft(null); };

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.pattern.trim()) { alert('Pattern is required.'); return; }
    const priority = Number(draft.priority);
    if (!Number.isFinite(priority)) { alert('Priority must be a number.'); return; }
    setSaving(true);
    try {
      if (!draft.bucketId) { alert('Pick a bucket.'); return; }
      if (editingId === 'new') {
        await railway.createRampCategoryRule({
          pattern:  draft.pattern.trim(),
          isRegex:  draft.isRegex,
          bucketId: draft.bucketId,
          priority,
          notes:    draft.notes.trim() || undefined,
        });
      } else if (editingId) {
        await railway.updateRampCategoryRule(editingId, {
          pattern:  draft.pattern.trim(),
          isRegex:  draft.isRegex,
          bucketId: draft.bucketId,
          priority,
          notes:    draft.notes.trim() || null,
        });
      }
      setEditingId(null);
      setDraft(null);
      await reload();
    } catch (e) {
      alert('Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [draft, editingId, reload]);

  const deleteRule = useCallback(async (id: string) => {
    if (!confirm('Delete this rule?')) return;
    try { await railway.deleteRampCategoryRule(id); await reload(); }
    catch { alert('Failed to delete.'); }
  }, [reload]);

  const seed = useCallback(async () => {
    if (!confirm('Insert the FleetCal starter rules? Existing rules with the same pattern will be skipped.')) return;
    setSeedBusy(true);
    setSeedMsg(null);
    try {
      const r = await railway.seedRampCategoryDefaults();
      setSeedMsg(`Seeded ${r.seeded}, skipped ${r.skipped} (already existed).`);
      await reload();
    } catch (e) {
      setSeedMsg('Seed failed.');
    } finally {
      setSeedBusy(false);
    }
  }, [reload]);

  return (
    <AppShell>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-6" style={{ maxWidth: 1024 }}>
          <button
            onClick={() => router.push('/expenses')}
            className="text-xs font-semibold mb-4 inline-flex items-center gap-1.5"
            style={{ color: 'var(--gc-text-3)' }}>
            <ArrowLeft size={13} /> Back to expenses
          </button>

          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h1 className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                Ramp category rules
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Regex / substring patterns matched against Ramp's own <code>sk_category_name</code>
                on sync. First match wins, lowest priority first. Users always override
                the auto-assignment from the Card Spend board.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {seedMsg && (
                <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{seedMsg}</span>
              )}
              <button
                onClick={() => void seed()}
                disabled={seedBusy}
                className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
                title="Insert the FleetCal starter rules">
                <Sparkles size={13} /> {seedBusy ? 'Seeding…' : 'Seed defaults'}
              </button>
              <button
                onClick={openNew}
                className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{
                  borderColor: 'var(--gc-border)', background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)',
                }}>
                <Plus size={14} /> Add rule
              </button>
            </div>
          </div>

          {err && (
            <div className="rounded-lg border p-4 mb-4 text-sm"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>{err}</div>
          )}

          {editingId === 'new' && draft && (
            <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                        saving={saving} title="New rule" />
          )}

          <div className="rounded-lg border overflow-hidden"
               style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
            {rules.length === 0 && !loading && !editingId && (
              <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
                No rules yet. New Ramp txns will land in Uncategorized until you add rules
                (or click <em>Seed defaults</em> to install the FleetCal starter set).
              </div>
            )}
            {rules.map(rule => (
              <div key={rule.id}>
                {editingId === rule.id && draft ? (
                  <RuleEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancel}
                              saving={saving} title="Edit rule" />
                ) : (
                  <div className="px-4 py-3 border-b flex items-center gap-3 last:border-b-0"
                       style={{ borderColor: 'var(--gc-border)' }}>
                    <div className="text-xs tabular-nums font-semibold" style={{ color: 'var(--gc-text-3)', width: 42 }}>
                      #{rule.priority}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-mono truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {rule.pattern}
                        </code>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                              style={{ background: '#f3f4f6', color: '#6b7280' }}>
                          {rule.isRegex ? 'regex' : 'substring'}
                        </span>
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                        → {rule.bucketName ?? '(unknown bucket)'}
                        {rule.notes ? ` · ${rule.notes}` : ''}
                      </div>
                    </div>
                    <button onClick={() => openEdit(rule)}
                            className="p-1.5 rounded hover:bg-black/5"
                            style={{ color: 'var(--gc-text-2)' }} title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => deleteRule(rule.id)}
                            className="p-1.5 rounded hover:bg-red-50"
                            style={{ color: '#dc2626' }} title="Delete">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {loading && rules.length === 0 && (
              <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
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
           style={{ color: 'var(--gc-text-3)' }}>{title}</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Pattern</label>
          <input
            type="text" value={draft.pattern}
            onChange={e => setDraft({ ...draft, pattern: e.target.value })}
            placeholder={draft.isRegex ? '^(automotive|auto\\s+parts)' : 'auto parts'}
            className="w-full px-3 py-1.5 rounded border text-sm font-mono"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Match type</label>
          <StyledSelect
            value={draft.isRegex ? 'regex' : 'substring'}
            onChange={e => setDraft({ ...draft, isRegex: e.target.value === 'regex' })}
            style={{ width: '100%' }}>
            <option value="regex">Regex</option>
            <option value="substring">Substring (case-insensitive)</option>
          </StyledSelect>
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Priority (lower wins)</label>
          <input
            type="number" step="1"
            value={draft.priority}
            onChange={e => setDraft({ ...draft, priority: e.target.value })}
            className="w-full px-3 py-1.5 rounded border text-sm tabular-nums"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Assign to bucket</label>
          <BucketSelect
            value={draft.bucketId}
            onChange={id => setDraft({ ...draft, bucketId: id })}
            style={{ width: '100%' }}
          />
        </div>
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

export default function RulesPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <RulesPageInner />
    </RequireCap>
  );
}
