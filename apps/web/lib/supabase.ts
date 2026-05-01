import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Driver, CalendarEvent, Accessorial, EventStatus, Stop, StopType, GeocodeStatus, Trailer, TrailerCategory, RefNum, LoadAuditEntry } from './types';
import { normalizePhone } from './phone';

function parseRefNums(raw: string | null): RefNum[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === 'object' && parsed[0] !== null && 'label' in parsed[0]) {
        return parsed as RefNum[];
      }
      // Old format: string[] — migrate on read
      return (parsed as string[]).filter(Boolean).map(v => ({ label: '', value: String(v) }));
    }
  } catch { /* legacy comma-separated */ }
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(v => ({ label: '', value: v }));
}

// ── DB row types (snake_case columns) ─────────────────────────────────────────
// IDs: assets/drivers use bigint (number), events use uuid (string)

export interface DbAsset {
  id: number;
  org_id: string;
  name: string;
  color: string;
  type: string;
  unit: string | null;
  truck: string | null;
  notes: string | null;
  hidden: boolean;
  sort_order: number;
  motive_vehicle_id: string | null;
  created_at: string;
}

export interface DbDriver {
  id: number;
  org_id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
}

export interface DbDriverAssetPref {
  asset_id: number;
  driver_id: number;
  org_id: string;
}

export interface DbTrailer {
  id: number;
  org_id: string;
  name: string;
  trailer_number: string | null;
  category: TrailerCategory;
  notes: string | null;
  motive_vehicle_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface DbEvent {
  id: string;
  internal_load_id: number | null;
  org_id: string;
  asset_id: number;
  title: string;
  start: string;
  end: string;
  driver_name: string | null;
  driver_id:   number | null;
  status: string;
  relay_group_id: string | null;
  relay_role: string | null;
  load_num: string | null;
  ref_nums: string | null;
  broker: string | null;
  trailer_type: string | null;
  trailer_id: number | null;
  dispatcher: string | null;
  load_price: number | null;
  driver_pay: number | null;
  special_instructions: string | null;
  notes: string | null;
  rate_con_pdf: string | null;
  accessorials: Accessorial[] | null;
  priority: boolean | null;
  event_kind: string | null;
  non_revenue_type: string | null;
  created_by_name: string | null;
  audit_log: LoadAuditEntry[] | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// Legacy columns removed from DB (kept here for reference during migration):
// bol_num, po_num, commodity, weight, miles, team_load, hazmat,
// pickup_city, delivery_city, pickup_appt, delivery_appt,
// rate_per_mile, factoring_company, invoice_num, payment_status,
// trailer_num, dispatched

export interface DbStop {
  id: string;
  event_id: string;
  org_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  appt_start: string | null;
  appt_end: string | null;
  timezone: string | null;
  geocode_status: string;
  instructions: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
  created_at: string;
  updated_at: string;
}

// ── Client singleton ──────────────────────────────────────────────────────────

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
    }
    _client = createClient(url, key);
  }
  return _client;
}

// ── Converters: DB row → app type ─────────────────────────────────────────────
// IDs are already the right type (number for assets/drivers, string for events)

export function dbTrailerToApp(row: DbTrailer): Trailer {
  return {
    id:              row.id,
    name:            row.name,
    trailerNumber:   row.trailer_number   ?? undefined,
    category:        row.category,
    notes:           row.notes            ?? undefined,
    motiveVehicleId: row.motive_vehicle_id ?? undefined,
    sortOrder:       row.sort_order,
  };
}

export function appTrailerToDb(
  t: Omit<Trailer, 'id'>,
  orgId: string,
  sortOrder = 0,
  id?: number,
): Omit<DbTrailer, 'created_at'> {
  return {
    ...(id != null ? { id } : {}),
    org_id:            orgId,
    name:              t.name,
    trailer_number:    t.trailerNumber    ?? null,
    category:          t.category,
    notes:             t.notes            ?? null,
    motive_vehicle_id: t.motiveVehicleId  ?? null,
    sort_order:        sortOrder,
  } as Omit<DbTrailer, 'created_at'>;
}

export function trailerUpdatesToDb(updates: Partial<Omit<Trailer, 'id'>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('name'            in updates) out.name              = updates.name;
  if ('trailerNumber'   in updates) out.trailer_number    = updates.trailerNumber    ?? null;
  if ('category'        in updates) out.category          = updates.category;
  if ('notes'           in updates) out.notes             = updates.notes            ?? null;
  if ('motiveVehicleId' in updates) out.motive_vehicle_id = updates.motiveVehicleId  ?? null;
  return out;
}

