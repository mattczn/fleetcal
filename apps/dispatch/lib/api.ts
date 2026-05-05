import { supabase } from "./supabase";
import { railway } from "./railway";
import type { Asset, Driver, Load, LoadStatus, RefNum, Stop, StopType, Customer as ApiCustomer } from "./types";
// All reads + writes go through Railway. The only remaining direct
// Supabase usage is the rate-con PDF upload (uploadRateConPdf), which
// writes to Storage. Realtime subscriptions also use the Supabase client,
// but those live in the load-detail screen, not here.

/**
 * Returns the preferred driver_id keyed by asset_id for this org.
 * (Schema enforces one preferred driver per asset.)
 *
 * `orgId` is unused — kept in the signature for caller compatibility; the
 * Railway endpoint reads it from the JWT.
 */
/**
 * Map<assetId, driverId> shape used to be a real `Map` here, but the
 * React Query AsyncStorage persister round-trips through JSON.stringify
 * which silently turns a Map into `{}` on the way back. Use a plain
 * record so it survives persistence.
 */
export async function fetchDriverAssetPrefs(_orgId: string): Promise<Record<number, number>> {
  try {
    const { prefs } = await railway.listDriverAssetPrefs();
    const out: Record<number, number> = {};
    for (const p of prefs) out[p.assetId] = p.driverId;
    return out;
  } catch (err) {
    console.error("fetchDriverAssetPrefs:", err);
    return {};
  }
}

export async function fetchDrivers(_orgId: string): Promise<Driver[]> {
  try {
    const { drivers } = await railway.listDrivers();
    return drivers;
  } catch (err) {
    console.error("fetchDrivers:", err);
    return [];
  }
}

/**
 * Backwards-compat type — historically the dispatch app exported a slimmer
 * Customer shape. The shared @fleetcal/types Customer is a superset, so we
 * just re-export it under the same name.
 */
export type Customer = ApiCustomer;

export async function fetchCustomers(_orgId: string): Promise<Customer[]> {
  try {
    const { customers } = await railway.listCustomers();
    return customers;
  } catch (err) {
    console.error("fetchCustomers:", err);
    return [];
  }
}

/**
 * Replace all stops for an event. Server-side handles the delete+insert
 * transactionally and rewrites sequence numbers from array order.
 */
