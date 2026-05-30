/**
 * AssetDetailModal — combined "current location + movement history"
 * view for a single asset.
 *
 * Layout (1200 × 720):
 *   ┌─────────────────────────────────┬───────────────────┐
 *   │                                 │  Range chips      │
 *   │                                 │  Totals           │
 *   │         MAP (left, 60%)         │  ─────            │
 *   │   - Truck marker when no card   │  May 21           │
 *   │     selected (zoomed in)        │   [card]          │
 *   │   - Road route when a card is   │   [card]          │
 *   │     selected                    │  May 20           │
 *   │                                 │   [card]          │
 *   │   Floating overlay (bottom):    │   [card]          │
 *   │   - Last seen info OR           │                   │
 *   │   - Movement details + ← →      │                   │
 *   └─────────────────────────────────┴───────────────────┘
 *
 * Clicking a movement card on the right paints its road route on the
 * same map and shows a details overlay. ← → step through clusters in
 * chronological order. No nested modal.
 */
'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, MapPin, Loader2, ChevronLeft, ChevronRight, ExternalLink, Truck, Gauge, Sparkles } from 'lucide-react';
import type { Asset } from '@/lib/types';
import type { MotiveLocation } from '@/app/api/motive/locations/route';
import { railway, type MovementCard } from '@/lib/railway';
import { clusterMovements, extractCity, type MovementCluster } from '@/lib/clusterMovements';
import { useCalendarStore } from '@/store/useCalendarStore';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import DatePicker from './DatePicker';
import OdometerChart from './OdometerChart';
import CostAnalysisPanel from './CostAnalysisPanel';

type Tab = 'movements' | 'odometer' | 'cost';

interface Props {
  asset:    Asset;
  location: MotiveLocation | null;
  onClose:  () => void;
  /** When set, the modal auto-selects the cluster containing this
   *  Motive driving_period id once data loads. Used when opening from
   *  a calendar movement card click. */
  initialMotivePeriodId?: number;
}

const PRESETS = [
  { key: 'today', label: 'Today',    days: 1  },
  { key: '7d',    label: 'Last 7d',  days: 7  },
  { key: '30d',   label: 'Last 30d', days: 30 },
] as const;
type PresetKey = typeof PRESETS[number]['key'];
type RangeKey  = PresetKey | 'custom';

