'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { MVP_LAUNCH_DEFAULTS } from '@fleetcal/types';
import { Asset, CalendarEvent, Driver, Dispatcher, Customer, SavedLocation, Trailer } from '@/lib/types';
import { buildDefaultFieldSettings, DEFAULT_SECTION_ORDER, FieldSection } from '@/lib/fields';
import { CardFieldKey, DEFAULT_CARD_FIELDS } from '@/lib/cardFields';
import { DEFAULT_PROMPT_VARIABLES, PromptVariables } from '@/lib/prompt';
import { getSupabase } from '@/lib/supabase';
import { normalizePhone } from '@/lib/phone';
import type { OrgData } from '@/lib/db';
import { fetchEventsInRange, fetchSavedLocations, createSavedLocation, updateSavedLocation, deleteSavedLocation, fetchDispatchers, createDispatcher, updateDispatcher, deleteDispatcher, fetchCustomers, createCustomer, updateCustomer, deleteCustomer, fetchTrailers, createTrailer, updateTrailer, deleteTrailer } from '@/lib/db';
import { railway } from '@/lib/railway';
import { buildCreateLoadBody, splitForUpdate, buildEventByIdUpdate } from '@/lib/loadFieldSplit';
import { DUMMY_ASSETS, DUMMY_DRIVERS, DUMMY_EVENTS, DEMO_BASE_DATE } from '@/lib/dummy-data';
import { localDateStr, todayAtNoon } from '@/lib/time-utils';

// ─── Self-echo suppression ──────────────────────────────────────────────
//
// When this client writes to an event, Supabase realtime echoes the
// change back to every subscribed client INCLUDING ourselves. Without
// dedup, the realtime callback would treat our own write as a foreign
// update and pop the "another dispatcher updated this load" banner.
//
// We tag each local write with a timestamp; a matching realtime event
// arriving within SELF_ECHO_WINDOW_MS is treated as a self-echo and
// applies the data without flagging the modal as conflicted.
//
// Module-local Map (not in Zustand state) — purely transient and
// doesn't need serialization or React reactivity.
const SELF_ECHO_WINDOW_MS = 5_000;
const selfWriteAt = new Map<string, number>();
function markSelfWrite(id: string) {
  selfWriteAt.set(id, Date.now());
}
function consumeSelfWrite(id: string): boolean {
  const t = selfWriteAt.get(id);
  if (t == null) return false;
  if (Date.now() - t > SELF_ECHO_WINDOW_MS) {
    selfWriteAt.delete(id);
    return false;
  }
  return true;
}

// ─── Delete-error notify helper ─────────────────────────────────────────
//
// The primary defense is the UI gate — the Delete button is removed
// entirely for roles without the relevant `*.delete` capability, so a
// non-permitted user never triggers a DELETE call in the first place.
// This helper only runs on the rare edge case where the API rejects a
// delete that the UI thought was allowed (server-side rule change,
// race, etc.). We log and let the caller silently roll local state
// back — no alert dialog, since the user did nothing wrong.
function notifyDeleteError(resource: string, err: unknown) {
  console.error(`remove${resource}:`, err);
}

export interface DragState {
  eventId: string;
  targetAssetId: number;
  dateStr: string;
  grabOffsetPx: number;
  durationMs: number;
  newStart: string;
  newEnd: string;
  /** Becomes true only AFTER the pointer has moved past the slop
   *  threshold (DRAG_SLOP_PX). Until then a mouseup is treated as a
   *  click → opens the modal. This is what prevents tiny pointer
   *  jitter from silently writing the event to a new slot. */
  hasMoved: boolean;
  /** Initial pointer position at mousedown, in viewport coords.
   *  Used by the slop guard in calendar/index.tsx so the drag has
   *  to travel a real distance before it arms. */
  pointerStartX: number;
  pointerStartY: number;
  /** Original asset + start/end at mousedown (in view-tz space, same
   *  units as newStart/newEnd). Used by handleMouseUp to verify the
   *  drag actually moved the event before committing — a drag that
   *  ends up snapping back to the original slot is treated as a
   *  click instead of a no-op database write. */
  originAssetId: number;
  originStart:   string;
  originEnd:     string;
}

export interface BatchItem {
  rateConPdf: string;
  parsed: Record<string, unknown>;
}

export interface EldLocation {
  vehicleId: string;
  description: string;
  lat: number;
  lon: number;
  locatedAt: string;
}

interface ModalState {
  modalOpen: boolean;
  modalMode: 'create' | 'edit';
  modalEventId?: string;
  modalDefaults?: Partial<CalendarEvent>;
  modalShowMap: boolean;
  modalConflict: 'updated' | 'deleted' | null;
  /** Cross-page hand-off: when the maintenance work-order modal sends
   *  the user to /calendar via "Schedule on calendar", it stuffs the
   *  work-order ID(s) here. EventModal's open-effect drains this into
   *  its pendingWorkOrderLinks buffer so the WO is pre-checked in the
   *  Linked Work Orders section, and the user's first save persists
   *  the link without needing a manual second step. */
  prefillWorkOrderLinkIds?: string[];
}

export interface DeletedEvent extends CalendarEvent {
  deletedAt: string;
}

export interface HydratePayload extends OrgData {
  orgId: string;
  loadedStart: string;
  loadedEnd: string;
}

function db() { return getSupabase(); }

// Resolve event.driverId from event.driverName against the current drivers list.
// Called at every event write so the FK stays in sync with the denormalized name.
//
// Matches against canonical name (firstName + lastName) AND the legacy
// `.name` field, case-insensitive, so loads saved either before or
// after the firstName/lastName split resolve correctly. Without the
// canonical match the calendar drag-to-reassign would silently drop
// the driver for any driver record whose legacy .name is empty.
function withResolvedDriverId<T extends { driverName?: string; driverId?: number }>(
  ev: T,
  drivers: Driver[],
): T {
  if (!ev.driverName) return { ...ev, driverId: undefined };
  const target = ev.driverName.trim().toLowerCase();
  const match = drivers.find(d => {
    if (d.name && d.name.trim().toLowerCase() === target) return true;
    const canonical = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim().toLowerCase();
    return !!canonical && canonical === target;
  });
  return { ...ev, driverId: match?.id };
}

/** `[time]` per the notification copy spec — "ddd M/D h:mm A" (e.g.
 *  "Wed 5/21 8:00 AM"). One format used across every push. Input is a
 *  naive ISO start ("YYYY-MM-DDTHH:mm") in HOME_TZ. */
