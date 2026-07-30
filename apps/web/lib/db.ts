'use client';

import { railway, RailwayError } from './railway';
import type { Customer as CustomerType, MergeCustomerResponse, DuplicateCustomerResponse } from '@fleetcal/types';

/** Thrown by createCustomer when the API rejects the insert because a
 *  same-name customer already exists (409 `duplicate_name`) and `force`
 *  was not set. Carries the colliding records so the caller can name
 *  them in a confirm prompt, then retry with force=true. */
export class DuplicateCustomerError extends Error {
  constructor(public existing: CustomerType[]) {
    super('duplicate_name');
    this.name = 'DuplicateCustomerError';
  }
}
import type { DeletedEvent } from '@/store/useCalendarStore';
import type { Asset, Driver, CalendarEvent, SavedLocation, Dispatcher, Customer, Trailer } from './types';

export interface OrgData {
  assets: Asset[];
  drivers: Driver[];
  events: CalendarEvent[];
  deletedEvents: DeletedEvent[];
  driverPrefs: Record<number, number>;
  /** Optional secondary driver per asset — backed by
   *  driver_asset_prefs.secondary_driver_id. */
  driverPrefsSecondary: Record<number, number>;
}

export async function fetchOrgData(
  _orgId: string,
  windowStart?: string,
  windowEnd?: string,
): Promise<OrgData> {
  const params: Record<string, string> = { includeDeleted: 'true' };
  if (windowStart) params.from = windowStart;
  if (windowEnd)   params.to   = windowEnd;

  const [assetsRes, driversRes, loadsRes, prefsRes] = await Promise.all([
    railway.listAssets(),
    railway.listDrivers(),
    railway.listLoads(params),
    railway.listDriverAssetPrefs(),
  ]);

  const { events, deletedEvents } = splitLoadsByDeleted(loadsRes.loads);
  const driverPrefs:          Record<number, number> = {};
  const driverPrefsSecondary: Record<number, number> = {};
  for (const p of prefsRes.prefs) {
    if (p.driverId != null) driverPrefs[p.assetId] = p.driverId;
    if (p.secondaryDriverId != null) driverPrefsSecondary[p.assetId] = p.secondaryDriverId;
  }

  return {
    assets:  assetsRes.assets,
    drivers: driversRes.drivers,
    events,
    deletedEvents,
    driverPrefs,
    driverPrefsSecondary,
  };
}

