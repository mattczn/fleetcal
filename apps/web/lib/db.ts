'use client';

import { getSupabase, dbAssetToApp, dbDriverToApp, dbStopToApp, DbAsset, DbDriver, DbStop, DbTrailer, dbTrailerToApp, appTrailerToDb, trailerUpdatesToDb } from './supabase';
import { joinEventLoadToApp } from '@fleetcal/types';
import type { DeletedEvent } from '@/store/useCalendarStore';
import type { Asset, Driver, CalendarEvent, Stop, SavedLocation, Dispatcher, Customer, Trailer } from './types';

// Joined-query columns. events is per-leg; loads is per-load.
// audit_log is excluded from the list query (accumulates over time;
// fetched on-demand by the modal via fetchEventAuditLog).
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
  orgId: string,
  windowStart?: string,
  windowEnd?: string,
): Promise<OrgData> {
  const db = getSupabase();

  let eventsQuery = db.from('events').select(EVENT_SELECT_JOINED).eq('org_id', orgId).order('start');
  if (windowStart) eventsQuery = eventsQuery.gte('start', windowStart);
  if (windowEnd)   eventsQuery = eventsQuery.lte('start', windowEnd);

  const [assetsRes, driversRes, eventsRes, prefsRes] = await Promise.all([
    db.from('assets').select('*').eq('org_id', orgId).order('sort_order'),
    db.from('drivers').select('*').eq('org_id', orgId).order('name'),
    eventsQuery,
    db.from('driver_asset_prefs').select('*').eq('org_id', orgId),
  ]);

  if (assetsRes.error) throw assetsRes.error;
  if (driversRes.error) throw driversRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const allEventRows = (eventsRes.data ?? []) as Array<Record<string, unknown> & { deleted_at: string | null }>;
  const events = allEventRows
    .filter(r => !r.deleted_at)
    .map(joinedRowToCalendarEvent);
  const deletedEvents = allEventRows
    .filter(r => !!r.deleted_at)
    .map(r => ({
      ...joinedRowToCalendarEvent(r),
      deletedAt: r.deleted_at as string,
    }));

  await attachStopsToEvents([...events, ...deletedEvents]);

  return {
    assets:  (assetsRes.data  as DbAsset[]).map(dbAssetToApp),
    drivers: (driversRes.data as DbDriver[]).map(dbDriverToApp),
    events,
    deletedEvents,
    driverPrefs: Object.fromEntries(
      (prefsRes.data ?? []).map((p: { asset_id: number; driver_id: number }) => [p.asset_id, p.driver_id])
    ),
  };
}

