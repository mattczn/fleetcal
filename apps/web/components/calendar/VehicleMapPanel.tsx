'use client';

import { useEffect, useRef } from 'react';
import { X, MapPin, ExternalLink } from 'lucide-react';
import type { MotiveLocation } from '@/app/api/motive/locations/route';

interface Props {
  asset: { name: string; color: string; unit?: string };
  location: MotiveLocation;
  onClose: () => void;
}

function staleness(locatedAt: string): 'fresh' | 'stale' | 'old' {
  const ageMs = Date.now() - new Date(locatedAt).getTime();
  if (ageMs < 2 * 3600_000) return 'fresh';
  if (ageMs < 8 * 3600_000) return 'stale';
  return 'old';
}

const STALENESS_COLOR = { fresh: '#16a34a', stale: '#b45309', old: '#9ca3af' };

export default function VehicleMapPanel({ asset, location, onClose }: Props) {
  const overlayRef    = useRef<HTMLDivElement>(null);
  const mapContainer  = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef        = useRef<any>(null);
  const token         = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (!mapContainer.current || !token) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any;
    const ro = new ResizeObserver(() => mapRef.current?.resize());
    ro.observe(mapContainer.current);

    import('mapbox-gl').then(({ default: mapboxgl }) => {
      import('mapbox-gl/dist/mapbox-gl.css').catch(() => {});
      mapboxgl.accessToken = token;

      map = new mapboxgl.Map({
        container: mapContainer.current!,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [location.lon, location.lat],
        zoom: 13,
      });
      mapRef.current = map;
      map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      map.on('load', () => map.resize());

      map.on('load', () => {
        // Pulsing blue dot marker
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
        if (!document.getElementById('truck-pulse-style')) {
          const style = document.createElement('style');
          style.id = 'truck-pulse-style';
          style.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
          document.head.appendChild(style);
        }
        wrapper.appendChild(pulse);
        wrapper.appendChild(dot);

        new mapboxgl.Marker({ element: wrapper })
          .setLngLat([location.lon, location.lat])
          .addTo(map);
      });
    });

    return () => { ro.disconnect(); map?.remove(); mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const age       = staleness(location.locatedAt);
  const locatedAt = new Date(location.locatedAt);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden"
        style={{ width: 780, height: 660, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: asset.color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{asset.name}</span>
              {asset.unit && <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>#{asset.unit}</span>}
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <MapPin size={10} style={{ color: STALENESS_COLOR[age], flexShrink: 0 }} />
              <span className="text-[12px] truncate" style={{ color: STALENESS_COLOR[age] }}>{location.description}</span>
              <span className="text-[11px] shrink-0" style={{ color: 'var(--gc-text-3)' }}>
                · {locatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Map */}
        <div className="flex-1 relative">
          <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

          {/* Coords + Google Maps link */}
          <div
            className="absolute bottom-2 right-2 flex items-center gap-2 rounded-md px-2 py-1"
            style={{ background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)' }}
          >
            <span className="text-[10px] font-mono" style={{ color: 'var(--gc-text-3)' }}>
              {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
            </span>
            <a
              href={`https://www.google.com/maps?q=${location.lat},${location.lon}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-[10px] font-medium"
              style={{ color: 'var(--gc-blue)', textDecoration: 'none' }}
            >
              <ExternalLink size={9} /> Maps
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
