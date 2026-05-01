'use client';

import { useEffect, useRef, useState } from 'react';
import { X, MapPin, Clock, Truck, CheckCircle2 } from 'lucide-react';
import type { Stop, StopType } from '@/lib/types';
import { fmtAppt } from './StopsSection';

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
  onClose: () => void;
  motiveVehicleId?: string;
}

interface TruckLocation {
  lat: number;
  lon: number;
  description: string;
  locatedAt: string;
}


const TYPE_CONFIG: Record<StopType, { label: string; color: string; bg: string }> = {
  pickup:    { label: 'Pickup',      color: '#166534', bg: '#dcfce7' },
  delivery:  { label: 'Delivery',    color: '#991b1b', bg: '#fee2e2' },
  stop:      { label: 'Stop',        color: '#92400e', bg: '#fef3c7' },
  drop_hook: { label: 'Drop & Hook', color: '#1e40af', bg: '#dbeafe' },
  relay:     { label: 'Relay Point', color: '#6d28d9', bg: '#f5f3ff' },
};

// Colors for map markers (same palette as above but as hex for mapbox)
const MARKER_COLORS: Record<StopType, string> = {
  pickup:    '#16a34a',
  delivery:  '#dc2626',
  stop:      '#d97706',
  drop_hook: '#2563eb',
  relay:     '#7c3aed',
};

