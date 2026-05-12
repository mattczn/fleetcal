'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
import { localDateStr } from '@/lib/time-utils';

export interface DragState {
  eventId: string;
  targetAssetId: number;
  dateStr: string;
  grabOffsetPx: number;
  durationMs: number;
  newStart: string;
  newEnd: string;
  hasMoved: boolean;
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
function withResolvedDriverId<T extends { driverName?: string; driverId?: number }>(
  ev: T,
  drivers: Driver[],
): T {
  if (!ev.driverName) return { ...ev, driverId: undefined };
  const match = drivers.find(d => d.name === ev.driverName);
  return { ...ev, driverId: match?.id };
}

// Fire a push notification to a driver via the dispatch API. Best-effort —
// failures are logged but don't block the event write.
function notifyDriver(driverId: number, title: string, body: string, data?: Record<string, unknown>) {
  fetch('/api/driver-push', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ driverId, title, body, data }),
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
  driverPrefs: Record<number, number>;
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

  addAsset: (asset: Omit<Asset, 'id'>) => void;
  updateAsset: (id: number, updates: Partial<Omit<Asset, 'id'>>) => void;
  removeAsset: (id: number) => void;
  reorderAssets: (fromId: number, toId: number) => void;

  addDriver: (name: string) => void;
  updateDriver: (id: number, updates: Partial<Omit<Driver, 'id'>>) => void;
  removeDriver: (id: number) => void;
  setDriverPref: (assetId: number, driverId: number | null) => void;

  addEvent: (event: Omit<CalendarEvent, 'id'>, presetId?: string) => void;
  updateEvent: (id: string, updates: Partial<Omit<CalendarEvent, 'id'>>) => void;
  removeEvent: (id: string, auditEntry?: import('@/lib/types').LoadAuditEntry) => void;
  // Remote-only (realtime): apply without writing back to DB
  addEventFromRemote: (event: CalendarEvent) => void;
  updateEventFromRemote: (event: CalendarEvent) => void;
  removeEventFromRemote: (id: string) => void;
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

  theme: 'light' | 'dark' | 'system';
  setTheme: (t: 'light' | 'dark' | 'system') => void;

  isDemo: boolean;
  hydrateDemoMode: () => void;
  exitDemoMode: () => void;

  showStatusOverlay: boolean;
  setShowStatusOverlay: (v: boolean) => void;

  calendarTimezone: string;
  setCalendarTimezone: (tz: string) => void;

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

  trailers: Trailer[];
  fetchTrailers: () => Promise<void>;
  addTrailer: (t: Omit<Trailer, 'id'>) => Promise<void>;
  updateTrailer: (id: number, updates: Partial<Omit<Trailer, 'id'>>) => Promise<void>;
  removeTrailer: (id: number) => Promise<void>;

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
  setEldLocations: (locs: EldLocation[]) => void;

  openCreateModal: (defaults?: Partial<CalendarEvent>) => void;
  openEditModal: (eventId: string) => void;
  openEditModalWithMap: (eventId: string) => void;
  closeModal: () => void;
  clearModalConflict: () => void;
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

