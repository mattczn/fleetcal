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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, MapPin, Container, AlertCircle, Loader2, Search, Clock, Plus, Trash2, Crosshair } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { useCalendarStore } from '@/store/useCalendarStore';
import { getTrailerUsage, type TrailerUsage } from '@/lib/trailerUsage';
import type { MotiveTrailerLocation } from '@/app/api/motive/trailer-locations/route';
import { yardsFrom, yardAt, feetToMetres, metresToFeet, DEFAULT_YARD_RADIUS_FT, type Yard } from '@/lib/yards';
import type { Trailer, CalendarEvent, SavedLocation } from '@/lib/types';

interface Props {
  /** Required in modal mode; ignored when `embedded`. */
  onClose?: () => void;
  /**
   * Render the map + roster filling the parent instead of as a modal
   * over the calendar. The /trailers page uses this so the page and
   * the toolbar popup stay the same component — the only differences
   * are the chrome (no backdrop, no fixed 980×720 card, no close
   * button) and that Escape isn't bound, since on a page there's
   * nothing to escape from.
   */
  embedded?: boolean;
}

// Status palette: red signals "this trailer is tied up right now",
// green signals "this trailer is free." Matches dispatcher mental
// model where green = good-to-grab.
const STATUS_PIN_COLOR = {
  in_use: '#d93025',  // red
  idle:   '#1e8e3e',  // green
} as const;

// Yards are drawn in blue, deliberately not red or green: those two
// already mean "this trailer is busy / free", and a geofence is not a
// third trailer state.
const YARD_COLOR = '#1a73e8';

const POLL_MS = 60_000;

/**
 * What the tag above a selected pin says.
 *
 * Every field is recomputed on each plot pass rather than captured
 * when the pin was built, because two of them go stale on their own:
 * "12m ago" ages, and a trailer gets hooked to a truck without the
 * pin ever moving.
 */
interface PinTag {
  /** "#2030" when the trailer has a number, else its display name. */
  heading:    string;
  category:   string;
  lastSeen:   string | null;
  /** Set only while the trailer is on a load that's running now. */
  truck?:     { name: string; color: string };
  loadTitle?: string;
}

/**
 * How a pin is currently being looked at.
 *
 * Hover is transient and selection is sticky, but they compete for the
 * same two bits of the pin — how big the dot is and what the tag says
 * — so they're one mode rather than two independent flags. Without
 * that, hovering a selected pin would try to show both tags at once.
 */
type PinMode = 'idle' | 'hover' | 'selected';

const PIN_SCALE: Record<PinMode, string> = {
  idle:     'scale(1)',
  hover:    'scale(1.35)',
  selected: 'scale(1.6)',
};

const PIN_SHADOW: Record<PinMode, string> = {
  idle:     '0 1px 6px rgba(0,0,0,0.35)',
  hover:    '0 2px 9px rgba(0,0,0,0.45)',
  selected: '0 2px 11px rgba(0,0,0,0.5)',
};

// Hover outranks selection. The selected pin is wherever you left it;
// the hovered pin is the one your cursor is on *now*, and its tag has
// to be readable over whatever it happens to overlap — including the
// selected pin's larger tag.
const PIN_Z: Record<PinMode, number | undefined> = {
  idle:     undefined,
  hover:    1000,
  selected: 900,
};

/** Build a colored circle marker (HTMLElement) for the map plus a
 *  pre-attached tag element that's hidden until the marker is
 *  hovered or selected. The tag element is returned alongside so the selection
 *  effect can flip it on/off, and the plot effect can repaint its
 *  contents, without either one recreating the pin. */
