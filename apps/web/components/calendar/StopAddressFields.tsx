/**
 * Shared facility-name + address inputs for a stop.
 *
 * Extracted verbatim from StopsSection so the leg builder's handoff box
 * and the Locations list run the SAME implementation — Google Places
 * autocomplete (session-tokened), saved-location + calendar-window
 * matches, the org-wide history lookup via railway.listRecentStops, the
 * ranking rules, on-blur geocoding, and the geocode status indicator.
 * There is deliberately no second copy of any of this: both surfaces
 * mount this component.
 *
 * Each instance owns its own dropdown state, so two mounted copies
 * (a stop row and the handoff box editing the same relay point) can't
 * fight over a shared "which index is open" value.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, CheckCircle2, AlertCircle, Clock, LocateFixed, Bookmark } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import type { Stop } from '@/lib/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';

function GeocodeIndicator({ status }: { status: Stop['geocodeStatus'] }) {
  // The green check is the ONLY signal that an address was actually
  // accepted by Google Places — anything else means the stop won't
  // route, won't surface on the map, and won't auto-fill the timezone.
  // Make that consequence explicit on hover so dispatchers don't
  // ship loads with raw text addresses by accident.
  const tip = status === 'success' ? (
    <>
      <strong>Address verified.</strong> Stop is geocoded — it&rsquo;ll route on the map, save lat/lng, and pick up the correct timezone.
    </>
  ) : status === 'failed' ? (
    <>
      <strong>Geocoding failed.</strong> Google couldn&rsquo;t resolve this address — the stop is <strong>not saved</strong> as a real location.
      <div style={{ marginTop: 6 }}>
        Fix: clear the field and start typing the address again, then pick one of the <strong>Google suggestions</strong> from the dropdown. The check turns green once Google accepts it.
      </div>
    </>
  ) : (
    <>
      <strong>Not yet geocoded.</strong> This address isn&rsquo;t saved as a real location yet — no lat/lng, no map route, no auto timezone.
      <div style={{ marginTop: 6 }}>
        Fix: type the address into the field and pick one of the <strong>Google suggestions</strong> that appears in the dropdown below. The check turns green once Google accepts it.
      </div>
    </>
  );
  const icon = status === 'success'
    ? <CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
    : status === 'failed'
      ? <AlertCircle  size={13} style={{ color: '#dc2626', flexShrink: 0 }} />
      : <Clock        size={13} style={{ color: '#9ca3af', flexShrink: 0 }} />;
  return (
    <Tooltip content={tip}>
      <span style={{ cursor: 'help' }}>{icon}</span>
    </Tooltip>
  );
}

interface StopSuggestion {
  key: string;
  facilityName?: string;
  address?: string;
  lat?: number;
  lng?: number;
  timezone?: string;
  count: number;
  isSaved?: boolean;
  savedName?: string;
  /** Came from the org-wide history lookup rather than the loaded
   *  calendar window. Ranked below local matches but still offered. */
  isRemote?: boolean;
}

/** How many facility/address suggestions to show at once. The calendar
 *  store only holds a ~2-week window, so local matches alone are a thin
 *  slice of where the fleet actually goes — the org-history lookup fills
 *  the rest and this cap has to leave room for it. */
const SUGGESTION_LIMIT = 10;

function suggestionKey(facilityName?: string, address?: string): string {
  return `${(facilityName ?? '').toLowerCase().trim()}||${(address ?? '').toLowerCase().trim()}`;
}

/**
 * Rank matches for a query: prefix hits on the facility name first (what
 * you get when you type "ALB" for ALBERTSONS), then other name hits, then
 * address-only hits. Saved locations outrank history, and local history
 * outranks the org-wide lookup only as a tiebreak — freshness of the
 * calendar window is not a signal of relevance.
 */
function rankSuggestions(list: StopSuggestion[], q: string): StopSuggestion[] {
  const score = (s: StopSuggestion): number => {
    const name = (s.facilityName ?? '').toLowerCase();
    const addr = (s.address ?? '').toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q))   return 1;
    if (addr.startsWith(q)) return 2;
    return 3;
  };
  return [...list].sort((a, b) => {
    if (a.isSaved !== b.isSaved) return a.isSaved ? -1 : 1;
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
    return b.count - a.count;
  });
}

