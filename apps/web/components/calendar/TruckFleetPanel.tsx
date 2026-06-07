'use client';

/**
 * TruckFleetPanel — right-side slide-over for the calendar's truck list.
 *
 * Opened from the Truck icon in CalendarToolbar (sits next to the
 * trailer/Container icon). Replaces the always-visible AssetSidebar
 * left rail for users who don't reach for the truck controls often
 * — keeps them one click away without burning horizontal real estate.
 *
 * Shows every truck (excluding the "Unassigned" placeholder asset)
 * with:
 *   - Color swatch + name + unit number
 *   - Asset type (Local / OTR / etc.)
 *   - Edit button → opens AssetsModal pre-selected on this truck
 *   - Hide button → toggles asset.hidden so the calendar grid drops
 *     its column (same gesture the old AssetSidebar's color swatch
 *     fires; reads via toggleAssetVisibility in the store)
 *
 * Search box filters by name, unit, or type. Hidden trucks live in a
 * collapsible section at the bottom so they're still reachable but
 * don't crowd the active list.
 *
 * Closes on backdrop click, Escape, or the header X.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Truck, Search, Pencil, Eye, EyeOff, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import AssetsModal from '@/components/sidebar/AssetsModal';
import type { Asset } from '@/lib/types';

interface Props {
  onClose: () => void;
  /** When provided, clicking a row's Edit button calls this AND
   *  closes the tray, instead of mounting an AssetsModal on top of
   *  the tray. Lets the calendar parent show the directory modal
   *  without the tray covering it. */
  onEditTruck?: (assetId: number) => void;
}

const PANEL_WIDTH = 420;

