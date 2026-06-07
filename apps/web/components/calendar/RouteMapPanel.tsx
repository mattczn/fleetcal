'use client';

import { useEffect, useRef, useState } from 'react';
import { X, MapPin, Clock, Truck, CheckCircle2, Activity } from 'lucide-react';
import type { Stop, StopType } from '@/lib/types';
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
}

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

export default function RouteMapPanel({ stops, onClose, motiveVehicleId, embedded = false }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const trafficRef   = useRef<google.maps.TrafficLayer | null>(null);
  const truckMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [trafficOn, setTrafficOn] = useState(true);
  const [truckLoc, setTruckLoc] = useState<TruckLocation | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const truckRef = useRef<TruckLocation | null>(null);
  const [etas, setEtas] = useState<Record<string, string | 'loading'>>({});
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);

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

      // Route line
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
              drawRouteLine(map, path);
            })
            .catch(() => drawRouteLine(map, coordPairs.map(c => ({ lat: c.lat, lng: c.lng }))));
        } else {
          drawRouteLine(map, coordPairs.map(c => ({ lat: c.lat, lng: c.lng })));
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
      </div>

      {/* Stop legend */}
      <div style={{ borderTop: '1px solid var(--gc-border)', background: 'var(--gc-surface)', maxHeight: 180, overflowY: 'auto', padding: '10px 12px' }}>
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
      </div>
    </div>
  );
}

function drawRouteLine(map: google.maps.Map, path: { lat: number; lng: number }[]) {
  // White outline beneath blue line for contrast over varied tiles.
  new google.maps.Polyline({
    map,
    path,
    strokeColor: '#ffffff',
    strokeOpacity: 0.85,
    strokeWeight: 6,
  });
  new google.maps.Polyline({
    map,
    path,
    strokeColor: '#2563eb',
    strokeOpacity: 1,
    strokeWeight: 3.5,
  });
}