function makePinElement(color: string): { wrapper: HTMLDivElement; labelEl: HTMLDivElement; dot: HTMLDivElement } {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;cursor:pointer;display:flex;flex-direction:column;align-items:center;';

  const labelEl = document.createElement('div');
  labelEl.style.cssText = [
    'display:none',
    'margin-bottom:5px',
    'padding:5px 9px',
    'background:#ffffff',
    'color:#202124',
    'border:1px solid rgba(0,0,0,0.15)',
    'border-radius:8px',
    'font-size:11px',
    'line-height:1.35',
    'text-align:left',
    // Capped so a long load title makes a two-line tag instead of a
    // banner wide enough to cover the pins either side of it.
    'max-width:240px',
    'box-shadow:0 2px 8px rgba(0,0,0,0.28)',
    'pointer-events:none',
  ].join(';');

  const dot = document.createElement('div');
  dot.style.cssText = [
    'width:16px', 'height:16px', 'border-radius:50%',
    `background:${color}`, 'border:2.5px solid white',
    `box-shadow:${PIN_SHADOW.idle}`,
    // Grown with a transform rather than by changing width/height, so
    // enlarging the dot never reflows the tag stacked above it. The
    // marker anchors this wrapper's bottom centre at the trailer's
    // coordinates, so a layout change here would visibly jump the pin.
    'transform-origin:center',
    'transition:transform 120ms ease-out, box-shadow 120ms ease-out',
  ].join(';');

  wrapper.appendChild(labelEl);
  wrapper.appendChild(dot);
  return { wrapper, labelEl, dot };
}

/** The truck's calendar colour as a dot. On the calendar the colour
 *  IS how a dispatcher recognises a truck, so this is identification,
 *  not decoration. Set through `style.background` rather than in the
 *  cssText string: the value comes out of the database, and the
 *  property setter ignores a malformed colour instead of letting it
 *  be parsed as further CSS. */
function truckSwatch(color: string): HTMLSpanElement {
  const swatch = document.createElement('span');
  swatch.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 1px rgba(0,0,0,0.15);';
  swatch.style.background = color;
  return swatch;
}

/**
 * Repaint a pin's tag from current data.
 *
 * Called on every plot pass, survivors included, so a tag a
 * dispatcher is looking at updates under them on the 60s poll instead
 * of freezing at whatever it said when the pin was created.
 *
 * `compact` is the hover tag: one line, because hovering is a glance
 * across a yard asking "which trailer is this, and is it under a
 * truck". Clicking is the deliberate read, and earns the category,
 * the last-seen and the load.
 *
 * Built with textContent rather than innerHTML — a trailer name and a
 * load title are org-entered strings.
 */
function paintPinTag(el: HTMLDivElement, tag: PinTag, compact: boolean): void {
  el.replaceChildren();
  el.style.padding = compact ? '3px 9px' : '5px 9px';

  if (compact) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;white-space:nowrap;';
    const heading = document.createElement('span');
    heading.textContent = tag.heading;
    heading.style.cssText = 'font-size:11px;font-weight:700;color:#202124;';
    row.appendChild(heading);
    if (tag.truck) {
      row.appendChild(truckSwatch(tag.truck.color));
      const name = document.createElement('span');
      name.textContent = tag.truck.name;
      name.style.cssText = 'font-size:11px;font-weight:600;color:#3c4043;';
      row.appendChild(name);
    }
    el.appendChild(row);
    return;
  }

  // Line 1 — the trailer's own identity: number, then category.
  const idRow = document.createElement('div');
  idRow.style.cssText = 'display:flex;align-items:baseline;gap:6px;white-space:nowrap;';
  const heading = document.createElement('span');
  heading.textContent = tag.heading;
  heading.style.cssText = 'font-size:12px;font-weight:700;color:#202124;';
  idRow.appendChild(heading);
  if (tag.category) {
    const cat = document.createElement('span');
    cat.textContent = tag.category;
    cat.style.cssText = 'font-size:10px;color:#5f6368;';
    idRow.appendChild(cat);
  }
  el.appendChild(idRow);

  // Line 2 — how much to trust the dot. A trailer last seen three
  // days ago is somewhere else by now, and that is the single most
  // important caveat on this map.
  if (tag.lastSeen) {
    const seen = document.createElement('div');
    seen.textContent = tag.lastSeen;
    seen.style.cssText = 'font-size:10px;color:#5f6368;white-space:nowrap;';
    el.appendChild(seen);
  }

  // Line 3 — truck + load, which turn "where is it" into "what is it
  // doing". Only present for a trailer on a running load.
  if (tag.truck) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:5px',
      'margin-top:4px', 'padding-top:4px',
      'border-top:1px solid rgba(0,0,0,0.08)',
    ].join(';');

    row.appendChild(truckSwatch(tag.truck.color));

    const truckName = document.createElement('span');
    truckName.textContent = tag.truck.name;
    truckName.style.cssText = 'font-size:11px;font-weight:700;color:#202124;white-space:nowrap;';
    row.appendChild(truckName);

    if (tag.loadTitle) {
      const sep = document.createElement('span');
      sep.textContent = '·';
      sep.style.cssText = 'font-size:11px;color:#9aa0a6;flex:0 0 auto;';
      row.appendChild(sep);
      const load = document.createElement('span');
      load.textContent = tag.loadTitle;
      load.style.cssText = 'font-size:11px;color:#5f6368;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(load);
    }
    el.appendChild(row);
  }
}