function fmtPushTime(naive: string | undefined | null): string {
  if (!naive) return '';
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return naive;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const wd = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${month}/${day} ${hour}:${String(minute).padStart(2, '0')} ${ampm}`;
}

// Fire a push notification to a driver via the dispatch API. Best-effort —
// failures are logged but don't block the event write.
//
// If `ruleKey` is provided, the server applies the org notification rule
// + per-driver override check before sending (auto-fire). Without it,
// the push goes through unconditionally — reserved for manual
// dispatcher nudges from NotifyDriverPopover.
//
// All three rule-gated push kinds pass `eventStart` (naive ISO in
// dispatch zone) so the server can enforce the rule's hoursBeforeStart
// window:
//   on_assignment    — pings new driver on assignment of an imminent load
//   load_cancelled   — pings driver when their imminent load is cancelled
//   reassigned_away  — pings driver when their imminent load goes to someone else
function notifyDriver(
  driverId: number,
  title: string,
  body: string,
  data?: Record<string, unknown>,
  ruleKey?: 'on_assignment' | 'load_cancelled' | 'reassigned_away',
  eventStart?: string | null,
) {
  fetch('/api/driver-push', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ driverId, title, body, data, ruleKey, eventStart }),
  }).catch(err => console.error('notifyDriver:', err));
}

interface CalendarStore extends ModalState {
  orgId: string | null;
  dbReady: boolean;
  loadedStart: string | null;
  loadedEnd: string | null;
  /** Persisted across reloads — used by CalendarSkeleton to render the right
   *  number of columns before fetchOrgData returns. Updated on hydrate. */
  lastKnownAssetCount: number;
  hydrate: (payload: HydratePayload) => void;
  extendLoadedRange: (start: string, end: string) => Promise<void>;
  /** Splice fetched events into the store. Used when a screen pulls
   *  loads outside the calendar's loaded window (e.g. /closeout) and
   *  needs the EventModal to find them by id. Existing ids are
   *  overwritten with the new payload (server is source of truth). */
  mergeEvents: (events: CalendarEvent[]) => void;

  assets: Asset[];
  events: CalendarEvent[];
  deletedEvents: DeletedEvent[];
  drivers: Driver[];
  /** Primary driver per asset (assetId → driverId). Auto-fills when
   *  the asset is selected on a load. Backed by
   *  driver_asset_prefs.driver_id. */
  driverPrefs: Record<number, number>;
  /** Optional secondary driver per asset — a driver who shares the
   *  asset (typically because they don't have their own truck).
   *  Backed by driver_asset_prefs.secondary_driver_id. Picking this
   *  driver in the load modal auto-fills the same asset. */
  driverPrefsSecondary: Record<number, number>;
  currentDate: Date;
  resourceWidth: number;
  resourceWidthLocked: boolean; // true when user has manually set via slider
  rowHeight: number;
  sidebarOpen: boolean;

  assetCategories: string[];
  addAssetCategory: (name: string) => void;
  updateAssetCategory: (oldName: string, newName: string) => void;
  removeAssetCategory: (name: string) => void;
  reorderAssetCategories: (fromIdx: number, toIdx: number) => void;

  addAsset: (asset: Omit<Asset, 'id'>) => Promise<number>;
  updateAsset: (id: number, updates: Partial<Omit<Asset, 'id'>>) => void;
  removeAsset: (id: number) => void;
  /** Hard delete — only succeeds when the asset has no loads attached.
   *  Throws on FK violation so the caller can show "retire instead." */
  hardDeleteAsset: (id: number) => Promise<void>;
  reorderAssets: (fromId: number, toId: number) => void;

  /** Create a driver. Accepts either a bare name (legacy) or a full
   *  Partial<Driver> with every profile field populated. Returns the
   *  server-assigned id once the row lands. */
  addDriver: (input: string | Partial<Omit<Driver, 'id'>>) => Promise<number>;
  updateDriver: (id: number, updates: Partial<Omit<Driver, 'id'>>) => void;
  removeDriver: (id: number) => void;
  /** Hard delete — only succeeds when the driver has no loads attached. */
  hardDeleteDriver: (id: number) => Promise<void>;
  setDriverPref: (assetId: number, driverId: number | null) => void;
  setDriverPrefSecondary: (assetId: number, driverId: number | null) => void;

  /** Create an event. `presetId` is the optimistic local id used
   *  until the server responds with the real uuid. `options.linkWorkOrderIds`
   *  (non-revenue only) names maintenance action items to attach via
   *  `eventId` AFTER the server-allocated id is known — addressing the
   *  race where flushing against `presetId` would target a temp uuid
   *  that the server immediately swaps out. */
  addEvent: (
    event: Omit<CalendarEvent, 'id'>,
    presetId?: string,
    options?: { linkWorkOrderIds?: string[] },
  ) => void;
  updateEvent: (id: string, updates: Partial<Omit<CalendarEvent, 'id'>>) => void;
  /** Soft-delete just the event row and leave the parent load intact.
   *  Used by the "Cancel & Remove from Calendar" flow — load stays in
   *  search / accounting / TONU paths but vanishes from the calendar.
   *  The audit entry attaches to the load via updateLoad. */
  cancelEventKeepLoad: (id: string, auditEntry?: import('@/lib/types').LoadAuditEntry) => void;
  removeEvent: (id: string, auditEntry?: import('@/lib/types').LoadAuditEntry) => void;
  // Remote-only (realtime): apply without writing back to DB
  addEventFromRemote: (event: CalendarEvent) => void;
  updateEventFromRemote: (event: CalendarEvent) => void;
  removeEventFromRemote: (id: string) => void;

  /** IDs of events currently being refetched via `refetchEvent`.
   *  UI surfaces (e.g. the modal stops section) read this to render a
   *  loading shimmer while fresh data lands. */
  refetchingEventIds: Set<string>;
  /** Force-refetch one event via /v1/events/:id and upsert the joined
   *  result into the cache. Used by the modal's manual refresh button
   *  and as a recovery path when an event landed with empty stops. */
  refetchEvent: (id: string) => Promise<void>;
  restoreEvent: (id: string, auditEntry?: import('@/lib/types').LoadAuditEntry) => void;
  purgeEvent: (id: string) => void;
  clearTrash: () => void;
  autoExpireTrash: () => void;

  createRelayPair: (pickup: Omit<CalendarEvent, 'id'>, delivery: Omit<CalendarEvent, 'id'>, presetPickupId?: string, presetDeliveryId?: string) => void;
  /** Convert an existing single-event load into a relay (pickup keeps its loadId; delivery is a new event on the same load). */
  splitToRelay: (pickupEventId: string, pickupUpdates: Partial<Omit<CalendarEvent, 'id'>>, deliveryData: Omit<CalendarEvent, 'id'>, presetDeliveryId?: string) => void;
  saveRelayBoth: (pickupId: string, pickupUpdates: Partial<Omit<CalendarEvent, 'id'>>, deliveryId: string, deliveryUpdates: Partial<Omit<CalendarEvent, 'id'>>) => void;
  removeRelay: (legId: string, auditLog?: import('@/lib/types').LoadAuditEntry[]) => void;

  setCurrentDate: (date: Date) => void;
  setResourceWidth: (width: number, userInitiated?: boolean) => void;
  unlockResourceWidth: () => void;
  setRowHeight: (h: number) => void;
  toggleSidebar: () => void;

  viewMode: 'day' | 'week';
  setViewMode: (mode: 'day' | 'week') => void;

  fieldSettings: Record<string, boolean>;
  sectionOrder: FieldSection[];
  setFieldEnabled: (id: string, enabled: boolean) => void;
  setSectionOrder: (order: FieldSection[]) => void;
  driverPayPct: number | null;
  setDriverPayPct: (pct: number | null) => void;

  promptInstructions: string;
  setPromptInstructions: (s: string) => void;
  promptVariables: PromptVariables;
  setPromptVariable: (key: keyof PromptVariables, value: string) => void;
  /** True once we've pulled rate-con settings from the server. Sync effects
   *  in settings/page guard on this so initial hydration doesn't trigger a
   *  write loop. */
  hasHydratedOrgSettings: boolean;
  hydrateRateConSettings: (settings: import('@fleetcal/types').RateConSettings | undefined) => void;

  /** Per-org role → capability override map. Empty / unset means every
   *  role uses the hardcoded defaults from @fleetcal/types/permissions.
   *  Hydrated from /v1/org-settings on app boot. */
  roleOverrides: import('@fleetcal/types').RoleOverrides;
  hydrateRoleOverrides: (overrides: import('@fleetcal/types').RoleOverrides | undefined) => void;

  /** Per-org module on/off flags. Independent of role capabilities —
   *  a module turned off here is invisible to everyone in the org,
   *  including the owner. Hydrated from /v1/org-settings on app
   *  boot. Empty map = all modules ON (the default). */
  orgModules: import('@fleetcal/types').OrgModuleFlags;
  hydrateOrgModules: (flags: import('@fleetcal/types').OrgModuleFlags | undefined) => void;

  /** Per-org document-type configuration (kind → enabled + driver
   *  visibility). Drives upload kind pickers across the app and the
   *  driver-visible filter on document reads. null = not yet hydrated;
   *  components reading it should fall back to DEFAULT_DOCUMENT_TYPES.
   *  Hydrated from /v1/org-settings on app boot. */
  documentTypes: import('@fleetcal/types').DocumentTypeConfig[] | null;
  hydrateDocumentTypes: (types: import('@fleetcal/types').DocumentTypeConfig[] | null | undefined) => void;

  theme: 'light' | 'dark' | 'system';
  setTheme: (t: 'light' | 'dark' | 'system') => void;

  /** Multiplier applied to every font-size on the calendar event
   *  cards (title, route, time, status overlay, etc). 1.0 = current
   *  default; the AppearancePanel exposes four presets: 0.9 / 1.0 /
   *  1.15 / 1.3. Stored as a number rather than an enum so future
   *  fine-grained controls (e.g. a slider) can drop in without a
   *  store migration. */
  cardFontScale: number;
  setCardFontScale: (n: number) => void;

  isDemo: boolean;
  hydrateDemoMode: () => void;
  exitDemoMode: () => void;

  showStatusOverlay: boolean;
  setShowStatusOverlay: (v: boolean) => void;
  /** Show the green check overlay when the driver has confirmed the load. */
  showConfirmedOverlay: boolean;
  setShowConfirmedOverlay: (v: boolean) => void;
  /** Show the green document overlay when a POD has been uploaded. */
  showPodOverlay: boolean;
  setShowPodOverlay: (v: boolean) => void;
  /** Show the billing-status indicator (verified / invoiced / paid / on-hold). */
  showBillingOverlay: boolean;
  setShowBillingOverlay: (v: boolean) => void;

  calendarTimezone: string;
  setCalendarTimezone: (tz: string) => void;

  // ── Motive movements (per-asset column "Movements" mode) ────────────
  /** Calendar-wide view toggle. 'loads' (default) renders the existing
   *  load events for every asset column; 'movements' switches every
   *  column over to Motive driving-period cards. Stored per dispatcher
   *  via the zustand persist below so the choice survives reloads. */
  calendarMode: 'loads' | 'movements';
  setCalendarMode: (mode: 'loads' | 'movements') => void;
  /** Most recent /v1/movements response, keyed by Motive vehicleId. */
  movementsByVehicle: Record<string, import('@/lib/railway').MovementCard[]>;
  /** True while a fetchMovements call is in flight. UI shows a spinner. */
  movementsLoading: boolean;
  /** Error message from the last fetch attempt — surfaced as a small
   *  banner on the calendar header so transient failures stop being
   *  invisible. Cleared on a successful fetch. */
  movementsError: string | null;
  /** Monotonically-increasing id for the most recent fetch call. Used
   *  to discard stale responses when the user navigates rapidly (the
   *  older request finishes after the newer one). */
  movementsRequestId: number;
  /** Fetch the movements window covering at least [start,end] (ISO).
   *  Backed by /v1/movements; results merge into movementsByVehicle. */
  fetchMovements: (start: string, end: string) => Promise<void>;

  cardFields: CardFieldKey[];
  setCardFields: (fields: CardFieldKey[]) => void;

  showUnassigned: boolean;
  unassignedAssetId: number | null;
  setShowUnassigned: (v: boolean) => void;

  triageMode: boolean;
  setTriageMode: (v: boolean) => void;

  trayOpen: boolean;
  setTrayOpen: (v: boolean) => void;

  smartAssignEventId: string | null;
  setSmartAssignEventId: (id: string | null) => void;

  toggleAssetVisibility: (id: number) => void;

  activeCategoryFilter: string | null;
  setActiveCategoryFilter: (cat: string | null) => void;

  savedLocations: SavedLocation[];
  fetchSavedLocations: () => Promise<void>;
  addSavedLocation: (loc: Omit<SavedLocation, 'id'>) => Promise<void>;
  updateSavedLocation: (id: string, updates: Partial<Omit<SavedLocation, 'id'>>) => Promise<void>;
  removeSavedLocation: (id: string) => Promise<void>;

  dispatchers: Dispatcher[];
  fetchDispatchers: () => Promise<void>;
  addDispatcher: (name: string, isDefault: boolean) => Promise<void>;
  updateDispatcher: (id: string, updates: { name?: string; isDefault?: boolean }) => Promise<void>;
  removeDispatcher: (id: string) => Promise<void>;

  customers: Customer[];
  fetchCustomers: () => Promise<void>;
  addCustomer: (c: Omit<Customer, 'id'>) => Promise<Customer | null>;
  updateCustomer: (id: string, updates: Partial<Omit<Customer, 'id'>>) => Promise<void>;
  removeCustomer: (id: string) => Promise<void>;
  addCustomerAlias: (id: string, alias: string) => Promise<void>;
  /** Append a contact to customer.contacts[] if no existing entry has
   *  the same email OR phone (case/whitespace-insensitive). No-op when
   *  the contact lacks name+email+phone. */
  addCustomerContact: (id: string, contact: { name?: string; email?: string; phone?: string }) => Promise<void>;

  trailers: Trailer[];
  fetchTrailers: () => Promise<void>;
  addTrailer: (t: Omit<Trailer, 'id'>) => Promise<number>;
  updateTrailer: (id: number, updates: Partial<Omit<Trailer, 'id'>>) => Promise<void>;
  removeTrailer: (id: number) => Promise<void>;
  hardDeleteTrailer: (id: number) => Promise<void>;

  dragState: DragState | null;
  setDragState: (s: DragState | null) => void;

  batchItems: BatchItem[];
  batchIndex: number;
  batchParseProgress: number;
  batchParseTotal: number;
  batchMinimized: boolean;
  batchCancelRequested: boolean;
  startBatch: (items: BatchItem[]) => void;
  batchNext: () => void;
  clearBatch: () => void;
  setBatchParseState: (progress: number, total: number) => void;
  setBatchMinimized: (v: boolean) => void;
  requestBatchCancel: () => void;

  eldLocations: EldLocation[];
  /** Epoch ms of the last successful Motive `/locations` fetch.
   *  Drives the "X min ago" pill in CalendarHeader. */
  eldLocationsFetchedAt: number | null;
  /** True while a refresh is in flight — drives spinner state. */
  eldLocationsLoading: boolean;
  setEldLocations: (locs: EldLocation[]) => void;
  /** Single source of truth for fetching Motive vehicle locations.
   *  EldSync polls this on a 10-min cadence; CalendarHeader's refresh
   *  button also calls it. Centralizing here means there's exactly one
   *  fetcher for `/api/motive/locations` regardless of how many UIs
   *  display the data. */
  refreshEldLocations: () => Promise<void>;

  openCreateModal: (defaults?: Partial<CalendarEvent>, opts?: { prefillWorkOrderLinkIds?: string[] }) => void;
  openEditModal: (eventId: string) => void;
  openEditModalWithMap: (eventId: string) => void;
  closeModal: () => void;
  clearModalConflict: () => void;
  /** Tag every event belonging to a load as a self-write so the incoming
   *  realtime echo doesn't trigger the "another dispatcher updated this
   *  load" banner. Call this before a direct API write that bypasses a
   *  store action (e.g. document uploads via railway.uploadLoadDocument). */
  markLoadSelfWrite: (loadId: string) => void;
  /** Monotonic counter, incremented after every successful load-touching
   *  store write (updateEvent → railway.updateLoad). Pages that hold
   *  their own load snapshot (accounting, closeout, timeline) can
   *  subscribe to this and refetch when it changes — keeps them in sync
   *  with edits made via EventModal/calendar without prop-drilling an
   *  onSaved callback through every mount point. */
  loadEditTick: number;
  /** Externally-triggered bump of loadEditTick. Useful for write paths
   *  that bypass the store (invoice send/markPaid/void, etc.) but still
   *  mutate the load row server-side (billing_status moves through
   *  released → invoiced → paid). Without this, the accounting/closeout
   *  snapshots would only re-sync on the next page-level Refresh. */
  bumpLoadEditTick: () => void;
}

export const useCalendarStore = create<CalendarStore>()(
  persist(
    (set, get) => ({

  // ── DB state ──────────────────────────────────────────────────────────────
  orgId:       null,
  dbReady:     false,
  loadedStart: null,
  loadedEnd:   null,
  lastKnownAssetCount: 0,

  hydrate: ({ orgId, assets, events, deletedEvents, drivers, driverPrefs, driverPrefsSecondary, loadedStart, loadedEnd }) => {
    const unassigned = assets.find(a => a.type === 'Unassigned' || a.name === 'Unassigned');
    const persistedShowUnassigned = get().showUnassigned;
    const visibleCount = assets.filter(a => !a.hidden).length;
    set({
      orgId, assets, events, deletedEvents, drivers,
      driverPrefs,
      driverPrefsSecondary: driverPrefsSecondary ?? {},
      dbReady: true, currentDate: todayAtNoon(), loadedStart, loadedEnd,
      unassignedAssetId: unassigned?.id ?? null,
      showUnassigned: persistedShowUnassigned,
      lastKnownAssetCount: visibleCount,
    });
    // If the setting is on but the asset doesn't exist in DB yet, create it now
    if (persistedShowUnassigned && !unassigned && orgId) {
      const tempId = -Date.now();
      set((state) => ({
        assets: [{ id: tempId, name: 'Unassigned', color: '#94a3b8', type: 'Unassigned', unit: '-', hidden: false, sortOrder: -1 }, ...state.assets],
      }));
      railway.createAsset({
        name: 'Unassigned', color: '#94a3b8', type: 'Unassigned',
        unit: '-', hidden: false, sortOrder: -1,
      }).then(({ asset }) => {
        set((state) => ({
          assets: state.assets.map(a => a.id === tempId ? asset : a),
          unassignedAssetId: asset.id,
        }));
      }).catch((err) => console.error('hydrate: create unassigned asset:', err));
    }
  },

  mergeEvents: (incoming) => {
    set((state) => {
      const incomingIds = new Set(incoming.map(e => e.id));
      const kept = state.events.filter(e => !incomingIds.has(e.id));
      return { events: [...kept, ...incoming] };
    });
  },

  extendLoadedRange: async (start, end) => {
    const { orgId, loadedStart, loadedEnd, isDemo } = get();
    if (!orgId || isDemo) return;
    // Already fully covered — nothing to do
    if (loadedStart && loadedEnd && start >= loadedStart && end <= loadedEnd) return;
    try {
      const { events, deletedEvents } = await fetchEventsInRange(orgId, start, end);
      set((state) => {
        // Merge by REPLACING existing events with the fresh copy instead
        // of skipping them. Previously we filtered out IDs already in
        // cache, which meant a load that landed in the cache with
        // empty/stale stops (from any earlier code path) could never
        // be healed by a subsequent fetch — a page reload wouldn't even
        // fix it. Upserting guarantees navigating refreshes the data.
        const newById = new Map(events.map(e => [e.id, e]));
        const updatedExisting = state.events.map(e => newById.get(e.id) ?? e);
        const additions = events.filter(e => !state.events.some(s => s.id === e.id));
        const newDelById = new Map(deletedEvents.map(e => [e.id, e]));
        const updatedDeleted = state.deletedEvents.map(e => newDelById.get(e.id) ?? e);
        const delAdditions = deletedEvents.filter(e => !state.deletedEvents.some(s => s.id === e.id));
        const newStart = !state.loadedStart || start < state.loadedStart ? start : state.loadedStart;
        const newEnd   = !state.loadedEnd   || end   > state.loadedEnd   ? end   : state.loadedEnd;
        return {
          events:        [...updatedExisting, ...additions],
          deletedEvents: [...updatedDeleted,  ...delAdditions],
          loadedStart: newStart,
          loadedEnd:   newEnd,
        };
      });
    } catch (err) {
      console.error('[store] extendLoadedRange:', err);
    }
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  // Starter category set — Local + OTR only. Carriers add their own
  // (Dedicated, Regional, Reefer, etc.) via Settings → Assets if they
  // need more axes. Keeping the default short avoids cluttering the
  // category chips for a 1-4 truck operation that may only run one
  // type of freight.
  assetCategories: ['Local', 'OTR'],
  assets:        [],
  events:        [],
  deletedEvents: [],
  drivers:       [],
  driverPrefs:          {},
  driverPrefsSecondary: {},
  // Noon-anchored — see todayAtNoon docs. Midnight-browser-tz lands in
  // the 1-2h window where org tz (HOME_TZ) and a browser tz east of it
  // disagree about the day, which silently broke movements rendering
  // and made events span the wrong calendar day.
  currentDate:   todayAtNoon(),
  resourceWidth:       80,
  resourceWidthLocked: false,
  rowHeight:           68,
  sidebarOpen:   true,

  // ── Settings ──────────────────────────────────────────────────────────────
  viewMode: 'day',
  setViewMode: (mode) => set({ viewMode: mode }),

  fieldSettings: buildDefaultFieldSettings(),
  sectionOrder:  DEFAULT_SECTION_ORDER,
  setFieldEnabled: (id, enabled) =>
    set((state) => ({ fieldSettings: { ...state.fieldSettings, [id]: enabled } })),
  setSectionOrder: (order) => set({ sectionOrder: order }),
  driverPayPct: null,
  setDriverPayPct: (pct) => {
    set({ driverPayPct: pct });
    // Persist to server so the value follows the org across devices
    // and survives clearing localStorage. Fire-and-forget — local
    // state already updated.
    void railway.updateOrgSettings({
      rateConSettings: { driverPayPct: pct },
    }).catch(err => console.error('[setDriverPayPct] save failed:', err));
  },

  promptInstructions: '',
  setPromptInstructions: (s) => set({ promptInstructions: s }),
  promptVariables: DEFAULT_PROMPT_VARIABLES,
  setPromptVariable: (key, value) =>
    set((state) => ({ promptVariables: { ...state.promptVariables, [key]: value } })),
  hasHydratedOrgSettings: false,
  hydrateRateConSettings: (settings) =>
    set((state) => ({
      promptVariables: { ...DEFAULT_PROMPT_VARIABLES, ...(settings?.promptVariables ?? {}) },
      promptInstructions: settings?.promptInstructions ?? '',
      fieldSettings:
        settings?.fieldSettings && Object.keys(settings.fieldSettings).length > 0
          ? { ...state.fieldSettings, ...settings.fieldSettings }
          : state.fieldSettings,
      // Server is the source of truth for driverPayPct now. If the
      // org has it set, use it; otherwise leave whatever's in local
      // state (which may have come from localStorage, see legacy
      // persistence note at line ~1760).
      driverPayPct: settings?.driverPayPct ?? state.driverPayPct,
      hasHydratedOrgSettings: true,
    })),

  roleOverrides: {},
  hydrateRoleOverrides: (overrides) =>
    set({ roleOverrides: overrides ?? {} }),

  // Initialize to the MVP-launch defaults instead of `{}` so the first
  // render is already pessimistic — gated nav items + settings panels
  // start HIDDEN rather than flashing visible and then hiding once the
  // DataLoader-driven GET /v1/org-settings response lands. For Curzon
  // (or any existing org with all flags), there's a brief MVP-flash
  // before hydration replaces these with the actual flags. Tradeoff
  // accepted: new-org test cases are the common case for the launch
  // window, and Curzon's flash → full-nav transition is less jarring
  // than the inverse.
  orgModules: { ...MVP_LAUNCH_DEFAULTS },
  hydrateOrgModules: (flags) =>
    set({ orgModules: flags ?? {} }),

  documentTypes: null,
  hydrateDocumentTypes: (types) =>
    set({ documentTypes: types ?? null }),

  cardFontScale: 1.0,
  setCardFontScale: (n) => set({ cardFontScale: n }),

  theme: 'light',
  setTheme: (t) => {
    set({ theme: t });
    if (typeof document !== 'undefined') {
      const resolved = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : t;
      document.documentElement.setAttribute('data-theme', resolved);
      // Mirror the resolved value into a cookie so the next page's
      // SSR can apply the correct data-theme attribute up-front and
      // avoid a flash. 1-year lifetime; same-site lax so it persists
      // across normal navigation.
      document.cookie = `fleetcal-theme=${resolved}; path=/; max-age=31536000; samesite=lax`;
    }
  },

  isDemo: false,
  hydrateDemoMode: () => {
    const today = localDateStr(new Date());
    // id -99 is the demo unassigned placeholder
    const UNASSIGNED_ID = -99;
    const demoAssets = [
      // Unassigned column first
      { id: UNASSIGNED_ID, name: 'Unassigned', color: '#9E9E9E', type: 'OTR', unit: '0', hidden: false, sortOrder: -1 },
      ...DUMMY_ASSETS.map(a => ({ ...a, id: -a.id, hidden: false })),
    ];
    const demoEvents = DUMMY_EVENTS.map(e => ({
      ...e,
      id:      `demo-${e.id}`,
      assetId: e.assetId === 99 ? UNASSIGNED_ID : -e.assetId,
      start:   e.start.replace(DEMO_BASE_DATE, today),
      end:     e.end.replace(DEMO_BASE_DATE, today),
    }));
    const demoDrivers = DUMMY_DRIVERS.map(d => ({ ...d, id: -d.id }));
    const demoPrefs: Record<number, number> = {};
    DUMMY_ASSETS.forEach(a => { demoPrefs[-a.id] = -a.id; });
    set({
      isDemo:               true,
      assets:               demoAssets,
      events:               demoEvents,
      drivers:              demoDrivers,
      driverPrefs:          demoPrefs,
      driverPrefsSecondary: {},
      showUnassigned:       true,
      unassignedAssetId:    UNASSIGNED_ID,
      currentDate:          todayAtNoon(),
    });
  },
  exitDemoMode: () => set({
    isDemo:               false,
    assets:               [],
    events:               [],
    deletedEvents:        [],
    drivers:              [],
    driverPrefs:          {},
    driverPrefsSecondary: {},
    loadedStart:          null,
    loadedEnd:            null,
    unassignedAssetId:    null,
  }),

  showStatusOverlay: true,
  setShowStatusOverlay: (v) => set({ showStatusOverlay: v }),
  showConfirmedOverlay: true,
  setShowConfirmedOverlay: (v) => set({ showConfirmedOverlay: v }),
  showPodOverlay: true,
  setShowPodOverlay: (v) => set({ showPodOverlay: v }),
  showBillingOverlay: true,
  setShowBillingOverlay: (v) => set({ showBillingOverlay: v }),

  calendarTimezone: 'America/Denver',
  setCalendarTimezone: (tz) => set({ calendarTimezone: tz }),

  calendarMode: 'loads',
  setCalendarMode: (mode) => set({ calendarMode: mode }),
  movementsByVehicle: {},
  movementsLoading: false,
  movementsError: null,
  movementsRequestId: 0,
  fetchMovements: async (start, end) => {
    // Stamp this call so a stale response from a previous date can't
    // overwrite the data for the date the user is currently looking at.
    // The race fires reliably when navigating between days quickly
    // (which is exactly when users say "movements disappeared").
    const requestId = useCalendarStore.getState().movementsRequestId + 1;
    set({ movementsRequestId: requestId, movementsLoading: true, movementsError: null });

    // Expand the YYYY-MM-DD inputs to a UTC window that covers the
    // whole calendar day regardless of org tz (overshoots by ±12h —
    // MovementCard already filters down to visible periods on the
    // current day, so over-fetching is harmless).
    const dayMs = 86_400_000;
    const fromIso = new Date(new Date(`${start}T00:00:00Z`).getTime() - dayMs / 2).toISOString();
    const toIso   = new Date(new Date(`${end}T00:00:00Z`).getTime()   + 1.5 * dayMs).toISOString();

    // Retry up to 3× with backoff (500ms, 1500ms) on transient errors —
    // Railway cold-starts, brief network blips, the auth-token race
    // beating the provider's first useEffect. The biggest source of
    // "Motive movements disappear sometimes" was a single 401/502 on
    // first paint silently swallowing the response.
    const { railway } = await import('@/lib/railway');
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await railway.listMovements(fromIso, toIso);

        // Check whether a NEWER fetch has fired in the meantime; if so
        // this response is stale, drop it on the floor.
        if (useCalendarStore.getState().movementsRequestId !== requestId) return;

        set({
          movementsByVehicle: res.byVehicle ?? {},
          movementsLoading:   false,
          movementsError:     null,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          // Backoff before the next retry.
          await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt)));
        }
      }
    }

    // Out of retries — record the error but DON'T wipe the existing
    // movementsByVehicle. Showing the last known data + an error
    // banner is strictly better than going blank, especially when
    // the failure is transient (the next nav will refetch cleanly).
    if (useCalendarStore.getState().movementsRequestId !== requestId) return;
    console.error('[useCalendarStore] fetchMovements failed after 3 attempts:', lastErr);
    set({
      movementsLoading: false,
      movementsError:   lastErr instanceof Error ? lastErr.message : 'Failed to load movements',
    });
  },

  cardFields: DEFAULT_CARD_FIELDS,
  setCardFields: (fields) => set({ cardFields: fields }),

  showUnassigned: true,
  unassignedAssetId: null,
  triageMode: false,
  setTriageMode: (v) => set({ triageMode: v }),

  trayOpen: false,
  setTrayOpen: (v) => set({ trayOpen: v }),
  smartAssignEventId: null,
  setSmartAssignEventId: (id) => set({ smartAssignEventId: id }),
  setShowUnassigned: (v: boolean) => {
    set({ showUnassigned: v });
    if (!v) return;
    const { unassignedAssetId, assets, orgId } = get();
    const assetExists = unassignedAssetId !== null && assets.some(a => a.id === unassignedAssetId);
    if (assetExists || !orgId) return;
    const tempId = -Date.now();
    set((state) => ({
      assets: [{ id: tempId, name: 'Unassigned', color: '#94a3b8', type: 'Unassigned', unit: '-', hidden: false, sortOrder: -1 }, ...state.assets],
    }));
    railway.createAsset({
      name: 'Unassigned', color: '#94a3b8', type: 'Unassigned',
      unit: '-', hidden: false, sortOrder: -1,
    }).then(({ asset }) => {
      set((state) => ({
        assets: state.assets.map((a) => (a.id === tempId ? asset : a)),
        unassignedAssetId: asset.id,
      }));
    }).catch((err) => console.error('setShowUnassigned:', err));
  },

  activeCategoryFilter: null,
  setActiveCategoryFilter: (cat) => set({ activeCategoryFilter: cat }),

  dragState: null,
  setDragState: (s) => set({ dragState: s }),

  // ── Saved Locations ───────────────────────────────────────────────────────
  savedLocations: [],
  fetchSavedLocations: async () => {
    const { orgId } = get();
    if (!orgId) return;
    const locs = await fetchSavedLocations(orgId);
    set({ savedLocations: locs });
  },
  addSavedLocation: async (loc) => {
    const { orgId } = get();
    if (!orgId) return;
    const created = await createSavedLocation(orgId, loc);
    if (created) set((s) => ({ savedLocations: [...s.savedLocations, created].sort((a, b) => a.name.localeCompare(b.name)) }));
  },
  updateSavedLocation: async (id, updates) => {
    await updateSavedLocation(id, updates);
    set((s) => ({ savedLocations: s.savedLocations.map((l) => l.id === id ? { ...l, ...updates } : l) }));
  },
  removeSavedLocation: async (id) => {
    try {
      await deleteSavedLocation(id);
      set((s) => ({ savedLocations: s.savedLocations.filter((l) => l.id !== id) }));
    } catch (err) {
      notifyDeleteError('Saved Location', err);
    }
  },

  // ── Dispatchers ───────────────────────────────────────────────────────────
  dispatchers: [],
  fetchDispatchers: async () => {
    const { orgId } = get();
    if (!orgId) return;
    const list = await fetchDispatchers(orgId);
    set({ dispatchers: list });
  },
  addDispatcher: async (name, isDefault) => {
    const { orgId } = get();
    if (!orgId) return;
    const created = await createDispatcher(orgId, name, isDefault);
    if (!created) return;
    set((s) => ({
      dispatchers: isDefault
        ? [...s.dispatchers.map(d => ({ ...d, isDefault: false })), created].sort((a, b) => a.name.localeCompare(b.name))
        : [...s.dispatchers, created].sort((a, b) => a.name.localeCompare(b.name)),
    }));
  },
  updateDispatcher: async (id, updates) => {
    const { orgId } = get();
    if (!orgId) return;
    await updateDispatcher(id, orgId, updates);
    set((s) => ({
      dispatchers: s.dispatchers.map(d => {
        if (updates.isDefault && d.id !== id) return { ...d, isDefault: false };
        if (d.id === id) return { ...d, ...updates };
        return d;
      }),
    }));
  },
  removeDispatcher: async (id) => {
    try {
      await deleteDispatcher(id);
      set((s) => ({ dispatchers: s.dispatchers.filter(d => d.id !== id) }));
    } catch (err) {
      notifyDeleteError('Dispatcher', err);
    }
  },

  // ── Customers ─────────────────────────────────────────────────────────────
  customers: [],
  fetchCustomers: async () => {
    const { orgId } = get();
    if (!orgId) return;
    const list = await fetchCustomers(orgId);
    set({ customers: list });
  },
  addCustomer: async (c) => {
    const { orgId } = get();
    if (!orgId) return null;
    const created = await createCustomer(orgId, c);
    if (!created) return null;
    set((s) => ({ customers: [...s.customers, created].sort((a, b) => a.name.localeCompare(b.name)) }));
    return created;
  },
  updateCustomer: async (id, updates) => {
    await updateCustomer(id, updates);
    set((s) => ({ customers: s.customers.map(c => c.id === id ? { ...c, ...updates } : c) }));
  },
  removeCustomer: async (id) => {
    try {
      await deleteCustomer(id);
      set((s) => ({ customers: s.customers.filter(c => c.id !== id) }));
    } catch (err) {
      notifyDeleteError('Customer', err);
    }
  },
  addCustomerAlias: async (id, alias) => {
    const customer = get().customers.find(c => c.id === id);
    if (!customer || customer.aliases.includes(alias)) return;
    const newAliases = [...customer.aliases, alias];
    await updateCustomer(id, { aliases: newAliases });
    set((s) => ({ customers: s.customers.map(c => c.id === id ? { ...c, aliases: newAliases } : c) }));
  },
  addCustomerContact: async (id, contact) => {
    const customer = get().customers.find(c => c.id === id);
    if (!customer) return;
    const name  = contact.name?.trim();
    const email = contact.email?.trim().toLowerCase();
    const phone = contact.phone?.trim().replace(/\D/g, '');
    // Nothing meaningful → don't add.
    if (!name && !email && !phone) return;
    // Dedup by email or phone (case-insensitive / digits-only).
    const existing = customer.contacts ?? [];
    const dupe = existing.some(c => {
      const e = c.email?.trim().toLowerCase();
      const p = c.phone?.trim().replace(/\D/g, '');
      return (email && e && email === e) || (phone && p && phone === p);
    });
    if (dupe) return;
    const next = [
      ...existing,
      {
        id:    crypto.randomUUID(),
        name:  contact.name?.trim()  || undefined,
        email: contact.email?.trim() || undefined,
        phone: contact.phone?.trim() || undefined,
      },
    ];
    await updateCustomer(id, { contacts: next });
    set((s) => ({ customers: s.customers.map(c => c.id === id ? { ...c, contacts: next } : c) }));
  },

  // ── Trailers ──────────────────────────────────────────────────────────────
  trailers: [],
  fetchTrailers: async () => {
    const { orgId } = get();
    if (!orgId) return;
    const list = await fetchTrailers(orgId);
    set({ trailers: list });
  },
  addTrailer: async (t) => {
    const { orgId } = get();
    if (!orgId) throw new Error('Not authenticated');
    const sortOrder = get().trailers.length;
    const created = await createTrailer(orgId, t, sortOrder);
    if (!created) throw new Error('Failed to save trailer — check console for details');
    set((s) => ({ trailers: [...s.trailers, created] }));
    return created.id;
  },
  updateTrailer: async (id, updates) => {
    await updateTrailer(id, updates);
    set((s) => ({ trailers: s.trailers.map(t => t.id === id ? { ...t, ...updates } : t) }));
  },
  removeTrailer: async (id) => {
    // The backend's DELETE /v1/trailers/:id is a soft-retire — it
    // stamps active_to=today rather than dropping the row, so any
    // historical loads still reference a real trailer record. Mirror
    // that locally: mark the trailer retired (activeTo=today) instead
    // of filtering it out. The settings list sorts retired entries to
    // the bottom and shows a "Retired" pill; the calendar +
    // trailer-fleet panel already skip trailers with activeTo set.
    try {
      await deleteTrailer(id);
      const today = (() => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      })();
      set((s) => ({
        trailers: s.trailers.map(t => t.id === id ? { ...t, activeTo: t.activeTo ?? today } : t),
      }));
    } catch (err) {
      notifyDeleteError('Trailer', err);
    }
  },
  hardDeleteTrailer: async (id) => {
    // Mirrors hardDeleteAsset/hardDeleteDriver — optimistic remove
    // from the local store, then call the API. On failure (most
    // likely 409 because something still references this trailer)
    // we roll back and re-throw so the caller can surface the
    // blocker reason inline.
    if (get().isDemo) return;
    const prevTrailers = get().trailers;
    set((s) => ({ trailers: s.trailers.filter(t => t.id !== id) }));
    try {
      await railway.hardDeleteTrailer(id);
    } catch (err) {
      set({ trailers: prevTrailers });
      throw err;
    }
  },

  // ── Asset categories ──────────────────────────────────────────────────────
  addAssetCategory: (name) =>
    set((state) => ({ assetCategories: [...state.assetCategories, name] })),

  updateAssetCategory: (oldName, newName) => {
    const affected = get().assets.filter((a) => a.type === oldName).map((a) => a.id).filter((id) => id > 0);
    set((state) => ({
      assetCategories: state.assetCategories.map((c) => (c === oldName ? newName : c)),
      assets: state.assets.map((a) => (a.type === oldName ? { ...a, type: newName } : a)),
    }));
    // Per-asset PATCH; small N (≤25 trucks) so this is fine.
    affected.forEach((id) => {
      railway.updateAsset(id, { type: newName }).catch((err) => console.error('updateAssetCategory:', err));
    });
  },

  removeAssetCategory: (name) =>
    set((state) => ({ assetCategories: state.assetCategories.filter((c) => c !== name) })),

  reorderAssetCategories: (fromIdx, toIdx) =>
    set((state) => {
      const arr = [...state.assetCategories];
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return { assetCategories: arr };
    }),

  // ── Assets ────────────────────────────────────────────────────────────────
  addAsset: async (asset) => {
    if (get().isDemo) return -1;
    const tempId = -Date.now();
    set((state) => ({ assets: [...state.assets, { ...asset, id: tempId }] }));
    const { orgId } = get();
    if (!orgId) return tempId;
    try {
      const { asset: created } = await railway.createAsset({
        name:            asset.name,
        color:           asset.color,
        type:            asset.type,
        unit:            asset.unit             ?? null,
        truck:           asset.truck            ?? null,
        notes:           asset.notes            ?? null,
        hidden:          asset.hidden           ?? false,
        motiveVehicleId: asset.motiveVehicleId  ?? null,
        sortOrder:       get().assets.length - 1,
        // Forward activeFrom when the caller supplied one. Server
        // falls back to today otherwise.
        ...(asset.activeFrom != null ? { activeFrom: asset.activeFrom } : {}),
      });
      set((state) => ({
        assets: state.assets.map((a) => a.id === tempId ? { ...created } : a),
      }));
      return created.id;
    } catch (err) {
      console.error('addAsset:', err);
      // Roll back the optimistic insert if the server call failed.
      set((state) => ({ assets: state.assets.filter((a) => a.id !== tempId) }));
      throw err;
    }
  },

  updateAsset: (id, updates) => {
    set((state) => ({ assets: state.assets.map((a) => (a.id === id ? { ...a, ...updates } : a)) }));
    if (get().isDemo) return;
    const body = {
      ...(updates.name !== undefined            ? { name: updates.name } : {}),
      ...(updates.color !== undefined           ? { color: updates.color } : {}),
      ...(updates.type !== undefined            ? { type: updates.type } : {}),
      ...(updates.unit !== undefined            ? { unit: updates.unit ?? null } : {}),
      ...(updates.truck !== undefined           ? { truck: updates.truck ?? null } : {}),
      ...(updates.notes !== undefined           ? { notes: updates.notes ?? null } : {}),
      ...(updates.hidden !== undefined          ? { hidden: updates.hidden } : {}),
      ...(updates.motiveVehicleId !== undefined ? { motiveVehicleId: updates.motiveVehicleId ?? null } : {}),
      ...(updates.activeFrom !== undefined      ? { activeFrom: updates.activeFrom } : {}),
      ...(updates.activeTo !== undefined        ? { activeTo: updates.activeTo ?? null } : {}),
    };
    if (Object.keys(body).length === 0) return;
    railway.updateAsset(id, body).catch((err) => console.error('updateAsset:', err));
  },

  removeAsset: (id) => {
    if (get().isDemo) return;
    // Snapshot pre-mutation state so we can roll back on API failure
    // (most often a 403 for users without assets.delete).
    const prevAssets        = get().assets;
    const prevEvents        = get().events;
    const prevDeletedEvents = get().deletedEvents;
    set((state) => ({
      assets:        state.assets.filter((a) => a.id !== id),
      events:        state.events.filter((e) => e.assetId !== id),
      deletedEvents: state.deletedEvents.filter((e) => e.assetId !== id),
    }));
    railway.deleteAsset(id).catch((err) => {
      set({ assets: prevAssets, events: prevEvents, deletedEvents: prevDeletedEvents });
      notifyDeleteError('Asset', err);
    });
  },

  hardDeleteAsset: async (id) => {
    if (get().isDemo) return;
    const prevAssets        = get().assets;
    const prevEvents        = get().events;
    const prevDeletedEvents = get().deletedEvents;
    // Optimistic remove
    set((state) => ({
      assets:        state.assets.filter((a) => a.id !== id),
      events:        state.events.filter((e) => e.assetId !== id),
      deletedEvents: state.deletedEvents.filter((e) => e.assetId !== id),
    }));
    try {
      await railway.hardDeleteAsset(id);
    } catch (err) {
      // Roll back on any failure — the most likely case is 409 from
      // events still referencing the asset, which means the caller's
      // "no loads attached" check was wrong (e.g. cached state).
      set({ assets: prevAssets, events: prevEvents, deletedEvents: prevDeletedEvents });
      throw err;
    }
  },

  reorderAssets: (fromId, toId) => {
    if (get().isDemo) return;
    const { assets: cur, unassignedAssetId: unassignedId } = get();
    const arr = [...cur];
    const fromIdx = arr.findIndex(a => a.id === fromId);
    const toIdx   = arr.findIndex(a => a.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(fromIdx < toIdx ? toIdx - 1 : toIdx, 0, moved);

    let order = 0;
    const withOrder = arr.map(a =>
      a.id === unassignedId ? { ...a, sortOrder: -1 } : { ...a, sortOrder: order++ }
    );
    set({ assets: withOrder });

    const reorderIds = withOrder.filter(a => a.id > 0 && a.id !== unassignedId).map(a => a.id);
    if (reorderIds.length) {
      railway.reorderAssets(reorderIds).catch((err) => console.error('reorderAssets:', err));
    }
  },

  toggleAssetVisibility: (id) => {
    const newHidden = !get().assets.find((a) => a.id === id)?.hidden;
    set((state) => ({
      assets: state.assets.map((a) => a.id === id ? { ...a, hidden: newHidden } : a),
    }));
    railway.updateAsset(id, { hidden: newHidden })
      .catch((err) => console.error('toggleAssetVisibility:', err));
  },

  // ── Drivers ───────────────────────────────────────────────────────────────
  addDriver: async (input) => {
    if (get().isDemo) return -1;
    // Normalize bare-name (legacy) calls into the full shape.
    const payload: Partial<Omit<Driver, 'id'>> = typeof input === 'string'
      ? { name: input }
      : input;
    const tempId = -Date.now();
    // Optimistic insert so the UI sees the row instantly. Real id
    // arrives a tick later from the server.
    const draftDriver: Driver = {
      id:   tempId,
      name: payload.name ?? '',
      ...(payload.firstName      != null ? { firstName:      payload.firstName      } : {}),
      ...(payload.lastName       != null ? { lastName:       payload.lastName       } : {}),
      ...(payload.phone          != null ? { phone:          payload.phone          } : {}),
      ...(payload.email          != null ? { email:          payload.email          } : {}),
      ...(payload.address        != null ? { address:        payload.address        } : {}),
      ...(payload.notes          != null ? { notes:          payload.notes          } : {}),
      ...(payload.licenseNumber  != null ? { licenseNumber:  payload.licenseNumber  } : {}),
      ...(payload.licenseState   != null ? { licenseState:   payload.licenseState   } : {}),
      ...(payload.licenseExp     != null ? { licenseExp:     payload.licenseExp     } : {}),
      ...(payload.medicalCardExp != null ? { medicalCardExp: payload.medicalCardExp } : {}),
      ...(payload.dob            != null ? { dob:            payload.dob            } : {}),
    };
    set((state) => ({ drivers: [...state.drivers, draftDriver] }));
    try {
      const { driver } = await railway.createDriver(payload as { name: string });
      // Replace temp with real row. If the create succeeded but
      // payload included optional fields, follow up with an update
      // so they hit the DB (createDriver only persists name today).
      const realId = driver.id;
      set((state) => ({
        drivers: state.drivers.map((d) => d.id === tempId ? { ...driver } : d),
      }));
      // Persist the rest of the fields via updateDriver so the server
      // catches up. addDriver in the store already accepts the same
      // Partial<Driver> shape on the wire.
      const rest: Partial<Omit<Driver, 'id'>> = { ...payload };
      delete (rest as { name?: string }).name;
      if (Object.keys(rest).length > 0) {
        await railway.updateDriver(realId, rest);
        set((state) => ({
          drivers: state.drivers.map((d) => d.id === realId ? { ...d, ...rest } : d),
        }));
      }
      return realId;
    } catch (err) {
      console.error('addDriver:', err);
      // Roll back the optimistic insert.
      set((state) => ({ drivers: state.drivers.filter((d) => d.id !== tempId) }));
      throw err;
    }
  },

  updateDriver: (id, updates) => {
    set((state) => ({ drivers: state.drivers.map((d) => (d.id === id ? { ...d, ...updates } : d)) }));
    if (get().isDemo) return;
    const body = {
      ...(updates.name           !== undefined ? { name: updates.name } : {}),
      ...(updates.firstName      !== undefined ? { firstName: updates.firstName ?? null } : {}),
      ...(updates.lastName       !== undefined ? { lastName: updates.lastName ?? null } : {}),
      ...(updates.phone          !== undefined ? { phone: normalizePhone(updates.phone) } : {}),
      ...(updates.notes          !== undefined ? { notes: updates.notes ?? null } : {}),
      ...(updates.email          !== undefined ? { email: updates.email ?? null } : {}),
      ...(updates.address        !== undefined ? { address: updates.address ?? null } : {}),
      ...(updates.licenseNumber  !== undefined ? { licenseNumber: updates.licenseNumber ?? null } : {}),
      ...(updates.licenseState   !== undefined ? { licenseState: updates.licenseState ?? null } : {}),
      ...(updates.licenseExp     !== undefined ? { licenseExp: updates.licenseExp ?? null } : {}),
      ...(updates.medicalCardExp !== undefined ? { medicalCardExp: updates.medicalCardExp ?? null } : {}),
      ...(updates.dob            !== undefined ? { dob: updates.dob ?? null } : {}),
      ...(updates.activeFrom     !== undefined ? { activeFrom: updates.activeFrom } : {}),
      ...(updates.activeTo       !== undefined ? { activeTo: updates.activeTo ?? null } : {}),
      // Owner-op flag — without this, the store's local optimistic
      // update flips the checkbox on but the PATCH body never includes
      // the field and the server keeps exclude_from_reports=false.
      // Next refresh reverts the UI to the actual server state and the
      // toggle appears unsticky. (Add other new Driver fields to this
      // allowlist as they land; this is the bottleneck.)
      ...(updates.excludeFromReports !== undefined ? { excludeFromReports: updates.excludeFromReports } : {}),
    };
    if (Object.keys(body).length === 0) return;
    railway.updateDriver(id, body).catch((err) => console.error('updateDriver:', err));
  },

  removeDriver: (id) => {
    if (get().isDemo) return;
    const prevDrivers     = get().drivers;
    const prevDriverPrefs = get().driverPrefs;
    const prefs = { ...prevDriverPrefs };
    Object.keys(prefs).forEach((k) => { if (prefs[+k] === id) delete prefs[+k]; });
    set((state) => ({ drivers: state.drivers.filter((d) => d.id !== id), driverPrefs: prefs }));
    railway.deleteDriver(id).catch((err) => {
      set({ drivers: prevDrivers, driverPrefs: prevDriverPrefs });
      notifyDeleteError('Driver', err);
    });
  },

  hardDeleteDriver: async (id) => {
    if (get().isDemo) return;
    const prevDrivers     = get().drivers;
    const prevDriverPrefs = get().driverPrefs;
    const prefs = { ...prevDriverPrefs };
    Object.keys(prefs).forEach((k) => { if (prefs[+k] === id) delete prefs[+k]; });
    set((state) => ({ drivers: state.drivers.filter((d) => d.id !== id), driverPrefs: prefs }));
    try {
      await railway.hardDeleteDriver(id);
    } catch (err) {
      set({ drivers: prevDrivers, driverPrefs: prevDriverPrefs });
      throw err;
    }
  },

  setDriverPref: (assetId, driverId) => {
    set((state) => {
      const prefs = { ...state.driverPrefs };
      if (driverId === null) delete prefs[assetId];
      else prefs[assetId] = driverId;
      return { driverPrefs: prefs };
    });
    // The PUT endpoint accepts a single-field patch; we never want to
    // touch the secondary slot from this setter. The API still deletes
    // the whole row server-side when BOTH slots end up null.
    railway.setDriverAssetPref(assetId, { driverId })
      .catch((err) => console.error('setDriverPref upsert:', err));
  },

  setDriverPrefSecondary: (assetId, driverId) => {
    set((state) => {
      const prefs = { ...state.driverPrefsSecondary };
      if (driverId === null) delete prefs[assetId];
      else prefs[assetId] = driverId;
      return { driverPrefsSecondary: prefs };
    });
    railway.setDriverAssetPref(assetId, { secondaryDriverId: driverId })
      .catch((err) => console.error('setDriverPrefSecondary upsert:', err));
  },

  // ── Events ────────────────────────────────────────────────────────────────
  addEvent: (event, presetId?, options?) => {
    if (get().isDemo) return;
    const tempId = presetId ?? crypto.randomUUID();
    // Optimistic insert with temp id; gets swapped for the server-allocated
    // uuid when the Railway create returns.
    set((state) => ({ events: [...state.events, { ...event, id: tempId }] }));
    const { orgId } = get();
    if (!orgId) return;
    const resolved = withResolvedDriverId(event, get().drivers);

    // Non-revenue events have no parent load; use POST /v1/events.
    if (event.eventKind === 'non_revenue') {
      railway.createEvent({
        title:          event.title,
        start:          event.start,
        end:            event.end,
        assetId:        event.assetId,
        nonRevenueType: event.nonRevenueType ?? 'Other',
        driverId:       resolved.driverId,
        driverName:     resolved.driverName ?? undefined,
        status:         event.status,
        trailerId:      event.trailerId,
        trailerType:    event.trailerType,
        driverPay:      event.driverPay,
        eventNotes:     event.notes,           // for non-revenue, web.notes is event-level
        priority:       event.priority,
        stops:          event.stops,
      })
        .then((res) => {
          const created = res.loads[0];
          if (!created) return;
          // Remove temp AND any prior insertion of the real id (defensive
          // against realtime/refetch racing with the .then swap).
          set((state) => ({
            events: [
              ...state.events.filter((e) => e.id !== tempId && e.id !== created.id),
              created,
            ],
          }));
          // Flush pending work-order links AFTER the server-allocated
          // event id is known. Previously EventModal fired these against
          // the temp id (presetId) immediately after addEvent returned,
          // which then got swapped out, leaving the WOs linked to a
          // ghost uuid that didn't exist on the server. Fire-and-forget
          // — failure is non-fatal; the user can re-link from the
          // maintenance side.
          //
          // Multi-link semantics: each WO might already be linked to
          // other shop days, so we ADD created.id to its existing
          // eventIds set rather than replacing. We pull current state
          // first to preserve those other links.
          const linkIds = options?.linkWorkOrderIds;
          if (linkIds && linkIds.length > 0) {
            void Promise.all(
              linkIds.map(async (woId) => {
                try {
                  const cur = await railway.getMaintenanceActionItem(woId);
                  const existing = cur.actionItem.eventIds ?? (cur.actionItem.eventId ? [cur.actionItem.eventId] : []);
                  const next = Array.from(new Set([...existing, created.id]));
                  await railway.updateMaintenanceActionItem(woId, { eventIds: next });
                } catch (err) {
                  console.error('[addEvent] link work order failed:', woId, err);
                }
              }),
            );
          }
        })
        .catch((err) => console.error('addEvent (non-revenue):', err));
      return;
    }

    // Revenue events: POST /v1/loads creates load + 1 event in one shot.
    const { load, event: evBody } = buildCreateLoadBody({
      ...event,
      driverId: resolved.driverId ?? undefined,
      driverName: resolved.driverName ?? undefined,
    });
    railway.createLoad({ load, events: [evBody] })
      .then((res) => {
        const created = res.loads[0];
        if (!created) return;
        // Remove temp AND any prior insertion of the real id (defensive
        // against realtime/refetch racing with the .then swap). Carries
        // over the joined fields the server returned (loadId, internalLoadId, etc.).
        set((state) => ({
          events: [
            ...state.events.filter((e) => e.id !== tempId && e.id !== created.id),
            created,
          ],
        }));
        // Notify driver if assigned. Rule-gated: respects org
        // notification_rules.onAssignment.enabled + hoursBeforeStart
        // window + quiet hours + the driver's per-rule opt-out.
        if (resolved.driverId) {
          // [route] = event.title (broker: pickup–delivery), [time] = canonical 12h.
          // eventId is required so the bell history can anchor the row.
          notifyDriver(
            resolved.driverId,
            'New Load Assigned',
            `${event.title} — ${fmtPushTime(event.start)}. Tap to view.`,
            { type: 'assigned', loadId: created.id, eventId: created.id, url: `/load/${created.id}` },
            'on_assignment',
            event.start,
          );
        }
      })
      .catch((err) => console.error('addEvent (revenue):', err));
  },

  updateEvent: (id, updates) => {
    const prevEvent      = get().events.find((e) => e.id === id);
    const prevDriverId   = prevEvent?.driverId;
    const prevConfirmedAt = prevEvent?.confirmedAt;
    // Tag the write so the realtime echo doesn't fire a conflict banner.
    markSelfWrite(id);
    set((state) => ({ events: state.events.map((e) => (e.id === id ? { ...e, ...updates } : e)) }));
    if (get().isDemo) return;
    const { orgId } = get();
    if (!orgId) return;

    const ev = get().events.find((e) => e.id === id);
    if (!ev) return;
    const merged = { ...ev, ...updates };
    const resolved = withResolvedDriverId(merged, get().drivers);

    // Apply driver resolution to the event-level updates so the API receives
    // the resolved driver_id when one was needed.
    //
    // When the user EXPLICITLY clears the driver ("— No driver —"), we
    // need to send null (not undefined). JSON.stringify strips
    // undefined values, so an undefined here arrives at the server as
    // "field not present" — the API's PATCH handler then leaves the
    // existing driver in place, and the form springs back to the
    // previously-assigned driver. Sending null routes through the
    // server's `update.driver_name = body.driverName ?? null` (and
    // same for driver_id) and actually clears the column.
    const resolvedUpdates: typeof updates = { ...updates };
    if ('driverId' in updates || 'driverName' in updates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (resolvedUpdates as any).driverId   = resolved.driverId   ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (resolvedUpdates as any).driverName = resolved.driverName ?? null;
    }

    const isNonRevenue = ev.eventKind === 'non_revenue';

    // Non-revenue events: only event-level updates. PATCH /v1/events/:id.
    if (isNonRevenue) {
      const evUpdate = buildEventByIdUpdate(resolvedUpdates, true);
      const promises: Promise<unknown>[] = [];
      if (Object.keys(evUpdate).length) {
        promises.push(railway.updateEvent(id, evUpdate));
      }
      if ('stops' in updates && updates.stops) {
        promises.push(railway.replaceStops(id, { stops: updates.stops }));
      }
      Promise.all(promises).catch((err) => console.error('updateEvent (non-revenue):', err));
      return;
    }

    // Revenue + has loadId: split into load update + event update.
    if (!ev.loadId) {
      console.error('updateEvent: revenue event missing loadId; ignoring write', id);
      return;
    }
    const { loadUpdates, eventUpdates } = splitForUpdate(resolvedUpdates);
    const promises: Promise<unknown>[] = [];
    if (Object.keys(loadUpdates).length) {
      promises.push(railway.updateLoad(ev.loadId, loadUpdates));
    }
    if (Object.keys(eventUpdates).length) {
      promises.push(railway.updateLoadEvent(ev.loadId, id, eventUpdates));
    }
    if ('stops' in updates && updates.stops) {
      promises.push(railway.replaceStops(id, { stops: updates.stops }));
    }
    const wroteLoad = Object.keys(loadUpdates).length > 0;
    Promise.all(promises)
      .then(() => {
        // Tell consumer pages (accounting, closeout, timeline) that a
        // load mutation just landed so they refresh their cached load
        // snapshots. Skip when only event-level fields changed — those
        // pages don't show event details and a refresh would just
        // flash the table.
        if (wroteLoad) {
          set({ loadEditTick: get().loadEditTick + 1 });
        }
        const newDriverId = resolved.driverId;
        if (newDriverId && newDriverId !== prevDriverId) {
          // Last-minute heads-up: if pickup is <6h away, fire an
          // urgent-flavor push since the driver missed both daily
          // sweeps. Otherwise, the regular "Load assigned" message
          // — driver will get the next evening sweep too.
          const pickupMs   = ev.start ? Date.parse(ev.start.replace(' ', 'T')) : NaN;
          const hoursOut   = isFinite(pickupMs) ? (pickupMs - Date.now()) / 3_600_000 : Infinity;
          const lastMinute = hoursOut > 0 && hoursOut < 6;
          // Copy spec #6/7 (≥6h) vs #8 (<6h, last-minute). [route] =
          // ev.title (broker: pickup–delivery), [time] = canonical 12h.
          notifyDriver(
            newDriverId,
            lastMinute ? 'New Load Picking Up Soon' : 'New Load Assigned',
            lastMinute
              ? `${ev.title} — Pickup ${fmtPushTime(ev.start)}. Confirm now.`
              : `${ev.title} — ${fmtPushTime(ev.start)}. Tap to view.`,
            { type: lastMinute ? 'last_minute_assign' : 'assigned', loadId: ev.loadId, eventId: id, url: `/load/${id}` },
            'on_assignment',
            ev.start,
          );
          // Notify the prior driver via the reassigned_away rule. The
          // server applies the rule's hoursBeforeStart window (default
          // 24h, configurable per-org in Settings → Driver App), plus
          // the per-driver opt-out check from driver_notification_prefs.
          // Pass eventStart so the server can do the time-window math.
          if (prevDriverId) {
            notifyDriver(
              prevDriverId,
              'Schedule Changed',
              `${ev.title} — pickup ${fmtPushTime(ev.start)} — is no longer assigned to you.`,
              // Deep-link to home — the load isn't theirs anymore, no
              // point routing to the load detail.
              { type: 'reassigned_away', loadId: ev.loadId, eventId: id, url: '/' },
              'reassigned_away',
              ev.start,
            );
          }
        }
      })
      .catch((err) => console.error('updateEvent:', err));
  },

  cancelEventKeepLoad: (id, auditEntry) => {
    if (get().isDemo) return;
    const ev = get().events.find((e) => e.id === id);
    if (!ev) return;
    markSelfWrite(id);
    // Drop the event from local state — same effect as a delete from
    // the user's perspective on the calendar — but DON'T move it to
    // the trash store (deletedEvents) because the load itself is
    // still active. If they want it back, they re-create the event
    // against the existing load.
    set((state) => ({
      events: state.events.filter((e) => e.id !== id),
    }));
    const { orgId } = get();
    if (!orgId) return;

    if (ev.eventKind === 'non_revenue' || !ev.loadId) {
      // Non-revenue events have no parent load to preserve; this path
      // is equivalent to a normal delete.
      railway.deleteEvent(id).catch((err) => console.error('cancelEventKeepLoad (non-revenue):', err));
      return;
    }

    // Persist the audit entry on the load before nuking the event so
    // the cancellation reason isn't orphaned.
    if (auditEntry) {
      const nextLog = [...(ev.auditLog ?? []), auditEntry];
      railway.updateLoad(ev.loadId, { auditLog: nextLog }).catch((err) =>
        console.error('cancelEventKeepLoad audit append:', err),
      );
    }
    railway.cancelEventKeepLoad(id).catch((err) =>
      console.error('cancelEventKeepLoad:', err),
    );

    // Cancel-keep-load — server enforces the load_cancelled rule's
    // hoursBeforeStart window + per-driver opt-out. Window default is
    // 24h, tunable in Settings → Driver App.
    if (ev.driverId) {
      notifyDriver(
        ev.driverId,
        'Load Cancelled',
        `${ev.title} — pickup ${fmtPushTime(ev.start)} — has been cancelled.`,
        // Deep-link to home — the load is gone, no detail to route to.
        { type: 'load_cancelled', loadId: ev.loadId, eventId: id, url: '/' },
        'load_cancelled',
        ev.start,
      );
    }
  },

  removeEvent: (id, auditEntry) => {
    if (get().isDemo) return;
    const ev = get().events.find((e) => e.id === id);
    if (!ev) return;
    markSelfWrite(id);
    const deletedAt = new Date().toISOString();
    const newAuditLog = auditEntry ? [...(ev.auditLog ?? []), auditEntry] : ev.auditLog;
    const updated = { ...ev, auditLog: newAuditLog };
    set((state) => ({
      events: state.events.filter((e) => e.id !== id),
      deletedEvents: [{ ...updated, deletedAt }, ...state.deletedEvents],
    }));
    const { orgId } = get();
    if (!orgId) return;

    // If the API rejects (race, server-side rule change, etc.), roll
    // the optimistic update back so the load reappears on the calendar
    // and disappears from "Recently Deleted". The UI gate already
    // hides the Cancel/Remove buttons from roles without loads.delete,
    // so this only fires in edge cases — no user-facing alert.
    const rollback = (err: unknown) => {
      console.error('removeEvent:', err);
      set((state) => ({
        events: state.events.some((e) => e.id === id) ? state.events : [...state.events, ev],
        deletedEvents: state.deletedEvents.filter((d) => d.id !== id),
      }));
    };

    if (ev.eventKind === 'non_revenue') {
      railway.deleteEvent(id).catch(rollback);
      return;
    }

    if (!ev.loadId) {
      console.error('removeEvent: revenue event missing loadId; ignoring delete', id);
      return;
    }

    // Revenue + has loadId: DELETE /v1/loads/:loadId cascades to events.
    railway.deleteLoad(ev.loadId).catch(rollback);

    // Full-delete — identical user-facing copy to the cancel-keep
    // path since the two are indistinguishable from the driver's
    // perspective. Same load_cancelled rule applies.
    if (ev.driverId) {
      notifyDriver(
        ev.driverId,
        'Load Cancelled',
        `${ev.title} — pickup ${fmtPushTime(ev.start)} — has been cancelled.`,
        // Deep-link to home — the load is gone, no detail to route to.
        { type: 'load_cancelled', loadId: ev.loadId, eventId: id, url: '/' },
        'load_cancelled',
        ev.start,
      );
    }
  },

  addEventFromRemote: (event) => {
    set((state) => {
      if (state.events.some(e => e.id === event.id)) return state;
      return { events: [...state.events, event] };
    });
  },

  updateEventFromRemote: (event) => {
    // If we just wrote this event locally, the realtime payload is
    // our own echo bouncing back — apply the data but don't pop the
    // "another dispatcher updated" banner.
    const isSelfEcho = consumeSelfWrite(event.id);
    set((state) => {
      const exists = state.events.some(e => e.id === event.id);
      if (!exists) {
        // Upsert: realtime INSERTs flow through here too (RealtimeSync
        // refetches every new event and feeds it to this action). The
        // previous .map()-only logic silently dropped events that
        // weren't already cached — a load created by another dispatcher
        // would arrive on the wire but never land in `events`.
        return {
          events: [...state.events, event],
          modalConflict: state.modalConflict,
        };
      }
      return {
        events: state.events.map(e => {
          if (e.id !== event.id) return e;
          // Take the incoming stops when populated; fall back to local
          // copy only when the refetch came back empty (defensive).
          const stops = (event.stops && event.stops.length > 0) ? event.stops : e.stops;
          return { ...e, ...event, stops };
        }),
        modalConflict: !isSelfEcho && state.modalOpen && state.modalEventId === event.id
          ? 'updated'
          : state.modalConflict,
      };
    });
  },

  refetchingEventIds: new Set<string>(),
  refetchEvent: async (id) => {
    // Track in-flight refetches so UI can render a spinner. The set is
    // copied on each mutation so Zustand subscribers re-render — Sets
    // are reference-equal under mutation, which would skip updates.
    set(state => {
      const next = new Set(state.refetchingEventIds);
      next.add(id);
      return { refetchingEventIds: next };
    });
    try {
      const { loads } = await railway.getEvent(id);
      // /v1/events/:id returns the requested leg plus its relay partner
      // if any — upsert all so a relay refresh heals both legs at once.
      // Mark each returned event as a self-write BEFORE the upsert so
      // the conflict banner ("updated by another dispatcher") doesn't
      // pop on a refresh we ourselves triggered. updateEventFromRemote
      // calls consumeSelfWrite(event.id) — a recent stamp suppresses
      // the banner. Without this, every modal open would pop the
      // banner via the auto-recover refetch in EventModal.
      for (const load of loads) {
        markSelfWrite(load.id);
      }
      for (const load of loads) {
        get().updateEventFromRemote(load);
      }
    } catch (err) {
      console.error('refetchEvent:', err);
      throw err;
    } finally {
      set(state => {
        const next = new Set(state.refetchingEventIds);
        next.delete(id);
        return { refetchingEventIds: next };
      });
    }
  },

  removeEventFromRemote: (id) => {
    const isSelfEcho = consumeSelfWrite(id);
    set((state) => ({
      events: state.events.filter(e => e.id !== id),
      modalConflict: !isSelfEcho && state.modalOpen && state.modalEventId === id
        ? 'deleted'
        : state.modalConflict,
    }));
  },

  restoreEvent: (id, auditEntry) => {
    const ev = get().deletedEvents.find((e) => e.id === id);
    if (!ev) return;
    const { deletedAt: _, ...rest } = ev;
    const newAuditLog = auditEntry ? [...(rest.auditLog ?? []), auditEntry] : rest.auditLog;
    const restored = { ...rest, auditLog: newAuditLog };
    set((state) => ({
      events: [...state.events, restored],
      deletedEvents: state.deletedEvents.filter((e) => e.id !== id),
    }));
    const { orgId } = get();
    if (!orgId) return;

    if (ev.eventKind === 'non_revenue') {
      // Non-revenue events have no parent load — un-soft-delete the event row directly.
      const patch: Record<string, unknown> = { deleted_at: null };
      if (auditEntry) patch.audit_log = newAuditLog;
      db().from('events').update(patch).eq('id', id).eq('org_id', orgId)
        .then(({ error }) => { if (error) console.error('restoreEvent (non-revenue):', error); });
      return;
    }

    if (!ev.loadId) {
      console.error('restoreEvent: revenue event missing loadId; ignoring restore', id);
      return;
    }

    // Revenue + has loadId: restore via load endpoint.
    railway.restoreLoad(ev.loadId).catch((err) => console.error('restoreEvent:', err));
  },

  purgeEvent: (id) => {
    const ev = get().deletedEvents.find((e) => e.id === id);
    if (!ev) return;
    set((state) => ({ deletedEvents: state.deletedEvents.filter((e) => e.id !== id) }));
    const { orgId } = get();
    if (orgId) {
      db().from('events').delete().eq('id', id).eq('org_id', orgId)
        .then(({ error }) => { if (error) console.error('purgeEvent:', error); });
    }
  },

  clearTrash: () => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = get().deletedEvents.filter((e) => Date.now() - new Date(e.deletedAt).getTime() >= THIRTY_DAYS);
    if (!expired.length) return;
    const ids = expired.map((e) => e.id);
    set((state) => ({ deletedEvents: state.deletedEvents.filter((e) => !ids.includes(e.id)) }));
    const { orgId } = get();
    if (orgId) {
      db().from('events').delete().in('id', ids).eq('org_id', orgId)
        .then(({ error }) => { if (error) console.error('clearTrash:', error); });
    }
  },

  autoExpireTrash: () => {
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = get().deletedEvents.filter((e) => Date.now() - new Date(e.deletedAt).getTime() >= THIRTY_DAYS);
    if (!expired.length) return;
    const ids = expired.map((e) => e.id);
    set((state) => ({ deletedEvents: state.deletedEvents.filter((e) => !ids.includes(e.id)) }));
    const { orgId } = get();
    if (orgId) {
      db().from('events').delete().in('id', ids).eq('org_id', orgId)
        .then(({ error }) => { if (error) console.error('autoExpireTrash:', error); });
    }
  },

  // ── Relay ─────────────────────────────────────────────────────────────────
  createRelayPair: (pickup, delivery, presetPickupId?, presetDeliveryId?) => {
    // Optimistic insert with temp ids; swapped on Railway response.
    const tempPickupId   = presetPickupId   ?? crypto.randomUUID();
    const tempDeliveryId = presetDeliveryId ?? crypto.randomUUID();
    set((state) => ({
      events: [
        ...state.events,
        { ...pickup,   relayRole: 'pickup'   as const, id: tempPickupId   },
        { ...delivery, relayRole: 'delivery' as const, id: tempDeliveryId },
      ],
    }));
    const { orgId } = get();
    if (!orgId) return;
    const drivers = get().drivers;
    const resolvedPickup   = withResolvedDriverId(pickup,   drivers);
    const resolvedDelivery = withResolvedDriverId(delivery, drivers);

    // POST /v1/loads with two events. Load-level fields come from the
    // pickup leg (in practice both legs carry the same load-level data
    // from the modal save).
    const { load } = buildCreateLoadBody({ ...pickup, driverId: resolvedPickup.driverId, driverName: resolvedPickup.driverName });
    railway.createLoad({
      load,
      events: [
        {
          title:        pickup.title,
          start:        pickup.start,
          end:          pickup.end,
          assetId:      pickup.assetId,
          driverId:     resolvedPickup.driverId,
          driverName:   resolvedPickup.driverName ?? undefined,
          status:       pickup.status,
          relayRole:    'pickup',
          trailerId:    pickup.trailerId,
          trailerType:  pickup.trailerType,
          driverPay:    pickup.driverPay,
          priority:     pickup.priority,
          stops:        pickup.stops,
        },
        {
          title:        delivery.title,
          start:        delivery.start,
          end:          delivery.end,
          assetId:      delivery.assetId,
          driverId:     resolvedDelivery.driverId,
          driverName:   resolvedDelivery.driverName ?? undefined,
          status:       delivery.status,
          relayRole:    'delivery',
          trailerId:    delivery.trailerId,
          trailerType:  delivery.trailerType,
          driverPay:    delivery.driverPay,
          priority:     delivery.priority,
          stops:        delivery.stops,
        },
      ],
    })
      .then((res) => {
        const pickupRes   = res.loads.find((l) => l.relayRole === 'pickup');
        const deliveryRes = res.loads.find((l) => l.relayRole === 'delivery');
        if (!pickupRes || !deliveryRes) return;
        // Drop temps + any prior insertions of the real ids, then add the
        // server-returned rows. Robust against realtime/refetch racing.
        const realIds = new Set([pickupRes.id, deliveryRes.id]);
        set((state) => ({
          events: [
            ...state.events.filter(
              (e) => e.id !== tempPickupId && e.id !== tempDeliveryId && !realIds.has(e.id),
            ),
            pickupRes,
            deliveryRes,
          ],
        }));
      })
      .catch((err) => console.error('createRelayPair:', err));
  },

  splitToRelay: (pickupEventId, pickupUpdates, deliveryData, presetDeliveryId) => {
    const state = get();
    const ev = state.events.find(e => e.id === pickupEventId);
    if (!ev) {
      console.error('splitToRelay: event not found', pickupEventId);
      return;
    }
    if (!ev.loadId) {
      console.error('splitToRelay: event has no loadId; cannot split', pickupEventId);
      return;
    }
    if (state.isDemo) return;
    const { orgId } = state;
    if (!orgId) return;

    const tempDeliveryId = presetDeliveryId ?? crypto.randomUUID();
    const stops = pickupUpdates.stops ?? deliveryData.stops ?? ev.stops ?? [];
    const relayIdx = stops.findIndex(s => s.type === 'relay');
    if (relayIdx < 0) {
      console.error('splitToRelay: no relay-type stop in stops list');
      return;
    }

    // Optimistic state: existing event becomes the pickup leg; add a temp
    // delivery on the same loadId. Both legs share the full stops list
    // (relay-marker is the handoff cutoff in the modal display). Server
    // mirrors this in /v1/loads/:id/split-relay.
    const updatedPickup: CalendarEvent = {
      ...ev,
      ...pickupUpdates,
      relayRole: 'pickup',
      relayGroupId: ev.loadId,
      stops,
    };
    const tempDelivery: CalendarEvent = {
      ...(deliveryData as CalendarEvent),
      id: tempDeliveryId,
      loadId: ev.loadId,
      // Propagate the existing load's load-level fields so the delivery leg
      // displays #internalLoadId, broker, accessorials, etc. immediately —
      // before the API swap. Real values come back via the .then below.
      internalLoadId: ev.internalLoadId,
      loadNum:        ev.loadNum,
      broker:         ev.broker,
      customerId:     ev.customerId,
      dispatcher:     ev.dispatcher,
      loadPrice:      ev.loadPrice,
      // Mirror the load-level total_billable onto the shadow delivery
      // leg so display surfaces (chip render, side strips) read the
      // same number on both legs of a relay. Write paths are unaffected
      // — the field is server-computed.
      totalBillable:  ev.totalBillable,
      rateConPdf:     ev.rateConPdf,
      accessorials:   ev.accessorials,
      refNums:        ev.refNums,
      notes:          ev.notes,
      relayRole: 'delivery',
      relayGroupId: ev.loadId,
      stops,
    };
    set(s => ({
      events: [...s.events.map(e => e.id === pickupEventId ? updatedPickup : e), tempDelivery],
    }));

    // 1. Apply load-level edits (broker, accessorials, notes, etc.) — splitRelay
    //    only touches event/stop rows.
    const drivers = state.drivers;
    const resolvedPickup = withResolvedDriverId({ ...ev, ...pickupUpdates }, drivers);
    const resolvedDelivery = withResolvedDriverId(deliveryData, drivers);

    const promises: Promise<unknown>[] = [];
    const { loadUpdates } = splitForUpdate(resolvedPickup);
    if (Object.keys(loadUpdates).length) {
      promises.push(railway.updateLoad(ev.loadId, loadUpdates));
    }

    // 2. Convert single → relay via the API. The server partitions stops at
    //    relayStopIndex into pickup/delivery legs and creates the delivery.
    promises.push(
      railway.splitRelay(ev.loadId, {
        pickupEnd:           updatedPickup.end,
        deliveryStart:       (deliveryData.start as string),
        deliveryEnd:         (deliveryData.end as string),
        deliveryAssetId:     resolvedDelivery.assetId as number,
        deliveryDriverId:    resolvedDelivery.driverId ?? null,
        deliveryDriverName:  resolvedDelivery.driverName ?? null,
        mergedStops:         stops,
        relayStopIndex:      relayIdx,
      }).then(res => {
        const realPickup   = res.loads.find(l => l.relayRole === 'pickup');
        const realDelivery = res.loads.find(l => l.relayRole === 'delivery');
        if (!realPickup || !realDelivery) return;
        const realIds = new Set([realPickup.id, realDelivery.id]);
        set(s => ({
          events: [
            ...s.events.filter(e => e.id !== tempDeliveryId && e.id !== pickupEventId && !realIds.has(e.id)),
            realPickup,
            realDelivery,
          ],
        }));
      }),
    );

    Promise.all(promises).catch(err => console.error('splitToRelay:', err));
  },

  saveRelayBoth: (pickupId, pickupUpdates, deliveryId, deliveryUpdates) => {
    set((state) => ({
      events: state.events.map((e) => {
        if (e.id === pickupId)   return { ...e, ...pickupUpdates };
        if (e.id === deliveryId) return { ...e, ...deliveryUpdates };
        return e;
      }),
    }));
    if (get().isDemo) return;
    const { orgId } = get();
    if (!orgId) return;

    const evts = get().events;
    const pu = evts.find((e) => e.id === pickupId);
    const de = evts.find((e) => e.id === deliveryId);
    if (!pu || !de) return;
    const drivers = get().drivers;
    const resolvedPu = withResolvedDriverId({ ...pu, ...pickupUpdates },   drivers);
    const resolvedDe = withResolvedDriverId({ ...de, ...deliveryUpdates }, drivers);

    // Apply driver resolution for the API payloads
    const puPayload: typeof pickupUpdates   = { ...pickupUpdates };
    const dePayload: typeof deliveryUpdates = { ...deliveryUpdates };
    if ('driverId' in pickupUpdates || 'driverName' in pickupUpdates) {
      puPayload.driverId   = resolvedPu.driverId   ?? undefined;
      puPayload.driverName = resolvedPu.driverName ?? undefined;
    }
    if ('driverId' in deliveryUpdates || 'driverName' in deliveryUpdates) {
      dePayload.driverId   = resolvedDe.driverId   ?? undefined;
      dePayload.driverName = resolvedDe.driverName ?? undefined;
    }

    if (!pu.loadId || !de.loadId) {
      console.error('saveRelayBoth: a leg is missing loadId; ignoring write', { pickupId, deliveryId });
      return;
    }

    // Both legs share the same loadId. Split each leg's updates into
    // load-level + event-level. Load-level should match across legs (the
    // modal shows one input for the whole load), but defensively prefer
    // the pickup leg's values when they conflict.
    const { loadUpdates: pickupLoadUpdates, eventUpdates: pickupEventUpdates } = splitForUpdate(puPayload);
    const { loadUpdates: deliveryLoadUpdates, eventUpdates: deliveryEventUpdates } = splitForUpdate(dePayload);
    const combinedLoadUpdates = { ...deliveryLoadUpdates, ...pickupLoadUpdates }; // pickup wins

    const promises: Promise<unknown>[] = [];
    if (Object.keys(combinedLoadUpdates).length) {
      promises.push(railway.updateLoad(pu.loadId, combinedLoadUpdates));
    }
    if (Object.keys(pickupEventUpdates).length) {
      promises.push(railway.updateLoadEvent(pu.loadId, pickupId, pickupEventUpdates));
    }
    if (Object.keys(deliveryEventUpdates).length) {
      promises.push(railway.updateLoadEvent(de.loadId, deliveryId, deliveryEventUpdates));
    }
    if ('stops' in pickupUpdates && pickupUpdates.stops) {
      promises.push(railway.replaceStops(pickupId, { stops: pickupUpdates.stops }));
    }
    if ('stops' in deliveryUpdates && deliveryUpdates.stops) {
      promises.push(railway.replaceStops(deliveryId, { stops: deliveryUpdates.stops }));
    }
    Promise.all(promises).catch((err) => console.error('saveRelayBoth:', err));
  },

  removeRelay: (legId, auditLog) => {
    const state = get();
    const leg = state.events.find((e) => e.id === legId);
    if (!leg) return;

    // Two events with the same load_id and relay_role set ARE the relay.
    let partner: CalendarEvent | undefined;
    if (leg.loadId) {
      partner = state.events.find((e) => e.loadId === leg.loadId && e.id !== legId);
    }
    if (!partner) return;

    const pickup   = leg.relayRole === 'pickup'   ? leg : partner;
    const delivery = leg.relayRole === 'delivery' ? leg : partner;
    if (!pickup || !delivery) return;

    const mergedStops = (pickup.stops ?? []).filter((s) => s.type !== 'relay');
    const merged: CalendarEvent = {
      ...pickup,
      end:           delivery.end,
      relayGroupId:  undefined,
      relayRole:     undefined,
      stops:         mergedStops,
      ...(auditLog !== undefined ? { auditLog } : {}),
    };
    const deletedAt = new Date().toISOString();
    const trashed: DeletedEvent = {
      ...delivery,
      deletedAt,
      relayGroupId: undefined,
      relayRole:    undefined,
    };
    set((s) => ({
      events:        s.events.filter((e) => e.id !== delivery.id).map((e) => (e.id === pickup.id ? merged : e)),
      deletedEvents: [trashed, ...s.deletedEvents],
    }));
    if (get().isDemo) return;
    const { orgId } = get();
    if (!orgId) return;

    if (!pickup.loadId || !delivery.loadId || pickup.loadId !== delivery.loadId) {
      console.error('removeRelay: legs do not share a loadId; ignoring', { pickupId: pickup.id, deliveryId: delivery.id });
      return;
    }
    railway
      .unsplitRelay(pickup.loadId, { keepEventId: pickup.id, mergedStops })
      .catch((err) => console.error('removeRelay:', err));
  },

  // ── Calendar nav ──────────────────────────────────────────────────────────
  setCurrentDate: (date) => {
    set({ currentDate: date });
    const { orgId, loadedStart, loadedEnd } = get();
    if (!orgId || !loadedStart || !loadedEnd) return;
    const iso = date.toISOString();
    if (iso >= loadedStart && iso <= loadedEnd) return;

    // Navigate outside loaded window — fetch a 2-week window around the target date
    const rangeStart = new Date(date);
    rangeStart.setDate(date.getDate() - 7);
    const rangeEnd = new Date(date);
    rangeEnd.setDate(date.getDate() + 7);
    const rs = rangeStart.toISOString();
    const re = rangeEnd.toISOString();

    fetchEventsInRange(orgId, rs, re).then(({ events, deletedEvents }) => {
      set((state) => {
        // Same upsert merge as extendLoadedRange — replace stale cached
        // events with the fresh fetch so navigating heals empty-stops
        // loads rather than silently skipping them.
        const newById = new Map(events.map(e => [e.id, e]));
        const updatedExisting = state.events.map(e => newById.get(e.id) ?? e);
        const additions = events.filter(e => !state.events.some(s => s.id === e.id));
        const newDelById = new Map(deletedEvents.map(e => [e.id, e]));
        const updatedDeleted = state.deletedEvents.map(e => newDelById.get(e.id) ?? e);
        const delAdditions = deletedEvents.filter(e => !state.deletedEvents.some(s => s.id === e.id));
        const newStart = rs < (state.loadedStart ?? rs) ? rs : (state.loadedStart ?? rs);
        const newEnd   = re > (state.loadedEnd   ?? re) ? re : (state.loadedEnd   ?? re);
        return {
          events:        [...updatedExisting, ...additions],
          deletedEvents: [...updatedDeleted,  ...delAdditions],
          loadedStart: newStart,
          loadedEnd:   newEnd,
        };
      });
    }).catch((err) => console.error('[store] fetchEventsInRange:', err));
  },
  setResourceWidth: (width, userInitiated = false) => set({ resourceWidth: width, ...(userInitiated ? { resourceWidthLocked: true } : {}) }),
  unlockResourceWidth: () => set({ resourceWidthLocked: false }),
  setRowHeight: (h) => set({ rowHeight: h }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  // ── Batch import ──────────────────────────────────────────────────────────
  batchItems: [],
  batchIndex: 0,
  batchParseProgress: 0,
  batchParseTotal: 0,
  batchMinimized: false,
  batchCancelRequested: false,
  startBatch: (items) => set({ batchItems: items, batchIndex: 0, batchMinimized: false, batchCancelRequested: false }),
  batchNext:  () => set((state) => ({ batchIndex: state.batchIndex + 1 })),
  clearBatch: () => set({ batchItems: [], batchIndex: 0, batchParseProgress: 0, batchParseTotal: 0, batchMinimized: false, batchCancelRequested: false }),
  setBatchParseState: (progress, total) => set({ batchParseProgress: progress, batchParseTotal: total }),
  setBatchMinimized:  (v) => set({ batchMinimized: v }),
  requestBatchCancel: () => set({ batchCancelRequested: true, batchParseTotal: 0, batchParseProgress: 0 }),

  // Monotonic counter bumped by updateEvent after every successful
  // railway.updateLoad. Consumer pages that hold their own load
  // snapshot subscribe to this and refetch on change. See type comment
  // above for rationale.
  loadEditTick: 0,
  bumpLoadEditTick: () => set((s) => ({ loadEditTick: s.loadEditTick + 1 })),

  // ── Modal ─────────────────────────────────────────────────────────────────
  modalOpen:      false,
  modalMode:      'create',
  modalEventId:   undefined,
  modalDefaults:  undefined,
  modalShowMap:   false,
  modalConflict:  null,
  prefillWorkOrderLinkIds: undefined,

  eldLocations: [],
  eldLocationsFetchedAt: null,
  eldLocationsLoading: false,
  setEldLocations: (locs) => set({ eldLocations: locs, eldLocationsFetchedAt: Date.now() }),
  refreshEldLocations: async () => {
    if (get().eldLocationsLoading) return; // coalesce overlapping calls
    set({ eldLocationsLoading: true });
    try {
      const res = await fetch('/api/motive/locations');
      if (!res.ok) return;
      const body = await res.json();
      const locs: EldLocation[] = Array.isArray(body)
        ? body
        : (Array.isArray(body?.locations) ? body.locations : []);
      set({ eldLocations: locs, eldLocationsFetchedAt: Date.now() });
    } catch { /* stale data is fine — leave previous list in place */ }
    finally { set({ eldLocationsLoading: false }); }
  },

  openCreateModal: (defaults, opts) =>
    set({
      modalOpen: true, modalMode: 'create', modalEventId: undefined,
      modalDefaults: defaults, modalShowMap: false,
      prefillWorkOrderLinkIds: opts?.prefillWorkOrderLinkIds,
    }),

  openEditModal: (eventId) =>
    set({ modalOpen: true, modalMode: 'edit', modalEventId: eventId, modalDefaults: undefined, modalShowMap: false, prefillWorkOrderLinkIds: undefined }),

  openEditModalWithMap: (eventId) =>
    set({ modalOpen: true, modalMode: 'edit', modalEventId: eventId, modalDefaults: undefined, modalShowMap: true, prefillWorkOrderLinkIds: undefined }),

  closeModal: () =>
    set({ modalOpen: false, modalEventId: undefined, modalDefaults: undefined, modalShowMap: false, modalConflict: null, batchItems: [], batchIndex: 0, batchParseProgress: 0, batchParseTotal: 0, batchMinimized: false, batchCancelRequested: false, prefillWorkOrderLinkIds: undefined }),

  clearModalConflict: () => set({ modalConflict: null }),

  markLoadSelfWrite: (loadId) => {
    // Tag every leg of this load. The realtime echo from a document upload
    // (or any other side-channel write that mutates loads.updated_at /
    // loads.rate_con_pdf) fires updateEventFromRemote per leg; without
    // this, the banner pops for the dispatcher who actually did the write.
    for (const e of get().events) {
      if (e.loadId === loadId) markSelfWrite(e.id);
    }
  },

    }),
    {
      name: 'dispatch-ui-settings',
      merge: (persisted, current) => {
        const p = persisted as Partial<typeof current>;
        const validSections = new Set<string>(DEFAULT_SECTION_ORDER);
        if (Array.isArray(p.sectionOrder)) {
          const filtered = (p.sectionOrder as string[]).filter(s => validSections.has(s)) as FieldSection[];
          // Append any sections added since last persist (e.g. 'locations')
          for (const s of DEFAULT_SECTION_ORDER) {
            if (!filtered.includes(s)) filtered.push(s);
          }
          p.sectionOrder = filtered;
        }
        if (p.fieldSettings) {
          p.fieldSettings = Object.fromEntries(
            Object.entries(p.fieldSettings).filter(([k]) => k in current.fieldSettings)
          );
        }
        // notesFormat → specialInstructionsFormat: forward any saved customization
        // so the user's prior wording isn't lost.
        if (p.promptVariables) {
          const pv = { ...(p.promptVariables as unknown as Record<string, string>) };
          if (!pv.specialInstructionsFormat && pv.notesFormat) {
            pv.specialInstructionsFormat = pv.notesFormat;
          }
          delete pv.notesFormat;
          p.promptVariables = { ...current.promptVariables, ...pv } as typeof current.promptVariables;
        }
        // assetCategories migration: if the persisted value is exactly
        // the OLD 4-category default (['OTR','Local','Dedicated','Regional']
        // in any order), replace with the new 2-category default
        // (['Local','OTR']). Anyone who customized their list keeps it.
        // This catches every browser that visited the app before the
        // 2026-06-05 default trim — without it, the new default never
        // takes effect for anyone who already had localStorage written.
        if (Array.isArray(p.assetCategories)) {
          const OLD_DEFAULT = ['OTR', 'Local', 'Dedicated', 'Regional'];
          const persistedSet = new Set(p.assetCategories);
          const matchesOldDefault =
            p.assetCategories.length === OLD_DEFAULT.length &&
            OLD_DEFAULT.every(c => persistedSet.has(c));
          if (matchesOldDefault) {
            p.assetCategories = ['Local', 'OTR'];
          }
        }
        return { ...current, ...p };
      },
      partialize: (state) => ({
        // resourceWidth is computed dynamically from container size — not persisted
        rowHeight:          state.rowHeight,
        viewMode:           state.viewMode,
        // fieldSettings, promptInstructions, promptVariables now live in
        // org_settings server-side (hydrated on app mount), not localStorage.
        sectionOrder:       state.sectionOrder,
        driverPayPct:       state.driverPayPct,
        theme:              state.theme,
        cardFontScale:      state.cardFontScale,
        assetCategories:    state.assetCategories,
        showStatusOverlay:   state.showStatusOverlay,
        showConfirmedOverlay: state.showConfirmedOverlay,
        showPodOverlay:      state.showPodOverlay,
        showBillingOverlay:  state.showBillingOverlay,
        showUnassigned:     state.showUnassigned,
        calendarTimezone:   state.calendarTimezone,
        calendarMode:       state.calendarMode,
        cardFields:         state.cardFields,
        unassignedAssetId:  state.unassignedAssetId,
        lastKnownAssetCount: state.lastKnownAssetCount,
      }),
    }
  )
);
