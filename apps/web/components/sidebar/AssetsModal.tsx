'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Truck, Clock, Plus, Check, Trash2, Fuel, Wrench, ExternalLink, Loader2 } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { AssetDocument, AssetDocumentKind } from '@fleetcal/types';
import Link from 'next/link';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { formatHardDeleteError } from '@/lib/hardDeleteError';
import { PRESET_COLORS } from '@/lib/asset-colors';
import LoadHistorySection from './LoadHistorySection';
import LifecycleEditor from './LifecycleEditor';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import type { Asset, CalendarEvent, Driver } from '@/lib/types';

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  scheduled:  { label: 'Scheduled',  color: '#1a73e8', bg: '#e8f0fe' },
  assigned:   { label: 'Assigned',   color: '#5b21b6', bg: '#ede9fe' },
  dispatched: { label: 'Dispatched', color: '#1558d6', bg: '#e8f0fe' },
  en_route:   { label: 'En Route',   color: '#e37400', bg: '#fef3e2' },
  picked_up:  { label: 'Picked Up',  color: '#7b1fa2', bg: '#f3e5f5' },
  delivered:  { label: 'Delivered',  color: '#188038', bg: '#e6f4ea' },
  cancelled:  { label: 'Cancelled',  color: '#d93025', bg: '#fce8e6' },
};

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

