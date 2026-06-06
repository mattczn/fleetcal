'use client';

/**
 * Saved Locations directory body for DirectoryModal.
 *
 * Left list (240px) of every saved location + right detail panel
 * with the name/address editor — matches the layout of the trucks /
 * drivers / trailers tabs. Address picking still uses the Google
 * Places autocomplete carried over from the original Settings panel;
 * when the user picks a suggestion the lat/lng/tz get filled in and
 * the row auto-saves.
 *
 * Add flow: clicking "+ Location" puts the right pane into an empty
 * draft form (no server row yet). The first successful save creates
 * the row, swaps the detail pane to the new location's edit view.
 * No abandoned-draft cleanup needed because nothing was written
 * until Save fired.
 *
 * Future hook: dispatchers will be able to right-click a stop on the
 * calendar and "save to locations" — but until that wiring lands,
 * this directory is the only entry point.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, MapPin, Plus, Trash2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import type { SavedLocation } from '@/lib/types';

const ACCENT = '#1a73e8';

type AcSuggestion = { place_id: string; description: string };

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

export default function SavedLocationsDirectoryBody() {
  const { savedLocations, fetchSavedLocations, addSavedLocation, updateSavedLocation, removeSavedLocation } = useCalendarStore();
  const { can } = usePermissions();
  const canDelete = can('savedLocations.delete');

  // `selected` is either an id (editing existing) or null (adding new).
  // We initialize to the first location when the list loads so the
  // detail pane isn't empty.
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding]     = useState(false);

  useEffect(() => { void fetchSavedLocations(); }, [fetchSavedLocations]);

  useEffect(() => {
    if (selected || adding) return;
    if (savedLocations.length > 0) setSelected(savedLocations[0].id);
  }, [savedLocations, selected, adding]);

  const selectedLoc = selected ? savedLocations.find(l => l.id === selected) ?? null : null;

  const handleAddClick = () => {
    setSelected(null);
    setAdding(true);
  };

  const handleSelectLoc = (id: string) => {
    setAdding(false);
    setSelected(id);
  };

  return (
    <div className="flex-1 overflow-hidden flex min-h-0">

      {/* ── Left Sidebar ── */}
      <div className="flex flex-col shrink-0"
        style={{ width: 240, borderRight: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
        <div className="shrink-0 flex items-center justify-between px-4 pt-5 pb-1">
          <span className="text-[10px] font-bold uppercase tracking-widest"
            style={{ color: 'var(--gc-text-3)' }}>
            Locations
          </span>
          <button
            onClick={handleAddClick}
            disabled={adding}
            title="Add location"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-50"
            style={{ color: ACCENT, background: 'transparent', border: 'none', cursor: adding ? 'default' : 'pointer' }}
            onMouseEnter={e => { if (!adding) e.currentTarget.style.background = 'var(--gc-blue-light)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Plus size={12} />
            Location
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {savedLocations.length === 0 && !adding && (
            <p className="text-xs px-2 py-2" style={{ color: 'var(--gc-text-3)' }}>
              No locations yet.
            </p>
          )}
          {adding && (
            <NavLocationRow
              key="__new"
              location={{ id: '__new', name: 'New location' }}
              selected={true}
              draft
              onSelect={() => { /* draft is already selected */ }}
            />
          )}
          {savedLocations.map(loc => (
            <NavLocationRow
              key={loc.id}
              location={loc}
              selected={!adding && selected === loc.id}
              onSelect={() => handleSelectLoc(loc.id)}
            />
          ))}
        </div>
      </div>

      {/* ── Right Panel ── */}
      <div className="flex-1 overflow-y-auto">
        {adding ? (
          <LocationDetailPanel
            // Key by 'new' so the form resets to empty whenever the
            // user re-enters add mode after navigating away.
            key="__new"
            location={null}
            canDelete={false}
            onSaveNew={async (v) => {
              await addSavedLocation(v);
              setAdding(false);
              // Selection auto-picks via the useEffect once the new
              // row appears in savedLocations — we'd need the id back
              // from addSavedLocation to be precise. For now we leave
              // selection to fall back to the first item on next render.
            }}
            onCancelNew={() => {
              setAdding(false);
              if (savedLocations.length > 0) setSelected(savedLocations[0].id);
            }}
            onUpdate={async () => {}}
            onDelete={async () => {}}
          />
        ) : selectedLoc ? (
          <LocationDetailPanel
            key={selectedLoc.id}
            location={selectedLoc}
            canDelete={canDelete}
            onSaveNew={async () => {}}
            onCancelNew={() => {}}
            onUpdate={(updates) => updateSavedLocation(selectedLoc.id, updates)}
            onDelete={async () => {
              await removeSavedLocation(selectedLoc.id);
              setSelected(null);
            }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm"
            style={{ color: 'var(--gc-text-3)' }}>
            Select a location
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Nav Location Row ─────────────────────────────────────────────────────────

function NavLocationRow({ location, selected, onSelect, draft }: {
  location: { id: string; name: string; address?: string };
  selected: boolean;
  onSelect: () => void;
  draft?: boolean;
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
      onMouseLeave={() => setHovered(false)}>
      <div
        className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center"
        style={{ background: ACCENT }}>
        <MapPin size={13} color="white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="text-sm font-medium truncate"
            style={{ color: selected ? ACCENT : 'var(--gc-text-1)' }}>
            {location.name}
          </div>
          {draft && (
            <span
              className="shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-[1px] rounded"
              style={{ background: '#fef3c7', color: '#92400e', letterSpacing: '0.5px' }}>
              Draft
            </span>
          )}
        </div>
        {location.address && (
          <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
            {location.address}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Location Detail Panel ────────────────────────────────────────────────────

function LocationDetailPanel({ location, canDelete, onSaveNew, onCancelNew, onUpdate, onDelete }: {
  /** Existing location for edit mode; null for add mode. */
  location: SavedLocation | null;
  canDelete: boolean;
  onSaveNew:   (v: Omit<SavedLocation, 'id'>) => Promise<void>;
  onCancelNew: () => void;
  onUpdate:    (updates: Partial<Omit<SavedLocation, 'id'>>) => Promise<void>;
  onDelete:    () => Promise<void>;
}) {
  const addMode = location === null;
  const [name, setName]         = useState(location?.name ?? '');
  const [address, setAddress]   = useState(location?.address ?? '');
  const [lat, setLat]           = useState<number | undefined>(location?.lat);
  const [lng, setLng]           = useState<number | undefined>(location?.lng);
  const [timezone, setTimezone] = useState<string | undefined>(location?.timezone);
  const [geocoded, setGeocoded] = useState(!!location?.lat);
  const [suggestions, setSuggestions] = useState<AcSuggestion[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const acTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justPicked = useRef(false);

  function fetchSuggestions(input: string) {
    if (acTimer.current) clearTimeout(acTimer.current);
    if (!input.trim() || input.length < 4) { setSuggestions([]); return; }
    acTimer.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/places?input=${encodeURIComponent(input)}`);
        const data = await res.json() as { suggestions: AcSuggestion[] };
        setSuggestions(data.suggestions ?? []);
      } catch { setSuggestions([]); }
    }, 300);
  }

  async function pickSuggestion(s: AcSuggestion) {
    justPicked.current = true;
    setSuggestions([]);
    setAddress(s.description);
    try {
      const res  = await fetch(`/api/places?place_id=${encodeURIComponent(s.place_id)}`);
      const data = await res.json() as { result: { lat: number; lng: number; timezone?: string; address?: string } | null };
      if (data.result) {
        const newAddress = data.result.address ?? s.description;
        setAddress(newAddress);
        setLat(data.result.lat);
        setLng(data.result.lng);
        setTimezone(data.result.timezone);
        setGeocoded(true);
        // Auto-commit the address change for existing rows. Add mode
        // collects everything and commits via Save.
        if (!addMode) {
          await onUpdate({
            address:  newAddress,
            lat:      data.result.lat,
            lng:      data.result.lng,
            timezone: data.result.timezone,
          });
        }
      }
    } catch { /* ignore */ }
  }

  const canSaveNew = name.trim() && geocoded;

  return (
    <div className="px-8 py-7">
      {/* Header */}
      <div className="flex items-center gap-5 mb-8">
        <div
          className="w-16 h-16 rounded-full shrink-0 flex items-center justify-center"
          style={{ background: ACCENT }}>
          <MapPin size={28} color="white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xl font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
            {addMode ? 'New location' : (name || 'Untitled')}
          </div>
          {!addMode && address && (
            <div className="text-sm mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
              {address}
            </div>
          )}
        </div>
      </div>

      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest mb-4"
          style={{ color: 'var(--gc-text-3)' }}>
          Profile
        </div>

        <PField label="Name">
          <input
            type="text" value={name} onChange={e => setName(e.target.value)}
            placeholder='e.g. "Main Yard" or "KC Terminal"' style={P_INPUT}
            autoFocus={addMode}
            onFocus={e => (e.currentTarget.style.borderColor = ACCENT)}
            onBlur={e => {
              const v = e.target.value.trim();
              setName(v);
              if (!addMode && v && v !== (location?.name ?? '')) void onUpdate({ name: v });
              e.currentTarget.style.borderColor = 'var(--gc-border)';
            }} />
        </PField>

        <div className="mt-4">
          <PField label="Address">
            <div style={{ position: 'relative' }}>
              <input value={address}
                onChange={e => { setAddress(e.target.value); setGeocoded(false); fetchSuggestions(e.target.value); }}
                onBlur={() => { setTimeout(() => { if (!justPicked.current) setSuggestions([]); justPicked.current = false; }, 150); }}
                placeholder="Search address…"
                style={{ ...P_INPUT, paddingRight: geocoded ? 32 : 12 }} />
              {geocoded && (
                <Check size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#16a34a' }} />
              )}
              {suggestions.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                  background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                  borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, overflow: 'hidden',
                }}>
                  {suggestions.map(s => (
                    <button key={s.place_id} type="button" onMouseDown={() => pickSuggestion(s)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                        padding: '8px 12px', fontSize: 13, color: 'var(--gc-text-1)',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        borderBottom: '1px solid var(--gc-border-light)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <MapPin size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                      {s.description}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {geocoded && lat != null && (
              <div className="text-xs mt-1.5" style={{ color: 'var(--gc-text-3)' }}>
                {lat.toFixed(5)}, {lng?.toFixed(5)}{timezone ? ` · ${timezone}` : ''}
              </div>
            )}
          </PField>
        </div>
      </div>

      {/* Add-mode footer — Save creates the row, Cancel returns. */}
      {addMode && (
        <div className="flex items-center gap-3 justify-end pt-5"
          style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button
            type="button" onClick={onCancelNew}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSaveNew({ name: name.trim(), address, lat, lng, timezone })}
            disabled={!canSaveNew}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: ACCENT }}>
            Save location
          </button>
        </div>
      )}

      {/* Edit-mode delete affordance — two-step inline confirm
          mirroring the AssetsModal Retire button. */}
      {!addMode && canDelete && (
        <div className="mt-10 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          {confirmDelete ? (
            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: 'var(--gc-text-2)' }}>
                Delete <strong>{name || 'this location'}</strong>?
              </span>
              <button
                onClick={() => void onDelete()}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white"
                style={{ background: '#d93025' }}>
                Delete
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
              Delete location
            </button>
          )}
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
