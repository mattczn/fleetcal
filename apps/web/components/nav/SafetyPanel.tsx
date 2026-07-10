'use client';

/**
 * SafetyPanel — centered full-height overlay listing every Motive safety
 * event in the trailing 24h, all statuses. Similar shape to MapDrawer
 * (same backdrop/border-radius/close pattern) but the left column is the
 * multi-alert index (not stops), and the right pane focuses on ONE
 * selected alert with a Google Map + dashcam video + dispatcher actions.
 *
 * Data comes from a single railway.listPerformanceEventsForPanel(24) call
 * that returns events (with raw Motive payload for GPS trace + video URLs)
 * plus a motive_driving_periods sidecar for the between-load movement OD
 * lines.
 *
 * Actions (Confirm driver / Notify / Dismiss) mirror the drawer so a
 * dispatcher can act without a second click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X, MapPin, Truck, Loader2 } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { railway } from '@/lib/railway';
import type {
  PerformanceEventRow,
  PerformanceEventMovement,
  MotivePerfRaw,
} from '@fleetcal/types';
import DashcamVideo from './SafetyDashcamVideo';

type PanelEvent = PerformanceEventRow & { raw?: MotivePerfRaw; vehicle_id?: number };

interface Driver { id: number; name: string }

const WINDOW_OPTIONS: Array<{ key: '1h' | '6h' | '24h' | '72h' | '168h'; hours: number; label: string }> = [
  { key: '1h',   hours: 1,   label: 'Last 1 hour'  },
  { key: '6h',   hours: 6,   label: 'Last 6 hours' },
  { key: '24h',  hours: 24,  label: 'Last 24 hours' },
  { key: '72h',  hours: 72,  label: 'Last 3 days'  },
  { key: '168h', hours: 168, label: 'Last 7 days'  },
];

export default function SafetyPanel({ onClose }: { onClose: () => void }) {
  const [events,    setEvents]    = useState<PanelEvent[]>([]);
  const [movements, setMovements] = useState<PerformanceEventMovement[]>([]);
  const [drivers,   setDrivers]   = useState<Driver[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [typeFilter,   setTypeFilter]   = useState<string>('all');
  const [truckFilter,  setTruckFilter]  = useState<string>('all');
  const [driverFilter, setDriverFilter] = useState<string>('all');
  const [windowHours,  setWindowHours]  = useState<number>(24);

  const load = useMemo(() => async () => {
    setLoading(true); setError(null);
    try {
      const [panel, driverList] = await Promise.all([
        railway.listPerformanceEventsForPanel(windowHours),
        railway.listDrivers(),
      ]);
      setEvents(panel.events);
      setMovements(panel.movements);
      setDrivers(driverList.drivers.map(d => ({ id: d.id, name: d.name })));
      // Keep the selection if it's still in the new window; otherwise
      // jump to the newest event so the map isn't blank.
      if (panel.events.length > 0) {
        setSelectedId(prev => (prev != null && panel.events.some(e => e.id === prev)) ? prev : panel.events[0].id);
      } else {
        setSelectedId(null);
      }
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load safety events');
    }
    setLoading(false);
  }, [windowHours]);

  // Reload whenever the time window changes; truck + driver + type
  // filters are client-side over the already-loaded set.
  useEffect(() => { void load(); }, [load]);

  // Escape closes the panel — matches the drawer/EventModal convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Distinct filter options — derived off the CURRENT window's events so
  // a filter never shows a truck/driver that has nothing in scope.
  const eventTypes = useMemo(
    () => Array.from(new Set(events.map(e => e.event_type))).sort(),
    [events],
  );
  const truckOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of events) {
      const label = e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id}`;
      map.set(label, label);
    }
    return Array.from(map.keys()).sort();
  }, [events]);
  const driverOptions = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) if (e.resolved_driver_name) s.add(e.resolved_driver_name);
    return Array.from(s).sort();
  }, [events]);

  const visible = useMemo(() => events.filter(e => {
    if (typeFilter   !== 'all' && e.event_type !== typeFilter)   return false;
    if (driverFilter !== 'all' && e.resolved_driver_name !== driverFilter) return false;
    if (truckFilter  !== 'all') {
      const label = e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id}`;
      if (label !== truckFilter) return false;
    }
    return true;
  }), [events, typeFilter, driverFilter, truckFilter]);

  const selected = visible.find(e => e.id === selectedId) ?? events.find(e => e.id === selectedId) ?? null;

  // Group by asset for the left rail. Preserves recency ordering within
  // each truck bucket.
  const byTruck = useMemo(() => {
    const map = new Map<string, PanelEvent[]>();
    for (const e of visible) {
      const key = e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id}`;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [visible]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, background: 'rgba(0,0,0,0.4)',
      }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: '100%', maxWidth: 1280, height: '88vh',
        display: 'flex', borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.28)',
        background: 'var(--gc-surface)',
      }}>

        {/* ── Left rail: 24h list ── */}
        <div style={{
          width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--gc-border-light)',
        }}>
          {/* Header */}
          <div style={{
            padding: '14px 16px', borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                Safety alerts
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--gc-text-3)', marginLeft: 6 }}>
                  {visible.length}{visible.length !== events.length ? ` of ${events.length}` : ''}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void load()}
                style={{ fontSize: 11, color: 'var(--gc-text-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                Refresh
              </button>
            </div>
            {/* Time window — server-side re-fetches when changed. */}
            <FilterSelect
              value={String(windowHours)}
              onChange={v => setWindowHours(Number(v))}
              options={WINDOW_OPTIONS.map(w => ({ value: String(w.hours), label: w.label }))}
            />
            {/* Type / Truck / Driver — client-side filter over the
                already-loaded window. Options auto-derive so an empty
                dropdown never appears. */}
            <FilterSelect
              value={typeFilter}
              onChange={setTypeFilter}
              options={[
                { value: 'all', label: `All types (${events.length})` },
                ...eventTypes.map(t => ({
                  value: t,
                  label: `${eventTypeLabel(t)} (${events.filter(e => e.event_type === t).length})`,
                })),
              ]}
            />
            <FilterSelect
              value={truckFilter}
              onChange={setTruckFilter}
              options={[
                { value: 'all', label: `All trucks (${truckOptions.length})` },
                ...truckOptions.map(t => ({ value: t, label: t })),
              ]}
            />
            <FilterSelect
              value={driverFilter}
              onChange={setDriverFilter}
              options={[
                { value: 'all', label: `All drivers (${driverOptions.length})` },
                ...driverOptions.map(d => ({ value: d, label: d })),
              ]}
            />
          </div>

          {/* Grouped list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 12 }}>
                <Loader2 size={16} className="animate-spin" style={{ display: 'inline-block' }} /> Loading…
              </div>
            ) : error ? (
              <div style={{ padding: 24, color: '#dc2626', fontSize: 12 }}>{error}</div>
            ) : byTruck.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 12 }}>
                No safety events in the last 24 hours.
              </div>
            ) : byTruck.map(([truckLabel, rows]) => (
              <div key={truckLabel}>
                <div style={{
                  padding: '6px 12px 4px', fontSize: 10.5, fontWeight: 700,
                  color: 'var(--gc-text-3)', letterSpacing: 0.4, textTransform: 'uppercase',
                  background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span
                    aria-hidden
                    style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: rows[0].asset_color ?? 'var(--gc-border-light)' }}
                  />
                  {truckLabel}
                  {rows[0].asset_unit ? ` · #${rows[0].asset_unit}` : ''}
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--gc-text-3)' }}>{rows.length}</span>
                </div>
                {rows.map(e => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setSelectedId(e.id)}
                    style={{
                      display: 'flex', width: '100%', gap: 8,
                      padding: '9px 12px 9px 9px',
                      borderBottom: '1px solid var(--gc-border-light)',
                      borderLeft: `3px solid ${e.asset_color ?? 'var(--gc-border-light)'}`,
                      background: e.id === selectedId ? 'var(--gc-bg)' : 'transparent',
                      textAlign: 'left', cursor: 'pointer',
                    }}
                    onMouseEnter={ev => { if (e.id !== selectedId) ev.currentTarget.style.background = 'var(--gc-bg)'; }}
                    onMouseLeave={ev => { if (e.id !== selectedId) ev.currentTarget.style.background = 'transparent'; }}
                  >
                    <AlertTriangle size={14} style={{ color: severityColor(e.intensity), flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-1)' }}>
                        {eventTypeLabel(e.event_type)}
                        {statusChip(e.dispatch_status)}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginTop: 2 }}>
                        {e.resolved_driver_name ?? 'Unassigned'}
                        {e.resolved_load_num ? ` · Load ${e.resolved_load_num}` : ''}
                      </div>
                      {e.resolved_load_title && (
                        <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {e.resolved_load_title}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 2 }}>{relTime(e.event_time)}</div>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: map + details for selected alert ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--gc-border-light)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            {selected ? (
              <>
                <span aria-hidden style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: selected.asset_color ?? 'var(--gc-border-light)' }} />
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                  {eventTypeLabel(selected.event_type)}
                  {selected.intensity ? ` — ${selected.intensity}` : ''}
                </div>
                <div style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>
                  {selected.asset_name ?? selected.vehicle_number} · {selected.resolved_driver_name ?? 'unassigned'}
                  {selected.resolved_load_num ? ` · Load ${selected.resolved_load_num}` : ''}
                  {selected.resolved_load_title ? ` · ${selected.resolved_load_title}` : ''}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginLeft: 'auto' }}>
                  {new Date(selected.event_time).toLocaleString()}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--gc-text-3)' }}>Pick an alert to see the map and video</div>
            )}
            <button
              type="button"
              aria-label="Close panel"
              onClick={onClose}
              style={{
                width: 28, height: 28, border: 'none', background: 'transparent',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--gc-text-2)',
              }}
            >
              <X size={16} />
            </button>
          </div>

          {selected ? (
            <SafetyDetail
              event={selected}
              movements={movements}
              drivers={drivers}
              onAfterAction={() => void load()}
            />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gc-text-3)', fontSize: 13 }}>
              No alert selected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Right pane: map + video + actions ──────────────────────────────────

function SafetyDetail({
  event, movements, drivers, onAfterAction,
}: {
  event:     PanelEvent;
  movements: PerformanceEventMovement[];
  drivers:   Driver[];
  onAfterAction: () => void;
}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clearRef = useRef<(() => void) | null>(null);

  const [driverId, setDriverId] = useState<number | null>(event.resolved_driver_id ?? null);
  const [message, setMessage]   = useState('');
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    setDriverId(event.resolved_driver_id ?? null);
    setMessage('');
    setActionErr(null);
  }, [event.id, event.resolved_driver_id]);

  // Render markers/polylines whenever the selected event changes.
  useEffect(() => {
    if (!mapContainer.current) return;
    let cancelled = false;

    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;

      if (!mapRef.current) {
        mapRef.current = new google.maps.Map(mapContainer.current, {
          center: { lat: 39.8283, lng: -98.5795 },
          zoom: 4,
          mapId: MAP_ID,
          clickableIcons: false,
          gestureHandling: 'greedy',
        });
      }
      const map = mapRef.current;

      // Tear down anything the previous event drew.
      clearRef.current?.();
      const disposables: Array<{ setMap: (m: google.maps.Map | null) => void }> = [];
      const stashClear = () => { for (const d of disposables) d.setMap(null); };
      clearRef.current = stashClear;

      const bounds = new google.maps.LatLngBounds();

      // (1) GPS trace of the incident — Motive stores ~1Hz samples in
      //     m_gps_lat/m_gps_lon during the event window. Renders as a
      //     colored polyline so dispatchers see the truck's path AT
      //     the moment the alert fired (e.g. tailgating closing speed).
      const raw = event.raw ?? {};
      const trace = zip(raw.m_gps_lat ?? [], raw.m_gps_lon ?? []);
      if (trace.length >= 2) {
        const line = new google.maps.Polyline({
          path: trace.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: severityColor(event.intensity),
          strokeOpacity: 0.9,
          strokeWeight: 4,
          map,
        });
        disposables.push(line);
        trace.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      }

      // (2) Event pin at the reported lat/lon.
      if (event.lat != null && event.lon != null) {
        const el = document.createElement('div');
        el.style.cssText = `width:22px;height:22px;border-radius:50%;background:${severityColor(event.intensity)};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,.35);`;
        const marker = new google.maps.marker.AdvancedMarkerElement({
          map, position: { lat: event.lat, lng: event.lon }, content: el,
        });
        disposables.push(dummySetMap(marker));
        bounds.extend({ lat: event.lat, lng: event.lon });
      }

      // (3) Covering motive_driving_period — draw the ACTUAL driving
      //     route (Mapbox Directions) between origin → event pin →
      //     destination so the map shows real roads, not straight
      //     hypotenuse lines. Falls back to a straight polyline if the
      //     Mapbox token is missing or the routing call fails.
      const eventMs = Date.parse(event.event_time);
      const period = movements
        .filter(m => m.vehicle_id === event.vehicle_id)
        .find(m => {
          const startMs = Date.parse(m.start_time);
          const endMs = m.end_time ? Date.parse(m.end_time) : Date.now();
          return startMs <= eventMs && eventMs <= endMs;
        });
      if (
        period?.origin_lat != null && period.origin_lon != null &&
        period?.destination_lat != null && period.destination_lon != null
      ) {
        const waypoints: Array<{ lat: number; lng: number }> = [
          { lat: period.origin_lat, lng: period.origin_lon },
        ];
        // Route THROUGH the event pin when we have one — that way the
        // rendered path visibly threads the incident location and the
        // dispatcher can tell "yes, the safety event happened along the
        // truck's actual road path".
        if (event.lat != null && event.lon != null) {
          waypoints.push({ lat: event.lat, lng: event.lon });
        }
        waypoints.push({ lat: period.destination_lat, lng: period.destination_lon });

        // Kick off the Mapbox fetch — the straight line is drawn first
        // so the map has SOMETHING while the async call is in-flight,
        // then swapped for the road-following polyline when it resolves.
        const straight = new google.maps.Polyline({
          path: waypoints,
          strokeColor: '#64748b',
          strokeOpacity: 0.35,
          strokeWeight: 2,
          icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 2 }, offset: '0', repeat: '10px' }],
          map,
        });
        disposables.push(straight);

        void fetchRouteGeometry(waypoints).then(path => {
          if (!path || cancelled || mapRef.current !== map) return;
          straight.setMap(null);
          const route = new google.maps.Polyline({
            path,
            strokeColor: '#475569',
            strokeOpacity: 0.85,
            strokeWeight: 3,
            map,
          });
          disposables.push(route);
          for (const p of path) bounds.extend(p);
          // Refit so the road path is fully visible — the straight
          // line's bounds were a subset so we don't lose the event pin.
          map.fitBounds(bounds, 80);
        });

        bounds.extend({ lat: period.origin_lat,      lng: period.origin_lon });
        bounds.extend({ lat: period.destination_lat, lng: period.destination_lon });
      }

      // Fit — small viewport → the polyline dominates; single point →
      // pan+zoom to make context readable.
      const hasPolyline = trace.length >= 2 || !!period;
      if (hasPolyline) {
        map.fitBounds(bounds, 80);
      } else if (event.lat != null && event.lon != null) {
        map.setCenter({ lat: event.lat, lng: event.lon });
        map.setZoom(14);
      }
    });

    return () => {
      cancelled = true;
      clearRef.current?.();
    };
  }, [event, movements]);

  async function handleNotify() {
    if (!driverId) return;
    setBusy(true); setActionErr(null);
    try {
      await railway.notifyPerformanceEventDriver(event.id, { driverId, message: message.trim() || undefined });
      onAfterAction();
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setBusy(false);
  }

  async function handleDismiss() {
    setBusy(true); setActionErr(null);
    try {
      await railway.updatePerformanceEvent(event.id, { dispatch_status: 'dismissed' });
      onAfterAction();
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setBusy(false);
  }

  async function handleConfirm() {
    if (!driverId) return;
    setBusy(true); setActionErr(null);
    try {
      await railway.updatePerformanceEvent(event.id, {
        dispatch_status:    'confirmed',
        assigned_driver_id: driverId,
      });
      onAfterAction();
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* Map fills the pane; the details column stacks context + video +
          actions on the right. */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      </div>

      <div style={{
        width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '1px solid var(--gc-border-light)', overflow: 'hidden',
      }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>

          <DetailBlock label="Context">
            <div style={{ fontSize: 12.5, color: 'var(--gc-text-1)', lineHeight: 1.5 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Truck size={12} style={{ color: 'var(--gc-text-3)' }} />
                {event.asset_name ?? event.vehicle_number}
                {event.asset_unit ? <span style={{ color: 'var(--gc-text-3)' }}>#{event.asset_unit}</span> : null}
              </div>
              {event.location_label && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--gc-text-2)', marginTop: 4 }}>
                  <MapPin size={12} style={{ color: 'var(--gc-text-3)' }} />
                  {event.location_label}
                </div>
              )}
              {event.raw?.max_speed != null && (
                <div style={{ color: 'var(--gc-text-2)', marginTop: 4 }}>
                  Peak {event.raw.max_speed.toFixed(1)} mph
                  {event.raw.event_intensity ? ` · ${event.raw.event_intensity.name} ${event.raw.event_intensity.value}${event.raw.event_intensity.unit_type}` : ''}
                </div>
              )}
            </div>
          </DetailBlock>

          <DashcamVideo raw={event.raw} />

          <DetailBlock label="Confirm driver">
            {event.resolved_driver_name && (
              <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginBottom: 6 }}>
                Autofilled from the calendar: <b>{event.resolved_driver_name}</b>
                {event.resolved_load_num ? ` (load ${event.resolved_load_num})` : ''}.
              </div>
            )}
            <select
              value={driverId ?? ''}
              onChange={e => setDriverId(e.target.value ? Number(e.target.value) : null)}
              style={{
                width: '100%', padding: '7px 9px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
                color: 'var(--gc-text-1)',
              }}
            >
              <option value="">Select a driver…</option>
              {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </DetailBlock>

          <DetailBlock label="Message (optional)">
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Custom note. Leave blank to send the default safety alert."
              rows={3}
              style={{
                width: '100%', padding: '7px 9px', fontSize: 12.5, borderRadius: 6,
                border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
                color: 'var(--gc-text-1)', resize: 'vertical',
              }}
            />
          </DetailBlock>

          {actionErr && <div style={{ fontSize: 12, color: '#dc2626' }}>{actionErr}</div>}
        </div>

        {/* Sticky action bar — always visible so a dispatcher scrolling
            through details can act without hunting for buttons. */}
        <div style={{
          padding: 12, borderTop: '1px solid var(--gc-border-light)',
          display: 'flex', gap: 8, flexShrink: 0, background: 'var(--gc-surface)',
        }}>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={busy || event.dispatch_status === 'dismissed'}
            style={{
              flex: 1, padding: '9px 10px', borderRadius: 6,
              border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)',
              color: 'var(--gc-text-1)', fontSize: 12.5,
              cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || !driverId || event.dispatch_status === 'confirmed'}
            style={{
              flex: 1, padding: '9px 10px', borderRadius: 6,
              border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
              color: 'var(--gc-text-1)', fontSize: 12.5,
              cursor: busy || !driverId ? 'not-allowed' : 'pointer',
              opacity: busy || !driverId ? 0.6 : 1,
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={handleNotify}
            disabled={busy || !driverId || event.dispatch_status === 'notified'}
            style={{
              flex: 1, padding: '9px 10px', borderRadius: 6,
              border: '1px solid #dc2626', background: '#dc2626',
              color: '#fff', fontSize: 12.5, fontWeight: 600,
              cursor: busy || !driverId ? 'not-allowed' : 'pointer',
              opacity: busy || !driverId ? 0.6 : 1,
            }}
          >
            {busy ? 'Sending…' : 'Notify'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Presentation helpers ───────────────────────────────────────────────

function FilterSelect({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        padding: '5px 8px', fontSize: 11.5, borderRadius: 5,
        border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
        color: 'var(--gc-text-1)',
      }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function DetailBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 5 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function statusChip(s: PerformanceEventRow['dispatch_status']): React.ReactNode {
  if (s === 'new') return null;
  const map: Record<string, { label: string; color: string }> = {
    confirmed: { label: 'confirmed', color: '#059669' },
    dismissed: { label: 'dismissed', color: '#6b7280' },
    notified:  { label: 'notified',  color: '#dc2626' },
  };
  const c = map[s];
  if (!c) return null;
  return (
    <span style={{
      marginLeft: 6, fontSize: 9.5, fontWeight: 700, color: c.color,
      textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      · {c.label}
    </span>
  );
}

function eventTypeLabel(t: string): string {
  switch (t) {
    case 'hard_accel':   return 'Hard acceleration';
    case 'hard_brake':   return 'Hard brake';
    case 'hard_corner':  return 'Hard cornering';
    case 'tailgating':   return 'Tailgating';
    case 'cell_phone':   return 'Phone use';
    case 'distraction':  return 'Distraction';
    case 'drowsiness':   return 'Drowsiness';
    case 'seatbelt':     return 'Seatbelt violation';
    default:             return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

function severityColor(intensity: string | null): string {
  const s = (intensity ?? '').toLowerCase();
  if (s.includes('severe') || s.includes('high')) return '#dc2626';
  if (s.includes('moderate')) return '#f59e0b';
  return '#3b82f6';
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return iso;
  const diffSec = (Date.now() - t) / 1000;
  if (diffSec < 60)   return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return 'Something went wrong.';
}

/** Mapbox Directions → path coordinates. Same call the MapDrawer makes
 *  for its truck-to-stop route line: `overview=full&geometries=geojson`
 *  returns the encoded road polyline for the driving profile. Returns
 *  null when the token is missing or the API errors — caller keeps the
 *  straight-line fallback in that case. */
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';
async function fetchRouteGeometry(
  waypoints: Array<{ lat: number; lng: number }>,
): Promise<Array<{ lat: number; lng: number }> | null> {
  if (!MAPBOX_TOKEN || waypoints.length < 2) return null;
  try {
    const coords = waypoints.slice(0, 25).map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?access_token=${MAPBOX_TOKEN}&geometries=geojson&overview=full`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const json = await res.json() as { routes?: { geometry: { coordinates: [number, number][] } }[] };
    const coordinates = json.routes?.[0]?.geometry.coordinates;
    if (!coordinates) return null;
    return coordinates.map(([lng, lat]) => ({ lat, lng }));
  } catch {
    return null;
  }
}

/** google.maps.marker.AdvancedMarkerElement doesn't expose setMap
 *  directly on the same object shape as Polyline/TrafficLayer; wrap it
 *  in a common cleanup interface so the disposables array can teardown
 *  everything uniformly. */
function dummySetMap(marker: google.maps.marker.AdvancedMarkerElement): { setMap: (m: google.maps.Map | null) => void } {
  return { setMap: (m) => { marker.map = m; } };
}

/** Turn two parallel numeric arrays into [lat, lon] tuples, dropping
 *  any positions where either side is missing. Motive returns matched
 *  lengths in practice but be defensive. */
function zip(a: number[], b: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) out.push([a[i], b[i]]);
  }
  return out;
}
