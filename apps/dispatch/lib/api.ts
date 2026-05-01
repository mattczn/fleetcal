import { supabase } from "./supabase";
import { joinEventLoadToApp } from "@fleetcal/types";
import type { Accessorial, Asset, Driver, Load, LoadStatus, RefNum, Stop, StopType } from "./types";

interface DbAssetRow {
  id:                 number;
  name:               string;
  type:               string;
  unit:               string | null;
  // assets.color is NOT NULL in the DB
  color:              string;
  hidden:             boolean;
  sort_order:         number;
  motive_vehicle_id:  string | null;
}

interface DbStopRow {
  id:            string;
  event_id:      string;
  sequence:      number;
  type:          string;
  facility_name: string | null;
  address:       string | null;
  city:          string | null;
  timezone:      string | null;
  appt_start:    string | null;
  appt_end:      string | null;
  lat:           number | null;
  lng:           number | null;
  instructions:  string | null;
  arrived_at:    string | null;
  arrived_lat:   number | null;
  arrived_lng:   number | null;
}

interface DbEventRow {
  id:                    string;
  internal_load_id:      number | null;
  asset_id:              number;
  driver_id:             number | null;
  driver_name:           string | null;
  load_num:              string | null;
  title:                 string;
  start:                 string;
  end:                   string;
  status:                string;
  broker:                string | null;
  trailer_type:          string | null;
  trailer_id:            number | null;
  driver_pay:            number | null;
  load_price:            number | null;
  notes:                 string | null;
  special_instructions:  string | null;
  ref_nums:              string | null;
  dispatcher:            string | null;
  accessorials:          unknown;
  rate_con_pdf:          string | null;
  relay_group_id:        string | null;
  relay_role:            string | null;
  created_by_name:       string | null;
  deleted_at:            string | null;
}

const STOP_COLS = "id,event_id,sequence,type,facility_name,address,city,timezone,appt_start,appt_end,lat,lng,instructions,arrived_at,arrived_lat,arrived_lng";

// Legacy column lists — used by paths not yet converted to the loads/events
// split. These pull load-level fields from the deprecated event columns and
// will return empty/null after Phase 2.5c drops those columns.
const EVENT_LIST_COLS = "id,internal_load_id,asset_id,driver_id,driver_name,load_num,title,start,end,status,broker,trailer_type,driver_pay,notes,special_instructions,deleted_at";
const EVENT_FULL_COLS = "id,internal_load_id,asset_id,driver_id,driver_name,load_num,title,start,end,status,broker,trailer_type,trailer_id,driver_pay,load_price,notes,special_instructions,ref_nums,dispatcher,accessorials,rate_con_pdf,relay_group_id,relay_role,created_by_name,deleted_at";

// Phase 2.5b column lists — for joined fetches against the new schema.
// Event-level fields only (no load-level denormalization). Load-level fields
// come back via the nested `load:loads(...)` select.
const EVENT_COLS_NEW =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at";
const LOAD_COLS_NEW =
  "id,internal_load_id,load_num,broker,load_price,dispatcher,notes," +
  "accessorials,rate_con_pdf,ref_nums,audit_log,created_by_name,customer_id";

function rowToStop(r: DbStopRow): Stop {
  return {
    id:           r.id,
    sequence:     r.sequence,
    type:         r.type as StopType,
    facilityName: r.facility_name ?? undefined,
    address:      r.address       ?? undefined,
    city:         r.city          ?? undefined,
    timezone:     r.timezone      ?? undefined,
    apptStart:    r.appt_start    ?? undefined,
    apptEnd:      r.appt_end      ?? undefined,
    lat:          r.lat           ?? undefined,
    lng:          r.lng           ?? undefined,
    instructions: r.instructions  ?? undefined,
    arrivedAt:    r.arrived_at    ?? undefined,
    arrivedLat:   r.arrived_lat   ?? undefined,
    arrivedLng:   r.arrived_lng   ?? undefined,
  };
}

function parseRefNums(raw: string | null): RefNum[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "object" && parsed[0] !== null && "label" in parsed[0]) {
        return parsed as RefNum[];
      }
      return (parsed as string[]).filter(Boolean).map((v) => ({ label: "", value: String(v) }));
    }
  } catch { /* legacy comma-separated */ }
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((v) => ({ label: "", value: v }));
}

function parseAccessorials(raw: unknown): Accessorial[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw as Accessorial[];
  if (typeof raw === "string") {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : undefined; } catch { return undefined; }
  }
  return undefined;
}

/**
 * Returns the preferred driver_id keyed by asset_id for this org.
 * (Schema enforces one preferred driver per asset.)
 */
export async function fetchDriverAssetPrefs(orgId: string): Promise<Map<number, number>> {
  const { data, error } = await supabase
    .from("driver_asset_prefs")
    .select("asset_id,driver_id")
    .eq("org_id", orgId);
  if (error) { console.error("fetchDriverAssetPrefs:", error); return new Map(); }
  const map = new Map<number, number>();
  for (const row of (data ?? []) as { asset_id: number; driver_id: number }[]) {
    map.set(row.asset_id, row.driver_id);
  }
  return map;
}

