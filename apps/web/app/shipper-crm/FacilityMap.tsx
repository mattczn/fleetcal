'use client';

/**
 * FacilityMap — every shipper/receiver/warehouse plotted on a Google Map.
 *
 * Uses the Data layer (GeoJSON) rather than one AdvancedMarkerElement per
 * facility: a carrier can easily have ~1,300 of these, and that many DOM
 * markers janks the map. The Data layer draws them as styled circle symbols
 * in one pass and stays smooth. Circle size scales with how often we run
 * there (the whole point is to see the busy ones), colour encodes role
 * (ship / receive / both), and the selected facility gets a dark ring.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import type { Facility, FacilityRole } from '@fleetcal/types';

interface Props {
  facilities: Facility[];
  selectedGeoKey: string | null;
  onSelect: (geoKey: string) => void;
}

const ROLE_COLOR: Record<FacilityRole, string> = {
  shipper:  '#1a73e8', // blue — we pick up here
  receiver: '#188038', // green — we deliver here
  both:     '#8430ce', // purple — both
  stop:     '#80868b', // grey — intermediate stop
};

/** Circle radius from visit count — sqrt so a 900-load facility isn't 90×
 *  a 10-load one, just clearly bigger. Clamped to stay tappable + sane. */
function radiusFor(visits: number): number {
  return Math.max(5, Math.min(24, 5 + Math.sqrt(visits) * 1.05));
}

export default function FacilityMap({ facilities, selectedGeoKey, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const errorRef     = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  // Refs so the once-registered style/click closures read live values
  // without re-binding listeners on every render.
  const selectedRef  = useRef<string | null>(selectedGeoKey);
  const onSelectRef  = useRef(onSelect);
  const styleFnRef   = useRef<google.maps.Data.StylingFunction | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // Keep the click handler's callback current without re-binding listeners.
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // ── (Re)draw features when the facility set changes ────────────────
  const drawFeatures = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.data.forEach((f) => map.data.remove(f));

    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const f of facilities) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
      map.data.addGeoJson({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: { geoKey: f.geoKey, visits: f.stats.visitCount, role: f.role, name: f.name ?? '' },
      });
      bounds.extend({ lat: f.lat, lng: f.lng });
      any = true;
    }
    // Only auto-fit when nothing is selected — a selection drives its own
    // focus and we don't want to yank the viewport out from under it.
    if (any && !selectedRef.current) map.fitBounds(bounds, 48);
  }, [facilities]);

  const focusSelected = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    // Re-apply styles so the ring moves to the new selection.
    if (styleFnRef.current) map.data.setStyle(styleFnRef.current);
    const gk = selectedRef.current;
    if (!gk) return;
    const target = facilities.find((f) => f.geoKey === gk);
    if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
      map.panTo({ lat: target.lat, lng: target.lng });
      if ((map.getZoom() ?? 0) < 9) map.setZoom(11);
    }
  }, [facilities]);

  // ── Init once ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    loadGoogleMaps()
      .then((google) => {
        if (cancelled || !containerRef.current) return;
        const map = new google.maps.Map(containerRef.current, {
          center: { lat: 39.8, lng: -98.5 },
          zoom: 4,
          mapId: MAP_ID,
          clickableIcons: false,
          gestureHandling: 'greedy',
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        });
        mapRef.current = map;

        const styleFn: google.maps.Data.StylingFunction = (feature) => {
          const visits = (feature.getProperty('visits') as number) ?? 1;
          const role   = (feature.getProperty('role') as FacilityRole) ?? 'stop';
          const gk     = feature.getProperty('geoKey') as string;
          const sel    = gk === selectedRef.current;
          const r      = radiusFor(visits);
          return {
            icon: {
              path:          google.maps.SymbolPath.CIRCLE,
              scale:         sel ? r + 4 : r,
              fillColor:     ROLE_COLOR[role],
              fillOpacity:   sel ? 0.95 : 0.68,
              strokeColor:   sel ? '#202124' : '#ffffff',
              strokeWeight:  sel ? 2.5 : 1,
            },
            // Busiest on top; selected always wins.
            zIndex: sel ? 10_000 : Math.round(visits),
          };
        };
        styleFnRef.current = styleFn;
        map.data.setStyle(styleFn);

        map.data.addListener('click', (e: google.maps.Data.MouseEvent) => {
          const gk = e.feature.getProperty('geoKey') as string | undefined;
          if (gk) onSelectRef.current(gk);
        });

        setMapReady(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (errorRef.current) {
          errorRef.current.textContent =
            err instanceof Error ? err.message : 'Failed to load map';
          errorRef.current.style.display = 'flex';
        }
      });

    return () => { cancelled = true; mapRef.current = null; };
  }, []);

  // Draw once the map is ready, then on every facility-set change.
  useEffect(() => { if (mapReady) drawFeatures(); }, [mapReady, drawFeatures]);

  // Keep the selection ref + viewport in sync with the chosen facility.
  useEffect(() => {
    selectedRef.current = selectedGeoKey;
    if (mapReady) focusSelected();
  }, [mapReady, selectedGeoKey, focusSelected]);

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-xl"
      style={{ background: 'var(--gc-surface-2)', border: '1px solid var(--gc-border)' }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        ref={errorRef}
        className="absolute inset-0 items-center justify-center text-center px-4"
        style={{ display: 'none', background: 'var(--gc-surface)', color: 'var(--gc-text-3)', fontSize: 12 }}
      />
      {/* Legend */}
      <div
        className="absolute left-3 bottom-3 flex items-center gap-3 rounded-lg px-3 py-2"
        style={{ background: 'rgba(255,255,255,0.95)', boxShadow: 'var(--shadow-2, 0 2px 8px rgba(0,0,0,0.15))' }}
      >
        {([['shipper', 'Ship'], ['receiver', 'Receive'], ['both', 'Both']] as const).map(([role, label]) => (
          <span key={role} className="flex items-center gap-1.5" style={{ fontSize: 11, fontWeight: 700, color: '#3c4043' }}>
            <span style={{ width: 10, height: 10, borderRadius: 999, background: ROLE_COLOR[role] }} />
            {label}
          </span>
        ))}
        <span style={{ fontSize: 10.5, color: '#80868b', fontWeight: 600 }}>· size = visits</span>
      </div>
    </div>
  );
}
