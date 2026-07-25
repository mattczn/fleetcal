'use client';

import { useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, Trash2, MapPin, AlertCircle, ArrowLeftRight } from 'lucide-react';
import { isHandoffStop, handoffIndexes } from '@fleetcal/types';
import { StopAddressFields } from './StopAddressFields';
import type { Stop, StopType } from '@/lib/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import DatePicker from './DatePicker';
import TimePicker from './TimePicker';
import { naiveHomeToView, naiveViewToHome } from '@/lib/time-utils';
import { LOAD_ACCENT, LOAD_ACCENT_BG, LOAD_ACCENT_BG_HOVER, LOAD_ACCENT_BORDER } from '@/lib/loadAccent';

interface Props {
  stops: Stop[];
  onChange: (stops: Stop[]) => void;
  headerColor: string;
  /** Map Route header badge handler. Optional — when omitted the badge
   *  doesn't render (e.g. on the load detail page where the map is
   *  already mounted in the page chrome and a separate route button
   *  would be redundant). */
  onMapRoute?: () => void;
  /** "Split / Relay" (first handoff) or "Add handoff" (subsequent ones)
   *  header button. Absent = affordance hidden. */
  onActivateRelay?: () => void;
  /** True while an unsaved handoff is pending — hides the add button so
   *  edit mode stays one-split-per-save. */
  relayActive?: boolean;
  /** Legacy role of the viewed leg. Superseded by legIndex/legCount for
   *  N-leg loads; still honored for 2-leg callers that don't pass them. */
  relayRole?: 'pickup' | 'transfer' | 'delivery';
  /** N-leg: 0-based position of the leg being viewed. Marker i sits
   *  between leg i and leg i+1; the viewed leg's window runs from
   *  marker i-1 (or first stop) to marker i (or last stop), boundary
   *  markers included — stops outside that window render greyed. */
  legIndex?: number;
  /** Total legs on the load (drafts included). Enables the handoff
   *  dividers even in create mode where relayRole isn't set yet. */
  legCount?: number;
  /** Driver name per leg, leg order — labels each handoff divider
   *  ("Luis drops → Sarah picks up"; falls back to "Handoff N"). */
  legDriverNames?: (string | undefined)[];
  /** Leg-builder mode: shows the per-stop "Handoff after this stop"
   *  toggle, the colored leg rail + per-stop leg tags, and the
   *  "+ add handoff between these stops" insert rows. Off (default)
   *  keeps the plain stops list every other caller renders. */
  legBuilder?: boolean;
  /** Toggle `isHandoff` on the stop at `idx`. Only offered for
   *  intermediate stops — the first and last can never be boundaries. */
  onToggleHandoff?: (idx: number) => void;
  /** Insert a NEW relay-point stop between stops `idx` and `idx+1`
   *  (the yard case — a handoff point that isn't a stop yet). */
  onInsertHandoffAfter?: (idx: number) => void;
  /** Per-leg accent colors, leg order — drives the rail + leg tags.
   *  Falls back to the relay purple when absent. */
  legColors?: string[];
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

/** Stop appointment time pill. Forwards to the shared TimePicker so
 *  the load modal's stop times pick up the same hour/minute popover
 *  as every other DateTimeInput in the app. */
function StopTimeInput({ value, onChange, headerColor }: { value: string; onChange: (v: string) => void; headerColor: string }) {
  return (
    <TimePicker
      value={value}
      onChange={onChange}
      headerColor={headerColor}
      inputWidth={'calc(68px * var(--ui-scale, 1))'}
      inputStyle={{
        padding: 'calc(8.5px * var(--ui-scale, 1)) calc(8px * var(--ui-scale, 1))',
        fontSize: 'calc(13.5px * var(--ui-scale, 1))',
      }}
    />
  );
}

/** DatePicker + SmartTime combo reading/writing "YYYY-MM-DDTHH:mm" */
/** DatePicker + SmartTime combo reading/writing "YYYY-MM-DDTHH:mm".
 *  Exported so RelayLegsEditor's handoff rows use the identical control
 *  (same formatting, same timezone handling) as the stop rows. */
export function ApptInput({ value, onChange, placeholder, headerColor }: { value: string; onChange: (v: string) => void; placeholder: string; headerColor: string }) {
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

/**
 * Handoff drop/pickup times as shown on a stop row.
 *
 * In the leg builder these are READ-ONLY here — the legs editor's
 * handoff divider is the single place to edit them, so the same value
 * can't be set from two surfaces. Outside the builder (a bare relay
 * point on a load that isn't being leg-edited — e.g. one created by the
 * older split flow, or viewed on the load detail page) the inputs stay
 * live so those flows keep working.
 */
function HandoffTimesReadOnly({
  dropLabel, pickupLabel, drop, pickup, editable, onEditDrop, onEditPickup, error,
}: {
  dropLabel: string;
  pickupLabel: string;
  drop: string;
  pickup: string;
  editable: boolean;
  onEditDrop: (v: string) => void;
  onEditPickup: (v: string) => void;
  error: string | null;
}) {
  const labelStyle: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: '#6d28d9', marginBottom: 3,
  };
  const readOnlyBox: React.CSSProperties = {
    border: '1px solid #ddd6fe', borderRadius: 8, background: '#f5f3ff',
    padding: 'calc(8.5px * var(--ui-scale, 1)) calc(10px * var(--ui-scale, 1))',
    fontSize: 'calc(12px * var(--ui-scale, 1))', color: '#5b21b6',
  };
  return (
    <>
      <div>
        <div style={labelStyle}>{dropLabel}</div>
        {editable
          ? <ApptInput value={drop} onChange={onEditDrop} placeholder="Drop time" headerColor="#7c3aed" />
          : <div style={readOnlyBox} title="Set this on the handoff row in the Relay section">
              {drop ? fmtAppt(drop) : <span style={{ color: '#a78bfa' }}>Set in Relay section</span>}
            </div>}
      </div>
      <div>
        <div style={labelStyle}>{pickupLabel}</div>
        {editable
          ? <ApptInput value={pickup} onChange={onEditPickup} placeholder="Pickup time" headerColor="#7c3aed" />
          : <div style={readOnlyBox} title="Set this on the handoff row in the Relay section">
              {pickup ? fmtAppt(pickup) : <span style={{ color: '#a78bfa' }}>Set in Relay section</span>}
            </div>}
      </div>
      {error && (
        <div style={{ fontSize: 11, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '5px 8px', marginTop: 2 }}>
          {error}
        </div>
      )}
    </>
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

/** Relay/leg accent — matches EventModal's RELAY_COLOR. */
const RELAY_ACCENT = '#7c3aed';
/** Per-leg rail colors, cycled. Leg 1 keeps the familiar relay purple
 *  so 2-leg loads look exactly as they did. */
const LEG_RAIL_COLORS = ['#7c3aed', '#0891b2', '#c2410c', '#15803d', '#b45309', '#be185d'];

const STOP_TYPES: StopType[] = ['pickup', 'delivery', 'drop', 'drop_hook', 'stop', 'relay'];
const TYPE_LABELS: Record<StopType, string> = {
  pickup: 'Pickup', delivery: 'Delivery', drop: 'Drop Trailer', drop_hook: 'Drop & Hook', stop: 'Stop', relay: 'Relay Point',
};


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

export default function StopsSection({ stops, onChange, headerColor, onMapRoute, onActivateRelay, relayActive, relayRole, legIndex, legCount, legDriverNames, legBuilder, onToggleHandoff, onInsertHandoffAfter, legColors, eventStart, eventEnd, loadedMiles, loadPrice, ratePerMile }: Props) {
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
  const [relayTimeError, setRelayTimeError] = useState<string | null>(null);
  const relayErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showRelayError(msg: string) {
    setRelayTimeError(msg);
    if (relayErrTimer.current) clearTimeout(relayErrTimer.current);
    relayErrTimer.current = setTimeout(() => setRelayTimeError(null), 3500);
  }

  // Transient banner under the section header — used when a stop-type
  // change to "Relay Point" is blocked (it would create an orphan
  // marker with no matching leg, which corrupts every leg's window and
  // blocks Save). Longer timeout than the time warning: it carries an
  // instruction, not just a nudge.
  const [typeChangeError, setTypeChangeError] = useState<string | null>(null);
  const typeErrTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showTypeChangeError(msg: string) {
    setTypeChangeError(msg);
    if (typeErrTimer.current) clearTimeout(typeErrTimer.current);
    typeErrTimer.current = setTimeout(() => setTypeChangeError(null), 6000);
  }

  // Always-current ref to stops so async callbacks don't use stale closures
  const stopsRef = useRef(stops);
  useEffect(() => { stopsRef.current = stops; }, [stops]);

  // Fetch saved locations on first render if not yet loaded
  useEffect(() => {
    if (savedLocations.length === 0) void fetchSavedLocs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


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
          {onActivateRelay && !relayActive && (
            <button
              type="button"
              onClick={onActivateRelay}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
              style={{ color: '#7c3aed', border: '1px solid #ddd6fe', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <ArrowLeftRight size={11} /> {stops.some(s => s.type === 'relay') ? 'Add handoff' : 'Split / Relay'}
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
          {onMapRoute && stops.length >= 2 && geocodedCount >= 2 && (
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

      {typeChangeError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '7px 10px', marginBottom: 8 }}>
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          <span>{typeChangeError}</span>
        </div>
      )}

      {/* Stop rows */}
      <div className="space-y-2">
        {(() => {
          // Handoff boundary positions, sequence order. Boundary i sits
          // between leg i and leg i+1. A boundary is either a bare
          // relay-point stop or a REAL stop flagged isHandoff — always
          // resolve via the shared helper, never `type === 'relay'`.
          const markerIdxs = handoffIndexes(stops);
          // Viewed-leg position: explicit legIndex wins; legacy relayRole
          // maps pickup=first, delivery=last, transfer=middle-of-3.
          const viewedLeg = legIndex ?? (
            relayRole === 'pickup'   ? 0
            : relayRole === 'delivery' ? markerIdxs.length
            : relayRole === 'transfer' ? Math.min(1, Math.max(0, markerIdxs.length - 1))
            : undefined);
          const isThisLeg = (idx: number) => {
            if (viewedLeg == null || markerIdxs.length === 0) return true;
            const lo = viewedLeg === 0 ? 0 : (markerIdxs[viewedLeg - 1] ?? 0);
            const hi = viewedLeg >= markerIdxs.length ? stops.length - 1 : markerIdxs[viewedLeg];
            // Boundary markers belong to both adjacent legs.
            return idx >= lo && idx <= hi;
          };
          const showDividers = viewedLeg != null || (legCount ?? 0) > 1 || legBuilder;
          // Leg each stop belongs to = number of boundaries strictly
          // before it. A boundary stop reads as the EARLIER leg (the
          // handoff happens after it); the next row opens the next leg.
          const legOf = (idx: number) => markerIdxs.filter(m => m < idx).length;
          const legTint = (leg: number) =>
            legColors?.[leg] ?? LEG_RAIL_COLORS[leg % LEG_RAIL_COLORS.length];
          const totalLegs = markerIdxs.length + 1;
          return stops.map((stop, idx) => {
          const cfg = TYPE_CONFIG[stop.type] ?? TYPE_CONFIG.stop;
          const thisLeg = isThisLeg(idx);
          const markerOrdinal = markerIdxs.indexOf(idx);
          const isBoundary = markerOrdinal >= 0;
          // A bare relay POINT is itself the handoff location, so its
          // divider reads above the row. A real stop flagged isHandoff
          // hands off AFTER servicing it — divider goes below.
          const dividerBelow = isBoundary && isHandoffStop(stop) && stop.type !== 'relay';
          const showThisDivider = isBoundary && showDividers;
          // Divider labeled with who hands the load to whom when both
          // legs' drivers are known.
          const fromName = legDriverNames?.[markerOrdinal]?.trim();
          const toName   = legDriverNames?.[markerOrdinal + 1]?.trim();
          const dividerLabel = fromName && toName
            ? `${fromName} drops → ${toName} picks up`
            : `Handoff ${markerOrdinal + 1}`;
          const dividerNode = showThisDivider ? (
            <div key={`divider-${stop.id}`} className="flex items-center gap-2 px-1 py-0.5">
              <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-lg"
                style={{ background: '#f5f3ff', color: RELAY_ACCENT, border: '1px solid #ddd6fe' }}>
                {dividerLabel}
              </span>
              <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
            </div>
          ) : null;
          const divider = dividerBelow ? null : dividerNode;
          const stopLeg = legOf(idx);
          const isFirst = idx === 0;
          const isLast  = idx === stops.length - 1;
          // The handoff toggle is only meaningful on an INTERMEDIATE
          // real stop — the first and last stop can never be boundaries
          // (server enforces it too), and a bare relay point is always
          // one.
          const canToggleHandoff = !!legBuilder && !!onToggleHandoff
            && !isFirst && !isLast && stop.type !== 'relay';

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
                // Leg rail — the colored bracket down the left of every
                // row showing which leg the stop belongs to.
                ...(legBuilder && totalLegs > 1
                  ? { borderLeft: `3px solid ${legTint(stopLeg)}`, paddingLeft: 8 }
                  : {}),
              }}
            >
              {/* Leg tag — which leg this stop belongs to. Boundary
                  stops carry both legs since they're serviced by the
                  driver dropping AND the one picking up. */}
              {legBuilder && totalLegs > 1 && (
                <span style={{
                  position: 'absolute', top: -7, left: 8, zIndex: 1,
                  fontSize: 9, fontWeight: 800, letterSpacing: '0.04em',
                  textTransform: 'uppercase', lineHeight: 1,
                  padding: '2px 5px', borderRadius: 4,
                  color: '#fff', background: legTint(stopLeg),
                  whiteSpace: 'nowrap',
                }}>
                  Leg {stopLeg + 1}{isBoundary ? ` → ${stopLeg + 2}` : ''}
                </span>
              )}

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
                  onChange={e => {
                    const nextType = e.target.value as StopType;
                    if (nextType === 'relay' && stop.type !== 'relay') {
                      // A relay point only makes sense with a leg on each
                      // side: an N-leg load carries exactly N-1 markers
                      // (legCount already includes any pending draft leg).
                      // Converting a stop beyond that creates an orphan
                      // marker that blocks Save — steer to the real flow.
                      // Re-converting after an accidental delete (count
                      // below the allowance) is still permitted.
                      const allowed = Math.max(0, (legCount ?? (relayRole ? 2 : 1)) - 1);
                      const current = stops.filter(s => s.type === 'relay').length;
                      if (current + 1 > allowed) {
                        showTypeChangeError(
                          allowed === 0
                            ? 'To split this load into a relay, use the "Split / Relay" button above — it creates the relay point and the second leg together.'
                            : 'This load already has a relay point for every handoff. To add another handoff, use "+ Add handoff" — it creates the relay point and the new leg together.',
                        );
                        return;
                      }
                    }
                    update(idx, { type: nextType });
                  }}
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
                {/* Facility + address — the SHARED implementation, also
                    mounted by the leg builder's handoff box. Relay
                    points are read-only in builder mode (edited in the
                    Relay section) but stay editable everywhere else. */}
                <StopAddressFields
                  stop={stop}
                  onChange={patch => update(idx, patch)}
                  headerColor={headerColor}
                  showFacility={stop.type !== 'relay'}
                  readOnly={!!legBuilder && isBoundary}
                />
                {legBuilder && isBoundary && (
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: RELAY_ACCENT, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <ArrowLeftRight size={10} style={{ flexShrink: 0 }} />
                    Handoff — edit in the Relay section above
                  </div>
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

              {/* Appt window — caps at 320px on roomy screens so the
                  Appt / Window / FCFS pills + date/time inputs stay on
                  one line, but `clamp` lets it shrink on narrower
                  surfaces (load detail page on smaller monitors,
                  narrowed EventModal) so the column stays proportionate
                  to the facility/address column instead of dominating
                  the row. flexShrink: 1 + min-width 0 lets the inputs
                  inside ride that shrink without overflowing. */}
              <div style={{ flexShrink: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, width: 'clamp(150px, 30%, 240px)' }}>
                {stop.type === 'relay' ? (
                  // Handoff times are edited in the LEGS EDITOR now, so
                  // there is exactly one place to set them. Shown here
                  // read-only for context while routing the stops.
                  <HandoffTimesReadOnly
                    dropLabel={fromName ? `${fromName} drops` : 'Driver 1 drop'}
                    pickupLabel={toName ? `${toName} picks up` : 'Driver 2 pickup'}
                    drop={toView(stop.apptStart)}
                    pickup={toView(stop.apptEnd)}
                    editable={!legBuilder}
                    onEditDrop={v => {
                      setRelayTimeError(null);
                      const stored = toHome(v);
                      update(idx, { apptStart: stored });
                      if (stop.apptEnd && stored && stored > stop.apptEnd) {
                        showRelayError('Driver 1 drop is after Driver 2 pickup — check times.');
                      }
                    }}
                    onEditPickup={v => {
                      setRelayTimeError(null);
                      const stored = toHome(v);
                      update(idx, { apptEnd: stored });
                      if (stop.apptStart && stored && stored < stop.apptStart) {
                        showRelayError('Driver 2 pickup is before Driver 1 drop — check times.');
                      }
                    }}
                    error={relayTimeError}
                  />
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
                    {/* Handoff-on-a-real-stop toggle. Turns THIS stop
                        into a leg boundary (no duplicate relay point
                        needed) and reveals the two handoff times. */}
                    {canToggleHandoff && (
                      <div style={{ marginTop: 2 }}>
                        <button
                          type="button"
                          onClick={() => onToggleHandoff!(idx)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 5, width: '100%',
                            fontSize: 10.5, fontWeight: 700, letterSpacing: '0.01em',
                            padding: '4px 7px', borderRadius: 6, cursor: 'pointer',
                            border: `1px ${stop.isHandoff ? 'solid' : 'dashed'} ${stop.isHandoff ? RELAY_ACCENT : '#ddd6fe'}`,
                            background: stop.isHandoff ? '#f5f3ff' : 'transparent',
                            color: RELAY_ACCENT,
                          }}
                          title={stop.isHandoff
                            ? 'Remove the handoff here — merges this leg with the next one'
                            : 'End a leg at this stop — the next driver takes over from here'}
                        >
                          <ArrowLeftRight size={10} style={{ flexShrink: 0 }} />
                          <span style={{ textAlign: 'left' }}>
                            {stop.isHandoff ? 'Handoff after this stop' : 'Handoff after this stop?'}
                          </span>
                        </button>
                        {stop.isHandoff && (
                          // Read-only mirror — the handoff row in the
                          // legs editor owns these two values.
                          <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <HandoffTimesReadOnly
                              dropLabel={fromName ? `${fromName} drops` : 'Driver 1 drop'}
                              pickupLabel={toName ? `${toName} picks up` : 'Driver 2 pickup'}
                              drop={toView(stop.handoffDropAt)}
                              pickup={toView(stop.handoffPickupAt)}
                              editable={false}
                              onEditDrop={() => {}}
                              onEditPickup={() => {}}
                              error={null}
                            />
                          </div>
                        )}
                      </div>
                    )}
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
            {/* Handoff-on-a-stop reads as "after this stop", so its
                divider renders below the row it belongs to. */}
            {dividerBelow ? dividerNode : null}
            {/* "+ add handoff between these stops" — creates a NEW
                relay-point stop in the gap (the yard case: a handoff
                location that isn't a stop yet). Not offered after the
                last stop (a handoff needs a leg on each side) nor
                adjacent to an existing boundary. */}
            {legBuilder && onInsertHandoffAfter && !isLast && !isBoundary && !markerIdxs.includes(idx + 1) && (
              <div className="flex items-center gap-2 px-1" style={{ paddingTop: 4 }}>
                <div className="flex-1 h-px" style={{ background: 'var(--gc-border-light)' }} />
                <button type="button" onClick={() => onInsertHandoffAfter(idx)}
                  className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg font-semibold transition-colors"
                  style={{ color: RELAY_ACCENT, border: '1px dashed #ddd6fe', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  title="Add a new relay point between these stops (e.g. the yard)">
                  <Plus size={9} /> Add handoff between these stops
                </button>
                <div className="flex-1 h-px" style={{ background: 'var(--gc-border-light)' }} />
              </div>
            )}
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
