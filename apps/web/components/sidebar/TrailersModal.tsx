'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Container, Plus, Trash2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { formatHardDeleteError } from '@/lib/hardDeleteError';
import LifecycleEditor from './LifecycleEditor';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import { TRAILER_CATEGORIES, type TrailerCategory } from '@fleetcal/types';
import type { Trailer } from '@/lib/types';

/**
 * Trailer directory — mirrors AssetsModal/DriversModal layout (left
 * list of trailers, right detail panel with editable fields). Lives
 * on the calendar sidebar under "Manage trailers" instead of in
 * settings, so dispatchers can manage trailers without leaving the
 * dispatch surface.
 *
 * Per-trailer fields are intentionally simpler than trucks/drivers:
 * name, trailer #, category, notes, lifecycle. The Motive Vehicle ID
 * field is only rendered when motive_integration is enabled — MVP
 * orgs (no ELD subscription) see a clean form without ELD plumbing.
 *
 * The trailer accent color is fixed (orange) because trailers don't
 * have a per-row color on the calendar like trucks do.
 */

const TRAILER_ACCENT = '#b85c00';

const P_INPUT: React.CSSProperties = {
  border: '1px solid var(--gc-border)',
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 14,
  color: 'var(--gc-text-1)',
  outline: 'none',
  background: 'var(--gc-surface)',
  transition: 'border-color 150ms',
  width: '100%',
  boxSizing: 'border-box',
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function TrailersModal({ onClose, initialTrailerId }: {
  onClose: () => void;
  initialTrailerId?: number;
}) {
  const { trailers: allTrailers, addTrailer, removeTrailer, hardDeleteTrailer } = useCalendarStore();

  // Sort retired trailers to the bottom so the directory leads with
  // everything currently in service.
  const today = dateKeyOf(new Date());
  const trailers = [
    ...allTrailers.filter(t =>  isActiveOn(t, today)),
    ...allTrailers.filter(t => !isActiveOn(t, today)),
  ];

  const [selected, setSelectedRaw] = useState<number>(
    initialTrailerId && trailers.some(t => t.id === initialTrailerId)
      ? initialTrailerId
      : (trailers.length > 0 ? trailers[0].id : -1)
  );
  const [adding, setAdding] = useState(false);

  // Track placeholder-row id so we can auto-clean if the user navigates
  // away without filling a real name. Same pattern as AssetsModal.
  const draftIdRef = useRef<number | null>(null);

  const cleanupDraft = () => {
    const id = draftIdRef.current;
    if (id == null) return;
    draftIdRef.current = null;
    const fresh = useCalendarStore.getState().trailers.find(t => t.id === id);
    if (fresh && fresh.name === 'New trailer' && !fresh.trailerNumber && !fresh.notes) {
      removeTrailer(id);
    }
  };

  const setSelected = (next: number) => {
    if (draftIdRef.current != null && next !== draftIdRef.current) cleanupDraft();
    setSelectedRaw(next);
  };

  const handleClose = () => { cleanupDraft(); onClose(); };

  useEffect(() => {
    return () => { cleanupDraft(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAdd = async () => {
    if (adding) return;
    cleanupDraft();
    setAdding(true);
    try {
      const newId = await addTrailer({
        name:     'New trailer',
        category: TRAILER_CATEGORIES[0],
        // Match AssetsModal default — historical reports stay clean.
        activeFrom: '2026-01-01',
      });
      draftIdRef.current = newId;
      setSelectedRaw(newId);
    } catch (err) {
      console.error('add trailer failed:', err);
    } finally {
      setAdding(false);
    }
  };

  const selectedTrailer = trailers.find(t => t.id === selected) ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="flex flex-col"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: 1020, height: '82vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2.5">
            <Container size={17} style={{ color: TRAILER_ACCENT }} />
            <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Trailer Directory
            </span>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* ── Left Sidebar ── */}
          <div className="flex flex-col shrink-0"
            style={{ width: 240, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>

            <div className="shrink-0 flex items-center justify-between px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--gc-text-3)' }}>
                Trailers
              </span>
              <button
                onClick={() => void handleAdd()}
                disabled={adding}
                title="Add trailer"
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50"
                style={{ color: 'var(--gc-blue)', background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
                onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={12} />
                {adding ? 'Adding…' : 'Trailer'}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {trailers.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
                  No trailers yet.
                </p>
              )}
              {trailers.map(t => (
                <NavTrailerRow
                  key={t.id}
                  trailer={t}
                  selected={selected === t.id}
                  onSelect={() => setSelected(t.id)}
                />
              ))}
            </div>
          </div>

          {/* ── Right Panel ── */}
          <div className="flex-1 overflow-y-auto">
            {selectedTrailer ? (
              <TrailerProfilePanel
                key={selectedTrailer.id}
                trailer={selectedTrailer}
                onRemove={() => {
                  if (draftIdRef.current === selectedTrailer.id) draftIdRef.current = null;
                  const remaining = trailers.filter(t => t.id !== selectedTrailer.id);
                  removeTrailer(selectedTrailer.id);
                  setSelectedRaw(remaining.length > 0 ? remaining[0].id : -1);
                }}
                onHardDelete={async () => {
                  if (draftIdRef.current === selectedTrailer.id) draftIdRef.current = null;
                  const remaining = trailers.filter(t => t.id !== selectedTrailer.id);
                  try {
                    await hardDeleteTrailer(selectedTrailer.id);
                    setSelectedRaw(remaining.length > 0 ? remaining[0].id : -1);
                  } catch (err) {
                    alert(formatHardDeleteError('trailer', err));
                  }
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm"
                style={{ color: 'var(--gc-text-3)' }}>
                Select a trailer
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex justify-end px-7 py-4"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <button onClick={handleClose}
            className="px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Nav Trailer Row ──────────────────────────────────────────────────────────

function NavTrailerRow({ trailer, selected, onSelect }: {
  trailer: Trailer;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
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
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center"
        style={{ background: TRAILER_ACCENT }}
      >
        <Container size={13} color="white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium truncate"
            style={{ color: selected ? 'var(--gc-blue)' : 'var(--gc-text-1)' }}>
            {trailer.name}
          </div>
          {!isActiveOn(trailer, dateKeyOf(new Date())) && (
            <span
              className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded"
              style={{ background: '#fee2e2', color: '#991b1b', letterSpacing: '0.5px' }}
              title={trailer.activeTo ? `Retired ${trailer.activeTo}` : 'Retired'}
            >
              Retired
            </span>
          )}
        </div>
        {trailer.trailerNumber && (
          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
            #{trailer.trailerNumber} · {trailer.category}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Trailer Profile Panel ────────────────────────────────────────────────────

function TrailerProfilePanel({ trailer, onRemove, onHardDelete }: {
  trailer: Trailer;
  onRemove: () => void;
  onHardDelete: () => void;
}) {
  const { updateTrailer } = useCalendarStore();
  const { can: canDo } = usePermissions();
  const canDelete = canDo('trailers.delete');
  const canEdit   = canDo('trailers.edit');
  // Hide the Motive Vehicle ID field when the org doesn't have the
  // ELD integration. MVP orgs get a clean trailer profile without
  // any ELD plumbing.
  const { enabled: moduleEnabled } = useModules();
  const showMotiveField = moduleEnabled('motive_integration');

  const [name,            setName]            = useState(trailer.name);
  const [trailerNumber,   setTrailerNumber]   = useState(trailer.trailerNumber ?? '');
  const [category,        setCategory]        = useState<TrailerCategory>(trailer.category);
  const [notes,           setNotes]           = useState(trailer.notes ?? '');
  const [motiveVehicleId, setMotiveVehicleId] = useState(trailer.motiveVehicleId ?? '');
  const [motiveEditing,   setMotiveEditing]   = useState(false);
  const [motiveDraft,     setMotiveDraft]     = useState(trailer.motiveVehicleId ?? '');
  const [confirmDelete,   setConfirmDelete]   = useState(false);

  const save = (updates: Partial<Omit<Trailer, 'id'>>) => updateTrailer(trailer.id, updates);

  const focusBorder = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    (e.currentTarget.style.borderColor = TRAILER_ACCENT);
  const blurBorder  = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    (e.currentTarget.style.borderColor = 'var(--gc-border)');

  return (
    <div className="px-8 py-7">

      {/* Header */}
      <div className="flex items-center gap-5 mb-8">
        <div
          className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: TRAILER_ACCENT }}
        >
          <Container size={28} color="white" />
        </div>
        <div>
          <div className="text-xl font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {trailer.name}{trailer.trailerNumber ? ` #${trailer.trailerNumber}` : ''}
          </div>
          <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
            {trailer.category}
          </div>
        </div>
      </div>

      {!canEdit && (
        <div style={{
          padding: '10px 14px', marginBottom: 24,
          background: '#fef3c7', border: '1px solid #fde68a',
          borderRadius: 10, color: '#92400e', fontSize: 13, fontWeight: 600,
        }}>
          Read-only — your role can view this trailer but can&apos;t make changes.
        </div>
      )}

      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4"
          style={{ color: 'var(--gc-text-3)' }}>
          Profile
        </div>

        {/* Name + Trailer # */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Trailer Name">
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Name" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                if (v) { setName(v); save({ name: v }); }
                blurBorder(e);
              }} />
          </PField>
          <PField label="Trailer #">
            <input type="text" value={trailerNumber} onChange={e => setTrailerNumber(e.target.value)}
              placeholder="e.g. 3041" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setTrailerNumber(v);
                save({ trailerNumber: v || undefined });
                blurBorder(e);
              }} />
          </PField>
        </div>

        {/* Category */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Category">
            <select
              value={category}
              onChange={e => {
                const v = e.target.value as TrailerCategory;
                setCategory(v);
                save({ category: v });
              }}
              style={{ ...P_INPUT, cursor: 'pointer', height: 42, padding: '0 12px' }}
              onFocus={focusBorder} onBlur={blurBorder}>
              {TRAILER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </PField>
        </div>

        {/* Notes */}
        <PField label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Add notes about this trailer…" rows={3}
            style={{ ...P_INPUT, resize: 'vertical', paddingTop: 10, paddingBottom: 10, lineHeight: '1.5', fontFamily: 'inherit' }}
            onFocus={focusBorder}
            onBlur={e => {
              const v = e.target.value.trim();
              setNotes(v);
              save({ notes: v || undefined });
              blurBorder(e);
            }} />
        </PField>

        {/* Motive Vehicle ID — only when motive_integration is on */}
        {showMotiveField && (
        <div className="mt-4">
        <PField label="Motive Vehicle ID">
          {motiveEditing ? (
            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                value={motiveDraft}
                onChange={e => setMotiveDraft(e.target.value)}
                placeholder="e.g. 123456"
                style={{ ...P_INPUT, flex: 1 }}
                onFocus={focusBorder}
                onBlur={blurBorder}
                onKeyDown={e => {
                  if (e.key === 'Escape') { setMotiveDraft(motiveVehicleId); setMotiveEditing(false); }
                }}
              />
              <button
                onClick={() => {
                  const v = motiveDraft.trim();
                  setMotiveVehicleId(v);
                  save({ motiveVehicleId: v || undefined });
                  setMotiveEditing(false);
                }}
                className="shrink-0 px-3 rounded-lg text-[13px] font-medium"
                style={{ background: TRAILER_ACCENT, color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div
                style={{ ...P_INPUT, flex: 1, color: motiveVehicleId ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}
              >
                {motiveVehicleId || 'Not set'}
              </div>
              <button
                onClick={() => { setMotiveDraft(motiveVehicleId); setMotiveEditing(true); }}
                className="shrink-0 px-3 rounded-lg text-[13px] font-medium"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)', cursor: 'pointer' }}
              >
                Edit
              </button>
            </div>
          )}
        </PField>
        </div>
        )}
      </div>
      </fieldset>

      {/* Lifecycle editor */}
      <LifecycleEditor
        activeFrom={trailer.activeFrom}
        activeTo={trailer.activeTo}
        accent={TRAILER_ACCENT}
        canEdit={canEdit}
        onSave={(changes) => save(changes)}
      />

      {/* Retire — soft, stamps active_to = today */}
      {canDelete && !trailer.activeTo && (
      <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
              Retire <strong>{trailer.name}</strong>? It&apos;ll drop off the picker starting today. Existing loads stay attached.
            </span>
            <button
              onClick={onRemove}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#d93025' }}>
              Retire
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: '#d93025' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Trash2 size={14} />
            Retire Trailer
          </button>
        )}
      </div>
      )}

      {/* Permanent delete */}
      {canDelete && (
        <PermanentDeleteBlock
          label={trailer.name}
          onConfirm={onHardDelete}
        />
      )}
    </div>
  );
}

/** Two-step destructive confirm — same pattern as AssetsModal. */
function PermanentDeleteBlock({ label, onConfirm }: {
  label: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const ready = armed && typed.trim() === label.trim();
  return (
    <div className="mt-6 pt-6" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2"
        style={{ color: 'var(--gc-text-3)' }}>
        Danger zone
      </div>
      {!armed ? (
        <button
          onClick={() => setArmed(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ color: '#7a1d18', border: '1px solid rgba(217,48,37,0.4)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(217,48,37,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <Trash2 size={14} />
          Delete permanently
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
            Permanently delete <strong>{label}</strong>. This can&apos;t be undone — the row is removed from the database.
            Type <code style={{ background: 'var(--gc-hover)', padding: '1px 4px', borderRadius: 3 }}>{label}</code> below to confirm.
          </p>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={label}
              className="flex-1 text-sm rounded-lg px-3 py-1.5 outline-none"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-1)' }}
            />
            <button
              onClick={() => { void onConfirm(); }}
              disabled={!ready}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
              style={{ background: '#d93025' }}>
              Delete permanently
            </button>
            <button
              onClick={() => { setArmed(false); setTyped(''); }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PField ───────────────────────────────────────────────────────────────────

function PField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}
