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
  const selFeatRef   = useRef<google.maps.Data.Feature | null>(null);
  const didFitRef    = useRef(false);
  const lastSigRef   = useRef<string>('');
  const [mapReady, setMapReady] = useState(false);

  // Keep the click handler's callback current without re-binding listeners.
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // Latest facilities for applySelection's pan lookup, without making the
  // selection callback depend on (and re-run for) every array change.
  const facilitiesRef = useRef(facilities);
  useEffect(() => { facilitiesRef.current = facilities; }, [facilities]);

  // Ring the selected facility, and pan to it only on a real selection
  // change (`pan`). Uses overrideStyle on the one feature (found by its
  // geoKey id) instead of restyling all ~1,300, so a click is O(1). Stable
  // identity (no deps) so logging a call doesn't re-pan the map.
  const applySelection = useCallback((gk: string | null, pan: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    if (selFeatRef.current) { map.data.revertStyle(selFeatRef.current); selFeatRef.current = null; }
    if (!gk) return;
    const feat = map.data.getFeatureById(gk);
    if (feat) {
      const visits = (feat.getProperty('visits') as number) ?? 1;
      const role   = (feat.getProperty('role') as FacilityRole) ?? 'stop';
      map.data.overrideStyle(feat, {
        icon: {
          path: google.maps.SymbolPath.CIRCLE, scale: radiusFor(visits) + 4,
          fillColor: ROLE_COLOR[role], fillOpacity: 0.95,
          strokeColor: '#202124', strokeWeight: 2.5,
        },
        zIndex: 10_000,
      });
      selFeatRef.current = feat;
    }
    if (pan) {
      const target = facilitiesRef.current.find((f) => f.geoKey === gk);
      if (target && Number.isFinite(target.lat) && Number.isFinite(target.lng)) {
        map.panTo({ lat: target.lat, lng: target.lng });
        if ((map.getZoom() ?? 0) < 9) map.setZoom(11);
      }
    }
  }, []);

  // Rebuild markers ONLY when the set of facilities actually changes — not
  // when a selection or an outreach edit hands us a new array of the same
  // points. The signature guard is what stops a logged call from redrawing
  // the whole map.
  const drawFeatures = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const sig = [...facilities].map((f) => f.geoKey).sort().join('|');
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    selFeatRef.current = null;
    map.data.forEach((f) => map.data.remove(f));

    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const f of facilities) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
      map.data.addGeoJson({
        type: 'Feature',
        id: f.geoKey,
        geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
        properties: { geoKey: f.geoKey, visits: f.stats.visitCount, role: f.role, name: f.name ?? '' },
      });
      bounds.extend({ lat: f.lat, lng: f.lng });
      any = true;
    }
    // Fit the viewport ONCE, on the first populated draw. Keeping it stable
    // after that is what stops the map lurching every time you filter.
    if (any && !didFitRef.current) { map.fitBounds(bounds, 48); didFitRef.current = true; }
    if (selectedRef.current) applySelection(selectedRef.current, false);
  }, [facilities, applySelection]);

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

        // Base style: role colour + size by visits. The selected facility is
        // handled separately via overrideStyle, so a click never re-runs
        // this for every point.
        map.data.setStyle((feature) => {
          const visits = (feature.getProperty('visits') as number) ?? 1;
          const role   = (feature.getProperty('role') as FacilityRole) ?? 'stop';
          const r      = radiusFor(visits);
          return {
            icon: {
              path: google.maps.SymbolPath.CIRCLE, scale: r,
              fillColor: ROLE_COLOR[role], fillOpacity: 0.68,
              strokeColor: '#ffffff', strokeWeight: 1,
            },
            zIndex: Math.round(visits),
          };
        });

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

  // Draw once the map is ready, then whenever the facility SET changes.
  useEffect(() => { if (mapReady) drawFeatures(); }, [mapReady, drawFeatures]);

  // Selection: ring + pan the one feature, no full restyle.
  useEffect(() => {
    selectedRef.current = selectedGeoKey;
    if (mapReady) applySelection(selectedGeoKey, true);
  }, [mapReady, selectedGeoKey, applySelection]);

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