function fmtDayChip(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtDuration(min: number): string {
  if (min < 1) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Tint asset.color with an alpha — used for card highlight backgrounds. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return `rgba(0,0,0,${alpha})`;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function fmtDateTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

/** Build the colored-truck DOM element used as the live-location
 *  marker on the map. Same Lucide Truck SVG used elsewhere in the
 *  app, set in white over the asset color. */
function makeTruckMarker(color: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'position:relative;width:48px;height:48px;';
  const pulse = document.createElement('div');
  pulse.style.cssText = `position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.25;animation:truck-pulse 2s ease-out infinite;`;
  const badge = document.createElement('div');
  badge.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:38px;height:38px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;`;
  badge.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
      <path d="M15 18H9"/>
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>
      <circle cx="17" cy="18" r="2"/>
      <circle cx="7" cy="18" r="2"/>
    </svg>
  `;
  if (!document.getElementById('truck-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'truck-pulse-style';
    style.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
    document.head.appendChild(style);
  }
  el.appendChild(pulse);
  el.appendChild(badge);
  return el;
}

/** Small labeled dot used for Start / End / waypoint markers. */
function makeDotMarker(color: string, label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `position:relative;width:16px;height:16px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);`;
  if (label) {
    const tag = document.createElement('div');
    tag.style.cssText = 'position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;color:#111;background:rgba(255,255,255,0.95);padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.15);';
    tag.textContent = label;
    el.appendChild(tag);
  }
  return el;
}

export default function AssetDetailModal({ asset, location, onClose, initialMotivePeriodId }: Props) {
  const overlayRef        = useRef<HTMLDivElement>(null);
  const mapContainer      = useRef<HTMLDivElement>(null);
  const mapRef            = useRef<google.maps.Map | null>(null);
  // Imperative refs for layer cleanup between selection changes.
  const markersRef        = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const directionsRef     = useRef<google.maps.DirectionsRenderer | null>(null);
  const polylineRef       = useRef<google.maps.Polyline | null>(null);
  const { calendarTimezone } = useCalendarStore();

  const [tab, setTab]                   = useState<Tab>('movements');
  const [range, setRange]               = useState<RangeKey>('7d');
  const [customDate, setCustomDate]     = useState<string>('');
  const [movements, setMovements]       = useState<MovementCard[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  /** Index into the chronologically-ascending clusters array. null =
   *  show current location instead. */
  const [selectedIdx, setSelectedIdx]   = useState<number | null>(null);
  /** Flips true once mapRef.current is initialized — the layer-paint
   *  effect needs this so it doesn't try to draw before the Map
   *  instance exists. */
  const [mapReady, setMapReady]         = useState(false);

  const linkedToMotive = !!asset.motiveVehicleId;

  const lookbackDays = (() => {
    if (range === 'custom' && customDate) {
      const todayMs = new Date().setHours(0, 0, 0, 0);
      const pickMs  = new Date(`${customDate}T00:00:00`).getTime();
      return Math.max(1, Math.ceil((todayMs - pickMs) / 86_400_000) + 1);
    }
    return PRESETS.find(p => p.key === range)?.days ?? 7;
  })();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If we have a known current location, Esc deselects first
        // and closes only on the second press. Without a location to
        // fall back to, Esc just closes — the empty-map state would
        // be useless.
        if (selectedIdx !== null && location) setSelectedIdx(null);
        else onClose();
      } else if (e.key === 'ArrowRight' && selectedIdx !== null) {
        setSelectedIdx(i => i !== null && i < (clustersRef.current.length - 1) ? i + 1 : i);
      } else if (e.key === 'ArrowLeft' && selectedIdx !== null) {
        setSelectedIdx(i => i !== null && i > 0 ? i - 1 : i);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, selectedIdx, location]);

  // Read-from-DB only. Motive ingestion happens in two places, both
  // outside this modal: the 5-min incremental cron, and the manual
  // "Backfill" buttons in Settings → Integrations → Motive. The modal
  // just paints whatever's in the DB for the requested window. If a
  // user wants older data than the cron's covered, they trigger a
  // wider backfill once from Settings and it's there for everyone.
  useEffect(() => {
    if (!linkedToMotive) return;
    if (range === 'custom' && !customDate) return;
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      setSelectedIdx(null); // reset selection when range changes
      try {
        let fromIso: string;
        let toIso:   string;
        if (range === 'custom' && customDate) {
          const dayMs  = 86_400_000;
          const baseMs = new Date(`${customDate}T00:00:00Z`).getTime();
          fromIso = new Date(baseMs - dayMs / 2).toISOString();
          toIso   = new Date(baseMs + 1.5 * dayMs).toISOString();
        } else {
          const nowMs = Date.now();
          fromIso = new Date(nowMs - lookbackDays * 86_400_000).toISOString();
          toIso   = new Date(nowMs).toISOString();
        }
        const res = await railway.listMovements(fromIso, toIso);
        if (cancelled) return;
        setMovements(res.byVehicle[String(asset.motiveVehicleId)] ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load movements');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range, customDate, lookbackDays, asset.motiveVehicleId, linkedToMotive]);

  // Clusters in chronological-ascending order (oldest → newest). This
  // is what selectedIdx indexes into.
  const clusters = useMemo(() => {
    const all = clusterMovements(movements);
    if (range !== 'custom' || !customDate) return all;
    const dayInTz = (iso: string) => new Intl.DateTimeFormat('en-CA', {
      timeZone: calendarTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
    return all.filter(c => dayInTz(c.startTime) === customDate);
  }, [movements, range, customDate, calendarTimezone]);

  // Mirror clusters into a ref so the keydown handler can see the
  // latest array without re-subscribing.
  const clustersRef = useRef<MovementCluster[]>(clusters);
  useEffect(() => { clustersRef.current = clusters; }, [clusters]);

  // If opened from a calendar movement click, pre-select the cluster
  // containing that motive_period id. Runs once after clusters land.
  const initialAppliedRef = useRef(false);
  useEffect(() => {
    if (initialAppliedRef.current) return;
    if (initialMotivePeriodId == null) { initialAppliedRef.current = true; return; }
    if (clusters.length === 0) return;
    const idx = clusters.findIndex(c => c.members.some(m => m.id === initialMotivePeriodId));
    if (idx >= 0) setSelectedIdx(idx);
    initialAppliedRef.current = true;
  }, [clusters, initialMotivePeriodId]);

  const selectedCluster = selectedIdx !== null ? clusters[selectedIdx] : null;

  // Groups for the right-hand list. Days reversed (newest first) and
  // each day's clusters reversed too — dispatchers expect recent
  // activity at the top.
  const groups = useMemo(() => {
    const map = new Map<string, { cluster: MovementCluster; idx: number }[]>();
    clusters.forEach((c, idx) => {
      const day = new Intl.DateTimeFormat('en-US', {
        timeZone: calendarTimezone,
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      }).format(new Date(c.startTime));
      const arr = map.get(day) ?? [];
      arr.push({ cluster: c, idx });
      map.set(day, arr);
    });
    return [...map.entries()].reverse().map(([day, items]) =>
      [day, items.slice().reverse()] as const,
    );
  }, [clusters, calendarTimezone]);

  const totals = useMemo(() => {
    let miles = 0, minutes = 0, periods = 0;
    for (const c of clusters) {
      miles   += c.miles;
      minutes += c.durationMin;
      periods += c.members.length;
    }
    return { count: clusters.length, totalPeriods: periods, miles, minutes };
  }, [clusters]);

  // Initialize the Map once, then drive it imperatively from a second
  // effect that responds to selection changes. Avoids re-mounting.
  useEffect(() => {
    if (!mapContainer.current) return;
    if (mapRef.current) return;
    let cancelled = false;
    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current || mapRef.current) return;
      const center = location
        ? { lat: location.lat, lng: location.lon }
        : { lat: 39.5, lng: -98.35 }; // continental US fallback
      mapRef.current = new google.maps.Map(mapContainer.current, {
        center, zoom: 14, mapId: MAP_ID,
        disableDefaultUI: false, clickableIcons: false,
        gestureHandling: 'greedy',
      });
      setMapReady(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-paint the map's layer whenever selection changes. Waits on
  // mapReady so the first paint doesn't fire while the map promise
  // is still resolving.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let cancelled = false;
    (async () => {
      const google = await loadGoogleMaps();
      if (cancelled || !mapRef.current) return;
      const map = mapRef.current;

      // Clear previous layer
      for (const m of markersRef.current) m.map = null;
      markersRef.current = [];
      if (directionsRef.current) { directionsRef.current.setMap(null); directionsRef.current = null; }
      if (polylineRef.current)   { polylineRef.current.setMap(null);   polylineRef.current   = null; }

      if (selectedCluster) {
        // Route view — DirectionsService with optional cluster waypoints
        const firstWithOrigin = selectedCluster.members.find(m => m.originLat != null && m.originLon != null);
        const lastWithDest    = [...selectedCluster.members].reverse().find(m => m.destinationLat != null && m.destinationLon != null);
        const startPos = firstWithOrigin
          ? { lat: firstWithOrigin.originLat as number, lng: firstWithOrigin.originLon as number }
          : null;
        const endPos = lastWithDest
          ? { lat: lastWithDest.destinationLat as number, lng: lastWithDest.destinationLon as number }
          : null;

        const isCluster = selectedCluster.members.length > 1;
        const waypoints: google.maps.DirectionsWaypoint[] = [];
        if (isCluster) {
          selectedCluster.members.forEach((m, idx) => {
            if (idx === 0) return;
            if (m.originLat != null && m.originLon != null) {
              waypoints.push({ location: { lat: m.originLat, lng: m.originLon }, stopover: true });
              const marker = new google.maps.marker.AdvancedMarkerElement({
                map, position: { lat: m.originLat, lng: m.originLon }, content: makeDotMarker(asset.color, `${idx + 1}`),
              });
              markersRef.current.push(marker);
            }
          });
        }
        if (startPos) {
          markersRef.current.push(new google.maps.marker.AdvancedMarkerElement({
            map, position: startPos, content: makeDotMarker('#16a34a', isCluster ? '1' : 'Start'),
          }));
        }
        if (endPos) {
          markersRef.current.push(new google.maps.marker.AdvancedMarkerElement({
            map, position: endPos, content: makeDotMarker('#dc2626', 'End'),
          }));
        }

        if (startPos && endPos) {
          const directionsService  = new google.maps.DirectionsService();
          const directionsRenderer = new google.maps.DirectionsRenderer({
            map, suppressMarkers: true,
            polylineOptions: { strokeColor: asset.color, strokeOpacity: 0.85, strokeWeight: 4 },
            preserveViewport: false,
          });
          directionsRef.current = directionsRenderer;
          directionsService.route(
            { origin: startPos, destination: endPos, waypoints, travelMode: google.maps.TravelMode.DRIVING, optimizeWaypoints: false },
            (result, status) => {
              if (cancelled) return;
              if (status === google.maps.DirectionsStatus.OK && result) {
                directionsRenderer.setDirections(result);
              } else {
                // Fallback: dashed straight polyline through all points.
                const path: google.maps.LatLngLiteral[] = [];
                if (startPos) path.push(startPos);
                for (const wp of waypoints) path.push(wp.location as google.maps.LatLngLiteral);
                if (endPos) path.push(endPos);
                if (path.length >= 2) {
                  polylineRef.current = new google.maps.Polyline({
                    path, map, strokeColor: asset.color, strokeOpacity: 0.6, strokeWeight: 3, geodesic: true,
                    icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '12px' }],
                  });
                }
                const bounds = new google.maps.LatLngBounds();
                if (startPos) bounds.extend(startPos);
                if (endPos)   bounds.extend(endPos);
                waypoints.forEach(wp => bounds.extend(wp.location as google.maps.LatLngLiteral));
                map.fitBounds(bounds, 60);
              }
            },
          );
        } else if (startPos || endPos) {
          map.setCenter((startPos ?? endPos)!);
          map.setZoom(13);
        }
      } else if (location) {
        // Current-location view — zoomed in colored truck
        const marker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: location.lat, lng: location.lon },
          content: makeTruckMarker(asset.color),
        });
        markersRef.current.push(marker);
        map.setCenter({ lat: location.lat, lng: location.lon });
        map.setZoom(15);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, location, asset.color, asset.motiveVehicleId, mapReady]);

  // Auto-scroll the right list to keep the selected card visible.
  const cardRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  useEffect(() => {
    if (selectedIdx === null) return;
    const el = cardRefs.current.get(selectedIdx);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIdx]);

  if (typeof document === 'undefined') return null;

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', zIndex: 999 }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden"
        style={{
          width: tab === 'cost' ? 1600 : 1200,
          height: 864,
          maxWidth: '96vw',
          maxHeight: '94vh',
          background: 'var(--gc-surface)',
          boxShadow: 'var(--shadow-3)',
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: asset.color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{asset.name}</span>
              {asset.unit && <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>#{asset.unit}</span>}
              {!linkedToMotive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1"
                  style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-3)' }}>
                  No ELD
                </span>
              )}
              {/* Quick link to the new asset timeline (per-day events vs
                  movements side-by-side). Opens in a new tab so the
                  current modal context isn't disrupted. */}
              <a
                href={`/timeline?assetId=${asset.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1 flex items-center gap-1"
                style={{ background: 'var(--gc-blue-tint)', color: 'var(--gc-blue)' }}
              >
                Timeline <ExternalLink size={10} />
              </a>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* Left: full-height map (~60%) — hidden on Cost tab so the
              wide table has the entire modal width to itself. The
              map adds no value when reading financial analytics. */}
          <div
            className="relative flex-1 min-w-0"
            style={{
              borderRight: '1px solid var(--gc-border-light)',
              display: tab === 'cost' ? 'none' : 'block',
            }}
          >
            <div ref={mapContainer} className="absolute inset-0" />

            {/* Bottom overlay — swaps between "last seen" and movement details */}
            <div className="absolute bottom-3 left-3 right-3 rounded-xl px-3 py-2.5 flex items-center gap-3"
              style={{ background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(6px)', border: '1px solid var(--gc-border)', boxShadow: 'var(--shadow-2)' }}>
              {selectedCluster ? (
                <>
                  {/* Movement details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                        {(() => {
                          const o = extractCity(selectedCluster.origin);
                          const d = extractCity(selectedCluster.destination);
                          const same = o && d && o.toLowerCase() === d.toLowerCase();
                          return o && d ? (same ? `around ${o}` : `${o} → ${d}`) : (o ?? d ?? '—');
                        })()}
                      </span>
                      {selectedCluster.members.length > 1 && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                          style={{ background: asset.color, color: 'white' }}>
                          {selectedCluster.members.length} moves
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
                      {fmtDateTime(selectedCluster.startTime, calendarTimezone)} – {fmtTime(selectedCluster.endTime, calendarTimezone)}
                      {' · '}{selectedCluster.miles.toFixed(1)} mi · {fmtDuration(selectedCluster.durationMin)}
                    </div>
                  </div>
                  {/* Prev / Next / Close */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setSelectedIdx(i => i !== null && i > 0 ? i - 1 : i)}
                      disabled={selectedIdx === 0}
                      className="p-1.5 rounded-full transition-colors disabled:opacity-30"
                      style={{ color: 'var(--gc-text-2)' }}
                      onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      title="Earlier (← key)"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="text-[10px] font-mono tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                      {selectedIdx !== null ? selectedIdx + 1 : 0} / {clusters.length}
                    </span>
                    <button
                      onClick={() => setSelectedIdx(i => i !== null && i < clusters.length - 1 ? i + 1 : i)}
                      disabled={selectedIdx !== null && selectedIdx === clusters.length - 1}
                      className="p-1.5 rounded-full transition-colors disabled:opacity-30"
                      style={{ color: 'var(--gc-text-2)' }}
                      onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      title="Later (→ key)"
                    >
                      <ChevronRight size={16} />
                    </button>
                    {location && (
                      <button
                        onClick={() => setSelectedIdx(null)}
                        className="flex items-center gap-1 ml-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors"
                        style={{ color: asset.color, background: hexToRgba(asset.color, 0.12), border: `1px solid ${hexToRgba(asset.color, 0.3)}` }}
                        onMouseEnter={e => { e.currentTarget.style.background = hexToRgba(asset.color, 0.2); }}
                        onMouseLeave={e => { e.currentTarget.style.background = hexToRgba(asset.color, 0.12); }}
                        title="Back to current location (Esc)"
                      >
                        <Truck size={11} />
                        Current location
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Last seen */}
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: asset.color }} />
                  <div className="flex-1 min-w-0">
                    {location ? (
                      <>
                        <div className="flex items-center gap-1">
                          <MapPin size={11} style={{ color: 'var(--gc-text-2)', flexShrink: 0 }} />
                          <span className="text-[12px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>{location.description}</span>
                        </div>
                        <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                          Last seen {fmtDateTime(location.locatedAt, calendarTimezone)}
                        </div>
                      </>
                    ) : (
                      <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                        {linkedToMotive ? 'No telemetry yet' : 'Asset not linked to Motive'}
                      </span>
                    )}
                  </div>
                  {location && (
                    <a
                      href={`https://www.google.com/maps?q=${location.lat},${location.lon}`}
                      target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[11px] font-medium shrink-0"
                      style={{ color: 'var(--gc-blue)', textDecoration: 'none' }}
                    >
                      <ExternalLink size={10} /> Maps
                    </a>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right: movements list OR odometer chart, depending on tab */}
          <div
            className="flex flex-col"
            style={{
              // Cost tab: panel takes the whole modal (map is hidden).
              // Other tabs: keep the original narrow side panel.
              width: tab === 'cost' ? '100%' : 460,
              flexShrink: tab === 'cost' ? 1 : 0,
            }}
          >
            {/* Tab toggle — Movements (default) / Odometer */}
            <div className="flex items-center gap-1 px-4 pt-3" style={{ color: 'var(--gc-text-3)' }}>
              {([
                { key: 'movements', label: 'Movements', icon: <ChevronRight size={11} /> },
                { key: 'odometer',  label: 'Odometer',  icon: <Gauge size={11} /> },
                { key: 'cost',      label: 'Cost',      icon: <Sparkles size={11} /> },
              ] as const).map(t => {
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors"
                    style={{
                      background: active ? hexToRgba(asset.color, 0.12) : 'transparent',
                      color:      active ? asset.color : 'var(--gc-text-3)',
                      border:     active ? `1px solid ${hexToRgba(asset.color, 0.3)}` : '1px solid transparent',
                    }}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                );
              })}
            </div>

            {tab === 'movements' && (
            <div className="px-4 py-3 shrink-0">
              <div className="flex items-center gap-1 mb-2.5 flex-wrap">
                {PRESETS.map(p => {
                  const active = range === p.key;
                  return (
                    <button
                      key={p.key}
                      onClick={() => setRange(p.key)}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                      style={{
                        background: active ? 'var(--gc-blue-light)' : 'transparent',
                        color:      active ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                        border:     active ? '1px solid var(--gc-blue-light)' : '1px solid transparent',
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
                <DatePicker
                  value={customDate}
                  onChange={(v) => { setCustomDate(v); setRange('custom'); }}
                  headerColor="var(--gc-blue)"
                  displayText={range === 'custom' && customDate ? fmtDayChip(customDate) : 'Pick a day…'}
                  buttonStyle={{
                    width: 'auto',
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: 6,
                    background: range === 'custom' ? 'var(--gc-blue-light)' : 'transparent',
                    color:      range === 'custom' ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                    border:     range === 'custom' ? '1px solid var(--gc-blue-light)' : '1px solid transparent',
                  }}
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] flex-wrap" style={{ color: 'var(--gc-text-3)' }}>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{totals.count}</strong> {totals.count === 1 ? 'block' : 'blocks'}</span>
                <span>·</span>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{totals.miles.toFixed(0)}</strong> mi</span>
                <span>·</span>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{fmtDuration(totals.minutes)}</strong> driving</span>
              </div>
            </div>
            )}

            {tab === 'movements' && (
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {!linkedToMotive && (
                <div className="text-center py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  This asset isn&apos;t linked to a Motive vehicle yet.
                  <br />
                  <a href="/settings" className="font-medium" style={{ color: 'var(--gc-blue)' }}>Link it in Settings</a>
                </div>
              )}
              {linkedToMotive && loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {linkedToMotive && error && (
                <div className="text-center py-6 text-[12px]" style={{ color: '#d93025' }}>{error}</div>
              )}
              {linkedToMotive && !loading && !error && groups.length === 0 && (
                <div className="text-center py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  No movements in this period.
                </div>
              )}
              {linkedToMotive && groups.map(([day, dayItems]) => (
                <div key={day} className="mb-3">
                  <div className="sticky top-0 z-10 text-[10px] font-semibold uppercase tracking-wide py-1.5 mb-1.5"
                    style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-3)' }}>
                    {day}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {dayItems.map(({ cluster: c, idx }) => {
                      const o = extractCity(c.origin);
                      const d = extractCity(c.destination);
                      const sameCity = o && d && o.toLowerCase() === d.toLowerCase();
                      const route = o && d
                        ? (sameCity ? `around ${o}` : `${o} → ${d}`)
                        : (o ?? d ?? '—');
                      const time = fmtTime(c.startTime, calendarTimezone);
                      const selected = selectedIdx === idx;
                      return (
                        <button
                          key={c.id}
                          ref={(el) => {
                            if (el) cardRefs.current.set(idx, el);
                            else    cardRefs.current.delete(idx);
                          }}
                          onClick={() => setSelectedIdx(idx)}
                          className="relative flex items-center gap-3 pl-3.5 pr-3 py-2 rounded-lg text-left transition-colors overflow-hidden"
                          style={{
                            background: selected ? hexToRgba(asset.color, 0.14) : 'var(--gc-bg)',
                            border: `1px solid ${selected ? asset.color : 'var(--gc-border-light)'}`,
                          }}
                          onMouseEnter={e => { if (!selected) e.currentTarget.style.background = hexToRgba(asset.color, 0.06); }}
                          onMouseLeave={e => { e.currentTarget.style.background = selected ? hexToRgba(asset.color, 0.14) : 'var(--gc-bg)'; }}
                        >
                          {/* Color stripe — asset color, full height left edge */}
                          <span aria-hidden className="absolute left-0 top-0 bottom-0" style={{ width: 3, background: asset.color }} />
                          <div className="text-[12px] font-mono tabular-nums shrink-0" style={{ color: selected ? 'var(--gc-text-1)' : 'var(--gc-text-2)', minWidth: 56 }}>
                            {time}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-medium truncate" style={{ color: 'var(--gc-text-1)' }}>
                              {c.members.length > 1 ? `${c.members.length} · ` : ''}{route}
                            </div>
                            <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                              {c.miles.toFixed(1)} mi · {fmtDuration(c.durationMin)}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            )}

            {tab === 'odometer' && asset.motiveVehicleId && (
              <OdometerChart
                vehicleId={Number(asset.motiveVehicleId)}
                color={asset.color}
                days={lookbackDays}
              />
            )}
            {tab === 'odometer' && !asset.motiveVehicleId && (
              <div className="flex-1 flex items-center justify-center text-[12px] px-4 text-center" style={{ color: 'var(--gc-text-3)' }}>
                Link this asset to a Motive vehicle in Settings to see odometer history.
              </div>
            )}

            {tab === 'cost' && asset.motiveVehicleId && (
              <CostAnalysisPanel
                vehicleId={Number(asset.motiveVehicleId)}
                days={lookbackDays}
              />
            )}
            {tab === 'cost' && !asset.motiveVehicleId && (
              <div className="flex-1 flex items-center justify-center text-[12px] px-4 text-center" style={{ color: 'var(--gc-text-3)' }}>
                Link this asset to a Motive vehicle in Settings before running cost analysis — it needs telemetry to match against the load schedule.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
