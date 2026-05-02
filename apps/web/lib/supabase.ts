import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Asset, Driver, Stop, StopType, GeocodeStatus, LoadAuditEntry } from './types';

// ── DB row types (snake_case columns) ─────────────────────────────────────────
// Used by the joined-event reads in lib/db.ts which still hit Supabase
// directly; reference-data CRUD all goes through Railway now.

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

export interface DbEvent {
  id: string;
  org_id: string;
  asset_id: number;
  title: string;
  start: string;
  end: string;
  driver_name: string | null;
  driver_id:   number | null;
  status: string;
  relay_role: string | null;
  trailer_type: string | null;
  trailer_id: number | null;
  driver_pay: number | null;
  notes: string | null;
  priority: boolean | null;
  event_kind: string | null;
  non_revenue_type: string | null;
  load_id: string | null;
  audit_log: LoadAuditEntry[] | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

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
// Only the read converters used by lib/db.ts:fetchOrgData. All writes go
// through Railway, so app→db converters live there.

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
    sortOrder:        row.sort_order,
  };
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

