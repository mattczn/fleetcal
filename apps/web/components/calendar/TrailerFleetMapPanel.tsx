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
 *       Hooked (no live load, but a finished one left it behind a
 *               tractor and nothing since unhooked it — see
 *               lib/trailerUsage.ts for what ends a hookup)
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
import { X, MapPin, Container, AlertCircle, Loader2, Search, Clock, Plus, Trash2, Crosshair, ShieldAlert, WifiOff, ParkingCircle, HelpCircle, Truck } from 'lucide-react';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import { useCalendarStore } from '@/store/useCalendarStore';
import { getTrailerUsage, type TrailerUsage } from '@/lib/trailerUsage';
import type { MotiveTrailerLocation } from '@/app/api/motive/trailer-locations/route';
import { yardsFrom, yardAt, feetToMetres, metresToFeet, DEFAULT_YARD_RADIUS_FT, type Yard } from '@/lib/yards';
import {
  isDark, isStatic, hoursSince, formatStill, formatAge, formatDwell,
  STILL_ALERT_DAYS, DARK_ALERT_HOURS, type Stillness,
} from '@/lib/trailerStillness';
import TrailerDetailPanel, { type TrailerDetailData } from '@/components/trailers/TrailerDetailPanel';
import type { TrailerSegment } from '@/lib/trailerHistory';
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
  hooked: '#e8710a',  // orange
  idle:   '#1e8e3e',  // green
} as const;

// Yards are drawn in blue, deliberately not red or green: those two
// already mean "this trailer is busy / free", and a geofence is not a
// third trailer state.
const YARD_COLOR = '#1a73e8';

// One colour for "this needs a look", whatever the reason. Red and
// green already mean busy/free on this map, so a third and fourth
// status hue would turn the pins into a quiz; the rail says which kind
// of attention it wants.
const ALERT_COLOR = '#f9ab00';

const POLL_MS = 60_000;
// The history sweep runs hourly and a park is measured in days, so
// re-deriving this every minute would be pure waste.
const STILLNESS_POLL_MS = 5 * 60_000;
const CLOCK_TICK_MS = 60_000;
// Matt's window. The route caps at 90, so this is one number to change
// if a week turns out to be too short to answer "where has it been".
const HISTORY_DAYS = 7;
// The trail the selected trailer left, drawn under the pins.
const TRAIL_COLOR = '#1a73e8';
// How long after a pin click the map's own click handler stays quiet.
// Long enough to cover the two events arriving from one physical
// click, short enough that a deliberate second click always lands.
const PIN_CLICK_GRACE_MS = 350;

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
  /** The tractor this trailer is linked to — on a live load, or left
   *  behind it by the last one. Absent when nothing has it. */
  truck?:     { name: string; color: string };
  /** False when `truck` comes from a FINISHED load (usage 'hooked')
   *  rather than one running now. The pin is drawn dimmed and the tag
   *  says "last load", so a leftover hookup can't be misread as a
   *  truck that's currently rolling. */
  linkLive?:  boolean;
  loadTitle?: string;
  /** "Parked 3d 4h at SLC Yard", "No fix in 21d" — the stillness line.
   *  Absent until the history sweep has something to say. */
  dwell?:     string;
  /** On the alert list, so the glyph wears the attention ring. */
  flagged?:   boolean;
  /** Colour for the plain-dot form — the red/green in-use/idle status.
   *  Unused when `truck` is set, since that pin is drawn in the
   *  truck's own colour instead. */
  dotColor:   string;
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

/**
 * Build the marker's DOM. Three pieces, all repainted later rather
 * than baked in here, because a trailer gets hooked to a truck without
 * its pin ever being recreated:
 *
 *   labelEl — the hover / click tag, ABOVE the glyph, hidden by default.
 *   dot     — the glyph itself: a status circle, or a truck-coloured
 *              badge once the trailer is pulling a load.
 *   chipEl  — the always-on "2020 · #633453 Swing" label, BELOW the
 *              glyph, shown only for a trailer under a truck.
 *
 * chipEl is absolutely positioned on purpose. The marker anchors the
 * wrapper's bottom centre at the trailer's coordinates, so a chip in
 * normal flow would push the glyph up off the point it marks.
 */
function makePinElement(): {
  wrapper: HTMLDivElement; labelEl: HTMLDivElement; dot: HTMLDivElement; chipEl: HTMLDivElement;
} {
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
    'display:flex', 'align-items:center', 'justify-content:center',
    'border:2.5px solid white',
    `box-shadow:${PIN_SHADOW.idle}`,
    // Grown with a transform rather than by changing width/height, so
    // enlarging the glyph never reflows the tag stacked above it. The
    // marker anchors this wrapper's bottom centre at the trailer's
    // coordinates, so a layout change here would visibly jump the pin.
    'transform-origin:center',
    'transition:transform 120ms ease-out, box-shadow 120ms ease-out',
  ].join(';');

  const chipEl = document.createElement('div');
  chipEl.style.cssText = [
    'display:none',
    'position:absolute',
    'top:calc(100% + 5px)',
    'left:50%',
    'transform:translateX(-50%)',
    'padding:2px 7px',
    'border-radius:5px',
    'background:rgba(32,33,36,0.86)',
    'color:#ffffff',
    'font-size:10px',
    'font-weight:600',
    'white-space:nowrap',
    'pointer-events:none',
  ].join(';');

  wrapper.appendChild(labelEl);
  wrapper.appendChild(dot);
  wrapper.appendChild(chipEl);
  return { wrapper, labelEl, dot, chipEl };
}

/** A truck seen from above, as an inline SVG. Inline rather than a
 *  lucide component because this marker is built with DOM calls, not
 *  rendered by React. */
