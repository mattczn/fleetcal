'use client';

import { getSupabase } from './supabase';
import { joinEventLoadToApp } from '@fleetcal/types';
import { railway } from './railway';
import type { DeletedEvent } from '@/store/useCalendarStore';
import type { Asset, Driver, CalendarEvent, SavedLocation, Dispatcher, Customer, Trailer } from './types';

// Joined-query columns used by the few legacy reads still on Supabase
// direct (fetchBrokerLoads). All other event reads go through Railway.
const EVENT_COLS = 'id,org_id,asset_id,title,start,end,driver_name,driver_id,status,relay_role,trailer_type,trailer_id,driver_pay,notes,priority,deleted_at,created_at,updated_at,event_kind,non_revenue_type,load_id';
const LOAD_COLS = 'id,internal_load_id,load_num,broker,load_price,dispatcher,notes,accessorials,rate_con_pdf,ref_nums,created_by_name,customer_id';
const EVENT_SELECT_JOINED = `${EVENT_COLS}, load:loads(${LOAD_COLS})`;

/**
 * Convert a joined-query row (event + nested `load`) into the app-domain
 * Load (CalendarEvent) view. PostgREST returns the nested relationship as
 * an array even for many-to-one, so we unwrap.
 */
function joinedRowToCalendarEvent(row: unknown): CalendarEvent {
  const r = row as Record<string, unknown> & {
    load?: Record<string, unknown>[] | Record<string, unknown> | null;
  };
  const load = Array.isArray(r.load) ? (r.load[0] ?? null) : (r.load ?? null);
  return joinEventLoadToApp(r, load) as CalendarEvent;
}

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
  try {
    await railway.updateTrailer(id, {
      ...(updates.name !== undefined            ? { name: updates.name } : {}),
      ...(updates.trailerNumber !== undefined   ? { trailerNumber: updates.trailerNumber ?? null } : {}),
      ...(updates.category !== undefined        ? { category: updates.category } : {}),
      ...(updates.notes !== undefined           ? { notes: updates.notes ?? null } : {}),
      ...(updates.motiveVehicleId !== undefined ? { motiveVehicleId: updates.motiveVehicleId ?? null } : {}),
    });
  } catch (err) { console.error('updateTrailer:', err); }
}

export async function deleteTrailer(id: number): Promise<void> {
  try { await railway.deleteTrailer(id); }
  catch (err) { console.error('deleteTrailer:', err); }
}

// ── Saved Locations ───────────────────────────────────────────────────────────

type DbSavedLocation = { id: string; org_id: string; name: string; address: string | null; lat: number | null; lng: number | null; timezone: string | null };

function dbLocToApp(r: DbSavedLocation): SavedLocation {
  return { id: r.id, name: r.name, address: r.address ?? undefined, lat: r.lat ?? undefined, lng: r.lng ?? undefined, timezone: r.timezone ?? undefined };
}

export async function fetchSavedLocations(orgId: string): Promise<SavedLocation[]> {
  const { data, error } = await getSupabase().from('saved_locations').select('*').eq('org_id', orgId).order('name');
  if (error) { console.error('fetchSavedLocations:', error.message); return []; }
  return (data as DbSavedLocation[]).map(dbLocToApp);
}

export async function createSavedLocation(orgId: string, loc: Omit<SavedLocation, 'id'>): Promise<SavedLocation | null> {
  const { data, error } = await getSupabase().from('saved_locations')
    .insert({ org_id: orgId, name: loc.name, address: loc.address ?? null, lat: loc.lat ?? null, lng: loc.lng ?? null, timezone: loc.timezone ?? null })
    .select().single();
  if (error) { console.error('createSavedLocation:', error.message); return null; }
  return dbLocToApp(data as DbSavedLocation);
}

export async function updateSavedLocation(id: string, updates: Partial<Omit<SavedLocation, 'id'>>): Promise<void> {
  const { error } = await getSupabase().from('saved_locations').update({
    name: updates.name, address: updates.address ?? null, lat: updates.lat ?? null, lng: updates.lng ?? null, timezone: updates.timezone ?? null,
  }).eq('id', id);
  if (error) console.error('updateSavedLocation:', error.message);
}

export async function deleteSavedLocation(id: string): Promise<void> {
  const { error } = await getSupabase().from('saved_locations').delete().eq('id', id);
  if (error) console.error('deleteSavedLocation:', error.message);
}

// ── Customers ─────────────────────────────────────────────────────────────────

