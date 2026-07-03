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

import { useEffect, useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { type TimelineCluster } from '@/lib/timelineClusters';
import { extractCity } from '@/lib/clusterMovements';
import type { TimelineEvent, TimelineLink } from '@/lib/railway';

interface Props {
  clusters:          TimelineCluster[];
  linkByMovementId:  Map<string, TimelineLink>;
  /** Used by the bottom-overlay footer to resolve event titles when an
   *  event is selected. Optional — when omitted, the footer falls back
   *  to the cluster route description. */
  eventLookup?:      Map<string, TimelineEvent>;
  tz:                string;
  selection:
    | { kind: 'event';   eventId: string }
    | { kind: 'cluster'; clusterId: string }
    | null;
  assetColor:        string;
  /** Pixel height of the map container. */
  height:            number;
  /** Called when the footer's prev / next steps to a different cluster
   *  — page reacts by updating selection state. */
  onSelectCluster?:  (clusterId: string) => void;
  /** Called when the footer's "Clear" button is hit. */
  onClearSelection?: () => void;
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

/**
 * Module-level cache of routed paths, keyed on the lane's coordinates.
 * Each `DirectionsService.route()` is a billable Directions request, and the
 * paint effect re-runs on every selection/highlight change — so without this,
 * clicking around the timeline re-bills the identical origin→destination route
 * on every click. A lane's road geometry doesn't depend on the selection, so we
 * cache the resolved path and reuse it for the life of the page. Bounded to
 * avoid unbounded growth across a long session.
 */
const timelineRoutePathCache = new Map<string, google.maps.LatLngLiteral[]>();
const ROUTE_CACHE_MAX = 500;

function routeCacheKey(
  start: google.maps.LatLngLiteral,
  end: google.maps.LatLngLiteral,
  waypoints: google.maps.DirectionsWaypoint[],
): string {
  const r = (n: number) => n.toFixed(5);
  const wp = waypoints
    .map((w) => {
      const l = w.location as google.maps.LatLngLiteral;
      return `${r(l.lat)},${r(l.lng)}`;
    })
    .join(';');
  return `${r(start.lat)},${r(start.lng)}|${wp}|${r(end.lat)},${r(end.lng)}`;
}

function rememberRoutePath(key: string, path: google.maps.LatLngLiteral[]): void {
  if (timelineRoutePathCache.size >= ROUTE_CACHE_MAX) {
    const oldest = timelineRoutePathCache.keys().next().value;
    if (oldest !== undefined) timelineRoutePathCache.delete(oldest);
  }
  timelineRoutePathCache.set(key, path);
}

export default function TimelineMap({
  clusters, linkByMovementId, eventLookup, tz,
  selection, assetColor, height,
  onSelectCluster, onClearSelection,
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
        const drawPath = (path: google.maps.LatLngLiteral[]) => {
          const line = new g.maps.Polyline({
            ...polylineOptionsForRole(role, assetColor, path),
            map,
          });
          overlaysRef.current.push(line);
        };

        // Reuse the cached road geometry for this lane when we've already
        // routed it — a re-selection redraws without a new Directions call.
        const cacheKey = routeCacheKey(start, end, waypoints);
        const cachedPath = timelineRoutePathCache.get(cacheKey);
        if (cachedPath) {
          drawPath(cachedPath);
        } else {
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
                rememberRoutePath(cacheKey, path);
              } else {
                // Routing failed — straight line through waypoints. Not cached
                // so a later attempt can still get the real road geometry.
                path = [start, ...waypoints.map((w) => w.location as google.maps.LatLngLiteral), end];
              }
              drawPath(path);
            },
          );
        }
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

  // ── Click-through footer overlay ──────────────────────────────────
  //
  // Mirrors AssetDetailModal's bottom-overlay click-through. The list
  // we cycle through depends on what's selected:
  //   - event   → clusters whose link references that event
  //   - cluster → ALL day clusters
  //   - nothing → ALL day clusters; clicking next picks cluster #1
  //
  // This way the dispatcher can click a load chip and step through
  // just that load's deliveries, or click no chip and audit the day.

  const cycleList = useMemo<TimelineCluster[]>(() => {
    if (selection?.kind === 'event') {
      const out: TimelineCluster[] = [];
      for (const cl of clusters) {
        for (const m of cl.members) {
          const l = linkByMovementId.get(m.id);
          if (!l) continue;
          if (
            l.loadedEventId === selection.eventId ||
            l.fromEventId   === selection.eventId ||
            l.toEventId     === selection.eventId
          ) {
            out.push(cl);
            break;
          }
        }
      }
      return out;
    }
    return clusters;
  }, [clusters, linkByMovementId, selection]);

  const selectedClusterId = selection?.kind === 'cluster' ? selection.clusterId : null;
  const currentIdx = selectedClusterId
    ? cycleList.findIndex((c) => c.id === selectedClusterId)
    : -1;

  const prevCluster = currentIdx > 0 ? cycleList[currentIdx - 1] : null;
  const nextCluster = currentIdx === -1
    ? (cycleList[0] ?? null)
    : (currentIdx < cycleList.length - 1 ? cycleList[currentIdx + 1] : null);

  const activeCluster: TimelineCluster | null = currentIdx >= 0 ? cycleList[currentIdx] : null;

  // Header text — the route summary for the active cluster, OR the
  // linked event's title when an event is selected but no cluster yet,
  // OR a "Day overview" fallback.
  const footerTitle: string = (() => {
    if (activeCluster) {
      const o = extractCity(activeCluster.origin);
      const d = extractCity(activeCluster.destination);
      if (o && d && o.toLowerCase() === d.toLowerCase()) return `around ${o}`;
      if (o || d) return `${o ?? '—'} → ${d ?? '—'}`;
      return 'Trip';
    }
    if (selection?.kind === 'event' && eventLookup) {
      const ev = eventLookup.get(selection.eventId);
      if (ev?.title) return ev.title;
    }
    return cycleList.length > 0 ? `${cycleList.length} trip${cycleList.length === 1 ? '' : 's'}` : 'No trips';
  })();

  const footerSubtitle: string = (() => {
    if (activeCluster) {
      const start = new Date(activeCluster.startTime);
      const end   = activeCluster.endTime ? new Date(activeCluster.endTime) : null;
      const fmtT = (d: Date) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
      const fmtD = (d: Date) => d.toLocaleDateString('en-US', { timeZone: tz, month: 'numeric', day: 'numeric' });
      const date = fmtD(start);
      const timeRange = end ? `${fmtT(start)} – ${fmtT(end)}` : fmtT(start);
      const miles = `${activeCluster.miles.toFixed(1)} mi`;
      const dur   = `${activeCluster.durationMin}m`;
      return `${date}, ${timeRange} · ${miles} · ${dur}`;
    }
    if (selection?.kind === 'event') return `Click ‹ or › to step through linked trips`;
    return `Click ‹ or › to step through the day's trips`;
  })();

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

      {/* Bottom-overlay click-through — mirrors AssetDetailModal's. */}
      {cycleList.length > 0 || selection != null ? (
        <div
          className="absolute left-4 right-4 bottom-4 flex items-center gap-3 rounded-2xl px-4 py-3"
          style={{
            background:     'rgba(255,255,255,0.96)',
            backdropFilter: 'blur(8px)',
            boxShadow:      'var(--shadow-3)',
          }}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {footerTitle}
            </div>
            <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>
              {footerSubtitle}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => prevCluster && onSelectCluster?.(prevCluster.id)}
              disabled={!prevCluster}
              className="p-1.5 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="Earlier (← key)"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-[10px] font-mono tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
              {currentIdx >= 0 ? currentIdx + 1 : 0} / {cycleList.length}
            </span>
            <button
              onClick={() => nextCluster && onSelectCluster?.(nextCluster.id)}
              disabled={!nextCluster}
              className="p-1.5 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ color: 'var(--gc-text-2)' }}
              onMouseEnter={(e) => { if (!e.currentTarget.disabled) e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              title="Later (→ key)"
            >
              <ChevronRight size={16} />
            </button>
            {selection != null ? (
              <button
                onClick={() => onClearSelection?.()}
                className="flex items-center gap-1 ml-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors"
                style={{
                  color:       assetColor,
                  background:  `${assetColor}1f`,        // ~12% alpha
                  border:      `1px solid ${assetColor}4d`,
                }}
                title="Clear selection (Esc)"
              >
                <X size={11} />
                Clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