export async function fetchEventsInRange(
  _orgId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<{ events: CalendarEvent[]; deletedEvents: DeletedEvent[] }> {
  const { loads } = await railway.listLoads({
    from: rangeStart,
    to:   rangeEnd,
    includeDeleted: 'true',
  });
  return splitLoadsByDeleted(loads);
}

/** Split a Load[] from the API into (events, deletedEvents). The API
 *  populates `.deletedAt` on soft-deleted rows when includeDeleted=true. */
function splitLoadsByDeleted(loads: CalendarEvent[]): {
  events: CalendarEvent[];
  deletedEvents: DeletedEvent[];
} {
  const events: CalendarEvent[] = [];
  const deletedEvents: DeletedEvent[] = [];
  for (const l of loads) {
    if (l.deletedAt) deletedEvents.push({ ...l, deletedAt: l.deletedAt });
    else events.push(l);
  }
  return { events, deletedEvents };
}

// ── Trailers ──────────────────────────────────────────────────────────────────

export async function fetchTrailers(_orgId: string): Promise<Trailer[]> {
  try {
    const { trailers } = await railway.listTrailers();
    return trailers;
  } catch (err) { console.error('fetchTrailers:', err); return []; }
}

export async function createTrailer(_orgId: string, t: Omit<Trailer, 'id'>, _sortOrder: number): Promise<Trailer | null> {
  try {
    // Forward every wire-shape field so newly-added Trailer fields
    // don't get silently dropped by this shim. Previously this
    // forwarded only 5 fields (name/number/category/notes/motiveId),
    // which meant the caller-provided activeFrom ('2026-01-01') +
    // the new vehicle details (make/model/vin/plate/state/exp) all
    // hit the API as undefined — the server then fell back to
    // todayUtcDateKey() for activeFrom and NULL for everything else.
    const { trailer } = await railway.createTrailer({
      name:               t.name,
      trailerNumber:      t.trailerNumber      ?? null,
      category:           t.category,
      notes:              t.notes              ?? null,
      motiveVehicleId:    t.motiveVehicleId    ?? null,
      make:               t.make               ?? null,
      model:              t.model              ?? null,
      vin:                t.vin                ?? null,
      licensePlate:       t.licensePlate       ?? null,
      licenseState:       t.licenseState       ?? null,
      licenseExpiration:  t.licenseExpiration  ?? null,
      activeFrom:         t.activeFrom,
      activeTo:           t.activeTo           ?? null,
    });
    return trailer;
  } catch (err) { console.error('createTrailer:', err); return null; }
}

export async function updateTrailer(id: number, updates: Partial<Omit<Trailer, 'id'>>): Promise<void> {
  const body = {
    ...(updates.name !== undefined            ? { name: updates.name } : {}),
    ...(updates.trailerNumber !== undefined   ? { trailerNumber: updates.trailerNumber ?? null } : {}),
    ...(updates.category !== undefined        ? { category: updates.category } : {}),
    ...(updates.notes !== undefined           ? { notes: updates.notes ?? null } : {}),
    ...(updates.motiveVehicleId !== undefined ? { motiveVehicleId: updates.motiveVehicleId ?? null } : {}),
  };
  if (Object.keys(body).length === 0) return;
  try { await railway.updateTrailer(id, body); }
  catch (err) { console.error('updateTrailer:', err); }
}

export async function deleteTrailer(id: number): Promise<void> {
  try { await railway.deleteTrailer(id); }
  catch (err) { console.error('deleteTrailer:', err); }
}

// ── Saved Locations ───────────────────────────────────────────────────────────

export async function fetchSavedLocations(_orgId: string): Promise<SavedLocation[]> {
  try { return (await railway.listSavedLocations()).locations; }
  catch (err) { console.error('fetchSavedLocations:', err); return []; }
}

export async function createSavedLocation(_orgId: string, loc: Omit<SavedLocation, 'id'>): Promise<SavedLocation | null> {
  try {
    const { location } = await railway.createSavedLocation({
      name:     loc.name,
      address:  loc.address  ?? null,
      lat:      loc.lat      ?? null,
      lng:      loc.lng      ?? null,
      timezone: loc.timezone ?? null,
    });
    return location;
  } catch (err) { console.error('createSavedLocation:', err); return null; }
}

export async function updateSavedLocation(id: string, updates: Partial<Omit<SavedLocation, 'id'>>): Promise<void> {
  const body = {
    ...(updates.name     !== undefined ? { name: updates.name } : {}),
    ...(updates.address  !== undefined ? { address: updates.address ?? null } : {}),
    ...(updates.lat      !== undefined ? { lat: updates.lat ?? null } : {}),
    ...(updates.lng      !== undefined ? { lng: updates.lng ?? null } : {}),
    ...(updates.timezone !== undefined ? { timezone: updates.timezone ?? null } : {}),
  };
  if (Object.keys(body).length === 0) return;
  try { await railway.updateSavedLocation(id, body); }
  catch (err) { console.error('updateSavedLocation:', err); }
}

export async function deleteSavedLocation(id: string): Promise<void> {
  try { await railway.deleteSavedLocation(id); }
  catch (err) { console.error('deleteSavedLocation:', err); }
}

// ── Customers ─────────────────────────────────────────────────────────────────

export async function fetchBrokerLoads(_orgId: string, names: string[]): Promise<CalendarEvent[]> {
  if (names.length === 0) return [];
  try {
    // Strip commas from names — comma is the param-list delimiter on the server side.
    const safe = names.map(n => n.replace(/,/g, '')).filter(Boolean);
    const { loads } = await railway.listLoads({ brokers: safe.join(',') });
    return [...loads].sort((a, b) => b.start.localeCompare(a.start));
  } catch (err) {
    console.error('fetchBrokerLoads:', err);
    return [];
  }
}

export async function fetchCustomers(_orgId: string): Promise<Customer[]> {
  try {
    // Alternate broker names ("aliases") are disabled. They were auto-populated
    // by customer merges and then matched against load broker names, linking
    // loads to the wrong customer and rendering stray name badges. Strip them
    // here — the single point where customers enter the web app — so every
    // alias badge, "aka" label, and alias-based match reads an empty list.
    // (Backend still stores the column; see the merge endpoint + data cleanup.)
    const { customers } = await railway.listCustomers();
    return customers.map(c => ({ ...c, aliases: [] }));
  } catch (err) { console.error('fetchCustomers:', err); return []; }
}

export async function createCustomer(_orgId: string, c: Omit<Customer, 'id'>, force = false): Promise<Customer | null> {
  try {
    const { customer } = await railway.createCustomer({
      name:                c.name,
      aliases:             c.aliases ?? [],
      shortName:           c.shortName           ?? null,
      mcNum:               c.mcNum               ?? null,
      contactName:         c.contactName         ?? null,
      contactEmail:        c.contactEmail        ?? null,
      contactPhone:        c.contactPhone        ?? null,
      contacts:            c.contacts            ?? [],
      notes:               c.notes               ?? null,
      parseHints:          c.parseHints          ?? null,
      invoiceMethod:       c.invoiceMethod       ?? null,
      invoiceEmail:        c.invoiceEmail        ?? null,
      invoicePortal:       c.invoicePortal       ?? null,
      invoiceInstructions: c.invoiceInstructions ?? null,
      billingAddress:      c.billingAddress      ?? null,
      ...(force ? { force: true } : {}),
    });
    return customer;
  } catch (err) {
    // 409 duplicate_name → surface as a typed error so the caller can
    // prompt "create a separate one anyway?" and retry with force=true.
    // Every other failure keeps the historical swallow-and-return-null
    // behavior so existing call sites don't suddenly start throwing.
    if (err instanceof RailwayError && err.status === 409) {
      const detail = err.detail as DuplicateCustomerResponse | null;
      if (detail?.error === 'duplicate_name') {
        throw new DuplicateCustomerError(detail.existing ?? []);
      }
    }
    console.error('createCustomer:', err);
    return null;
  }
}

/** Merge `sourceId` into `targetId`: every load + invoice is reassigned
 *  to the target and the source customer is deleted. Throws on failure
 *  so the UI can surface it (unlike delete, a half-finished merge is
 *  worth flagging). */
export async function mergeCustomer(sourceId: string, targetId: string): Promise<MergeCustomerResponse> {
  return railway.mergeCustomer(sourceId, targetId);
}

export async function updateCustomer(id: string, updates: Partial<Omit<Customer, 'id'>>): Promise<void> {
  // Whitelist of fields to forward. Every field that BrokerProfileModal
  // (and other call sites) writes must be listed here — anything left
  // out gets silently dropped before reaching the API, which has been
  // the cause of "I saved this and it disappeared on refresh" bugs:
  // local optimistic state shows the new value, the DB still holds the
  // old one, and the next fetchCustomers wipes the change.
  const body = {
    ...(updates.name !== undefined         ? { name: updates.name } : {}),
    ...(updates.aliases !== undefined      ? { aliases: updates.aliases } : {}),
    ...(updates.shortName !== undefined    ? { shortName: updates.shortName ?? null } : {}),
    ...(updates.mcNum !== undefined        ? { mcNum: updates.mcNum ?? null } : {}),
    ...(updates.contactName !== undefined  ? { contactName: updates.contactName ?? null } : {}),
    ...(updates.contactEmail !== undefined ? { contactEmail: updates.contactEmail ?? null } : {}),
    ...(updates.contactPhone !== undefined ? { contactPhone: updates.contactPhone ?? null } : {}),
    ...(updates.contacts !== undefined            ? { contacts: updates.contacts ?? [] } : {}),
    ...(updates.notes !== undefined               ? { notes: updates.notes ?? null } : {}),
    ...(updates.parseHints !== undefined          ? { parseHints: updates.parseHints ?? null } : {}),
    ...(updates.invoiceMethod !== undefined       ? { invoiceMethod: updates.invoiceMethod ?? null } : {}),
    ...(updates.invoiceEmail !== undefined        ? { invoiceEmail: updates.invoiceEmail ?? null } : {}),
    ...(updates.invoicePortal !== undefined       ? { invoicePortal: updates.invoicePortal ?? null } : {}),
    ...(updates.invoiceInstructions !== undefined ? { invoiceInstructions: updates.invoiceInstructions ?? null } : {}),
    ...(updates.billingAddress      !== undefined ? { billingAddress:      updates.billingAddress      ?? null } : {}),
  };
  if (Object.keys(body).length === 0) return;
  try { await railway.updateCustomer(id, body); }
  catch (err) { console.error('updateCustomer:', err); }
}

export async function deleteCustomer(id: string): Promise<void> {
  try { await railway.deleteCustomer(id); }
  catch (err) { console.error('deleteCustomer:', err); }
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

export interface DispatcherCreateInput {
  firstName:    string;
  lastName:     string;
  hireDate?:    string;
  clerkUserId?: string;
  isDefault?:   boolean;
}

export interface DispatcherUpdateInput {
  firstName?:   string;
  lastName?:    string;
  hireDate?:    string | null;
  clerkUserId?: string | null;
  isDefault?:   boolean;
  active?:      boolean;
}

export async function fetchDispatchers(_orgId: string): Promise<Dispatcher[]> {
  try { return (await railway.listDispatchers()).dispatchers; }
  catch (err) { console.error('fetchDispatchers:', err); return []; }
}

export async function createDispatcher(_orgId: string, input: DispatcherCreateInput): Promise<Dispatcher | null> {
  try { return (await railway.createDispatcher(input)).dispatcher; }
  catch (err) { console.error('createDispatcher:', err); return null; }
}

export async function updateDispatcher(id: number, _orgId: string, updates: DispatcherUpdateInput): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  try { await railway.updateDispatcher(id, updates); }
  catch (err) { console.error('updateDispatcher:', err); }
}

export async function deleteDispatcher(id: number): Promise<void> {
  try { await railway.deleteDispatcher(id); }
  catch (err) { console.error('deleteDispatcher:', err); }
}

export async function searchEvents(_orgId: string, query: string): Promise<CalendarEvent[]> {
  if (!query || query.length < 2) return [];
  try {
    // Request the API's full ceiling (50). The calendar dropdown
    // displays 25 with a "See all N" footer to /search when more
    // exist, so we need enough headroom to surface the true count
    // and let the user scroll through ~25 without re-querying.
    const { loads } = await railway.searchLoads(query.trim(), 50);
    return loads as CalendarEvent[];
  } catch (err) {
    console.error('searchEvents:', err);
    return [];
  }
}

// ── Payroll adjustments ───────────────────────────────────────────────────────

export type PayrollAdjustment = import('@fleetcal/types').PayrollAdjustment;

export async function fetchPayrollAdjustments(_orgId: string, weekStart: string): Promise<PayrollAdjustment[]> {
  try { return (await railway.listPayrollAdjustments({ weekStart })).adjustments; }
  catch (err) { console.error('fetchPayrollAdjustments:', err); return []; }
}

export async function addPayrollAdjustment(
  adj: { orgId?: string; driverName: string; weekStart: string; category: string; description?: string; amount: number; inspectionReportId?: string },
): Promise<PayrollAdjustment | null> {
  try {
    const { adjustment } = await railway.createPayrollAdjustment({
      driverName:  adj.driverName,
      weekStart:   adj.weekStart,
      category:    adj.category,
      description: adj.description ?? null,
      amount:      adj.amount,
      inspectionReportId: adj.inspectionReportId ?? null,
    });
    return adjustment;
  } catch (err) { console.error('addPayrollAdjustment:', err); return null; }
}

/** Resolves true when the adjustment's week has a live payroll record.
 *  The delete happens either way — the API accepts writes into finalized
 *  weeks by design and reports the divergence rather than blocking it. */
export async function deletePayrollAdjustment(id: string): Promise<boolean> {
  try {
    const res = await railway.deletePayrollAdjustment(id);
    return !!res?.weekFinalized;
  }
  catch (err) { console.error('deletePayrollAdjustment:', err); return false; }
}

// ── Payroll records (finalized payments) ─────────────────────────────────────

export type PayrollRecord = import('@fleetcal/types').PayrollRecord;

export async function fetchPayrollRecord(
  _orgId: string, driverName: string, weekStart: string,
): Promise<PayrollRecord | null> {
  try {
    const { records } = await railway.listPayrollRecords({ driverName, weekStart });
    return records[0] ?? null;
  } catch (err) { console.error('fetchPayrollRecord:', err); return null; }
}

export type PayrollLineItem = import('@fleetcal/types').PayrollLineItem;

/** Finalize a driver-week — writes the frozen line detail alongside the
 *  total so the week can be re-rendered and reprinted exactly as issued.
 *
 *  `lineItems` must sum to `totalPay`; the API rejects a snapshot that
 *  doesn't foot. Re-finalizing an already-finalized week supersedes the
 *  previous record instead of overwriting it. */
export async function finalizeDriverPay(
  _orgId: string, driverName: string, weekStart: string, totalPay: number,
  lineItems?: PayrollLineItem[], finalizedByName?: string | null,
): Promise<PayrollRecord | null> {
  try {
    const { record } = await railway.upsertPayrollRecord({
      driverName, weekStart, totalPay,
      lineItems: lineItems ?? null,
      finalizedByName: finalizedByName ?? null,
    });
    return record;
  } catch (err) { console.error('finalizeDriverPay:', err); return null; }
}

/** Reopen — the record is superseded server-side, not deleted. Returns
 *  the retired record (carrying who reopened it and when) or null. */
export async function unfinalizeDriverPay(
  id: string, reopenedByName?: string | null,
): Promise<PayrollRecord | null> {
  try {
    const { record } = await railway.deletePayrollRecord(id, reopenedByName ?? null);
    return record;
  }
  catch (err) { console.error('unfinalizeDriverPay:', err); return null; }
}

/** Every live finalized record for one week, across drivers.
 *
 *  The payroll page needs this to keep a finalized driver on screen even
 *  when the week no longer computes any loads for them — e.g. the load
 *  was edited across the Saturday boundary after the week was paid. The
 *  stub still exists, so the card still shows. */
export async function fetchPayrollRecordsForWeek(weekStart: string): Promise<PayrollRecord[]> {
  try { return (await railway.listPayrollRecords({ weekStart })).records; }
  catch (err) { console.error('fetchPayrollRecordsForWeek:', err); return []; }
}

export async function fetchPayrollRecordsForDriver(_orgId: string, driverName: string): Promise<PayrollRecord[]> {
  try { return (await railway.listPayrollRecords({ driverName })).records; }
  catch (err) { console.error('fetchPayrollRecordsForDriver:', err); return []; }
}

// ── Driver-uploaded documents ─────────────────────────────────────────────────

export type LoadDocument = import('@fleetcal/types').DocumentSummary;

export async function fetchLoadDocuments(loadId: string, _orgId: string): Promise<LoadDocument[]> {
  if (!loadId) return [];
  try {
    const { documents } = await railway.listLoadDocuments(loadId);
    return documents;
  } catch (err) {
    console.error('fetchLoadDocuments:', err);
    return [];
  }
}

export async function getLoadDocumentSignedUrl(documentId: string): Promise<string | null> {
  try {
    const { url } = await railway.getDocumentUrl(documentId);
    return url;
  } catch (err) {
    console.error('getLoadDocumentSignedUrl:', err);
    return null;
  }
}

export async function fetchEventAuditLog(eventId: string, _orgId: string): Promise<import('./types').LoadAuditEntry[] | null> {
  try {
    const { entries } = await railway.getEventAuditLog(eventId);
    return entries as import('./types').LoadAuditEntry[];
  } catch (err) {
    // 404 happens when the modal opens an event whose id hasn't been swapped
    // from optimistic temp → server uuid yet. No audit log to fetch; silent.
    const status = (err as { status?: number } | null)?.status;
    if (status !== 404) console.error('fetchEventAuditLog:', err);
    return null;
  }
}