export function dbAssetToApp(row: DbAsset): Asset {
  return {
    id:               row.id,
    name:             row.name,
    color:            row.color,
    type:             row.type,
    unit:             row.unit              ?? undefined,
    truck:            row.truck             ?? undefined,
    hidden:           row.hidden,
    notes:            row.notes             ?? undefined,
    motiveVehicleId:  row.motive_vehicle_id ?? undefined,
  };
}

export function assetUpdatesToDb(updates: Partial<Omit<Asset, 'id'>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('name'            in updates) out.name              = updates.name;
  if ('color'           in updates) out.color             = updates.color;
  if ('type'            in updates) out.type              = updates.type;
  if ('unit'            in updates) out.unit              = updates.unit             ?? null;
  if ('truck'           in updates) out.truck             = updates.truck            ?? null;
  if ('hidden'          in updates) out.hidden            = updates.hidden           ?? false;
  if ('notes'           in updates) out.notes             = updates.notes            ?? null;
  if ('motiveVehicleId' in updates) out.motive_vehicle_id = updates.motiveVehicleId ?? null;
  return out;
}

export function dbDriverToApp(row: DbDriver): Driver {
  return {
    id:        row.id,
    name:      row.name,
    firstName: row.first_name  ?? undefined,
    lastName:  row.last_name   ?? undefined,
    phone:     row.phone       ?? undefined,
    notes:     row.notes       ?? undefined,
  };
}

// dbEventToApp / appEventToDb moved to @fleetcal/types/converters and re-exported below.
export { dbEventToApp, appEventToDb } from "@fleetcal/types";

export function appAssetToDb(
  asset: Omit<Asset, 'id'>,
  orgId: string,
  sortOrder = 0,
  id?: number,
): Omit<DbAsset, 'created_at'> {
  return {
    ...(id != null ? { id } : {}),
    org_id:            orgId,
    name:              asset.name,
    color:             asset.color,
    type:              asset.type,
    unit:              asset.unit             ?? null,
    truck:             asset.truck            ?? null,
    notes:             asset.notes            ?? null,
    hidden:            asset.hidden           ?? false,
    sort_order:        sortOrder,
    motive_vehicle_id: asset.motiveVehicleId  ?? null,
  } as Omit<DbAsset, 'created_at'>;
}

export function dbStopToApp(row: DbStop): Stop {
  return {
    id:            row.id,
    eventId:       row.event_id,
    sequence:      row.sequence,
    type:          row.type as StopType,
    facilityName:  row.facility_name  ?? undefined,
    address:       row.address        ?? undefined,
    city:          row.city           ?? undefined,
    lat:           row.lat            ?? undefined,
    lng:           row.lng            ?? undefined,
    apptStart:     row.appt_start     ?? undefined,
    apptEnd:       row.appt_end       ?? undefined,
    timezone:      row.timezone       ?? undefined,
    geocodeStatus: row.geocode_status as GeocodeStatus,
    instructions:  row.instructions   ?? undefined,
    arrivedAt:     row.arrived_at     ?? undefined,
    arrivedLat:    row.arrived_lat    ?? undefined,
    arrivedLng:    row.arrived_lng    ?? undefined,
  };
}

export function appStopToDb(stop: Omit<Stop, 'id'>, orgId: string, eventId: string, id?: string): Omit<DbStop, 'created_at' | 'updated_at'> {
  return {
    id:            id ?? crypto.randomUUID(),
    event_id:      eventId,
    org_id:        orgId,
    sequence:      stop.sequence,
    type:          stop.type,
    facility_name: stop.facilityName   ?? null,
    address:       stop.address        ?? null,
    city:          stop.city           ?? null,
    lat:           stop.lat            ?? null,
    lng:           stop.lng            ?? null,
    appt_start:    stop.apptStart      ?? null,
    appt_end:      stop.apptEnd        ?? null,
    timezone:      stop.timezone       ?? null,
    geocode_status: stop.geocodeStatus,
    instructions:  stop.instructions   ?? null,
    arrived_at:    stop.arrivedAt      ?? null,
    arrived_lat:   stop.arrivedLat     ?? null,
    arrived_lng:   stop.arrivedLng     ?? null,
  };
}

export function appDriverToDb(
  driver: Omit<Driver, 'id'>,
  orgId: string,
  id?: number,
): Omit<DbDriver, 'created_at'> {
  return {
    ...(id != null ? { id } : {}),
    org_id:     orgId,
    name:       driver.name,
    first_name: driver.firstName ?? null,
    last_name:  driver.lastName  ?? null,
    phone:      normalizePhone(driver.phone),
    notes:      driver.notes     ?? null,
  } as Omit<DbDriver, 'created_at'>;
}