export async function fetchEventsInRange(
  orgId: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<{ events: CalendarEvent[]; deletedEvents: DeletedEvent[] }> {
  const db = getSupabase();
  const { data, error } = await db.from('events')
    .select(EVENT_SELECT_JOINED)
    .eq('org_id', orgId)
    .gte('start', rangeStart)
    .lte('start', rangeEnd)
    .order('start');

  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown> & { deleted_at: string | null }>;
  const events = rows.filter(r => !r.deleted_at).map(joinedRowToCalendarEvent);
  const deletedEvents = rows
    .filter(r => !!r.deleted_at)
    .map(r => ({ ...joinedRowToCalendarEvent(r), deletedAt: r.deleted_at as string }));

  await attachStopsToEvents([...events, ...deletedEvents]);

  return { events, deletedEvents };
}

/**
 * Fetch all stops for a set of event IDs and merge them into the events array.
 * Mutates the events in-place for efficiency.
 */
export async function attachStopsToEvents(events: CalendarEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = getSupabase();
  const ids = events.map(e => e.id);

  // Supabase "in" filter has limits; chunk if needed
  const chunkSize = 100;
  const allRows: DbStop[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await db
      .from('stops')
      .select('*')
      .in('event_id', ids.slice(i, i + chunkSize))
      .order('sequence');
    if (!error && data) allRows.push(...(data as DbStop[]));
  }

  const byEvent = new Map<string, Stop[]>();
  for (const row of allRows) {
    const stop = dbStopToApp(row);
    const arr = byEvent.get(row.event_id) ?? [];
    arr.push(stop);
    byEvent.set(row.event_id, arr);
  }

  for (const ev of events) {
    ev.stops = byEvent.get(ev.id) ?? [];
  }
}

// ── Trailers ──────────────────────────────────────────────────────────────────

export async function fetchTrailers(orgId: string): Promise<Trailer[]> {
  const { data, error } = await getSupabase().from('trailers').select('*').eq('org_id', orgId).order('sort_order');
  if (error) { console.error('fetchTrailers:', error.message); return []; }
  return (data as DbTrailer[]).map(dbTrailerToApp);
}

export async function createTrailer(orgId: string, t: Omit<Trailer, 'id'>, sortOrder: number): Promise<Trailer | null> {
  const { data, error } = await getSupabase().from('trailers').insert(appTrailerToDb(t, orgId, sortOrder)).select().single();
  if (error) { console.error('createTrailer:', error.message); return null; }
  return dbTrailerToApp(data as DbTrailer);
}

export async function updateTrailer(id: number, updates: Partial<Omit<Trailer, 'id'>>): Promise<void> {
  const { error } = await getSupabase().from('trailers').update(trailerUpdatesToDb(updates)).eq('id', id);
  if (error) console.error('updateTrailer:', error.message);
}

export async function deleteTrailer(id: number): Promise<void> {
  const { error } = await getSupabase().from('trailers').delete().eq('id', id);
  if (error) console.error('deleteTrailer:', error.message);
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

type DbCustomer = {
  id: string; org_id: string; name: string; aliases: string[];
  short_name: string | null;
  mc_num: string | null; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; notes: string | null;
};

function dbCustomerToApp(r: DbCustomer): Customer {
  return {
    id: r.id, name: r.name, aliases: r.aliases ?? [],
    shortName: r.short_name ?? undefined,
    mcNum: r.mc_num ?? undefined, contactName: r.contact_name ?? undefined,
    contactEmail: r.contact_email ?? undefined, contactPhone: r.contact_phone ?? undefined,
    notes: r.notes ?? undefined,
  };
}

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

export async function fetchCustomers(orgId: string): Promise<Customer[]> {
  const { data, error } = await getSupabase().from('customers').select('*').eq('org_id', orgId).order('name');
  if (error) { console.error('fetchCustomers:', error.message); return []; }
  return (data as DbCustomer[]).map(dbCustomerToApp);
}

export async function createCustomer(orgId: string, c: Omit<Customer, 'id'>): Promise<Customer | null> {
  const { data, error } = await getSupabase().from('customers').insert({
    org_id: orgId, name: c.name, aliases: c.aliases ?? [],
    short_name: c.shortName ?? null,
    mc_num: c.mcNum ?? null, contact_name: c.contactName ?? null,
    contact_email: c.contactEmail ?? null, contact_phone: c.contactPhone ?? null,
    notes: c.notes ?? null,
  }).select().single();
  if (error) { console.error('createCustomer:', error.message); return null; }
  return dbCustomerToApp(data as DbCustomer);
}

export async function updateCustomer(id: string, updates: Partial<Omit<Customer, 'id'>>): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (updates.name        !== undefined) patch.name          = updates.name;
  if (updates.aliases     !== undefined) patch.aliases       = updates.aliases;
  if (updates.shortName   !== undefined) patch.short_name    = updates.shortName ?? null;
  if (updates.mcNum       !== undefined) patch.mc_num        = updates.mcNum ?? null;
  if (updates.contactName !== undefined) patch.contact_name  = updates.contactName ?? null;
  if (updates.contactEmail !== undefined) patch.contact_email = updates.contactEmail ?? null;
  if (updates.contactPhone !== undefined) patch.contact_phone = updates.contactPhone ?? null;
  if (updates.notes       !== undefined) patch.notes         = updates.notes ?? null;
  const { error } = await getSupabase().from('customers').update(patch).eq('id', id);
  if (error) console.error('updateCustomer:', error.message);
}

export async function deleteCustomer(id: string): Promise<void> {
  const { error } = await getSupabase().from('customers').delete().eq('id', id);
  if (error) console.error('deleteCustomer:', error.message);
}

// ── Dispatchers ───────────────────────────────────────────────────────────────

type DbDispatcher = { id: string; org_id: string; name: string; is_default: boolean };

function dbDispatcherToApp(r: DbDispatcher): Dispatcher {
  return { id: r.id, name: r.name, isDefault: r.is_default };
}

export async function fetchDispatchers(orgId: string): Promise<Dispatcher[]> {
  const { data, error } = await getSupabase().from('dispatchers').select('*').eq('org_id', orgId).order('name');
  if (error) { console.error('fetchDispatchers:', error.message); return []; }
  return (data as DbDispatcher[]).map(dbDispatcherToApp);
}

export async function createDispatcher(orgId: string, name: string, isDefault: boolean): Promise<Dispatcher | null> {
  const db = getSupabase();
  if (isDefault) await db.from('dispatchers').update({ is_default: false }).eq('org_id', orgId);
  const { data, error } = await db.from('dispatchers').insert({ org_id: orgId, name, is_default: isDefault }).select().single();
  if (error) { console.error('createDispatcher:', error.message); return null; }
  return dbDispatcherToApp(data as DbDispatcher);
}

export async function updateDispatcher(id: string, orgId: string, updates: { name?: string; isDefault?: boolean }): Promise<void> {
  const db = getSupabase();
  if (updates.isDefault) await db.from('dispatchers').update({ is_default: false }).eq('org_id', orgId);
  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.isDefault !== undefined) patch.is_default = updates.isDefault;
  const { error } = await db.from('dispatchers').update(patch).eq('id', id);
  if (error) console.error('updateDispatcher:', error.message);
}

export async function deleteDispatcher(id: string): Promise<void> {
  const { error } = await getSupabase().from('dispatchers').delete().eq('id', id);
  if (error) console.error('deleteDispatcher:', error.message);
}