export default function TruckFleetPanel({ onClose, onEditTruck }: Props) {
  const {
    assets,
    toggleAssetVisibility,
    reorderAssets,
    unassignedAssetId,
    // Category filter chips moved here from the left rail
    // (AssetSidebar). The store value is the canonical filter that
    // also drives which trucks render as columns on the calendar
    // grid — same source-of-truth, just a different control surface.
    assetCategories,
    activeCategoryFilter,
    setActiveCategoryFilter,
  } = useCalendarStore();
  const { can } = usePermissions();
  const canEdit = can('assets.edit');

  // Drag-state — track the asset being dragged by id (NOT array index,
  // since the visible list is a filtered + searched subset of the
  // store's full assets array). reorderAssets persists via railway.
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

  // Local search + which-section-is-open state.
  const [query, setQuery]                = useState('');
  const [hiddenOpen, setHiddenOpen]      = useState(false);
  const [editingAssetId, setEditingId]   = useState<number | null>(null);

  // Focus the search input on mount — keyboard-first feel.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Esc-to-close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Filter + partition into active / hidden. Drop the Unassigned
  // placeholder asset (it's a dispatcher-side scaffold, not a real
  // truck the user can edit) and any RETIRED asset (lifecycle's
  // activeTo is in the past). Order follows the store's `assets`
  // array verbatim — that's the canonical sort the user controls
  // via drag-to-reorder, and it must match the calendar grid's
  // column order so the same truck shows in the same position
  // on both surfaces.
  const today = dateKeyOf(new Date());
  const { activeTrucks, hiddenTrucks } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (a: Asset) => {
      if (!q) return true;
      const hay = `${a.name} ${a.unit ?? ''} ${a.type ?? ''}`.toLowerCase();
      return hay.includes(q);
    };
    const matchesCategory = (a: Asset) =>
      activeCategoryFilter === null || a.type === activeCategoryFilter;
    const real = assets.filter(a =>
      a.id !== unassignedAssetId &&
      a.name !== 'Unassigned' &&
      a.type !== 'Unassigned' &&
      isActiveOn(a, today)
    );
    const active: Asset[] = [];
    const hidden: Asset[] = [];
    for (const a of real) {
      if (!matches(a)) continue;
      if (!matchesCategory(a)) continue;
      if (a.hidden) hidden.push(a);
      else active.push(a);
    }
    // Intentionally no alpha sort — store order is the truth.
    return { activeTrucks: active, hiddenTrucks: hidden };
  }, [assets, query, activeCategoryFilter, unassignedAssetId, today]);

  // When the embedded AssetsModal closes, we don't auto-close the
  // tray — the user may want to edit a few in a row. Just clear the
  // selection so the modal mounts fresh on the next Edit click.
  const handleAssetsModalClose = () => {
    setEditingId(null);
  };

  const content = (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0"
        style={{ background: 'rgba(0,0,0,0.35)', zIndex: 1090 }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-label="Truck fleet"
        className="fixed top-0 right-0 h-full flex flex-col"
        style={{
          width: PANEL_WIDTH,
          background: 'var(--gc-surface)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
          zIndex: 1100,
        }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div
          className="flex items-center gap-2 px-4"
          style={{ height: 56, borderBottom: '1px solid var(--gc-border)' }}>
          <Truck size={17} style={{ color: 'var(--gc-text-2)' }} />
          <div className="text-[15px] font-bold flex-1" style={{ color: 'var(--gc-text-1)' }}>
            Trucks
          </div>
          <div className="text-[11px] font-medium" style={{ color: 'var(--gc-text-3)' }}>
            {activeTrucks.length}{hiddenTrucks.length > 0 && ` + ${hiddenTrucks.length} hidden`}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close trucks panel"
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div
            className="flex items-center gap-2 rounded-md flex-1"
            style={{
              background: 'var(--gc-bg)',
              border: '1px solid var(--gc-border-light)',
              padding: '6px 10px',
            }}>
            <Search size={13} style={{ color: 'var(--gc-text-3)' }} />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name, unit, type…"
              className="flex-1 outline-none bg-transparent text-[13px]"
              style={{ color: 'var(--gc-text-1)' }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="rounded-full p-0.5"
                style={{ color: 'var(--gc-text-3)' }}
                title="Clear search">
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        {/* Category filter chips — All + one chip per category. Same
            store value (activeCategoryFilter) that drives the
            calendar grid's column filtering, so toggling here also
            filters the columns on the calendar behind this tray. */}
        {assetCategories.length > 0 && (
          <div
            className="flex gap-1.5 px-4 py-2 overflow-x-auto"
            style={{ borderBottom: '1px solid var(--gc-border-light)', scrollbarWidth: 'none' }}>
            <button
              onClick={() => setActiveCategoryFilter(null)}
              className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
              style={{
                background: activeCategoryFilter === null ? 'var(--gc-blue-light)' : 'transparent',
                color:      activeCategoryFilter === null ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                border: `1px solid ${activeCategoryFilter === null ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
              }}>
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
                }}>
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto py-2">
          {activeTrucks.length === 0 && hiddenTrucks.length === 0 ? (
            <div
              className="text-[13px] font-medium text-center py-10 px-6"
              style={{ color: 'var(--gc-text-3)' }}>
              {query
                ? 'No trucks match that search.'
                : 'No trucks yet.'}
            </div>
          ) : (
            <>
              {activeTrucks.map(a => (
                <TruckRow
                  key={a.id}
                  asset={a}
                  canEdit={canEdit}
                  // Drag affordances only when the search box is empty
                  // — reordering a filtered view would silently scramble
                  // positions of trucks the user can't currently see.
                  isOver={overAssetId === a.id}
                  draggable={canEdit && !query}
                  onDragStart={() => handleDragStart(a.id)}
                  onDragOver={(e) => handleDragOver(e, a.id)}
                  onDrop={() => handleDrop(a.id)}
                  onDragEnd={handleDragEnd}
                  onEdit={() => {
                    if (onEditTruck) { onEditTruck(a.id); onClose(); }
                    else             setEditingId(a.id);
                  }}
                  onToggleHide={() => toggleAssetVisibility(a.id)}
                />
              ))}

              {/* Hidden trucks — collapsed by default, behind a
                  disclosure so they don't crowd the active list. */}
              {hiddenTrucks.length > 0 && (
                <div className="mt-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                  <button
                    type="button"
                    onClick={() => setHiddenOpen(v => !v)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wider transition-colors"
                    style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {hiddenOpen
                      ? <ChevronDown size={12} />
                      : <ChevronRight size={12} />}
                    Hidden ({hiddenTrucks.length})
                  </button>
                  {hiddenOpen && hiddenTrucks.map(a => (
                    <TruckRow
                      key={a.id}
                      asset={a}
                      canEdit={canEdit}
                      isOver={false}
                      // Hidden trucks aren't draggable — they don't have
                      // a calendar column to move around among, and
                      // hidden vs active is the only ordering that
                      // matters once a truck is hidden.
                      draggable={false}
                      onEdit={() => {
                        if (onEditTruck) { onEditTruck(a.id); onClose(); }
                        else             setEditingId(a.id);
                      }}
                      onToggleHide={() => toggleAssetVisibility(a.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Edit modal — mounted ON TOP of the tray. AssetsModal accepts
          initialAssetId so it lands directly on the row the user
          clicked. */}
      {editingAssetId != null && (
        <AssetsModal
          onClose={handleAssetsModalClose}
          initialAssetId={editingAssetId}
        />
      )}
    </>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

// ── Row ────────────────────────────────────────────────────────────

function TruckRow({
  asset, canEdit, isOver, draggable,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onEdit, onToggleHide,
}: {
  asset: Asset;
  canEdit: boolean;
  /** True while a drag is happening AND this row is the current
   *  drop target. Highlight gives the user a clear "drop here" cue. */
  isOver: boolean;
  draggable: boolean;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
  onEdit: () => void;
  onToggleHide: () => void;
}) {
  const isHidden = !!asset.hidden;
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 transition-colors"
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDrop={draggable ? onDrop : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      style={{
        background: isOver ? 'var(--gc-blue-light)' : 'transparent',
        cursor: draggable ? 'grab' : 'default',
        boxShadow: isOver ? 'inset 0 -2px 0 var(--gc-blue)' : 'none',
      }}
      onMouseEnter={e => { if (!isOver) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!isOver) e.currentTarget.style.background = 'transparent'; }}>
      {/* Drag handle — only shown when reorder is allowed. Tiny
          dot-grip mirrors the AssetSidebar's left rail. */}
      {draggable && (
        <div
          className="shrink-0 flex items-center justify-center"
          style={{ color: 'var(--gc-text-3)', width: 14 }}>
          <GripVertical size={12} />
        </div>
      )}
      {/* Truck icon — plain, colored by asset.color. Matches the
          AssetSidebar's left-rail rendering exactly so the same
          truck reads identically on both surfaces. */}
      <div
        className="flex items-center justify-center shrink-0"
        style={{ width: 22, height: 22 }}>
        <Truck size={14} style={{ color: isHidden ? 'var(--gc-border)' : asset.color }} />
      </div>

      {/* Name + unit + type */}
      <div className="flex-1 min-w-0">
        <div
          className="text-[13px] font-semibold truncate"
          style={{ color: isHidden ? 'var(--gc-text-3)' : 'var(--gc-text-1)' }}>
          {asset.name}
          {asset.unit && (
            <span
              className="font-medium ml-1"
              style={{ color: 'var(--gc-text-3)' }}>
              #{asset.unit}
            </span>
          )}
        </div>
        <div
          className="text-[11.5px] truncate"
          style={{ color: 'var(--gc-text-3)' }}>
          {asset.type || '—'}
        </div>
      </div>

      {/* Actions — edit + hide. Both icon-only with tooltip; only
          shown to users with assets.edit. */}
      {canEdit && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onEdit}
            title="Edit truck"
            className="rounded-md transition-colors flex items-center justify-center"
            style={{
              width: 28, height: 28,
              color: 'var(--gc-text-3)',
              background: 'transparent',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--gc-hover)';
              e.currentTarget.style.color = 'var(--gc-text-1)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--gc-text-3)';
            }}>
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={onToggleHide}
            title={isHidden ? 'Show on calendar' : 'Hide from calendar'}
            className="rounded-md transition-colors flex items-center justify-center"
            style={{
              width: 28, height: 28,
              color: isHidden ? 'var(--gc-blue)' : 'var(--gc-text-3)',
              background: 'transparent',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--gc-hover)';
              if (!isHidden) e.currentTarget.style.color = 'var(--gc-text-1)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = isHidden ? 'var(--gc-blue)' : 'var(--gc-text-3)';
            }}>
            {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}
