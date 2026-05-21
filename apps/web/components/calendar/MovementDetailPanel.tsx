/**
 * MovementDetailPanel — modal that opens when a dispatcher clicks a
 * driving-period card. Shows the route polyline between origin and
 * destination (when coords are present) plus all the Motive metadata
 * we mirror. Read-only — Motive is the source of truth.
 *
 * Mirrors VehicleMapPanel's modal-over-map layout so the two telemetry
 * surfaces feel consistent.
 */
'use client';

import { useEffect, useRef } from 'react';
import { X, MapPin, ExternalLink, Clock, Activity, User } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import type { MovementCard } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

interface Props {
  movement: MovementCard;
  asset:    { name: string; color: string; unit?: string };
  onClose:  () => void;
}

const SOURCE_LABEL: Record<number, string> = {
  1: 'gateway',
  2: 'edited in Motive',
  3: 'unidentified driver',
};

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

function fmtDuration(min: number | null): string {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function MovementDetailPanel({ movement, asset, onClose }: Props) {
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const { calendarTimezone } = useCalendarStore();

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const hasOrigin = movement.originLat != null && movement.originLon != null;
  const hasDest   = movement.destinationLat != null && movement.destinationLon != null;
  const hasRoute  = hasOrigin && hasDest;

  // Render map + route polyline. When either endpoint is missing, drop
  // a single marker on whichever we have.
  useEffect(() => {
    if (!mapContainer.current) return;
    if (!hasOrigin && !hasDest) return;

    let cancelled = false;
    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;

      const origin = hasOrigin
        ? { lat: movement.originLat as number, lng: movement.originLon as number }
        : null;
      const dest = hasDest
        ? { lat: movement.destinationLat as number, lng: movement.destinationLon as number }
        : null;

      const center = origin ?? dest!;
      const map = new google.maps.Map(mapContainer.current, {
        center, zoom: 10, mapId: MAP_ID,
        disableDefaultUI: false, clickableIcons: false,
        gestureHandling: 'greedy',
      });
      mapRef.current = map;

      const dot = (color: string, label: string) => {
        const el = document.createElement('div');
        el.style.cssText = `position:relative;width:18px;height:18px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);`;
        const tag = document.createElement('div');
        tag.style.cssText = 'position:absolute;top:-22px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:700;color:#111;background:rgba(255,255,255,0.95);padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.15);';
        tag.textContent = label;
        el.appendChild(tag);
        return el;
      };

      if (origin) {
        new google.maps.marker.AdvancedMarkerElement({
          map, position: origin, content: dot('#16a34a', 'Start'),
        });
      }
      if (dest) {
        new google.maps.marker.AdvancedMarkerElement({
          map, position: dest, content: dot('#dc2626', 'End'),
        });
      }

      if (origin && dest) {
        new google.maps.Polyline({
          path: [origin, dest],
          map,
          strokeColor: asset.color,
          strokeOpacity: 0.85,
          strokeWeight: 3.5,
          geodesic: true,
        });
        const bounds = new google.maps.LatLngBounds();
        bounds.extend(origin); bounds.extend(dest);
        map.fitBounds(bounds, 60);
      }
    });

    return () => { cancelled = true; mapRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceLabel = movement.source != null ? SOURCE_LABEL[movement.source] ?? `source ${movement.source}` : null;
  const inProgress  = movement.status === 'in_progress' || movement.endTime == null;

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
              {inProgress && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1"
                  style={{ background: '#16a34a', color: 'white' }}>
                  Live
                </span>
              )}
            </div>
            <div className="text-[12px] truncate mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {movement.origin ?? '—'}
              {movement.origin && movement.destination ? ' → ' : ' '}
              {movement.destination ?? ''}
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

        {/* Body — map on top, metadata below */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Map */}
          <div className="relative" style={{ height: 380 }}>
            {hasOrigin || hasDest ? (
              <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
            ) : (
              <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)' }}>
                No coordinates reported for this period
              </div>
            )}

            {hasRoute && (
              <a
                href={`https://www.google.com/maps/dir/?api=1&origin=${movement.originLat},${movement.originLon}&destination=${movement.destinationLat},${movement.destinationLon}`}
                target="_blank" rel="noopener noreferrer"
                className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-1"
                style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)', color: 'var(--gc-blue)', textDecoration: 'none' }}
              >
                <ExternalLink size={10} /> Open in Maps
              </a>
            )}
          </div>

          {/* Metadata grid */}
          <div className="flex-1 px-4 py-3 overflow-y-auto" style={{ background: 'var(--gc-bg)', borderTop: '1px solid var(--gc-border-light)' }}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
              <Field icon={<Clock size={12} />} label="Started">
                {fmtTime(movement.startTime, calendarTimezone)}
              </Field>
              <Field icon={<Clock size={12} />} label="Ended">
                {inProgress ? <span style={{ color: '#16a34a' }}>still in progress</span> : fmtTime(movement.endTime, calendarTimezone)}
              </Field>
              <Field icon={<Activity size={12} />} label="Distance">
                {movement.miles != null ? `${movement.miles.toFixed(1)} mi` : '—'}
              </Field>
              <Field icon={<Clock size={12} />} label="Duration">
                {fmtDuration(movement.durationMin)}
              </Field>
              <Field icon={<MapPin size={12} />} label="Origin">
                {movement.origin ?? '—'}
              </Field>
              <Field icon={<MapPin size={12} />} label="Destination">
                {movement.destination ?? '—'}
              </Field>
              {movement.type && (
                <Field icon={<Activity size={12} />} label="Type">
                  {movement.type}
                </Field>
              )}
              {movement.status && (
                <Field icon={<Activity size={12} />} label="Status">
                  {movement.status.replace(/_/g, ' ')}
                </Field>
              )}
              {sourceLabel && (
                <Field icon={<User size={12} />} label="Source">
                  {sourceLabel}
                </Field>
              )}
            </div>

            <div className="mt-3 pt-3 text-[10px] font-mono" style={{ color: 'var(--gc-text-3)', borderTop: '1px solid var(--gc-border-light)' }}>
              Motive driving_period #{movement.id} · vehicle {movement.vehicleNumber ?? movement.vehicleId}
            </div>
          </div>
        </div>
      </div>
    </div>
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
