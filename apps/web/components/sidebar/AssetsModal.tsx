'use client';

import { useState } from 'react';
import { X, Truck, Clock, Plus, Check, Trash2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { PRESET_COLORS } from '@/lib/asset-colors';
import LoadHistorySection from './LoadHistorySection';
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
  const { assets: allAssets, assetCategories, drivers, events, openEditModal, addAsset, removeAsset, unassignedAssetId } = useCalendarStore();
  const assets = allAssets.filter(a => a.id !== unassignedAssetId);

  const [selected, setSelected] = useState<number>(
    initialAssetId && assets.some(a => a.id === initialAssetId)
      ? initialAssetId
      : (assets.length > 0 ? assets[0].id : -1)
  );
  const [adding, setAdding] = useState(false);

  // Click + Add Asset → create a placeholder asset server-side and
  // select it. AssetProfilePanel opens with empty fields; user fills
  // them in and they auto-save on blur. To discard, click Delete at
  // the bottom of the profile panel.
  const handleAdd = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const newId = await addAsset({
        name:  '',
        color: PRESET_COLORS[assets.length % PRESET_COLORS.length],
        type:  assetCategories[0] ?? 'OTR',
        hidden: false,
        sortOrder: 0,
      });
      setSelected(newId);
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
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
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
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors"
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

            <div className="shrink-0 px-4 pt-5 pb-1">
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: 'var(--gc-text-3)' }}>
                Assets
              </span>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {assets.length === 0 && (
                <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
                  No assets yet.
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

              <button
                onClick={() => void handleAdd()}
                disabled={adding}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold mt-1 transition-colors disabled:opacity-50"
                style={{ color: 'var(--gc-blue)', background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
                onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={13} />
                {adding ? 'Adding…' : 'Add Asset'}
              </button>
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
                  const remaining = assets.filter(a => a.id !== selectedAsset.id);
                  removeAsset(selectedAsset.id);
                  setSelected(remaining.length > 0 ? remaining[0].id : -1);
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
          <button onClick={onClose}
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
        <div className="text-sm font-medium truncate"
          style={{ color: selected ? 'var(--gc-blue)' : 'var(--gc-text-1)' }}>
          {asset.name}
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

function AssetProfilePanel({ asset, events, drivers, openEditModal, onRemove }: {
  asset: Asset;
  events: CalendarEvent[];
  drivers: Driver[];
  openEditModal: (id: string) => void;
  onRemove: () => void;
}) {
  const { updateAsset, assetCategories } = useCalendarStore();

  const [name,            setName]            = useState(asset.name);
  const [unit,            setUnit]            = useState(asset.unit            ?? '');
  const [truck,           setTruck]           = useState(asset.truck           ?? '');
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
            {asset.type}{asset.truck ? ` · ${asset.truck}` : ''}
          </div>
        </div>
      </div>

      {/* Profile fields */}
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4"
          style={{ color: 'var(--gc-text-3)' }}>
          Profile
        </div>

        {/* Name + Unit */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Asset Name">
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

        {/* Truck + Category */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <PField label="Truck">
            <input type="text" value={truck} onChange={e => setTruck(e.target.value)}
              placeholder="e.g. 2024 Freightliner" style={P_INPUT}
              onFocus={focusBorder}
              onBlur={e => {
                const v = e.target.value.trim();
                setTruck(v);
                save({ truck: v || undefined });
                blurBorder(e);
              }} />
          </PField>
          <PField label="Category">
            <select value={type} onChange={e => { setType(e.target.value); save({ type: e.target.value }); }}
              style={{ ...P_INPUT, cursor: 'pointer', height: 42, padding: '0 12px' }}
              onFocus={focusBorder} onBlur={blurBorder}>
              {assetCategories.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </PField>
        </div>

        {/* Color */}
        <div className="mb-4">
          <PField label="Color">
            <div className="flex flex-wrap gap-2 pt-1">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(c); save({ color: c }); }}
                  className="w-7 h-7 rounded-full transition-all"
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
            placeholder="Add notes about this asset…" rows={3}
            style={{ ...P_INPUT, resize: 'vertical', paddingTop: 10, paddingBottom: 10, lineHeight: '1.5', fontFamily: 'inherit' }}
            onFocus={focusBorder}
            onBlur={e => {
              const v = e.target.value.trim();
              setNotes(v);
              save({ notes: v || undefined });
              blurBorder(e);
            }} />
        </PField>

        {/* Motive integration */}
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
      </div>

      {/* Recent loads — In Progress / Upcoming / Completed with search.
          Same structure as BrokerProfileModal's load history surface. */}
      <LoadHistorySection
        loads={assetLoads}
        assets={[asset]}
        onSelect={openEditModal}
        heading="Loads"
        emptyLabel="No loads found for this asset"
      />

      {/* Delete */}
      <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
              Remove <strong>{asset.name}</strong>? This cannot be undone.
            </span>
            <button
              onClick={onRemove}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
              style={{ background: '#d93025' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
              Remove
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
            Delete Asset
          </button>
        )}
      </div>
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
