'use client';

import { useEffect, useRef, useState } from 'react';
import { X, MapPin, Clock, Truck, User, ExternalLink, Star, Navigation } from 'lucide-react';
import type { CalendarEvent, Asset, EventStatus } from '@/lib/types';
import type { EldLocation } from '@/store/useCalendarStore';
import { fmtAppt } from '@/components/calendar/StopsSection';
import { calcDirections } from '@/lib/directions';
import CopyChip from '@/components/ui/CopyChip';

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtEta(seconds: number, timezone?: string): string {
  const arrival = new Date(Date.now() + seconds * 1000);
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return arrival.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
}

type StopDistance = { miles: number; durationSeconds: number };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours(), m = d.getMinutes();
  const hh = h % 12 || 12, ap = h >= 12 ? 'PM' : 'AM';
  return m === 0 ? `${hh} ${ap}` : `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

const STOP_COLORS: Record<string, string> = {
  pickup:    '#16a34a',
  delivery:  '#dc2626',
  stop:      '#d97706',
  drop_hook: '#2563eb',
  relay:     '#7c3aed',
};

const STOP_LABELS: Record<string, string> = {
  pickup: 'Pickup', delivery: 'Delivery', stop: 'Stop', drop_hook: 'Drop & Hook', relay: 'Relay',
};

const STATUS_CHIPS: { key: EventStatus; label: string }[] = [
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'picked_up',  label: 'Picked Up'  },
  { key: 'delivered',  label: 'Delivered'  },
  { key: 'tonu',       label: 'TONU'       },
  { key: 'cancelled',  label: 'Cancelled'  },
  { key: 'problem',    label: 'Problem'    },
];

// ── Component ──────────────────────────────────────────────────────────────────

interface Props {
  ev: CalendarEvent;
  asset: Asset | undefined;
  truckLoc: EldLocation | null;
  onClose: () => void;
  onOpenLoad: (id: string) => void;
  onStatusChange: (id: string, status: EventStatus | undefined) => void;
  onPriorityToggle: (id: string, priority: boolean) => void;
}

export default function MapDrawer({ ev, asset, truckLoc, onClose, onOpenLoad, onStatusChange, onPriorityToggle }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
  const geocodedStops = (ev.stops ?? []).filter(s => s.lat != null && s.lng != null);
  const assetColor = asset?.color ?? '#64748b';

  // Per-stop ETAs from truck — fetched on demand (click)
  const [stopDistances, setStopDistances] = useState<Map<string, StopDistance | 'loading'>>(new Map());

  const fetchStopEta = (stopId: string, stopLat: number, stopLng: number, stopTz?: string) => {
    if (!truckLoc || stopDistances.has(stopId)) return;
    setStopDistances(prev => new Map(prev).set(stopId, 'loading'));
    calcDirections([
      { lat: truckLoc.lat, lng: truckLoc.lon },
      { lat: stopLat,      lng: stopLng      },
    ]).then(dir => {
      setStopDistances(prev => {
        const next = new Map(prev);
        if (dir) next.set(stopId, dir); else next.delete(stopId);
        return next;
      });
    });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    if (!mapContainer.current || !token) return;
    let map: mapboxgl.Map;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(mapContainer.current);

    import('mapbox-gl').then(({ default: mapboxgl }) => {
      mapboxgl.accessToken = token;
      map = new mapboxgl.Map({
        container: mapContainer.current!,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [-98.5795, 39.8283],
        zoom: 3.5,
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');

      map.on('load', () => {
        map.resize();

        // Stop markers
        geocodedStops.forEach((stop, idx) => {
          const el = document.createElement('div');
          el.style.cssText = `width:26px;height:26px;border-radius:50%;background:${STOP_COLORS[stop.type] ?? '#64748b'};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700;cursor:default;`;
          el.textContent = String(idx + 1);
          const popup = new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(`
            <div style="font-size:12px;line-height:1.4;max-width:190px">
              <div style="font-weight:700;color:${STOP_COLORS[stop.type] ?? '#64748b'}">${STOP_LABELS[stop.type] ?? 'Stop'}</div>
              ${stop.facilityName ? `<div style="font-weight:600">${stop.facilityName}</div>` : ''}
              ${stop.address     ? `<div style="color:#555">${stop.address}</div>` : ''}
              ${stop.apptStart   ? `<div style="color:#888;margin-top:2px">${fmtAppt(stop.apptStart)}${stop.apptEnd ? ` – ${fmtAppt(stop.apptEnd)}` : ''}</div>` : ''}
            </div>`);
          new mapboxgl.Marker({ element: el }).setLngLat([stop.lng!, stop.lat!]).setPopup(popup).addTo(map);
        });

        // Truck marker
        if (truckLoc) {
          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'position:relative;width:22px;height:22px;';
          const pulse = document.createElement('div');
          pulse.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:rgba(59,130,246,0.25);animation:truck-pulse 2s ease-out infinite;';
          const dot = document.createElement('div');
          dot.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#3b82f6;border:2.5px solid white;box-shadow:0 1px 6px rgba(59,130,246,0.6);';
          if (!document.getElementById('truck-pulse-style')) {
            const s = document.createElement('style'); s.id = 'truck-pulse-style';
            s.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
            document.head.appendChild(s);
          }
          wrapper.appendChild(pulse); wrapper.appendChild(dot);
          const popup = new mapboxgl.Popup({ offset: 14, closeButton: false }).setHTML(`
            <div style="font-size:12px;line-height:1.5;max-width:190px">
              <div style="font-weight:700;color:#1d4ed8">Current Location</div>
              <div style="color:#555">${truckLoc.description}</div>
              <div style="color:#888;margin-top:2px">Last seen ${timeAgo(truckLoc.locatedAt)}</div>
            </div>`);
          new mapboxgl.Marker({ element: wrapper }).setLngLat([truckLoc.lon, truckLoc.lat]).setPopup(popup).addTo(map);
        }

        // Route line from truck → stops
        const allPoints = [
          ...(truckLoc ? [{ lng: truckLoc.lon, lat: truckLoc.lat }] : []),
          ...geocodedStops.map(s => ({ lng: s.lng!, lat: s.lat! })),
        ];
        if (allPoints.length >= 2) {
          const coordStr = allPoints.map(p => `${p.lng},${p.lat}`).join(';');
          fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${coordStr}?access_token=${token}&geometries=geojson&overview=full`)
            .then(r => r.json())
            .then((data: { routes?: { geometry: GeoJSON.LineString }[] }) => {
              const geom = data.routes?.[0]?.geometry ?? { type: 'LineString' as const, coordinates: allPoints.map(p => [p.lng, p.lat]) };
              addLine(map, geom);
            })
            .catch(() => addLine(map, { type: 'LineString', coordinates: allPoints.map(p => [p.lng, p.lat]) }));

          const bounds = allPoints.reduce(
            (b, p) => b.extend([p.lng, p.lat] as mapboxgl.LngLatLike),
            new mapboxgl.LngLatBounds([allPoints[0].lng, allPoints[0].lat], [allPoints[0].lng, allPoints[0].lat])
          );
          map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: 600 });
        } else if (allPoints.length === 1) {
          map.setCenter([allPoints[0].lng, allPoints[0].lat]); map.setZoom(10);
        }
      });
    });

    return () => { ro.disconnect(); map?.remove(); mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>

      <div style={{
        width: '100%', maxWidth: 1100, height: '88vh',
        display: 'flex', borderRadius: 14,
        overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.28)',
        background: 'var(--gc-surface)',
      }}>

        {/* ── Left: Map ── */}
        <div ref={mapContainer} style={{ flex: 1, minWidth: 0 }} />

        {/* ── Right: Info panel ── */}
        <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--gc-border)' }}>

          {/* Header */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--gc-border)', background: assetColor, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <Truck size={13} style={{ color: 'rgba(255,255,255,0.85)', flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {asset?.name ?? '—'}{asset?.unit ? ` #${asset.unit}` : ''}
              </span>
              <button type="button"
                onClick={() => onPriorityToggle(ev.id, !ev.priority)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <Star size={14} fill={ev.priority ? '#fbbf24' : 'none'} style={{ color: ev.priority ? '#fbbf24' : 'rgba(255,255,255,0.5)' }} />
              </button>
              <button type="button" onClick={onClose}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                <X size={13} style={{ color: '#fff' }} />
              </button>
            </div>

            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.title}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: truckLoc ? 6 : 0 }}>
              {ev.loadNum && <CopyChip value={ev.loadNum} style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }} />}
              {ev.loadNum && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>·</span>}
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>{fmtTime(ev.start)} – {fmtTime(ev.end)}</span>
              {ev.driverName && (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>·</span>
                  <User size={11} style={{ color: 'rgba(255,255,255,0.65)' }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>{ev.driverName}</span>
                </>
              )}
            </div>

            {truckLoc && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <MapPin size={11} style={{ color: 'rgba(255,255,255,0.65)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {truckLoc.description}
                </span>
                <Clock size={10} style={{ color: 'rgba(255,255,255,0.5)', flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
                  {timeAgo(truckLoc.locatedAt)}
                </span>
              </div>
            )}
          </div>

          {/* Status chips */}
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--gc-border)', flexShrink: 0 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gc-text-3)', marginBottom: 8 }}>Status</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {STATUS_CHIPS.map(({ key, label }) => {
                const active = ev.status === key;
                return (
                  <button key={key} type="button"
                    onClick={() => onStatusChange(ev.id, ev.status === key ? undefined : key)}
                    style={{
                      fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                      background: active ? assetColor : 'var(--gc-bg)',
                      color: active ? '#fff' : 'var(--gc-text-2)',
                      border: active ? `1px solid ${assetColor}` : '1px solid var(--gc-border)',
                      transition: 'all 120ms',
                    }}>
                    {label}
                  </button>
                );
              })}
              {ev.status && ev.status !== 'scheduled' && (
                <button type="button" onClick={() => onStatusChange(ev.id, undefined)}
                  style={{ fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 20, cursor: 'pointer', background: 'transparent', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border)' }}>
                  ✕ Clear
                </button>
              )}
            </div>
          </div>

          {/* Stop list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--gc-text-3)', marginBottom: 10 }}>
              Stops
            </div>
            {(ev.stops ?? []).length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>No stops added</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(ev.stops ?? []).map((stop, idx) => {
                  const hasCoords = stop.lat != null && stop.lng != null;
                  const color = STOP_COLORS[stop.type] ?? '#64748b';
                  return (
                    <div key={stop.id}
                      onClick={() => { if (hasCoords && mapRef.current) mapRef.current.flyTo({ center: [stop.lng!, stop.lat!], zoom: 13, duration: 600 }); }}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: hasCoords ? 'pointer' : 'default', borderRadius: 8, padding: '6px 8px', margin: '0 -8px', transition: 'background 120ms' }}
                      onMouseEnter={e => { if (hasCoords) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1, background: hasCoords ? color : '#9ca3af', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 10, fontWeight: 700 }}>
                        {idx + 1}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, padding: '1px 6px', borderRadius: 4 }}>
                            {STOP_LABELS[stop.type] ?? 'Stop'}
                          </span>
                          {!hasCoords && <span style={{ fontSize: 10, color: '#9ca3af' }}>no coordinates</span>}
                        </div>
                        {stop.facilityName && <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gc-text-1)' }}>{stop.facilityName}</div>}
                        {stop.address && <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>{stop.address}</div>}
                        {stop.apptStart && (
                          <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Clock size={10} />
                            {fmtAppt(stop.apptStart)}{stop.apptEnd ? ` – ${fmtAppt(stop.apptEnd)}` : ''}
                          </div>
                        )}
                        {hasCoords && truckLoc && (() => {
                          const d = stopDistances.get(stop.id);
                          if (d === 'loading') return (
                            <div style={{ fontSize: 10, color: 'var(--gc-text-3)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                              <Navigation size={9} style={{ opacity: 0.5 }} />
                              <span style={{ opacity: 0.5 }}>Calculating…</span>
                            </div>
                          );
                          if (d) return (
                            <div style={{ fontSize: 11, color: '#1d4ed8', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                              <Navigation size={10} style={{ flexShrink: 0 }} />
                              {d.miles} mi · {fmtDuration(d.durationSeconds)} · ETA {fmtEta(d.durationSeconds, stop.timezone)}
                            </div>
                          );
                          return (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); fetchStopEta(stop.id, stop.lat!, stop.lng!, stop.timezone); }}
                              style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: 'rgba(29,78,216,0.08)', border: '1px solid rgba(29,78,216,0.2)', borderRadius: 5, padding: '2px 7px', cursor: 'pointer' }}>
                              <Navigation size={9} />
                              ETA from truck
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer: Edit Load */}
          <div style={{ padding: '12px 14px', borderTop: '1px solid var(--gc-border)', flexShrink: 0 }}>
            <button type="button"
              onClick={() => { onClose(); onOpenLoad(ev.id); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                fontSize: 13, fontWeight: 700, padding: '9px 0', borderRadius: 10, cursor: 'pointer',
                background: assetColor, color: '#fff', border: 'none',
              }}
              onMouseEnter={e => { e.currentTarget.style.filter = 'brightness(0.9)'; }}
              onMouseLeave={e => { e.currentTarget.style.filter = 'none'; }}>
              <ExternalLink size={14} />
              Edit Load
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addLine(map: any, geometry: object) {
  // The directions fetch is async — by the time it resolves the map may have
  // been removed (drawer closed, HMR remount). Bail if the style isn't there.
  if (!map || typeof map.getStyle !== 'function' || !map.getStyle()) return;
  try {
    if (map.getSource('route')) { map.getSource('route').setData({ type: 'Feature', properties: {}, geometry }); return; }
    map.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry } });
    map.addLayer({ id: 'route-outline', type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.7 } }, 'road-label');
    map.addLayer({ id: 'route-line',    type: 'line', source: 'route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 3.5 } }, 'road-label');
  } catch {
    // map was disposed mid-call — nothing to draw on
  }
}
