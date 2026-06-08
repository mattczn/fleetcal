'use client';

/**
 * DispatchersModal — directory body for the "Dispatchers" tab in the
 * Manage Assets directory (alongside Drivers, Trucks, Trailers,
 * Customers, Locations).
 *
 * Pattern: list on the left, detail panel on the right. Auto-saves
 * fields on blur (matches DriversModal mode — the DirectoryDetailHandle
 * the shell expects becomes a no-op since there's no staged dirty
 * state to gate).
 *
 * Each dispatcher has:
 *   - first_name, last_name   (required)
 *   - hire_date               (optional, YYYY-MM-DD)
 *   - clerk_user_id           (optional link to a Clerk org member —
 *                              dropdown is populated from useOrganization()
 *                              memberships when available, falls back to
 *                              a plain text input otherwise)
 *   - is_default              (boolean — at most one per org)
 *   - active                  (soft-delete flag; deactivating preserves
 *                              the row so historical loads.dispatcher_id
 *                              references still resolve)
 */

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Plus, Trash2, Star, UserCheck, UserX, Loader2, X, Check } from 'lucide-react';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { Dispatcher } from '@/lib/types';
import type { DirectoryDetailHandle } from './DirectoryModal';

interface DispatchersModalProps {
  onClose: () => void;
  initialDispatcherId?: number;
  /** Render only the body when mounted inside DirectoryModal. */
  embedded?: boolean;
}

const DispatchersModal = forwardRef<DirectoryDetailHandle, DispatchersModalProps>(
function DispatchersModal({ onClose, initialDispatcherId, embedded }, modalRef) {
  // Auto-save on blur → no dirty-state gating needed. Mirrors the
  // DriversModal pattern so the DirectoryModal shell's unsaved-changes
  // dialog can never trigger from this tab.
  useImperativeHandle(modalRef, () => ({
    isDirty: () => false,
    save:    () => Promise.resolve(),
    discard: () => {},
  }), []);

  const { dispatchers, addDispatcher, updateDispatcher, removeDispatcher } = useCalendarStore();

  // Sort: active first, then by last name. Soft-deleted rows surface
  // at the bottom (with an Inactive pill) so historical attribution
  // is browsable but not in the way.
  const sortedDispatchers = [...dispatchers].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const ln = a.lastName.localeCompare(b.lastName);
    return ln !== 0 ? ln : a.firstName.localeCompare(b.firstName);
  });

  const [selectedId, setSelectedId] = useState<number | null>(
    initialDispatcherId ?? sortedDispatchers[0]?.id ?? null
  );

  // Once dispatchers load (or change), pick the first if nothing's selected.
  useEffect(() => {
    if (selectedId == null && sortedDispatchers.length > 0) {
      setSelectedId(sortedDispatchers[0].id);
    }
  }, [sortedDispatchers, selectedId]);

  const [adding, setAdding] = useState(false);

  async function handleAdd(firstName: string, lastName: string) {
    if (!firstName.trim() || !lastName.trim()) return;
    const created = await addDispatcher({
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
    });
    if (created) {
      setSelectedId(created.id);
      setAdding(false);
    }
  }

  const selected = sortedDispatchers.find(d => d.id === selectedId) ?? null;

  return (
    <div className="flex flex-1 min-h-0">
      {/* ── Left rail — list ─────────────────────────────────────── */}
      <div className="shrink-0 flex flex-col"
        style={{ width: 280, borderRight: '1px solid var(--gc-border-light)' }}>
        <div className="shrink-0 p-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <button
            onClick={() => setAdding(true)}
            disabled={adding}
            className="flex items-center justify-center gap-1.5 w-full text-[13px] font-semibold py-2 rounded-lg transition-colors"
            style={{
              background:  adding ? 'var(--gc-hover)' : 'var(--gc-blue)',
              color:       adding ? 'var(--gc-text-3)' : '#ffffff',
              border:      'none',
              cursor:      adding ? 'default' : 'pointer',
              opacity:     adding ? 0.5 : 1,
            }}>
            <Plus size={14} />
            Add dispatcher
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {adding && (
            <AddDispatcherRow
              onSave={handleAdd}
              onCancel={() => setAdding(false)} />
          )}
          {sortedDispatchers.length === 0 && !adding && (
            <div className="p-6 text-[12.5px] text-center" style={{ color: 'var(--gc-text-3)' }}>
              No dispatchers yet. Add one to get started.
            </div>
          )}
          {sortedDispatchers.map(d => {
            const active = d.id === selectedId;
            return (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className="flex items-center justify-between w-full px-3 py-2 text-left transition-colors"
                style={{
                  background: active ? 'var(--gc-hover)' : 'transparent',
                  borderLeft: `3px solid ${active ? 'var(--gc-blue)' : 'transparent'}`,
                  borderBottom: '1px solid var(--gc-border-light)',
                  cursor: 'pointer',
                }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate"
                    style={{ color: d.active ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                    {d.firstName} {d.lastName}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    {d.isDefault && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: '#dbeafe', color: '#1d4ed8' }}>
                        <Star size={9} fill="currentColor" /> DEFAULT
                      </span>
                    )}
                    {!d.active && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: '#f1f3f4', color: '#5f6368' }}>
                        INACTIVE
                      </span>
                    )}
                    {d.clerkUserId && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"
                        style={{ background: '#e6f4ea', color: '#137333' }}
                        title="Linked to a Clerk org member">
                        <UserCheck size={9} /> CLERK
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right pane — detail ──────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <DispatcherDetail
            key={selected.id}
            dispatcher={selected}
            onUpdate={(updates) => updateDispatcher(selected.id, updates)}
            onRemove={() => removeDispatcher(selected.id)} />
        ) : (
          <div className="h-full flex items-center justify-center text-[13px]"
            style={{ color: 'var(--gc-text-3)' }}>
            Select a dispatcher to view details, or add one to get started.
          </div>
        )}
      </div>

      {/* In standalone (non-embedded) mode, render a Close button.
          In embedded mode, the DirectoryModal shell owns the close. */}
      {!embedded && (
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-full"
          style={{ color: 'var(--gc-text-2)' }}>
          <X size={16} />
        </button>
      )}
    </div>
  );
});