function truckGlyphSvg(): string {
  return [
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"',
    ' stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">',
    '<path d="M3 7h10v9H3z"/><path d="M13 10h4l4 3.5V16h-8z"/>',
    '<circle cx="7" cy="18.5" r="1.6" fill="#ffffff"/>',
    '<circle cx="17.5" cy="18.5" r="1.6" fill="#ffffff"/>',
    '</svg>',
  ].join('');
}

/**
 * Draw the glyph for a pin's current state.
 *
 * A trailer under a truck stops being a dot and becomes a rounded
 * badge in THAT TRUCK's calendar colour carrying a truck mark — the
 * shape says "this one is moving with a tractor", the colour says
 * which tractor. A trailer on its own keeps the status circle, where
 * the colour means in-use / idle instead.
 *
 * Repainted every plot pass, so a trailer hooked to a truck between
 * two polls changes shape without its marker being rebuilt.
 */
function paintPinGlyph(dot: HTMLDivElement, tag: PinTag): void {
  if (tag.truck) {
    dot.style.width = '22px';
    dot.style.height = '22px';
    dot.style.borderRadius = '7px';
    dot.style.background = tag.truck.color;
    // A hookup left over from a finished load is faded rather than
    // recoloured: the truck's own colour is how it's recognised, so
    // swapping it would cost the identification to say something the
    // tag says in words anyway. Dimmed reads as "was", which is
    // exactly the claim.
    dot.style.opacity = tag.linkLive === false ? '0.6' : '1';
    if (!dot.firstChild) dot.innerHTML = truckGlyphSvg();
    return;
  }
  dot.style.width = '16px';
  dot.style.height = '16px';
  dot.style.borderRadius = '50%';
  dot.style.background = tag.dotColor;
  dot.style.opacity = '1';
  if (dot.firstChild) dot.replaceChildren();
}

/**
 * The always-on label under a moving trailer: "2020 · #633453 Swing".
 *
 * Only for trailers under a truck. Showing it for all of them would
 * be unreadable — most of the fleet sits in two yards, and their
 * labels would stack into a block of text. The ones under a tractor
 * are spread out along a highway, which is exactly where a label you
 * don't have to hover for earns its place.
 */
