/**
 * AssetDetailModal — combined "current location + movement history"
 * view for a single asset. Opens when a dispatcher clicks the asset's
 * column header (or the live-location chip beneath it).
 *
 * Layout (1100 × 720):
 *   ┌─────────────────────────────────────┬───────────────────────┐
 *   │ Range chips · totals                │ CURRENT LOCATION      │
 *   │ ─ Movement history (scroll) ─       │ ┌───────────────────┐ │
 *   │   Day group                          │ │      [map]        │ │
 *   │     [row] [row] [row] ...            │ │                   │ │
 *   │   Day group                          │ └───────────────────┘ │
 *   │     ...                              │                       │
 *   └─────────────────────────────────────┴───────────────────────┘
 *
 * Movements are clustered with the same rules used in the calendar
 * (15-min gap merge, overlap merge), so the list stays readable.
 * Clicking a row opens MovementDetailPanel on top, reusing the same
 * road-route map / metadata grid for individual periods.
 */
'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, MapPin, Loader2, ChevronRight, ExternalLink } from 'lucide-react';
import type { Asset } from '@/lib/types';
import type { MotiveLocation } from '@/app/api/motive/locations/route';
import { railway, type MovementCard } from '@/lib/railway';
import { clusterMovements, extractCity, type MovementCluster } from '@/lib/clusterMovements';
import { useCalendarStore } from '@/store/useCalendarStore';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import MovementDetailPanel from './MovementDetailPanel';
import DatePicker from './DatePicker';

interface Props {
  asset:    Asset;
  location: MotiveLocation | null;
  onClose:  () => void;
}

const PRESETS = [
  { key: 'today', label: 'Today',    days: 1  },
  { key: '7d',    label: 'Last 7d',  days: 7  },
  { key: '30d',   label: 'Last 30d', days: 30 },
] as const;
type PresetKey = typeof PRESETS[number]['key'];
type RangeKey  = PresetKey | 'custom';