  hydrate: ({ orgId, assets, events, deletedEvents, drivers, driverPrefs, loadedStart, loadedEnd }) => {
    const unassigned = assets.find(a => a.type === 'Unassigned' || a.name === 'Unassigned');
    const persistedShowUnassigned = get().showUnassigned;
    const visibleCount = assets.filter(a => !a.hidden).length;
    set({
      orgId, assets, events, deletedEvents, drivers, driverPrefs,
      dbReady: true, currentDate: new Date(), loadedStart, loadedEnd,
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
        const existingIds    = new Set(state.events.map(e => e.id));
        const existingDelIds = new Set(state.deletedEvents.map(e => e.id));
        const newStart = !state.loadedStart || start < state.loadedStart ? start : state.loadedStart;
        const newEnd   = !state.loadedEnd   || end   > state.loadedEnd   ? end   : state.loadedEnd;
        return {
          events:        [...state.events,        ...events.filter(e => !existingIds.has(e.id))],
          deletedEvents: [...state.deletedEvents, ...deletedEvents.filter(e => !existingDelIds.has(e.id))],
          loadedStart: newStart,
          loadedEnd:   newEnd,
        };
      });
    } catch (err) {
      console.error('[store] extendLoadedRange:', err);
    }
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  assetCategories: ['OTR', 'Local', 'Dedicated', 'Regional'],
  assets:        [],
  events:        [],
  deletedEvents: [],
  drivers:       [],
  driverPrefs:   {},
  currentDate:   new Date(),
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
  setDriverPayPct: (pct) => set({ driverPayPct: pct }),

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
      hasHydratedOrgSettings: true,
    })),

  theme: 'light',
  setTheme: (t) => {
    set({ theme: t });
    if (typeof document !== 'undefined') {
      const resolved = t === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : t;
      document.documentElement.setAttribute('data-theme', resolved);
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
      isDemo:            true,
      assets:            demoAssets,
      events:            demoEvents,
      drivers:           demoDrivers,
      driverPrefs:       demoPrefs,
      showUnassigned:    true,
      unassignedAssetId: UNASSIGNED_ID,
      currentDate:       new Date(),
    });
  },
  exitDemoMode: () => set({
    isDemo:            false,
    assets:            [],
    events:            [],
    deletedEvents:     [],
    drivers:           [],
    driverPrefs:       {},
    loadedStart:       null,
    loadedEnd:         null,
    unassignedAssetId: null,
  }),

  showStatusOverlay: true,
  setShowStatusOverlay: (v) => set({ showStatusOverlay: v }),

  calendarTimezone: 'America/Denver',
  setCalendarTimezone: (tz) => set({ calendarTimezone: tz }),

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
    await deleteSavedLocation(id);
    set((s) => ({ savedLocations: s.savedLocations.filter((l) => l.id !== id) }));
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
    await deleteDispatcher(id);
    set((s) => ({ dispatchers: s.dispatchers.filter(d => d.id !== id) }));
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
    await deleteCustomer(id);
    set((s) => ({ customers: s.customers.filter(c => c.id !== id) }));
  },
  addCustomerAlias: async (id, alias) => {
    const customer = get().customers.find(c => c.id === id);
    if (!customer || customer.aliases.includes(alias)) return;
    const newAliases = [...customer.aliases, alias];
    await updateCustomer(id, { aliases: newAliases });
    set((s) => ({ customers: s.customers.map(c => c.id === id ? { ...c, aliases: newAliases } : c) }));
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
  },
  updateTrailer: async (id, updates) => {
    await updateTrailer(id, updates);
    set((s) => ({ trailers: s.trailers.map(t => t.id === id ? { ...t, ...updates } : t) }));
  },
  removeTrailer: async (id) => {
    await deleteTrailer(id);
    set((s) => ({ trailers: s.trailers.filter(t => t.id !== id) }));
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
  addAsset: (asset) => {
    if (get().isDemo) return;
    const tempId = -Date.now();
    set((state) => ({ assets: [...state.assets, { ...asset, id: tempId }] }));
    const { orgId } = get();
    if (!orgId) return;
    railway.createAsset({
      name:            asset.name,
      color:           asset.color,
      type:            asset.type,
      unit:            asset.unit             ?? null,
      truck:           asset.truck            ?? null,
      notes:           asset.notes            ?? null,
      hidden:          asset.hidden           ?? false,
      motiveVehicleId: asset.motiveVehicleId  ?? null,
      sortOrder:       get().assets.length - 1,
    }).then(({ asset: created }) => {
      set((state) => ({
        assets: state.assets.map((a) => a.id === tempId ? { ...created } : a),
      }));
    }).catch((err) => console.error('addAsset:', err));
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
    };
    if (Object.keys(body).length === 0) return;
    railway.updateAsset(id, body).catch((err) => console.error('updateAsset:', err));
  },

  removeAsset: (id) => {
    if (get().isDemo) return;
    set((state) => ({
      assets:        state.assets.filter((a) => a.id !== id),
      events:        state.events.filter((e) => e.assetId !== id),
      deletedEvents: state.deletedEvents.filter((e) => e.assetId !== id),
    }));
    railway.deleteAsset(id).catch((err) => console.error('removeAsset:', err));
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
  addDriver: (name) => {
    if (get().isDemo) return;
    const tempId = -Date.now();
    set((state) => ({ drivers: [...state.drivers, { id: tempId, name }] }));
    railway.createDriver({ name })
      .then(({ driver }) => {
        set((state) => ({
          drivers: state.drivers.map((d) => d.id === tempId ? { ...driver } : d),
        }));
      })
      .catch((err) => console.error('addDriver:', err));
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
    };
    if (Object.keys(body).length === 0) return;
    railway.updateDriver(id, body).catch((err) => console.error('updateDriver:', err));
  },

  removeDriver: (id) => {
    if (get().isDemo) return;
    const prefs = { ...get().driverPrefs };
    Object.keys(prefs).forEach((k) => { if (prefs[+k] === id) delete prefs[+k]; });
    set((state) => ({ drivers: state.drivers.filter((d) => d.id !== id), driverPrefs: prefs }));
    railway.deleteDriver(id).catch((err) => console.error('removeDriver:', err));
  },

  setDriverPref: (assetId, driverId) => {
    set((state) => {
      const prefs = { ...state.driverPrefs };
      if (driverId === null) delete prefs[assetId];
      else prefs[assetId] = driverId;
      return { driverPrefs: prefs };
    });
    if (driverId === null) {
      railway.deleteDriverAssetPref(assetId)
        .catch((err) => console.error('setDriverPref delete:', err));
    } else {
      railway.setDriverAssetPref(assetId, { driverId })
        .catch((err) => console.error('setDriverPref upsert:', err));
    }
  },

  // ── Events ────────────────────────────────────────────────────────────────
  addEvent: (event, presetId?) => {
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
        // Notify driver if assigned
        if (resolved.driverId) {
          notifyDriver(
            resolved.driverId,
            'New load assigned',
            event.loadNum ? `Load #${event.loadNum} — ${event.title}` : event.title,
            { loadId: created.id },
          );
        }
      })
      .catch((err) => console.error('addEvent (revenue):', err));
  },

  updateEvent: (id, updates) => {
    const prevDriverId = get().events.find((e) => e.id === id)?.driverId;
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
    const resolvedUpdates: typeof updates = { ...updates };
    if ('driverId' in updates || 'driverName' in updates) {
      resolvedUpdates.driverId = resolved.driverId ?? undefined;
      resolvedUpdates.driverName = resolved.driverName ?? undefined;
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
    Promise.all(promises)
      .then(() => {
        if (resolved.driverId && resolved.driverId !== prevDriverId) {
          notifyDriver(
            resolved.driverId,
            'Load assigned to you',
            ev.loadNum ? `Load #${ev.loadNum} — ${ev.title}` : ev.title,
            { loadId: ev.loadId },
          );
        }
      })
      .catch((err) => console.error('updateEvent:', err));
  },

  removeEvent: (id, auditEntry) => {
    if (get().isDemo) return;
    const ev = get().events.find((e) => e.id === id);
    if (!ev) return;
    const deletedAt = new Date().toISOString();
    const newAuditLog = auditEntry ? [...(ev.auditLog ?? []), auditEntry] : ev.auditLog;
    const updated = { ...ev, auditLog: newAuditLog };
    set((state) => ({
      events: state.events.filter((e) => e.id !== id),
      deletedEvents: [{ ...updated, deletedAt }, ...state.deletedEvents],
    }));
    const { orgId } = get();
    if (!orgId) return;

    if (ev.eventKind === 'non_revenue') {
      railway.deleteEvent(id).catch((err) => console.error('removeEvent (non-revenue):', err));
      return;
    }

    if (!ev.loadId) {
      console.error('removeEvent: revenue event missing loadId; ignoring delete', id);
      return;
    }

    // Revenue + has loadId: DELETE /v1/loads/:loadId cascades to events.
    railway.deleteLoad(ev.loadId).catch((err) => console.error('removeEvent:', err));
  },

  addEventFromRemote: (event) => {
    set((state) => {
      if (state.events.some(e => e.id === event.id)) return state;
      return { events: [...state.events, event] };
    });
  },

  updateEventFromRemote: (event) => {
    set((state) => ({
      events: state.events.map(e => e.id === event.id
        // Realtime payload never includes stops (not a column) — preserve existing stops
        ? { ...e, ...event, stops: e.stops }
        : e),
      // Flag conflict if this event is currently open in the modal
      modalConflict: state.modalOpen && state.modalEventId === event.id ? 'updated' : state.modalConflict,
    }));
  },

  removeEventFromRemote: (id) => {
    set((state) => ({
      events: state.events.filter(e => e.id !== id),
      // Flag conflict if this event is currently open in the modal
      modalConflict: state.modalOpen && state.modalEventId === id ? 'deleted' : state.modalConflict,
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
        const existingIds = new Set(state.events.map((e) => e.id));
        const existingDelIds = new Set(state.deletedEvents.map((e) => e.id));
        const newStart = rs < (state.loadedStart ?? rs) ? rs : (state.loadedStart ?? rs);
        const newEnd   = re > (state.loadedEnd   ?? re) ? re : (state.loadedEnd   ?? re);
        return {
          events:        [...state.events,        ...events.filter((e) => !existingIds.has(e.id))],
          deletedEvents: [...state.deletedEvents, ...deletedEvents.filter((e) => !existingDelIds.has(e.id))],
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

  // ── Modal ─────────────────────────────────────────────────────────────────
  modalOpen:      false,
  modalMode:      'create',
  modalEventId:   undefined,
  modalDefaults:  undefined,
  modalShowMap:   false,
  modalConflict:  null,

  eldLocations: [],
  setEldLocations: (locs) => set({ eldLocations: locs }),

  openCreateModal: (defaults) =>
    set({ modalOpen: true, modalMode: 'create', modalEventId: undefined, modalDefaults: defaults, modalShowMap: false }),

  openEditModal: (eventId) =>
    set({ modalOpen: true, modalMode: 'edit', modalEventId: eventId, modalDefaults: undefined, modalShowMap: false }),

  openEditModalWithMap: (eventId) =>
    set({ modalOpen: true, modalMode: 'edit', modalEventId: eventId, modalDefaults: undefined, modalShowMap: true }),

  closeModal: () =>
    set({ modalOpen: false, modalEventId: undefined, modalDefaults: undefined, modalShowMap: false, modalConflict: null, batchItems: [], batchIndex: 0, batchParseProgress: 0, batchParseTotal: 0, batchMinimized: false, batchCancelRequested: false }),

  clearModalConflict: () => set({ modalConflict: null }),

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
        assetCategories:    state.assetCategories,
        showStatusOverlay:  state.showStatusOverlay,
        showUnassigned:     state.showUnassigned,
        calendarTimezone:   state.calendarTimezone,
        cardFields:         state.cardFields,
        unassignedAssetId:  state.unassignedAssetId,
        lastKnownAssetCount: state.lastKnownAssetCount,
      }),
    }
  )
);