/** Put one pin into the given mode: dot size, stacking order, and
 *  which tag (if any) is open. Every caller funnels through here so
 *  the three modes can't drift apart — the bug that would otherwise
 *  show up is a pin left large after the cursor moved on. */
function applyPinVisual(
  mode:   PinMode,
  dot:    HTMLDivElement | undefined,
  tagEl:  HTMLDivElement | undefined,
  marker: google.maps.marker.AdvancedMarkerElement | undefined,
  tag:    PinTag | undefined,
): void {
  if (dot) {
    dot.style.transform = PIN_SCALE[mode];
    dot.style.boxShadow = PIN_SHADOW[mode];
  }
  if (marker) marker.zIndex = PIN_Z[mode];
  if (!tagEl) return;
  if (mode === 'idle' || !tag) {
    tagEl.style.display = 'none';
    return;
  }
  paintPinTag(tagEl, tag, mode === 'hover');
  tagEl.style.display = 'block';
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

export default function TrailerFleetMapPanel({ onClose, embedded = false }: Props) {
  const { trailers, events, drivers, assets, calendarTimezone, savedLocations } = useCalendarStore();
  const addSavedLocation    = useCalendarStore(s => s.addSavedLocation);
  const updateSavedLocation = useCalendarStore(s => s.updateSavedLocation);
  const overlayRef   = useRef<HTMLDivElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<google.maps.Map | null>(null);
  const markersRef   = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  // Pin label elements keyed by trailer id — separate from the markers
  // map so we can toggle visibility on selection change without
  // recreating any pins. Cleared together with markersRef.
  const labelsRef    = useRef<Map<string, HTMLDivElement>>(new Map());
  // Pin positions keyed by trailer id, written by the plot effect.
  // The selection effect reads these rather than marker.position so
  // it can nudge the view without taking `groups` as a dependency —
  // doing that would re-run the nudge on every 60s poll.
  const positionsRef = useRef<Map<string, google.maps.LatLngLiteral>>(new Map());
  // The dot inside each pin, kept separately so it can be scaled
  // without touching the tag above it.
  const dotsRef      = useRef<Map<string, HTMLDivElement>>(new Map());
  // What each pin's tag should say, written by the plot effect and
  // read by repaintPins. Keeping it here rather than in state means a
  // hover doesn't re-render the whole roster.
  const tagDataRef   = useRef<Map<string, PinTag>>(new Map());
  // Hover lives in a ref, not state, for the same reason: nothing in
  // the React tree depends on it, only map DOM.
  const hoveredKeyRef  = useRef<string | null>(null);
  // Selection DOES live in state (the sidebar highlight needs it);
  // this mirror exists so the pin listeners, which are attached once
  // at pin creation, read the current value instead of whatever was
  // selected on the render that created them.
  const selectedKeyRef = useRef<string | null>(null);

  const [locations,  setLocations]  = useState<Record<string, MotiveTrailerLocation>>({});
  const [locLoading, setLocLoading] = useState(false);
  const [locError,   setLocError]   = useState<string | null>(null);
  const [selectedTrailerId, setSelectedTrailerId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  // Which half of the rail is showing. Yards only on the page — the
  // toolbar popup is a glance-at-the-fleet tool, not somewhere to
  // administer geofences.
  const [rail, setRail] = useState<'trailers' | 'yards'>('trailers');
  // Non-null while waiting for a map click to place a new yard. Named
  // first so the click finishes the job instead of opening a prompt.
  const [placing, setPlacing] = useState<{ name: string; radiusFt: number } | null>(null);
  const [yardError, setYardError] = useState<string | null>(null);

  const yards = useMemo(() => yardsFrom(savedLocations), [savedLocations]);

  /**
   * Re-apply every pin's visual state from the refs.
   *
   * One pass over all pins rather than a targeted update of the two
   * that changed, because the pin *losing* hover or selection has to
   * shrink back and close its tag, and tracking which that was is how
   * you end up with a pin stuck large. There are a few dozen pins;
   * this is three style writes each.
   *
   * Stable identity with no dependencies, reading everything through
   * refs — so the mouseenter/mouseleave handlers attached when a pin
   * was created still see the current selection, not a stale one.
   */
  const repaintPins = useCallback(() => {
    const selKey = selectedKeyRef.current;
    const hovKey = hoveredKeyRef.current;
    for (const [key, marker] of markersRef.current) {
      const mode: PinMode = key === hovKey ? 'hover'
        : key === selKey ? 'selected'
        : 'idle';
      applyPinVisual(mode, dotsRef.current.get(key), labelsRef.current.get(key), marker, tagDataRef.current.get(key));
    }
  }, []);

  /**
   * Select a trailer and move the map accordingly.
   *
   * The two ways in want different things from the map, so the caller
   * says which it is:
   *
   *   'pin'  — you can already see the pin, you just clicked it. Nudge
   *            it into full view only if it's near/past the edge, and
   *            otherwise leave the view exactly as framed. Clicking
   *            your way around five trailers in one yard must not
   *            re-frame the map five times.
   *   'row'  — you clicked a name in the roster and may have no idea
   *            where that trailer is. Centre it; that IS the request.
   *
   * The pan lives here rather than in the selection effect so clicking
   * the row of an already-selected trailer re-centres instead of doing
   * nothing (the state wouldn't change, so no effect would run).
   */
  const focusTrailer = useCallback((id: number, source: 'pin' | 'row') => {
    setSelectedTrailerId(id);
    const pos = positionsRef.current.get(String(id));
    if (!pos) return;  // no GPS — nothing to move to
    void loadGoogleMaps().then(google => {
      const map = mapRef.current;
      if (!map) return;
      if (source === 'row') {
        map.panTo(pos);
        return;
      }
      // panToBounds pans by the MINIMUM amount needed to fit a point
      // inside the padded viewport, and does nothing when it already
      // fits. The padding is asymmetric because the tag hangs above
      // the dot and spreads sideways: these are roughly that tag's
      // footprint, so a nudged pin never lands somewhere its own tag
      // is clipped by the map frame.
      map.panToBounds(new google.maps.LatLngBounds(pos, pos), {
        top: 130, right: 160, bottom: 50, left: 160,
      });
    });
  }, []);

  // ── Escape ───────────────────────────────────────────────────────
  // Escape peels one layer at a time: an open trailer detail first,
  // then the panel. Without the first step, dismissing a tag in the
  // calendar popup would close the whole popup with it.
  //
  // Bound in embedded mode too, where there is no panel to close but
  // there is still a detail to dismiss.
  useEffect(() => {
    if (embedded && selectedTrailerId == null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (selectedTrailerId != null) { setSelectedTrailerId(null); return; }
      onClose?.();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, embedded, selectedTrailerId]);

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
      positionsRef.current.clear();
      dotsRef.current.clear();
      tagDataRef.current.clear();
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
        const load = entry.usage.load;
        // Only an in-use trailer has a load, and only that load names
        // a truck — so an idle pin's tag simply has no truck line
        // rather than an empty one.
        const truck = load ? assets.find(a => a.id === load.assetId) : undefined;
        const tag: PinTag = {
          // Prefers the trailer number (what dispatchers actually call
          // them) and falls back to the display name.
          heading: entry.trailer.trailerNumber
            ? `#${entry.trailer.trailerNumber}`
            : entry.trailer.name,
          category: entry.trailer.category,
          lastSeen,
          truck: truck ? { name: truck.name, color: truck.color } : undefined,
          // routeLabel is the fallback because a load with no typed
          // title still has stops, and "Las Vegas, NV → Salt Lake
          // City, UT" beats a blank line.
          loadTitle: load ? (load.title || routeLabel(load)) : undefined,
        };
        const position = { lat: entry.loc.lat, lng: entry.loc.lon };

        const existing = markersRef.current.get(key);
        if (existing) {
          // Update the survivor in place — moving the pin without
          // recreating the AdvancedMarkerElement or its listeners.
          existing.position = position;
        } else {
          const { wrapper, labelEl, dot } = makePinElement(color);

          // No `title` on the marker. It used to carry name + truck +
          // last seen as a native browser tooltip, which now arrives a
          // second late and directly on top of the hover tag saying
          // the same thing. The tag replaces it.
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map,
            position,
            content: wrapper,
          });
          marker.addListener('click', () => focusTrailer(entry.trailer.id, 'pin'));

          // Hover is wired to the wrapper rather than the marker so it
          // works regardless of which pointer events the Maps marker
          // forwards. The tag is pointer-events:none, so opening it
          // can't steal the hover from the pin underneath — and since
          // the tag stacks ABOVE the dot while the marker anchors the
          // wrapper's bottom edge, the dot doesn't move when the tag
          // appears. No flicker loop.
          wrapper.addEventListener('mouseenter', () => {
            hoveredKeyRef.current = key;
            repaintPins();
          });
          wrapper.addEventListener('mouseleave', () => {
            if (hoveredKeyRef.current === key) hoveredKeyRef.current = null;
            repaintPins();
          });

          markersRef.current.set(key, marker);
          labelsRef.current.set(key, labelEl);
          dotsRef.current.set(key, dot);
        }
        // Recorded for new pins and survivors alike: the poll that
        // moved a pin may also have aged its "last seen" or hooked it
        // to a truck, and an open tag has to pick that up.
        tagDataRef.current.set(key, tag);
        positionsRef.current.set(key, position);
        bounds.extend(position);
      }

      // Remove markers whose trailers dropped out of the pinned set.
      for (const [key, marker] of markersRef.current) {
        if (!seen.has(key)) {
          marker.map = null;
          markersRef.current.delete(key);
          labelsRef.current.delete(key);
          positionsRef.current.delete(key);
          dotsRef.current.delete(key);
          tagDataRef.current.delete(key);
          // A trailer can drop out of the pinned set while the cursor
          // is on it (a search keystroke, or its GPS going stale), and
          // a hovered key pointing at a pin that no longer exists
          // would keep the next pin that reuses the id looking hovered.
          if (hoveredKeyRef.current === key) hoveredKeyRef.current = null;
        }
      }

      // Fit the map to all pins exactly once, on the first plot with
      // data. After that, poll updates mutate pins without forcibly
      // re-centering (matching prior UX where the view stayed put).
      if (!didInitialFitRef.current && allPinned.length > 0) {
        didInitialFitRef.current = true;
        if (allPinned.length > 1) map.fitBounds(bounds, 60);
      }

      // Last, so brand-new pins start at the right size and any open
      // tag refreshes with this pass's data.
      repaintPins();
    });
  }, [mapReady, groups, assets, repaintPins, focusTrailer]);

  // ── Yard circles ──────────────────────────────────────────────────────
  // Redrawn whenever the yard set changes. Circles are not clickable:
  // a geofence that swallows clicks would make the pins underneath it
  // unselectable, and the pin is what a dispatcher is aiming for.
  const circlesRef = useRef<google.maps.Circle[]>([]);
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let cancelled = false;
    void loadGoogleMaps().then(google => {
      const map = mapRef.current;
      if (cancelled || !map) return;
      for (const c of circlesRef.current) c.setMap(null);
      circlesRef.current = yards.map(y => new google.maps.Circle({
        map,
        center: { lat: y.lat, lng: y.lng },
        radius: y.radiusMeters,
        strokeColor: YARD_COLOR,
        strokeOpacity: 0.9,
        strokeWeight: 1.5,
        fillColor: YARD_COLOR,
        fillOpacity: 0.12,
        clickable: false,
        zIndex: 1,
      }));
    });
    return () => {
      cancelled = true;
      for (const c of circlesRef.current) c.setMap(null);
      circlesRef.current = [];
    };
  }, [yards, mapReady]);

  // ── Click the map to drop a new yard ──────────────────────────────────
  // Only armed while `placing` is set, so an ordinary click on the map
  // never creates anything.
  useEffect(() => {
    if (!mapReady || !mapRef.current || !placing) return;
    const map = mapRef.current;
    const listener: google.maps.MapsEventListener = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      const { name, radiusFt } = placing;
      setPlacing(null);
      void (async () => {
        try {
          await addSavedLocation({
            name,
            lat: e.latLng!.lat(),
            lng: e.latLng!.lng(),
            radiusMeters: feetToMetres(radiusFt),
          });
          setYardError(null);
        } catch (err) {
          setYardError(err instanceof Error ? err.message : 'Could not save the yard');
        }
      })();
    });
    return () => listener.remove();
  }, [mapReady, placing, addSavedLocation]);

  // ── Selection effect ────────────────────────────────────────
  // Three things happen when a trailer becomes selected (whether the
  // click came from a pin or a sidebar row):
  //   1. The pin's dot grows and its tag opens above it — trailer
  //      number, category, last seen, and the truck + load if it's on
  //      one. (Hover does a smaller version of the same thing; both
  //      go through repaintPins.)
  //   2. The pin's zIndex is bumped so it draws above its neighbours
  //      and its tag isn't buried under their dots.
  //   3. The matching sidebar row scrolls into view — without this the
  //      highlight is invisible when the row is below the fold.
  //
  // Moving the MAP is deliberately not here: what it should do depends
  // on whether the click came from a pin or a roster row, which only
  // the click site knows. See focusTrailer.
  useEffect(() => {
    // One repaint handles both ends of the change: the pin that just
    // lost the selection shrinks and closes its tag, the one that
    // gained it grows and opens the full tag.
    selectedKeyRef.current = selectedTrailerId == null ? null : String(selectedTrailerId);
    repaintPins();

    if (selectedTrailerId == null) return;

    // Scroll the sidebar row into view. We use a data attribute rather
    // than threading refs through Section so the lookup stays simple
    // even as the row list re-orders (search filtering, etc.).
    if (typeof document !== 'undefined') {
      const row = document.querySelector<HTMLElement>(`[data-trailer-row-id="${selectedTrailerId}"]`);
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedTrailerId, repaintPins]);

  // Roster rows always centre — see focusTrailer.
  const selectFromRow = useCallback((id: number) => focusTrailer(id, 'row'), [focusTrailer]);

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

  const content = (
    <>
        {/* Header. Embedded, the title and icon would just repeat the
            page shell's own "Trailers" heading, so only the counts
            survive — as a slim strip above the map. */}
        <div
          className={`flex items-center gap-3 px-4 shrink-0 ${embedded ? 'py-2' : 'py-3'}`}
          style={{ borderBottom: '1px solid var(--gc-border)' }}
        >
          {!embedded && <Container size={18} style={{ color: 'var(--gc-blue)' }} />}
          <div className="flex-1 min-w-0">
            {!embedded && (
              <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                Trailer fleet
              </div>
            )}
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {totalCount} trailers · {activeCount} in use · {groups.noGps.length} without GPS
              {locLoading && <span className="ml-2"><Loader2 size={10} className="inline animate-spin" /></span>}
            </div>
          </div>
          {!embedded && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-full transition-colors shrink-0"
              style={{ color: 'var(--gc-text-3)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body: map + sidebar. In the modal the map is a fixed 620 of
            the 980 card; on the page it takes whatever the roster
            doesn't, so a wide monitor spends its pixels on the map. */}
        <div className="flex-1 flex min-h-0">
          {/* Map */}
          <div className="relative" style={embedded ? { flex: 1, minWidth: 0 } : { width: 620 }}>
            <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
            {locError && (
              <div className="absolute top-3 left-3 right-3 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'rgba(217,48,37,0.1)', border: '1px solid rgba(217,48,37,0.35)', color: '#d93025' }}>
                <AlertCircle size={12} className="inline mr-1" /> {locError}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div
            className={`flex flex-col min-h-0${embedded ? '' : ' flex-1'}`}
            style={{ borderLeft: '1px solid var(--gc-border)', ...(embedded ? { width: 400, flexShrink: 0 } : {}) }}
          >
            {/* Trailers / Yards. Only on the page: the toolbar popup
                is a glance-at-the-fleet tool, not somewhere to
                administer geofences. */}
            {embedded && (
              <div className="flex gap-1 px-3 pt-2.5 shrink-0">
                {(['trailers', 'yards'] as const).map(tab => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => { setRail(tab); if (tab === 'trailers') setPlacing(null); }}
                    className="text-[12px] font-semibold capitalize"
                    style={{
                      padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                      border: `1px solid ${rail === tab ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                      background: rail === tab ? 'var(--gc-blue)' : 'transparent',
                      color: rail === tab ? '#fff' : 'var(--gc-text-2)',
                    }}
                  >
                    {tab === 'yards' ? `Yards${yards.length ? ` (${yards.length})` : ''}` : 'Trailers'}
                  </button>
                ))}
              </div>
            )}

            {rail === 'trailers' && (<>
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
                  yardName: yardAt(loc.lat, loc.lon, yards)?.name,
                  locationLabel: loc.description || undefined,
                  detail: {
                    driver: driverName(usage.load),
                    asset:  assetName(usage.load),
                    route:  routeLabel(usage.load),
                    status: usage.load?.status,
                  },
                }))}
                selectedId={selectedTrailerId}
                onSelect={selectFromRow}
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
                  yardName: yardAt(loc.lat, loc.lon, yards)?.name,
                  locationLabel: loc.description || undefined,
                }))}
                selectedId={selectedTrailerId}
                onSelect={selectFromRow}
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
                onSelect={selectFromRow}
                dim
              />
              {totalCount === 0 && (
                <div className="px-4 py-8 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                  {query ? `No trailers match "${query}".` : 'No active trailers in the fleet yet.'}
                </div>
              )}
            </div>
            </>)}

            {rail === 'yards' && (
              <YardsRail
                yards={yards}
                locations={savedLocations}
                placing={placing}
                error={yardError}
                onStartPlacing={(name, radiusFt) => { setYardError(null); setPlacing({ name, radiusFt }); }}
                onCancelPlacing={() => setPlacing(null)}
                onSetRadius={(id, radiusFt) => { void updateSavedLocation(id, { radiusMeters: feetToMetres(radiusFt) }); }}
                onClearYard={(id) => { void updateSavedLocation(id, { radiusMeters: null }); }}
                onFocus={(y) => { mapRef.current?.panTo({ lat: y.lat, lng: y.lng }); }}
              />
            )}
          </div>
        </div>
    </>
  );

  if (embedded) {
    return (
      <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--gc-surface)' }}>
        {content}
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={e => { if (e.target === overlayRef.current) onClose?.(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden"
        style={{ width: 980, height: 720, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
      >
        {content}
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
    /** Name of the yard this trailer is parked inside, if any. */
    yardName?: string;
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
      {rows.map(({ trailer, badge, badgeColor, lastSeen, locationLabel, yardName, detail }) => {
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
            {yardName && (
              <div className="mt-1.5 text-[11px] flex items-center gap-1" style={{ color: YARD_COLOR, fontWeight: 600 }}>
                <Container size={10} />
                <span className="truncate">At {yardName}</span>
              </div>
            )}
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

/**
 * YardsRail — manage the geofences shown on the map.
 *
 * Two ways in, because there are two situations. A place dispatch
 * already has as a stop preset (SLC Yard has been one since the HOS
 * work) just needs a radius — promoting it keeps one row, so the
 * preset and the geofence can never drift apart. Somewhere not yet on
 * file gets named here and placed by clicking the map, which beats
 * typing coordinates for a gravel lot with no address.
 *
 * "Remove" clears the radius rather than deleting the location: these
 * rows are also the stop presets the load modal offers, and dropping
 * one because a geofence is no longer wanted would quietly take a
 * preset with it.
 */
function YardsRail({
  yards, locations, placing, error,
  onStartPlacing, onCancelPlacing, onSetRadius, onClearYard, onFocus,
}: {
  yards: Yard[];
  locations: SavedLocation[];
  placing: { name: string; radiusFt: number } | null;
  error: string | null;
  onStartPlacing: (name: string, radiusFt: number) => void;
  onCancelPlacing: () => void;
  onSetRadius: (id: string, radiusFt: number) => void;
  onClearYard: (id: string) => void;
  onFocus: (yard: Yard) => void;
}) {
  const [newName, setNewName] = useState('');
  const yardIds = new Set(yards.map(y => y.id));
  // Candidates for promotion: already geocoded, not already a yard.
  const promotable = locations.filter(l =>
    !yardIds.has(l.id) && typeof l.lat === 'number' && typeof l.lng === 'number');

  return (
    <div className="flex-1 overflow-auto">
      {/* Add */}
      <div className="px-3 py-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        {placing ? (
          <div className="rounded-lg px-3 py-2.5 text-[12px]"
            style={{ background: 'rgba(26,115,232,0.08)', border: `1px solid ${YARD_COLOR}` }}>
            <div className="flex items-center gap-1.5 font-semibold" style={{ color: YARD_COLOR }}>
              <Crosshair size={12} /> Click the map to place “{placing.name}”
            </div>
            <div className="mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {placing.radiusFt.toLocaleString()} ft radius · adjustable after
            </div>
            <button
              type="button"
              onClick={onCancelPlacing}
              className="mt-2 text-[11px] font-semibold"
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--gc-text-2)' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newName.trim()) {
                  onStartPlacing(newName.trim(), DEFAULT_YARD_RADIUS_FT);
                  setNewName('');
                }
              }}
              placeholder="New yard name"
              className="flex-1 text-[13px] outline-none"
              style={{
                padding: '7px 10px', border: '1px solid var(--gc-border)',
                borderRadius: 8, background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
              }}
            />
            <button
              type="button"
              disabled={!newName.trim()}
              onClick={() => { onStartPlacing(newName.trim(), DEFAULT_YARD_RADIUS_FT); setNewName(''); }}
              className="text-[12px] font-semibold inline-flex items-center gap-1"
              style={{
                padding: '7px 11px', borderRadius: 8, border: 'none',
                background: newName.trim() ? YARD_COLOR : 'var(--gc-border)',
                color: '#fff', cursor: newName.trim() ? 'pointer' : 'default',
              }}
            >
              <Plus size={13} /> Place
            </button>
          </div>
        )}
        {error && (
          <div className="mt-2 text-[11px]" style={{ color: '#d93025' }}>
            <AlertCircle size={11} className="inline mr-1" />{error}
          </div>
        )}
      </div>

      {/* Existing yards */}
      {yards.length === 0 && !placing && (
        <div className="px-4 py-6 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
          No yards yet. Name one above and click the map to place it, or give
          a saved location a radius below.
        </div>
      )}
      {yards.map(y => (
        <div key={y.id} className="px-4 py-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onFocus(y)}
              className="flex-1 min-w-0 text-left text-[13px] font-semibold truncate"
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--gc-text-1)' }}
            >
              {y.name}
            </button>
            <button
              type="button"
              onClick={() => onClearYard(y.id)}
              title="Stop treating this location as a yard (keeps the saved location)"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: 2 }}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="number"
              min={50}
              step={50}
              defaultValue={metresToFeet(y.radiusMeters)}
              onBlur={e => {
                const ft = Number(e.target.value);
                if (Number.isFinite(ft) && ft > 0 && feetToMetres(ft) !== y.radiusMeters) onSetRadius(y.id, ft);
              }}
              className="text-[12px] outline-none tabular-nums"
              style={{
                width: 84, padding: '4px 8px', border: '1px solid var(--gc-border)',
                borderRadius: 6, background: 'var(--gc-surface)', color: 'var(--gc-text-1)',
              }}
            />
            <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>ft radius</span>
          </div>
        </div>
      ))}

      {/* Promote an existing preset */}
      {promotable.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Saved locations
          </div>
          {promotable.map(l => (
            <div key={l.id} className="flex items-center gap-2 py-1.5">
              <span className="flex-1 min-w-0 truncate text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                {l.name}
              </span>
              <button
                type="button"
                onClick={() => onSetRadius(l.id, DEFAULT_YARD_RADIUS_FT)}
                className="text-[11px] font-semibold"
                style={{
                  padding: '3px 9px', borderRadius: 6,
                  border: `1px solid ${YARD_COLOR}`, background: 'transparent',
                  color: YARD_COLOR, cursor: 'pointer',
                }}
              >
                Make a yard
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