export async function fetchDrivers(orgId: string): Promise<Driver[]> {
  const { data, error } = await supabase
    .from("drivers")
    .select("id,name,phone")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) { console.error("fetchDrivers:", error); return []; }
  return ((data ?? []) as { id: number; name: string; phone: string | null }[]).map((d) => ({
    id:    d.id,
    name:  d.name,
    phone: d.phone ?? undefined,
  }));
}

export interface Customer {
  id:           string;
  name:         string;
  aliases:      string[];
  shortName?:   string;
  contactName?: string;
  contactPhone?: string;
}

export async function fetchCustomers(orgId: string): Promise<Customer[]> {
  const { data, error } = await supabase
    .from("customers")
    .select("id,name,aliases,short_name,contact_name,contact_phone")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) { console.error("fetchCustomers:", error); return []; }
  return (data ?? []).map((c) => ({
    id:           c.id as string,
    name:         c.name as string,
    aliases:      (c.aliases as string[] | null) ?? [],
    shortName:    (c.short_name as string | null) ?? undefined,
    contactName:  (c.contact_name as string | null) ?? undefined,
    contactPhone: (c.contact_phone as string | null) ?? undefined,
  }));
}

/**
 * Replace all stops for an event (matches dispatch-next/lib/db.ts pattern):
 * delete existing then insert the new ordered set. Sequence is rewritten to
 * 1..N from array order so the caller never has to manage sequence numbers.
 */
export async function saveStops(eventId: string, orgId: string, stops: Stop[]): Promise<void> {
  const del = await supabase.from("stops").delete().eq("event_id", eventId).eq("org_id", orgId);
  if (del.error) throw new Error(del.error.message);
  if (stops.length === 0) return;
  const rows = stops.map((s, i) => ({
    event_id:      eventId,
    org_id:        orgId,
    sequence:      i + 1,
    type:          s.type,
    facility_name: s.facilityName ?? null,
    address:       s.address      ?? null,
    city:          s.city         ?? null,
    timezone:      s.timezone     ?? null,
    appt_start:    s.apptStart    ?? null,
    appt_end:      s.apptEnd      ?? null,
    lat:           s.lat          ?? null,
    lng:           s.lng          ?? null,
    instructions:  s.instructions ?? null,
    arrived_at:    s.arrivedAt    ?? null,
    arrived_lat:   s.arrivedLat   ?? null,
    arrived_lng:   s.arrivedLng   ?? null,
  }));
  const ins = await supabase.from("stops").insert(rows);
  if (ins.error) throw new Error(ins.error.message);
}

export interface GeocodeResult {
  lat:       number;
  lng:       number;
  timezone?: string;
}

/**
 * Geocode an address via dispatch-next's /api/geocode endpoint, which uses
 * Google Geocoding + geo-tz for timezone resolution. Returns null on failure.
 */
