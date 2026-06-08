'use client';

/**
 * DispatchersModal — directory body for the "Dispatchers" tab in the
 * Manage Assets directory (Drivers / Trucks / Trailers / Customers /
 * Locations).
 *
 * Visual + interaction conventions match DriversModal so the five
 * directory tabs feel like one family:
 *
 *   - 240-px left rail with a tiny uppercase section header and an
 *     inline "+ Dispatcher" accent button.
 *   - List rows show a circular initials avatar (grey when idle,
 *     blue when selected) + full name + a row of pills for status
 *     (DEFAULT ★, INACTIVE, CLERK).
 *   - Detail pane leads with a 64-px avatar + display name header,
 *     then fields, toggles, and the danger zone.
 *
 * Add behavior mirrors DriversModal: clicking "+ Dispatcher" creates
 * a placeholder row server-side immediately, selects it, and pushes
 * focus into the First name field. If the user navigates away
 * without entering a real name, the placeholder row is silently
 * removed (cleanupDraft below).
 *
 * Auto-saves on blur; the DirectoryDetailHandle exposed via forwardRef
 * is a no-op since there's no staged dirty state to gate.
 */

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Plus, Trash2, Star, UserCheck, X, Headset, Calendar } from 'lucide-react';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { Dispatcher } from '@/lib/types';
import type { DirectoryDetailHandle } from './DirectoryModal';

const ACCENT = '#1a73e8';

interface DispatchersModalProps {
  onClose: () => void;
  initialDispatcherId?: number;
  embedded?: boolean;
}

