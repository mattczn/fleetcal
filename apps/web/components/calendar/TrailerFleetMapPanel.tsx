'use client';

/**
 * TrailerFleetMapPanel — fleet-wide trailer map + sidebar.
 *
 * Opened via the Container icon in CalendarToolbar. Shows:
 *   - Left: Google Map with one pin per Motive-linked trailer that
 *     has a current_location. RED pin = in use right now (currently
 *     attached to an active load); GREEN pin = idle / available.
 *   - Right: search box, then sectioned list of all trailers:
 *       Active (in use right now)  — pulled from getTrailerUsage()
 *       Idle (no current load)
 *       No GPS (trailers without motiveVehicleId, or no recent ping)
 *     Each row shows trailer name, number, category, "last seen" if
 *     the trailer has GPS data, and (for in-use rows) the linked
 *     load's driver, route, and status.
 *
 * Click a sidebar row → pans the map to its pin. Click a pin → marks
 * the corresponding sidebar row.
 *
 * Search filters every section (matches name, trailer #, category,
 * notes). When the query is non-empty, sections collapse to only the
 * trailers that match.
 *
 * Polls /api/motive/trailer-locations every 60s while open. Closes on
 * Escape or click outside.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, MapPin, Container, AlertCircle, Loader2, Search, Clock } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { useCalendarStore } from '@/store/useCalendarStore';
import { getTrailerUsage, type TrailerUsage } from '@/lib/trailerUsage';
import type { MotiveTrailerLocation } from '@/app/api/motive/trailer-locations/route';
import type { Trailer, CalendarEvent } from '@/lib/types';

interface Props {
  onClose: () => void;
}

// Status palette: red signals "this trailer is tied up right now",
// green signals "this trailer is free." Matches dispatcher mental
// model where green = good-to-grab.
const STATUS_PIN_COLOR = {
  in_use: '#d93025',  // red
  idle:   '#1e8e3e',  // green
} as const;

const POLL_MS = 60_000;

/** Build a colored circle marker (HTMLElement) for the map plus a
 *  pre-attached label element that's hidden until the marker is
 *  selected. The label element is returned alongside so the
 *  selection-effect can flip it on/off without recreating the pin. */
function makePinElement(color: string, label: string): { wrapper: HTMLDivElement; labelEl: HTMLDivElement } {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;cursor:pointer;display:flex;flex-direction:column;align-items:center;';

  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  labelEl.style.cssText = [
    'display:none',
    'margin-bottom:4px',
    'padding:2px 8px',
    'background:#ffffff',
    'color:#202124',
    'border:1px solid rgba(0,0,0,0.15)',
    'border-radius:6px',
    'font-size:11px',
    'font-weight:700',
    'white-space:nowrap',
    'box-shadow:0 1px 4px rgba(0,0,0,0.25)',
    'pointer-events:none',
  ].join(';');

  const dot = document.createElement('div');
  dot.style.cssText = `
    width:16px;height:16px;border-radius:50%;
    background:${color};border:2.5px solid white;
    box-shadow:0 1px 6px rgba(0,0,0,0.35);
  `;

  wrapper.appendChild(labelEl);
  wrapper.appendChild(dot);
  return { wrapper, labelEl };
}

/** Format an ISO timestamp as a coarse "X ago" string. Returns null
 *  when the input is missing or unparseable. Granularity is sized for
 *  fleet GPS pings: seconds → minutes → hours → days → months → years. */
function formatLastSeen(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 30_000) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60)         return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)         return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)         return `${hr}h ago`;
  const day = Math.floor(hr  / 24);
  if (day < 30)         return `${day}d ago`;
  const mo  = Math.floor(day / 30);
  if (mo  < 12)         return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Case-insensitive substring match across the fields the dispatcher
 *  is likely to type. Empty query matches everything. */
