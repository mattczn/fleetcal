/**
 * Planned events (module: planning) — dispatcher placeholders on a
 * truck's calendar column for work that isn't booked yet.
 *
 * Kept OUT of useCalendarStore on purpose. `events` there is read by
 * payroll, the dashboard, closeout, the driver-notify paths and more,
 * all of which treat anything in it as real work. Plans live in their
 * own table server-side for the same reason; this store is the client
 * half of that separation. The calendar column reads both and draws
 * plans with their own card.
 */
import { create } from 'zustand';
import type { PlannedEvent, CreatePlannedEventRequest, UpdatePlannedEventRequest } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { errorToast } from '@/lib/errorToast';

interface PlannedState {
  items: PlannedEvent[];
  loaded: boolean;
  /** Plan waiting for the next load created through the load modal —
   *  set by "Create load from plan", consumed by useCalendarStore's
   *  addEvent the moment the save starts, so a cancelled load modal
   *  never attaches to some later, unrelated load. */
  pendingAttachId: string | null;

  load: () => Promise<void>;
  create: (body: CreatePlannedEventRequest) => Promise<boolean>;
  update: (id: string, body: UpdatePlannedEventRequest) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Close the plan against a load (the load's uuid, not the event id). */
  attach: (id: string, loadId: string) => Promise<boolean>;

  setPendingAttach: (id: string | null) => void;
  /** Returns and clears the pending plan id. */
  takePendingAttach: () => string | null;
}

const byStart = (a: PlannedEvent, b: PlannedEvent) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id);

export const usePlannedStore = create<PlannedState>((set, get) => ({
  items: [],
  loaded: false,
  pendingAttachId: null,

  load: async () => {
    try {
      const { plannedEvents } = await railway.listPlannedEvents();
      set({ items: plannedEvents.sort(byStart), loaded: true });
    } catch (err) {
      // A 403 here just means the module is off or the role can't see
      // plans — the calendar should render without them, not complain.
      console.error('[plannedStore] load:', err);
      set({ items: [], loaded: true });
    }
  },

  create: async (body) => {
    try {
      const { plannedEvent } = await railway.createPlannedEvent(body);
      set((s) => ({ items: [...s.items, plannedEvent].sort(byStart) }));
      return true;
    } catch (err) {
      errorToast(err, 'Plan did not save');
      return false;
    }
  },

  update: async (id, body) => {
    try {
      const { plannedEvent } = await railway.updatePlannedEvent(id, body);
      set((s) => ({ items: s.items.map((p) => (p.id === id ? plannedEvent : p)).sort(byStart) }));
      return true;
    } catch (err) {
      errorToast(err, 'Plan did not save');
      return false;
    }
  },

  remove: async (id) => {
    const prev = get().items;
    set({ items: prev.filter((p) => p.id !== id) });
    try {
      await railway.deletePlannedEvent(id);
      return true;
    } catch (err) {
      set({ items: prev });
      errorToast(err, 'Plan was not deleted');
      return false;
    }
  },

  attach: async (id, loadId) => {
    try {
      await railway.attachPlannedEvent(id, loadId);
      // Attached plans are closed — they leave the calendar.
      set((s) => ({ items: s.items.filter((p) => p.id !== id) }));
      return true;
    } catch (err) {
      errorToast(err, 'Could not attach the load to this plan');
      return false;
    }
  },

  setPendingAttach: (id) => set({ pendingAttachId: id }),
  takePendingAttach: () => {
    const id = get().pendingAttachId;
    if (id) set({ pendingAttachId: null });
    return id;
  },
}));