/** Format YYYY-MM-DD for the custom-day chip ("May 19, 2026"). */
function fmtDayChip(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtDuration(min: number): string {
  if (min < 1) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export default function AssetDetailModal({ asset, location, onClose }: Props) {
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const { calendarTimezone } = useCalendarStore();

  const [range, setRange]               = useState<RangeKey>('7d');
  const [customDate, setCustomDate]     = useState<string>(''); // YYYY-MM-DD
  const [movements, setMovements]       = useState<MovementCard[]>([]);
  const [loading, setLoading]           = useState(false);
  const [backfilling, setBackfilling]   = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [openCluster, setOpenCluster]   = useState<MovementCluster | null>(null);

  const linkedToMotive = !!asset.motiveVehicleId;

  // How many days back the chosen range covers. Used to decide if we
  // need to fire a backfill before fetching (cron only covers ~7d).
  const lookbackDays = (() => {
    if (range === 'custom' && customDate) {
      const todayMs = new Date().setHours(0, 0, 0, 0);
      const pickMs  = new Date(`${customDate}T00:00:00`).getTime();
      return Math.max(1, Math.ceil((todayMs - pickMs) / 86_400_000) + 1);
    }
    return PRESETS.find(p => p.key === range)?.days ?? 7;
  })();

  // Close on Escape — but only when no inner detail panel is open
  // (otherwise the inner panel handles it).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !openCluster) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, openCluster]);

  // Fetch movements when range changes. For ranges > 7 days, fire an
  // auto-backfill first so the DB actually has the data — the cron's
  // incremental sync only catches what Motive has *updated* since the
  // cursor, not the full lookback.
  useEffect(() => {
    if (!linkedToMotive) return;
    if (range === 'custom' && !customDate) return; // wait for date pick
    let cancelled = false;
    (async () => {
      setError(null);
      setLoading(true);
      try {
        if (lookbackDays > 7) {
          setBackfilling(true);
          try {
            await railway.syncMovements({ mode: 'backfill', windowDays: lookbackDays });
          } catch (e) {
            console.warn('[AssetDetailModal] auto-backfill failed', e);
          } finally {
            if (!cancelled) setBackfilling(false);
          }
        }

        // Compute the UTC window to query. Custom day pulls ±12h
        // around the chosen day so we catch periods that straddle
        // midnight in org tz; we filter back down client-side.
        let fromIso: string;
        let toIso:   string;
        if (range === 'custom' && customDate) {
          const dayMs = 86_400_000;
          const baseMs = new Date(`${customDate}T00:00:00Z`).getTime();
          fromIso = new Date(baseMs - dayMs / 2).toISOString();
          toIso   = new Date(baseMs + 1.5 * dayMs).toISOString();
        } else {
          const nowMs = Date.now();
          fromIso = new Date(nowMs - lookbackDays * 86_400_000).toISOString();
          toIso   = new Date(nowMs).toISOString();
        }

        const res = await railway.listMovements(fromIso, toIso);
        if (cancelled) return;
        setMovements(res.byVehicle[String(asset.motiveVehicleId)] ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load movements');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range, customDate, lookbackDays, asset.motiveVehicleId, linkedToMotive]);

  // Cluster the fetched movements (same rules as the calendar column).
  // When in custom-day mode, also trim clusters whose start isn't on
  // the picked day in org tz (the ±12h fetch overshoots so we need to
  // filter client-side).
  const clusters = useMemo(() => {
    const all = clusterMovements(movements);
    if (range !== 'custom' || !customDate) return all;
    const dayInTz = (iso: string) => new Intl.DateTimeFormat('en-CA', {
      timeZone: calendarTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
    return all.filter(c => dayInTz(c.startTime) === customDate);
  }, [movements, range, customDate, calendarTimezone]);

  // Group by day (in org tz) for the list header rows.
  const groups = useMemo(() => {
    const map = new Map<string, MovementCluster[]>();
    for (const c of clusters) {
      const day = new Intl.DateTimeFormat('en-US', {
        timeZone: calendarTimezone,
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      }).format(new Date(c.startTime));
      const arr = map.get(day) ?? [];
      arr.push(c);
      map.set(day, arr);
    }
    return [...map.entries()];
  }, [clusters, calendarTimezone]);

  const totals = useMemo(() => {
    let miles = 0, minutes = 0, periods = 0;
    for (const c of clusters) {
      miles   += c.miles;
      minutes += c.durationMin;
      periods += c.members.length;
    }
    return { count: clusters.length, totalPeriods: periods, miles, minutes };
  }, [clusters]);

  // Render the current-location map once when the modal mounts (and
  // location data exists). Same pulsing-blue-dot pattern as
  // VehicleMapPanel so the two reads "feel" identical.
  useEffect(() => {
    if (!mapContainer.current || !location) return;
    let cancelled = false;
    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;
      const map = new google.maps.Map(mapContainer.current, {
        center: { lat: location.lat, lng: location.lon },
        zoom: 12, mapId: MAP_ID,
        disableDefaultUI: false, clickableIcons: false,
        gestureHandling: 'greedy',
      });
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;width:22px;height:22px;';
      const pulse = document.createElement('div');
      pulse.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:rgba(59,130,246,0.25);animation:truck-pulse 2s ease-out infinite;';
      const dot = document.createElement('div');
      dot.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#3b82f6;border:2.5px solid white;box-shadow:0 1px 6px rgba(59,130,246,0.6);';
      if (!document.getElementById('truck-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'truck-pulse-style';
        style.textContent = '@keyframes truck-pulse{0%{transform:scale(1);opacity:.6}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}';
        document.head.appendChild(style);
      }
      wrapper.appendChild(pulse);
      wrapper.appendChild(dot);
      new google.maps.marker.AdvancedMarkerElement({
        map, position: { lat: location.lat, lng: location.lon }, content: wrapper,
      });
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typeof document === 'undefined') return null;

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)', zIndex: 999 }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden"
        style={{ width: 1100, height: 720, maxWidth: '95vw', maxHeight: '92vh', background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: asset.color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{asset.name}</span>
              {asset.unit && <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>#{asset.unit}</span>}
              {!linkedToMotive && (
                <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ml-1"
                  style={{ background: 'var(--gc-hover)', color: 'var(--gc-text-3)' }}>
                  No ELD
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            <X size={16} />
          </button>
        </div>

        {/* Body: history (left) + location (right) */}
        <div className="flex-1 flex min-h-0">
          {/* Left: movement history */}
          <div className="flex-1 flex flex-col min-h-0" style={{ borderRight: '1px solid var(--gc-border-light)' }}>
            <div className="px-4 py-3 shrink-0">
              <div className="flex items-center gap-1 mb-2.5 flex-wrap">
                {PRESETS.map(p => {
                  const active = range === p.key;
                  return (
                    <button
                      key={p.key}
                      onClick={() => setRange(p.key)}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                      style={{
                        background: active ? 'var(--gc-blue-light)' : 'transparent',
                        color:      active ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                        border:     active ? '1px solid var(--gc-blue-light)' : '1px solid transparent',
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
                {/* Custom day picker — selecting a date flips range to
                    'custom' so the rest of the modal scopes to that day. */}
                <DatePicker
                  value={customDate}
                  onChange={(v) => { setCustomDate(v); setRange('custom'); }}
                  headerColor="var(--gc-blue)"
                  displayText={range === 'custom' && customDate ? fmtDayChip(customDate) : 'Pick a day…'}
                  buttonStyle={{
                    width: 'auto',
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: 6,
                    background: range === 'custom' ? 'var(--gc-blue-light)' : 'transparent',
                    color:      range === 'custom' ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                    border:     range === 'custom' ? '1px solid var(--gc-blue-light)' : '1px solid transparent',
                  }}
                />
              </div>
              <div className="flex items-center gap-2 text-[11px] flex-wrap" style={{ color: 'var(--gc-text-3)' }}>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{totals.count}</strong> {totals.count === 1 ? 'block' : 'blocks'}</span>
                {totals.count !== totals.totalPeriods && (
                  <span>({totals.totalPeriods} raw periods)</span>
                )}
                <span>·</span>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{totals.miles.toFixed(0)}</strong> mi</span>
                <span>·</span>
                <span><strong style={{ color: 'var(--gc-text-2)' }}>{fmtDuration(totals.minutes)}</strong> driving</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {!linkedToMotive && (
                <div className="text-center py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  This asset isn&apos;t linked to a Motive vehicle yet.
                  <br />
                  <a href="/settings" className="font-medium" style={{ color: 'var(--gc-blue)' }}>
                    Link it in Settings → Integrations
                  </a>
                </div>
              )}
              {linkedToMotive && backfilling && (
                <div className="text-center py-3 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={14} className="inline animate-spin mr-1.5" />
                  Backfilling history…
                </div>
              )}
              {linkedToMotive && loading && !backfilling && (
                <div className="flex items-center justify-center gap-2 py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              )}
              {linkedToMotive && error && (
                <div className="text-center py-6 text-[12px]" style={{ color: '#d93025' }}>{error}</div>
              )}
              {linkedToMotive && !loading && !error && groups.length === 0 && (
                <div className="text-center py-8 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  No movements in this period.
                </div>
              )}
              {linkedToMotive && groups.map(([day, dayClusters]) => (
                <div key={day} className="mb-3">
                  <div className="sticky top-0 z-10 text-[10px] font-semibold uppercase tracking-wide py-1.5 mb-1.5"
                    style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-3)' }}>
                    {day}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {dayClusters.map(c => {
                      const o = extractCity(c.origin);
                      const d = extractCity(c.destination);
                      const sameCity = o && d && o.toLowerCase() === d.toLowerCase();
                      const route = o && d
                        ? (sameCity ? `around ${o}` : `${o} → ${d}`)
                        : (o ?? d ?? '—');
                      const time = new Intl.DateTimeFormat('en-US', {
                        timeZone: calendarTimezone,
                        hour: 'numeric', minute: '2-digit',
                      }).format(new Date(c.startTime));
                      return (
                        <button
                          key={c.id}
                          onClick={() => setOpenCluster(c)}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors"
                          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-bg)'; }}
                        >
                          <div className="text-[12px] font-mono tabular-nums shrink-0" style={{ color: 'var(--gc-text-2)', minWidth: 64 }}>
                            {time}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] font-medium truncate" style={{ color: 'var(--gc-text-1)' }}>
                              {c.members.length > 1 ? `${c.members.length} moves · ` : ''}{route}
                            </div>
                            <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                              {c.miles.toFixed(1)} mi · {fmtDuration(c.durationMin)}
                            </div>
                          </div>
                          <ChevronRight size={12} style={{ color: 'var(--gc-text-3)' }} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: current location map */}
          <div className="flex flex-col shrink-0" style={{ width: 440 }}>
            <div className="px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="text-[10px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--gc-text-3)' }}>
                Current location
              </div>
              {location ? (
                <>
                  <div className="flex items-center gap-1">
                    <MapPin size={11} style={{ color: 'var(--gc-text-2)' }} />
                    <span className="text-[12px] truncate" style={{ color: 'var(--gc-text-1)' }}>{location.description}</span>
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                    Last update: {new Date(location.locatedAt).toLocaleString('en-US', { timeZone: calendarTimezone, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </>
              ) : (
                <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                  {linkedToMotive ? 'No telemetry yet' : 'Asset not linked to Motive'}
                </div>
              )}
            </div>
            <div className="flex-1 relative">
              {location ? (
                <>
                  <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
                  <a
                    href={`https://www.google.com/maps?q=${location.lat},${location.lon}`}
                    target="_blank" rel="noopener noreferrer"
                    className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-1"
                    style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)', color: 'var(--gc-blue)', textDecoration: 'none' }}
                  >
                    <ExternalLink size={10} /> Open in Maps
                  </a>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)' }}>
                  No location available
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Inner detail panel for a single cluster — renders at higher z. */}
      {openCluster && (
        <MovementDetailPanel
          cluster={openCluster}
          asset={{ name: asset.name, color: asset.color, unit: asset.unit ?? undefined }}
          onClose={() => setOpenCluster(null)}
        />
      )}
    </div>
  );

  return createPortal(content, document.body);
}