export async function saveStops(eventId: string, _orgId: string, stops: Stop[]): Promise<void> {
  await railway.replaceStops(eventId, { stops });
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

export interface SplitRelayOptions {
  eventId:            string;
  orgId:              string;
  pickupEnd:          string; // YYYY-MM-DDTHH:mm — when Driver 1 drops at relay
  deliveryStart:      string;
  deliveryEnd:        string;
  deliveryAssetId:    number;
  deliveryDriverId?:  number | null;
  deliveryDriverName?: string | null;
  /** Full ordered stops list including the relay-type stop. */
  mergedStops:        Stop[];
}

/**
 * Convert this single-event load into a relay pair via POST /v1/loads/:id/split-relay.
 * Returns the new delivery-leg event id.
 */
export async function splitIntoRelay(opts: SplitRelayOptions): Promise<string> {
  const { loads } = await railway.getEvent(opts.eventId);
  const self = loads.find(l => l.id === opts.eventId) ?? loads[0];
  if (!self?.loadId) throw new Error("Cannot split: event has no loadId");

  const relayStopIndex = opts.mergedStops.findIndex(s => s.type === "relay");
  if (relayStopIndex < 0) throw new Error("mergedStops must include a stop with type='relay'");

  const res = await railway.splitRelay(self.loadId, {
    pickupEnd:          opts.pickupEnd,
    deliveryStart:      opts.deliveryStart,
    deliveryEnd:        opts.deliveryEnd,
    deliveryAssetId:    opts.deliveryAssetId,
    deliveryDriverId:   opts.deliveryDriverId ?? null,
    deliveryDriverName: opts.deliveryDriverName ?? null,
    mergedStops:        opts.mergedStops,
    relayStopIndex,
  });
  const delivery = res.loads.find(l => l.relayRole === "delivery");
  if (!delivery) throw new Error("Server didn't return a delivery leg");
  return delivery.id;
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
 * Soft-delete a load. The dispatch UI passes an event id, but the API soft-
 * delete operates on loadId, so resolve once first. For non-revenue events
 * (no loadId), there's no soft-delete endpoint — fall back to event delete.
 */
export async function softDeleteLoad(id: string, _orgId: string): Promise<void> {
  const { loads } = await railway.getEvent(id);
  const self = loads.find(l => l.id === id) ?? loads[0];
  if (self?.loadId) {
    await railway.deleteLoad(self.loadId);
  } else {
    await railway.deleteEvent(id);
  }
}

export async function restoreLoad(id: string, _orgId: string): Promise<void> {
  // Restore needs loadId; for non-revenue events, deleteEvent above wasn't
  // reached so this should always resolve via the event row even when soft-
  // deleted (the API's GET event-by-id excludes soft-deleted rows so we
  // can't fetch then). Cleaner path: call the existing soft-delete listing
  // to find the load id, but for v1 the dispatch trash screen passes the
  // event id which we treat as loadId fallback if direct lookup fails.
  try {
    const { loads } = await railway.getEvent(id);
    const self = loads.find(l => l.id === id) ?? loads[0];
    if (self?.loadId) { await railway.restoreLoad(self.loadId); return; }
  } catch { /* event likely soft-deleted — try direct */ }
  // Fallback: assume the id passed IS the loadId (legacy callers).
  await railway.restoreLoad(id);
}

// Hard-delete is web-only. Mobile dispatchers restore from trash; expired
// soft-deletes are purged via the web or a future scheduled job.

/**
 * Recently deleted loads for this org, newest first. Filters to last `days` days.
 */
export async function fetchDeletedLoads(_orgId: string, days = 30): Promise<DeletedLoadRow[]> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    const { loads } = await railway.listLoads({
      from:           fmt(cutoff),
      to:             fmt(new Date()),
      includeDeleted: "true",
    });
    return loads
      .filter(l => l.deletedAt)
      .sort((a, b) => (b.deletedAt ?? "") > (a.deletedAt ?? "") ? 1 : -1)
      .slice(0, 100)
      .map(l => ({
        id:         l.id,
        title:      l.title,
        loadNum:    l.loadNum,
        broker:     l.broker,
        start:      l.start,
        end:        l.end,
        assetName:  l.assetName,
        driverName: l.driverName,
        deletedAt:  l.deletedAt!,
      }));
  } catch (err) {
    console.error("fetchDeletedLoads:", err);
    return [];
  }
}

/**
 * Undo a relay split via POST /v1/loads/:id/unsplit-relay. Must be called
 * from the pickup-leg event id; the server merges stops, keeps the pickup,
 * soft-deletes the delivery leg.
 */
export async function removeRelay(pickupEventId: string, _orgId: string): Promise<void> {
  const { loads } = await railway.getEvent(pickupEventId);
  const self = loads.find(l => l.id === pickupEventId) ?? loads[0];
  if (!self?.loadId) throw new Error("Cannot unsplit: event has no loadId");
  if (self.relayRole !== "pickup") throw new Error("Call removeRelay from the pickup leg");
  await railway.unsplitRelay(self.loadId, { keepEventId: pickupEventId });
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
 * history. Ordered by recency, deduped server-side by (facility_name, address).
 */
export async function fetchRecentStops(
  _orgId: string,
  query: string,
  limit = 8,
): Promise<RecentStop[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const { recentStops } = await railway.listRecentStops({ q, limit });
    return recentStops;
  } catch (err) {
    console.warn("fetchRecentStops:", err);
    return [];
  }
}

export interface SavedLocation {
  id:        string;
  name:      string;
  address?:  string;
  lat?:      number;
  lng?:      number;
  timezone?: string;
}

