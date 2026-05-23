'use client';

/**
 * TrailerFleetMapPanel — fleet-wide trailer map + sidebar.
 *
 * Opened via the Container icon in CalendarToolbar. Shows:
 *   - Left: Google Map with one pin per Motive-linked trailer that
 *     has a current_location. Blue pin = in use right now; gray pin
 *     = idle.
 *   - Right: sectioned list of all trailers:
 *       Active (in use right now)  — pulled from getTrailerUsage()
 *       Idle (no current load)
 *       No GPS (trailers without motiveVehicleId)
 *     Each row shows trailer name, number, category. In-use rows
 *     also show the linked load's driver, route, status.
 *
 * Click a sidebar row → pans the map to its pin. Click a pin → marks
 * the corresponding sidebar row.
 *
 * Polls /api/motive/trailer-locations every 60s while open. Closes on
 * Escape or click outside.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, MapPin, Container, AlertCircle, Loader2 } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { useCalendarStore } from '@/store/useCalendarStore';
import { getTrailerUsage, type TrailerUsage } from '@/lib/trailerUsage';
import type { MotiveTrailerLocation } from '@/app/api/motive/trailer-locations/route';
import type { Trailer, CalendarEvent } from '@/lib/types';

interface Props {
  onClose: () => void;
}

const STATUS_PIN_COLOR = {
  in_use: '#1a73e8',  // blue
  idle:   '#9ca3af',  // gray
} as const;

const POLL_MS = 60_000;

/** Build a colored circle marker (HTMLElement) for the map. */
function makePinElement(color: string): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;width:20px;height:20px;cursor:pointer;';
  const dot = document.createElement('div');
  dot.style.cssText = `
    position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    width:16px;height:16px;border-radius:50%;
    background:${color};border:2.5px solid white;
    box-shadow:0 1px 6px rgba(0,0,0,0.35);
  `;
  wrapper.appendChild(dot);
  return wrapper;
}

