'use client';

import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { X, Container, Plus, Trash2, Loader2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { formatHardDeleteError } from '@/lib/hardDeleteError';
import { railway } from '@/lib/railway';
import LifecycleEditor from './LifecycleEditor';
import LoadHistorySection from './LoadHistorySection';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import { type TrailerCategory, type TrailerDocument, type TrailerDocumentKind } from '@fleetcal/types';
import CategoryEditorDialog from './CategoryEditorDialog';
import { Tag } from 'lucide-react';
import type { Trailer } from '@/lib/types';
import type { DirectoryDetailHandle } from './DirectoryModal';

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

interface TrailersModalProps {
  onClose: () => void;
  initialTrailerId?: number;
  /** Embedded mode for DirectoryModal — skip outer chrome. */
  embedded?: boolean;
}

const TrailersModal = forwardRef<DirectoryDetailHandle, TrailersModalProps>(
function TrailersModal({ onClose, initialTrailerId, embedded }, modalRef) {
  // Forward the inner detail handle so the DirectoryModal shell can
  // gate cross-tab navigation against staged form changes.
  const detailRef          = useRef<TrailerDetailHandle>(null);
  const [, setPanelDirty]  = useState(false);
  const [showUnsaved, setShowUnsaved] = useState(false);
  const [saving,      setSaving]      = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  useImperativeHandle(modalRef, () => ({
    isDirty: () => detailRef.current?.isDirty() ?? false,
    save:    () => detailRef.current?.save() ?? Promise.resolve(),
    discard: () => { detailRef.current?.discard(); },
  }), []);

  const {
    trailers: allTrailers,
    addTrailer, removeTrailer, hardDeleteTrailer,
    trailerCategories,
    addTrailerCategory, updateTrailerCategory, removeTrailerCategory, reorderTrailerCategories,
  } = useCalendarStore();
  // Whether the small "Categories" dialog is open over the modal.
  const [catEditOpen, setCatEditOpen] = useState(false);
  // The trailer_categories module gates the per-trailer Category
  // field. MVP orgs with uniform fleets (all dry vans) get a
  // simpler form without the dropdown; Curzon-style mixed fleets
  // flip it on. When off, new trailers silently default to 'Other'
  // so the DB CHECK constraint stays satisfied.
  const { enabled: moduleEnabled } = useModules();
  const showCategory = moduleEnabled('trailer_categories');

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

  const tryNavigate = (action: () => void) => {
    if (detailRef.current?.isDirty()) {
      pendingActionRef.current = action;
      setShowUnsaved(true);
    } else {
      action();
    }
  };

  const handleUnsavedSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await detailRef.current?.save();
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      setShowUnsaved(false);
      action?.();
    } catch (err) {
      console.error('[TrailersModal] save failed:', err);
      alert(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  const handleUnsavedDiscard = () => {
    detailRef.current?.discard();
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setShowUnsaved(false);
    action?.();
  };
  const handleUnsavedKeep = () => {
    pendingActionRef.current = null;
    setShowUnsaved(false);
  };

  const setSelected = (next: number) => {
    tryNavigate(() => {
      if (draftIdRef.current != null && next !== draftIdRef.current) cleanupDraft();
      setSelectedRaw(next);
    });
  };

  const handleClose = () => {
    tryNavigate(() => { cleanupDraft(); onClose(); });
  };

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
        // Default category: when the categories module is on, lead
        // with 'Swing' (the most common starting point for the
        // current Curzon use). When off, pick 'Other' — the form
        // hides the field entirely and 'Other' reads as
        // "uncategorized" if categories ever get turned back on.
        category: showCategory ? (trailerCategories[0] ?? 'Other') : 'Other',
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

  const unsavedDialog = showUnsaved && (
    <div className="absolute inset-0 z-20 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 14 }}>
      <div className="rounded-2xl p-6 space-y-4"
        style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 380, border: '1px solid var(--gc-border-light)' }}>
        <div>
          <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Save changes?</div>
          <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>You have unsaved changes to this trailer.</div>
        </div>
        <div className="flex flex-col gap-2">
          <button onClick={() => void handleUnsavedSave()} disabled={saving}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-60"
            style={{ background: TRAILER_ACCENT }}>
            {saving ? 'Saving…' : 'Yes, save changes'}
          </button>
          <button onClick={handleUnsavedDiscard} disabled={saving}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}>
            No, discard changes
          </button>
          <button onClick={handleUnsavedKeep} disabled={saving}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
            style={{ color: 'var(--gc-text-3)', background: 'transparent' }}>
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );

  const content = (
    <>
      {/* Header — hidden in embedded mode. */}
      {!embedded && (
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
      )}

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
              <div className="flex items-center gap-1">
                {/* Manage trailer categories — opens an overlay where
                    the dispatcher edits the dropdown values used by
                    the Category select on every trailer. */}
                {showCategory && (
                  <button
                    onClick={() => setCatEditOpen(true)}
                    title="Manage categories"
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors"
                    style={{ color: 'var(--gc-text-2)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <Tag size={12} />
                    Categories
                  </button>
                )}
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
                  showCategory={showCategory}
                />
              ))}
            </div>
          </div>

          {/* ── Right Panel ── */}
          <div className="flex-1 overflow-y-auto">
            {selectedTrailer ? (
              <TrailerProfilePanel
                key={selectedTrailer.id}
                ref={detailRef}
                onDirtyChange={setPanelDirty}
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

      {/* Footer — hidden in embedded mode. */}
      {!embedded && (
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
      )}
    </>
  );

  const categoryDialog = catEditOpen && (
    <CategoryEditorDialog
      title="Trailer Categories"
      hint="Used for the Category dropdown on every trailer. Renaming updates all assigned trailers; the seed list is Swing, Roll Up, Reefer, Flat Bed, Other."
      items={trailerCategories}
      onAdd={addTrailerCategory}
      onUpdate={updateTrailerCategory}
      onRemove={removeTrailerCategory}
      onReorder={reorderTrailerCategories}
      onClose={() => setCatEditOpen(false)}
    />
  );

  if (embedded) return (<>{unsavedDialog}{categoryDialog}{content}</>);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div
        className="flex flex-col relative"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: 1020, height: '82vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
        }}>
        {unsavedDialog}
        {categoryDialog}
        {content}
      </div>
    </div>
  );
});