export async function fetchSavedLocations(_orgId: string): Promise<SavedLocation[]> {
  try {
    const { locations } = await railway.listSavedLocations();
    return locations;
  } catch (err) {
    console.error("fetchSavedLocations:", err);
    return [];
  }
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

export async function fetchAssets(_orgId: string): Promise<Asset[]> {
  try {
    const { assets } = await railway.listAssets();
    return assets;
  } catch (err) {
    console.error("fetchAssets:", err);
    return [];
  }
}

/**
 * Loads whose start/end overlaps the given local date. The Railway endpoint
 * uses naive start/end strings so YYYY-MM-DDTHH:mm bounds match the same
 * semantics as the previous direct query.
 */
export async function fetchLoadsForDay(_orgId: string, dateKey: string): Promise<Load[]> {
  try {
    const { loads } = await railway.listLoads({
      from: `${dateKey}T00:00`,
      to:   `${dateKey}T23:59`,
    });
    // listLoads already sorts and excludes soft-deleted by default.
    return loads;
  } catch (err) {
    console.error("fetchLoadsForDay:", err);
    return [];
  }
}

// fetchActiveLoadsByAsset removed — the map view now derives in-transit
// loads inline by clock time (pickup ≤ now ≤ delivery), not by status.

/**
 * Search loads across all dates by load #, title, broker, or driver name.
 * Returns recent matches first (newest start date). Capped server-side at 50.
 */
export async function searchLoads(_orgId: string, query: string): Promise<Load[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const { loads } = await railway.searchLoads(q, 50);
    return loads;
  } catch (err) {
    console.error("searchLoads:", err);
    return [];
  }
}

export async function fetchLoad(id: string, _orgId: string): Promise<Load | null> {
  try {
    const { loads } = await railway.getEvent(id);
    if (loads.length === 0) return null;
    const self = loads.find(l => l.id === id) ?? loads[0];
    const partner = loads.find(l => l.id !== self.id);

    if (!partner) return self;

    // Pull the partner-derived fields onto the returned Load so existing UI
    // code (that reads load.partnerStops, load.partnerDriverName, etc.) keeps
    // working without changes.
    return {
      ...self,
      partnerEventId:    partner.id,
      partnerStops:      partner.stops,
      partnerDriverName: partner.driverName,
      partnerAssetName:  partner.assetName,
    } as Load;
  } catch (err) {
    console.error("fetchLoad:", err);
    return null;
  }
}

// ── Documents ─────────────────────────────────────────────────────────────────

export type DocumentKind = "bol" | "pod" | "scale" | "other";

export interface LoadDocument {
  id:          string;
  eventId:     string;
  fileName:    string;
  mimeType?:   string;
  sizeBytes?:  number;
  kind:        DocumentKind;
  uploadedAt:  string;
  notes?:      string;
}

/**
 * List documents for the load this event belongs to. Returns [] for non-
 * revenue events (no parent load). Use `railway.getDocumentUrl(doc.id)` to
 * resolve a signed URL when you need to view/download.
 */
export async function fetchDocuments(eventId: string, _orgId: string): Promise<LoadDocument[]> {
  try {
    const { loads } = await railway.getEvent(eventId);
    const loadId = loads.find(l => l.id === eventId)?.loadId ?? loads[0]?.loadId;
    if (!loadId) return [];
    const { documents } = await railway.listLoadDocuments(loadId);
    return documents.map((d) => ({
      id:         d.id,
      eventId,
      fileName:   d.fileName,
      mimeType:   d.mimeType,
      sizeBytes:  d.sizeBytes,
      kind:       d.kind as DocumentKind,
      uploadedAt: d.uploadedAt,
      notes:      undefined, // DocumentSummary doesn't expose notes; rare anyway
    }));
  } catch (err) {
    console.error("fetchDocuments:", err);
    return [];
  }
}

export type TrailerCategory = "Swing" | "Roll Up" | "Flat Bed" | "Other";

export interface Trailer {
  id:             number;
  name:           string;
  trailerNumber?: string;
  category:       TrailerCategory;
}

export async function fetchTrailers(_orgId: string): Promise<Trailer[]> {
  try {
    const { trailers } = await railway.listTrailers();
    return trailers.map(t => ({
      id:            t.id,
      name:          t.name,
      trailerNumber: t.trailerNumber,
      category:      t.category as TrailerCategory,
    }));
  } catch (err) {
    console.error("fetchTrailers:", err);
    return [];
  }
}