export async function fetchBrokerLoads(orgId: string, names: string[]): Promise<CalendarEvent[]> {
  if (names.length === 0) return [];
  const db = getSupabase();
  // Quote each value so commas inside names don't break the PostgREST filter parser
  const orFilter = names.map(n => `broker.ilike."${n.replace(/"/g, '')}"`).join(',');
  const { data, error } = await db
    .from('events')
    .select(EVENT_SELECT_JOINED)
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .or(orFilter)
    .order('start', { ascending: false });
  if (error) { console.error('fetchBrokerLoads:', error.message); return []; }
  return ((data ?? []) as Array<Record<string, unknown>>).map(joinedRowToCalendarEvent);
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
  try {
    await railway.updateCustomer(id, {
      ...(updates.name !== undefined         ? { name: updates.name } : {}),
      ...(updates.aliases !== undefined      ? { aliases: updates.aliases } : {}),
      ...(updates.shortName !== undefined    ? { shortName: updates.shortName ?? null } : {}),
      ...(updates.mcNum !== undefined        ? { mcNum: updates.mcNum ?? null } : {}),
      ...(updates.contactName !== undefined  ? { contactName: updates.contactName ?? null } : {}),
      ...(updates.contactEmail !== undefined ? { contactEmail: updates.contactEmail ?? null } : {}),
      ...(updates.contactPhone !== undefined ? { contactPhone: updates.contactPhone ?? null } : {}),
      ...(updates.notes !== undefined        ? { notes: updates.notes ?? null } : {}),
    });
  } catch (err) { console.error('updateCustomer:', err); }
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
  try {
    await railway.updateDispatcher(id, {
      ...(updates.name !== undefined      ? { name: updates.name } : {}),
      ...(updates.isDefault !== undefined ? { isDefault: updates.isDefault } : {}),
    });
  } catch (err) { console.error('updateDispatcher:', err); }
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

export interface PayrollAdjustment {
  id: string;
  orgId: string;
  driverName: string;
  weekStart: string;   // ISO date string YYYY-MM-DD
  category: string;
  description?: string;
  amount: number;
  createdAt: string;
}

export async function fetchPayrollAdjustments(orgId: string, weekStart: string): Promise<PayrollAdjustment[]> {
  const { data, error } = await getSupabase()
    .from('payroll_adjustments')
    .select('*')
    .eq('org_id', orgId)
    .eq('week_start', weekStart)
    .order('created_at');
  if (error || !data) return [];
  return (data as any[]).map(r => ({
    id: r.id, orgId: r.org_id, driverName: r.driver_name,
    weekStart: r.week_start, category: r.category,
    description: r.description ?? undefined, amount: Number(r.amount),
    createdAt: r.created_at,
  }));
}

export async function addPayrollAdjustment(
  adj: Omit<PayrollAdjustment, 'id' | 'createdAt'>
): Promise<PayrollAdjustment | null> {
  const { data, error } = await getSupabase()
    .from('payroll_adjustments')
    .insert({
      org_id: adj.orgId, driver_name: adj.driverName,
      week_start: adj.weekStart, category: adj.category,
      description: adj.description ?? null, amount: adj.amount,
    })
    .select()
    .single();
  if (error || !data) { console.error('addPayrollAdjustment:', error?.message); return null; }
  const r = data as any;
  return { id: r.id, orgId: r.org_id, driverName: r.driver_name, weekStart: r.week_start, category: r.category, description: r.description ?? undefined, amount: Number(r.amount), createdAt: r.created_at };
}

export async function deletePayrollAdjustment(id: string): Promise<void> {
  const { error } = await getSupabase().from('payroll_adjustments').delete().eq('id', id);
  if (error) console.error('deletePayrollAdjustment:', error.message);
}

// ── Payroll records (finalized payments) ─────────────────────────────────────

export interface PayrollRecord {
  id: string;
  orgId: string;
  driverName: string;
  weekStart: string;
  totalPay: number;
  finalizedAt: string;
  notes?: string;
}

export async function fetchPayrollRecord(
  orgId: string, driverName: string, weekStart: string
): Promise<PayrollRecord | null> {
  const { data, error } = await getSupabase()
    .from('payroll_records')
    .select('*')
    .eq('org_id', orgId)
    .eq('driver_name', driverName)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as any;
  return { id: r.id, orgId: r.org_id, driverName: r.driver_name, weekStart: r.week_start, totalPay: Number(r.total_pay), finalizedAt: r.finalized_at, notes: r.notes ?? undefined };
}

export async function finalizeDriverPay(
  orgId: string, driverName: string, weekStart: string, totalPay: number
): Promise<PayrollRecord | null> {
  const { data, error } = await getSupabase()
    .from('payroll_records')
    .upsert({ org_id: orgId, driver_name: driverName, week_start: weekStart, total_pay: totalPay, finalized_at: new Date().toISOString() }, { onConflict: 'org_id,driver_name,week_start' })
    .select()
    .single();
  if (error || !data) { console.error('finalizeDriverPay:', error?.message); return null; }
  const r = data as any;
  return { id: r.id, orgId: r.org_id, driverName: r.driver_name, weekStart: r.week_start, totalPay: Number(r.total_pay), finalizedAt: r.finalized_at };
}

export async function unfinalizeDriverPay(id: string): Promise<void> {
  const { error } = await getSupabase().from('payroll_records').delete().eq('id', id);
  if (error) console.error('unfinalizeDriverPay:', error.message);
}

export async function fetchPayrollRecordsForDriver(orgId: string, driverName: string): Promise<PayrollRecord[]> {
  const { data, error } = await getSupabase()
    .from('payroll_records')
    .select('*')
    .eq('org_id', orgId)
    .eq('driver_name', driverName)
    .order('week_start', { ascending: false });
  if (error || !data) return [];
  return (data as any[]).map(r => ({
    id: r.id, orgId: r.org_id, driverName: r.driver_name,
    weekStart: r.week_start, totalPay: Number(r.total_pay),
    finalizedAt: r.finalized_at, notes: r.notes ?? undefined,
  }));
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
    console.error('fetchEventAuditLog:', err);
    return null;
  }
}