// Distance in miles between two lat/lng points (haversine).
function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const CHECK_IN_VERIFY_THRESHOLD_MI = 0.5;

function CheckInChip({ stop }: { stop: Stop }) {
  if (!stop.arrivedAt) return null;
  const time = new Date(stop.arrivedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const distMi =
    stop.lat != null && stop.lng != null && stop.arrivedLat != null && stop.arrivedLng != null
      ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat, stop.arrivedLng)
      : null;
  const verified = distMi != null && distMi <= CHECK_IN_VERIFY_THRESHOLD_MI;
  const palette = verified
    ? { bg: '#dcfce7', fg: '#15803d', border: '#86efac' }
    : { bg: '#fef9c3', fg: '#854d0e', border: '#fde68a' };
  const distLabel =
    distMi == null ? null : distMi < 0.1 ? 'on-site' : `${distMi.toFixed(1)} mi off`;
  return (
    <div style={{
      fontSize: 9, fontWeight: 600, textAlign: 'center',
      color: palette.fg, background: palette.bg,
      border: `1px solid ${palette.border}`, borderRadius: 4,
      padding: '2px 4px', letterSpacing: '0.02em', whiteSpace: 'nowrap',
    }}>
      Checked in <strong>{time}</strong>{distLabel ? ` · ${distLabel}` : ''}
    </div>
  );
}

export interface StopAddressFieldsProps {
  /** The stop being edited (only the address-ish fields are read). */
  stop: Pick<Stop, 'facilityName' | 'address' | 'lat' | 'lng' | 'timezone' | 'geocodeStatus'>;
  /** Apply a patch to the stop. Callers write it wherever the stop lives. */
  onChange: (patch: Partial<Stop>) => void;
  headerColor: string;
  /** Hide the facility-name input (relay points historically had none). */
  showFacility?: boolean;
  /** Read-only render: values shown, no inputs, no autocomplete. */
  readOnly?: boolean;
  /** Extra styling hook for the inputs (the handoff box tints them). */
  inputStyle?: React.CSSProperties;
  /** Placeholder overrides. */
  facilityPlaceholder?: string;
  addressPlaceholder?: string;
}