function trailerMatchesQuery(t: Trailer, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (t.name.toLowerCase().includes(needle)) return true;
  if (t.trailerNumber?.toLowerCase().includes(needle)) return true;
  if (t.category.toLowerCase().includes(needle))       return true;
  if (t.notes?.toLowerCase().includes(needle))         return true;
  return false;
}

export default function TrailerFleetMapPanel({ onClose }: Props) {
  const { trailers, events, drivers, assets, calendarTimezone } = useCalendarStore();
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const markersRef   = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  // Pin label elements keyed by trailer id — separate from the markers
  // map so we can toggle visibility on selection change without
  // recreating any pins. Cleared together with markersRef.
  const labelsRef    = useRef<Map<string, HTMLDivElement>>(new Map());

  const [locations,  setLocations]  = useState<Record<string, MotiveTrailerLocation>>({});
  const [locLoading, setLocLoading] = useState(false);
  const [locError,   setLocError]   = useState<string | null>(null);
  const [selectedTrailerId, setSelectedTrailerId] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  // ── ESC closes ────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // Stable comma-separated list of Motive asset IDs to locate. The
  // server-side endpoint hits keeptruckin.com/v1/asset_locations and
  // trims the response to just these IDs.
  const motiveIds = useMemo(() => {
    return trailers
      .filter(t => !t.activeTo && !!t.motiveVehicleId)
      .map(t => t.motiveVehicleId!)
      .sort()
      .join(',');
  }, [trailers]);

  // ── Poll trailer locations ────────────────────────────────────────────
  useEffect(() => {
    if (!motiveIds) {
      setLocations({});
      setLocLoading(false);
      return;
    }
    let cancelled = false;
    const fetchLocs = async () => {
      setLocLoading(true);
      try {
        const res = await fetch(`/api/motive/trailer-locations?ids=${encodeURIComponent(motiveIds)}`);
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
  }, [motiveIds]);

  // ── Compute usage + grouping ──────────────────────────────────────────
  // Group every (non-retired) trailer into Active / Idle / No GPS, then
  // filter by the search query. Filtering AFTER grouping keeps the
  // section labels honest: "Active 0" still appears if the user has
  // typed a query that doesn't match any active trailer, rather than
  // silently shifting items between sections.
  const groups = useMemo(() => {
    type RowWithLoc = { trailer: Trailer; usage: TrailerUsage; loc: MotiveTrailerLocation };
    type RowNoGps   = { trailer: Trailer; usage: TrailerUsage };
    const active: RowWithLoc[] = [];
    const idle:   RowWithLoc[] = [];
    const noGps:  RowNoGps[]   = [];

    for (const t of trailers) {
      if (t.activeTo) continue;  // retired — out of the fleet view
      if (!trailerMatchesQuery(t, query)) continue;
      const usage = getTrailerUsage(t.id, events, calendarTimezone);
      const loc = t.motiveVehicleId ? locations[t.motiveVehicleId] : undefined;
      if (!loc) {
        noGps.push({ trailer: t, usage });
        continue;
      }
      (usage.status === 'in_use' ? active : idle).push({ trailer: t, usage, loc });
    }
    return { active, idle, noGps };
  }, [trailers, events, locations, calendarTimezone, query]);

  // ── Construct the map ONCE ────────────────────────────────────────────
  // The google.maps.Map is a billable Dynamic Maps load, so it must be
  // built exactly once for the lifetime of this panel. The `mapReady`
  // flag flips after construction so the marker effect below can start
  // plotting pins onto the existing instance. The initial center/zoom
  // and one-time fit-bounds are done here from a ref snapshot of the
  // current groups so we don't re-center on every poll.
  const [mapReady, setMapReady] = useState(false);
  const didInitialFitRef = useRef(false);
  // Latest groups, read (not depended on) by the construction effect so
  // the initial center/fit reflects whatever pins exist at first paint
  // without pulling `groups` into the deps.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  useEffect(() => {
    if (!mapContainer.current) return;
    if (mapRef.current) return;  // never re-instantiate
    let cancelled = false;

    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current || mapRef.current) return;

      const allPinned = [...groupsRef.current.active, ...groupsRef.current.idle];
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
      setMapReady(true);
    });

    return () => {
      cancelled = true;
      markersRef.current.forEach(m => { m.map = null; });
      markersRef.current.clear();
      labelsRef.current.clear();
      mapRef.current = null;
    };
    // Construct once — never tear down / rebuild on poll-driven count
    // changes (that would spawn a fresh billable Dynamic Maps load).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Plot / diff pins on the existing map ──────────────────────────────
  // Runs whenever `groups` change (search filtering, poll updates). It
  // adds new markers, removes stale ones, and updates the position /
  // color / title of survivors — all on the map instance built above,
  // so the poll interval never re-instantiates the map. Pins are
  // plotted from groups (so search filtering hides pins too — the map
  // shows exactly what the sidebar shows).
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    void loadGoogleMaps().then(google => {
      const map = mapRef.current;
      if (!map) return;

      const allPinned = [...groups.active, ...groups.idle];
      const seen = new Set<string>();
      const bounds = new google.maps.LatLngBounds();

      for (const entry of allPinned) {
        const key = String(entry.trailer.id);
        seen.add(key);
        const color = STATUS_PIN_COLOR[entry.usage.status];
        const lastSeen = formatLastSeen(entry.loc.locatedAt);
        // Label content prefers the trailer number (what dispatchers
        // actually call them) and falls back to the display name.
        const labelText = entry.trailer.trailerNumber
          ? `#${entry.trailer.trailerNumber}`
          : entry.trailer.name;
        const position = { lat: entry.loc.lat, lng: entry.loc.lon };
        const title = lastSeen ? `${entry.trailer.name} · ${lastSeen}` : entry.trailer.name;

        const existing = markersRef.current.get(key);
        if (existing) {
          // Update the survivor in place — moving the pin and refreshing
          // its hover title without recreating the AdvancedMarkerElement.
          existing.position = position;
          existing.title = title;
        } else {
          const { wrapper, labelEl } = makePinElement(color, labelText);
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map,
            position,
            content: wrapper,
            // Hover title gives the dispatcher a quick read without
            // clicking through to the sidebar.
            title,
          });
          marker.addListener('click', () => setSelectedTrailerId(entry.trailer.id));
          markersRef.current.set(key, marker);
          labelsRef.current.set(key, labelEl);
        }
        bounds.extend(position);
      }

      // Remove markers whose trailers dropped out of the pinned set.
      for (const [key, marker] of markersRef.current) {
        if (!seen.has(key)) {
          marker.map = null;
          markersRef.current.delete(key);
          labelsRef.current.delete(key);
        }
      }

      // Fit the map to all pins exactly once, on the first plot with
      // data. After that, poll updates mutate pins without forcibly
      // re-centering (matching prior UX where the view stayed put).
      if (!didInitialFitRef.current && allPinned.length > 0) {
        didInitialFitRef.current = true;
        if (allPinned.length > 1) map.fitBounds(bounds, 60);
      }
    });
  }, [mapReady, groups]);

  // ── Selection effect ──────────────────────────────────────────────────
  // Three things happen when a trailer becomes selected (whether the
  // click came from a pin or a sidebar row):
  //   1. The map pans/zooms to the pin.
  //   2. The pin's label (trailer #) appears above the dot, and the
  //      pin's zIndex is bumped so it draws on top of nearby pins.
  //   3. The matching sidebar row scrolls into view — without this the
  //      highlight is invisible when the row is below the fold.
  useEffect(() => {
    // Hide every label first so old selections clear out.
    labelsRef.current.forEach(el => { el.style.display = 'none'; });
    markersRef.current.forEach(m => { m.zIndex = undefined; });

    if (selectedTrailerId == null) return;

    const key = String(selectedTrailerId);
    const marker = markersRef.current.get(key);
    const labelEl = labelsRef.current.get(key);

    if (labelEl) labelEl.style.display = 'block';
    if (marker)  marker.zIndex = 999;

    if (marker?.position && mapRef.current) {
      const pos = marker.position as google.maps.LatLngLiteral;
      mapRef.current.panTo(pos);
      mapRef.current.setZoom(Math.max(mapRef.current.getZoom() ?? 8, 11));
    }

    // Scroll the sidebar row into view. We use a data attribute rather
    // than threading refs through Section so the lookup stays simple
    // even as the row list re-orders (search filtering, etc.).
    if (typeof document !== 'undefined') {
      const row = document.querySelector<HTMLElement>(`[data-trailer-row-id="${selectedTrailerId}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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
          <div className="flex-1 flex flex-col min-h-0" style={{ borderLeft: '1px solid var(--gc-border)' }}>
            {/* Search — sits above the scrollable section list so it
                stays visible while scrolling through long fleets. */}
            <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <div className="relative">
                <Search
                  size={13}
                  style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--gc-text-3)' }}
                />
                <input
                  type="text"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search trailer name, #, or category"
                  className="w-full text-[13px] outline-none"
                  style={{
                    padding: '7px 28px 7px 30px',
                    border: '1px solid var(--gc-border)',
                    borderRadius: 8,
                    background: 'var(--gc-surface)',
                    color: 'var(--gc-text-1)',
                  }}
                />
                {query && (
                  <button
                    onClick={() => setQuery('')}
                    title="Clear search"
                    style={{
                      position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                      padding: 3, borderRadius: 6, border: 'none', background: 'transparent',
                      cursor: 'pointer', color: 'var(--gc-text-3)',
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <Section
                label="Active"
                count={groups.active.length}
                statusColor={STATUS_PIN_COLOR.in_use}
                rows={groups.active.map(({ trailer, usage, loc }) => ({
                  trailer,
                  badge: 'In use',
                  badgeColor: STATUS_PIN_COLOR.in_use,
                  lastSeen: formatLastSeen(loc.locatedAt),
                  locationLabel: loc.description || undefined,
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
                rows={groups.idle.map(({ trailer, loc }) => ({
                  trailer,
                  badge: 'Idle',
                  badgeColor: STATUS_PIN_COLOR.idle,
                  lastSeen: formatLastSeen(loc.locatedAt),
                  locationLabel: loc.description || undefined,
                }))}
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
                  {query ? `No trailers match "${query}".` : 'No active trailers in the fleet yet.'}
                </div>
              )}
            </div>
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
    /** Pre-formatted "X ago" string — only set for rows that have GPS. */
    lastSeen?:      string | null;
    /** Reverse-geocoded address from Motive — shown above driver/asset. */
    locationLabel?: string;
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
      {rows.map(({ trailer, badge, badgeColor, lastSeen, locationLabel, detail }) => {
        const isSel = trailer.id === selectedId;
        return (
          <button
            key={trailer.id}
            data-trailer-row-id={trailer.id}
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
                <div className="text-[11px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--gc-text-3)' }}>
                  <span>{trailer.category}</span>
                  {lastSeen && (
                    <>
                      <span style={{ opacity: 0.4 }}>·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock size={9} />
                        {lastSeen}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <span
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0"
                style={{ color: badgeColor, background: `${badgeColor}20` }}
              >
                {badge}
              </span>
            </div>
            {/* Address — surfaced even on idle rows so the dispatcher
                can see "trailer is sitting at the yard" without
                clicking the pin. */}
            {locationLabel && (
              <div className="mt-1.5 text-[11px] flex items-center gap-1" style={{ color: 'var(--gc-text-2)' }}>
                <MapPin size={10} style={{ color: 'var(--gc-text-3)' }} />
                <span className="truncate">{locationLabel}</span>
              </div>
            )}
            {detail && (detail.route || detail.driver || detail.asset) && (
              <div className="mt-1.5 pl-0 text-[11px] space-y-0.5" style={{ color: 'var(--gc-text-2)' }}>
                {detail.route && !locationLabel && (
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
