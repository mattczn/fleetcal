'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { GripVertical, Plus, Trash2, MapPin, CheckCircle2, AlertCircle, Clock, LocateFixed, ArrowLeftRight, Bookmark } from 'lucide-react';
import type { Stop, StopType } from '@/lib/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import DatePicker from './DatePicker';
import { parseTimeInput, naiveHomeToView, naiveViewToHome } from '@/lib/time-utils';
import { LOAD_ACCENT, LOAD_ACCENT_BG, LOAD_ACCENT_BG_HOVER, LOAD_ACCENT_BORDER } from '@/lib/loadAccent';

interface Props {
  stops: Stop[];
  onChange: (stops: Stop[]) => void;
  headerColor: string;
  onMapRoute: () => void;
  onActivateRelay?: () => void;
  relayActive?: boolean;
  relayRole?: 'pickup' | 'delivery';
  eventStart?: string; // "YYYY-MM-DDTHH:mm" — for relay time bounds
  eventEnd?: string;
  loadedMiles?: number | null;
  loadPrice?: number | null;
  ratePerMile?: number | null;
}

/** Convert IANA timezone → short abbreviation, e.g. "America/Denver" → "MT" */
function tzAbbr(iana: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value ?? iana;
  } catch {
    return iana;
  }
}

/**
 * Format "2026-04-23T08:00" → "Apr 23, 8:00 AM".
 *
 * When `viewTz` is provided, the stored naive string (anchored in
 * HOME_TZ — see lib/time-utils.ts) is first shifted into the view
 * timezone so the rendered time tracks the user's setting. Without
 * `viewTz` the string is rendered as-is (legacy behavior).
 */
