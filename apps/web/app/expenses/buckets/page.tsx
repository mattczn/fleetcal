'use client';

/**
 * /expenses/buckets — user-editable bucket tree.
 *
 * Two levels: top-level buckets are dashboard tiles; sub-buckets show
 * up in the drill-in view. Rename, reorder, delete freely.
 *
 * System roles: two special assignments — "driver_pay" (receives live
 * driver pay + payroll_adjustments) and "mudflap_fuel" (receives
 * fuel_transactions). Assign one bucket per role in the editor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Plus, Pencil, Trash2, X, Check,
  ChevronUp, ChevronDown, CornerDownRight, Zap,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { railway } from '@/lib/railway';
import type {
  ExpenseBucket, ExpenseBucketTreeNode, ExpenseBucketSystemRole,
} from '@fleetcal/types';
import { EXPENSE_BUCKET_SYSTEM_ROLES } from '@fleetcal/types';
import { invalidateBucketCache } from '../BucketSelect';

interface DraftForm {
  name:       string;
  icon:       string;
  color:      string;
  systemRole: '' | ExpenseBucketSystemRole;
}
const EMPTY_DRAFT: DraftForm = { name: '', icon: '', color: '', systemRole: '' };

function draftFromBucket(b: ExpenseBucket): DraftForm {
  return {
    name: b.name,
    icon: b.icon ?? '',
    color: b.color ?? '',
    systemRole: b.systemRole ?? '',
  };
}

const SYSTEM_ROLE_LABELS: Record<ExpenseBucketSystemRole, string> = {
  driver_pay:   'Receives driver pay + payroll adjustments',
  mudflap_fuel: 'Receives Mudflap fuel transactions',
};

function BucketsPageInner() {
  const router = useRouter();
  const [tree, setTree]           = useState<ExpenseBucketTreeNode[]>([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);

  // Edit dialog state
  const [editingId, setEditingId] = useState<string | 'new-top' | null>(null);
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null);
  const [draft, setDraft]         = useState<DraftForm | null>(null);

  // Delete confirmation state (server may return blocked references)
  const [deleteFor, setDeleteFor] = useState<{
    id: string;
    name: string;
    references?: {
      recurring: number; entries: number; rampTxns: number; rampRules: number;
      subBuckets: number; systemRole: string | null;
    };
    detail?: string;
  } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      invalidateBucketCache();
      const r = await railway.listExpenseBuckets();
      setTree(r.tree);
    } catch (e) {
      console.error('[buckets] load failed:', e);
      setErr('Failed to load buckets.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const openNewTop      = () => { setEditingId('new-top'); setAddingChildTo(null); setDraft({ ...EMPTY_DRAFT }); };
  const openNewChild    = (parentId: string) => { setEditingId('new-top'); setAddingChildTo(parentId); setDraft({ ...EMPTY_DRAFT }); };
  const openEdit        = (b: ExpenseBucket) => { setEditingId(b.id); setAddingChildTo(null); setDraft(draftFromBucket(b)); };
  const cancelEdit      = () => { setEditingId(null); setAddingChildTo(null); setDraft(null); };

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.name.trim()) { alert('Name is required.'); return; }
    setSaving(true);
    try {
      if (editingId === 'new-top') {
        await railway.createExpenseBucket({
          name:           draft.name.trim(),
          parentBucketId: addingChildTo ?? undefined,
          icon:           draft.icon.trim() || undefined,
          color:          draft.color.trim() || undefined,
          systemRole:     draft.systemRole || undefined,
        });
      } else if (editingId) {
        await railway.updateExpenseBucket(editingId, {
          name:       draft.name.trim(),
          icon:       draft.icon.trim() || null,
          color:      draft.color.trim() || null,
          systemRole: draft.systemRole || null,
        });
      }
      cancelEdit();
      await reload();
    } catch (e) {
      const detail = (e as { detail?: string })?.detail ?? (e as Error).message;
      alert(`Failed to save: ${detail}`);
    } finally {
      setSaving(false);
    }
  }, [draft, editingId, addingChildTo, reload]);

  const askDelete = useCallback(async (id: string, name: string) => {
    try {
      await railway.deleteExpenseBucket(id);
      await reload();
    } catch (e) {
      const err = e as { status?: number; detail?: unknown; message?: string };
      if (err.status === 409 && typeof err.detail === 'object' && err.detail !== null) {
        const d = err.detail as {
          error: string; detail: string;
          references: { recurring: number; entries: number; rampTxns: number; rampRules: number; subBuckets: number; systemRole: string | null };
        };
        setDeleteFor({ id, name, references: d.references, detail: d.detail });
      } else {
        alert(`Failed to delete: ${err.message ?? 'unknown'}`);
      }
    }
  }, [reload]);

  const move = useCallback(async (siblings: string[], id: string, direction: 'up' | 'down', parentBucketId: string | null) => {
    const idx = siblings.indexOf(id);
    if (idx < 0) return;
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= siblings.length) return;
    const next = [...siblings];
    [next[idx], next[swap]] = [next[swap], next[idx]];
    try {
      await railway.reorderExpenseBuckets({ parentBucketId, orderedIds: next });
      await reload();
    } catch (e) {
      alert('Failed to reorder.');
    }
  }, [reload]);

  const topLevelIds = useMemo(() => tree.map(n => n.bucket.id), [tree]);

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
                Buckets
              </h1>
              <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Top-level buckets are dashboard tiles. Sub-buckets show up in the
                drill-in view and roll up into their parent's total.
              </p>
            </div>
            <button
              onClick={openNewTop}
              className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
              style={{
                borderColor: 'var(--gc-border)', background: 'var(--gc-surface)',
                color: 'var(--gc-text-1)',
              }}>
              <Plus size={14} /> Add bucket
            </button>
          </div>

          {err && (
            <div className="rounded-lg border p-4 mb-4 text-sm"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>{err}</div>
          )}

          {editingId === 'new-top' && draft && !addingChildTo && (
            <BucketEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancelEdit}
                          saving={saving} title="New top-level bucket" allowSystemRole />
          )}

          <div className="rounded-lg border overflow-hidden"
               style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
            {tree.map((node, i) => {
              const siblingIds = topLevelIds;
              return (
                <div key={node.bucket.id}>
                  {editingId === node.bucket.id && draft ? (
                    <div className="p-2">
                      <BucketEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancelEdit}
                                    saving={saving} title="Edit bucket" allowSystemRole />
                    </div>
                  ) : (
                    <BucketRow
                      bucket={node.bucket}
                      onEdit={() => openEdit(node.bucket)}
                      onDelete={() => askDelete(node.bucket.id, node.bucket.name)}
                      onAddChild={() => openNewChild(node.bucket.id)}
                      onMoveUp={i > 0 ? () => move(siblingIds, node.bucket.id, 'up', null) : undefined}
                      onMoveDown={i < tree.length - 1 ? () => move(siblingIds, node.bucket.id, 'down', null) : undefined}
                    />
                  )}
                  {node.children.length > 0 && (
                    <div style={{ background: 'var(--gc-surface-2, #f9fafb)' }}>
                      {node.children.map((child, j) => (
                        <div key={child.id}>
                          {editingId === child.id && draft ? (
                            <div className="p-2">
                              <BucketEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancelEdit}
                                            saving={saving} title="Edit sub-bucket" />
                            </div>
                          ) : (
                            <BucketRow
                              bucket={child}
                              indent
                              onEdit={() => openEdit(child)}
                              onDelete={() => askDelete(child.id, child.name)}
                              onMoveUp={j > 0 ? () => move(node.children.map(c => c.id), child.id, 'up', node.bucket.id) : undefined}
                              onMoveDown={j < node.children.length - 1 ? () => move(node.children.map(c => c.id), child.id, 'down', node.bucket.id) : undefined}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {addingChildTo === node.bucket.id && draft && (
                    <div className="p-2" style={{ background: 'var(--gc-surface-2, #f9fafb)' }}>
                      <BucketEditor draft={draft} setDraft={setDraft} onSave={save} onCancel={cancelEdit}
                                    saving={saving} title={`New sub-bucket under ${node.bucket.name}`} />
                    </div>
                  )}
                </div>
              );
            })}
            {tree.length === 0 && !loading && (
              <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
                No buckets yet. Click <em>Add bucket</em> to create your first one.
              </div>
            )}
            {loading && tree.length === 0 && (
              <div className="p-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
            )}
          </div>
        </div>
      </div>

      {deleteFor && (
        <DeleteBlockedDialog
          bucketName={deleteFor.name}
          references={deleteFor.references}
          detail={deleteFor.detail}
          onClose={() => setDeleteFor(null)}
        />
      )}
    </AppShell>
  );
}

function BucketRow({
  bucket, indent = false, onEdit, onDelete, onAddChild, onMoveUp, onMoveDown,
}: {
  bucket: ExpenseBucket;
  indent?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddChild?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  return (
    <div className="px-4 py-3 border-b flex items-center gap-3 last:border-b-0"
         style={{ borderColor: 'var(--gc-border)', paddingLeft: indent ? 44 : 16 }}>
      {indent && <CornerDownRight size={14} style={{ color: 'var(--gc-text-3)' }} />}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>
            {bucket.name}
          </span>
          {bucket.icon && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{ background: '#f3f4f6', color: '#6b7280' }}>
              {bucket.icon}
            </span>
          )}
          {bucket.systemRole && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                  style={{ background: '#fef3c7', color: '#92400e' }}>
              <Zap size={10} /> {bucket.systemRole}
            </span>
          )}
        </div>
      </div>
      {onMoveUp && (
        <button onClick={onMoveUp} className="p-1 rounded hover:bg-black/5"
                style={{ color: 'var(--gc-text-3)' }} title="Move up">
          <ChevronUp size={14} />
        </button>
      )}
      {onMoveDown && (
        <button onClick={onMoveDown} className="p-1 rounded hover:bg-black/5"
                style={{ color: 'var(--gc-text-3)' }} title="Move down">
          <ChevronDown size={14} />
        </button>
      )}
      {onAddChild && (
        <button onClick={onAddChild} className="p-1.5 rounded hover:bg-black/5"
                style={{ color: 'var(--gc-text-2)' }} title="Add sub-bucket">
          <Plus size={14} />
        </button>
      )}
      <button onClick={onEdit} className="p-1.5 rounded hover:bg-black/5"
              style={{ color: 'var(--gc-text-2)' }} title="Edit">
        <Pencil size={14} />
      </button>
      <button onClick={onDelete} className="p-1.5 rounded hover:bg-red-50"
              style={{ color: '#dc2626' }} title="Delete">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function BucketEditor({
  draft, setDraft, onSave, onCancel, saving, title, allowSystemRole = false,
}: {
  draft: DraftForm;
  setDraft: (d: DraftForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  title: string;
  allowSystemRole?: boolean;
}) {
  return (
    <div className="rounded-lg border p-4 mb-4"
         style={{ borderColor: 'var(--gc-accent, #1a73e8)', background: 'var(--gc-surface)' }}>
      <div className="text-[11px] font-bold uppercase tracking-wider mb-3"
           style={{ color: 'var(--gc-text-3)' }}>{title}</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Name</label>
          <input
            type="text" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="Payroll & People"
            className="w-full px-3 py-1.5 rounded border text-sm"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Icon (lucide name)</label>
          <input
            type="text" value={draft.icon}
            onChange={e => setDraft({ ...draft, icon: e.target.value })}
            placeholder="Users"
            className="w-full px-3 py-1.5 rounded border text-sm font-mono"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                 style={{ color: 'var(--gc-text-3)' }}>Color (optional)</label>
          <input
            type="text" value={draft.color}
            onChange={e => setDraft({ ...draft, color: e.target.value })}
            placeholder="#1a73e8"
            className="w-full px-3 py-1.5 rounded border text-sm font-mono"
            style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }} />
        </div>
        {allowSystemRole && (
          <div className="col-span-2">
            <label className="text-[11px] font-bold uppercase tracking-wider block mb-1"
                   style={{ color: 'var(--gc-text-3)' }}>System role (optional)</label>
            <StyledSelect
              value={draft.systemRole}
              onChange={e => setDraft({ ...draft, systemRole: e.target.value as '' | ExpenseBucketSystemRole })}
              style={{ width: '100%' }}>
              <option value="">— none —</option>
              {EXPENSE_BUCKET_SYSTEM_ROLES.map(r => (
                <option key={r} value={r}>{SYSTEM_ROLE_LABELS[r]}</option>
              ))}
            </StyledSelect>
            <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
              Only one bucket per org can hold each role. Assigning here moves it off any other bucket that had it.
            </div>
          </div>
        )}
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

function DeleteBlockedDialog({
  bucketName, references, detail, onClose,
}: {
  bucketName: string;
  references?: { recurring: number; entries: number; rampTxns: number; rampRules: number; subBuckets: number; systemRole: string | null };
  detail?: string;
  onClose: () => void;
}) {
  const parts: string[] = [];
  if (references) {
    if (references.recurring)  parts.push(`${references.recurring} recurring rule${references.recurring === 1 ? '' : 's'}`);
    if (references.entries)    parts.push(`${references.entries} one-time entr${references.entries === 1 ? 'y' : 'ies'}`);
    if (references.rampTxns)   parts.push(`${references.rampTxns} card txn${references.rampTxns === 1 ? '' : 's'}`);
    if (references.rampRules)  parts.push(`${references.rampRules} auto-mapping rule${references.rampRules === 1 ? '' : 's'}`);
    if (references.subBuckets) parts.push(`${references.subBuckets} sub-bucket${references.subBuckets === 1 ? '' : 's'}`);
    if (references.systemRole) parts.push(`system role "${references.systemRole}"`);
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
         style={{ background: 'rgba(0,0,0,0.4)' }}
         onClick={onClose}>
      <div className="max-w-md w-full rounded-lg border p-5"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}
           onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--gc-text-1)' }}>
          Can't delete "{bucketName}" yet
        </h3>
        <p className="text-sm mb-3" style={{ color: 'var(--gc-text-2)' }}>
          {detail ?? `Move ${parts.join(', ')} to another bucket first.`}
        </p>
        {parts.length > 0 && (
          <ul className="text-xs mb-4 space-y-1" style={{ color: 'var(--gc-text-3)' }}>
            {parts.map(p => <li key={p}>• {p}</li>)}
          </ul>
        )}
        <div className="flex justify-end">
          <button onClick={onClose}
                  className="text-xs font-semibold px-3 py-1.5 rounded border"
                  style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BucketsPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <BucketsPageInner />
    </RequireCap>
  );
}