export default TrailersModal;

// ─── Nav Trailer Row ──────────────────────────────────────────────────────────

function NavTrailerRow({ trailer, selected, onSelect, showCategory }: {
  trailer: Trailer;
  selected: boolean;
  onSelect: () => void;
  showCategory: boolean;
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
            #{trailer.trailerNumber}{showCategory ? ` · ${trailer.category}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Trailer Profile Panel ────────────────────────────────────────────────────

interface TrailerProfilePanelProps {
  trailer: Trailer;
  onRemove: () => void;
  onHardDelete: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Imperative handle returned via forwardRef — Save/Discard contract
 *  the parent modal and the DirectoryModal shell can use to gate
 *  cross-tab navigation while staged form changes exist. */
export type TrailerDetailHandle = {
  isDirty: () => boolean;
  save:    () => Promise<void>;
  discard: () => void;
};

const TrailerProfilePanel = forwardRef<TrailerDetailHandle, TrailerProfilePanelProps>(
function TrailerProfilePanel({ trailer, onRemove, onHardDelete, onDirtyChange }, ref) {
  const { updateTrailer, events, assets, openEditModal, trailerCategories } = useCalendarStore();

  // Details / History split — matches Trucks / Drivers / Customers.
  // Trailer history is the set of events (loads) where this trailer
  // was assigned via events.trailer_id. The CalendarEvent.trailerId
  // field is populated by the load modal's trailer dropdown; we
  // filter the global events array down to the matches.
  const [view, setView] = useState<'details' | 'history'>('details');
  const trailerLoads = events.filter(ev => ev.trailerId === trailer.id);
  const { can: canDo } = usePermissions();
  const canDelete = canDo('trailers.delete');
  const canEdit   = canDo('trailers.edit');
  // Hide the Motive Vehicle ID field when the org doesn't have the
  // ELD integration. MVP orgs get a clean trailer profile without
  // any ELD plumbing.
  const { enabled: moduleEnabled } = useModules();
  const showMotiveField = moduleEnabled('motive_integration');
  // Trailer categories — same gating rationale as the modal entry
  // point. When off, the Category dropdown disappears from the
  // profile form AND from the small header sub-line under the name.
  const showCategory    = moduleEnabled('trailer_categories');

  const [name,              setName]              = useState(trailer.name);
  const [trailerNumber,     setTrailerNumber]     = useState(trailer.trailerNumber ?? '');
  const [category,          setCategory]          = useState<TrailerCategory>(trailer.category);
  const [notes,             setNotes]             = useState(trailer.notes ?? '');
  const [make,              setMake]              = useState(trailer.make ?? '');
  const [model,             setModel]             = useState(trailer.model ?? '');
  const [vin,               setVin]               = useState(trailer.vin ?? '');
  const [licensePlate,      setLicensePlate]      = useState(trailer.licensePlate ?? '');
  const [licenseState,      setLicenseState]      = useState(trailer.licenseState ?? '');
  const [licenseExpiration, setLicenseExpiration] = useState(trailer.licenseExpiration ?? '');
  const [motiveVehicleId,   setMotiveVehicleId]   = useState(trailer.motiveVehicleId ?? '');
  const [motiveEditing,     setMotiveEditing]     = useState(false);
  const [motiveDraft,       setMotiveDraft]       = useState(trailer.motiveVehicleId ?? '');
  const [confirmDelete,     setConfirmDelete]     = useState(false);

  // Stage updates locally; commit on Save click. The legacy inline
  // `save({...})` calls below all hit this no-op now — local state
  // is the single source of truth. Same pattern as AssetsModal.
  const save = (_updates: Partial<Omit<Trailer, 'id'>>) => {};
  const realUpdateTrailer = updateTrailer;

  const isDirty =
    name              !== trailer.name                          ||
    trailerNumber     !== (trailer.trailerNumber     ?? '')     ||
    category          !== trailer.category                      ||
    notes             !== (trailer.notes             ?? '')     ||
    make              !== (trailer.make              ?? '')     ||
    model             !== (trailer.model             ?? '')     ||
    vin               !== (trailer.vin               ?? '')     ||
    licensePlate      !== (trailer.licensePlate      ?? '')     ||
    licenseState      !== (trailer.licenseState      ?? '')     ||
    licenseExpiration !== (trailer.licenseExpiration ?? '')     ||
    motiveVehicleId   !== (trailer.motiveVehicleId   ?? '');

  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  const saveAll = async () => {
    await realUpdateTrailer(trailer.id, {
      name:              name.trim() || trailer.name,
      trailerNumber:     trailerNumber.trim() || undefined,
      category,
      notes:             notes.trim() || undefined,
      make:              make.trim() || undefined,
      model:             model.trim() || undefined,
      vin:               vin.trim().toUpperCase().replace(/\s+/g, '') || undefined,
      licensePlate:      licensePlate.trim().toUpperCase() || undefined,
      licenseState:      licenseState.trim().toUpperCase() || undefined,
      licenseExpiration: licenseExpiration || null,
      motiveVehicleId:   motiveVehicleId.trim() || undefined,
    });
  };

  const discardAll = () => {
    setName(trailer.name);
    setTrailerNumber(trailer.trailerNumber ?? '');
    setCategory(trailer.category);
    setNotes(trailer.notes ?? '');
    setMake(trailer.make ?? '');
    setModel(trailer.model ?? '');
    setVin(trailer.vin ?? '');
    setLicensePlate(trailer.licensePlate ?? '');
    setLicenseState(trailer.licenseState ?? '');
    setLicenseExpiration(trailer.licenseExpiration ?? '');
    setMotiveVehicleId(trailer.motiveVehicleId ?? '');
  };

  useImperativeHandle(ref, () => ({
    isDirty: () => isDirty,
    save:    saveAll,
    discard: discardAll,
  }), [isDirty, saveAll, discardAll]);

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
          {showCategory && (
            <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {trailer.category}
            </div>
          )}
        </div>
      </div>

      {/* Details / History tab selector — mirrors AssetsModal. */}
      <div className="flex items-center gap-1 mb-6 p-0.5 rounded-lg"
        style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', width: 'fit-content' }}>
        {(['details', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setView(tab)}
            className="px-4 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize"
            style={{
              background: view === tab ? 'var(--gc-surface)' : 'transparent',
              color:      view === tab ? TRAILER_ACCENT : 'var(--gc-text-3)',
              boxShadow:  view === tab ? '0 1px 2px rgba(0,0,0,0.08)' : 'none',
            }}>
            {tab}
          </button>
        ))}
      </div>

      {view === 'details' && (<>

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

        {/* Category — gated on trailer_categories module. Hidden for
            MVP orgs with uniform fleets; visible for mixed fleets
            (Curzon) that need the per-trailer label. */}
        {showCategory && (
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
                {/* If the trailer's current category was removed from the
                    org's list (orphaned), surface it at the top so the
                    select still displays the actual value. */}
                {category && !trailerCategories.includes(category) && (
                  <option value={category}>{category}</option>
                )}
                {trailerCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </PField>
          </div>
        )}

        {/* Make + Model — mirrors the trucks profile shape. */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Make">
            <input type="text" value={make} onChange={e => setMake(e.target.value)}
              placeholder="e.g. Wabash" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setMake(v);
                save({ make: v || undefined });
                blurBorder(e);
              }} />
          </PField>
          <PField label="Model">
            <input type="text" value={model} onChange={e => setModel(e.target.value)}
              placeholder="e.g. DuraPlate" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setModel(v);
                save({ model: v || undefined });
                blurBorder(e);
              }} />
          </PField>
        </div>

        {/* VIN + License Plate */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="VIN">
            <input type="text" value={vin} onChange={e => setVin(e.target.value)}
              placeholder="17-character VIN" style={P_INPUT}
              maxLength={17}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim().toUpperCase().replace(/\s+/g, '');
                setVin(v);
                save({ vin: v || undefined });
                blurBorder(e);
              }} />
          </PField>
          <PField label="License Plate">
            <input type="text" value={licensePlate} onChange={e => setLicensePlate(e.target.value)}
              placeholder="e.g. 9XY-Z123" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim().toUpperCase();
                setLicensePlate(v);
                save({ licensePlate: v || undefined });
                blurBorder(e);
              }} />
          </PField>
        </div>

        {/* License State + Expiration — trailers cross state lines
            and get registered in different jurisdictions more often
            than trucks, so the state + expiry are useful primary
            data, not optional. */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="License State">
            <input type="text" value={licenseState} onChange={e => setLicenseState(e.target.value)}
              placeholder="e.g. CA" style={P_INPUT}
              maxLength={2}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim().toUpperCase();
                setLicenseState(v);
                save({ licenseState: v || undefined });
                blurBorder(e);
              }} />
          </PField>
          <PField label="License Expiration">
            <input type="date" value={licenseExpiration} onChange={e => setLicenseExpiration(e.target.value)}
              style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value;
                setLicenseExpiration(v);
                save({ licenseExpiration: v || null });
                blurBorder(e);
              }} />
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
      {/* Documents — registration, inspection, insurance, title,
          other. Same UX as the truck + driver doc surfaces. */}
      <TrailerDocumentsSection trailerId={trailer.id} accent={TRAILER_ACCENT} canEdit={canEdit} />

      </fieldset>

      {/* Lifecycle editor */}
      <LifecycleEditor
        activeFrom={trailer.activeFrom}
        activeTo={trailer.activeTo}
        accent={TRAILER_ACCENT}
        canEdit={canEdit}
        onSave={(changes) => realUpdateTrailer(trailer.id, changes)}
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

      {/* Save / Discard bar — sticky at the bottom of Details when
          any profile field is staged. Mirrors AssetsModal. */}
      {isDirty && canEdit && (
        <div
          className="sticky bottom-0 -mx-8 px-8 py-4 mt-8 flex items-center gap-3 justify-end"
          style={{
            background: 'var(--gc-surface)',
            borderTop: '1px solid var(--gc-border-light)',
            boxShadow: '0 -8px 16px -8px rgba(0,0,0,0.08)',
          }}>
          <span className="text-xs mr-auto" style={{ color: 'var(--gc-text-3)' }}>
            Unsaved changes
          </span>
          <button
            type="button"
            onClick={discardAll}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            Discard
          </button>
          <button
            type="button"
            onClick={() => void saveAll()}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors"
            style={{ background: TRAILER_ACCENT }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
            Save changes
          </button>
        </div>
      )}

      </>)}

      {view === 'history' && (
        <LoadHistorySection
          loads={trailerLoads}
          assets={assets}
          onSelect={openEditModal}
          heading="Loads"
          emptyLabel="No loads found for this trailer"
        />
      )}
    </div>
  );
});

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

