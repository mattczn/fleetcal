'use client';

import { useState, useRef } from 'react';
import { Plus, Layers, Truck, Users, Pencil, GripVertical, Menu, Settings } from 'lucide-react';
import Link from 'next/link';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore, BatchItem } from '@/store/useCalendarStore';
import { buildBrokerRules } from '@/lib/customerMatch';
import EditAssetDialog from './EditAssetDialog';
import DriversModal from './DriversModal';
import AssetsModal from './AssetsModal';
import MiniCalendar from './MiniCalendar';
import type { Asset } from '@/lib/types';

function CheckboxSwatch({ color, hidden, onToggle }: { color: string; hidden: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onToggle(); }}
      className="w-4 h-4 rounded shrink-0 flex items-center justify-center transition-all"
      style={{ backgroundColor: hidden ? 'transparent' : color, border: hidden ? `2px solid ${color}` : 'none' }}
      title={hidden ? 'Show column' : 'Hide column'}
    >
      {!hidden && (
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4l3 3 5-6" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </button>
  );
}

export default function AssetSidebar() {
  const { assets: allAssets, reorderAssets, openCreateModal, sidebarOpen, toggleSidebar, toggleAssetVisibility, assetCategories, activeCategoryFilter, setActiveCategoryFilter, startBatch, setBatchParseState, clearBatch, fieldSettings, promptInstructions, promptVariables, unassignedAssetId, showUnassigned, dbReady } = useCalendarStore();
  const assets = allAssets.filter(a => a.id !== unassignedAssetId);
  const unassignedAsset = showUnassigned && unassignedAssetId !== null ? allAssets.find(a => a.id === unassignedAssetId) ?? null : null;
  const { organization } = useOrganization();
  const [showDrivers, setShowDrivers] = useState(false);
  const [showAssets,  setShowAssets]  = useState(false);
  const [batchHovered, setBatchHovered] = useState(false);
  const batchFileInputRef = useRef<HTMLInputElement>(null);

  const handleBatchFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    setBatchParseState(0, fileArray.length);
    const items: BatchItem[] = [];
    for (let i = 0; i < fileArray.length; i++) {
      if (useCalendarStore.getState().batchCancelRequested) {
        setBatchParseState(0, 0);
        clearBatch();
        return;
      }
      const file = fileArray[i];
      if (file.type !== 'application/pdf') { setBatchParseState(i + 1, fileArray.length); continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      try {
        const res = await fetch('/api/parse-ratecon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: base64,
            enabledFields: Object.keys(fieldSettings).filter(k => fieldSettings[k]),
            customInstructions: promptInstructions,
            promptVariables,
            customers: useCalendarStore.getState().customers.map(c => ({
              name: c.name, aliases: c.aliases ?? [], parseHints: c.parseHints,
            })),
          }),
        });
        const json = await res.json();
        items.push({ rateConPdf: dataUrl, parsed: json.error ? {} : json });
      } catch {
        items.push({ rateConPdf: dataUrl, parsed: {} });
      }
      setBatchParseState(i + 1, fileArray.length);
    }

    if (useCalendarStore.getState().batchCancelRequested) {
      setBatchParseState(0, 0);
      clearBatch();
      return;
    }

    const wasMinimized = useCalendarStore.getState().batchMinimized;
    setBatchParseState(0, 0);
    if (items.length > 0) {
      startBatch(items);
      // Only auto-open if the user left the overlay up (didn't click Keep Working)
      if (!wasMinimized) {
        openCreateModal();
      }
    }
  };

  // Drag state — tracked by asset ID to avoid index mismatch with filtered list
  const dragId = useRef<number | null>(null);
  const [overAssetId, setOverAssetId] = useState<number | null>(null);

  const handleDragStart = (id: number) => { dragId.current = id; };
  const handleDragOver  = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    if (dragId.current !== null && dragId.current !== id) setOverAssetId(id);
  };
  const handleDrop = (id: number) => {
    if (dragId.current !== null && dragId.current !== id) reorderAssets(dragId.current, id);
    dragId.current = null;
    setOverAssetId(null);
  };
  const handleDragEnd = () => { dragId.current = null; setOverAssetId(null); };

  return (
    <>
      <aside
        data-tour="sidebar"
        className="flex flex-col h-full shrink-0 overflow-hidden"
        style={{
          background: 'var(--gc-surface)',
          width: sidebarOpen ? 256 : 0,
          borderRight: sidebarOpen ? '1px solid var(--gc-border)' : 'none',
          transition: 'width 200ms ease, border 200ms ease',
        }}
      >
        {/* Branding header — aligns with toolbar height */}
        <div
          className="shrink-0 flex items-center gap-2 px-3"
          style={{ height: 64, borderBottom: '1px solid var(--gc-border)' }}
        >
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2">
            {organization?.imageUrl
              ? <img src={organization.imageUrl} alt="" className="w-8 h-8 rounded-lg shrink-0 object-cover" />
              : <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-bold shrink-0" style={{ background: 'var(--gc-blue)' }}>D</div>
            }
            <span
              className="text-[20px] font-normal tracking-tight whitespace-nowrap"
              style={{ color: 'var(--gc-text-2)', letterSpacing: '-0.3px' }}
            >
              Dispatch
            </span>
          </div>
        </div>

        {/* New Load / Batch Import split button */}
        <div className="px-4 pb-3 shrink-0" style={{ paddingTop: 20, position: 'relative' }}>
          <div data-tour="new-load-area" className="flex rounded-2xl overflow-hidden text-sm font-medium"
            style={{ boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
            <button
              onClick={() => openCreateModal()}
              className="flex items-center gap-2.5 pl-5 pr-4 py-3.5 flex-1 transition-colors"
              style={{ color: 'var(--gc-text-1)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Plus size={22} style={{ color: 'var(--gc-blue)' }} strokeWidth={2} />
              <span>New Load</span>
            </button>
            <div style={{ width: 1, background: 'var(--gc-border-light)', alignSelf: 'stretch' }} />
            <button
              onClick={() => batchFileInputRef.current?.click()}
              className="flex items-center justify-center px-3.5 transition-colors"
              style={{ color: 'var(--gc-text-3)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-blue)'; setBatchHovered(true); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; setBatchHovered(false); }}
            >
              <Layers size={16} />
            </button>
            <input
              ref={batchFileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const files = e.target.files;
                if (files && files.length > 10) { alert('Batch import is limited to 10 PDFs at a time.'); e.target.value = ''; return; }
                handleBatchFiles(files);
                e.target.value = '';
              }}
            />
          </div>
          {batchHovered && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% - 6px)', right: 16,
              background: 'rgba(0,0,0,0.72)', color: 'white',
              fontSize: 11, fontWeight: 600, padding: '3px 8px',
              borderRadius: 6, whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              Batch Upload
            </div>
          )}
        </div>

        {/* Mini calendar */}
        <div className="shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <MiniCalendar />
        </div>

        {/* Category filter chips */}
        {assetCategories.length > 0 && (
          <div
            className="shrink-0 flex gap-1.5 px-3 py-2 overflow-x-auto"
            style={{ borderBottom: '1px solid var(--gc-border-light)', scrollbarWidth: 'none' }}
          >
            <button
              onClick={() => setActiveCategoryFilter(null)}
              className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
              style={{
                background: activeCategoryFilter === null ? 'var(--gc-blue-light)' : 'transparent',
                color:      activeCategoryFilter === null ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                border: `1px solid ${activeCategoryFilter === null ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
              }}
            >
              All
            </button>
            {assetCategories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategoryFilter(activeCategoryFilter === cat ? null : cat)}
                className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                style={{
                  background: activeCategoryFilter === cat ? 'var(--gc-blue-light)' : 'transparent',
                  color:      activeCategoryFilter === cat ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                  border: `1px solid ${activeCategoryFilter === cat ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Asset list — flat + draggable */}
        <div className="flex-1 overflow-y-auto py-1">
          {unassignedAsset && (
            <UnassignedRow asset={unassignedAsset} />
          )}
          {assets.length === 0 && !unassignedAsset && !dbReady && (
            <div className="flex flex-col gap-1 px-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-2 rounded-md">
                  <div className="skeleton-pulse rounded-full" style={{ width: 26, height: 26 }} />
                  <div className="flex-1 flex flex-col gap-1.5">
                    <div className="skeleton-pulse rounded" style={{ height: 9, width: '60%' }} />
                    <div className="skeleton-pulse rounded" style={{ height: 7, width: '38%' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {assets.length === 0 && !unassignedAsset && dbReady && (
            <div className="flex flex-col items-center gap-3 py-10" style={{ color: 'var(--gc-text-3)' }}>
              <Truck size={26} style={{ opacity: 0.35 }} />
              <span className="text-sm">No assets yet</span>
            </div>
          )}
          {assets.filter(a => activeCategoryFilter === null || a.type === activeCategoryFilter).map((asset) => (
            <AssetRow
              key={asset.id}
              asset={asset}
              isOver={overAssetId === asset.id}
              onDragStart={() => handleDragStart(asset.id)}
              onDragOver={e => handleDragOver(e, asset.id)}
              onDrop={() => handleDrop(asset.id)}
              onDragEnd={handleDragEnd}
              onToggleVisibility={() => toggleAssetVisibility(asset.id)}
            />
          ))}
        </div>

        {/* Manage buttons */}
        <div className="shrink-0 p-3 space-y-0.5" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button
            onClick={() => setShowAssets(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Truck size={16} />
            Manage assets
          </button>
          <button
            onClick={() => setShowDrivers(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Users size={16} />
            Manage drivers
          </button>
          <Link
            href="/settings"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Settings size={16} />
            Settings
          </Link>
        </div>
      </aside>

      {showAssets  && <AssetsModal    onClose={() => setShowAssets(false)} />}
      {showDrivers && <DriversModal   onClose={() => setShowDrivers(false)} />}
    </>
  );
}

interface RowProps {
  asset: Asset;
  isOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onToggleVisibility: () => void;
}

function AssetRow({ asset, isOver, onDragStart, onDragOver, onDrop, onDragEnd, onToggleVisibility }: RowProps) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        className="flex items-center gap-2 px-2 py-2 transition-colors select-none"
        style={{
          background: hovered ? 'var(--gc-hover)' : 'transparent',
          cursor: 'default',
          borderTop: isOver ? '2px solid var(--gc-blue)' : '2px solid transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="shrink-0 flex items-center" style={{ color: hovered ? 'var(--gc-text-3)' : 'transparent', cursor: 'grab' }}>
          <GripVertical size={14} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 truncate">
            <button
              type="button"
              onClick={onToggleVisibility}
              title={asset.hidden ? 'Show on calendar' : 'Hide from calendar'}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', flexShrink: 0 }}
            >
              <Truck size={14} style={{ color: asset.hidden ? 'var(--gc-border)' : asset.color }} />
            </button>
            <span className="text-sm truncate" style={{ color: asset.hidden ? 'var(--gc-text-3)' : 'var(--gc-text-1)' }}>
              {asset.name}{asset.unit ? <span style={{ color: 'var(--gc-text-3)', fontWeight: 500 }}> #{asset.unit}</span> : null}
            </span>
          </div>
          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)', paddingLeft: 22 }}>
            {asset.type}
          </div>
        </div>

        {hovered && (
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.stopPropagation(); e.currentTarget.style.color = 'var(--gc-blue)'; e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}
            title={`Edit ${asset.name}`}
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
      {editing && <EditAssetDialog asset={asset} onClose={() => setEditing(false)} />}
    </>
  );
}

function UnassignedRow({ asset }: { asset: import('@/lib/types').Asset }) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <div
        className="flex items-center gap-2 px-2 py-2 transition-colors select-none"
        style={{ background: hovered ? 'var(--gc-hover)' : 'transparent', cursor: 'default' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="shrink-0" style={{ width: 14 }} />
        <div className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: asset.color }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate" style={{ color: 'var(--gc-text-1)' }}>{asset.name}</div>
          {hovered ? (
            <div className="text-[10px] truncate" style={{ color: 'var(--gc-blue)' }}>
              Turn Off Placeholder in Settings
            </div>
          ) : (
            <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
              {asset.unit ? `#${asset.unit}` : ''}{asset.unit ? ' · ' : ''}Unassigned
            </div>
          )}
        </div>
        {hovered && (
          <button
            onClick={() => setEditing(true)}
            className="p-1 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--gc-blue)'; e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}
            title="Edit Unassigned"
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
      {editing && <EditAssetDialog asset={asset} onClose={() => setEditing(false)} />}
    </>
  );
}
