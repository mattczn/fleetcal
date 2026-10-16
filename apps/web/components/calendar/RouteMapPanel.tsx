'use client';

import { useEffect, useRef, useState } from 'react';
import { X, MapPin, Clock, Truck, CheckCircle2, Activity, Route, Navigation, ChevronLeft, ChevronRight } from 'lucide-react';
import type { LoadTrailDrive, LoadTrailResponse, LoadTrailRole } from '@fleetcal/types';
import type { Stop, StopType } from '@/lib/types';
import { railway } from '@/lib/railway';
import { extractCity } from '@/lib/clusterMovements';
import { fmtStopWindow } from './StopsSection';
import { useCalendarStore } from '@/store/useCalendarStore';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';

const VERIFY_THRESHOLD_MI = 0.5;

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

function fmtCheckInTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

interface Props {
  stops: Stop[];
  /** Required in modal mode (the EventModal sets this to close the
   *  map panel). Optional in embedded mode — the page-level container
   *  manages its own visibility and never needs the X. */
  onClose?: () => void;
  motiveVehicleId?: string;
  /** When true, drops the hardcoded 44% width and the close-button
   *  header so the panel renders full-size inside a card on the load
   *  detail page (or anywhere else that wants the map standalone).
   *  Default false preserves the EventModal-side-panel behaviour. */
  embedded?: boolean;
  /** Calendar entry whose GPS trail to draw (any leg of the load). In
   *  modal mode it defaults to the open modal's event. */
  eventId?: string;
}

// The GPS trail: drives the movement linker charged to this load
// (docs/movement-linking.md). Dashed = empty miles.
const TRAIL_STYLE: Record<LoadTrailRole, { color: string; label: string; dashed: boolean }> = {
  deadhead:    { color: '#f59e0b', label: 'Deadhead in',  dashed: true },
  loaded:      { color: '#16a34a', label: 'Loaded (GPS)', dashed: false },
  return:      { color: '#9333ea', label: 'Return',       dashed: true },
  non_revenue: { color: '#64748b', label: 'Non-revenue',  dashed: true },
};

interface TruckLocation {
  lat: number;
  lon: number;
  description: string;
  locatedAt: string;
}


const TYPE_CONFIG: Record<StopType, { label: string; color: string; bg: string }> = {
  pickup:    { label: 'Pickup',       color: '#166534', bg: '#dcfce7' },
  delivery:  { label: 'Delivery',     color: '#991b1b', bg: '#fee2e2' },
  drop:      { label: 'Drop Trailer', color: '#0e7490', bg: '#cffafe' },
  drop_hook: { label: 'Drop & Hook',  color: '#1e40af', bg: '#dbeafe' },
  stop:      { label: 'Stop',         color: '#92400e', bg: '#fef3c7' },
  relay:     { label: 'Relay Point',  color: '#6d28d9', bg: '#f5f3ff' },
};