export default function TrailerFleetMapPanel({ onClose }: Props) {
  const { trailers, events, drivers, assets, calendarTimezone } = useCalendarStore();
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const markersRef   = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());

  const [locations,  setLocations]  = useState<Record<string, MotiveTrailerLocation>>({});
  const [locLoading, setLocLoading] = useState(false);
  const [locError,   setLocError]   = useState<string | null>(null);
  const [selectedTrailerId, setSelectedTrailerId] = useState<number | null>(null);

  // ── ESC closes ────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // ── Poll trailer locations ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const fetchLocs = async () => {
      setLocLoading(true);
      try {
        const res = await fetch('/api/motive/trailer-locations');
        if (!res.ok) {
          setLocError(`Motive returned ${res.status}`);
          return;
        }
        const json = await res.json() as { locations?: MotiveTrailerLocation[]; error?: string };
        if (cancelled) return;
        const map: Record<string, MotiveTrailerLocation> = {};
        for (const loc of json.locations ?? []) map[loc.trailerId] = loc;
        setLocations(map);
        setLocError(null);
      } catch (e) {
        if (!cancelled) setLocError(e instanceof Error ? e.message : 'Failed to fetch');
      } finally {
        if (!cancelled) setLocLoading(false);
      }
    };
    void fetchLocs();
    const id = setInterval(fetchLocs, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Compute usage + grouping ──────────────────────────────────────────
  // Group every trailer into Active / Idle / No GPS. Active is shown
  // first because that's what the dispatcher cares about most.
  const groups = useMemo(() => {
    const active: Array<{ trailer: Trailer; usage: TrailerUsage; loc: MotiveTrailerLocation }> = [];
    const idle:   Array<{ trailer: Trailer; usage: TrailerUsage; loc: MotiveTrailerLocation }> = [];
    const noGps:  Array<{ trailer: Trailer; usage: TrailerUsage }>                              = [];

    for (const t of trailers) {
      // Skip retired trailers from the fleet view — they're history.
      if (t.activeTo) continue;
      const usage = getTrailerUsage(t.id, events, calendarTimezone);
      const loc = t.motiveVehicleId ? locations[t.motiveVehicleId] : undefined;
      if (!loc) {
        noGps.push({ trailer: t, usage });
        continue;
      }
      (usage.status === 'in_use' ? active : idle).push({ trailer: t, usage, loc });
    }
    return { active, idle, noGps };
  }, [trailers, events, locations, calendarTimezone]);

  // ── Initialize map + plot pins ────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current) return;
    let cancelled = false;

    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;

      // Center on the spread of all pins; fall back to continental US.
      const allPinned = [...groups.active, ...groups.idle];
      const initialCenter = allPinned.length > 0
        ? { lat: allPinned[0].loc.lat, lng: allPinned[0].loc.lon }
        : { lat: 39.5, lng: -98.35 };

      const map = new google.maps.Map(mapContainer.current, {
        center: initialCenter,
        zoom: allPinned.length > 0 ? 8 : 4,
        mapId: MAP_ID,
        disableDefaultUI: false,
        clickableIcons: false,
        gestureHandling: 'greedy',
      });
      mapRef.current = map;

      // Plot pins
      const bounds = new google.maps.LatLngBounds();
      for (const entry of allPinned) {
        const color = STATUS_PIN_COLOR[entry.usage.status];
        const marker = new google.maps.marker.AdvancedMarkerElement({
          map,
          position: { lat: entry.loc.lat, lng: entry.loc.lon },
          content: makePinElement(color),
          title: entry.trailer.name,
        });
        marker.addListener('click', () => setSelectedTrailerId(entry.trailer.id));
        markersRef.current.set(String(entry.trailer.id), marker);
        bounds.extend({ lat: entry.loc.lat, lng: entry.loc.lon });
      }
      if (allPinned.length > 1) map.fitBounds(bounds, 60);
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach(m => { m.map = null; });
      markersRef.current.clear();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.active.length, groups.idle.length]);

  // ── Pan to selected trailer's pin ─────────────────────────────────────
  useEffect(() => {
    if (selectedTrailerId == null || !mapRef.current) return;
    const marker = markersRef.current.get(String(selectedTrailerId));
    if (!marker?.position) return;
    const pos = marker.position as google.maps.LatLngLiteral;
    mapRef.current.panTo(pos);
    mapRef.current.setZoom(Math.max(mapRef.current.getZoom() ?? 8, 11));
  }, [selectedTrailerId]);

  // ── Sidebar row helpers ───────────────────────────────────────────────
  function driverName(load: CalendarEvent | undefined): string | undefined {
    if (!load) return undefined;
    if (load.driverName) return load.driverName;
    if (load.driverId) {
      const d = drivers.find(x => x.id === load.driverId);
      return d?.name;
    }
    return undefined;
  }
  function assetName(load: CalendarEvent | undefined): string | undefined {
    if (!load) return undefined;
    const a = assets.find(x => x.id === load.assetId);
    return a?.name;
  }

  // ── Render ────────────────────────────────────────────────────────────
  const totalCount  = groups.active.length + groups.idle.length + groups.noGps.length;
  const activeCount = groups.active.length;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden"
        style={{ width: 980, height: 720, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <Container size={18} style={{ color: 'var(--gc-blue)' }} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Trailer fleet
            </div>
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {totalCount} trailers · {activeCount} in use · {groups.noGps.length} without GPS
              {locLoading && <span className="ml-2"><Loader2 size={10} className="inline animate-spin" /></span>}
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

        {/* Body: map + sidebar */}
        <div className="flex-1 flex min-h-0">
          {/* Map */}
          <div className="relative" style={{ width: 620 }}>
            <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
            {locError && (
              <div className="absolute top-3 left-3 right-3 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'rgba(217,48,37,0.1)', border: '1px solid rgba(217,48,37,0.35)', color: '#d93025' }}>
                <AlertCircle size={12} className="inline mr-1" /> {locError}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="flex-1 overflow-auto" style={{ borderLeft: '1px solid var(--gc-border)' }}>
            <Section
              label="Active"
              count={groups.active.length}
              statusColor={STATUS_PIN_COLOR.in_use}
              rows={groups.active.map(({ trailer, usage }) => ({
                trailer,
                badge: 'In use',
                badgeColor: STATUS_PIN_COLOR.in_use,
                detail: {
                  driver: driverName(usage.load),
                  asset:  assetName(usage.load),
                  route:  routeLabel(usage.load),
                  status: usage.load?.status,
                },
              }))}
              selectedId={selectedTrailerId}
              onSelect={setSelectedTrailerId}
            />
            <Section
              label="Idle"
              count={groups.idle.length}
              statusColor={STATUS_PIN_COLOR.idle}
              rows={groups.idle.map(({ trailer }) => ({ trailer, badge: 'Idle', badgeColor: STATUS_PIN_COLOR.idle }))}
              selectedId={selectedTrailerId}
              onSelect={setSelectedTrailerId}
            />
            <Section
              label="No GPS"
              count={groups.noGps.length}
              statusColor="var(--gc-border)"
              rows={groups.noGps.map(({ trailer, usage }) => ({
                trailer,
                badge: usage.status === 'in_use' ? 'In use (no GPS)' : 'Idle',
                badgeColor: usage.status === 'in_use' ? STATUS_PIN_COLOR.in_use : 'var(--gc-text-3)',
                detail: usage.status === 'in_use' ? {
                  driver: driverName(usage.load),
                  asset:  assetName(usage.load),
                  route:  routeLabel(usage.load),
                  status: usage.load?.status,
                } : undefined,
              }))}
              selectedId={selectedTrailerId}
              onSelect={setSelectedTrailerId}
              dim
            />
            {totalCount === 0 && (
              <div className="px-4 py-8 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                No active trailers in the fleet yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function routeLabel(load: CalendarEvent | undefined): string | undefined {
  if (!load) return undefined;
  const pickup   = load.stops?.find(s => s.type === 'pickup');
  const delivery = load.stops?.find(s => s.type === 'delivery');
  if (!pickup && !delivery) return load.title;
  const fmt = (s?: { city?: string; state?: string }) =>
    s?.city && s?.state ? `${s.city}, ${s.state}` : s?.city;
  return [fmt(pickup), fmt(delivery)].filter(Boolean).join(' → ') || load.title;
}

function Section({
  label, count, statusColor, rows, selectedId, onSelect, dim,
}: {
  label: string;
  count: number;
  statusColor: string;
  rows: Array<{
    trailer: Trailer;
    badge: string;
    badgeColor: string;
    detail?: { driver?: string; asset?: string; route?: string; status?: string };
  }>;
  selectedId: number | null;
  onSelect: (id: number) => void;
  dim?: boolean;
}) {
  if (count === 0) return null;
  return (
    <div style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
      <div className="px-4 py-2.5 flex items-center gap-2 sticky top-0"
        style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)', zIndex: 1 }}>
        <div className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
          {label}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{count}</span>
      </div>
      {rows.map(({ trailer, badge, badgeColor, detail }) => {
        const isSel = trailer.id === selectedId;
        return (
          <button
            key={trailer.id}
            onClick={() => onSelect(trailer.id)}
            className="w-full text-left px-4 py-2.5 transition-colors"
            style={{
              background: isSel ? 'var(--gc-blue-light)' : 'transparent',
              borderLeft: isSel ? `3px solid var(--gc-blue)` : '3px solid transparent',
              opacity: dim && !isSel ? 0.85 : 1,
            }}
            onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                  {trailer.name}
                  {trailer.trailerNumber && (
                    <span className="ml-1.5 font-normal" style={{ color: 'var(--gc-text-3)' }}>
                      #{trailer.trailerNumber}
                    </span>
                  )}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{trailer.category}</div>
              </div>
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0"
                style={{ color: badgeColor, background: `${badgeColor}20` }}
              >
                {badge}
              </span>
            </div>
            {detail && (detail.route || detail.driver || detail.asset) && (
              <div className="mt-1.5 pl-0 text-[11px] space-y-0.5" style={{ color: 'var(--gc-text-2)' }}>
                {detail.route && (
                  <div className="flex items-center gap-1">
                    <MapPin size={10} style={{ color: 'var(--gc-text-3)' }} />
                    <span className="truncate">{detail.route}</span>
                  </div>
                )}
                {(detail.driver || detail.asset) && (
                  <div className="truncate" style={{ color: 'var(--gc-text-3)' }}>
                    {[detail.asset, detail.driver, detail.status?.replace('_', ' ')].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