DispatchersModal.displayName = 'DispatchersModal';
export default DispatchersModal;

// ─── Add row ─────────────────────────────────────────────────────

function AddDispatcherRow({ onSave, onCancel }: {
  onSave:   (firstName: string, lastName: string) => void;
  onCancel: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const canSave = firstName.trim() && lastName.trim();
  return (
    <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
      <input
        autoFocus
        placeholder="First name"
        value={firstName}
        onChange={e => setFirstName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSave) onSave(firstName, lastName); if (e.key === 'Escape') onCancel(); }}
        style={ROW_INPUT} />
      <input
        placeholder="Last name"
        value={lastName}
        onChange={e => setLastName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSave) onSave(firstName, lastName); if (e.key === 'Escape') onCancel(); }}
        style={ROW_INPUT} />
      <div className="flex gap-2">
        <button
          onClick={() => onSave(firstName, lastName)}
          disabled={!canSave}
          className="flex items-center gap-1 text-[12px] font-bold px-2.5 py-1.5 rounded-lg"
          style={{
            background: canSave ? 'var(--gc-blue)' : 'var(--gc-hover)',
            color:      canSave ? '#fff' : 'var(--gc-text-3)',
            border:     'none',
            cursor:     canSave ? 'pointer' : 'default',
          }}>
          <Check size={12} /> Add
        </button>
        <button
          onClick={onCancel}
          className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg"
          style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Detail panel ────────────────────────────────────────────────

interface ClerkMemberOption {
  userId: string;
  label:  string;
}