export function StopAddressFields({
  stop, onChange, headerColor, showFacility = true, readOnly = false,
  inputStyle, facilityPlaceholder = 'Facility name', addressPlaceholder = 'Full address',
}: StopAddressFieldsProps) {
  const savedLocations = useCalendarStore(s => s.savedLocations);
  const fetchSavedLocs = useCalendarStore(s => s.fetchSavedLocations);
  const allEvents      = useCalendarStore(s => s.events);

  const [suggestions,         setSuggestions]         = useState<{ place_id: string; description: string }[]>([]);
  const [savedSuggestions,    setSavedSuggestions]    = useState<StopSuggestion[]>([]);
  const [facilitySuggestions, setFacilitySuggestions] = useState<StopSuggestion[]>([]);
  const [facilityOpen,        setFacilityOpen]        = useState(false);
  const [addrOpen,            setAddrOpen]            = useState(false);
  const [manualCoord,         setManualCoord]         = useState(false);
  const [manualLat,           setManualLat]           = useState('');
  const [manualLng,           setManualLng]           = useState('');
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSelected = useRef(false);
  // One Places session token per address-editing session — threaded through
  // every autocomplete request and the final place-details call so Google
  // bills it as a single Autocomplete Session SKU. Reset after each select.
  const placesToken = useRef<string | null>(null);
  const getPlacesToken = () => (placesToken.current ??= crypto.randomUUID());

  const [remoteStops, setRemoteStops] = useState<StopSuggestion[]>([]);
  const remoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteSeq   = useRef(0);
  const facilityQ   = useRef('');
  const addrQ       = useRef('');

  useEffect(() => {
    if (savedLocations.length === 0) void fetchSavedLocs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const historicalStops = useMemo<StopSuggestion[]>(() => {
    const map = new Map<string, StopSuggestion>();

    // Seed with saved locations first (always included, marked as saved)
    for (const loc of savedLocations) {
      const key = `${loc.name.toLowerCase().trim()}||${(loc.address ?? '').toLowerCase().trim()}`;
      map.set(key, {
        key,
        facilityName: loc.name,
        address: loc.address,
        lat: loc.lat,
        lng: loc.lng,
        timezone: loc.timezone,
        count: 0,
        isSaved: true,
      });
    }

    // Merge in historical event stops, incrementing count
    for (const ev of allEvents) {
      for (const s of ev.stops ?? []) {
        if (!s.address && !s.facilityName) continue;
        const key = `${(s.facilityName ?? '').toLowerCase().trim()}||${(s.address ?? '').toLowerCase().trim()}`;
        const existing = map.get(key);
        if (existing) {
          existing.count++;
        } else {
          map.set(key, {
            key,
            facilityName: s.facilityName,
            address: s.address,
            lat: s.lat,
            lng: s.lng,
            timezone: s.timezone,
            count: 1,
            isSaved: false,
          });
        }
      }
    }

    // Saved locations first, then by frequency
    return Array.from(map.values()).sort((a, b) => {
      if (a.isSaved !== b.isSaved) return a.isSaved ? -1 : 1;
      return b.count - a.count;
    });
  }, [allEvents, savedLocations]);

  const localMatches = useCallback((q: string) => historicalStops.filter(s =>
    (s.facilityName ?? '').toLowerCase().includes(q) ||
    (s.address ?? '').toLowerCase().includes(q)
  ), [historicalStops]);

  /** Local + org-history matches, deduped and ranked. */
  const mergedMatches = useCallback((q: string): StopSuggestion[] => {
    const seen = new Set<string>();
    const out: StopSuggestion[] = [];
    for (const s of [...localMatches(q), ...remoteStops]) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      out.push(s);
    }
    return rankSuggestions(out, q).slice(0, SUGGESTION_LIMIT);
  }, [localMatches, remoteStops]);

  /** Debounced org-history lookup. Stale responses are dropped by seq so a
   *  slow request for "ALB" can't overwrite results for "ALBERTSONS". */
  const searchOrgHistory = useCallback((q: string) => {
    if (remoteTimer.current) clearTimeout(remoteTimer.current);
    if (q.length < 2) { setRemoteStops([]); return; }
    const seq = ++remoteSeq.current;
    remoteTimer.current = setTimeout(async () => {
      try {
        const { recentStops } = await railway.listRecentStops({ q, limit: 25 });
        if (seq !== remoteSeq.current) return;
        setRemoteStops((recentStops ?? []).map(r => ({
          key:          suggestionKey(r.facilityName, r.address),
          facilityName: r.facilityName,
          address:      r.address,
          lat:          r.lat,
          lng:          r.lng,
          timezone:     r.timezone,
          count:        0,
          isRemote:     true,
        })));
      } catch {
        // Autocomplete is additive — a failed history lookup just leaves
        // the local matches in place rather than surfacing an error.
        if (seq === remoteSeq.current) setRemoteStops([]);
      }
    }, 250);
  }, []);

  // History arrives after the keystroke that asked for it, so refresh
  // whichever dropdown is open rather than making the user type again.
  useEffect(() => {
    if (facilityOpen && facilityQ.current) setFacilitySuggestions(mergedMatches(facilityQ.current));
    if (addrOpen && addrQ.current)         setSavedSuggestions(mergedMatches(addrQ.current));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStops]);

  const fetchSuggestions = useCallback((input: string) => {
    if (acTimer.current) clearTimeout(acTimer.current);
    const q = input.trim().toLowerCase();
    // Local matches (saved locations + loaded calendar window) render
    // instantly; the org-history lookup fills in behind them.
    addrQ.current = q;
    searchOrgHistory(q);
    const matched = q.length >= 1 ? mergedMatches(q) : [];
    setSavedSuggestions(matched);
    if (!q || q.length < 4) { setSuggestions([]); setAddrOpen(matched.length > 0); return; }
    setAddrOpen(true);
    acTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?input=${encodeURIComponent(input)}&sessiontoken=${getPlacesToken()}`);
        const data = await res.json() as { suggestions: { place_id: string; description: string }[] };
        setSuggestions(data.suggestions ?? []);
        setAddrOpen(true);
      } catch { setSuggestions([]); }
    }, 300);
  }, [mergedMatches, searchOrgHistory]);

  function applySuggestion(s: StopSuggestion) {
    justSelected.current = true;
    setSuggestions([]); setSavedSuggestions([]); setFacilitySuggestions([]);
    setAddrOpen(false); setFacilityOpen(false);
    onChange({
      facilityName: s.facilityName ?? stop.facilityName,
      address: s.address ?? stop.address,
      lat: s.lat,
      lng: s.lng,
      timezone: s.timezone,
      geocodeStatus: s.lat ? 'success' : 'pending',
    });
  }

  async function applyPlace(s: { place_id: string; description: string }) {
    justSelected.current = true;
    setSuggestions([]); setAddrOpen(false);
    try {
      const res  = await fetch(`/api/places?place_id=${encodeURIComponent(s.place_id)}&sessiontoken=${getPlacesToken()}`);
      const data = await res.json() as { result: { lat: number; lng: number; timezone?: string; address?: string } | null };
      if (data.result) {
        onChange({ address: data.result.address ?? s.description, lat: data.result.lat, lng: data.result.lng, timezone: data.result.timezone, geocodeStatus: 'success' });
      } else {
        onChange({ address: s.description, geocodeStatus: 'failed' });
      }
    } catch {
      onChange({ address: s.description, geocodeStatus: 'failed' });
    } finally {
      // Session complete — next address edit starts a fresh token.
      placesToken.current = null;
    }
  }

  async function geocode(address: string) {
    if (!address?.trim()) return;
    onChange({ geocodeStatus: 'pending' });
    try {
      const res = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const { result } = await res.json() as { result: { lat: number; lng: number; timezone?: string } | null };
      if (result) {
        onChange({ lat: result.lat, lng: result.lng, timezone: result.timezone, geocodeStatus: 'success' });
      } else {
        onChange({ lat: undefined, lng: undefined, timezone: undefined, geocodeStatus: 'failed' });
      }
    } catch {
      onChange({ geocodeStatus: 'failed' });
    }
  }

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 6,
    padding: 'calc(5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))',
    fontSize: 'calc(12.5px * var(--ui-scale, 1))',
    color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
    outline: 'none', width: '100%',
    ...inputStyle,
  };

  const dropdown = (items: React.ReactNode) => (
    <div style={{
      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
      background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
      borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, overflow: 'hidden',
    }}>{items}</div>
  );

  const suggestionRow = (s: StopSuggestion, onPick: () => void) => (
    <button
      key={s.key}
      type="button"
      onMouseDown={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        width: '100%', textAlign: 'left',
        padding: '7px 10px', fontSize: 12, color: 'var(--gc-text-1)',
        background: 'transparent', border: 'none', cursor: 'pointer',
        borderBottom: '1px solid var(--gc-border-light)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <Bookmark size={10} style={{ color: s.isSaved ? 'var(--gc-blue)' : 'var(--gc-text-3)', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        {s.facilityName && <span style={{ fontWeight: 700 }}>{s.facilityName}</span>}
        {s.address && <span style={{ color: 'var(--gc-text-3)', marginLeft: s.facilityName ? 5 : 0 }}>{s.address}</span>}
      </span>
      {s.count > 1 && <span style={{ fontSize: 10, color: 'var(--gc-text-3)', flexShrink: 0 }}>×{s.count}</span>}
    </button>
  );

  if (readOnly) {
    const box: React.CSSProperties = {
      ...inp, background: 'var(--gc-bg)', color: 'var(--gc-text-2)',
      cursor: 'default', minHeight: 'calc(26px * var(--ui-scale, 1))',
    };
    return (
      <>
        {showFacility && (
          <div style={box}>{stop.facilityName || <span style={{ color: 'var(--gc-text-3)' }}>No facility name</span>}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ ...box, flex: 1, minWidth: 0 }}>
            {stop.address || <span style={{ color: 'var(--gc-text-3)' }}>No address</span>}
          </div>
          <GeocodeIndicator status={stop.geocodeStatus} />
        </div>
      </>
    );
  }

  return (
    <>
      {showFacility && (
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={stop.facilityName ?? ''}
            onChange={e => {
              onChange({ facilityName: e.target.value });
              const q = e.target.value.trim().toLowerCase();
              facilityQ.current = q;
              searchOrgHistory(q);
              if (q.length >= 1) {
                const matched = mergedMatches(q);
                setFacilitySuggestions(matched);
                setFacilityOpen(matched.length > 0);
              } else {
                setFacilitySuggestions([]); setFacilityOpen(false);
              }
            }}
            placeholder={facilityPlaceholder}
            style={{ ...inp }}
            onFocus={e => {
              e.currentTarget.style.borderColor = headerColor;
              const q = (stop.facilityName ?? '').trim().toLowerCase();
              facilityQ.current = q;
              if (q.length >= 1) {
                searchOrgHistory(q);
                const matched = mergedMatches(q);
                setFacilitySuggestions(matched);
                setFacilityOpen(matched.length > 0);
              }
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = 'var(--gc-border)';
              setTimeout(() => { setFacilitySuggestions([]); setFacilityOpen(false); }, 200);
            }}
          />
          {facilityOpen && facilitySuggestions.length > 0 &&
            dropdown(facilitySuggestions.map(s => suggestionRow(s, () => applySuggestion(s))))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <input
            type="text"
            value={stop.address ?? ''}
            onChange={e => {
              onChange({ address: e.target.value, geocodeStatus: 'pending' });
              fetchSuggestions(e.target.value);
            }}
            placeholder={addressPlaceholder}
            style={{ ...inp, width: '100%' }}
            onFocus={e => {
              e.currentTarget.style.borderColor = headerColor;
              fetchSuggestions(e.currentTarget.value);
            }}
            onBlur={e => {
              e.currentTarget.style.borderColor = 'var(--gc-border)';
              setTimeout(() => { setSuggestions([]); setSavedSuggestions([]); setAddrOpen(false); }, 200);
              if (justSelected.current) { justSelected.current = false; return; }
              const addr = e.currentTarget.value.trim();
              if (addr && (stop.geocodeStatus === 'pending' || !stop.timezone)) void geocode(addr);
            }}
          />
          {addrOpen && (savedSuggestions.length > 0 || suggestions.length > 0) && dropdown(
            <>
              {savedSuggestions.length > 0 && (
                <>
                  <div style={{ padding: '5px 10px 3px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    Your Locations
                  </div>
                  {savedSuggestions.map(s => suggestionRow(s, () => applySuggestion(s)))}
                </>
              )}
              {suggestions.length > 0 && (
                <>
                  {savedSuggestions.length > 0 && (
                    <div style={{ padding: '5px 10px 3px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
                      Search Results
                    </div>
                  )}
                  {suggestions.map(s => (
                    <button
                      key={s.place_id}
                      type="button"
                      onMouseDown={() => void applyPlace(s)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        width: '100%', textAlign: 'left',
                        padding: '7px 10px', fontSize: 12, color: 'var(--gc-text-1)',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        borderBottom: '1px solid var(--gc-border-light)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <MapPin size={10} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                      {s.description}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
        <GeocodeIndicator status={stop.geocodeStatus} />
      </div>
      {stop.geocodeStatus === 'failed' && (
        manualCoord ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <input type="text" value={manualLat} onChange={e => setManualLat(e.target.value)}
              placeholder="Lat (e.g. 36.0395)" style={{ ...inp, width: 130, fontSize: 11, padding: '3px 6px' }} />
            <input type="text" value={manualLng} onChange={e => setManualLng(e.target.value)}
              placeholder="Lng (e.g. -114.9817)" style={{ ...inp, width: 140, fontSize: 11, padding: '3px 6px' }} />
            <button type="button"
              onClick={() => {
                const lat = parseFloat(manualLat);
                const lng = parseFloat(manualLng);
                if (!isNaN(lat) && !isNaN(lng)) {
                  fetch('/api/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lng }) })
                    .then(r => r.json())
                    .then((d: { result: { timezone?: string } | null }) => {
                      onChange({ lat, lng, timezone: d.result?.timezone, geocodeStatus: 'success' });
                    })
                    .catch(() => onChange({ lat, lng, geocodeStatus: 'success' }));
                  setManualCoord(false); setManualLat(''); setManualLng('');
                }
              }}
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 5, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >Apply</button>
            <button type="button" onClick={() => { setManualCoord(false); setManualLat(''); setManualLng(''); }}
              style={{ fontSize: 11, color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setManualCoord(true); setManualLat(''); setManualLng(''); }}
            style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: 11, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 5, padding: '2px 7px', cursor: 'pointer' }}
          >
            <LocateFixed size={10} /> Enter coordinates manually
          </button>
        )
      )}
    </>
  );
}
