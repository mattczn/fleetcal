'use client';

/**
 * TimelineMap — Google Map view tied to the asset-timeline's selection.
 *
 * Selection drives what's drawn:
 *   - null              → all visible clusters in faint asset-color lines
 *                          (just so the day's footprint is visible at all)
 *   - event selection   → highlight every cluster whose current link
 *                          references that event (loaded for it, or
 *                          transition with from/to = it). Non-linked
 *                          clusters dim down.
 *   - cluster selection → highlight just that cluster's route with the
 *                          full start/end markers + bright polyline.
 *                          Non-selected clusters dim down.
 *
 * Drawing model copies MovementDetailPanel:
 *   - Custom DOM markers (16px colored dots, optional label tag).
 *   - DirectionsService.route() for road polylines.
 *   - Straight-line dashed fallback when routing fails.
 *
 * Markers + polylines get torn down + redrawn on every selection
 * change. We keep the map instance alive across renders so panning
 * state (and the tile cache) survive.
 */

import { useEffect, useRef } from 'react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import type { TimelineCluster } from '@/lib/timelineClusters';
import type { TimelineEvent, TimelineLink } from '@/lib/railway';

interface Props {
  clusters:          TimelineCluster[];
  linkByMovementId:  Map<string, TimelineLink>;
  selection:
    | { kind: 'event';   eventId: string }
    | { kind: 'cluster'; clusterId: string }
    | null;
  assetColor:        string;
  /** Pixel height of the map container. */
  height:            number;
}

/** Picks the cluster(s) that should be drawn "prominent" based on the
 *  current selection. Everything else still renders, just faded. */
function highlightedIdsFor(
  selection: Props['selection'],
  clusters: TimelineCluster[],
  linkByMovementId: Map<string, TimelineLink>,
): Set<string> {
  if (!selection) return new Set(clusters.map((c) => c.id));
  if (selection.kind === 'cluster') return new Set([selection.clusterId]);
  // Event selection: any cluster whose any-member link refs this event id.
  const out = new Set<string>();
  for (const c of clusters) {
    for (const m of c.members) {
      const l = linkByMovementId.get(m.id);
      if (!l) continue;
      if (
        l.loadedEventId === selection.eventId ||
        l.fromEventId   === selection.eventId ||
        l.toEventId     === selection.eventId
      ) {
        out.add(c.id);
        break;
      }
    }
  }
  return out;
}

/** Returns the cluster's link role by checking its first member with a
 *  current link. Cluster members share an identical link post-AI, so
 *  the first one with a link is representative. */
function roleForCluster(
  cl: TimelineCluster,
  linkByMovementId: Map<string, TimelineLink>,
): TimelineLink['role'] | null {
  for (const m of cl.members) {
    const l = linkByMovementId.get(m.id);
    if (l) return l.role;
  }
  return null;
}

/** Polyline style for a cluster's route, per industry convention:
 *  loaded = solid heavy line; deadhead = dashed lighter line. */