// ─── Trailer Documents Section ────────────────────────────────────────────────

const TRAILER_DOC_KINDS: { key: TrailerDocumentKind; label: string }[] = [
  { key: 'registration', label: 'Registration' },
  { key: 'inspection',   label: 'Annual Inspection' },
  { key: 'insurance',    label: 'Insurance' },
  { key: 'title',        label: 'Title' },
  { key: 'other',        label: 'Other' },
];

function TrailerDocumentsSection({ trailerId, accent, canEdit }: {
  trailerId: number;
  accent: string;
  canEdit: boolean;
}) {
  const [documents, setDocuments]         = useState<TrailerDocument[]>([]);
  const [loading, setLoading]             = useState(true);
  const [uploadingKind, setUploadingKind] = useState<TrailerDocumentKind | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await railway.listTrailerDocuments(trailerId);
        if (alive) setDocuments(res.documents);
      } catch (err) {
        console.warn('[TrailersModal] load documents:', err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [trailerId]);

  async function uploadDoc(kind: TrailerDocumentKind, file: File) {
    setUploadingKind(kind);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      await railway.uploadTrailerDocument(trailerId, form);
      const res = await railway.listTrailerDocuments(trailerId);
      setDocuments(res.documents);
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploadingKind(null);
    }
  }

  async function deleteDoc(docId: string) {
    if (!confirm('Delete this document?')) return;
    try {
      await railway.deleteTrailerDocument(docId);
      setDocuments(docs => docs.filter(d => d.id !== docId));
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="mb-8">
      <div className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--gc-text-3)' }}>
        Documents
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--gc-text-3)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {TRAILER_DOC_KINDS.map((k, idx) => {
            const forKind = documents.filter(d => d.kind === k.key);
            return (
              <div key={k.key}
                style={{ paddingTop: idx === 0 ? 0 : 12, borderTop: idx === 0 ? 'none' : '1px solid var(--gc-border-light)' }}>
                <div className="flex items-center mb-2">
                  <span className="text-sm font-semibold flex-1" style={{ color: 'var(--gc-text-1)' }}>{k.label}</span>
                  {canEdit && (
                    <label
                      className="text-xs font-semibold px-2.5 py-1 rounded-lg cursor-pointer flex items-center gap-1"
                      style={{ background: 'var(--gc-blue-light)', color: accent, opacity: uploadingKind === k.key ? 0.6 : 1 }}>
                      {uploadingKind === k.key ? <Loader2 size={11} className="animate-spin" /> : '+'} Upload
                      <input type="file" hidden
                        accept="image/*,application/pdf"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (f) await uploadDoc(k.key, f);
                          (e.currentTarget as HTMLInputElement).value = '';
                        }} />
                    </label>
                  )}
                </div>
                {forKind.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>None uploaded.</div>
                ) : (
                  <div className="space-y-1.5">
                    {forKind.map(d => (
                      <div key={d.id}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg"
                        style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                        <span className="text-xs truncate flex-1" style={{ color: 'var(--gc-text-1)' }}>{d.fileName}</span>
                        <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          {new Date(d.uploadedAt).toLocaleDateString()}
                        </span>
                        {d.signedUrl && (
                          <a href={d.signedUrl} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-medium" style={{ color: accent }}>View</a>
                        )}
                        {canEdit && (
                          <button onClick={() => deleteDoc(d.id)}
                            className="text-xs font-medium" style={{ color: '#b91c1c' }}>Delete</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
