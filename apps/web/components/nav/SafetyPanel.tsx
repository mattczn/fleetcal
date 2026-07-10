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
 * Actions (Acknowledge / Notify / Ignore) mirror the drawer so a
 * dispatcher can act without a second click.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X, MapPin, Truck, Loader2, ExternalLink } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { railway } from '@/lib/railway';
import type {
  PerformanceEventRow,
  PerformanceEventMovement,
  MotivePerfRaw,
  DriverSafetyScoreRow,
} from '@fleetcal/types';
import DashcamVideo from './SafetyDashcamVideo';
import SeverityMeter, { severityColor as severityLevelColor } from './SeverityMeter';
import { fmtDenverLong, fmtDenverFull, relTimeDenver } from '@/lib/safetyTime';

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
  const router = useRouter();
  const [events,    setEvents]    = useState<PanelEvent[]>([]);
  const [movements, setMovements] = useState<PerformanceEventMovement[]>([]);
  const [drivers,   setDrivers]   = useState<Driver[]>([]);
  const [driverScores7d, setDriverScores7d] = useState<Map<number, DriverSafetyScoreRow>>(new Map());
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [typeFilter,   setTypeFilter]   = useState<string>('all');
  const [truckFilter,  setTruckFilter]  = useState<string>('all');
  const [driverFilter, setDriverFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [windowHours,  setWindowHours]  = useState<number>(24);

  const load = useMemo(() => async () => {
    setLoading(true); setError(null);
    try {
      // Three parallel calls: panel events, drivers list, and 7-day
      // driver safety scores. 7-day scores are used in the detail pane
      // to show a shorter-window health snapshot for the selected
      // event's driver. Fetched once per panel open; not re-fetched
      // when the window filter changes because it's always 7d.
      const [panel, driverList, safety7d] = await Promise.all([
        railway.listPerformanceEventsForPanel(windowHours),
        railway.listDrivers(),
        railway.getDriverSafetyScoring(7).catch(err => {
          console.warn('[SafetyPanel] 7d scores failed:', err);
          return null;
        }),
      ]);
      setEvents(panel.events);
      setMovements(panel.movements);
      setDrivers(driverList.drivers.map(d => ({ id: d.id, name: d.name })));
      if (safety7d) {
        setDriverScores7d(new Map(safety7d.drivers.map(r => [r.driverId, r])));
      }
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
    if (statusFilter !== 'all') {
      // The 'disputed' status is orthogonal to dispatch_status — it
      // means dispute_status='pending' regardless of what dispatch
      // did with the alert.
      if (statusFilter === 'disputed') {
        if (e.dispute_status !== 'pending') return false;
      } else if (e.dispatch_status !== statusFilter) {
        return false;
      }
    }
    if (truckFilter  !== 'all') {
      const label = e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id}`;
      if (label !== truckFilter) return false;
    }
    return true;
  }), [events, typeFilter, driverFilter, statusFilter, truckFilter]);

  const selected = visible.find(e => e.id === selectedId) ?? events.find(e => e.id === selectedId) ?? null;

  // ── Above-fleet-avg severe events in the past 24h ──────────────────
  //
  // Compare each driver's severe count in the trailing 24h against the
  // fleet mean (severe events / drivers who had any events at all).
  // Flag when the driver is above the mean AND has at least 2 severe
  // events — noise-immunity against a one-shot bad brake. Whole-panel
  // computation from already-loaded events (no extra fetch).
  const severeFlags = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const perDriver = new Map<number, { name: string | null; total: number; severe: number }>();
    for (const e of events) {
      if (Date.parse(e.event_time) < cutoff) continue;
      const driverId = e.resolved_driver_id ?? e.assigned_driver_id ?? null;
      if (driverId == null) continue;
      const acc = perDriver.get(driverId) ?? { name: e.resolved_driver_name, total: 0, severe: 0 };
      acc.name = acc.name ?? e.resolved_driver_name;
      acc.total++;
      if (e.severity_level === 'severe') acc.severe++;
      perDriver.set(driverId, acc);
    }
    if (perDriver.size === 0) return { fleetAvgSevere: 0, flagged: [] as Array<{ driverId: number; name: string | null; severe: number }> };
    const totalSevere = Array.from(perDriver.values()).reduce((s, v) => s + v.severe, 0);
    const fleetAvgSevere = totalSevere / perDriver.size;
    const flagged: Array<{ driverId: number; name: string | null; severe: number }> = [];
    for (const [driverId, v] of perDriver) {
      if (v.severe >= 2 && v.severe > fleetAvgSevere) {
        flagged.push({ driverId, name: v.name, severe: v.severe });
      }
    }
    flagged.sort((a, b) => b.severe - a.severe);
    return { fleetAvgSevere: Math.round(fleetAvgSevere * 10) / 10, flagged };
  }, [events]);
  const flaggedDriverIds = useMemo(
    () => new Set(severeFlags.flagged.map(f => f.driverId)),
    [severeFlags],
  );

  // Flat chronological list — server already returns events by
  // event_time DESC. Truck identity still reads at a glance via the
  // color accent bar + truck name printed on each row.

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
            {/* Deep-link to the drivers scorecard so a dispatcher can
                jump from panel triage to the fleet-wide overview. */}
            <button
              type="button"
              onClick={() => { onClose(); router.push('/drivers'); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, color: 'var(--gc-blue, #1a73e8)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                padding: 0, alignSelf: 'flex-start',
              }}
            >
              View driver scorecards <ExternalLink size={11} />
            </button>
            {/* Above-fleet-avg severe banner — appears when at least
                one driver had ≥2 severe events in the last 24h AND was
                above the fleet mean. Tooltip shows the raw numbers. */}
            {severeFlags.flagged.length > 0 && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: '#fef2f2',
                  border: '1px solid #fecaca',
                  color: '#991b1b',
                  fontSize: 11.5,
                  lineHeight: 1.4,
                }}
                title={`Fleet average: ${severeFlags.fleetAvgSevere} severe events per driver in the last 24h.`}
              >
                <div style={{ fontWeight: 700, marginBottom: 2 }}>
                  ⚠ {severeFlags.flagged.length} driver{severeFlags.flagged.length === 1 ? '' : 's'} above fleet avg (24h)
                </div>
                <div>
                  {severeFlags.flagged.slice(0, 4).map(f => (
                    <span key={f.driverId}>
                      {f.name ?? `Driver ${f.driverId}`} ({f.severe})
                      {' · '}
                    </span>
                  ))}
                  {severeFlags.flagged.length > 4 && `+${severeFlags.flagged.length - 4} more`}
                </div>
              </div>
            )}
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
            {/* Dispatch status — picking "Notified" gives a running
                record of every safety-alert push we sent in the window.
                Counts derive from the current event set so an empty
                bucket makes it obvious we sent zero of X. */}
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'all',       label: `Any status (${events.length})` },
                { value: 'new',       label: `New (${events.filter(e => e.dispatch_status === 'new').length})` },
                { value: 'confirmed', label: `Acknowledged (${events.filter(e => e.dispatch_status === 'confirmed').length})` },
                { value: 'notified',  label: `Driver notified (${events.filter(e => e.dispatch_status === 'notified').length})` },
                { value: 'dismissed', label: `Ignored (${events.filter(e => e.dispatch_status === 'dismissed').length})` },
                { value: 'disputed',  label: `Disputed — pending (${events.filter(e => e.dispute_status === 'pending').length})` },
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
            ) : visible.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--gc-text-3)', fontSize: 12 }}>
                No safety events in this window.
              </div>
            ) : visible.map(e => {
              const truck = e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id}`;
              return (
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {/* Row 1: event type + status chip + time (right-aligned) */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-1)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {eventTypeLabel(e.event_type)}
                        {statusChip(e.dispatch_status)}
                        {disputeChip(e.dispute_status)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginLeft: 'auto', flexShrink: 0 }}>
                        {relTimeDenver(e.event_time)}
                      </div>
                    </div>
                    {/* Row 2: truck (with color dot) + driver + 24h severe flag */}
                    <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {truck}
                      {e.resolved_driver_name ? ` · ${e.resolved_driver_name}` : ' · unassigned'}
                      {(() => {
                        const drvId = e.resolved_driver_id ?? e.assigned_driver_id;
                        if (drvId == null || !flaggedDriverIds.has(drvId)) return null;
                        return (
                          <span
                            title="This driver is above the fleet average for severe events in the last 24h"
                            style={{
                              marginLeft: 6, padding: '1px 5px', borderRadius: 3,
                              background: '#fef2f2', color: '#991b1b',
                              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
                            }}
                          >
                            ⚠ 24H
                          </span>
                        );
                      })()}
                    </div>
                    {/* Row 3: load if present */}
                    {(e.resolved_load_num || e.resolved_load_title) && (
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {e.resolved_load_num ? `Load ${e.resolved_load_num}` : ''}
                        {e.resolved_load_num && e.resolved_load_title ? ' · ' : ''}
                        {e.resolved_load_title ?? ''}
                      </div>
                    )}
                  </div>
                  {/* Severity icon on the RIGHT so it doesn't collide
                      with the truck color bar on the left — the two
                      signals stay visually distinct. */}
                  <AlertTriangle
                    size={18}
                    style={{
                      color: severityLevelColor(e.severity_level),
                      flexShrink: 0,
                      alignSelf: 'center',
                      marginLeft: 6,
                    }}
                  />
                </button>
              );
            })}
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
                  {fmtDenverLong(selected.event_time)}
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
              driverScores7d={driverScores7d}
              onOpenScorecard={() => { onClose(); router.push('/drivers'); }}
              onEventUpdated={(updated) => {
                // Splice the server's fresh row (already enriched) into
                // our events array — no full re-fetch. Same row, same
                // position in the list, only status/driver/notified_*
                // fields change.
                setEvents(prev => prev.map(e => e.id === updated.id ? { ...e, ...updated } : e));
              }}
              onRawRefreshed={(eventId, raw) => {
                // Persist the refreshed raw payload onto the panel's
                // events array so clicking away and back keeps the
                // video visible without hitting Motive again.
                setEvents(prev => prev.map(e => e.id === eventId ? { ...e, raw } : e));
              }}
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
  event, movements, drivers, driverScores7d, onOpenScorecard, onEventUpdated, onRawRefreshed,
}: {
  event:     PanelEvent;
  movements: PerformanceEventMovement[];
  drivers:   Driver[];
  /** 7-day safety scores keyed by fleetcal driver id. Used to show
   *  the selected event's driver's short-window health snapshot. */
  driverScores7d: Map<number, DriverSafetyScoreRow>;
  /** Called with the freshly-enriched row after any mutation. Parent
   *  splices it into its events array — no full re-fetch. */
  onEventUpdated: (updated: PerformanceEventRow) => void;
  onRawRefreshed: (eventId: number, raw: MotivePerfRaw | undefined) => void;
  /** Fires when the dispatcher clicks the "See full scorecard" link
   *  next to the 7-day score. Panel navigates to /drivers. */
  onOpenScorecard: () => void;
}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const clearRef = useRef<(() => void) | null>(null);

  const [driverId, setDriverId] = useState<number | null>(event.assigned_driver_id ?? event.resolved_driver_id ?? null);
  const [message, setMessage]   = useState('');
  const [busy, setBusy] = useState(false);
  const [savingDriver, setSavingDriver] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  useEffect(() => {
    // Prefer the dispatcher's saved assignment when present — that's
    // the "corrected" value. Falls back to the calendar autofill on
    // events the dispatcher hasn't touched yet.
    setDriverId(event.assigned_driver_id ?? event.resolved_driver_id ?? null);
    setMessage('');
    setActionErr(null);
    setSavingDriver(false);
  }, [event.id, event.assigned_driver_id, event.resolved_driver_id]);

  // Persist a driver reassignment as soon as the dispatcher picks a
  // new person from the dropdown — even without pressing Notify. That
  // way the corrected assignment shows on the row for the next viewer,
  // and if Notify happens later it goes to whoever is currently saved.
  async function persistDriver(next: number | null) {
    if (next === (event.assigned_driver_id ?? null)) return;
    setSavingDriver(true); setActionErr(null);
    try {
      const res = await railway.updatePerformanceEvent(event.id, { assigned_driver_id: next });
      onEventUpdated(res.event);
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setSavingDriver(false);
  }

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

      // All route lines get colored by the ASSET (truck), not by
      // severity — that way the map's line color matches the popover's
      // left accent bar for the same truck. Severity still comes through
      // via the event pin's fill color below.
      const routeColor = event.asset_color ?? '#475569';

      // (1) GPS trace of the incident — Motive stores ~1Hz samples in
      //     m_gps_lat/m_gps_lon during the event window. Renders as a
      //     truck-colored polyline so dispatchers see the truck's path
      //     AT the moment the alert fired (e.g. tailgating closing
      //     speed).
      const raw = event.raw ?? {};
      const trace = zip(raw.m_gps_lat ?? [], raw.m_gps_lon ?? []);
      if (trace.length >= 2) {
        const line = new google.maps.Polyline({
          path: trace.map(([lat, lng]) => ({ lat, lng })),
          strokeColor: routeColor,
          strokeOpacity: 0.95,
          strokeWeight: 5,
          map,
        });
        disposables.push(line);
        trace.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      }

      // (2) Event pin at the reported lat/lon.
      if (event.lat != null && event.lon != null) {
        const el = document.createElement('div');
        el.style.cssText = `width:22px;height:22px;border-radius:50%;background:${severityLevelColor(event.severity_level)};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,.35);`;
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
        // Both variants use the truck color so a dispatcher can tell at
        // a glance which alerts on the panel belong to the same truck.
        const straight = new google.maps.Polyline({
          path: waypoints,
          strokeColor: routeColor,
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
            strokeColor: routeColor,
            strokeOpacity: 0.85,
            strokeWeight: 4,
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
      const res = await railway.notifyPerformanceEventDriver(event.id, { driverId, message: message.trim() || undefined });
      // notify-driver returns { event, warning? } — event is null only
      // when the DB update failed AFTER the push already fired. Splice
      // whatever came back.
      if (res.event) onEventUpdated(res.event);
      // Clear the message field so the next event doesn't inherit it.
      setMessage('');
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setBusy(false);
  }

  async function handleDismiss() {
    setBusy(true); setActionErr(null);
    try {
      const res = await railway.updatePerformanceEvent(event.id, { dispatch_status: 'dismissed' });
      onEventUpdated(res.event);
    } catch (err) {
      setActionErr(errorMessage(err));
    }
    setBusy(false);
  }

  async function handleConfirm() {
    if (!driverId) return;
    setBusy(true); setActionErr(null);
    try {
      const res = await railway.updatePerformanceEvent(event.id, {
        dispatch_status:    'confirmed',
        assigned_driver_id: driverId,
      });
      onEventUpdated(res.event);
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
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <SeverityMeter event={event} />
              </div>
            </div>
          </DetailBlock>

          {/* Driver-filed dispute — surfaces the driver's reason plus
              Accept / Reject actions when the dispute is pending. If the
              dispute is already resolved, we render the outcome as an
              audit record. */}
          {event.dispute_status !== 'none' && (
            <DisputeReviewBlock event={event} onEventUpdated={onEventUpdated} />
          )}

          {/* Driver 7-day safety score — shorter-window health check
              alongside the 30-day score on the drivers page. Only
              renders when we have a resolved driver AND a 7d score. */}
          <DriverScore7dBlock
            event={event}
            driverScores7d={driverScores7d}
            onOpenScorecard={onOpenScorecard}
          />

          {/* Delivery record — only rendered when a push actually went
              out. Gives the dispatcher an audit trail without opening a
              separate log. */}
          {event.notified_at && (
            <DetailBlock label="Notification sent">
              <div style={{ fontSize: 12, color: 'var(--gc-text-1)', lineHeight: 1.55 }}>
                <div style={{ color: 'var(--gc-text-2)' }}>
                  {fmtDenverFull(event.notified_at)}
                  {event.notified_driver_name ? ` · sent to ${event.notified_driver_name}` : ''}
                </div>
                {event.notified_message && (
                  <div style={{ marginTop: 6, padding: 8, borderRadius: 6, background: 'var(--gc-bg)', color: 'var(--gc-text-1)', whiteSpace: 'pre-wrap' }}>
                    {event.notified_message}
                  </div>
                )}
              </div>
            </DetailBlock>
          )}

          <DashcamVideo
            eventId={event.id}
            raw={event.raw}
            onRefreshed={r => onRawRefreshed(event.id, r)}
          />

          <DetailBlock label="Confirm driver">
            {event.resolved_driver_name && !event.assigned_driver_id && (
              <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginBottom: 6 }}>
                Autofilled from the calendar: <b>{event.resolved_driver_name}</b>
                {event.resolved_load_num ? ` (load ${event.resolved_load_num})` : ''}. Change below if the system was wrong.
              </div>
            )}
            {event.assigned_driver_id != null && event.assigned_driver_id !== event.resolved_driver_id && (
              <div style={{ fontSize: 11.5, color: 'var(--gc-text-2)', marginBottom: 6 }}>
                Manually corrected — this alert is now assigned to the driver below.
              </div>
            )}
            <select
              value={driverId ?? ''}
              onChange={e => {
                const next = e.target.value ? Number(e.target.value) : null;
                setDriverId(next);
                // Persist on change so a correction sticks even if the
                // dispatcher never presses Notify.
                void persistDriver(next);
              }}
              disabled={savingDriver}
              style={{
                width: '100%', padding: '7px 9px', fontSize: 13, borderRadius: 6,
                border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
                color: 'var(--gc-text-1)',
                opacity: savingDriver ? 0.7 : 1,
              }}
            >
              <option value="">Select a driver…</option>
              {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {savingDriver && (
              <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 4 }}>Saving…</div>
            )}
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
            Ignore
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
            Acknowledge
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

function DisputeReviewBlock({
  event, onEventUpdated,
}: {
  event: PanelEvent;
  onEventUpdated: (updated: PerformanceEventRow) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [resolution, setResolution] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function review(status: 'accepted' | 'rejected') {
    setBusy(true); setErr(null);
    try {
      const res = await railway.updatePerformanceEvent(event.id, {
        dispute_status:     status,
        dispute_resolution: resolution.trim() || null,
      });
      onEventUpdated(res.event);
      setResolution('');
    } catch (e) {
      setErr(errorMessage(e));
    }
    setBusy(false);
  }

  const isPending = event.dispute_status === 'pending';
  const isAccepted = event.dispute_status === 'accepted';
  const label =
    isPending  ? 'Driver disputed — needs review' :
    isAccepted ? 'Dispute accepted — dropped from driver score' :
                 'Dispute rejected — event stands';
  const labelColor =
    isPending  ? '#991b1b' :
    isAccepted ? '#137333' :
                 '#b06000';

  return (
    <DetailBlock label={label}>
      <div style={{ fontSize: 12, color: 'var(--gc-text-1)', lineHeight: 1.55 }}>
        {event.dispute_reason && (
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>
              Driver's reason
            </div>
            <div style={{ padding: 8, borderRadius: 6, background: 'var(--gc-bg)', color: 'var(--gc-text-1)', whiteSpace: 'pre-wrap' }}>
              {event.dispute_reason}
            </div>
            {event.disputed_at && (
              <div style={{ color: 'var(--gc-text-3)', marginTop: 3, fontSize: 11 }}>
                Filed {fmtDenverFull(event.disputed_at)}
              </div>
            )}
          </div>
        )}

        {!isPending && event.dispute_resolution && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>
              Dispatch response
            </div>
            <div style={{ padding: 8, borderRadius: 6, background: 'var(--gc-bg)', color: 'var(--gc-text-1)', whiteSpace: 'pre-wrap' }}>
              {event.dispute_resolution}
            </div>
            {event.dispute_reviewed_at && (
              <div style={{ color: 'var(--gc-text-3)', marginTop: 3, fontSize: 11 }}>
                Reviewed {fmtDenverFull(event.dispute_reviewed_at)}
              </div>
            )}
          </div>
        )}

        {isPending && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 3 }}>
              Response (optional)
            </div>
            <textarea
              value={resolution}
              onChange={e => setResolution(e.target.value)}
              placeholder="Explain your decision so the driver has context…"
              rows={2}
              style={{
                width: '100%', padding: '7px 9px', fontSize: 12.5, borderRadius: 6,
                border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)',
                color: 'var(--gc-text-1)', resize: 'vertical',
              }}
            />
            {err && (
              <div style={{ fontSize: 11.5, color: '#dc2626', marginTop: 6 }}>{err}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                onClick={() => void review('rejected')}
                disabled={busy}
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6,
                  border: '1px solid var(--gc-border-light)',
                  background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)', fontSize: 12.5, fontWeight: 600,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                }}
              >
                Reject — event stands
              </button>
              <button
                type="button"
                onClick={() => void review('accepted')}
                disabled={busy}
                style={{
                  flex: 1, padding: '8px 10px', borderRadius: 6,
                  border: '1px solid #137333',
                  background: '#137333',
                  color: '#fff', fontSize: 12.5, fontWeight: 700,
                  cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
                }}
              >
                Accept — drop from score
              </button>
            </div>
          </div>
        )}
        {!isPending && (
          <div style={{ color: labelColor, fontSize: 11.5, marginTop: 8 }}>
            {isAccepted
              ? 'This event no longer counts against the driver\'s safety score.'
              : 'This event still counts against the driver\'s safety score.'}
          </div>
        )}
      </div>
    </DetailBlock>
  );
}