export default function RouteMapPanel({ stops, onClose, motiveVehicleId }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef       = useRef<any>(null);
  const token        = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const [truckLoc, setTruckLoc] = useState<TruckLocation | null>(null);
  const truckRef = useRef<TruckLocation | null>(null);
  const [etas, setEtas] = useState<Record<string, string | 'loading'>>({});

  const geocodedStops = stops.filter(s => s.lat != null && s.lng != null);

  function fetchEta(stopId: string, stopLat: number, stopLng: number, stopTimezone?: string) {
    if (!truckLoc || !token) return;
    setEtas(prev => ({ ...prev, [stopId]: 'loading' }));

    fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${truckLoc.lon},${truckLoc.lat};${stopLng},${stopLat}?access_token=${token}&overview=false`)
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
    if (!mapContainer.current || !token) return;

    let map: mapboxgl.Map;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
    if (mapContainer.current) ro.observe(mapContainer.current);

    import('mapbox-gl').then(({ default: mapboxgl }) => {
      import('mapbox-gl/dist/mapbox-gl.css').catch(() => {/* CSS may already be loaded */});

      mapboxgl.accessToken = token;

      map = new mapboxgl.Map({
        container: mapContainer.current!,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [-98.5795, 39.8283], // center of US
        zoom: 3.5,
      });
      mapRef.current = map;

      map.addControl(new mapboxgl.NavigationControl(), 'top-right');

      // Force correct size once the flex container has settled
      map.on('load', () => { map.resize(); });

      map.on('load', () => {
        // Add markers for each geocoded stop
        geocodedStops.forEach((stop, idx) => {
          const el = document.createElement('div');
          el.style.cssText = `
            width: 28px; height: 28px; border-radius: 50%;
            background: ${MARKER_COLORS[stop.type]};
            border: 2.5px solid white;
            box-shadow: 0 2px 6px rgba(0,0,0,0.35);
            display: flex; align-items: center; justify-content: center;
            color: white; font-size: 11px; font-weight: 700;
            cursor: default;
          `;
          el.textContent = String(idx + 1);

          const popup = new mapboxgl.Popup({ offset: 18, closeButton: false })
            .setHTML(`
              <div style="font-size:12px;line-height:1.4;max-width:200px">
                <div style="font-weight:700;color:${MARKER_COLORS[stop.type]}">${TYPE_CONFIG[stop.type].label}</div>
                ${stop.facilityName ? `<div style="font-weight:600">${stop.facilityName}</div>` : ''}
                ${stop.address     ? `<div style="color:#555">${stop.address}</div>` : ''}
                ${stop.apptStart   ? `<div style="color:#888;margin-top:2px">${fmtAppt(stop.apptStart)}${stop.apptEnd ? ` – ${fmtAppt(stop.apptEnd)}` : ''}</div>` : ''}
              </div>
            `);

          new mapboxgl.Marker({ element: el })
            .setLngLat([stop.lng!, stop.lat!])
            .setPopup(popup)
            .addTo(map);
        });

        // Add driver check-in markers for any stop with a recorded arrival
        stops.forEach((stop, idx) => {
          if (stop.arrivedLat == null || stop.arrivedLng == null || !stop.arrivedAt) return;
          const distMi =
            stop.lat != null && stop.lng != null
              ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat, stop.arrivedLng)
              : null;
          const onSite = distMi != null && distMi <= VERIFY_THRESHOLD_MI;
          const ringColor = onSite ? '#16a34a' : '#d97706';

          const el = document.createElement('div');
          el.style.cssText = `
            width: 22px; height: 22px; border-radius: 50%;
            background: white;
            border: 2.5px solid ${ringColor};
            box-shadow: 0 1px 4px rgba(0,0,0,0.25);
            display: flex; align-items: center; justify-content: center;
            cursor: default;
          `;
          el.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="${ringColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

          const distLabel =
            distMi == null
              ? ''
              : distMi < 0.1
                ? '<div style="color:#16a34a;font-weight:600;margin-top:2px">On-site</div>'
                : `<div style="color:${onSite ? '#16a34a' : '#d97706'};font-weight:600;margin-top:2px">${distMi.toFixed(1)} mi off</div>`;

          const popup = new mapboxgl.Popup({ offset: 14, closeButton: false })
            .setHTML(`
              <div style="font-size:12px;line-height:1.4;max-width:200px">
                <div style="font-weight:700;color:${ringColor}">Stop ${idx + 1} check-in</div>
                <div style="color:#555;margin-top:1px">${fmtCheckInTime(stop.arrivedAt!)}</div>
                ${distLabel}
              </div>
            `);

          new mapboxgl.Marker({ element: el })
            .setLngLat([stop.arrivedLng!, stop.arrivedLat!])
            .setPopup(popup)
            .addTo(map);
        });

        // Add truck location marker if ELD data is available
        const truck = truckRef.current;
        if (truck) {
          // Pulsing blue dot (Apple Maps style)
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'position:relative;width:22px;height:22px;';

          const pulse = document.createElement('div');
          pulse.style.cssText = `
            position:absolute;inset:0;border-radius:50%;
            background:rgba(59,130,246,0.25);
            animation:truck-pulse 2s ease-out infinite;
          `;

          const dot = document.createElement('div');
          dot.style.cssText = `
            position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
            width:14px;height:14px;border-radius:50%;
            background:#3b82f6;border:2.5px solid white;
            box-shadow:0 1px 6px rgba(59,130,246,0.6);
          `;

          // Inject keyframes once
          if (!document.getElementById('truck-pulse-style')) {
            const style = document.createElement('style');
            style.id = 'truck-pulse-style';
            style.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
            document.head.appendChild(style);
          }

          wrapper.appendChild(pulse);
          wrapper.appendChild(dot);

          const age    = Math.round((Date.now() - new Date(truck.locatedAt).getTime()) / 60000);
          const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
          const truckPopup = new mapboxgl.Popup({ offset: 14, closeButton: false })
            .setHTML(`
              <div style="font-size:12px;line-height:1.5;max-width:200px">
                <div style="font-weight:700;color:#1d4ed8">Truck Location</div>
                <div style="color:#555">${truck.description}</div>
                <div style="color:#888;margin-top:2px">Updated ${ageStr}</div>
              </div>
            `);

          new mapboxgl.Marker({ element: wrapper })
            .setLngLat([truck.lon, truck.lat])
            .setPopup(truckPopup)
            .addTo(map);
        }

        // Draw route line between stops
        if (geocodedStops.length >= 2) {
          const coords = geocodedStops.map(s => [s.lng!, s.lat!]);

          // Try to get actual road route from Mapbox Directions
          const coordStr = coords.map(([lng, lat]) => `${lng},${lat}`).join(';');
          fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordStr}?access_token=${token}&geometries=geojson&overview=full`)
            .then(r => r.json())
            .then((data: { routes?: { geometry: GeoJSON.LineString }[] }) => {
              const geometry = data.routes?.[0]?.geometry ?? {
                type: 'LineString' as const,
                coordinates: coords,
              };
              addRouteLine(map, geometry);
            })
            .catch(() => {
              // Fallback: straight lines between stops
              addRouteLine(map, { type: 'LineString', coordinates: coords });
            });

          // Fit map to stops
          const bounds = coords.reduce(
            (b, [lng, lat]) => b.extend([lng, lat] as mapboxgl.LngLatLike),
            new mapboxgl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]])
          );
          map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 800 });
        } else if (geocodedStops.length === 1) {
          map.setCenter([geocodedStops[0].lng!, geocodedStops[0].lat!]);
          map.setZoom(10);
        }
      });
    });

    return () => { ro.disconnect(); map?.remove(); mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col shrink-0" style={{ width: '44%', borderRight: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="flex items-center gap-2">
          <MapPin size={14} style={{ color: 'var(--gc-text-3)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>Route Map</span>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}>
            {geocodedStops.length} of {stops.length} geocoded
          </span>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <X size={15} />
        </button>
      </div>

      {/* Map */}
      <div ref={mapContainer} style={{ flex: 1 }} />

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
                onClick={() => {
                  if (!hasCoords || !mapRef.current) return;
                  mapRef.current.flyTo({ center: [stop.lng!, stop.lat!], zoom: 13, duration: 800 });
                }}
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
                      <Clock size={10} style={{ display: 'inline', marginRight: 3, verticalAlign: 'middle' }} />{fmtAppt(stop.apptStart)}{stop.apptEnd ? ` – ${fmtAppt(stop.apptEnd)}` : ''}
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
                        onClick={e => {
                          e.stopPropagation();
                          if (mapRef.current) {
                            mapRef.current.flyTo({ center: [stop.arrivedLng!, stop.arrivedLat!], zoom: 14, duration: 800 });
                          }
                        }}
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
              onClick={() => { mapRef.current?.flyTo({ center: [truckLoc.lon, truckLoc.lat], zoom: 13, duration: 800 }); }}
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addRouteLine(map: any, geometry: object) {
  // The directions fetch is async — bail if the map was disposed in the meantime.
  if (!map || typeof map.getStyle !== 'function' || !map.getStyle()) return;
  try {
    if (map.getSource('route')) {
      map.getSource('route').setData({ type: 'Feature', properties: {}, geometry });
      return;
    }
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry } });
    map.addLayer({ id: 'route-outline', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.8 },
    }, 'road-label');
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#2563eb', 'line-width': 3.5 },
    }, 'road-label');
  } catch {
    // map was disposed mid-call — nothing to draw on
  }
}
