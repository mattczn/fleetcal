'use client';

/**
 * Saved Locations directory body for DirectoryModal.
 *
 * Extracted from apps/web/app/settings/page.tsx (SavedLocationsPanel +
 * LocationForm) so the locations directory lives next to its sibling
 * fleet directories rather than buried in Settings. The settings panel
 * itself can be removed once the directory is wired everywhere this
 * editor was previously linked from.
 *
 * Auto-saves on form submit — no staged dirty state, so the
 * DirectoryModal shell never has to gate cross-tab navigation when
 * this tab is active.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';

type AcSuggestion = { place_id: string; description: string };

interface LocationFormState {
  name:      string;
  address:   string;
  lat?:      number;
  lng?:      number;
  timezone?: string;
}

export default function SavedLocationsDirectoryBody() {
  const { savedLocations, fetchSavedLocations, addSavedLocation, updateSavedLocation, removeSavedLocation } = useCalendarStore();
  const { can } = usePermissions();
  const canDelete = can('savedLocations.delete');
  const [adding, setAdding]                 = useState(false);
  const [editingId, setEditingId]           = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => { void fetchSavedLocations(); }, [fetchSavedLocations]);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-7">
      <div style={{ maxWidth: 720 }}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Saved Locations</h2>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg"
              style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}>
              <Plus size={14} /> Add Location
            </button>
          )}
        </div>
        <p className="text-sm mb-6" style={{ color: 'var(--gc-text-3)' }}>
          Save yards and terminals here to quickly select them as relay points on loads.
        </p>

        {adding && (
          <div style={{ border: '1px solid var(--gc-border)', borderRadius: 12, padding: 16, marginBottom: 12, background: 'var(--gc-surface)' }}>
            <div className="text-sm font-semibold mb-3" style={{ color: 'var(--gc-text-1)' }}>New Location</div>
            <LocationForm
              onSave={async (v) => { await addSavedLocation(v); setAdding(false); }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}

        {savedLocations.length === 0 && !adding ? (
          <div style={{ border: '1px dashed var(--gc-border)', borderRadius: 12, padding: 32, textAlign: 'center' }}>
            <MapPin size={24} style={{ color: 'var(--gc-text-3)', margin: '0 auto 8px' }} />
            <div className="text-sm font-medium" style={{ color: 'var(--gc-text-2)' }}>No saved locations yet</div>
            <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>Add your yards and terminals to use them as relay points.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {savedLocations.map(loc => (
              <div key={loc.id} style={{ border: '1px solid var(--gc-border-light)', borderRadius: 12, background: 'var(--gc-surface)', overflow: 'hidden' }}>
                {editingId === loc.id ? (
                  <div style={{ padding: 16 }}>
                    <div className="text-sm font-semibold mb-3" style={{ color: 'var(--gc-text-1)' }}>Edit Location</div>
                    <LocationForm
                      initial={{ name: loc.name, address: loc.address ?? '', lat: loc.lat, lng: loc.lng, timezone: loc.timezone }}
                      onSave={async (v) => { await updateSavedLocation(loc.id, v); setEditingId(null); }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                ) : confirmDeleteId === loc.id ? (
                  <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span className="text-sm" style={{ color: 'var(--gc-text-1)' }}>Delete <strong>{loc.name}</strong>?</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => setConfirmDeleteId(null)}
                        style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--gc-border)', background: 'transparent', fontSize: 13, cursor: 'pointer', color: 'var(--gc-text-2)' }}>
                        Cancel
                      </button>
                      <button type="button" onClick={async () => { await removeSavedLocation(loc.id); setConfirmDeleteId(null); }}
                        style={{ padding: '5px 14px', borderRadius: 7, border: 'none', background: '#d93025', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: '#e8f0fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <MapPin size={16} style={{ color: '#1a73e8' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>{loc.name}</div>
                      {loc.address && <div className="text-xs truncate mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{loc.address}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button type="button" onClick={() => setEditingId(loc.id)}
                        style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <Pencil size={14} />
                      </button>
                      {canDelete && (
                        <button type="button" onClick={() => setConfirmDeleteId(loc.id)}
                          style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = '#d93025'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Address autocomplete + geocoded save. Lifted verbatim from
 *  the settings panel; uses /api/places for both suggestions and
 *  place-id resolution. */
function LocationForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: LocationFormState;
  onSave: (v: LocationFormState) => void;
  onCancel: () => void;
}) {
  const [name, setName]         = useState(initial?.name ?? '');
  const [address, setAddress]   = useState(initial?.address ?? '');
  const [lat, setLat]           = useState<number | undefined>(initial?.lat);
  const [lng, setLng]           = useState<number | undefined>(initial?.lng);
  const [timezone, setTimezone] = useState<string | undefined>(initial?.timezone);
  const [geocoded, setGeocoded] = useState(!!initial?.lat);
  const [suggestions, setSuggestions] = useState<AcSuggestion[]>([]);
  const acTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justPicked = useRef(false);

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 8, padding: '8px 12px',
    fontSize: 14, color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
    outline: 'none', width: '100%',
  };

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
        setAddress(data.result.address ?? s.description);
        setLat(data.result.lat);
        setLng(data.result.lng);
        setTimezone(data.result.timezone);
        setGeocoded(true);
      }
    } catch { /* ignore */ }
  }

  const canSave = name.trim() && geocoded;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>Location Name</div>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder='e.g. "Main Yard" or "KC Terminal"' style={inp} autoFocus />
      </div>
      <div>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>Address</div>
        <div style={{ position: 'relative' }}>
          <input value={address}
            onChange={e => { setAddress(e.target.value); setGeocoded(false); fetchSuggestions(e.target.value); }}
            onBlur={() => { setTimeout(() => { if (!justPicked.current) setSuggestions([]); justPicked.current = false; }, 150); }}
            placeholder="Search address…"
            style={{ ...inp, paddingRight: geocoded ? 32 : 12 }} />
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
          <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>
            {lat.toFixed(5)}, {lng?.toFixed(5)}{timezone ? ` · ${timezone}` : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" onClick={onCancel}
          style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'transparent', fontSize: 13, color: 'var(--gc-text-2)', cursor: 'pointer' }}>
          Cancel
        </button>
        <button type="button" onClick={() => onSave({ name: name.trim(), address, lat, lng, timezone })} disabled={!canSave}
          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: canSave ? '#1a73e8' : 'var(--gc-border)', color: canSave ? '#fff' : 'var(--gc-text-3)', fontSize: 13, fontWeight: 700, cursor: canSave ? 'pointer' : 'default' }}>
          Save
        </button>
      </div>
    </div>
  );
}