function DispatcherDetail({ dispatcher, onUpdate, onRemove }: {
  dispatcher: Dispatcher;
  onUpdate:   (updates: { firstName?: string; lastName?: string; hireDate?: string | null; clerkUserId?: string | null; isDefault?: boolean; active?: boolean }) => Promise<void>;
  onRemove:   () => Promise<void>;
}) {
  // Local copies so the inputs stay responsive between blurs.
  const [firstName, setFirstName] = useState(dispatcher.firstName);
  const [lastName,  setLastName]  = useState(dispatcher.lastName);
  const [hireDate,  setHireDate]  = useState(dispatcher.hireDate ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lastSavedRef = useRef({
    firstName: dispatcher.firstName,
    lastName:  dispatcher.lastName,
    hireDate:  dispatcher.hireDate ?? '',
  });

  // Reset local state when switching dispatchers (key prop in parent
  // already remounts, but defense in depth).
  useEffect(() => {
    setFirstName(dispatcher.firstName);
    setLastName(dispatcher.lastName);
    setHireDate(dispatcher.hireDate ?? '');
    lastSavedRef.current = {
      firstName: dispatcher.firstName,
      lastName:  dispatcher.lastName,
      hireDate:  dispatcher.hireDate ?? '',
    };
  }, [dispatcher.id, dispatcher.firstName, dispatcher.lastName, dispatcher.hireDate]);

  // ── Clerk members for the link picker ────────────────────────
  // Loads asynchronously; falls back to a text input if Clerk isn't
  // initialized (e.g. preview environments) or the call fails.
  const { organization } = useOrganization();
  const [members, setMembers] = useState<ClerkMemberOption[] | null>(null);
  useEffect(() => {
    if (!organization) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await organization.getMemberships({ pageSize: 100 });
        if (cancelled) return;
        const opts: ClerkMemberOption[] = page.data.map(m => {
          const u = m.publicUserData;
          const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();
          const email = u?.identifier ?? '';
          return {
            userId: u?.userId ?? '',
            label:  name ? `${name}${email ? ` (${email})` : ''}` : email || u?.userId || 'Unknown',
          };
        }).filter(m => m.userId);
        setMembers(opts);
      } catch (err) {
        console.warn('[DispatchersModal] Clerk member list failed:', err);
        if (!cancelled) setMembers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [organization]);

  // ── Field-blur auto-save ─────────────────────────────────────
  function saveNameIfChanged() {
    const updates: { firstName?: string; lastName?: string } = {};
    const trimmedFirst = firstName.trim();
    const trimmedLast  = lastName.trim();
    if (trimmedFirst && trimmedFirst !== lastSavedRef.current.firstName) updates.firstName = trimmedFirst;
    if (trimmedLast  && trimmedLast  !== lastSavedRef.current.lastName)  updates.lastName  = trimmedLast;
    if (Object.keys(updates).length === 0) return;
    void onUpdate(updates);
    lastSavedRef.current = { ...lastSavedRef.current, ...updates };
  }
  function saveHireDateIfChanged() {
    const v = hireDate || null;
    if (v === (lastSavedRef.current.hireDate || null)) return;
    void onUpdate({ hireDate: v });
    lastSavedRef.current.hireDate = v ?? '';
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Header — current name + status pills */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[20px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
            {dispatcher.firstName} {dispatcher.lastName}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            {dispatcher.isDefault && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded"
                style={{ background: '#dbeafe', color: '#1d4ed8' }}>
                <Star size={10} fill="currentColor" /> DEFAULT
              </span>
            )}
            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded"
              style={{
                background: dispatcher.active ? '#e6f4ea' : '#f1f3f4',
                color:      dispatcher.active ? '#137333' : '#5f6368',
              }}>
              {dispatcher.active ? <UserCheck size={10} /> : <UserX size={10} />}
              {dispatcher.active ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Fields ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input
            type="text"
            value={firstName}
            onChange={e => setFirstName(e.target.value)}
            onBlur={saveNameIfChanged}
            style={INPUT_STYLE} />
        </Field>
        <Field label="Last name">
          <input
            type="text"
            value={lastName}
            onChange={e => setLastName(e.target.value)}
            onBlur={saveNameIfChanged}
            style={INPUT_STYLE} />
        </Field>
        <Field label="Hire date (optional)">
          <input
            type="date"
            value={hireDate}
            onChange={e => setHireDate(e.target.value)}
            onBlur={saveHireDateIfChanged}
            style={INPUT_STYLE} />
        </Field>
        <Field label="Linked Clerk user (optional)">
          {members === null ? (
            <div className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={12} className="animate-spin" /> Loading members…
            </div>
          ) : members.length === 0 ? (
            <input
              type="text"
              value={dispatcher.clerkUserId ?? ''}
              placeholder="user_..."
              onChange={e => { void onUpdate({ clerkUserId: e.target.value.trim() || null }); }}
              style={INPUT_STYLE} />
          ) : (
            <select
              value={dispatcher.clerkUserId ?? ''}
              onChange={e => { void onUpdate({ clerkUserId: e.target.value || null }); }}
              style={INPUT_STYLE}>
              <option value="">— Not linked —</option>
              {members.map(m => (
                <option key={m.userId} value={m.userId}>{m.label}</option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {/* ── Toggles ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <Toggle
          label="Default dispatcher"
          description="Auto-filled on new loads when no other dispatcher is set."
          checked={dispatcher.isDefault}
          onChange={(v) => { void onUpdate({ isDefault: v }); }} />
        <Toggle
          label="Active"
          description="Inactive dispatchers are hidden from the load picker but stay on historical loads."
          checked={dispatcher.active}
          onChange={(v) => { void onUpdate({ active: v }); }} />
      </div>

      {/* ── Danger zone ─────────────────────────────────────────── */}
      <div className="pt-4" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="text-[12.5px]" style={{ color: 'var(--gc-text-1)' }}>
              Confirm delete? Historical loads keep the cached name.
            </span>
            <button
              onClick={async () => {
                await onRemove();
                setConfirmDelete(false);
              }}
              className="text-[12px] font-bold px-2.5 py-1.5 rounded-lg"
              style={{ background: '#fce8e6', color: '#c5221f', border: '1px solid #f5c2c0', cursor: 'pointer' }}>
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg"
              style={{ background: 'transparent', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-[12.5px] font-semibold px-2.5 py-1.5 rounded-lg"
            style={{ background: 'transparent', color: '#c5221f', border: '1px solid #f5c2c0', cursor: 'pointer' }}>
            <Trash2 size={12} /> Delete dispatcher
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      {children}
    </label>
  );
}

function Toggle({ label, description, checked, onChange }: {
  label:       string;
  description: string;
  checked:     boolean;
  onChange:    (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ marginTop: 3, width: 16, height: 16, cursor: 'pointer' }} />
      <div className="flex-1">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{label}</div>
        <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{description}</div>
      </div>
    </label>
  );
}

const ROW_INPUT: React.CSSProperties = {
  width:        '100%',
  padding:      '6px 8px',
  fontSize:     12.5,
  border:       '1px solid var(--gc-border)',
  borderRadius: 6,
  outline:      'none',
};

const INPUT_STYLE: React.CSSProperties = {
  width:        '100%',
  padding:      '8px 10px',
  fontSize:     13,
  border:       '1px solid var(--gc-border)',
  borderRadius: 8,
  background:   'var(--gc-surface)',
  color:        'var(--gc-text-1)',
  outline:      'none',
};