const DispatchersModal = forwardRef<DirectoryDetailHandle, DispatchersModalProps>(
function DispatchersModal({ onClose, initialDispatcherId, embedded }, modalRef) {
  // Auto-save on blur → no dirty-state gating. Mirrors DriversModal.
  useImperativeHandle(modalRef, () => ({
    isDirty: () => false,
    save:    () => Promise.resolve(),
    discard: () => {},
  }), []);

  const { dispatchers, addDispatcher, updateDispatcher, removeDispatcher } = useCalendarStore();

  // Active first, then alphabetical by last name. Inactive (soft-
  // deleted) rows sit at the bottom with an INACTIVE pill so the
  // dispatcher can still inspect historical attribution.
  const sortedDispatchers = [...dispatchers].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const ln = a.lastName.localeCompare(b.lastName);
    return ln !== 0 ? ln : a.firstName.localeCompare(b.firstName);
  });

  const [selected, setSelected] = useState<number | null>(
    initialDispatcherId ?? sortedDispatchers[0]?.id ?? null
  );
  const [adding, setAdding] = useState(false);

  // Track the placeholder row we created on "+ Dispatcher" so we can
  // clean it up if the user bails without entering a real name. Same
  // pattern as DriversModal — auto-saved drafts (firstName/lastName
  // already filled in) get kept; untouched placeholders get pruned.
  const draftIdRef = useRef<number | null>(null);

  const cleanupDraft = () => {
    const id = draftIdRef.current;
    if (id == null) return;
    draftIdRef.current = null;
    const fresh = useCalendarStore.getState().dispatchers.find(d => d.id === id);
    if (!fresh) return;
    // Still a placeholder if the user hasn't replaced "New" / "Dispatcher"
    // with anything real.
    const stillPlaceholder = fresh.firstName === PLACEHOLDER_FIRST && fresh.lastName === PLACEHOLDER_LAST;
    if (stillPlaceholder) {
      void removeDispatcher(id);
    }
  };

  // Strip the placeholder if the panel unmounts mid-edit.
  useEffect(() => {
    return () => { cleanupDraft(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If selection got nulled but rows exist, pick the first one.
  useEffect(() => {
    if (selected == null && sortedDispatchers.length > 0) {
      setSelected(sortedDispatchers[0].id);
    }
  }, [sortedDispatchers, selected]);

  const handleAdd = async () => {
    if (adding) return;
    cleanupDraft();
    setAdding(true);
    try {
      const created = await addDispatcher({
        firstName: PLACEHOLDER_FIRST,
        lastName:  PLACEHOLDER_LAST,
      });
      if (created) {
        draftIdRef.current = created.id;
        setSelected(created.id);
      }
    } finally {
      setAdding(false);
    }
  };

  const handleSelect = (id: number) => {
    // Switching off a still-placeholder draft → clean it up first.
    cleanupDraft();
    setSelected(id);
  };

  const handleClose = () => {
    cleanupDraft();
    onClose();
  };

  const selectedDispatcher = sortedDispatchers.find(d => d.id === selected) ?? null;

  const content = (
    <>
      {/* Header — only in standalone mode (DirectoryModal supplies its
          own tab strip + close button in embedded mode). */}
      {!embedded && (
        <div className="shrink-0 flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2.5">
            <Headset size={17} style={{ color: ACCENT }} />
            <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Dispatcher Directory
            </span>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Body — left rail + right detail pane. */}
      <div className="flex-1 overflow-hidden flex min-h-0">

        {/* ── Left Rail ─────────────────────────────────────────── */}
        <div className="flex flex-col shrink-0"
          style={{ width: 240, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>

          {/* Section header — uppercase title + inline + button. */}
          <div className="shrink-0 flex items-center justify-between px-4 pt-5 pb-1">
            <span className="text-[10px] font-bold uppercase tracking-widest"
              style={{ color: 'var(--gc-text-3)' }}>
              Dispatchers
            </span>
            <button
              onClick={() => void handleAdd()}
              disabled={adding}
              title="Add dispatcher"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50"
              style={{ color: ACCENT, background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
              onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Plus size={12} />
              {adding ? 'Adding…' : 'Dispatcher'}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {sortedDispatchers.length === 0 && (
              <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
                No dispatchers yet.
              </p>
            )}
            {sortedDispatchers.map(d => (
              <DispatcherRow
                key={d.id}
                dispatcher={d}
                selected={selected === d.id}
                onSelect={() => handleSelect(d.id)} />
            ))}
          </div>
        </div>

        {/* ── Right Pane ────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          {selectedDispatcher ? (
            <DispatcherDetail
              key={selectedDispatcher.id}
              dispatcher={selectedDispatcher}
              onUpdate={(updates) => updateDispatcher(selectedDispatcher.id, updates)}
              onRemove={async () => {
                await removeDispatcher(selectedDispatcher.id);
                // Selection clears; the effect at the top picks a new row.
                setSelected(null);
              }} />
          ) : (
            <div className="flex items-center justify-center h-full text-sm"
              style={{ color: 'var(--gc-text-3)' }}>
              Select a dispatcher
            </div>
          )}
        </div>
      </div>
    </>
  );

  if (embedded) return <>{content}</>;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div
        className="flex flex-col relative"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: 1040, height: '86vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
        }}>
        {content}
      </div>
    </div>
  );
});

DispatchersModal.displayName = 'DispatchersModal';
export default DispatchersModal;

// Placeholder names used for the empty-row-on-Add flow. Must match
// here and in cleanupDraft.
const PLACEHOLDER_FIRST = 'New';
const PLACEHOLDER_LAST  = 'Dispatcher';

// ─── List row ────────────────────────────────────────────────────

function dispatcherDisplayName(d: Dispatcher): string {
  return `${d.firstName} ${d.lastName}`.trim();
}

function dispatcherInitials(d: Dispatcher): string {
  const a = d.firstName?.[0] ?? '';
  const b = d.lastName?.[0]  ?? '';
  return (a + b).toUpperCase() || '?';
}

function DispatcherRow({ dispatcher, selected, onSelect }: {
  dispatcher: Dispatcher;
  selected:   boolean;
  onSelect:   () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const inactive = !dispatcher.active;

  return (
    <div
      className="flex items-center gap-2.5 px-2 py-2 rounded-lg cursor-pointer select-none transition-colors"
      style={{
        background: selected
          ? 'var(--gc-blue-light)'
          : hovered ? 'var(--gc-hover)' : 'transparent',
      }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white"
        style={{ background: selected ? ACCENT : '#9aa0a6', opacity: inactive ? 0.55 : 1 }}>
        {dispatcherInitials(dispatcher)}
      </div>
      <span className="flex-1 text-sm font-medium truncate"
        style={{ color: selected ? ACCENT : inactive ? 'var(--gc-text-3)' : 'var(--gc-text-1)' }}>
        {dispatcherDisplayName(dispatcher)}
      </span>
      {/* Indicator chips — small enough to coexist on a narrow rail.
          ★ for default, dot for Clerk-linked, "—" pill when inactive. */}
      {dispatcher.isDefault && (
        <Star size={11} fill={selected ? ACCENT : '#1d4ed8'}
          style={{ color: selected ? ACCENT : '#1d4ed8', flexShrink: 0 }} />
      )}
      {dispatcher.clerkUserId && !inactive && (
        <span title="Linked to a Clerk org member"
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#34a853', flexShrink: 0,
          }} />
      )}
      {inactive && (
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
          style={{ background: '#f1f3f4', color: '#5f6368' }}>
          OFF
        </span>
      )}
    </div>
  );
}

// ─── Detail pane ─────────────────────────────────────────────────

interface ClerkMemberOption {
  userId: string;
  label:  string;
}

function DispatcherDetail({ dispatcher, onUpdate, onRemove }: {
  dispatcher: Dispatcher;
  onUpdate:   (updates: { firstName?: string; lastName?: string; hireDate?: string | null; clerkUserId?: string | null; isDefault?: boolean; active?: boolean }) => Promise<void>;
  onRemove:   () => Promise<void>;
}) {
  const [firstName, setFirstName] = useState(dispatcher.firstName);
  const [lastName,  setLastName]  = useState(dispatcher.lastName);
  const [hireDate,  setHireDate]  = useState(dispatcher.hireDate ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const lastSavedRef = useRef({
    firstName: dispatcher.firstName,
    lastName:  dispatcher.lastName,
    hireDate:  dispatcher.hireDate ?? '',
  });
  const firstNameInputRef = useRef<HTMLInputElement>(null);

  // Reset locals when switching rows (key prop also remounts, defense
  // in depth). Auto-focus + select the First name field on first
  // render of a placeholder so the user can just type their name.
  useEffect(() => {
    setFirstName(dispatcher.firstName);
    setLastName(dispatcher.lastName);
    setHireDate(dispatcher.hireDate ?? '');
    lastSavedRef.current = {
      firstName: dispatcher.firstName,
      lastName:  dispatcher.lastName,
      hireDate:  dispatcher.hireDate ?? '',
    };
    const isPlaceholder = dispatcher.firstName === PLACEHOLDER_FIRST && dispatcher.lastName === PLACEHOLDER_LAST;
    if (isPlaceholder) {
      // Focus + select-all so typing replaces "New" cleanly.
      requestAnimationFrame(() => {
        firstNameInputRef.current?.focus();
        firstNameInputRef.current?.select();
      });
    }
  }, [dispatcher.id, dispatcher.firstName, dispatcher.lastName, dispatcher.hireDate]);

  // ── Clerk members for the link picker ────────────────────────
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

  // ── Auto-save on blur ────────────────────────────────────────
  function saveNameIfChanged() {
    const updates: { firstName?: string; lastName?: string } = {};
    const f = firstName.trim();
    const l = lastName.trim();
    if (f && f !== lastSavedRef.current.firstName) updates.firstName = f;
    if (l && l !== lastSavedRef.current.lastName)  updates.lastName  = l;
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
    <div className="px-8 py-7">
      {/* ── Avatar + name header ─────────────────────────────── */}
      <div className="flex items-center gap-5 mb-8">
        <div
          className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center text-2xl font-bold text-white"
          style={{ background: ACCENT, opacity: dispatcher.active ? 1 : 0.55 }}>
          {dispatcherInitials(dispatcher)}
        </div>
        <div>
          <div className="text-xl font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {dispatcherDisplayName(dispatcher)}
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            {dispatcher.isDefault && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded"
                style={{ background: '#dbeafe', color: '#1d4ed8' }}>
                <Star size={10} fill="currentColor" /> DEFAULT
              </span>
            )}
            {!dispatcher.active && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded"
                style={{ background: '#f1f3f4', color: '#5f6368' }}>
                INACTIVE
              </span>
            )}
            {dispatcher.clerkUserId && (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded"
                style={{ background: '#e6f4ea', color: '#137333' }}
                title="Linked to a Clerk org member">
                <UserCheck size={10} /> CLERK
              </span>
            )}
            {dispatcher.hireDate && (
              <span className="inline-flex items-center gap-1 text-[11.5px]"
                style={{ color: 'var(--gc-text-3)' }}>
                <Calendar size={11} />
                Hired {formatHireDate(dispatcher.hireDate)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Fields ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Field label="First name">
          <input
            ref={firstNameInputRef}
            type="text"
            value={firstName}
            onChange={e => setFirstName(e.target.value)}
            onBlur={saveNameIfChanged}
            style={INPUT_STYLE}
            onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
            onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
        </Field>
        <Field label="Last name">
          <input
            type="text"
            value={lastName}
            onChange={e => setLastName(e.target.value)}
            onBlur={saveNameIfChanged}
            style={INPUT_STYLE}
            onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
            onBlurCapture={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
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
            <div className="text-[12.5px] py-2" style={{ color: 'var(--gc-text-3)' }}>
              Loading members…
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

      {/* ── Toggles ─────────────────────────────────────────── */}
      <div className="space-y-3 mb-6">
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

      {/* ── Danger zone ─────────────────────────────────────── */}
      <div className="pt-5" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>
              Confirm delete? Historical loads keep the cached name.
            </span>
            <button
              onClick={async () => { await onRemove(); setConfirmDelete(false); }}
              className="text-[12px] font-bold px-3 py-1.5 rounded-lg"
              style={{ background: '#fce8e6', color: '#c5221f', border: '1px solid #f5c2c0', cursor: 'pointer' }}>
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg"
              style={{ background: 'transparent', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-[12.5px] font-semibold px-3 py-1.5 rounded-lg"
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
      <div className="text-[11px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
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

/** Format YYYY-MM-DD → "Jun 9, 2026". Used in the detail header. */
function formatHireDate(yyyyMmDd: string): string {
  // Construct a UTC Date to avoid timezone-induced day-shift; the
  // value is a wall-clock date with no timezone meaning anyway.
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return yyyyMmDd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

const INPUT_STYLE: React.CSSProperties = {
  width:        '100%',
  padding:      '9px 11px',
  fontSize:     13.5,
  border:       '1px solid var(--gc-border)',
  borderRadius: 8,
  background:   'var(--gc-surface)',
  color:        'var(--gc-text-1)',
  outline:      'none',
  transition:   'border-color 120ms',
};
