'use client';

/**
 * CategoryEditorDialog — small overlay for managing the org's
 * truck-categories or trailer-categories list. Mounted inside the
 * Trucks and Trailers directory modals so dispatchers can edit the
 * filter/sort buckets without bouncing out to Settings.
 *
 * Mechanics mirror the assetCategories pattern in the Settings page:
 * add, rename (renames cascade through the truck rows that reference
 * the old name — done by the parent's onUpdate callback), remove,
 * drag-reorder. Renames for trailers are display-only (no cascade)
 * because the trailer category column accepts any string and the
 * store doesn't track which trailers used the old name centrally.
 */

import { useRef, useState } from 'react';
import { Check, GripVertical, Pencil, Plus, Trash2, X } from 'lucide-react';

interface Props {
  title:       string;
  /** Subtitle hint shown under the title — e.g. "Used for filtering trucks". */
  hint?:       string;
  items:       string[];
  onAdd:       (name: string) => void;
  onUpdate:    (oldName: string, newName: string) => void;
  onRemove:    (name: string) => void;
  onReorder:   (fromIdx: number, toIdx: number) => void;
  onClose:     () => void;
}

export default function CategoryEditorDialog({
  title, hint, items, onAdd, onUpdate, onRemove, onReorder, onClose,
}: Props) {
  const [newName, setNewName]   = useState('');
  const [editIdx, setEditIdx]   = useState<number | null>(null);
  const [editVal, setEditVal]   = useState('');
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx]   = useState<number | null>(null);

  const handleAdd = () => {
    const trimmed = newName.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onAdd(trimmed);
    setNewName('');
  };

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setEditVal(items[idx]);
  };

  const confirmEdit = () => {
    if (editIdx === null) return;
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== items[editIdx] && !items.includes(trimmed)) {
      onUpdate(items[editIdx], trimmed);
    }
    setEditIdx(null);
  };

  const cancelEdit = () => setEditIdx(null);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl flex flex-col"
        style={{
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border-light)',
          boxShadow: 'var(--shadow-3)',
          width: 460, maxHeight: '80%', overflow: 'hidden',
        }}>
        {/* Header */}
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <div className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>{title}</div>
            {hint && (
              <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--gc-text-3)' }}>{hint}</div>
            )}
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-full transition-colors flex-shrink-0"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto"
          style={{ borderTop: '1px solid var(--gc-border-light)', borderBottom: '1px solid var(--gc-border-light)' }}>
          {items.length === 0 && (
            <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
              No categories yet — add one below.
            </div>
          )}

          <div className="divide-y" style={{ borderColor: 'var(--gc-border-light)' }}>
            {items.map((cat, idx) => (
              <div
                key={cat}
                draggable
                onDragStart={() => { dragIdx.current = idx; }}
                onDragOver={e => { e.preventDefault(); if (dragIdx.current !== null && dragIdx.current !== idx) setOverIdx(idx); }}
                onDrop={() => { if (dragIdx.current !== null && dragIdx.current !== idx) onReorder(dragIdx.current, idx); dragIdx.current = null; setOverIdx(null); }}
                onDragEnd={() => { dragIdx.current = null; setOverIdx(null); }}
                className="flex items-center gap-3 px-5 py-3"
                style={{ background: overIdx === idx ? 'var(--gc-hover)' : 'transparent' }}
              >
                <GripVertical size={14} style={{ color: 'var(--gc-text-3)', cursor: 'grab', flexShrink: 0 }} />

                {editIdx === idx ? (
                  <input
                    autoFocus
                    value={editVal}
                    onChange={e => setEditVal(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                    className="flex-1 rounded-lg px-2.5 py-1 text-sm outline-none"
                    style={{ border: '1px solid var(--gc-blue)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
                  />
                ) : (
                  <span className="flex-1 text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{cat}</span>
                )}

                {editIdx === idx ? (
                  <div className="flex items-center gap-1">
                    <button onClick={confirmEdit} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-blue)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Check size={14} />
                    </button>
                    <button onClick={cancelEdit} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(idx)} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => onRemove(cat)} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = '#d93025'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Add new */}
        <div className="shrink-0 px-5 py-4 flex items-center gap-2"
          style={{ background: 'var(--gc-bg)' }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="New category name…"
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          />
          <button
            onClick={handleAdd}
            disabled={!newName.trim() || items.includes(newName.trim())}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-40"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={e => { if (newName.trim()) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