function polylineOptionsForRole(
  role: TimelineLink['role'] | null,
  assetColor: string,
  path: google.maps.LatLngLiteral[],
): google.maps.PolylineOptions {
  if (role === 'loaded') {
    return {
      path,
      strokeColor:   assetColor,
      strokeOpacity: 0.95,
      strokeWeight:  5,
      geodesic:      true,
    };
  }
  if (role === 'transition') {
    // Dashed: stroke transparent + repeating short-line icons.
    return {
      path,
      strokeColor:   assetColor,
      strokeOpacity: 0,
      strokeWeight:  3,
      geodesic:      true,
      icons: [{
        icon:   { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: assetColor, scale: 3 } as google.maps.Symbol,
        offset: '0',
        repeat: '14px',
      }],
    };
  }
  // rest / unrelated / unlinked — neutral gray dashed so they show
  // but don't compete visually with real trips.
  return {
    path,
    strokeColor:   '#5f6368',
    strokeOpacity: 0,
    strokeWeight:  3,
    geodesic:      true,
    icons: [{
      icon:   { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#5f6368', scale: 3 } as google.maps.Symbol,
      offset: '0',
      repeat: '14px',
    }],
  };
}

/** Pull every coord pair we have across a cluster's members. */
function coordsForCluster(cl: TimelineCluster): {
  start: google.maps.LatLngLiteral | null;
  end:   google.maps.LatLngLiteral | null;
  waypoints: google.maps.DirectionsWaypoint[];
} {
  const firstWithOrigin = cl.members.find(
    (m) => m.originLat != null && m.originLon != null,
  );
  const lastWithDest = [...cl.members].reverse().find(
    (m) => m.destinationLat != null && m.destinationLon != null,
  );
  const start = firstWithOrigin
    ? { lat: firstWithOrigin.originLat as number, lng: firstWithOrigin.originLon as number }
    : null;
  const end = lastWithDest
    ? { lat: lastWithDest.destinationLat as number, lng: lastWithDest.destinationLon as number }
    : null;

  // Intermediate members' origins become waypoints — same logic
  // MovementDetailPanel uses for the calendar's cluster modal.
  const waypoints: google.maps.DirectionsWaypoint[] = [];
  cl.members.forEach((m, idx) => {
    if (idx === 0) return;
    if (m.originLat != null && m.originLon != null) {
      waypoints.push({
        location: { lat: m.originLat, lng: m.originLon },
        stopover: true,
      });
    }
  });

  return { start, end, waypoints };
}

function makeDot(color: string, label: string | null = null): HTMLElement {
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

export default function TimelineMap({
  clusters, linkByMovementId, selection, assetColor, height,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  // Everything we paint each render lives here so we can tear it down
  // on the next selection change without leaking handles.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overlaysRef  = useRef<Array<{ setMap: (m: any) => void }>>([]);
  const errorRef     = useRef<HTMLDivElement>(null);

  // ── Init map once ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    loadGoogleMaps()
      .then((google) => {
        if (cancelled || !containerRef.current) return;
        const map = new google.maps.Map(containerRef.current, {
          // Default center somewhere sensible (continental US) until
          // we fit bounds to actual cluster coords.
          center: { lat: 39.5, lng: -98.5 },
          zoom: 4,
          mapId: MAP_ID,
          disableDefaultUI: false,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
        mapRef.current = map;
      })
      .catch((err) => {
        if (cancelled) return;
        if (errorRef.current) {
          errorRef.current.textContent =
            err instanceof Error ? err.message : 'Failed to load map';
          errorRef.current.style.display = 'flex';
        }
      });

    return () => {
      cancelled = true;
      mapRef.current = null;
    };
  }, []);

  // ── Draw / redraw markers + polylines on every selection or
  //    cluster-set change. Keeps the map instance alive across runs. ─
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // The Google libs are loaded by the time mapRef is populated.
    const g = window.google;
    if (!g) return;

    // Tear down anything from the previous pass.
    for (const ov of overlaysRef.current) ov.setMap(null);
    overlaysRef.current = [];

    const highlighted = highlightedIdsFor(selection, clusters, linkByMovementId);
    const bounds = new g.maps.LatLngBounds();
    let boundsTouched = false;

    // Pass 1: faint background lines for every cluster that ISN'T
    // highlighted — keeps the day's footprint visible while a selection
    // narrows focus.
    for (const cl of clusters) {
      if (highlighted.has(cl.id)) continue;
      const { start, end, waypoints } = coordsForCluster(cl);
      if (!start || !end) continue;
      const path = [start, ...waypoints.map((w) => w.location as google.maps.LatLngLiteral), end];
      const line = new g.maps.Polyline({
        map, path,
        strokeColor: '#9aa0a6',
        strokeOpacity: 0.45,
        strokeWeight: 2,
        geodesic: true,
      });
      overlaysRef.current.push(line);
    }

    // Pass 2: prominent renders for each highlighted cluster.
    // Each gets a Start dot (or numbered dot if it's one of many),
    // intermediate waypoint dots, End dot, and a routed polyline
    // styled by link role (loaded = solid heavy, deadhead = dashed).
    const highlightedClusters = clusters.filter((c) => highlighted.has(c.id));
    highlightedClusters.forEach((cl, idx) => {
      const { start, end, waypoints } = coordsForCluster(cl);
      const role = roleForCluster(cl, linkByMovementId);

      // Per-cluster Start / End numbering when multiple are highlighted
      // (event-selection case: many trips for one load).
      const startLabel = highlightedClusters.length > 1 ? `${idx + 1}` : 'Start';
      const endLabel   = highlightedClusters.length > 1 ? null : 'End';

      if (start) {
        const m = new g.maps.marker.AdvancedMarkerElement({
          map, position: start,
          content: makeDot('#16a34a', startLabel),
        });
        overlaysRef.current.push({
          setMap: (mp) => { (m as { map: google.maps.Map | null }).map = mp; },
        });
        bounds.extend(start); boundsTouched = true;
      }
      for (const wp of waypoints) {
        const loc = wp.location as google.maps.LatLngLiteral;
        const m = new g.maps.marker.AdvancedMarkerElement({
          map, position: loc, content: makeDot(assetColor),
        });
        overlaysRef.current.push({
          setMap: (mp) => { (m as { map: google.maps.Map | null }).map = mp; },
        });
        bounds.extend(loc); boundsTouched = true;
      }
      if (end) {
        const m = new g.maps.marker.AdvancedMarkerElement({
          map, position: end,
          content: makeDot('#dc2626', endLabel),
        });
        overlaysRef.current.push({
          setMap: (mp) => { (m as { map: google.maps.Map | null }).map = mp; },
        });
        bounds.extend(end); boundsTouched = true;
      }

      // Polyline rendering: ask DirectionsService for the road path,
      // then draw OUR OWN polyline using role-specific styling (solid
      // for loaded, dashed for deadhead). DirectionsRenderer can't
      // dash, so we ignore it and use the result's overview_path.
      if (start && end) {
        const ds = new g.maps.DirectionsService();
        ds.route(
          {
            origin: start, destination: end, waypoints,
            travelMode: g.maps.TravelMode.DRIVING,
            optimizeWaypoints: false,
          },
          (result, status) => {
            let path: google.maps.LatLngLiteral[];
            if (status === g.maps.DirectionsStatus.OK && result?.routes?.[0]) {
              // Road-accurate path from the routing result.
              path = result.routes[0].overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
            } else {
              // Routing failed — straight line through waypoints.
              path = [start, ...waypoints.map((w) => w.location as google.maps.LatLngLiteral), end];
            }
            const line = new g.maps.Polyline({
              ...polylineOptionsForRole(role, assetColor, path),
              map,
            });
            overlaysRef.current.push(line);
          },
        );
      }
    });

    // Fit bounds: if anything highlighted, fit to it. Else fit to all
    // clusters (no-op the first time when nothing is on the map).
    if (boundsTouched) {
      // The padding leaves room for the detail header above to not
      // visually overlap markers near the top edge.
      map.fitBounds(bounds, 60);
    } else if (clusters.length > 0) {
      const all = new g.maps.LatLngBounds();
      let touched = false;
      for (const c of clusters) {
        const { start, end } = coordsForCluster(c);
        if (start) { all.extend(start); touched = true; }
        if (end)   { all.extend(end);   touched = true; }
      }
      if (touched) map.fitBounds(all, 60);
    }
  }, [clusters, linkByMovementId, selection, assetColor]);

  return (
    <div
      className="relative rounded-lg overflow-hidden"
      style={{
        height,
        background: 'var(--gc-surface-2)',
        border:     '1px solid var(--gc-border)',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div
        ref={errorRef}
        className="absolute inset-0 items-center justify-center text-center px-4"
        style={{
          display: 'none',
          background: 'var(--gc-surface)',
          color: 'var(--gc-text-3)',
          fontSize: 12,
        }}
      />
    </div>
  );
}