export async function geocodeAddress(
  getToken: () => Promise<string | null>,
  address: string,
): Promise<GeocodeResult | null> {
  const baseUrl = (await import("./env")).env.dispatchApiUrl;
  if (!baseUrl) return null;
  try {
    const token = await getToken();
    const res = await fetch(`${baseUrl}/api/geocode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: GeocodeResult | null };
    return json.result ?? null;
  } catch (err) {
    console.warn("geocodeAddress:", err);
    return null;
  }
}

/** RFC4122-ish UUID — fine for relay-group/event ids; not crypto-strong. */
function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface SplitRelayOptions {
  eventId:            string;
  orgId:              string;
  pickupEnd:          string; // ISO — when Driver 1 drops at relay
  deliveryStart:      string; // ISO — when Driver 2 picks up
  deliveryEnd:        string; // ISO — end of delivery leg (usually = original end)
  deliveryAssetId:    number;
  deliveryDriverId?:  number | null;
  deliveryDriverName?: string | null;
  mergedStops:        Stop[];  // full stops list including the relay-type stop
}

/**
 * Split a single load into a relay pair: this event becomes the pickup leg,
 * a new event row is created for the delivery leg. Both events share the
 * same `relay_group_id`. Stops are written identically to both events
 * (matching dispatch-next's pattern in createRelayPair).
 *
 * Returns the new delivery-leg event id.
 */
export async function splitIntoRelay(opts: SplitRelayOptions): Promise<string> {
  const groupId    = uuid();
  const deliveryId = uuid();

  const cur = await supabase.from("events").select("*").eq("id", opts.eventId).eq("org_id", opts.orgId).single();
  if (cur.error || !cur.data) throw new Error(cur.error?.message ?? "Event not found");

  const row = cur.data as Record<string, unknown>;
  // Clone — drop PK and timestamps, override per-leg fields.
  const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = row;
  void _id; void _ca; void _ua;
  const deliveryRow: Record<string, unknown> = {
    ...rest,
    id:              deliveryId,
    asset_id:        opts.deliveryAssetId,
    driver_id:       opts.deliveryDriverId ?? null,
    driver_name:     opts.deliveryDriverName ?? null,
    start:           opts.deliveryStart,
    end:             opts.deliveryEnd,
    status:          "scheduled",
    relay_group_id:  groupId,
    relay_role:      "delivery",
  };
  const ins = await supabase.from("events").insert(deliveryRow);
  if (ins.error) throw new Error(`Couldn't create delivery leg: ${ins.error.message}`);

  const upd = await supabase.from("events").update({
    end:            opts.pickupEnd,
    relay_group_id: groupId,
    relay_role:     "pickup",
  }).eq("id", opts.eventId).eq("org_id", opts.orgId);
  if (upd.error) throw new Error(`Couldn't update pickup leg: ${upd.error.message}`);

  await saveStops(opts.eventId, opts.orgId, opts.mergedStops);
  await saveStops(deliveryId,   opts.orgId, opts.mergedStops);

  return deliveryId;
}

export interface DeletedLoadRow {
  id:           string;
  title:        string;
  loadNum?:     string;
  broker?:      string;
  start:        string;
  end:          string;
  assetName?:   string;
  driverName?:  string;
  deletedAt:    string;
}

/**
 * Soft-delete a load. If the load is part of a relay, the partner leg is
 * unmarked (relay_group_id/relay_role cleared) so it stands alone afterward.
 */
export async function softDeleteLoad(id: string, orgId: string): Promise<void> {
  const cur = await supabase.from("events").select("relay_group_id").eq("id", id).eq("org_id", orgId).single();
  if (cur.error || !cur.data) throw new Error(cur.error?.message ?? "Load not found");
  const groupId = (cur.data as { relay_group_id: string | null }).relay_group_id;

  const deletedAt = new Date().toISOString();
  const upd = await supabase.from("events").update({ deleted_at: deletedAt }).eq("id", id).eq("org_id", orgId);
  if (upd.error) throw new Error(upd.error.message);

  if (groupId) {
    const partnerUpd = await supabase.from("events").update({ relay_group_id: null, relay_role: null })
      .eq("relay_group_id", groupId).eq("org_id", orgId).neq("id", id).is("deleted_at", null);
    if (partnerUpd.error) console.warn("softDeleteLoad partner clear:", partnerUpd.error.message);
  }
}

export async function restoreLoad(id: string, orgId: string): Promise<void> {
  const upd = await supabase.from("events").update({ deleted_at: null }).eq("id", id).eq("org_id", orgId);
  if (upd.error) throw new Error(upd.error.message);
}

export async function purgeLoad(id: string, orgId: string): Promise<void> {
  // Hard delete: stops cascade via FK ON DELETE CASCADE.
  const del = await supabase.from("events").delete().eq("id", id).eq("org_id", orgId);
  if (del.error) throw new Error(del.error.message);
}

/**
 * Recently deleted loads for this org, newest first. Filters to last `days` days.
 */
export async function fetchDeletedLoads(orgId: string, days = 30): Promise<DeletedLoadRow[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("events")
    .select("id,title,load_num,broker,start,end,asset_id,driver_name,deleted_at")
    .eq("org_id", orgId)
    .not("deleted_at", "is", null)
    .gte("deleted_at", cutoff)
    .order("deleted_at", { ascending: false })
    .limit(100);
  if (error) { console.error("fetchDeletedLoads:", error); return []; }
  const rows = (data ?? []) as Array<{
    id: string; title: string; load_num: string | null; broker: string | null;
    start: string; end: string; asset_id: number; driver_name: string | null;
    deleted_at: string;
  }>;
  if (rows.length === 0) return [];
  // Resolve asset names in one query.
  const assetIds = Array.from(new Set(rows.map((r) => r.asset_id)));
  const ar = await supabase.from("assets").select("id,name,unit").in("id", assetIds).eq("org_id", orgId);
  const assetMap = new Map<number, string>();
  for (const a of ((ar.data ?? []) as Array<{ id: number; name: string; unit: string | null }>)) {
    assetMap.set(a.id, `${a.name}${a.unit ? ` #${a.unit}` : ""}`);
  }
  return rows.map((r) => ({
    id:         r.id,
    title:      r.title,
    loadNum:    r.load_num ?? undefined,
    broker:     r.broker ?? undefined,
    start:      r.start,
    end:        r.end,
    assetName:  assetMap.get(r.asset_id),
    driverName: r.driver_name ?? undefined,
    deletedAt:  r.deleted_at,
  }));
}

/**
 * Undo a relay split. Must be called from the pickup-leg event id.
 * - Merges stops back (drops the relay-type stop)
 * - Pickup leg keeps its id, end = delivery.end, relay fields cleared
 * - Delivery leg is soft-deleted (deleted_at = now)
 */
export async function removeRelay(pickupEventId: string, orgId: string): Promise<void> {
  const cur = await supabase.from("events").select("id,relay_group_id,relay_role,end").eq("id", pickupEventId).eq("org_id", orgId).single();
  if (cur.error || !cur.data) throw new Error(cur.error?.message ?? "Pickup leg not found");
  const pickupRow = cur.data as { id: string; relay_group_id: string | null; relay_role: string | null; end: string };
  if (!pickupRow.relay_group_id) throw new Error("Not part of a relay");
  if (pickupRow.relay_role !== "pickup") throw new Error("Call removeRelay from the pickup leg");

  const partner = await supabase.from("events").select("id,end").eq("relay_group_id", pickupRow.relay_group_id).eq("org_id", orgId).neq("id", pickupEventId).maybeSingle();
  if (partner.error) throw new Error(partner.error.message);
  if (!partner.data) throw new Error("Delivery partner not found");
  const partnerRow = partner.data as { id: string; end: string };

  // Merge stops: take pickup's stops, drop the relay marker.
  const stopsRes = await supabase.from("stops").select("*").eq("event_id", pickupEventId).eq("org_id", orgId).order("sequence");
  if (stopsRes.error) throw new Error(stopsRes.error.message);
  const merged: Stop[] = ((stopsRes.data ?? []) as Array<{
    id: string; sequence: number; type: string; facility_name: string | null; address: string | null;
    city: string | null; timezone: string | null; appt_start: string | null; appt_end: string | null;
    lat: number | null; lng: number | null; instructions: string | null;
    arrived_at: string | null; arrived_lat: number | null; arrived_lng: number | null;
  }>)
    .filter((r) => r.type !== "relay")
    .map((r) => ({
      id:           r.id,
      sequence:     r.sequence,
      type:         r.type as Stop["type"],
      facilityName: r.facility_name ?? undefined,
      address:      r.address       ?? undefined,
      city:         r.city          ?? undefined,
      timezone:     r.timezone      ?? undefined,
      apptStart:    r.appt_start    ?? undefined,
      apptEnd:      r.appt_end      ?? undefined,
      lat:          r.lat           ?? undefined,
      lng:          r.lng           ?? undefined,
      instructions: r.instructions  ?? undefined,
      arrivedAt:    r.arrived_at    ?? undefined,
      arrivedLat:   r.arrived_lat   ?? undefined,
      arrivedLng:   r.arrived_lng   ?? undefined,
    }));

  const upd = await supabase.from("events").update({
    end:            partnerRow.end,
    relay_group_id: null,
    relay_role:     null,
  }).eq("id", pickupEventId).eq("org_id", orgId);
  if (upd.error) throw new Error(`Couldn't clear pickup leg: ${upd.error.message}`);

  const del = await supabase.from("events").update({
    deleted_at: new Date().toISOString(),
  }).eq("id", partnerRow.id).eq("org_id", orgId);
  if (del.error) throw new Error(`Couldn't remove delivery leg: ${del.error.message}`);

  await saveStops(pickupEventId, orgId, merged);
}

export interface RecentStop {
  facilityName?: string;
  address?:      string;
  city?:         string;
  lat?:          number;
  lng?:          number;
  timezone?:     string;
}

/**
 * Returns recently-used distinct facility/address combos from the org's stops
 * history. Ordered by recency, deduped by (facility_name, address). Useful as
 * a third source of suggestions alongside saved_locations and Google Places.
 */
export async function fetchRecentStops(
  orgId: string,
  query: string,
  limit = 8,
): Promise<RecentStop[]> {
  const q = query.trim();
  if (!q) return [];
  // Pull a generous batch and dedupe in JS — Supabase JS client doesn't support
  // distinct/GROUP BY directly, so this is the simplest path.
  const { data, error } = await supabase
    .from("stops")
    .select("facility_name,address,city,lat,lng,timezone,created_at")
    .eq("org_id", orgId)
    .or(`facility_name.ilike.%${q}%,address.ilike.%${q}%`)
    .order("created_at", { ascending: false })
    .limit(80);
  if (error) { console.warn("fetchRecentStops:", error.message); return []; }
  const seen = new Set<string>();
  const out: RecentStop[] = [];
  for (const r of (data ?? []) as Array<{
    facility_name: string | null; address: string | null; city: string | null;
    lat: number | null; lng: number | null; timezone: string | null;
  }>) {
    const key = `${(r.facility_name ?? "").toLowerCase()}|${(r.address ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      facilityName: r.facility_name ?? undefined,
      address:      r.address       ?? undefined,
      city:         r.city          ?? undefined,
      lat:          r.lat           ?? undefined,
      lng:          r.lng           ?? undefined,
      timezone:     r.timezone      ?? undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SavedLocation {
  id:        string;
  name:      string;
  address?:  string;
  lat?:      number;
  lng?:      number;
  timezone?: string;
}

export async function fetchSavedLocations(orgId: string): Promise<SavedLocation[]> {
  const { data, error } = await supabase
    .from("saved_locations")
    .select("id,name,address,lat,lng,timezone")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (error) { console.error("fetchSavedLocations:", error); return []; }
  return ((data ?? []) as Array<{
    id: string; name: string; address: string | null;
    lat: number | null; lng: number | null; timezone: string | null;
  }>).map((r) => ({
    id:       r.id,
    name:     r.name,
    address:  r.address ?? undefined,
    lat:      r.lat ?? undefined,
    lng:      r.lng ?? undefined,
    timezone: r.timezone ?? undefined,
  }));
}

export interface PlaceSuggestion {
  placeId:     string;
  description: string;
}
export interface PlaceDetails {
  address:   string;
  lat:       number;
  lng:       number;
  timezone?: string;
}

/** Calls dispatch-next /api/places (Google Places Autocomplete proxy). */
export async function placesAutocomplete(
  getToken: () => Promise<string | null>,
  input: string,
): Promise<PlaceSuggestion[]> {
  const baseUrl = (await import("./env")).env.dispatchApiUrl;
  if (!baseUrl || !input.trim()) return [];
  try {
    const token = await getToken();
    const res = await fetch(`${baseUrl}/api/places?input=${encodeURIComponent(input)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { suggestions?: { place_id: string; description: string }[] };
    return (json.suggestions ?? []).map((s) => ({ placeId: s.place_id, description: s.description }));
  } catch (err) {
    console.warn("placesAutocomplete:", err);
    return [];
  }
}

/** Resolve a Google place_id to its formatted address + coords + timezone. */
export async function placeDetails(
  getToken: () => Promise<string | null>,
  placeId: string,
): Promise<PlaceDetails | null> {
  const baseUrl = (await import("./env")).env.dispatchApiUrl;
  if (!baseUrl) return null;
  try {
    const token = await getToken();
    const res = await fetch(`${baseUrl}/api/places?place_id=${encodeURIComponent(placeId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: PlaceDetails | null };
    return json.result ?? null;
  } catch (err) {
    console.warn("placeDetails:", err);
    return null;
  }
}

export async function fetchAssets(orgId: string): Promise<Asset[]> {
  const { data, error } = await supabase
    .from("assets")
    .select("id,name,type,unit,color,hidden,sort_order,motive_vehicle_id")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("fetchAssets:", error);
    return [];
  }
  return ((data ?? []) as DbAssetRow[]).map((r) => ({
    id:              r.id,
    name:            r.name,
    type:            r.type,
    unit:            r.unit ?? undefined,
    color:           r.color,
    hidden:          !!r.hidden,
    sortOrder:       r.sort_order,
    motiveVehicleId: r.motive_vehicle_id ?? undefined,
  }));
}

export async function fetchLoadsForDay(orgId: string, dateKey: string): Promise<Load[]> {
  const dayStart = `${dateKey}T00:00`;
  const dayEnd   = `${dateKey}T23:59`;

  // Joined fetch: each event row comes back with its load row nested as
  // `.load` (or null for non-revenue events).
  const { data: events, error } = await supabase
    .from("events")
    .select(`${EVENT_COLS_NEW}, load:loads(${LOAD_COLS_NEW})`)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .lte("start", dayEnd)
    .gte("end", dayStart)
    .order("start", { ascending: true });
  if (error) {
    console.error("fetchLoadsForDay:", error);
    return [];
  }
  // PostgREST returns the nested `load` as an array even for many-to-one
  // relationships. Unwrap to a single object (or null) for the converter.
  type RowWithLoad = Record<string, unknown> & { load: Record<string, unknown> | null };
  const rows: RowWithLoad[] = (events ?? []).map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const load = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    return { ...ev, load };
  });
  if (rows.length === 0) return [];

  const eventIds = rows.map((r) => r.id as string);
  const assetIds = Array.from(new Set(rows.map((r) => r.asset_id as number)));

  const [stopsRes, assetsRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit").in("id", assetIds),
  ]);

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as DbStopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }

  const assetsById = new Map<number, { name: string; unit: string | null }>();
  for (const a of (assetsRes.data ?? []) as { id: number; name: string; unit: string | null }[]) {
    assetsById.set(a.id, a);
  }

  return rows.map((r): Load => {
    const load = joinEventLoadToApp(r, r.load);
    const asset = assetsById.get(load.assetId);
    return {
      ...load,
      assetName: asset ? `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}` : undefined,
      stops: (stopsByEvent.get(r.id as string) ?? []).sort((a, b) => a.sequence - b.sequence),
    };
  });
}

/**
 * For each asset, return the load it's currently working — the most recent
 * event with status in (dispatched, en_route, picked_up). Keyed by asset_id.
 */
export async function fetchActiveLoadsByAsset(orgId: string): Promise<Map<number, Load>> {
  const { data: events, error } = await supabase
    .from("events")
    .select(EVENT_LIST_COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .in("status", ["dispatched", "en_route", "picked_up"])
    .order("start", { ascending: false });
  if (error) {
    console.error("fetchActiveLoadsByAsset:", error);
    return new Map();
  }
  const rows = (events ?? []) as DbEventRow[];
  if (rows.length === 0) return new Map();

  // Pick the latest in-progress event per asset (rows already sorted by start desc)
  const seen = new Set<number>();
  const picked: DbEventRow[] = [];
  for (const r of rows) {
    if (seen.has(r.asset_id)) continue;
    seen.add(r.asset_id);
    picked.push(r);
  }

  const eventIds = picked.map((r) => r.id);
  const assetIds = Array.from(seen);
  const [stopsRes, assetsRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit").in("id", assetIds),
  ]);
  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as DbStopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }
  const assetsById = new Map<number, { name: string; unit: string | null }>();
  for (const a of (assetsRes.data ?? []) as { id: number; name: string; unit: string | null }[]) {
    assetsById.set(a.id, a);
  }

  const map = new Map<number, Load>();
  for (const r of picked) {
    const asset = assetsById.get(r.asset_id);
    map.set(r.asset_id, {
      id:              r.id,
      internalLoadId:  r.internal_load_id ?? undefined,
      loadNum:         r.load_num ?? undefined,
      title:        r.title,
      start:        r.start,
      end:          r.end,
      status:       (r.status as LoadStatus) ?? "scheduled",
      broker:       r.broker        ?? undefined,
      trailerType:  r.trailer_type  ?? undefined,
      driverPay:    r.driver_pay    ?? undefined,
      notes:        r.notes         ?? undefined,
      specialInstructions: r.special_instructions ?? undefined,
      assetId:      r.asset_id,
      assetName:    asset ? `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}` : undefined,
      driverId:     r.driver_id ?? undefined,
      driverName:   r.driver_name ?? undefined,
      stops:        (stopsByEvent.get(r.id) ?? []).sort((a, b) => a.sequence - b.sequence),
    });
  }
  return map;
}

/**
 * Search loads across all dates by load #, title, broker, or driver name.
 * Returns recent matches first (newest start date). Capped to 50 results.
 */
export async function searchLoads(orgId: string, query: string): Promise<Load[]> {
  const q = query.trim();
  if (!q) return [];
  // Escape postgrest special chars in the pattern.
  const safe = q.replace(/[%,()]/g, "\\$&");
  const pattern = `%${safe}%`;

  const numericId = /^\d+$/.test(q) ? parseInt(q, 10) : null;
  const orFilter = numericId !== null
    ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},title.ilike.${pattern},broker.ilike.${pattern},driver_name.ilike.${pattern}`
    : `load_num.ilike.${pattern},title.ilike.${pattern},broker.ilike.${pattern},driver_name.ilike.${pattern}`;

  const { data: events, error } = await supabase
    .from("events")
    .select(EVENT_LIST_COLS)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(orFilter)
    .order("start", { ascending: false })
    .limit(50);
  if (error) {
    console.error("searchLoads:", error);
    return [];
  }
  const rows = (events ?? []) as DbEventRow[];
  if (rows.length === 0) return [];

  const eventIds = rows.map((r) => r.id);
  const assetIds = Array.from(new Set(rows.map((r) => r.asset_id)));

  const [stopsRes, assetsRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit").in("id", assetIds),
  ]);

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as DbStopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }

  const assetsById = new Map<number, { name: string; unit: string | null }>();
  for (const a of (assetsRes.data ?? []) as { id: number; name: string; unit: string | null }[]) {
    assetsById.set(a.id, a);
  }

  return rows.map((r): Load => {
    const asset = assetsById.get(r.asset_id);
    return {
      id:              r.id,
      internalLoadId:  r.internal_load_id ?? undefined,
      loadNum:         r.load_num ?? undefined,
      title:           r.title,
      start:           r.start,
      end:             r.end,
      status:          (r.status as LoadStatus) ?? "scheduled",
      broker:          r.broker        ?? undefined,
      trailerType:  r.trailer_type  ?? undefined,
      driverPay:    r.driver_pay    ?? undefined,
      notes:        r.notes         ?? undefined,
      specialInstructions: r.special_instructions ?? undefined,
      assetId:      r.asset_id,
      assetName:    asset ? `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}` : undefined,
      driverId:     r.driver_id ?? undefined,
      driverName:   r.driver_name ?? undefined,
      stops:        (stopsByEvent.get(r.id) ?? []).sort((a, b) => a.sequence - b.sequence),
    };
  });
}

interface DbTrailerRow {
  id:             number;
  name:           string;
  trailer_number: string | null;
}

export async function fetchLoad(id: string, orgId: string): Promise<Load | null> {
  const { data, error } = await supabase
    .from("events")
    .select(EVENT_FULL_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("fetchLoad:", error);
    return null;
  }
  const r = data as DbEventRow;

  const [stopsRes, assetRes, trailerRes, driverRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).eq("event_id", id).eq("org_id", orgId),
    supabase.from("assets").select("id,name,unit,motive_vehicle_id").eq("id", r.asset_id).maybeSingle(),
    r.trailer_id != null
      ? supabase.from("trailers").select("id,name,trailer_number").eq("id", r.trailer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    r.driver_id != null
      ? supabase.from("drivers").select("id,phone").eq("id", r.driver_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const stops: Stop[] = ((stopsRes.data ?? []) as DbStopRow[])
    .map(rowToStop)
    .sort((a, b) => a.sequence - b.sequence);

  const asset   = assetRes.data   as { id: number; name: string; unit: string | null; motive_vehicle_id: string | null } | null;
  const trailer = trailerRes.data as DbTrailerRow | null;
  const driver  = driverRes.data  as { id: number; phone: string | null } | null;

  // Relay partner — fetch the other event in the same relay_group_id
  let partnerEventId:    string | undefined;
  let partnerStops:      Stop[] | undefined;
  let partnerDriverName: string | undefined;
  let partnerAssetName:  string | undefined;
  if (r.relay_group_id) {
    const { data: partnerRow } = await supabase
      .from("events")
      .select("id,asset_id,driver_name")
      .eq("relay_group_id", r.relay_group_id)
      .eq("org_id", orgId)
      .neq("id", r.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (partnerRow) {
      const pr = partnerRow as { id: string; asset_id: number; driver_name: string | null };
      partnerEventId    = pr.id;
      partnerDriverName = pr.driver_name ?? undefined;
      const [pStopsRes, pAssetRes] = await Promise.all([
        supabase.from("stops").select(STOP_COLS).eq("event_id", pr.id).eq("org_id", orgId),
        supabase.from("assets").select("id,name,unit").eq("id", pr.asset_id).maybeSingle(),
      ]);
      partnerStops = ((pStopsRes.data ?? []) as DbStopRow[])
        .map(rowToStop)
        .sort((a, b) => a.sequence - b.sequence);
      const pAsset = pAssetRes.data as { id: number; name: string; unit: string | null } | null;
      partnerAssetName = pAsset ? `${pAsset.name}${pAsset.unit ? ` #${pAsset.unit}` : ""}` : undefined;
    }
  }

  return {
    id:              r.id,
    internalLoadId:  r.internal_load_id ?? undefined,
    loadNum:         r.load_num ?? undefined,
    title:           r.title,
    start:           r.start,
    end:             r.end,
    status:          (r.status as LoadStatus) ?? "scheduled",

    driverId:     r.driver_id ?? undefined,
    driverName:   r.driver_name ?? undefined,
    driverPhone:  driver?.phone ?? undefined,
    dispatcher:   r.dispatcher ?? undefined,
    createdByName: r.created_by_name ?? undefined,

    assetId:          r.asset_id,
    assetName:        asset ? `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}` : undefined,
    motiveVehicleId:  asset?.motive_vehicle_id ?? undefined,
    trailerId:    r.trailer_id ?? undefined,
    trailerNum:   trailer
      ? `${trailer.trailer_number ?? trailer.name}`
      : undefined,
    trailerType:  r.trailer_type ?? undefined,

    refNums:      parseRefNums(r.ref_nums),

    broker:       r.broker    ?? undefined,

    loadPrice:    r.load_price ?? undefined,
    driverPay:    r.driver_pay ?? undefined,

    notes:                r.notes                ?? undefined,
    specialInstructions:  r.special_instructions ?? undefined,
    accessorials:         parseAccessorials(r.accessorials),
    rateConPdf:           r.rate_con_pdf         ?? undefined,

    relayGroupId: r.relay_group_id ?? undefined,
    relayRole:    (r.relay_role as "pickup" | "delivery" | null) ?? undefined,
    partnerEventId,
    partnerStops,
    partnerDriverName,
    partnerAssetName,

    stops,
  };
}

// ── Documents ─────────────────────────────────────────────────────────────────

export type DocumentKind = "bol" | "pod" | "scale" | "other";

export interface LoadDocument {
  id:          string;
  eventId:     string;
  storagePath: string;
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  kind:        DocumentKind;
  uploadedAt:  string;
  notes?:      string;
}

interface DbDocRow {
  id: string; event_id: string; storage_path: string; file_name: string;
  mime_type: string | null; size_bytes: number | null; kind: string;
  uploaded_at: string; notes: string | null;
}

export async function fetchDocuments(eventId: string, orgId: string): Promise<LoadDocument[]> {
  const { data, error } = await supabase
    .from("load_documents")
    .select("id,event_id,storage_path,file_name,mime_type,size_bytes,kind,uploaded_at,notes")
    .eq("event_id", eventId)
    .eq("org_id",   orgId)
    .order("uploaded_at", { ascending: false });
  if (error) {
    if (error.code !== "42P01") console.error("fetchDocuments:", error);
    return [];
  }
  return ((data ?? []) as DbDocRow[]).map((r) => ({
    id:          r.id,
    eventId:     r.event_id,
    storagePath: r.storage_path,
    fileName:    r.file_name,
    mimeType:    r.mime_type ?? undefined,
    sizeBytes:   r.size_bytes ?? undefined,
    kind:        (r.kind as DocumentKind) ?? "other",
    uploadedAt:  r.uploaded_at,
    notes:       r.notes ?? undefined,
  }));
}

export type TrailerCategory = "Swing" | "Roll Up" | "Flat Bed" | "Other";

export interface Trailer {
  id:             number;
  name:           string;
  trailerNumber?: string;
  category:       TrailerCategory;
}

export async function fetchTrailers(orgId: string): Promise<Trailer[]> {
  const { data, error } = await supabase
    .from("trailers")
    .select("id,name,trailer_number,category,sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) { console.error("fetchTrailers:", error); return []; }
  return (data ?? []).map((t) => ({
    id:            t.id as number,
    name:          t.name as string,
    trailerNumber: (t.trailer_number as string | null) ?? undefined,
    category:      t.category as TrailerCategory,
  }));
}

export async function updateLoadTrailer(id: string, orgId: string, trailerId: number | null): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update({ trailer_id: trailerId })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("updateLoadTrailer:", error);
    throw error;
  }
}

/**
 * Partial event update. Caller passes the snake_case columns to change.
 * Validated server-side; we don't whitelist here.
 */
export async function updateLoadFields(
  id:    string,
  orgId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update(fields)
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("updateLoadFields:", error);
    throw error;
  }
}

export async function updateLoadStatus(id: string, orgId: string, status: LoadStatus): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update({ status })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("updateLoadStatus:", error);
    throw error;
  }
}

export async function getDocumentSignedUrl(storagePath: string, expiresInSec = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from("load-documents").createSignedUrl(storagePath, expiresInSec);
  if (error) { console.error("getDocumentSignedUrl:", error); return null; }
  return data?.signedUrl ?? null;
}

export async function getRateConSignedUrl(storagePath: string, expiresInSec = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from("rate-cons").createSignedUrl(storagePath, expiresInSec);
  if (error) { console.error("getRateConSignedUrl:", error); return null; }
  return data?.signedUrl ?? null;
}

// ── Create new load + upload rate con PDF ─────────────────────────────────────

export async function uploadRateConPdf(args: {
  orgId:    string;
  base64:   string;
  fileName: string;
}): Promise<string | null> {
  const ts   = Date.now();
  const safe = args.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${args.orgId}/${ts}_${safe}`;
  const bytes = decodeBase64ToUint8(args.base64);
  const { error } = await supabase.storage.from("rate-cons").upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (error) { console.error("uploadRateConPdf:", error); return null; }
  return path;
}

function decodeBase64ToUint8(b64: string): Uint8Array {
  // RN doesn't have atob in older runtimes; modern Hermes does. Fall back manually if needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = global as any;
  if (typeof g.atob === "function") {
    const bin = g.atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const len = clean.length;
  const placeholders = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const arrLen = (len * 3) / 4 - placeholders;
  const arr = new Uint8Array(arrLen);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = lookup[clean.charCodeAt(i + 1)];
    const c = lookup[clean.charCodeAt(i + 2)];
    const d = lookup[clean.charCodeAt(i + 3)];
    if (p < arrLen) arr[p++] = (a << 2) | (b >> 4);
    if (p < arrLen) arr[p++] = ((b & 15) << 4) | (c >> 2);
    if (p < arrLen) arr[p++] = ((c & 3) << 6) | d;
  }
  return arr;
}

export interface NewLoadInput {
  orgId:        string;
  assetId:      number;
  title:        string;
  start:        string;          // YYYY-MM-DDTHH:mm naive MT
  end:          string;
  loadNum?:     string;
  broker?:      string;
  driverName?:  string;
  driverId?:    number | null;
  notes?:       string;
  specialInstructions?: string;
  refNums?:     RefNum[];
  loadPrice?:   number;
  driverPay?:   number;
  rateConPdf?:  string;          // storage path
  createdByName?: string;
}

export async function createLoad(input: NewLoadInput): Promise<string | null> {
  const { data, error } = await supabase
    .from("events")
    .insert({
      org_id:               input.orgId,
      asset_id:             input.assetId,
      title:                input.title,
      start:                input.start,
      end:                  input.end,
      status:               "scheduled",
      load_num:             input.loadNum ?? null,
      broker:               input.broker  ?? null,
      driver_id:            input.driverId ?? null,
      driver_name:          input.driverName ?? null,
      notes:                input.notes ?? null,
      special_instructions: input.specialInstructions ?? null,
      ref_nums:             input.refNums ? JSON.stringify(input.refNums) : null,
      load_price:           input.loadPrice ?? null,
      driver_pay:           input.driverPay ?? null,
      rate_con_pdf:         input.rateConPdf ?? null,
      created_by_name:      input.createdByName ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("createLoad:", error);
    throw error;
  }
  return (data as { id: string } | null)?.id ?? null;
}

export interface ParsedRateCon {
  title?:     string;
  loadNum?:   string;
  broker?:    string;
  start?:     string;
  end?:       string;
  refNums?:   RefNum[];
  loadPrice?: number;
  driverPay?: number;
  notes?:     string;
  specialInstructions?: string;
  stops?: {
    sequence?:    number;
    type?:        StopType;
    facilityName?: string;
    address?:     string;
    city?:        string;
    apptStart?:   string;
    apptEnd?:     string;
    instructions?: string;
  }[];
}

export async function parseRateConViaApi(
  base64: string,
  getToken: () => Promise<string | null>,
): Promise<ParsedRateCon | null> {
  // Re-uses the existing dispatch-next /api/parse-ratecon endpoint.
  // Configure dispatchApiUrl in app.json `extra`.
  const baseUrl = (await import("./env")).env.dispatchApiUrl;
  if (!baseUrl) {
    throw new Error("dispatchApiUrl not configured in app.json");
  }
  const token = await getToken();
  const res = await fetch(`${baseUrl}/api/parse-ratecon`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ data: base64 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`parse-ratecon failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as ParsedRateCon;
  return json;
}