function paintPinChip(chipEl: HTMLDivElement, tag: PinTag): void {
  if (!tag.truck) {
    chipEl.style.display = 'none';
    return;
  }
  chipEl.textContent = [tag.truck.name, [tag.heading, tag.category].filter(Boolean).join(' ')]
    .filter(Boolean).join(' · ');
  // Matches the pin it hangs under: solid while the load is running,
  // washed out once the link is only the last load's.
  chipEl.style.background = tag.linkLive === false
    ? 'rgba(32,33,36,0.52)'
    : 'rgba(32,33,36,0.86)';
  chipEl.style.display = 'block';
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
      // One word, because the whole point of the hover tag is that
      // it's readable at a glance: "hooked" says the truck is the
      // last one that had it, not one on a load right now.
      if (tag.linkLive === false) {
        const note = document.createElement('span');
        note.textContent = 'hooked';
        note.style.cssText = 'font-size:10px;color:#80868b;';
        row.appendChild(note);
      }
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

  // Line 3 — how long it has been sitting here, which is the question
  // the position alone can't answer. Amber when it's on the alert
  // list, so the tag and the ring on the dot agree.
  if (tag.dwell) {
    const dwell = document.createElement('div');
    dwell.textContent = tag.dwell;
    dwell.style.cssText = `font-size:10px;font-weight:${tag.flagged ? 700 : 400};color:${tag.flagged ? '#b06000' : '#5f6368'};white-space:nowrap;`;
    el.appendChild(dwell);
  }

  // Line 4 — truck + load, which turn "where is it" into "what is it
  // doing". Present for a trailer on a running load, and for one a
  // finished load left behind a tractor.
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

    // On a live load the title sits inline with the truck. On a
    // leftover hookup it moves to its own line prefixed "Last load",
    // because inline it would read as what the truck is doing now.
    if (tag.loadTitle && tag.linkLive !== false) {
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

    if (tag.linkLive === false) {
      const note = document.createElement('div');
      note.textContent = tag.loadTitle
        ? `Last load · ${tag.loadTitle}`
        : 'Still hooked · no live load';
      note.style.cssText = 'font-size:10px;color:#5f6368;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      el.appendChild(note);
    }
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
  chipEl: HTMLDivElement | undefined,
): void {
  if (dot && tag) paintPinGlyph(dot, tag);
  if (chipEl && tag) paintPinChip(chipEl, tag);
  if (dot) {
    dot.style.transform = PIN_SCALE[mode];
    // The ring is composed in front of the drop shadow rather than
    // replacing it, so a flagged pin still reads as raised.
    dot.style.boxShadow = tag?.flagged
      ? `0 0 0 3.5px ${ALERT_COLOR}, ${PIN_SHADOW[mode]}`
      : PIN_SHADOW[mode];
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

/**
 * Why a trailer is on the alert list.
 *
 * Four kinds, deliberately not collapsed into one "stale" number,
 * because they call for different actions:
 *
 *   dark        — the tracker stopped reporting. Could be a dead
 *                 gateway battery; could be that the trailer is
 *                 somewhere it shouldn't be. Needs no stored history:
 *                 Motive's own located_at is already old.
 *   static_away — reporting fine, hasn't moved past the 2-day rule,
 *                 and is NOT inside a known yard. The one that most
 *                 often means "go look at this".
 *   static_yard — same, but it's sitting in one of our yards. Matt's
 *                 rule says flag anything over 2 days, so it is
 *                 listed; it's separated rather than suppressed
 *                 because a spare parked at the terminal for a week is
 *                 ordinary and would otherwise bury the rest.
 *   untracked   — no Motive link, or linked but Motive has never
 *                 returned a position. Not monitorable at all, which
 *                 is itself worth knowing.
 */
type TrailerAlertKind = 'dark' | 'static_away' | 'static_yard' | 'untracked';

interface TrailerAlert {
  trailer:        Trailer;
  kind:           TrailerAlertKind;
  /** Hours since Motive's last fix. Null for an untracked trailer. */
  fixAgeHours:    number | null;
  still:          Stillness | null;
  yardName?:      string;
  locationLabel?: string;
}

// The tab badge counts only the kinds that mean "go look at this".
// Including the untracked trailers would pin the badge at 5 forever on
// Curzon's fleet, and a badge that never goes to zero stops being read.
const BADGED_KINDS = new Set<TrailerAlertKind>(['dark', 'static_away']);

export default function TrailerFleetMapPanel({ onClose, embedded = false }: Props) {
  const { trailers, events, drivers, assets, calendarTimezone, savedLocations } = useCalendarStore();
  // Needed to tell a real tractor from the Unassigned placeholder
  // every load sits on until it's dispatched — a load parked there
  // must not leave a trailer "hooked" to a truck that doesn't exist.
  const unassignedAssetId = useCalendarStore(s => s.unassignedAssetId);
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
  // The always-on "truck · trailer" chip under a moving trailer's pin.
  const chipsRef     = useRef<Map<string, HTMLDivElement>>(new Map());
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
  // When a pin was last clicked. The map's own click handler ignores
  // anything inside a short window after it, so selecting a pin can
  // never immediately deselect itself. The Maps API is not supposed to
  // let a marker click reach the map at all, but "not supposed to" is
  // the wrong thing to hang a selection on when the cost of being
  // wrong is a feature that silently does nothing.
  const pinClickAtRef  = useRef(0);

  const [locations,  setLocations]  = useState<Record<string, MotiveTrailerLocation>>({});
  // Derived from the stored location history (see
  // /api/trailers/stillness). Empty until the hourly sweep in apps/api
  // has written something, which is also the honest state for the
  // first days after it goes live.
  const [stillness, setStillness] = useState<Record<string, Stillness>>({});
  const [historyStartedAt, setHistoryStartedAt] = useState<string | null>(null);
  // The selected trailer's own recent life. Fetched per selection
  // rather than for the whole fleet: a week of 2-minute fixes for 27
  // trailers is a lot of JSON to hand the browser for a panel showing
  // one of them.
  const [history, setHistory] = useState<
    { trailerId: number; path: Array<{ lat: number; lon: number }>; segments: TrailerSegment[] } | null
  >(null);
  // No separate loading flag: "loading" is exactly "the history we
  // hold isn't this trailer's yet", which is derivable, and storing it
  // instead would mean a synchronous setState inside the fetch effect.
  // A failed fetch records an EMPTY result for the trailer rather than
  // leaving the spinner up forever — the panel then says "no stored
  // history yet", which is also what it would say if the sweep simply
  // hadn't reached this trailer.
  // The alert rules compare timestamps against the clock, which makes
  // them a function of time as well as of data: a trailer crosses the
  // 2-day line with nothing else on the page changing. Holding "now"
  // in state keeps the memo below pure — no Date.now() during render,
  // which would memoise a stale clock — and makes the crossing
  // actually happen. A minute is plenty for thresholds in days.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const [locLoading, setLocLoading] = useState(false);
  const [locError,   setLocError]   = useState<string | null>(null);
  const [selectedTrailerId, setSelectedTrailerId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  // Which half of the rail is showing. Yards only on the page — the
  // toolbar popup is a glance-at-the-fleet tool, not somewhere to
  // administer geofences.
  const [rail, setRail] = useState<'trailers' | 'yards' | 'alerts'>('trailers');
  // How the Trailers rail is grouped. Status answers "what's free";
  // location answers "what's accounted for at the yard", which is a
  // different question and wants a different list, not a sort.
  const [grouping, setGrouping] = useState<'status' | 'location'>('status');
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
      applyPinVisual(
        mode,
        dotsRef.current.get(key),
        labelsRef.current.get(key),
        marker,
        tagDataRef.current.get(key),
        chipsRef.current.get(key),
      );
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
    if (source === 'pin') pinClickAtRef.current = Date.now();
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

  // ── Poll the stillness history ────────────────────────────
  // Far slower than the position poll, because this changes on the
  // hour at most: it is derived from a sweep that runs hourly, and a
  // park measured in days does not need a 60s refresh. The route also
  // caches per-org for 5 minutes, so a dispatcher reopening the page
  // doesn't re-read the history table.
  //
  // A failure here is silent on purpose. The map still works without
  // it; losing the dwell line is not worth a red banner, and before
  // the migration runs the route legitimately has nothing to return.
  useEffect(() => {
    let cancelled = false;
    const fetchStillness = async () => {
      try {
        const res = await fetch('/api/trailers/stillness');
        if (!res.ok) return;
        const json = await res.json() as {
          stillness?: Record<string, Stillness>;
          historyStartedAt?: string | null;
        };
        if (cancelled) return;
        setStillness(json.stillness ?? {});
        setHistoryStartedAt(json.historyStartedAt ?? null);
      } catch {
        // see above — deliberately quiet
      }
    };
    void fetchStillness();
    const id = setInterval(fetchStillness, STILLNESS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Compute usage + grouping ──────────────────────────────────────────
  // Group every (non-retired) trailer into Active / Hooked / Idle / No
  // GPS, then filter by the search query. Filtering AFTER grouping
  // keeps the section labels honest: "Active 0" still appears if the
  // user has typed a query that doesn't match any active trailer,
  // rather than silently shifting items between sections.
  //
  // The yard geofences feed getTrailerUsage because being parked in
  // one of our yards is what ends a hookup (see trailerUsage.ts) —
  // the trailer is home and accounted for, so it goes back to being a
  // spare whatever brought it there.
  const groups = useMemo(() => {
    type RowWithLoc = { trailer: Trailer; usage: TrailerUsage; loc: MotiveTrailerLocation };
    type RowNoGps   = { trailer: Trailer; usage: TrailerUsage };
    const active: RowWithLoc[] = [];
    const hooked: RowWithLoc[] = [];
    const idle:   RowWithLoc[] = [];
    const noGps:  RowNoGps[]   = [];

    for (const t of trailers) {
      if (t.activeTo) continue;  // retired — out of the fleet view
      if (!trailerMatchesQuery(t, query)) continue;
      const loc = t.motiveVehicleId ? locations[t.motiveVehicleId] : undefined;
      // A trailer with no fix gets atYard: false — not because it
      // isn't in a yard, but because we can't know. Leaving the hook
      // standing is the useful answer there: who had it last is the
      // only thing known about an untracked trailer at all.
      const usage = getTrailerUsage(t.id, events, calendarTimezone, {
        atYard: loc ? yardAt(loc.lat, loc.lon, yards) != null : false,
        unassignedAssetId,
      });
      if (!loc) {
        noGps.push({ trailer: t, usage });
        continue;
      }
      (usage.status === 'in_use' ? active
        : usage.status === 'hooked' ? hooked
        : idle).push({ trailer: t, usage, loc });
    }
    // Everything with a pin on the map, in one list — the orderings
    // that don't care about status (the plot pass, the by-location
    // grouping) read this so a fourth bucket can't be forgotten in
    // one of them.
    return { active, hooked, idle, noGps, pinned: [...active, ...hooked, ...idle] };
  }, [trailers, events, locations, calendarTimezone, query, yards, unassignedAssetId]);

  // ── The selected trailer's history ─────────────────────────
  // Only on the page: the detail panel it feeds is a third column,
  // which the 980px calendar popup has no room for.
  useEffect(() => {
    // No clearing of `history` here. Every reader already checks
    // that the history it holds belongs to the selected trailer, so
    // stale data is ignored rather than blanked — which keeps this
    // effect free of a synchronous setState.
    if (!embedded || selectedTrailerId == null) return;
    let cancelled = false;
    const id = selectedTrailerId;
    void (async () => {
      const empty = { trailerId: id, path: [], segments: [] as TrailerSegment[] };
      try {
        const res = await fetch(`/api/trailers/${id}/history?days=${HISTORY_DAYS}`);
        if (!res.ok) { if (!cancelled) setHistory(empty); return; }
        const json = await res.json() as typeof empty;
        // A slow response for a trailer the dispatcher has already
        // clicked away from must not overwrite the current one.
        if (cancelled || json.trailerId !== id) return;
        setHistory(json);
      } catch {
        if (!cancelled) setHistory(empty);
      }
    })();
    return () => { cancelled = true; };
  }, [embedded, selectedTrailerId]);

  // ── Alerts ─────────────────────────────────────────────────
  // Built from `trailers` rather than `groups` on purpose: the search
  // box belongs to the Trailers tab, and a typo there must not hide a
  // trailer that needs looking at.
  //
  // `dark` short-circuits `static`: once a tracker stops reporting we
  // don't know whether the trailer moved, and claiming "hasn't moved
  // in 9 days" from a 9-day-old fix would be the most misleading thing
  // on the page.
  const alerts = useMemo(() => {
    const now = nowMs;
    const out: TrailerAlert[] = [];
    for (const t of trailers) {
      if (t.activeTo) continue;
      const loc = t.motiveVehicleId ? locations[t.motiveVehicleId] : undefined;
      if (!loc) {
        out.push({ trailer: t, kind: 'untracked', fixAgeHours: null, still: null });
        continue;
      }
      const fixAgeHours   = hoursSince(loc.locatedAt, now);
      const still         = stillness[String(t.id)] ?? null;
      const yardName      = yardAt(loc.lat, loc.lon, yards)?.name;
      const locationLabel = loc.description || undefined;
      if (isDark(loc.locatedAt, now)) {
        out.push({ trailer: t, kind: 'dark', fixAgeHours, still, yardName, locationLabel });
        continue;
      }
      if (still && isStatic(still, now)) {
        out.push({
          trailer: t,
          kind: yardName ? 'static_yard' : 'static_away',
          fixAgeHours, still, yardName, locationLabel,
        });
      }
    }
    return out;
  }, [trailers, locations, stillness, yards, nowMs]);

  const alertBadgeCount = useMemo(
    () => alerts.filter(a => BADGED_KINDS.has(a.kind)).length,
    [alerts],
  );

  // Which trailers wear the ring on the map. Only the two actionable
  // kinds: ringing every untracked trailer and every spare parked in
  // the yard would ring most of the fleet.
  const flaggedIds = useMemo(() => {
    const s = new Set<number>();
    for (const a of alerts) if (BADGED_KINDS.has(a.kind)) s.add(a.trailer.id);
    return s;
  }, [alerts]);

  // ── Grouped by where they are ───────────────────────────
  // One section per yard, then everything else, then the untracked.
  //
  // Deliberately NOT a city clusterer. Motive's labels run from "Salt
  // Lake City, UT" to "3.3 mi SW of Cheyenne, WY", and guessing a
  // place out of the second kind would invent groupings that are
  // sometimes wrong — which is worse than none when the question is
  // "is this trailer accounted for". Yards are exact because you drew
  // them; everything else is sorted by address, which clusters the
  // same-city ones together anyway since the label leads with it.
  //
  // In-use trailers are included: where a trailer IS doesn't stop
  // being true because it's under a load.
  const byLocation = useMemo(() => {
    const pinned = groups.pinned;
    const atYard = new Map<string, typeof pinned>();
    const elsewhere: typeof pinned = [];
    for (const entry of pinned) {
      const yard = yardAt(entry.loc.lat, entry.loc.lon, yards);
      if (!yard) { elsewhere.push(entry); continue; }
      const list = atYard.get(yard.id) ?? [];
      list.push(entry);
      atYard.set(yard.id, list);
    }
    elsewhere.sort((a, b) => (a.loc.description || '').localeCompare(b.loc.description || ''));
    // Fullest yard first — that's the one worth checking against.
    const sections = yards
      .map(y => ({ yard: y, rows: atYard.get(y.id) ?? [] }))
      .filter(s => s.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length);
    return { sections, elsewhere };
  }, [groups, yards]);

  // ── The selected trailer, assembled ──────────────────────
  // "Last connected vehicle" and "last driver" come from OUR LOADS,
  // not from Motive. Motive reports the tractor its gateway last drew
  // power from, which is a reasonable guess about hardware;
  // events.assetId is what dispatch actually assigned, which is the
  // answer to "who had it". Where the two disagree, dispatch is right
  // about intent, and intent is what this panel is for.
  const detailData = useMemo<TrailerDetailData | null>(() => {
    if (!embedded || selectedTrailerId == null) return null;
    const trailer = trailers.find(t => t.id === selectedTrailerId);
    if (!trailer) return null;

    const loc   = trailer.motiveVehicleId ? locations[trailer.motiveVehicleId] : undefined;
    const usage = getTrailerUsage(trailer.id, events, calendarTimezone, {
      atYard: loc ? yardAt(loc.lat, loc.lon, yards) != null : false,
      unassignedAssetId,
    });
    const still = stillness[String(trailer.id)];

    const recent = events
      .filter(e => e.trailerId === trailer.id && !e.deletedAt)
      .sort((a, b) => b.start.localeCompare(a.start));

    const truckLoad  = recent.find(e => e.assetId != null);
    const truckAsset = truckLoad ? assets.find(a => a.id === truckLoad.assetId) : undefined;

    const driverLoad = recent.find(e => e.driverName || e.driverId != null);
    const driverLabel = driverLoad
      ? (driverLoad.driverName ?? drivers.find(d => d.id === driverLoad.driverId)?.name)
      : undefined;

    return {
      trailer,
      status:         usage.status,
      address:        loc?.description || undefined,
      yardName:       loc ? yardAt(loc.lat, loc.lon, yards)?.name : undefined,
      fixAgeHours:    hoursSince(loc?.locatedAt, nowMs),
      stillHours:     still?.stillHours ?? null,
      stillTruncated: still?.truncated ?? true,
      currentLoad:    usage.load,
      lastTruck:  truckLoad && truckAsset ? { asset: truckAsset, at: truckLoad.start } : undefined,
      lastDriver: driverLoad && driverLabel ? { name: driverLabel, at: driverLoad.start } : undefined,
      recentLoads: recent.slice(0, 6),
    };
  }, [embedded, selectedTrailerId, trailers, events, calendarTimezone, locations, stillness, yards, assets, drivers, nowMs, unassignedAssetId]);

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

      const allPinned = groupsRef.current.pinned;
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
      chipsRef.current.clear();
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

      const allPinned = groups.pinned;
      const seen = new Set<string>();
      const bounds = new google.maps.LatLngBounds();

      for (const entry of allPinned) {
        const key = String(entry.trailer.id);
        seen.add(key);
        const color = STATUS_PIN_COLOR[entry.usage.status];
        const lastSeen = formatLastSeen(entry.loc.locatedAt);
        const load = entry.usage.load;
        // Set for an in-use trailer and for a hooked one (where it's
        // the load that left it on that truck); absent when idle, so
        // an idle pin's tag simply has no truck line rather than an
        // empty one.
        const truck = load ? assets.find(a => a.id === load.assetId) : undefined;
        const linkLive = entry.usage.status === 'in_use';
        const tag: PinTag = {
          // Prefers the trailer number (what dispatchers actually call
          // them) and falls back to the display name.
          heading: entry.trailer.trailerNumber
            ? `#${entry.trailer.trailerNumber}`
            : entry.trailer.name,
          category: entry.trailer.category,
          lastSeen,
          truck: truck ? { name: truck.name, color: truck.color } : undefined,
          linkLive,
          // routeLabel is the fallback because a load with no typed
          // title still has stops, and "Las Vegas, NV → Salt Lake
          // City, UT" beats a blank line.
          loadTitle: load ? (load.title || routeLabel(load)) : undefined,
          dwell: dwellLine(entry.trailer.id, entry.loc, stillness, yards),
          flagged: flaggedIds.has(entry.trailer.id),
          dotColor: color,
        };
        const position = { lat: entry.loc.lat, lng: entry.loc.lon };

        const existing = markersRef.current.get(key);
        if (existing) {
          // Update the survivor in place — moving the pin without
          // recreating the AdvancedMarkerElement or its listeners.
          existing.position = position;
        } else {
          const { wrapper, labelEl, dot, chipEl } = makePinElement();

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
          chipsRef.current.set(key, chipEl);
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
          chipsRef.current.delete(key);
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
  }, [mapReady, groups, assets, repaintPins, focusTrailer, stillness, yards, flaggedIds]);

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

  // ── Draw the selected trailer's trail ───────────────────
  // A polyline through the actual fixes, because the route taken is
  // the thing no list of start/end pairs can show. Drawn beneath the
  // pins and non-clickable so it never swallows a click meant for a
  // marker or for the empty-map deselect.
  const trailRef = useRef<google.maps.Polyline | null>(null);
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let cancelled = false;
    const pts = history && history.trailerId === selectedTrailerId ? history.path : [];
    void loadGoogleMaps().then(google => {
      const map = mapRef.current;
      if (cancelled || !map) return;
      trailRef.current?.setMap(null);
      trailRef.current = null;
      if (pts.length < 2) return;
      trailRef.current = new google.maps.Polyline({
        map,
        path: pts.map(p => ({ lat: p.lat, lng: p.lon })),
        strokeColor: TRAIL_COLOR,
        strokeOpacity: 0.65,
        strokeWeight: 3,
        clickable: false,
        zIndex: 2,
      });
    });
    return () => {
      cancelled = true;
      trailRef.current?.setMap(null);
      trailRef.current = null;
    };
  }, [mapReady, history, selectedTrailerId]);

  // ── Click empty map to clear the selection ────────────────────
  // Clicking away closes the open detail. Going from one pin to the
  // next still just moves the selection: a marker click is handled by
  // the marker, and the guard below covers the case where it reaches
  // the map anyway. Yard circles are clickable:false, so a click
  // inside a yard counts as empty map and clears too.
  //
  // Suspended while `placing`: that click is placing a yard, and the
  // effect below owns it.
  useEffect(() => {
    if (!mapReady || !mapRef.current || placing) return;
    const listener = mapRef.current.addListener('click', () => {
      if (Date.now() - pinClickAtRef.current < PIN_CLICK_GRACE_MS) return;
      setSelectedTrailerId(null);
    });
    return () => listener.remove();
  }, [mapReady, placing]);

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
  /** The tractor's calendar colour. On the calendar the colour IS how
   *  a dispatcher recognises a truck, so carrying it into the roster
   *  row makes the row and the map pin name the same tractor the same
   *  way — the name alone makes you read before you recognise. */
  function assetColor(load: CalendarEvent | undefined): string | undefined {
    if (!load) return undefined;
    return assets.find(x => x.id === load.assetId)?.color;
  }

  // One row shape for both groupings — the list is regrouped, not
  // redesigned, so a trailer reads the same wherever it appears.
  function rowFor(entry: { trailer: Trailer; usage: TrailerUsage; loc: MotiveTrailerLocation }) {
    const status = entry.usage.status;
    return {
      trailer: entry.trailer,
      badge: status === 'in_use' ? 'In use' : status === 'hooked' ? 'Hooked' : 'Idle',
      badgeColor: STATUS_PIN_COLOR[status],
      lastSeen: formatLastSeen(entry.loc.locatedAt),
      yardName: yardAt(entry.loc.lat, entry.loc.lon, yards)?.name,
      locationLabel: entry.loc.description || undefined,
      detail: status === 'idle' ? undefined : {
        driver: driverName(entry.usage.load),
        asset:  assetName(entry.usage.load),
        assetColor: assetColor(entry.usage.load),
        // The route of a load that's OVER is not where the trailer
        // is, and this row already shows where it is from the live
        // fix — so a hooked row shows who had it, not where that
        // load went.
        route:  status === 'in_use' ? routeLabel(entry.usage.load) : undefined,
        status: entry.usage.load?.status,
        lead:   status === 'hooked' ? 'Last load' : undefined,
      },
    };
  }

  // ── Render ────────────────────────────────────────────────────────────
  const totalCount  = groups.pinned.length + groups.noGps.length;
  const activeCount = groups.active.length;
  const hookedCount = groups.hooked.length;

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
              {totalCount} trailers · {activeCount} in use · {hookedCount} hooked · {groups.noGps.length} without GPS
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
          {/* Detail — left of the map, so the panel and the pin it
              describes are on screen together and the roster on the
              right still works for moving between trailers. */}
          {detailData && (
            <TrailerDetailPanel
              // Keyed by trailer so switching selection remounts the
              // panel. That resets the edit form for free, instead of
              // an effect that would otherwise show one trailer's
              // half-typed VIN under another's name.
              key={detailData.trailer.id}
              data={detailData}
              segments={history?.trailerId === detailData.trailer.id ? history.segments : null}
              historyDays={HISTORY_DAYS}
              loadingHistory={history?.trailerId !== detailData.trailer.id}
              onClose={() => setSelectedTrailerId(null)}
            />
          )}

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
                {(['trailers', 'yards', 'alerts'] as const).map(tab => {
                  const isActive = rail === tab;
                  // An unvisited Alerts tab with something on it wears
                  // the alert colour, so the count is noticed without
                  // the tab having to be opened.
                  const wantsAttention = tab === 'alerts' && alertBadgeCount > 0 && !isActive;
                  const label = tab === 'yards'  ? `Yards${yards.length ? ` (${yards.length})` : ''}`
                              : tab === 'alerts' ? `Alerts${alertBadgeCount ? ` (${alertBadgeCount})` : ''}`
                              : 'Trailers';
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => { setRail(tab); if (tab !== 'yards') setPlacing(null); }}
                      className="text-[12px] font-semibold"
                      style={{
                        padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                        border: `1px solid ${isActive ? 'var(--gc-blue)' : wantsAttention ? ALERT_COLOR : 'var(--gc-border)'}`,
                        background: isActive ? 'var(--gc-blue)' : wantsAttention ? `${ALERT_COLOR}1f` : 'transparent',
                        color: isActive ? '#fff' : wantsAttention ? '#b06000' : 'var(--gc-text-2)',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            {rail === 'trailers' && (<>
            {/* Group by status or by place. Two different questions:
                "what's free to grab" and "what's accounted for at the
                yard". */}
            <div className="flex gap-1 px-3 pt-2.5 shrink-0">
              {(['status', 'location'] as const).map(g => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGrouping(g)}
                  className="text-[11px] font-semibold capitalize"
                  style={{
                    padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
                    border: `1px solid ${grouping === g ? 'var(--gc-text-2)' : 'var(--gc-border)'}`,
                    background: grouping === g ? 'var(--gc-hover)' : 'transparent',
                    color: grouping === g ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                  }}
                >
                  {g === 'status' ? 'By status' : 'By location'}
                </button>
              ))}
            </div>
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
              {grouping === 'status' ? (<>
                <Section
                  label="Active"
                  count={groups.active.length}
                  statusColor={STATUS_PIN_COLOR.in_use}
                  rows={groups.active.map(rowFor)}
                  selectedId={selectedTrailerId}
                  onSelect={selectFromRow}
                />
                <Section
                  label="Hooked"
                  count={groups.hooked.length}
                  statusColor={STATUS_PIN_COLOR.hooked}
                  rows={groups.hooked.map(rowFor)}
                  selectedId={selectedTrailerId}
                  onSelect={selectFromRow}
                />
                <Section
                  label="Idle"
                  count={groups.idle.length}
                  statusColor={STATUS_PIN_COLOR.idle}
                  rows={groups.idle.map(rowFor)}
                  selectedId={selectedTrailerId}
                  onSelect={selectFromRow}
                />
              </>) : (<>
                {yards.length === 0 && (
                  <div className="px-4 py-3 text-[11px] leading-snug" style={{ color: 'var(--gc-text-3)' }}>
                    No yards defined yet, so everything lands under &ldquo;Not at a yard&rdquo;. Give a
                    saved location a radius on the Yards tab and its trailers group here.
                  </div>
                )}
                {byLocation.sections.map(({ yard, rows }) => (
                  <Section
                    key={yard.id}
                    label={yard.name}
                    count={rows.length}
                    statusColor={YARD_COLOR}
                    // The "At <yard>" line is dropped inside a yard's
                    // own section: the heading already said it.
                    rows={rows.map(e => ({ ...rowFor(e), yardName: undefined }))}
                    selectedId={selectedTrailerId}
                    onSelect={selectFromRow}
                  />
                ))}
                <Section
                  label="Not at a yard"
                  count={byLocation.elsewhere.length}
                  statusColor="var(--gc-text-3)"
                  rows={byLocation.elsewhere.map(rowFor)}
                  selectedId={selectedTrailerId}
                  onSelect={selectFromRow}
                />
              </>)}
              <Section
                label="No GPS"
                count={groups.noGps.length}
                statusColor="var(--gc-border)"
                rows={groups.noGps.map(({ trailer, usage }) => ({
                  trailer,
                  badge: usage.status === 'in_use' ? 'In use (no GPS)'
                       : usage.status === 'hooked' ? 'Hooked'
                       : 'Idle',
                  badgeColor: usage.status === 'idle'
                    ? 'var(--gc-text-3)'
                    : STATUS_PIN_COLOR[usage.status],
                  detail: usage.status === 'idle' ? undefined : {
                    driver: driverName(usage.load),
                    asset:  assetName(usage.load),
                    assetColor: assetColor(usage.load),
                    route:  usage.status === 'in_use' ? routeLabel(usage.load) : undefined,
                    status: usage.load?.status,
                    lead:   usage.status === 'hooked' ? 'Last load' : undefined,
                  },
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

            {rail === 'alerts' && (
              <AlertsRail
                alerts={alerts}
                historyStartedAt={historyStartedAt}
                selectedId={selectedTrailerId}
                onSelect={selectFromRow}
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

/**
 * The one-line stillness summary for a pin's tag.
 *
 * Ordered by what matters most. A dark tracker comes first because
 * everything after it would be a claim about a trailer we stopped
 * hearing from. Then a measured park. Then, before any history
 * exists, nothing at all — silence is better than a confident
 * "parked 0h" that only means "we started watching a minute ago".
 */
function dwellLine(
  trailerId: number,
  loc: MotiveTrailerLocation,
  stillness: Record<string, Stillness>,
  yards: Yard[],
): string | undefined {
  const fixAge = hoursSince(loc.locatedAt);
  if (fixAge != null && fixAge >= DARK_ALERT_HOURS) {
    return `Last fix ${formatAge(fixAge)}`;
  }
  const s = stillness[String(trailerId)];
  if (!s || s.stillHours == null) return undefined;
  if (s.stillHours < 1 && s.truncated) return undefined;
  const yard = yardAt(loc.lat, loc.lon, yards);
  const where = yard ? ` at ${yard.name}` : '';
  return `Parked ${formatDwell(s.stillHours, s.truncated)}${where}`;
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
    /** `lead` prefixes the truck/driver line — "Last load" on a
     *  hooked row, so facts taken from a finished load can't be read
     *  as what the trailer is doing now. */
     detail?: {
       driver?: string; asset?: string; route?: string; status?: string;
       lead?: string;
       /** The tractor's calendar colour, for the truck mark. */
       assetColor?: string;
     };
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
                  <div className="flex items-center gap-1 min-w-0" style={{ color: 'var(--gc-text-3)' }}>
                    {detail.lead && <span className="shrink-0">{detail.lead} ·</span>}
                    {detail.asset && (
                      <>
                        {/* Tinted through the style prop rather than a
                            class: the value comes out of the database,
                            and the property setter drops a malformed
                            colour instead of it landing in markup. */}
                        <Truck
                          size={11}
                          className="shrink-0"
                          style={{ color: detail.assetColor || 'var(--gc-text-3)' }}
                        />
                        <span className="shrink-0 font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                          {detail.asset}
                        </span>
                      </>
                    )}
                    {(detail.driver || detail.status) && (
                      <span className="truncate">
                        {detail.asset ? '· ' : ''}
                        {[detail.driver, detail.status?.replace('_', ' ')].filter(Boolean).join(' · ')}
                      </span>
                    )}
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

/**
 * AlertsRail — the trailers that want someone to lay eyes on them.
 *
 * Four groups in descending "go look at this" order. The split between
 * the two static groups is what makes the list usable: Matt's rule is
 * "flag anything that hasn't moved in 2 days", and taken literally
 * that includes every spare sitting at the terminal, which on its own
 * would bury the one trailer parked for three days behind a truck stop
 * in Nevada. So both are listed and the yard ones come last, dimmed.
 *
 * Every row selects and centres its trailer, because the next question
 * after "which one" is always "where".
 */
function AlertsRail({
  alerts, historyStartedAt, selectedId, onSelect,
}: {
  alerts: TrailerAlert[];
  historyStartedAt: string | null;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const groups: Array<{
    kind:  TrailerAlertKind;
    label: string;
    hint:  string;
    color: string;
    Icon:  typeof ShieldAlert;
    dim?:  boolean;
  }> = [
    { kind: 'dark',        label: 'Tracker dark',   color: ALERT_COLOR,       Icon: WifiOff,
      hint: `No GPS fix in over ${DARK_ALERT_HOURS}h — the tracker stopped reporting, so where it is now is a guess.` },
    { kind: 'static_away', label: 'Not moved',      color: ALERT_COLOR,       Icon: ShieldAlert,
      hint: `Still reporting, but hasn't moved in ${STILL_ALERT_DAYS}+ days and isn't at a known yard.` },
    { kind: 'static_yard', label: 'Parked at a yard', color: YARD_COLOR,      Icon: ParkingCircle, dim: true,
      hint: `Hasn't moved in ${STILL_ALERT_DAYS}+ days, but it's inside one of your yards.` },
    { kind: 'untracked',   label: 'No tracker',     color: 'var(--gc-text-3)', Icon: HelpCircle, dim: true,
      hint: 'No Motive link, or Motive has never returned a position. Can’t be monitored at all.' },
  ];

  // Before there are two days of history, the static rules cannot have
  // fired yet, and saying so beats an empty list that looks like an
  // all-clear. The dark rule needs no history and works from day one.
  const historyHours = hoursSince(historyStartedAt);
  const warmingUp = historyHours == null || historyHours < STILL_ALERT_DAYS * 24;

  const total = alerts.length;

  return (
    <div className="flex-1 overflow-auto">
      {warmingUp && (
        <div
          className="mx-3 mt-3 px-3 py-2.5 rounded-lg text-[11px]"
          style={{ background: 'var(--gc-hover)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
        >
          <div className="font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
            Still building history
          </div>
          {historyHours == null
            ? `No stored positions yet. "Not moved" needs ${STILL_ALERT_DAYS} days of history before it can fire; tracker-dark alerts work now.`
            : `${formatStill(historyHours)} of history so far. "Not moved" starts reporting at ${STILL_ALERT_DAYS} days; tracker-dark alerts work now.`}
        </div>
      )}

      {total === 0 && !warmingUp && (
        <div className="px-4 py-8 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
          Every trailer has reported recently and moved within the last {STILL_ALERT_DAYS} days.
        </div>
      )}

      {groups.map(({ kind, label, hint, color, Icon, dim }) => {
        const rows = alerts.filter(a => a.kind === kind);
        if (rows.length === 0) return null;
        // Longest-standing first within each group: if you only deal
        // with one, it should be the worst one.
        rows.sort((a, b) => {
          const av = kind === 'dark' ? (a.fixAgeHours ?? 0) : (a.still?.stillHours ?? 0);
          const bv = kind === 'dark' ? (b.fixAgeHours ?? 0) : (b.still?.stillHours ?? 0);
          return bv - av;
        });
        return (
          <div key={kind} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
            <div className="px-4 pt-3 pb-2 sticky top-0" style={{ background: 'var(--gc-bg)', zIndex: 1 }}>
              <div className="flex items-center gap-2">
                <Icon size={12} style={{ color }} />
                <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
                  {label}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{rows.length}</span>
              </div>
              <div className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--gc-text-3)' }}>{hint}</div>
            </div>
            {rows.map(a => {
              const isSel = a.trailer.id === selectedId;
              const measure = kind === 'dark'
                ? `Last fix ${formatAge(a.fixAgeHours)}`
                : kind === 'untracked'
                  ? 'Never reported'
                  : `Parked ${formatDwell(a.still?.stillHours ?? null, a.still?.truncated ?? false)}`;
              return (
                <button
                  key={a.trailer.id}
                  data-trailer-row-id={a.trailer.id}
                  onClick={() => onSelect(a.trailer.id)}
                  className="w-full text-left px-4 py-2.5 transition-colors"
                  style={{
                    background: isSel ? 'var(--gc-blue-light)' : 'transparent',
                    borderLeft: isSel ? '3px solid var(--gc-blue)' : '3px solid transparent',
                    opacity: dim && !isSel ? 0.75 : 1,
                  }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                      {a.trailer.trailerNumber ? `#${a.trailer.trailerNumber}` : a.trailer.name}
                      <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--gc-text-3)' }}>
                        {a.trailer.category}
                      </span>
                    </div>
                    <span className="text-[11px] font-semibold shrink-0" style={{ color }}>
                      {measure}
                    </span>
                  </div>
                  {a.yardName && (
                    <div className="mt-1 text-[11px] flex items-center gap-1" style={{ color: YARD_COLOR, fontWeight: 600 }}>
                      <Container size={10} />
                      <span className="truncate">At {a.yardName}</span>
                    </div>
                  )}
                  {a.locationLabel && !a.yardName && (
                    <div className="mt-1 text-[11px] flex items-center gap-1" style={{ color: 'var(--gc-text-2)' }}>
                      <MapPin size={10} style={{ color: 'var(--gc-text-3)' }} />
                      <span className="truncate">{a.locationLabel}</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