export async function updateLoadTrailer(id: string, _orgId: string, trailerId: number | null): Promise<void> {
  await railway.updateEvent(id, { trailerId });
}

// snake_case → camelCase, scoped by which row the field lives on after 2.5c.
// Anything not listed below is ignored.
const EVENT_FIELD_MAP: Record<string, string> = {
  asset_id:      "assetId",
  driver_id:     "driverId",
  driver_name:   "driverName",
  driver_pay:    "driverPay",
  trailer_id:    "trailerId",
  trailer_type:  "trailerType",
  start:         "start",
  end:           "end",
  status:        "status",
  priority:      "priority",
  title:         "title",
};
const LOAD_FIELD_MAP: Record<string, string> = {
  load_num:      "loadNum",
  broker:        "broker",
  load_price:    "loadPrice",
  dispatcher:    "dispatcher",
  notes:         "notes",
  accessorials:  "accessorials",
  ref_nums:      "refNums",
  customer_id:   "customerId",
  commodity:     "commodity",
  weight:        "weight",
  internal_note: "internalNote",
  rate_con_pdf:  "rateConPdf",
};

/**
 * Partial event update. Caller passes the snake_case columns to change;
 * we map them to the API's camelCase request shape and dispatch to the
 * right endpoint(s). Load-level changes need the parent loadId; we fetch
 * it once when needed.
 *
 * `special_instructions` is legacy (pre-2.5c). Map it to load.notes for
 * revenue events to match the web app's convention.
 */
export async function updateLoadFields(
  id:    string,
  _orgId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const eventBody: Record<string, unknown> = {};
  const loadBody:  Record<string, unknown> = {};

  for (const [k, v] of Object.entries(fields)) {
    const evKey = EVENT_FIELD_MAP[k];
    if (evKey) { eventBody[evKey] = v; continue; }
    const loadKey = LOAD_FIELD_MAP[k];
    if (loadKey) { loadBody[loadKey] = v; continue; }
    if (k === "special_instructions") {
      // Legacy field — fold into load.notes (revenue) or eventNotes (non-rev).
      // If both special_instructions and notes are sent, notes wins below.
      if (loadBody.notes === undefined) loadBody.notes = v;
      continue;
    }
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[updateLoadFields] unknown column "${k}" — ignored`);
    }
  }

  const tasks: Promise<unknown>[] = [];
  if (Object.keys(eventBody).length) tasks.push(railway.updateEvent(id, eventBody));
  if (Object.keys(loadBody).length) {
    // Resolve loadId from the event. Non-revenue events have no load — drop
    // load-level fields with a warning.
    const { loads } = await railway.getEvent(id);
    const self = loads.find(l => l.id === id) ?? loads[0];
    const loadId = self?.loadId;
    if (loadId) tasks.push(railway.updateLoad(loadId, loadBody));
    else if (process.env.NODE_ENV !== "production") {
      console.warn("[updateLoadFields] event has no loadId; load-level fields skipped");
    }
  }
  await Promise.all(tasks);
}

export async function updateLoadStatus(id: string, _orgId: string, status: LoadStatus): Promise<void> {
  await railway.updateEvent(id, { status });
}

// getDocumentSignedUrl / getRateConSignedUrl removed — callers now go
// through railway.getDocumentUrl(documentId) and railway.getRateConUrl(loadId)
// directly (see DocumentsView).

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
  // Notes go to load.notes (broker context); legacy specialInstructions
  // is folded in if notes isn't already set.
  const mergedNotes = input.notes ?? input.specialInstructions;
  const { loads } = await railway.createLoad({
    load: {
      loadNum:       input.loadNum,
      broker:        input.broker,
      loadPrice:     input.loadPrice,
      rateConPdf:    input.rateConPdf,
      refNums:       input.refNums,
      notes:         mergedNotes,
      createdByName: input.createdByName,
    },
    events: [{
      title:      input.title,
      start:      input.start,
      end:        input.end,
      assetId:    input.assetId,
      driverId:   input.driverId ?? undefined,
      driverName: input.driverName,
      driverPay:  input.driverPay,
      status:     "scheduled",
      stops:      [],
    }],
  });
  return loads[0]?.id ?? null;
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