export async function searchEvents(orgId: string, query: string): Promise<CalendarEvent[]> {
  if (!query || query.length < 2) return [];
  const db = getSupabase();
  const q  = query.trim();
  const numericId = /^\d+$/.test(q) ? parseInt(q, 10) : null;
  // Match against event-level fields directly + load-level fields via join.
  // Two queries (event-side + load-side) → union — PostgREST doesn't support
  // OR across nested-relation filters in a single .or().
  const escaped = q.replace(/[%,()]/g, '\\$&');
  const pattern = `%${escaped}%`;

  const evtQuery = db
    .from('events')
    .select(EVENT_SELECT_JOINED)
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .or(`title.ilike.${pattern},driver_name.ilike.${pattern},notes.ilike.${pattern}`)
    .order('start', { ascending: false })
    .limit(20);

  const loadOr = numericId !== null
    ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
    : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;
  const loadIdsQuery = db
    .from('loads')
    .select('id')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .or(loadOr)
    .limit(50);

  const [evtRes, loadIdsRes] = await Promise.all([evtQuery, loadIdsQuery]);
  if (evtRes.error) { console.error('searchEvents events:', evtRes.error); return []; }

  const matchedLoadIds = ((loadIdsRes.data ?? []) as { id: string }[]).map(r => r.id);
  let loadMatches: unknown[] = [];
  if (matchedLoadIds.length > 0) {
    const res = await db.from('events')
      .select(EVENT_SELECT_JOINED)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .in('load_id', matchedLoadIds)
      .order('start', { ascending: false })
      .limit(20);
    if (res.error) console.error('searchEvents loads:', res.error);
    loadMatches = res.data ?? [];
  }

  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const r of [...((evtRes.data ?? []) as Array<Record<string, unknown>>), ...(loadMatches as Array<Record<string, unknown>>)]) {
    const id = r.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(joinedRowToCalendarEvent(r));
  }
  return out.slice(0, 20);
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

export interface LoadDocument {
  id: string;
  eventId: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: 'bol' | 'pod' | 'scale' | 'other';
  uploadedAt: string;
  storagePath: string;
  signedUrl?: string;
}

export async function fetchLoadDocuments(eventId: string, orgId: string): Promise<LoadDocument[]> {
  const db = getSupabase();
  const { data, error } = await db
    .from('load_documents')
    .select('id,event_id,file_name,mime_type,size_bytes,kind,uploaded_at,storage_path')
    .eq('event_id', eventId)
    .eq('org_id', orgId)
    .order('uploaded_at', { ascending: false });
  if (error) { console.error('fetchLoadDocuments:', error); return []; }
  const rows = (data ?? []).map(r => ({
    id:           r.id as string,
    eventId:      r.event_id as string,
    fileName:     r.file_name as string,
    mimeType:     (r.mime_type as string | null) ?? undefined,
    sizeBytes:    (r.size_bytes as number | null) ?? undefined,
    kind:         (r.kind as LoadDocument['kind']) ?? 'other',
    uploadedAt:   r.uploaded_at as string,
    storagePath:  r.storage_path as string,
  }));
  if (rows.length === 0) return rows;

  // Batch-resolve signed URLs in a single API call so clicking a doc is instant.
  const { data: urlData, error: urlErr } = await db.storage
    .from('load-documents')
    .createSignedUrls(rows.map(r => r.storagePath), 3600);
  if (urlErr) { console.error('fetchLoadDocuments signedUrls:', urlErr); return rows; }
  const urlByPath = new Map<string, string>();
  for (const u of urlData ?? []) {
    if (u.path && u.signedUrl) urlByPath.set(u.path, u.signedUrl);
  }
  return rows.map(r => ({ ...r, signedUrl: urlByPath.get(r.storagePath) }));
}

export async function getLoadDocumentSignedUrl(storagePath: string, expiresInSec = 3600): Promise<string | null> {
  const db = getSupabase();
  const { data, error } = await db.storage.from('load-documents').createSignedUrl(storagePath, expiresInSec);
  if (error || !data) { console.error('getLoadDocumentSignedUrl:', error); return null; }
  return data.signedUrl;
}

export async function fetchEventAuditLog(eventId: string, orgId: string): Promise<import('./types').LoadAuditEntry[] | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from('events')
    .select('audit_log')
    .eq('id', eventId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) { console.error('fetchEventAuditLog:', error); return null; }
  return (data?.audit_log as import('./types').LoadAuditEntry[] | null) ?? [];
}

export async function fetchEventPdf(eventId: string): Promise<string | null> {
  const db = getSupabase();
  const { data, error } = await db
    .from('events')
    .select('load:loads(rate_con_pdf)')
    .eq('id', eventId)
    .single();
  if (error || !data) return null;
  const load = Array.isArray(data.load) ? data.load[0] : data.load;
  const val = (load as { rate_con_pdf: string | null } | null)?.rate_con_pdf ?? null;
  if (!val) return null;
  // Legacy: base64 data URLs stored before storage migration — return as-is
  if (val.startsWith('data:')) return val;
  // Storage path — return a signed URL valid for 1 hour
  const { getRateConSignedUrl } = await import('./storage');
  return getRateConSignedUrl(val);
}