export default function AssetsModal({ onClose, initialAssetId }: { onClose: () => void; initialAssetId?: number }) {
  const { assets: allAssets, assetCategories, drivers, events, openEditModal, addAsset, removeAsset, hardDeleteAsset, unassignedAssetId } = useCalendarStore();
  // Drop the 'Unassigned' bucket, then sort retired trucks to the
  // bottom so the directory leads with everything currently in service.
  const today = dateKeyOf(new Date());
  const assets = [
    ...allAssets.filter(a => a.id !== unassignedAssetId &&  isActiveOn(a, today)),
    ...allAssets.filter(a => a.id !== unassignedAssetId && !isActiveOn(a, today)),
  ];

  const [selected, setSelectedRaw] = useState<number>(
    initialAssetId && assets.some(a => a.id === initialAssetId)
      ? initialAssetId
      : (assets.length > 0 ? assets[0].id : -1)
  );
  const [adding, setAdding] = useState(false);

  // Track the id of the row we created via "+ Add Asset" as a
  // placeholder. If the user navigates away (selection change, close,
  // unmount) without entering a real name, that row gets removed so
  // we don't leave "New asset" sitting in the directory.
  const draftIdRef = useRef<number | null>(null);

  const cleanupDraft = () => {
    const id = draftIdRef.current;
    if (id == null) return;
    draftIdRef.current = null;
    // Read fresh store state in case the user typed something we
    // should preserve. If the row was already deleted explicitly,
    // .find returns undefined and we skip.
    const fresh = useCalendarStore.getState().assets.find(a => a.id === id);
    if (fresh && fresh.name === 'New truck' && !fresh.unit && !fresh.truck && !fresh.notes) {
      removeAsset(id);
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

  // Click + Add Asset → create a placeholder asset server-side and
  // select it. AssetProfilePanel opens with empty fields; user fills
  // them in and they auto-save on blur. If the user navigates away
  // without filling anything in, the placeholder is auto-removed.
  const handleAdd = async () => {
    if (adding) return;
    cleanupDraft(); // drop any stranded draft from a previous click
    setAdding(true);
    try {
      // API requires non-empty name on create. Seed with "New asset"
      // so the call validates; the profile panel opens with the name
      // field focused so the dispatcher just types their real name
      // and the placeholder disappears.
      const newId = await addAsset({
        name:  'New truck',
        color: PRESET_COLORS[assets.length % PRESET_COLORS.length],
        type:  assetCategories[0] ?? 'OTR',
        hidden: false,
        sortOrder: 0,
        // Org-wide default lifecycle start. The server's todayUtcDateKey()
        // fallback was correct for orgs being onboarded mid-year, but
        // this fleet's records all started 2026-01-01 — overriding here
        // means every new truck shows up in reports from that date
        // forward instead of "today" (which would zero out historical
        // metrics that span the create date).
        activeFrom: '2026-01-01',
      });
      draftIdRef.current = newId;
      setSelectedRaw(newId);
    } catch (err) {
      console.error('add asset failed:', err);
    } finally {
      setAdding(false);
    }
  };

  const selectedAsset = assets.find(a => a.id === selected) ?? null;

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
            <Truck size={17} style={{ color: 'var(--gc-blue)' }} />
            <span className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Asset Directory
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

            {/* Section header — title on the left, + button inline on
                the right. Saves a row of scroll real estate and gives
                the action the prominence dispatchers expect (matches
                the standard sidebar pattern). */}
            <div className="shrink-0 flex items-center justify-between px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--gc-text-3)' }}>
                Assets
              </span>
              <button
                onClick={() => void handleAdd()}
                disabled={adding}
                title="Add truck"
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50"
                style={{ color: 'var(--gc-blue)', background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
                onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={12} />
                {adding ? 'Adding…' : 'Truck'}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {assets.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
                  No trucks yet.
                </p>
              )}
              {assets.map(a => (
                <NavAssetRow
                  key={a.id}
                  asset={a}
                  selected={selected === a.id}
                  onSelect={() => setSelected(a.id)}
                />
              ))}
            </div>
          </div>

          {/* ── Right Panel ── */}
          <div className="flex-1 overflow-y-auto">
            {selectedAsset ? (
              <AssetProfilePanel
                key={selectedAsset.id}
                asset={selectedAsset}
                events={events}
                drivers={drivers}
                openEditModal={openEditModal}
                onRemove={() => {
                  // Explicit delete — clear draft tracking so cleanup
                  // doesn't try to double-remove an already-gone row.
                  if (draftIdRef.current === selectedAsset.id) draftIdRef.current = null;
                  const remaining = assets.filter(a => a.id !== selectedAsset.id);
                  removeAsset(selectedAsset.id);
                  setSelectedRaw(remaining.length > 0 ? remaining[0].id : -1);
                }}
                onHardDelete={async () => {
                  if (draftIdRef.current === selectedAsset.id) draftIdRef.current = null;
                  const remaining = assets.filter(a => a.id !== selectedAsset.id);
                  try {
                    await hardDeleteAsset(selectedAsset.id);
                    setSelectedRaw(remaining.length > 0 ? remaining[0].id : -1);
                  } catch (err) {
                    // 409 from API when references exist on tables we
                    // don't track locally (fuel reports, etc.). The
                    // API returns a per-table breakdown; surface it.
                    alert(formatHardDeleteError('asset', err));
                  }
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm"
                style={{ color: 'var(--gc-text-3)' }}>
                Select an asset
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

// ─── Nav Asset Row ────────────────────────────────────────────────────────────

function NavAssetRow({ asset, selected, onSelect }: {
  asset: Asset;
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
        style={{ background: asset.color }}
      >
        <Truck size={13} color="white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium truncate"
            style={{ color: selected ? 'var(--gc-blue)' : 'var(--gc-text-1)' }}>
            {asset.name}
          </div>
          {/* Retired pill — asset.activeTo has been set to a date that's
              already in the past. Shown inline next to the name so the
              dispatcher can scan the directory and immediately tell
              which trucks are no longer on the calendar. Future-dated
              activeTo (scheduled retirement) is intentionally NOT
              flagged here — the asset is still in service until that
              date. */}
          {!isActiveOn(asset, dateKeyOf(new Date())) && (
            <span
              className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded"
              style={{ background: '#fee2e2', color: '#991b1b', letterSpacing: '0.5px' }}
              title={asset.activeTo ? `Retired ${asset.activeTo}` : 'Retired'}
            >
              Retired
            </span>
          )}
        </div>
        {asset.unit && (
          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
            #{asset.unit}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Asset Profile Panel ──────────────────────────────────────────────────────

function AssetProfilePanel({ asset, events, drivers, openEditModal, onRemove, onHardDelete }: {
  asset: Asset;
  events: CalendarEvent[];
  drivers: Driver[];
  openEditModal: (id: string) => void;
  onRemove: () => void;
  onHardDelete: () => void;
}) {
  const { updateAsset, assetCategories, deletedEvents } = useCalendarStore();
  const { can: canDo } = usePermissions();
  const canDelete = canDo('assets.delete');
  const canEdit   = canDo('assets.edit');
  // Module gates — hide Motive-only / Fuel / Maintenance affordances
  // when the org doesn't have those modules. MVP orgs see a cleaner
  // truck profile without ELD-integration plumbing or Equipment links.
  const { enabled: moduleEnabled } = useModules();
  const showMotiveField  = moduleEnabled('motive_integration');
  const showFuelLink     = moduleEnabled('fuel');
  const showMaintLink    = moduleEnabled('maintenance');
  const showEquipmentRow = showFuelLink || showMaintLink;
  // Hard delete is only safe when there are no loads referencing this
  // asset (events.asset_id has ON DELETE RESTRICT). We count both live
  // events AND soft-deleted ones — the FK constraint doesn't care
  // about deleted_at, it cares about row existence.
  const loadsAttached =
    events.filter(e => e.assetId === asset.id).length +
    deletedEvents.filter(e => e.assetId === asset.id).length;

  const [name,            setName]            = useState(asset.name);
  const [unit,            setUnit]            = useState(asset.unit            ?? '');
  // Make + Model replace the old single free-text `truck` field. The
  // DB column for `truck` is still around for backward compat but no
  // longer rendered or edited from this UI. If a future read needs
  // the legacy value, asset.truck is still available off the store.
  const [make,              setMake]              = useState(asset.make              ?? '');
  const [model,             setModel]             = useState(asset.model             ?? '');
  const [vin,               setVin]               = useState(asset.vin               ?? '');
  const [licensePlate,      setLicensePlate]      = useState(asset.licensePlate      ?? '');
  const [licenseState,      setLicenseState]      = useState(asset.licenseState      ?? '');
  const [licenseExpiration, setLicenseExpiration] = useState(asset.licenseExpiration ?? '');
  const [type,            setType]            = useState(asset.type);
  const [notes,           setNotes]           = useState(asset.notes           ?? '');
  const [color,           setColor]           = useState(asset.color);
  const [motiveVehicleId,     setMotiveVehicleId]     = useState(asset.motiveVehicleId ?? '');
  const [motiveEditing,       setMotiveEditing]       = useState(false);
  const [motiveDraft,         setMotiveDraft]         = useState(asset.motiveVehicleId ?? '');
  const [confirmDelete,       setConfirmDelete]       = useState(false);

  const save = (updates: Partial<Omit<Asset, 'id'>>) =>
    updateAsset(asset.id, updates);

  const focusBorder = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    (e.currentTarget.style.borderColor = color);
  const blurBorder  = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    (e.currentTarget.style.borderColor = 'var(--gc-border)');

  // Loads attached to this asset. LoadHistorySection handles
  // sort/group/clip; pass the full unsliced list.
  const assetLoads = events.filter(ev => ev.assetId === asset.id);

  return (
    <div className="px-8 py-7">

      {/* Header */}
      <div className="flex items-center gap-5 mb-8">
        <div
          className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: color }}
        >
          <Truck size={28} color="white" />
        </div>
        <div>
          <div className="text-xl font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {asset.name}{asset.unit ? ` #${asset.unit}` : ''}
          </div>
          <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
            {/* Header sub-line: category + make/model. Prefer the new
                make + model fields; fall back to the legacy `truck`
                free-text for rows not yet backfilled. */}
            {asset.type}{(() => {
              const mm = [asset.make, asset.model].filter(Boolean).join(' ');
              const display = mm || asset.truck;
              return display ? ` · ${display}` : '';
            })()}
          </div>
        </div>
      </div>

      {/* Read-only notice for roles (e.g. maintenance) that have
          assets.view but not assets.edit. The fieldset below disables
          all form controls; this banner explains why. */}
      {!canEdit && (
        <div style={{
          padding: '10px 14px',
          marginBottom: 24,
          background: '#fef3c7',
          border: '1px solid #fde68a',
          borderRadius: 10,
          color: '#92400e',
          fontSize: 13,
          fontWeight: 600,
        }}>
          Read-only — your role can view this asset but can&apos;t make changes.
        </div>
      )}

      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
      {/* Profile fields */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4"
          style={{ color: 'var(--gc-text-3)' }}>
          Profile
        </div>

        {/* Name + Unit */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Truck Name">
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Name" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                if (v) { setName(v); save({ name: v }); }
                blurBorder(e);
              }} />
          </PField>
          <PField label="Unit #">
            <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
              placeholder="e.g. 2024" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setUnit(v);
                save({ unit: v || undefined });
                blurBorder(e);
              }} />
          </PField>
        </div>

        {/* Make + Model — replaces the single free-text "Make/Model"
            input. Splitting these out lets future surfaces filter or
            group by manufacturer (e.g. maintenance "Cascadia issues"
            view), and matches every fleet-management UI dispatchers
            are used to seeing. */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Make">
            <input type="text" value={make} onChange={e => setMake(e.target.value)}
              placeholder="e.g. Freightliner" style={P_INPUT}
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
              placeholder="e.g. Cascadia" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setModel(v);
                save({ model: v || undefined });
                blurBorder(e);
              }} />
          </PField>
        </div>

        {/* VIN + License Plate — both are critical for maintenance
            shop intake (VIN) and toll / DMV correspondence (plate).
            Both columns are indexed for fast lookup. */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="VIN">
            <input type="text" value={vin} onChange={e => setVin(e.target.value)}
              placeholder="17-character VIN" style={P_INPUT}
              maxLength={17}
              onFocus={focusBorder}
              onBlur={e => {
                // VINs are conventionally uppercase, no spaces.
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

        {/* License State + Expiration — IRP-apportioned plates and
            state-specific renewal cycles vary by truck. Same shape
            as the trailer fields for visual parity. */}
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

        {/* Category */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Category">
            <select value={type} onChange={e => { setType(e.target.value); save({ type: e.target.value }); }}
              style={{ ...P_INPUT, cursor: 'pointer', height: 42, padding: '0 12px' }}
              onFocus={focusBorder} onBlur={blurBorder}>
              {assetCategories.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </PField>
        </div>

        {/* Color — fixed 10-column grid so the 20 colors always render
            as two even rows of 10, regardless of container width. */}
        <div className="mb-4">
          <PField label="Color">
            <div className="grid gap-2 pt-1"
              style={{ gridTemplateColumns: 'repeat(10, minmax(0, 1fr))' }}>
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(c); save({ color: c }); }}
                  className="w-7 h-7 rounded-full transition-all justify-self-center"
                  style={{
                    background: c,
                    outline: color === c ? `3px solid ${c}` : '3px solid transparent',
                    outlineOffset: 2,
                    transform: color === c ? 'scale(1.1)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          </PField>
        </div>

        {/* Notes */}
        <PField label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Add notes about this truck…" rows={3}
            style={{ ...P_INPUT, resize: 'vertical', paddingTop: 10, paddingBottom: 10, lineHeight: '1.5', fontFamily: 'inherit' }}
            onFocus={focusBorder}
            onBlur={e => {
              const v = e.target.value.trim();
              setNotes(v);
              save({ notes: v || undefined });
              blurBorder(e);
            }} />
        </PField>

        {/* Motive integration — only when the org has motive_integration ON */}
        {showMotiveField && (
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
                style={{ background: color, color: '#fff', border: 'none', cursor: 'pointer' }}
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
        )}
      </div>

      {/* Quick links to the truck-scoped views on the Fuel and
          Maintenance pages. Each pre-fills its respective filter via
          ?asset=<name> so the dispatcher lands on a filtered table.
          Hidden entirely when both modules are OFF (MVP). When only
          one is on, only that card renders. */}
      {showEquipmentRow && (
      <div className={showFuelLink && showMaintLink ? "grid grid-cols-2 gap-3 mb-8" : "grid grid-cols-1 gap-3 mb-8"}>
        {showFuelLink && (
        <Link
          href={`/fuel?asset=${encodeURIComponent(asset.name)}`}
          className="flex items-center gap-2 px-4 py-3 rounded-xl transition-colors"
          style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)', textDecoration: 'none' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
          <div className="flex items-center justify-center rounded-lg shrink-0"
            style={{ width: 32, height: 32, background: 'var(--gc-blue-light)', color: 'var(--gc-blue)' }}>
            <Fuel size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold" style={{ color: 'var(--gc-text-1)' }}>Fuel Reports</div>
            <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>All fuel transactions</div>
          </div>
          <ExternalLink size={13} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
        </Link>
        )}
        {showMaintLink && (
        <Link
          href={`/maintenance?asset=${encodeURIComponent(asset.name)}`}
          className="flex items-center gap-2 px-4 py-3 rounded-xl transition-colors"
          style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)', textDecoration: 'none' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
          <div className="flex items-center justify-center rounded-lg shrink-0"
            style={{ width: 32, height: 32, background: '#fef3e2', color: '#b85c00' }}>
            <Wrench size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold" style={{ color: 'var(--gc-text-1)' }}>Maintenance</div>
            <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>Reports & action items</div>
          </div>
          <ExternalLink size={13} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
        </Link>
        )}
      </div>
      )}

      {/* Documents — registration, inspection, insurance, title, other.
          Per-kind upload + list mirrors the driver-docs pattern so the
          UX is consistent across the truck/driver/trailer directories. */}
      <AssetDocumentsSection assetId={asset.id} accent={color} canEdit={canEdit} />

      </fieldset>

      {/* Recent loads — In Progress / Upcoming / Completed with search.
          Same structure as BrokerProfileModal's load history surface. */}
      <LoadHistorySection
        loads={assetLoads}
        assets={[asset]}
        onSelect={openEditModal}
        heading="Loads"
        emptyLabel="No loads found for this asset"
      />

      {/* Lifecycle editor — set/edit the active_from and retire date.
          Bookkeeping fixes happen here; the Retire button below is the
          one-tap "retire today" shortcut. Both write to the same
          fields. Gated on assets.edit (not delete) because backdating
          active_from is a correction, not a destructive action. */}
      <LifecycleEditor
        activeFrom={asset.activeFrom}
        activeTo={asset.activeTo}
        accent={color}
        canEdit={canEdit}
        onSave={(changes) => save(changes)}
      />

      {/* Retire — gated on assets.delete. Underlying API now stamps
          active_to = today rather than hard-deleting; historical loads
          stay attached. Skipped when already retired (the lifecycle
          editor above shows the retire date in that case). */}
      {canDelete && !asset.activeTo && (
      <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
              Retire <strong>{asset.name}</strong>? It'll drop off the calendar starting today. Existing loads stay attached and you can review them in history.
            </span>
            <button
              onClick={onRemove}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
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
            Retire Asset
          </button>
        )}
      </div>
      )}

      {/* Permanent delete — always visible (no more hiding when loads
          exist). When references are detected the button shows
          disabled with the local blocker hint; the API does a real
          pre-flight count on EVERY related table, so it's the source
          of truth even if our local hint missed something. */}
      {canDelete && (
        <PermanentDeleteBlock
          label={asset.name}
          onConfirm={onHardDelete}
          localBlockerHint={loadsAttached > 0
            ? `${loadsAttached} load${loadsAttached === 1 ? '' : 's'} attached`
            : null}
        />
      )}
    </div>
  );
}

/** Two-step destructive confirm — click to arm, type the name, click
 *  again to fire. When `localBlockerHint` is set, the button is
 *  disabled and the hint is shown inline. */
function PermanentDeleteBlock({ label, onConfirm, localBlockerHint }: {
  label: string;
  onConfirm: () => void | Promise<void>;
  localBlockerHint: string | null;
}) {
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const ready    = armed && typed.trim() === label.trim();
  const blocked  = localBlockerHint != null;
  return (
    <div className="mt-6 pt-6" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-2"
        style={{ color: 'var(--gc-text-3)' }}>
        Danger zone
      </div>
      {!armed ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => { if (!blocked) setArmed(true); }}
            disabled={blocked}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
            style={{ color: '#7a1d18', border: '1px solid rgba(217,48,37,0.4)', cursor: blocked ? 'not-allowed' : 'pointer' }}
            onMouseEnter={e => { if (!blocked) e.currentTarget.style.background = 'rgba(217,48,37,0.08)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Trash2 size={14} />
            Delete permanently
          </button>
          {blocked && (
            <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
              {localBlockerHint} — retire instead to keep history.
            </span>
          )}
        </div>
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
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
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

// ─── Asset Documents Section ──────────────────────────────────────────────────

/** Per-truck document attachments. Mirrors the DriversModal pattern:
 *  one row per document kind, with an inline upload button and a list
 *  of attached files (file name + uploaded date + View + Delete). */
const ASSET_DOC_KINDS: { key: AssetDocumentKind; label: string }[] = [
  { key: 'registration', label: 'Registration' },
  { key: 'inspection',   label: 'Annual Inspection' },
  { key: 'insurance',    label: 'Insurance' },
  { key: 'title',        label: 'Title' },
  { key: 'other',        label: 'Other' },
];

function AssetDocumentsSection({ assetId, accent, canEdit }: {
  assetId: number;
  accent: string;
  canEdit: boolean;
}) {
  const [documents, setDocuments]     = useState<AssetDocument[]>([]);
  const [loading, setLoading]         = useState(true);
  const [uploadingKind, setUploadingKind] = useState<AssetDocumentKind | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await railway.listAssetDocuments(assetId);
        if (alive) setDocuments(res.documents);
      } catch (err) {
        console.warn('[AssetsModal] load documents:', err);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [assetId]);

  async function uploadDoc(kind: AssetDocumentKind, file: File) {
    setUploadingKind(kind);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      await railway.uploadAssetDocument(assetId, form);
      const res = await railway.listAssetDocuments(assetId);
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
      await railway.deleteAssetDocument(docId);
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
          {ASSET_DOC_KINDS.map((k, idx) => {
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
