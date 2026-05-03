'use client';

import { railway } from './railway';
import type { DeletedEvent } from '@/store/useCalendarStore';
import type { Asset, Driver, CalendarEvent, SavedLocation, Dispatcher, Customer, Trailer } from './types';

export interface OrgData {
  assets: Asset[];
  drivers: Driver[];
  events: CalendarEvent[];
  deletedEvents: DeletedEvent[];
  driverPrefs: Record<number, number>;
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
  const driverPrefs: Record<number, number> = {};
  for (const p of prefsRes.prefs) driverPrefs[p.assetId] = p.driverId;

  return {
    assets:  assetsRes.assets,
    drivers: driversRes.drivers,
    events,
    deletedEvents,
    driverPrefs,
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
    const { trailer } = await railway.createTrailer({
      name:            t.name,
      trailerNumber:   t.trailerNumber  ?? null,
      category:        t.category,
      notes:           t.notes          ?? null,
      motiveVehicleId: t.motiveVehicleId ?? null,
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
  try { return (await railway.listCustomers()).customers; }
  catch (err) { console.error('fetchCustomers:', err); return []; }
}

export async function createCustomer(_orgId: string, c: Omit<Customer, 'id'>): Promise<Customer | null> {
  try {
    const { customer } = await railway.createCustomer({
      name:         c.name,
      aliases:      c.aliases ?? [],
      shortName:    c.shortName    ?? null,
      mcNum:        c.mcNum        ?? null,
      contactName:  c.contactName  ?? null,
      contactEmail: c.contactEmail ?? null,
      contactPhone: c.contactPhone ?? null,
      notes:        c.notes        ?? null,
    });
    return customer;
  } catch (err) { console.error('createCustomer:', err); return null; }
}

export async function updateCustomer(id: string, updates: Partial<Omit<Customer, 'id'>>): Promise<void> {
  const body = {
    ...(updates.name !== undefined         ? { name: updates.name } : {}),
    ...(updates.aliases !== undefined      ? { aliases: updates.aliases } : {}),
    ...(updates.shortName !== undefined    ? { shortName: updates.shortName ?? null } : {}),
    ...(updates.mcNum !== undefined        ? { mcNum: updates.mcNum ?? null } : {}),
    ...(updates.contactName !== undefined  ? { contactName: updates.contactName ?? null } : {}),
    ...(updates.contactEmail !== undefined ? { contactEmail: updates.contactEmail ?? null } : {}),
    ...(updates.contactPhone !== undefined ? { contactPhone: updates.contactPhone ?? null } : {}),
    ...(updates.notes !== undefined        ? { notes: updates.notes ?? null } : {}),
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

export async function fetchDispatchers(_orgId: string): Promise<Dispatcher[]> {
  try { return (await railway.listDispatchers()).dispatchers; }
  catch (err) { console.error('fetchDispatchers:', err); return []; }
}

export async function createDispatcher(_orgId: string, name: string, isDefault: boolean): Promise<Dispatcher | null> {
  try { return (await railway.createDispatcher({ name, isDefault })).dispatcher; }
  catch (err) { console.error('createDispatcher:', err); return null; }
}

export async function updateDispatcher(id: string, _orgId: string, updates: { name?: string; isDefault?: boolean }): Promise<void> {
  const body = {
    ...(updates.name !== undefined      ? { name: updates.name } : {}),
    ...(updates.isDefault !== undefined ? { isDefault: updates.isDefault } : {}),
  };
  if (Object.keys(body).length === 0) return;
  try { await railway.updateDispatcher(id, body); }
  catch (err) { console.error('updateDispatcher:', err); }
}

export async function deleteDispatcher(id: string): Promise<void> {
  try { await railway.deleteDispatcher(id); }
  catch (err) { console.error('deleteDispatcher:', err); }
}

export async function searchEvents(_orgId: string, query: string): Promise<CalendarEvent[]> {
  if (!query || query.length < 2) return [];
  try {
    const { loads } = await railway.searchLoads(query.trim(), 20);
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
  adj: { orgId?: string; driverName: string; weekStart: string; category: string; description?: string; amount: number },
): Promise<PayrollAdjustment | null> {
  try {
    const { adjustment } = await railway.createPayrollAdjustment({
      driverName:  adj.driverName,
      weekStart:   adj.weekStart,
      category:    adj.category,
      description: adj.description ?? null,
      amount:      adj.amount,
    });
    return adjustment;
  } catch (err) { console.error('addPayrollAdjustment:', err); return null; }
}

export async function deletePayrollAdjustment(id: string): Promise<void> {
  try { await railway.deletePayrollAdjustment(id); }
  catch (err) { console.error('deletePayrollAdjustment:', err); }
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

export async function finalizeDriverPay(
  _orgId: string, driverName: string, weekStart: string, totalPay: number,
): Promise<PayrollRecord | null> {
  try {
    const { record } = await railway.upsertPayrollRecord({ driverName, weekStart, totalPay });
    return record;
  } catch (err) { console.error('finalizeDriverPay:', err); return null; }
}

export async function unfinalizeDriverPay(id: string): Promise<void> {
  try { await railway.deletePayrollRecord(id); }
  catch (err) { console.error('unfinalizeDriverPay:', err); }
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

