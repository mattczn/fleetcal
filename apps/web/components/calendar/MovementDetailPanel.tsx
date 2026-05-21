/**
 * MovementDetailPanel — modal that opens when a dispatcher clicks a
 * driving-period card. Shows the route(s) on a map plus all the Motive
 * metadata we mirror. Read-only — Motive is the source of truth.
 *
 * Two modes:
 *   - Single member: classic origin → destination polyline + metadata grid.
 *   - Clustered (>1 member): every member's start dot is plotted, a
 *     polyline threads through them in time order, and the body shows
 *     a row per member so the dispatcher can audit what the cluster
 *     actually contained.
 */
'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, MapPin, ExternalLink, Clock, Activity, Layers } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import type { MovementCard } from '@/lib/railway';
import { extractCity, type MovementCluster } from '@/lib/clusterMovements';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  cluster: MovementCluster;
  asset:   { name: string; color: string; unit?: string };
  onClose: () => void;
}

function fmtTime(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(d);
}

function fmtTimeOnly(iso: string | null, tz: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: '2-digit',
  }).format(d);
}

function fmtDuration(min: number | null): string {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function MovementDetailPanel({ cluster, asset, onClose }: Props) {
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const { calendarTimezone } = useCalendarStore();

  const isCluster = cluster.members.length > 1;
  const single    = cluster.members[0];

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Collect every coord we have across all members so the map can
  // render either a single route or a multi-stop connect-the-dots.
  const coords: { lat: number; lng: number; kind: 'start' | 'end'; member: MovementCard }[] = [];
  for (const m of cluster.members) {
    if (m.originLat != null && m.originLon != null) {
      coords.push({ lat: m.originLat, lng: m.originLon, kind: 'start', member: m });
    }
    if (m.destinationLat != null && m.destinationLon != null) {
      coords.push({ lat: m.destinationLat, lng: m.destinationLon, kind: 'end', member: m });
    }
  }
  const hasAnyCoords = coords.length > 0;

  // Single-route convenience pointers (only used when !isCluster)
  const hasOrigin = single.originLat != null && single.originLon != null;
  const hasDest   = single.destinationLat != null && single.destinationLon != null;
  const hasRoute  = hasOrigin && hasDest;

  useEffect(() => {
    if (!mapContainer.current) return;
    if (!hasAnyCoords) return;

    let cancelled = false;
    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;

      const map = new google.maps.Map(mapContainer.current, {
        center: { lat: coords[0].lat, lng: coords[0].lng },
        zoom: 10, mapId: MAP_ID,
        disableDefaultUI: false, clickableIcons: false,
        gestureHandling: 'greedy',
      });
      mapRef.current = map;

      const dot = (color: string, label: string) => {
        const el = document.createElement('div');
        el.style.cssText = `position:relative;width:16px;height:16px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);`;
        if (label) {
          const tag = document.createElement('div');
          tag.style.cssText = 'position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;color:#111;background:rgba(255,255,255,0.95);padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.15);';
          tag.textContent = label;
          el.appendChild(tag);
        }
        return el;
      };

      // Resolve origin (first member's start), destination (last
      // member's end), and any intermediate stops as waypoints. Used
      // for both single-period and cluster renders.
      const firstWithOrigin = cluster.members.find(m => m.originLat != null && m.originLon != null);
      const lastWithDest    = [...cluster.members].reverse().find(m => m.destinationLat != null && m.destinationLon != null);
      const startPos = firstWithOrigin
        ? { lat: firstWithOrigin.originLat as number, lng: firstWithOrigin.originLon as number }
        : null;
      const endPos = lastWithDest
        ? { lat: lastWithDest.destinationLat as number, lng: lastWithDest.destinationLon as number }
        : null;

      // For clusters, intermediate member starts (except the first)
      // become waypoints. Drop the dots regardless so dispatchers see
      // the order of the moves.
      const waypoints: google.maps.DirectionsWaypoint[] = [];
      if (isCluster) {
        cluster.members.forEach((m, idx) => {
          if (idx === 0) return; // already covered by startPos
          if (m.originLat != null && m.originLon != null) {
            waypoints.push({ location: { lat: m.originLat, lng: m.originLon }, stopover: true });
            new google.maps.marker.AdvancedMarkerElement({
              map, position: { lat: m.originLat, lng: m.originLon },
              content: dot(asset.color, `${idx + 1}`),
            });
          }
        });
      }
      if (startPos) {
        new google.maps.marker.AdvancedMarkerElement({
          map, position: startPos,
          content: dot('#16a34a', isCluster ? '1' : 'Start'),
        });
      }
      if (endPos) {
        new google.maps.marker.AdvancedMarkerElement({
          map, position: endPos,
          content: dot('#dc2626', 'End'),
        });
      }

      const drawStraightFallback = () => {
        const path: google.maps.LatLngLiteral[] = [];
        if (startPos) path.push(startPos);
        for (const wp of waypoints) {
          const loc = wp.location as google.maps.LatLngLiteral;
          path.push(loc);
        }
        if (endPos) path.push(endPos);
        if (path.length >= 2) {
          new google.maps.Polyline({
            path, map, strokeColor: asset.color, strokeOpacity: 0.6,
            strokeWeight: 3, geodesic: true,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '12px' }],
          });
        }
      };

      if (startPos && endPos) {
        const directionsService  = new google.maps.DirectionsService();
        const directionsRenderer = new google.maps.DirectionsRenderer({
          map,
          suppressMarkers: true, // keep our custom Start / End / waypoint dots
          polylineOptions: { strokeColor: asset.color, strokeOpacity: 0.85, strokeWeight: 4 },
          preserveViewport: false,
        });
        directionsService.route(
          {
            origin: startPos,
            destination: endPos,
            waypoints: waypoints,
            travelMode: google.maps.TravelMode.DRIVING,
            optimizeWaypoints: false,
          },
          (result, status) => {
            if (cancelled) return;
            if (status === google.maps.DirectionsStatus.OK && result) {
              directionsRenderer.setDirections(result);
            } else {
              // Common reasons: ZERO_RESULTS (across an ocean),
              // OVER_QUERY_LIMIT, no road near coords. Fall back to a
              // dashed straight line so we still show *something*.
              drawStraightFallback();
              const bounds = new google.maps.LatLngBounds();
              if (startPos) bounds.extend(startPos);
              if (endPos)   bounds.extend(endPos);
              waypoints.forEach(wp => bounds.extend(wp.location as google.maps.LatLngLiteral));
              map.fitBounds(bounds, 60);
            }
          },
        );
      } else {
        // Only one endpoint — center on it, no route to draw.
        const only = startPos ?? endPos;
        if (only) map.setCenter(only);
      }
    });

    return () => { cancelled = true; mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inProgress  = !isCluster && (single.status === 'in_progress' || single.endTime == null);

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', zIndex: 1000 }}
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
              {isCluster && (
                <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1"
                  style={{ background: asset.color, color: 'white' }}>
                  <Layers size={10} /> {cluster.members.length} moves
                </span>
              )}
              {inProgress && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1"
                  style={{ background: '#16a34a', color: 'white' }}>
                  Live
                </span>
              )}
            </div>
            <div className="text-[12px] truncate mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {(() => {
                const o = extractCity(cluster.origin);
                const d = extractCity(cluster.destination);
                if (o && d && o.toLowerCase() === d.toLowerCase()) return `around ${o}`;
                if (o && d) return `${o} → ${d}`;
                return o ?? d ?? '—';
              })()}
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

        {/* Body — map on top, metadata/member list below */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="relative" style={{ height: 420 }}>
            {hasAnyCoords ? (
              <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
            ) : (
              <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)' }}>
                No coordinates reported for {isCluster ? 'any of these periods' : 'this period'}
              </div>
            )}

            {!isCluster && hasRoute && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&origin=${single.originLat},${single.originLon}&destination=${single.destinationLat},${single.destinationLon}`}
                target="_blank" rel="noopener noreferrer"
                className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-1"
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)', color: 'var(--gc-blue)', textDecoration: 'none' }}
              >
                <ExternalLink size={10} /> Open in Maps
              </a>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 px-4 py-3 overflow-y-auto" style={{ background: 'var(--gc-bg)', borderTop: '1px solid var(--gc-border-light)' }}>
            {isCluster ? (
              <ClusterBody cluster={cluster} tz={calendarTimezone} />
            ) : (
              <SingleBody movement={single} tz={calendarTimezone} inProgress={inProgress} />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  // Portal to document.body so the fixed overlay isn't clipped by an
  // ancestor's containing block (transform/filter/contain). Component
  // is 'use client' + only renders after user click — past hydration —
  // but guard typeof document anyway in case it ever renders on the
  // server. Using a useState mount gate would break the map's []-deps
  // effect (the ref isn't attached on the first null render).
  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

// ── Single-period body ────────────────────────────────────────────────────

function SingleBody({ movement, tz, inProgress }: {
  movement: MovementCard; tz: string; inProgress: boolean;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
        <Field icon={<Clock size={12} />} label="Started">{fmtTime(movement.startTime, tz)}</Field>
        <Field icon={<Clock size={12} />} label="Ended">
          {inProgress ? <span style={{ color: '#16a34a' }}>still in progress</span> : fmtTime(movement.endTime, tz)}
        </Field>
        <Field icon={<Activity size={12} />} label="Distance">
          {movement.miles != null ? `${movement.miles.toFixed(1)} mi` : '—'}
        </Field>
        <Field icon={<Clock size={12} />} label="Duration">{fmtDuration(movement.durationMin)}</Field>
        <Field icon={<MapPin size={12} />} label="Origin">{movement.origin ?? '—'}</Field>
        <Field icon={<MapPin size={12} />} label="Destination">{movement.destination ?? '—'}</Field>
      </div>
      <div className="mt-3 pt-3 text-[10px] font-mono" style={{ color: 'var(--gc-text-3)', borderTop: '1px solid var(--gc-border-light)' }}>
        Motive driving_period #{movement.id} · vehicle {movement.vehicleNumber ?? movement.vehicleId}
      </div>
    </>
  );
}

// ── Cluster body — summary header + per-member list ───────────────────────

function ClusterBody({ cluster, tz }: { cluster: MovementCluster; tz: string }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-x-6 gap-y-3 text-[12px] mb-4">
        <Field icon={<Layers size={12} />} label="Short moves">
          {cluster.members.length}
        </Field>
        <Field icon={<Activity size={12} />} label="Total miles">
          {cluster.miles.toFixed(1)} mi
        </Field>
        <Field icon={<Clock size={12} />} label="Total driving">
          {fmtDuration(cluster.durationMin)}
        </Field>
      </div>

      <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
        Members
      </div>
      <div className="flex flex-col gap-2">
        {cluster.members.map((m, i) => {
          const hasRoute = m.originLat != null && m.originLon != null && m.destinationLat != null && m.destinationLon != null;
          return (
            <div key={m.id}
              className="flex items-start gap-3 rounded-lg px-3 py-2 text-[12px]"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}
            >
              <div className="flex items-center justify-center w-5 h-5 rounded-full shrink-0 text-[10px] font-bold text-white" style={{ background: 'var(--gc-text-2)' }}>
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                    {fmtTimeOnly(m.startTime, tz)}
                    {m.endTime && m.endTime !== m.startTime && (
                      <> – {fmtTimeOnly(m.endTime, tz)}</>
                    )}
                  </span>
                  <span style={{ color: 'var(--gc-text-3)' }}>
                    {m.miles != null ? `${m.miles.toFixed(1)} mi` : ''}
                    {m.miles != null && m.durationMin != null ? ' · ' : ''}
                    {m.durationMin != null ? fmtDuration(m.durationMin) : ''}
                  </span>
                </div>
                {(m.origin || m.destination) && (
                  <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }} title={[m.origin, m.destination].filter(Boolean).join(' → ')}>
                    {extractCity(m.origin) ?? '—'}
                    {m.origin && m.destination ? ' → ' : ' '}
                    {extractCity(m.destination) ?? ''}
                  </div>
                )}
              </div>
              {hasRoute && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&origin=${m.originLat},${m.originLon}&destination=${m.destinationLat},${m.destinationLon}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] font-medium shrink-0"
                  style={{ color: 'var(--gc-blue)', textDecoration: 'none' }}
                  onClick={e => e.stopPropagation()}
                >
                  <ExternalLink size={10} /> Maps
                </a>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
        {icon}
        {label}
      </div>
      <div style={{ color: 'var(--gc-text-1)' }}>{children}</div>
    </div>
  );
}