function DriverScore7dBlock({
  event, driverScores7d, onOpenScorecard,
}: {
  event: PanelEvent;
  driverScores7d: Map<number, DriverSafetyScoreRow>;
  onOpenScorecard: () => void;
}) {
  const driverId = event.resolved_driver_id ?? event.assigned_driver_id;
  if (driverId == null) return null;
  const score = driverScores7d.get(driverId);
  if (!score) return null;
  // Same score bands as the SafetyScoreCell on the drivers page.
  const color =
    score.safetyScore == null ? 'var(--gc-text-3)' :
    score.safetyScore >= 85    ? '#137333' :
    score.safetyScore >= 70    ? '#b06000' :
                                 '#c5221f';
  return (
    <DetailBlock label="Driver — last 7 days">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ textAlign: 'center', minWidth: 60 }}>
          <div className="tabular-nums" style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>
            {score.safetyScore ?? '—'}
          </div>
          <div style={{ fontSize: 9.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 3 }}>
            Safety score
          </div>
        </div>
        <div style={{ flex: 1, fontSize: 12, color: 'var(--gc-text-2)', lineHeight: 1.5 }}>
          <div className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
            <span style={{ fontWeight: 600 }}>{score.moderateEvents + score.severeEvents}</span> event
            {score.moderateEvents + score.severeEvents === 1 ? '' : 's'}
            {score.severeEvents > 0 && (
              <> · <span style={{ color: '#c5221f', fontWeight: 600 }}>{score.severeEvents} severe</span></>
            )}
          </div>
          <div className="tabular-nums" style={{ color: 'var(--gc-text-3)', marginTop: 2 }}>
            {score.milesDriven.toLocaleString()} mi
            {score.flagged && (
              <span style={{ color: '#c5221f', marginLeft: 6, fontWeight: 700 }}>· flagged</span>
            )}
          </div>
          <button
            type="button"
            onClick={onOpenScorecard}
            style={{
              marginTop: 6,
              padding: 0, border: 'none', background: 'transparent',
              color: 'var(--gc-blue, #1a73e8)',
              fontSize: 11, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}
          >
            See full scorecard <ExternalLink size={11} />
          </button>
        </div>
      </div>
    </DetailBlock>
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
    // DB values are still 'confirmed' / 'dismissed' — see notify-driver
    // route + the status enum in the migration. Only the surface labels
    // changed, so a future migration renaming the enum values is a UI
    // no-op.
    confirmed: { label: 'acknowledged', color: '#059669' },
    dismissed: { label: 'ignored',      color: '#6b7280' },
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

function disputeChip(s: PerformanceEventRow['dispute_status']): React.ReactNode {
  if (!s || s === 'none') return null;
  const map: Record<string, { label: string; color: string; bg: string }> = {
    pending:  { label: 'DISPUTED',       color: '#991b1b', bg: '#fee2e2' },
    accepted: { label: 'DISPUTE ACCEPT', color: '#137333', bg: '#e6f4ea' },
    rejected: { label: 'DISPUTE REJECT', color: '#b06000', bg: '#fef3c7' },
  };
  const c = map[s];
  if (!c) return null;
  return (
    <span
      title={
        s === 'pending' ? 'Driver disputed this alert — needs review'
        : s === 'accepted' ? 'Dispute accepted — dropped from driver score'
        : 'Dispute rejected — event stands'
      }
      style={{
        marginLeft: 6, padding: '1px 5px', borderRadius: 3,
        fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
        color: c.color, background: c.bg,
      }}
    >
      {c.label}
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