const MARKER_COLORS: Record<StopType, string> = {
  pickup:    '#16a34a',
  delivery:  '#dc2626',
  drop:      '#0891b2',
  drop_hook: '#2563eb',
  stop:      '#d97706',
  relay:     '#7c3aed',
};

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export default function RouteMapPanel({ stops, onClose, motiveVehicleId, embedded = false, eventId }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const trafficRef   = useRef<google.maps.TrafficLayer | null>(null);
  const truckMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [trafficOn, setTrafficOn] = useState(false);
  const [truckLoc, setTruckLoc] = useState<TruckLocation | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const truckRef = useRef<TruckLocation | null>(null);
  const [etas, setEtas] = useState<Record<string, string | 'loading'>>({});
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const modalEventId = useCalendarStore(s => s.modalEventId);
  const trailEventId = eventId ?? (embedded ? undefined : modalEventId);
  // Each answer is tagged with the entry it's for, so switching loads
  // never shows the previous load's trail.
  const [trailResult, setTrailResult] = useState<{ id: string; data: LoadTrailResponse | null } | null>(null);
  const trail = trailEventId && trailResult?.id === trailEventId ? trailResult.data : null;
  const [showTrail, setShowTrail] = useState(true);
  const trailOverlays = useRef<Array<google.maps.Polyline | google.maps.marker.AdvancedMarkerElement>>([]);
  const trailFitted = useRef(false);
  // Route shows by default only when there's no linked GPS to show instead.
  const [routeChoice, setRouteChoice] = useState<boolean | null>(null);
  const showRoute = routeChoice ?? !(trail && trail.segments.length > 0);
  const showRouteRef = useRef(true);
  const routeLines = useRef<google.maps.Polyline[]>([]);
  const [bottomTab, setBottomTab] = useState<'stops' | 'gps'>('stops');
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  const drives = trail?.drives ?? [];
  const selectedIdx = drives.findIndex(d => d.movementId === selectedDrive);
  const selected = selectedIdx >= 0 ? drives[selectedIdx] : null;

  const geocodedStops = stops.filter(s => s.lat != null && s.lng != null);

  function fetchEta(stopId: string, stopLat: number, stopLng: number, stopTimezone?: string) {
    if (!truckLoc || !MAPBOX_TOKEN) return;
    setEtas(prev => ({ ...prev, [stopId]: 'loading' }));

    fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${truckLoc.lon},${truckLoc.lat};${stopLng},${stopLat}?access_token=${MAPBOX_TOKEN}&overview=false`)
      .then(r => r.json())
      .then((dir: { routes?: { duration: number }[] }) => {
        const secs = dir.routes?.[0]?.duration;
        if (secs == null) { setEtas(prev => ({ ...prev, [stopId]: 'N/A' })); return; }
        const hrs = Math.floor(secs / 3600);
        const mins = Math.round((secs % 3600) / 60);
        const duration = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
        const arrival = new Date(Date.now() + secs * 1000);
        const timeZone = stopTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const arrivalStr = arrival.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).toLowerCase();
        setEtas(prev => ({ ...prev, [stopId]: `${duration} · ${arrivalStr}` }));
      })
      .catch(() => setEtas(prev => ({ ...prev, [stopId]: 'Error' })));
  }

  // Fetch truck location from Motive if an ELD is linked
  useEffect(() => {
    if (!motiveVehicleId) return;
    fetch('/api/motive/locations')
      .then(r => r.json())
      .then((data: { locations?: { vehicleId: string; lat: number; lon: number; description: string; locatedAt: string }[] }) => {
        const match = data.locations?.find(l => l.vehicleId === motiveVehicleId) ?? null;
        truckRef.current = match;
        setTruckLoc(match);
      })
      .catch(() => {});
  }, [motiveVehicleId]);

  useEffect(() => {
    if (!mapContainer.current) return;

    let cancelled = false;
    let openInfoWindow: google.maps.InfoWindow | null = null;

    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;
      const map = new google.maps.Map(mapContainer.current, {
        center: { lat: 39.8283, lng: -98.5795 }, // center of US
        zoom: 4,
        mapId: MAP_ID,
        clickableIcons: false,
        gestureHandling: 'greedy',
      });
      mapRef.current = map;
      setMapReady(true);

      // Live traffic overlay (toggleable)
      trafficRef.current = new google.maps.TrafficLayer({ map: trafficOn ? map : null });

      const openPopup = (anchor: google.maps.marker.AdvancedMarkerElement, html: string) => {
        if (!openInfoWindow) openInfoWindow = new google.maps.InfoWindow();
        openInfoWindow.setContent(html);
        openInfoWindow.open({ anchor, map });
      };

      // Stop markers
      geocodedStops.forEach((stop, idx) => {
        const el = document.createElement('div');
        el.style.cssText = `width:28px;height:28px;border-radius:50%;background:${MARKER_COLORS[stop.type]};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700;cursor:pointer;`;
        el.textContent = String(idx + 1);

        const html = `
          <div style="font-size:12px;line-height:1.4;max-width:200px;padding:2px 4px">
            <div style="font-weight:700;color:${MARKER_COLORS[stop.type]}">${TYPE_CONFIG[stop.type].label}</div>
            ${stop.facilityName ? `<div style="font-weight:600">${stop.facilityName}</div>` : ''}
            ${stop.address     ? `<div style="color:#555">${stop.address}</div>` : ''}
            ${stop.apptStart   ? `<div style="color:#888;margin-top:2px">${fmtStopWindow(stop, calendarTimezone)}</div>` : ''}
          </div>`;
        const marker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: stop.lat!, lng: stop.lng! },
          content: el,
        });
        marker.addListener('click', () => openPopup(marker, html));
      });

      // Driver check-in markers
      stops.forEach((stop, idx) => {
        if (stop.arrivedLat == null || stop.arrivedLng == null || !stop.arrivedAt) return;
        const distMi =
          stop.lat != null && stop.lng != null
            ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat, stop.arrivedLng)
            : null;
        const onSite = distMi != null && distMi <= VERIFY_THRESHOLD_MI;
        const ringColor = onSite ? '#16a34a' : '#d97706';

        const el = document.createElement('div');
        el.style.cssText = `width:22px;height:22px;border-radius:50%;background:white;border:2.5px solid ${ringColor};box-shadow:0 1px 4px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;cursor:pointer;`;
        el.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${ringColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

        const distLabel =
          distMi == null
            ? ''
            : distMi < 0.1
              ? '<div style="color:#16a34a;font-weight:600;margin-top:2px">On-site</div>'
              : `<div style="color:${onSite ? '#16a34a' : '#d97706'};font-weight:600;margin-top:2px">${distMi.toFixed(1)} mi off</div>`;

        const html = `
          <div style="font-size:12px;line-height:1.4;max-width:200px;padding:2px 4px">
            <div style="font-weight:700;color:${ringColor}">Stop ${idx + 1} check-in</div>
            <div style="color:#555;margin-top:1px">${fmtCheckInTime(stop.arrivedAt!)}</div>
            ${distLabel}
          </div>`;

        const marker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: stop.arrivedLat!, lng: stop.arrivedLng! },
          content: el,
        });
        marker.addListener('click', () => openPopup(marker, html));
      });

      // Truck marker is now rendered in a separate effect keyed on
      // truckLoc — the Motive fetch resolves AFTER this init runs,
      // so doing it here meant we tried to draw a marker before the
      // location data existed, and the []-deps prevented a re-run.
      // See the truck-marker effect below.

      // Route line (kept so the Route toggle can hide it)
      const drawRoute = (path: { lat: number; lng: number }[]) => {
        routeLines.current = drawRouteLine(map, path);
        if (!showRouteRef.current) routeLines.current.forEach(l => l.setMap(null));
      };
      if (geocodedStops.length >= 2) {
        const coordPairs = geocodedStops.map(s => ({ lng: s.lng!, lat: s.lat! }));
        const coordStr = coordPairs.map(c => `${c.lng},${c.lat}`).join(';');

        if (MAPBOX_TOKEN) {
          fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordStr}?access_token=${MAPBOX_TOKEN}&geometries=geojson&overview=full`)
            .then(r => r.json())
            .then((data: { routes?: { geometry: GeoJSON.LineString }[] }) => {
              const path =
                data.routes?.[0]?.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })) ??
                coordPairs.map(c => ({ lat: c.lat, lng: c.lng }));
              drawRoute(path);
            })
            .catch(() => drawRoute(coordPairs.map(c => ({ lat: c.lat, lng: c.lng }))));
        } else {
          drawRoute(coordPairs.map(c => ({ lat: c.lat, lng: c.lng })));
        }

        // Fit bounds to stops
        const bounds = new google.maps.LatLngBounds();
        coordPairs.forEach(c => bounds.extend({ lat: c.lat, lng: c.lng }));
        map.fitBounds(bounds, 60);
      } else if (geocodedStops.length === 1) {
        map.setCenter({ lat: geocodedStops[0].lat!, lng: geocodedStops[0].lng! });
        map.setZoom(10);
      }
    });

    return () => { cancelled = true; mapRef.current = null; trafficRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GPS trail for the load: fetched once per entry, drawn on its own
  // layer so the toggle can clear it without touching the route.
  useEffect(() => {
    if (!trailEventId) return;
    let cancelled = false;
    railway.getLoadTrail(trailEventId)
      .then(res => { if (!cancelled) setTrailResult({ id: trailEventId, data: res }); })
      .catch(() => { if (!cancelled) setTrailResult({ id: trailEventId, data: null }); });
    return () => { cancelled = true; };
  }, [trailEventId]);

  useEffect(() => {
    if (!mapReady || !trail || !showTrail) return;
    let cancelled = false;
    void loadGoogleMaps().then(google => {
      const map = mapRef.current;
      if (cancelled || !map) return;
      const info = new google.maps.InfoWindow();
      const when = (iso: string) => new Date(iso).toLocaleString('en-US', {
        timeZone: calendarTimezone || undefined, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const bounds = new google.maps.LatLngBounds();

      for (const seg of trail.segments) {
        const st = TRAIL_STYLE[seg.role];
        const line = new google.maps.Polyline({
          map,
          path: seg.path,
          zIndex: 1,
          strokeColor: st.color,
          strokeOpacity: st.dashed ? 0 : 0.85,
          strokeWeight: 4,
          icons: st.dashed
            ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: st.color, scale: 3 }, offset: '0', repeat: '14px' }]
            : undefined,
        });
        line.addListener('click', (e: google.maps.MapMouseEvent) => {
          info.setContent(`
            <div style="font-size:12px;line-height:1.45;max-width:220px;padding:2px 4px">
              <div style="font-weight:700;color:${st.color}">${st.label}${seg.truck ? ` · ${seg.truck}` : ''}</div>
              <div style="color:#555">${when(seg.start)} → ${when(seg.end)}</div>
              <div style="color:#555">${Math.round(seg.miles)} mi driven</div>
              ${seg.roadSnapped ? '' : '<div style="color:#888">Drawn straight between GPS points</div>'}
            </div>`);
          if (e.latLng) info.setPosition(e.latLng);
          info.open({ map });
        });
        trailOverlays.current.push(line);
        seg.path.forEach(p => bounds.extend(p));
      }

      for (const p of trail.parked) {
        const el = document.createElement('div');
        el.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#374151;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.4);cursor:pointer;';
        const marker = new google.maps.marker.AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content: el, zIndex: 0 });
        marker.addListener('click', () => {
          info.setContent(`
            <div style="font-size:12px;line-height:1.45;max-width:220px;padding:2px 4px">
              <div style="font-weight:700;color:#374151">Parked ${p.hours} h${p.truck ? ` · ${p.truck}` : ''}</div>
              <div style="color:#555">${when(p.arrive)} → ${when(p.depart)}</div>
              ${p.place ? `<div style="color:#888">${p.place}</div>` : ''}
            </div>`);
          info.open({ anchor: marker, map });
        });
        trailOverlays.current.push(marker);
      }

      // First draw: widen the view to take in where the truck came from
      // and went after, along with the stops already in frame.
      if (!trailFitted.current && !bounds.isEmpty()) {
        const current = map.getBounds();
        if (current) bounds.union(current);
        map.fitBounds(bounds, 60);
        trailFitted.current = true;
      }
    });
    return () => {
      cancelled = true;
      for (const o of trailOverlays.current) {
        if ('setMap' in o) o.setMap(null);
        else o.map = null;
      }
      trailOverlays.current = [];
    };
  }, [mapReady, trail, showTrail, calendarTimezone]);

  // Route toggle. The ref covers a route that finishes drawing later.
  useEffect(() => {
    showRouteRef.current = showRoute;
    routeLines.current.forEach(l => l.setMap(showRoute ? mapRef.current : null));
  }, [showRoute]);

  // Start/end pins for the movement picked in the list.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !selected) return;
    const color = TRAIL_STYLE[selected.role].color;
    const pins: google.maps.marker.AdvancedMarkerElement[] = [];
    const pin = (p: { lat: number; lng: number }, filled: boolean, title: string) => {
      const el = document.createElement('div');
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${filled ? color : '#fff'};border:3px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,0.4);`;
      el.title = title;
      pins.push(new google.maps.marker.AdvancedMarkerElement({ map, position: p, content: el, zIndex: 5 }));
    };
    if (selected.from) pin(selected.from, false, 'Drive started');
    if (selected.to) pin(selected.to, true, 'Drive ended');
    return () => { pins.forEach(m => { m.map = null; }); };
  }, [mapReady, selected]);

  const selectDrive = (idx: number) => {
    const d = drives[idx];
    if (!d) return;
    setSelectedDrive(d.movementId);
    document.querySelector(`[data-drive="${d.movementId}"]`)?.scrollIntoView({ block: 'nearest' });
    const map = mapRef.current;
    const pts = [d.from, d.to].filter((p): p is { lat: number; lng: number } => !!p);
    if (!map || !pts.length) return;
    if (pts.length === 2 && distanceMiles(pts[0].lat, pts[0].lng, pts[1].lat, pts[1].lng) > 0.5) {
      const b = new google.maps.LatLngBounds();
      pts.forEach(p => b.extend(p));
      map.fitBounds(b, 80);
    } else {
      map.panTo(pts[0]);
      map.setZoom(14);
    }
  };

  // Sync the traffic layer's visibility with the toggle.
  useEffect(() => {
    if (trafficRef.current && mapRef.current) {
      trafficRef.current.setMap(trafficOn ? mapRef.current : null);
    }
  }, [trafficOn]);

  // Render/refresh the truck marker on the map. Separate from the
  // main map-init effect because that effect has []-deps and runs
  // before the Motive fetch resolves — without this, the side-panel
  // "Truck (ELD)" row would fly the camera to the right spot with
  // nothing drawn there.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    // Tear down any prior marker (truckLoc may have updated, or just cleared).
    if (truckMarkerRef.current) {
      truckMarkerRef.current.map = null;
      truckMarkerRef.current = null;
    }
    if (!truckLoc) return;

    let cancelled = false;
    void loadGoogleMaps().then(google => {
      if (cancelled || !mapRef.current) return;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;width:22px;height:22px;cursor:pointer;';
      const pulse = document.createElement('div');
      pulse.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:rgba(59,130,246,0.25);animation:truck-pulse 2s ease-out infinite;';
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#3b82f6;border:2.5px solid white;box-shadow:0 1px 6px rgba(59,130,246,0.6);';
      if (!document.getElementById('truck-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'truck-pulse-style';
        style.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
        document.head.appendChild(style);
      }
      wrapper.appendChild(pulse);
      wrapper.appendChild(dot);

      const age    = Math.round((Date.now() - new Date(truckLoc.locatedAt).getTime()) / 60000);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      const html = `
        <div style="font-size:12px;line-height:1.5;max-width:200px;padding:2px 4px">
          <div style="font-weight:700;color:#1d4ed8">Truck Location</div>
          <div style="color:#555">${truckLoc.description}</div>
          <div style="color:#888;margin-top:2px">Updated ${ageStr}</div>
        </div>`;
      const marker = new google.maps.marker.AdvancedMarkerElement({
        map: mapRef.current,
        position: { lat: truckLoc.lat, lng: truckLoc.lon },
        content: wrapper,
      });
      const popup = new google.maps.InfoWindow();
      marker.addListener('click', () => {
        popup.setContent(html);
        popup.open({ anchor: marker, map: mapRef.current! });
      });
      truckMarkerRef.current = marker;
    });
    return () => { cancelled = true; };
  }, [truckLoc, mapReady]);

  const flyTo = (lat: number, lng: number, zoom: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.panTo({ lat, lng });
    map.setZoom(zoom);
  };

  return (
    <div className={embedded ? 'flex flex-col h-full w-full' : 'flex flex-col shrink-0'}
      style={embedded
        ? { background: 'var(--gc-bg)' }
        : { width: '44%', borderRight: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
      {/* Panel header — close button only renders in modal mode; the
          embedded usage skips the X since the page owns its chrome. */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="flex items-center gap-2">
          <MapPin size={14} style={{ color: 'var(--gc-text-3)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>Route Map</span>
          <span className="text-xs px-2 py-0.5 rounded-lg" style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}>
            {geocodedStops.length} of {stops.length} geocoded
          </span>
        </div>
        {!embedded && onClose && (
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={15} />
          </button>
        )}
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
        <button
          type="button"
          onClick={() => setTrafficOn(t => !t)}
          style={{
            position: 'absolute', top: 56, right: 10, zIndex: 1,
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 10px', fontSize: 12, fontWeight: 600,
            borderRadius: 6, cursor: 'pointer',
            border: '1px solid rgba(0,0,0,0.15)',
            background: trafficOn ? '#1a73e8' : 'rgba(255,255,255,0.95)',
            color: trafficOn ? '#fff' : 'var(--gc-text-2)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
          }}
          title={trafficOn ? 'Hide traffic' : 'Show traffic'}
        >
          <Activity size={12} />
          Traffic
        </button>
        {geocodedStops.length >= 2 ? (
          <button
            type="button"
            onClick={() => setRouteChoice(!showRoute)}
            style={{
              position: 'absolute', top: 92, right: 10, zIndex: 1,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px', fontSize: 12, fontWeight: 600,
              borderRadius: 6, cursor: 'pointer',
              border: '1px solid rgba(0,0,0,0.15)',
              background: showRoute ? '#2563eb' : 'rgba(255,255,255,0.95)',
              color: showRoute ? '#fff' : 'var(--gc-text-2)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            }}
            title={showRoute ? 'Hide the planned route' : 'Show the planned route'}
          >
            <Navigation size={12} />
            Route
          </button>
        ) : null}
        {trail && trail.segments.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowTrail(t => !t)}
            style={{
              position: 'absolute', top: geocodedStops.length >= 2 ? 128 : 92, right: 10, zIndex: 1,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px', fontSize: 12, fontWeight: 600,
              borderRadius: 6, cursor: 'pointer',
              border: '1px solid rgba(0,0,0,0.15)',
              background: showTrail ? '#16a34a' : 'rgba(255,255,255,0.95)',
              color: showTrail ? '#fff' : 'var(--gc-text-2)',
              boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            }}
            title={showTrail ? 'Hide the GPS trail' : 'Show where the truck actually drove'}
          >
            <Route size={12} />
            GPS trail
          </button>
        ) : null}
      </div>

      {/* Stop legend */}
      <div style={{ borderTop: '1px solid var(--gc-border)', background: 'var(--gc-surface)', maxHeight: 240, overflowY: 'auto', padding: '10px 12px' }}>
        {trail ? (
          <div className="flex items-center gap-3 flex-wrap mb-2" style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
            {trail.segments.length === 0 ? (
              <span>No GPS linked to this load yet — the linker runs every 6 hours.</span>
            ) : (
              <>
                <span style={{ fontWeight: 700, color: 'var(--gc-text-2)' }}>GPS</span>
                {(Object.keys(TRAIL_STYLE) as LoadTrailRole[]).map(role => {
                  const miles = trail.segments.filter(s => s.role === role).reduce((n, s) => n + s.miles, 0);
                  if (!miles) return null;
                  const st = TRAIL_STYLE[role];
                  return (
                    <span key={role} className="flex items-center gap-1">
                      <span style={{ width: 14, height: 0, borderTop: `3px ${st.dashed ? 'dashed' : 'solid'} ${st.color}` }} />
                      {st.label} {Math.round(miles)} mi
                    </span>
                  );
                })}
                {trail.parked.length > 0 ? (
                  <span className="flex items-center gap-1">
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#374151' }} />
                    parked
                  </span>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {drives.length > 0 ? (
          <div className="flex items-center gap-1 mb-2">
            {(['stops', 'gps'] as const).map(t => (
              <button key={t} type="button" onClick={() => setBottomTab(t)}
                className="px-2 py-0.5 rounded text-[11px] font-semibold"
                style={{
                  background: bottomTab === t ? 'var(--gc-text-1)' : 'var(--gc-surface-2)',
                  color: bottomTab === t ? 'var(--gc-surface)' : 'var(--gc-text-2)',
                }}>
                {t === 'stops' ? `Stops (${stops.length})` : `GPS movements (${drives.length})`}
              </button>
            ))}
            {bottomTab === 'gps' ? (
              <div className="ml-auto flex items-center gap-1" style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                <button type="button" disabled={selectedIdx <= 0} onClick={() => selectDrive(selectedIdx - 1)}
                  className="p-0.5 rounded disabled:opacity-30" title="Previous movement">
                  <ChevronLeft size={14} />
                </button>
                <span className="tabular-nums">{selectedIdx >= 0 ? selectedIdx + 1 : '–'} / {drives.length}</span>
                <button type="button" disabled={selectedIdx >= drives.length - 1} onClick={() => selectDrive(selectedIdx + 1)}
                  className="p-0.5 rounded disabled:opacity-30" title="Next movement">
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {bottomTab === 'gps' && drives.length > 0 ? (
          <TrailDriveList drives={drives} selectedId={selected?.movementId ?? null} onSelect={selectDrive} tz={calendarTimezone || undefined} />
        ) : (
        <div className="space-y-1.5">
          {stops.map((stop, idx) => {
            const cfg = TYPE_CONFIG[stop.type] ?? TYPE_CONFIG.stop;
            const hasCoords = stop.lat != null && stop.lng != null;
            return (
              <div
                key={stop.id}
                className="flex items-start gap-2.5"
                onClick={() => { if (hasCoords) flyTo(stop.lat!, stop.lng!, 13); }}
                style={{ cursor: hasCoords ? 'pointer' : 'default', borderRadius: 6, padding: '2px 4px', margin: '0 -4px', transition: 'background 120ms' }}
                onMouseEnter={e => { if (hasCoords) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                  background: hasCoords ? MARKER_COLORS[stop.type] : '#9ca3af',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: 'white', fontSize: 10, fontWeight: 700,
                }}>
                  {idx + 1}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span style={{ fontSize: 10, fontWeight: 700, color: cfg.color, background: cfg.bg, padding: '1px 5px', borderRadius: 4 }}>
                      {cfg.label}
                    </span>
                    {stop.facilityName && (
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-1)' }}>{stop.facilityName}</span>
                    )}
                    {!hasCoords && (
                      <span style={{ fontSize: 10, color: '#9ca3af' }}>no coordinates</span>
                    )}
                  </div>
                  {stop.address && (
                    <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>{stop.address}</div>
                  )}
                  {stop.apptStart && (
                    <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                      <Clock size={10} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />{fmtStopWindow(stop, calendarTimezone)}
                    </div>
                  )}
                  {stop.arrivedAt && stop.arrivedLat != null && stop.arrivedLng != null && (() => {
                    const distMi = stop.lat != null && stop.lng != null
                      ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat!, stop.arrivedLng!)
                      : null;
                    const onSite = distMi != null && distMi <= VERIFY_THRESHOLD_MI;
                    const tint = onSite ? '#16a34a' : '#d97706';
                    const distLabel = distMi == null
                      ? ''
                      : distMi < 0.1
                        ? ' · on-site'
                        : ` · ${distMi.toFixed(1)} mi off`;
                    return (
                      <div
                        onClick={e => { e.stopPropagation(); flyTo(stop.arrivedLat!, stop.arrivedLng!, 14); }}
                        style={{ fontSize: 11, fontWeight: 600, color: tint, marginTop: 1, cursor: 'pointer' }}
                      >
                        <CheckCircle2 size={10} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
                        Checked in {fmtCheckInTime(stop.arrivedAt)}{distLabel}
                      </div>
                    );
                  })()}
                  {truckLoc && hasCoords && (
                    etas[stop.id] && etas[stop.id] !== 'loading' ? (
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#3b82f6', marginTop: 1 }}>
                        ETA: {etas[stop.id]}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); fetchEta(stop.id, stop.lat!, stop.lng!, stop.timezone); }}
                        style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: '#3b82f6', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '1px 6px', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#dbeafe')}
                        onMouseLeave={e => (e.currentTarget.style.background = '#eff6ff')}
                      >
                        {etas[stop.id] === 'loading' ? 'Calculating…' : 'ETA from truck'}
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}

          {/* Truck location row */}
          {truckLoc && (
            <div
              className="flex items-start gap-2.5"
              onClick={() => flyTo(truckLoc.lat, truckLoc.lon, 13)}
              style={{ cursor: 'pointer', borderRadius: 6, padding: '2px 4px', margin: '0 -4px', transition: 'background 120ms' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                background: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Truck size={11} color="white" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-1)' }}>Truck (ELD)</div>
                <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{truckLoc.description}</div>
                <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                  <Clock size={10} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />
                  {(() => {
                    const age = Math.round((Date.now() - new Date(truckLoc.locatedAt).getTime()) / 60000);
                    return age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function fmtSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Each linked Motive drive in order, with the time parked between them. */
function TrailDriveList({ drives, selectedId, onSelect, tz }: {
  drives: LoadTrailDrive[]; selectedId: string | null; onSelect: (idx: number) => void; tz: string | undefined;
}) {
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
  const at = (iso: string, withDate: boolean) => new Date(iso).toLocaleString('en-US', {
    timeZone: tz, ...(withDate ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit',
  });
  return (
    <div className="space-y-0.5">
      {drives.map((d, idx) => {
        const st = TRAIL_STYLE[d.role];
        const prev = drives[idx - 1];
        const parkedMs = prev?.end && prev.truck === d.truck ? Date.parse(d.start) - Date.parse(prev.end) : 0;
        const from = extractCity(d.origin) ?? '—';
        const to = extractCity(d.destination) ?? '—';
        const on = d.movementId === selectedId;
        return (
          <div key={d.movementId}>
            {parkedMs >= 15 * 60000 ? (
              <div className="flex items-center gap-1.5 pl-3 py-0.5" style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#374151' }} />
                Parked {fmtSpan(parkedMs)}{prev.destination ? ` · ${extractCity(prev.destination)}` : ''}
              </div>
            ) : null}
            <div
              data-drive={d.movementId}
              onClick={() => onSelect(idx)}
              className="flex items-start gap-2 cursor-pointer"
              style={{ borderRadius: 6, padding: '3px 6px', margin: '0 -6px', background: on ? 'var(--gc-hover)' : 'transparent' }}
            >
              <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: st.color, flexShrink: 0 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="flex items-center gap-1.5" style={{ fontSize: 12 }}>
                  <span style={{ fontWeight: 700, color: st.color }}>{st.label.replace(' (GPS)', '')}</span>
                  {d.truck ? <span style={{ color: 'var(--gc-text-3)' }}>· {d.truck}</span> : null}
                  <span className="ml-auto tabular-nums" style={{ color: 'var(--gc-text-2)', fontWeight: 600 }}>
                    {d.miles != null ? `${Math.round(d.miles)} mi` : '—'}
                  </span>
                </div>
                <div className="tabular-nums" style={{ fontSize: 11, color: 'var(--gc-text-2)' }}>
                  {at(d.start, true)} → {d.end ? at(d.end, day(d.end) !== day(d.start)) : '…'}
                  {d.end ? ` · ${fmtSpan(Date.parse(d.end) - Date.parse(d.start))}` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{from} → {to}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function drawRouteLine(map: google.maps.Map, path: { lat: number; lng: number }[]): google.maps.Polyline[] {
  // White outline beneath blue line for contrast over varied tiles.
  return [
    new google.maps.Polyline({
      map,
      path,
      strokeColor: '#ffffff',
      strokeOpacity: 0.85,
      strokeWeight: 6,
    }),
    new google.maps.Polyline({
      map,
      path,
      strokeColor: '#2563eb',
      strokeOpacity: 1,
      strokeWeight: 3.5,
    }),
  ];
}
