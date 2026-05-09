/**
 * Splits the web's CalendarEvent shape into the load-level fields and
 * event-level fields the Railway API expects.
 *
 * Background: pre-2.5a, all load-level info (broker, load_num, accessorials,
 * etc.) lived on the event row. Web's CalendarEvent reflects that flat
 * shape. After the schema split, those fields belong on `loads`, while
 * per-leg/per-event fields stay on `events`. This helper decides where
 * each field goes for write-time API calls.
 */

import type { CalendarEvent } from '@/lib/types';
import type {
  CreateLoadRequestLoad,
  CreateLoadRequestEvent,
  UpdateLoadRequest,
  UpdateEventRequest,
  UpdateEventByIdRequest,
} from '@fleetcal/types';

// ── Field classification ────────────────────────────────────────────────

const LOAD_LEVEL_KEYS = [
  'loadNum',
  'broker',
  'customerId',
  'dispatcher',
  'loadPrice',
  'commodity',
  'weight',
  'rateConPdf',
  'accessorials',
  'refNums',
  'notes',          // load-level for revenue events
  'internalNotes',
  'createdByName',
  'auditLog',       // full-array replacement; caller appends locally before sending
] as const;

const EVENT_LEVEL_KEYS = [
  'title',
  'start',
  'end',
  'status',
  'assetId',
  'driverId',
  'driverName',
  'trailerId',
  'trailerType',
  'driverPay',
  'loadedMiles',
  'priority',
  'relayRole',
] as const;

// ── Create ──────────────────────────────────────────────────────────────

/**
 * Build a `POST /v1/loads` request body for a single revenue event.
 * (For relay loads, the caller calls this for each leg and merges; or
 * builds the body directly with both events.)
 */
export function buildCreateLoadBody(event: Omit<CalendarEvent, 'id'>): {
  load: CreateLoadRequestLoad;
  event: CreateLoadRequestEvent;
} {
  // specialInstructions historically lived on the event row; merge it into
  // load.notes if `notes` itself isn't already set.
  const mergedNotes =
    event.notes !== undefined
      ? event.notes
      : event.specialInstructions ?? undefined;

  const load: CreateLoadRequestLoad = stripUndefined({
    loadNum:       event.loadNum,
    broker:        event.broker,
    customerId:    event.customerId,
    dispatcher:    event.dispatcher,
    loadPrice:     event.loadPrice,
    commodity:     event.commodity,
    weight:        event.weight,
    rateConPdf:    event.rateConPdf,
    accessorials:  event.accessorials,
    refNums:       event.refNums,
    notes:         mergedNotes,
    internalNotes: event.internalNotes && event.internalNotes.length > 0 ? event.internalNotes : undefined,
    createdByName: event.createdByName,
  });

  const ev: CreateLoadRequestEvent = stripUndefined({
    title:        event.title,
    start:        event.start,
    end:          event.end,
    assetId:      event.assetId,
    driverId:     event.driverId,
    driverName:   event.driverName,
    status:       event.status,
    relayRole:    event.relayRole,
    trailerId:    event.trailerId,
    trailerType:  event.trailerType,
    driverPay:    event.driverPay,
    priority:     event.priority,
    stops:        event.stops,
  }) as CreateLoadRequestEvent;

  // Required fields must be present
  ev.title = event.title;
  ev.start = event.start;
  ev.end = event.end;
  ev.assetId = event.assetId;

  return { load, event: ev };
}

// ── Update ──────────────────────────────────────────────────────────────

/**
 * Split a Partial<CalendarEvent> into load-level updates and event-level
 * updates. Only keys actually present in the input are propagated; absent
 * keys mean "don't change."
 *
 * Note on `specialInstructions`: web modal historically had this as a
 * separate field. Post-split, it merges into loads.notes. If both are
 * present in the update, `notes` wins; if only specialInstructions, it
 * becomes `notes` for the load update.
 */
export function splitForUpdate(updates: Partial<CalendarEvent>): {
  loadUpdates: UpdateLoadRequest;
  eventUpdates: UpdateEventRequest;
} {
  const loadUpdates: UpdateLoadRequest = {};
  const eventUpdates: UpdateEventRequest = {};

  for (const key of LOAD_LEVEL_KEYS) {
    if (key in updates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (loadUpdates as any)[key] = (updates as any)[key];
    }
  }
  for (const key of EVENT_LEVEL_KEYS) {
    if (key in updates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventUpdates as any)[key] = (updates as any)[key];
    }
  }

  // specialInstructions: merge into loadUpdates.notes if notes not also set
  if ('specialInstructions' in updates && !('notes' in updates)) {
    loadUpdates.notes = updates.specialInstructions ?? null;
  }

  return { loadUpdates, eventUpdates };
}

/**
 * Same as splitForUpdate but the event side targets the load-id-agnostic
 * `PATCH /v1/events/:id` endpoint. Used for non-revenue events (which
 * have no loadId so the load side is dropped) and as an alt path for
 * revenue events when the caller doesn't have loadId handy.
 *
 * For non-revenue events, web's `notes` field is event-level (no load
 * exists). It maps to `eventNotes`.
 */
export function buildEventByIdUpdate(
  updates: Partial<CalendarEvent>,
  isNonRevenue: boolean,
): UpdateEventByIdRequest {
  const eventUpdates: UpdateEventByIdRequest = {};
  for (const key of EVENT_LEVEL_KEYS) {
    if (key in updates) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (eventUpdates as any)[key] = (updates as any)[key];
    }
  }
  if (isNonRevenue) {
    // For non-revenue, web.notes is event-level
    if ('notes' in updates) eventUpdates.eventNotes = updates.notes ?? null;
    if ('nonRevenueType' in updates) eventUpdates.nonRevenueType = updates.nonRevenueType ?? null;
  }
  return eventUpdates;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out as T;
}