export function fmtAppt(val: string, viewTz?: string): string {
  if (!val) return val;
  const shifted = viewTz ? naiveHomeToView(val, viewTz) : val;
  const m = shifted.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (!m) return shifted;
  const [y, mo, d] = m[1].split('-').map(Number);
  const [h, min]   = m[2].split(':').map(Number);
  const month = new Date(y, mo - 1, d).toLocaleString('en-US', { month: 'short' });
  return `${month} ${d}, ${h % 12 || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * Render the stop's appointment window with its schedule-type tag.
 *   appointment → "Appt: Apr 23, 8:00 AM"
 *   window      → "Window: Apr 23, 8:00 AM – 11:00 AM"
 *   fcfs        → "FCFS: opens Apr 23, 7:00 AM, closes 5:00 PM"
 * Falls back to legacy interpretation if scheduleType is not set.
 *
 * `viewTz` shifts the rendered times from HOME_TZ into the user's
 * current view timezone (see fmtAppt). Omit for legacy behavior.
 */
export function fmtStopWindow(stop: { apptStart?: string; apptEnd?: string; scheduleType?: string }, viewTz?: string): string {
  if (!stop.apptStart) return '';
  const start = fmtAppt(stop.apptStart, viewTz);
  const end   = stop.apptEnd ? fmtAppt(stop.apptEnd, viewTz) : '';
  const effective = stop.scheduleType ?? (stop.apptEnd ? 'window' : 'appointment');
  if (effective === 'fcfs')   return end ? `FCFS: ${start} – ${end}` : `FCFS: opens ${start}`;
  if (effective === 'window') return end ? `Window: ${start} – ${end}` : `Window: ${start}`;
  return `Appt: ${start}`;
}

function StopTimeInput({ value, onChange, headerColor }: { value: string; onChange: (v: string) => void; headerColor: string }) {
  const [raw, setRaw] = useState(value);
  useEffect(() => { setRaw(value); }, [value]);
  const commit = () => {
    const parsed = parseTimeInput(raw);
    if (parsed) { setRaw(parsed); onChange(parsed); }
    else setRaw(value);
  };
  return (
    <input
      type="text" value={raw}
      onChange={e => setRaw(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      placeholder="8am"
      style={{
        // Scales with the load modal's --ui-scale so the stop time
        // pill matches the surrounding fields at any preset.
        width: 'calc(68px * var(--ui-scale, 1))',
        border: '1px solid var(--gc-border)', borderRadius: 8,
        padding: 'calc(8.5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))',
        fontSize: 'calc(13.5px * var(--ui-scale, 1))',
        color: 'var(--gc-text-1)', outline: 'none', cursor: 'text',
        transition: 'border-color 150ms', background: 'var(--gc-surface)',
      }}
      onFocus={e => { requestAnimationFrame(() => e.target.select()); e.currentTarget.style.borderColor = headerColor; }}
      onBlur={e => { commit(); e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
    />
  );
}

/** DatePicker + SmartTime combo reading/writing "YYYY-MM-DDTHH:mm" */
function ApptInput({ value, onChange, placeholder, headerColor }: { value: string; onChange: (v: string) => void; placeholder: string; headerColor: string }) {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  const datePart = m ? m[1] : '';
  const timePart = m ? m[2] : '';

  if (!value) {
    return (
      <button
        type="button"
        onClick={() => onChange(`${new Date().toISOString().slice(0, 10)}T08:00`)}
        style={{
          border: '1px solid var(--gc-border)', borderRadius: 8,
          padding: 'calc(8.5px * var(--ui-scale, 1)) calc(11px * var(--ui-scale, 1))',
          fontSize: 'calc(12px * var(--ui-scale, 1))',
          color: 'var(--gc-text-3)', background: 'var(--gc-surface)',
          cursor: 'pointer', width: '100%', textAlign: 'left',
          transition: 'border-color 150ms',
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = headerColor)}
        onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
      >
        {placeholder}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <DatePicker value={datePart} onChange={d => onChange(`${d}T${timePart || '08:00'}`)} headerColor={LOAD_ACCENT} />
      <StopTimeInput value={timePart} onChange={t => onChange(`${datePart}T${t}`)} headerColor={headerColor} />
      <button
        type="button" onClick={() => onChange('')} title="Clear"
        style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
        onMouseEnter={e => (e.currentTarget.style.color = '#d93025')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}
      >×</button>
    </div>
  );
}

const TYPE_CONFIG: Record<StopType, { label: string; color: string; bg: string }> = {
  pickup:    { label: 'PU',    color: '#166534', bg: '#dcfce7' },
  delivery:  { label: 'DEL',   color: '#991b1b', bg: '#fee2e2' },
  drop:      { label: 'DROP',  color: '#0e7490', bg: '#cffafe' },
  drop_hook: { label: 'D&H',   color: '#1e40af', bg: '#dbeafe' },
  stop:      { label: 'STOP',  color: '#92400e', bg: '#fef3c7' },
  relay:     { label: 'RELAY', color: '#6d28d9', bg: '#f5f3ff' },
};

const STOP_TYPES: StopType[] = ['pickup', 'delivery', 'drop', 'drop_hook', 'stop', 'relay'];
const TYPE_LABELS: Record<StopType, string> = {
  pickup: 'Pickup', delivery: 'Delivery', drop: 'Drop Trailer', drop_hook: 'Drop & Hook', stop: 'Stop', relay: 'Relay Point',
};

function GeocodeIndicator({ status }: { status: Stop['geocodeStatus'] }) {
  if (status === 'success') return <span title="Geocoded"><CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} /></span>;
  if (status === 'failed')  return <span title="Geocoding failed"><AlertCircle  size={13} style={{ color: '#dc2626', flexShrink: 0 }} /></span>;
  return <span title="Not yet geocoded"><Clock size={13} style={{ color: '#9ca3af', flexShrink: 0 }} /></span>;
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

export default function StopsSection({ stops, onChange, headerColor, onMapRoute, onActivateRelay, relayActive, relayRole, eventStart, eventEnd, loadedMiles, loadPrice, ratePerMile }: Props) {
  const savedLocations    = useCalendarStore(s => s.savedLocations);
  const fetchSavedLocs    = useCalendarStore(s => s.fetchSavedLocations);
  const allEvents         = useCalendarStore(s => s.events);
  const calendarTimezone  = useCalendarStore(s => s.calendarTimezone);
  // Stops store appt_start/appt_end in HOME_TZ but the user enters and
  // sees times in their current view timezone. Wrap reads/writes so the
  // form state on disk stays in HOME_TZ while the inputs reflect view tz.
  const toView = (v: string | undefined): string => v ? naiveHomeToView(v, calendarTimezone) : '';
  const toHome = (v: string): string => v ? naiveViewToHome(v, calendarTimezone) : '';
  const dragIdx    = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  const [expandedInstructions, setExpandedInstructions] = useState<Set<string>>(new Set());
  const [manualCoordIdx, setManualCoordIdx] = useState<number | null>(null);
  const [manualLat, setManualLat] = useState('');
  const [manualLng, setManualLng] = useState('');
  const [relayTimeError, setRelayTimeError] = useState<string | null>(null);
  const relayErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showRelayError(msg: string) {
    setRelayTimeError(msg);
    if (relayErrTimer.current) clearTimeout(relayErrTimer.current);
    relayErrTimer.current = setTimeout(() => setRelayTimeError(null), 3500);
  }

  // Always-current ref to stops so async callbacks don't use stale closures
  const stopsRef = useRef(stops);
  useEffect(() => { stopsRef.current = stops; }, [stops]);

  // Fetch saved locations on first render if not yet loaded
  useEffect(() => {
    if (savedLocations.length === 0) void fetchSavedLocs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build a deduplicated, frequency-ranked list combining saved locations + historical stops
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

  // Autocomplete
  const [suggestions,           setSuggestions]           = useState<{ place_id: string; description: string }[]>([]);
  const [savedSuggestions,      setSavedSuggestions]      = useState<StopSuggestion[]>([]);
  const [facilityAcIdx,         setFacilityAcIdx]         = useState<number | null>(null); // facility name dropdown
  const [facilitySuggestions,   setFacilitySuggestions]   = useState<StopSuggestion[]>([]);
  const [acIdx, setAcIdx] = useState<number | null>(null); // which stop is showing suggestions
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justSelected = useRef(false);

  const fetchSuggestions = useCallback((idx: number, input: string) => {
    if (acTimer.current) clearTimeout(acTimer.current);
    const q = input.trim().toLowerCase();
    // Search historical stops (includes saved locations) client-side instantly
    const matched = q.length >= 1
      ? historicalStops.filter(s =>
          (s.facilityName ?? '').toLowerCase().includes(q) ||
          (s.address ?? '').toLowerCase().includes(q)
        ).slice(0, 6)
      : [];
    setSavedSuggestions(matched);
    if (!q || q.length < 4) { setSuggestions([]); if (!matched.length) setAcIdx(null); else setAcIdx(idx); return; }
    setAcIdx(idx);
    acTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?input=${encodeURIComponent(input)}`);
        const data = await res.json() as { suggestions: { place_id: string; description: string }[] };
        setSuggestions(data.suggestions ?? []);
        setAcIdx(idx);
      } catch { setSuggestions([]); }
    }, 300);
  }, [historicalStops]);

  function selectStopSuggestion(idx: number, s: StopSuggestion) {
    justSelected.current = true;
    setSuggestions([]); setSavedSuggestions([]); setAcIdx(null);
    onChange(stopsRef.current.map((stop, i) => i === idx ? {
      ...stop,
      facilityName: s.facilityName ?? stop.facilityName,
      address: s.address ?? stop.address,
      lat: s.lat,
      lng: s.lng,
      timezone: s.timezone,
      geocodeStatus: s.lat ? 'success' : 'pending',
    } : stop));
  }

  async function selectSuggestion(idx: number, s: { place_id: string; description: string }) {
    justSelected.current = true;
    setSuggestions([]); setAcIdx(null);
    try {
      const res  = await fetch(`/api/places?place_id=${encodeURIComponent(s.place_id)}`);
      const data = await res.json() as { result: { lat: number; lng: number; timezone?: string; address?: string } | null };
      if (data.result) {
        onChange(stopsRef.current.map((stop, i) => i === idx ? { ...stop, address: data.result!.address ?? s.description, lat: data.result!.lat, lng: data.result!.lng, timezone: data.result!.timezone, geocodeStatus: 'success' } : stop));
      } else {
        onChange(stopsRef.current.map((stop, i) => i === idx ? { ...stop, address: s.description, geocodeStatus: 'failed' } : stop));
      }
    } catch {
      onChange(stopsRef.current.map((stop, i) => i === idx ? { ...stop, address: s.description, geocodeStatus: 'failed' } : stop));
    }
  }

  const geocodedCount = stops.filter(s => s.geocodeStatus === 'success').length;

  function update(idx: number, patch: Partial<Stop>) {
    const next = stops.map((s, i) => i === idx ? { ...s, ...patch } : s);
    onChange(next);
  }

  function addStop() {
    const newStop: Stop = {
      id: crypto.randomUUID(),
      eventId: '',
      sequence: stops.length + 1,
      type: stops.length === 0 ? 'pickup' : stops.every(s => s.type === 'pickup') ? 'delivery' : 'stop',
      geocodeStatus: 'pending',
    };
    onChange([...stops, newStop]);
  }

  function removeStop(idx: number) {
    onChange(stops.filter((_, i) => i !== idx).map((s, i) => ({ ...s, sequence: i + 1 })));
  }

  function onDragStart(idx: number) {
    dragIdx.current = idx;
    setDragActive(true);
  }

  function onDragEnter(idx: number) {
    dragOverIdx.current = idx;
  }

  function onDragEnd() {
    setDragActive(false);
    if (dragIdx.current === null || dragOverIdx.current === null || dragIdx.current === dragOverIdx.current) {
      dragIdx.current = null; dragOverIdx.current = null; return;
    }
    const next = [...stops];
    const [moved] = next.splice(dragIdx.current, 1);
    next.splice(dragOverIdx.current, 0, moved);
    onChange(next.map((s, i) => ({ ...s, sequence: i + 1 })));
    dragIdx.current = null; dragOverIdx.current = null;
  }

  async function geocodeStop(idx: number, address: string) {
    if (!address?.trim()) return;
    onChange(stopsRef.current.map((s, i) => i === idx ? { ...s, geocodeStatus: 'pending' } : s));
    try {
      const res = await fetch('/api/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const { result } = await res.json() as { result: { lat: number; lng: number; timezone?: string } | null };
      if (result) {
        onChange(stopsRef.current.map((s, i) => i === idx ? { ...s, lat: result.lat, lng: result.lng, timezone: result.timezone, geocodeStatus: 'success' } : s));
      } else {
        onChange(stopsRef.current.map((s, i) => i === idx ? { ...s, lat: undefined, lng: undefined, timezone: undefined, geocodeStatus: 'failed' } : s));
      }
    } catch {
      onChange(stopsRef.current.map((s, i) => i === idx ? { ...s, geocodeStatus: 'failed' } : s));
    }
  }

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 6,
    // Per-stop input rows (address, ref #, notes, etc.) scale with
    // the load modal's --ui-scale just like the top-level form fields
    // — without this they'd stay the original size while everything
    // around them shrinks.
    padding: 'calc(5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))',
    fontSize: 'calc(12.5px * var(--ui-scale, 1))',
    color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
    outline: 'none', width: '100%',
  };

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          Locations
        </span>
        <div className="flex items-center gap-2">
          {onActivateRelay && !relayActive && !stops.some(s => s.type === 'relay') && (
            <button
              type="button"
              onClick={onActivateRelay}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
              style={{ color: '#7c3aed', border: '1px solid #ddd6fe', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <ArrowLeftRight size={11} /> Split / Relay
            </button>
          )}
          {loadedMiles != null && (
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}`, background: LOAD_ACCENT_BG }}>
              <MapPin size={11} /> {loadedMiles.toLocaleString()} loaded mi
            </span>
          )}
          {ratePerMile != null && (
            <span className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}`, background: LOAD_ACCENT_BG }}>
              ${ratePerMile.toFixed(2)}/mi
            </span>
          )}
          {stops.length >= 2 && geocodedCount >= 2 && (
            <button
              type="button"
              onClick={onMapRoute}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
              style={{ color: LOAD_ACCENT, border: `1px solid ${LOAD_ACCENT_BORDER}`, background: LOAD_ACCENT_BG }}
              onMouseEnter={e => (e.currentTarget.style.background = LOAD_ACCENT_BG_HOVER)}
              onMouseLeave={e => (e.currentTarget.style.background = LOAD_ACCENT_BG)}
            >
              <MapPin size={11} /> Map Route
            </button>
          )}
        </div>
      </div>

      {/* Stop rows */}
      <div className="space-y-2">
        {(() => {
          const relayIdx = relayRole ? stops.findIndex(s => s.type === 'relay') : -1;
          const isThisLeg = (idx: number) => {
            if (relayIdx === -1 || !relayRole) return true;
            if (relayRole === 'pickup')   return idx <= relayIdx;
            if (relayRole === 'delivery') return idx >= relayIdx;
            return true;
          };
          return stops.map((stop, idx) => {
          const cfg = TYPE_CONFIG[stop.type] ?? TYPE_CONFIG.stop;
          const thisLeg = isThisLeg(idx);
          const isRelayHandoff = stop.type === 'relay' && relayRole != null;
          // Divider before the relay handoff stop
          const divider = isRelayHandoff ? (
            <div key={`divider-${stop.id}`} className="flex items-center gap-2 px-1 py-0.5">
              <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-lg"
                style={{ background: '#f5f3ff', color: '#7c3aed', border: '1px solid #ddd6fe' }}>
                {relayRole === 'pickup' ? 'Pickup leg ends here' : 'Delivery leg starts here'}
              </span>
              <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
            </div>
          ) : null;

          return (
            <div key={stop.id}>
              {divider}
            <div
              draggable
              onDragStart={() => onDragStart(idx)}
              onDragEnter={() => onDragEnter(idx)}
              onDragEnd={onDragEnd}
              onDragOver={e => e.preventDefault()}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'flex-start', gap: 8,
                padding: '10px 10px 10px 6px',
                borderRadius: 10,
                border: thisLeg ? '1px solid var(--gc-border-light)' : '1px solid var(--gc-border-light)',
                background: thisLeg ? 'var(--gc-surface)' : 'var(--gc-bg)',
                opacity: (dragActive && dragIdx.current === idx ? 0.4 : 1) * (thisLeg ? 1 : 0.45),
                transition: 'opacity 150ms',
              }}
            >
              {/* Drag handle + sequence */}
              <div
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, paddingTop: 2, cursor: 'grab', flexShrink: 0 }}
              >
                <GripVertical size={14} style={{ color: 'var(--gc-text-3)' }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gc-text-3)' }}>{idx + 1}</span>
              </div>

              {/* Type badge + timezone */}
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                <select
                  value={stop.type}
                  onChange={e => update(idx, { type: e.target.value as StopType })}
                  style={{
                    height: 28, border: 'none', borderRadius: 6,
                    padding: '0 6px', fontSize: 11, fontWeight: 700,
                    color: cfg.color, background: cfg.bg,
                    outline: 'none', cursor: 'pointer',
                  }}
                >
                  {STOP_TYPES.map(t => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
                {stop.timezone && (
                  <div style={{
                    fontSize: 9, fontWeight: 600, textAlign: 'center',
                    color: 'var(--gc-text-3)', background: 'var(--gc-bg)',
                    border: '1px solid var(--gc-border)', borderRadius: 4,
                    padding: '2px 4px', letterSpacing: '0.02em', whiteSpace: 'nowrap',
                  }}>
                    Time Zone: <strong>{tzAbbr(stop.timezone)}</strong>
                  </div>
                )}
                {stop.arrivedAt && <CheckInChip stop={stop} />}
              </div>

              {/* Address + facility */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {stop.type !== 'relay' && (
                  <div style={{ position: 'relative' }}>
                    <input
                      type="text"
                      value={stop.facilityName ?? ''}
                      onChange={e => {
                        update(idx, { facilityName: e.target.value });
                        const q = e.target.value.trim().toLowerCase();
                        if (q.length >= 1) {
                          const matched = historicalStops.filter(s =>
                            (s.facilityName ?? '').toLowerCase().includes(q) ||
                            (s.address ?? '').toLowerCase().includes(q)
                          ).slice(0, 6);
                          setFacilitySuggestions(matched);
                          setFacilityAcIdx(matched.length ? idx : null);
                        } else {
                          setFacilitySuggestions([]); setFacilityAcIdx(null);
                        }
                      }}
                      placeholder="Facility name"
                      style={{ ...inp }}
                      onFocus={e => {
                        e.currentTarget.style.borderColor = headerColor;
                        const q = (stop.facilityName ?? '').trim().toLowerCase();
                        if (q.length >= 1) {
                          const matched = historicalStops.filter(s =>
                            (s.facilityName ?? '').toLowerCase().includes(q) ||
                            (s.address ?? '').toLowerCase().includes(q)
                          ).slice(0, 6);
                          setFacilitySuggestions(matched);
                          setFacilityAcIdx(matched.length ? idx : null);
                        }
                      }}
                      onBlur={e => {
                        e.currentTarget.style.borderColor = 'var(--gc-border)';
                        setTimeout(() => { setFacilitySuggestions([]); setFacilityAcIdx(null); }, 200);
                      }}
                    />
                    {facilityAcIdx === idx && facilitySuggestions.length > 0 && (
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                        background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                        borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, overflow: 'hidden',
                      }}>
                        {facilitySuggestions.map(s => (
                          <button
                            key={s.key}
                            type="button"
                            onMouseDown={() => {
                              justSelected.current = true;
                              setFacilitySuggestions([]); setFacilityAcIdx(null);
                              onChange(stopsRef.current.map((stop, i) => i === idx ? {
                                ...stop,
                                facilityName: s.facilityName ?? stop.facilityName,
                                address: s.address ?? stop.address,
                                lat: s.lat, lng: s.lng, timezone: s.timezone,
                                geocodeStatus: s.lat ? 'success' : 'pending',
                              } : stop));
                            }}
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
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, position: 'relative' }}>
                  <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                    <input
                      type="text"
                      value={stop.address ?? ''}
                      onChange={e => {
                        update(idx, { address: e.target.value, geocodeStatus: 'pending' });
                        fetchSuggestions(idx, e.target.value);
                      }}
                      placeholder="Full address"
                      style={{ ...inp, width: '100%' }}
                      onFocus={e => {
                        e.currentTarget.style.borderColor = headerColor;
                        fetchSuggestions(idx, e.currentTarget.value);
                      }}
                      onBlur={e => {
                        e.currentTarget.style.borderColor = 'var(--gc-border)';
                        setTimeout(() => { setSuggestions([]); setSavedSuggestions([]); setAcIdx(null); }, 200);
                        if (justSelected.current) { justSelected.current = false; return; }
                        const addr = e.currentTarget.value.trim();
                        if (addr && (stop.geocodeStatus === 'pending' || !stop.timezone)) void geocodeStop(idx, addr);
                      }}
                    />
                    {acIdx === idx && (savedSuggestions.length > 0 || suggestions.length > 0) && (
                      <div style={{
                        position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                        background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                        borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, overflow: 'hidden',
                      }}>
                        {/* Historical stops first */}
                        {savedSuggestions.length > 0 && (
                          <>
                            <div style={{ padding: '5px 10px 3px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
                              Your Locations
                            </div>
                            {savedSuggestions.map(s => (
                              <button
                                key={s.key}
                                type="button"
                                onMouseDown={() => selectStopSuggestion(idx, s)}
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
                            ))}
                          </>
                        )}
                        {/* Google Places below */}
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
                                onMouseDown={() => selectSuggestion(idx, s)}
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
                      </div>
                    )}
                  </div>
                  <GeocodeIndicator status={stop.geocodeStatus} />
                </div>
                {stop.geocodeStatus === 'failed' && (
                  manualCoordIdx === idx ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <input
                        type="text" value={manualLat} onChange={e => setManualLat(e.target.value)}
                        placeholder="Lat (e.g. 36.0395)"
                        style={{ ...inp, width: 130, fontSize: 11, padding: '3px 6px' }}
                      />
                      <input
                        type="text" value={manualLng} onChange={e => setManualLng(e.target.value)}
                        placeholder="Lng (e.g. -114.9817)"
                        style={{ ...inp, width: 140, fontSize: 11, padding: '3px 6px' }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const lat = parseFloat(manualLat);
                          const lng = parseFloat(manualLng);
                          if (!isNaN(lat) && !isNaN(lng)) {
                            fetch('/api/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat, lng }) })
                              .then(r => r.json())
                              .then((d: { result: { timezone?: string } | null }) => {
                                update(idx, { lat, lng, timezone: d.result?.timezone, geocodeStatus: 'success' });
                              })
                              .catch(() => update(idx, { lat, lng, geocodeStatus: 'success' }));
                            setManualCoordIdx(null); setManualLat(''); setManualLng('');
                          }
                        }}
                        style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 5, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}
                      >Apply</button>
                      <button type="button" onClick={() => { setManualCoordIdx(null); setManualLat(''); setManualLng(''); }}
                        style={{ fontSize: 11, color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setManualCoordIdx(idx); setManualLat(''); setManualLng(''); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, fontSize: 11, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 5, padding: '2px 7px', cursor: 'pointer' }}
                    >
                      <LocateFixed size={10} /> Enter coordinates manually
                    </button>
                  )
                )}
                {/* Instructions — allowed on every stop type, including relays */}
                {expandedInstructions.has(stop.id) ? (
                  <textarea
                    autoFocus
                    value={stop.instructions ?? ''}
                    onChange={e => update(idx, { instructions: e.target.value })}
                    placeholder="Gate codes, dock notes, contacts…"
                    rows={3}
                    style={{ ...inp, resize: 'vertical', fontSize: 12, lineHeight: 1.4, padding: '5px 8px' }}
                    onFocus={e => (e.currentTarget.style.borderColor = headerColor)}
                    onBlur={e => {
                      e.currentTarget.style.borderColor = 'var(--gc-border)';
                      if (!stop.instructions?.trim()) setExpandedInstructions(prev => { const s = new Set(prev); s.delete(stop.id); return s; });
                    }}
                  />
                ) : stop.instructions ? (
                  <button
                    type="button"
                    onClick={() => setExpandedInstructions(prev => { const s = new Set(prev); s.add(stop.id); return s; })}
                    style={{ alignSelf: 'flex-start', width: '100%', textAlign: 'left', fontSize: 12, color: 'var(--gc-text-2)', background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = headerColor)}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
                    title={stop.instructions}
                  >
                    {stop.instructions}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setExpandedInstructions(prev => { const s = new Set(prev); s.add(stop.id); return s; })}
                    style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--gc-text-3)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
                    onMouseEnter={e => (e.currentTarget.style.color = headerColor)}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}
                  >
                    <Plus size={11} /> Instructions
                  </button>
                )}
              </div>

              {/* Appt window */}
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 5, width: 260 }}>
                {stop.type === 'relay' ? (
                  <>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d28d9', marginBottom: 3 }}>Driver 1 drop</div>
                      <ApptInput
                        value={toView(stop.apptStart)}
                        onChange={v => {
                          setRelayTimeError(null);
                          const stored = toHome(v);
                          update(idx, { apptStart: stored });
                          // Warn (but don't block) if drop ends up after Driver 2 pickup
                          if (stop.apptEnd && stored && stored > stop.apptEnd) {
                            showRelayError('Driver 1 drop is after Driver 2 pickup — check times.');
                          }
                        }}
                        placeholder="Drop time"
                        headerColor="#7c3aed"
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d28d9', marginBottom: 3 }}>Driver 2 pickup</div>
                      <ApptInput
                        value={toView(stop.apptEnd)}
                        onChange={v => {
                          setRelayTimeError(null);
                          const stored = toHome(v);
                          update(idx, { apptEnd: stored });
                          // Warn (but don't block) if pickup ends up before Driver 1 drop
                          if (stop.apptStart && stored && stored < stop.apptStart) {
                            showRelayError('Driver 2 pickup is before Driver 1 drop — check times.');
                          }
                        }}
                        placeholder="Pickup time"
                        headerColor="#7c3aed"
                      />
                    </div>
                    {relayTimeError && (
                      <div style={{ fontSize: 11, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '5px 8px', marginTop: 2 }}>
                        {relayTimeError}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* Schedule-type pill set: appointment | window | fcfs */}
                    <div style={{ display: 'flex', gap: 4 }}>
                      {(['appointment', 'window', 'fcfs'] as const).map(opt => {
                        const effective = stop.scheduleType ?? (stop.apptEnd ? 'window' : 'appointment');
                        const active = effective === opt;
                        const label = opt === 'appointment' ? 'Appt' : opt === 'window' ? 'Window' : 'FCFS';
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => update(idx, { scheduleType: opt })}
                            style={{
                              flex: 1, fontSize: 10, fontWeight: 700, padding: '3px 6px',
                              borderRadius: 5, cursor: 'pointer',
                              border: `1px solid ${active ? LOAD_ACCENT : 'var(--gc-border)'}`,
                              background: active ? LOAD_ACCENT : 'transparent',
                              color: active ? '#fff' : 'var(--gc-text-3)',
                              transition: 'all 100ms',
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {(() => {
                      const effective = stop.scheduleType ?? (stop.apptEnd ? 'window' : 'appointment');
                      if (effective === 'appointment') {
                        return <ApptInput value={toView(stop.apptStart)} onChange={v => update(idx, { apptStart: toHome(v), apptEnd: undefined })} placeholder="Appointment" headerColor={headerColor} />;
                      }
                      // window OR fcfs both use a start/end pair
                      return (
                        <>
                          <ApptInput value={toView(stop.apptStart)} onChange={v => update(idx, { apptStart: toHome(v) })} placeholder={effective === 'fcfs' ? 'Opens' : 'From'} headerColor={headerColor} />
                          <ApptInput value={toView(stop.apptEnd)}   onChange={v => update(idx, { apptEnd:   toHome(v) })} placeholder={effective === 'fcfs' ? 'Closes' : 'To'}   headerColor={headerColor} />
                        </>
                      );
                    })()}
                  </>
                )}
              </div>

              {/* Delete confirm overlay */}
              {confirmDeleteIdx === idx && (
                <div style={{
                  position: 'absolute', inset: 0, borderRadius: 10, zIndex: 10,
                  background: 'var(--gc-surface)', border: '1px solid #d93025',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                    Are you sure you want to delete this stop?
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => { removeStop(idx); setConfirmDeleteIdx(null); }}
                      style={{ fontSize: 12, fontWeight: 700, padding: '5px 16px', borderRadius: 6, border: 'none', background: '#d93025', color: '#fff', cursor: 'pointer' }}
                    >Yes</button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteIdx(null)}
                      style={{ fontSize: 12, fontWeight: 700, padding: '5px 16px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}
                    >No</button>
                  </div>
                </div>
              )}

              {/* Delete button */}
              {confirmDeleteIdx !== idx && (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteIdx(idx)}
                  style={{ flexShrink: 0, padding: 4, borderRadius: '50%', color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer', marginTop: 2 }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#d93025'; e.currentTarget.style.background = 'rgba(217,48,37,.1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            </div>
          );
        });
        })()}
      </div>

      {/* Add stop */}
      <button
        type="button"
        onClick={addStop}
        className="mt-2 flex items-center gap-1.5 text-xs font-semibold transition-opacity"
        style={{ color: LOAD_ACCENT }}
        onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
        onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
      >
        <Plus size={13} /> Add stop
      </button>
    </div>
  );
}
