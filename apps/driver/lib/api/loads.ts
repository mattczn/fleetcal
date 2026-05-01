import { supabase } from "@/lib/supabase";
import type { Load, LoadStatus, Stop } from "@/lib/types";

const EVENT_COLS =
  "id,internal_load_id,load_num,title,start,end,status,broker,trailer_type,trailer_id,driver_pay,notes,special_instructions,ref_nums,asset_id,deleted_at,relay_group_id,relay_role,driver_name";

interface DbEventRow {
  id: string;
  internal_load_id: number | null;
  load_num: string | null;
  title: string;
  start: string;
  end: string;
  status: string;
  broker: string | null;
  trailer_type: string | null;
  trailer_id:   number | null;
  driver_pay: number | null;
  notes: string | null;
  special_instructions: string | null;
  ref_nums: string | null;
  asset_id: number;
  deleted_at: string | null;
  relay_group_id: string | null;
  relay_role:     string | null;
  driver_name:    string | null;
}

interface DbTrailerRow {
  id:             number;
  name:           string;
  trailer_number: string | null;
}

function parseRefNums(raw: string | null): { label: string; value: string }[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return undefined;
}

interface DbStopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  timezone: string | null;
  appt_start: string | null;
  appt_end: string | null;
  lat: number | null;
  lng: number | null;
  instructions: string | null;
  arrived_at:  string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

interface DbAssetRow {
  id: number;
  name: string;
  unit: string | null;
}

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,timezone,appt_start,appt_end,lat,lng,instructions,arrived_at,arrived_lat,arrived_lng";

function rowToStop(r: DbStopRow): Stop {
  return {
    id:            r.id,
    sequence:      r.sequence,
    type:          r.type as Stop["type"],
    facilityName:  r.facility_name ?? undefined,
    address:       r.address       ?? undefined,
    city:          r.city          ?? undefined,
    timezone:      r.timezone      ?? undefined,
    apptStart:     r.appt_start    ?? undefined,
    apptEnd:       r.appt_end      ?? undefined,
    lat:           r.lat           ?? undefined,
    lng:           r.lng           ?? undefined,
    instructions:  r.instructions  ?? undefined,
    arrivedAt:     r.arrived_at    ?? undefined,
    arrivedLat:    r.arrived_lat   ?? undefined,
    arrivedLng:    r.arrived_lng   ?? undefined,
  };
}

function rowToLoad(
  r: DbEventRow,
  stopsByEvent: Map<string, Stop[]>,
  assetsById: Map<number, DbAssetRow>,
  trailersById: Map<number, DbTrailerRow>,
): Load {
  const asset = assetsById.get(r.asset_id);
  const trailer = r.trailer_id != null ? trailersById.get(r.trailer_id) : undefined;
  return {
    id:                  r.id,
    internalLoadId:      r.internal_load_id ?? undefined,
    loadNum:             r.load_num ?? undefined,
    title:               r.title,
    start:               r.start,
    end:                 r.end,
    status:              (r.status as LoadStatus) ?? "scheduled",
    assetId:             r.asset_id,
    broker:              r.broker               ?? undefined,
    trailerType:         r.trailer_type         ?? undefined,
    trailerId:           r.trailer_id           ?? undefined,
    trailerName:         trailer
      ? `#${trailer.trailer_number ?? trailer.name}`
      : undefined,
    driverPay:           r.driver_pay           ?? undefined,
    notes:               r.notes                ?? undefined,
    specialInstructions: r.special_instructions ?? undefined,
    refNums:             parseRefNums(r.ref_nums),
    relayGroupId:        r.relay_group_id ?? undefined,
    relayRole:           (r.relay_role as "pickup" | "delivery" | null) ?? undefined,
    assetName:           asset
      ? `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}`
      : undefined,
    stops:               (stopsByEvent.get(r.id) ?? []).sort(
      (a, b) => a.sequence - b.sequence,
    ),
  };
}

/**
 * Fetch all loads assigned to a driver, ordered by start time.
 * Stops + asset info come from two follow-up queries (Supabase doesn't
 * support nested joins through PostgREST without explicit FK config).
 */
export async function fetchLoadsForDriver(
  driverId: number,
  orgId: string,
): Promise<Load[]> {
  const { data: events, error } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .order("start", { ascending: true });

  if (error) {
    console.error("fetchLoadsForDriver:", error);
    throw error;
  }

  const rows = (events ?? []) as DbEventRow[];
  if (rows.length === 0) return [];

  const eventIds  = rows.map((r) => r.id);
  const assetIds  = Array.from(new Set(rows.map((r) => r.asset_id)));
  const trailerIds = Array.from(new Set(rows.map((r) => r.trailer_id).filter((x): x is number => x != null)));

  const [stopsRes, assetsRes, trailersRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit").in("id", assetIds),
    trailerIds.length > 0
      ? supabase.from("trailers").select("id,name,trailer_number").in("id", trailerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (stopsRes.error)    console.error("fetchLoadsForDriver stops:",    stopsRes.error);
  if (assetsRes.error)   console.error("fetchLoadsForDriver assets:",   assetsRes.error);
  if (trailersRes.error) console.error("fetchLoadsForDriver trailers:", trailersRes.error);

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as DbStopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }

  const assetsById = new Map<number, DbAssetRow>();
  for (const a of (assetsRes.data ?? []) as DbAssetRow[]) {
    assetsById.set(a.id, a);
  }

  const trailersById = new Map<number, DbTrailerRow>();
  for (const t of (trailersRes.data ?? []) as DbTrailerRow[]) {
    trailersById.set(t.id, t);
  }

  return rows.map((r) => rowToLoad(r, stopsByEvent, assetsById, trailersById));
}

export async function fetchLoad(
  id: string,
  driverId: number,
  orgId: string,
): Promise<Load | null> {
  const { data, error } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) { console.error("fetchLoad:", error); return null; }
  if (!data) return null;

  const row = data as DbEventRow;

  const [stopsRes, assetRes, trailerRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).eq("event_id", row.id),
    supabase.from("assets").select("id,name,unit").eq("id", row.asset_id).maybeSingle(),
    row.trailer_id != null
      ? supabase.from("trailers").select("id,name,trailer_number").eq("id", row.trailer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const stops = ((stopsRes.data ?? []) as DbStopRow[])
    .map(rowToStop)
    .sort((a, b) => a.sequence - b.sequence);
  const stopsByEvent = new Map([[row.id, stops]]);
  const assetsById = new Map<number, DbAssetRow>();
  if (assetRes.data) assetsById.set(row.asset_id, assetRes.data as DbAssetRow);
  const trailersById = new Map<number, DbTrailerRow>();
  if (trailerRes.data && row.trailer_id != null) {
    trailersById.set(row.trailer_id, trailerRes.data as DbTrailerRow);
  }

  const load = rowToLoad(row, stopsByEvent, assetsById, trailersById);

  // If this is a relay, fetch the partner event (same relay_group_id, different id)
  // so the driver can see what happens after their leg.
  if (row.relay_group_id) {
    const { data: partnerRow } = await supabase
      .from("events")
      .select(EVENT_COLS)
      .eq("relay_group_id", row.relay_group_id)
      .eq("org_id", orgId)
      .neq("id", row.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (partnerRow) {
      const pr = partnerRow as DbEventRow;
      const { data: partnerStopsData } = await supabase
        .from("stops")
        .select(STOP_COLS)
        .eq("event_id", pr.id);
      load.partnerStops = ((partnerStopsData ?? []) as DbStopRow[])
        .map(rowToStop)
        .sort((a, b) => a.sequence - b.sequence);
      load.partnerDriverName = pr.driver_name ?? undefined;
    }
  }

  return load;
}

export interface DriverAuditEntry {
  changedAt:    string;
  changedByName: string;
  prevStatus?:  LoadStatus;
  newStatus?:   LoadStatus;
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?:  { fileName: string; kind: string };
  stopCheckedIn?:    { stopFacility?: string; stopType?: string; distanceMi?: number };
  stopCheckInUndone?: { stopFacility?: string; stopType?: string };
}

/**
 * Append an entry to the event's audit_log JSONB column.
 * Read-modify-write — safe enough for driver-paced edits, not for high contention.
 */
export async function appendEventAuditEntry(
  eventId: string,
  orgId:   string,
  entry:   DriverAuditEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from("events")
    .select("audit_log")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) { console.error("appendEventAuditEntry read:", error); return; }
  const existing = (data?.audit_log as DriverAuditEntry[] | null) ?? [];
  const next = [...existing, entry];
  const { error: writeErr } = await supabase
    .from("events")
    .update({ audit_log: next })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (writeErr) console.error("appendEventAuditEntry write:", writeErr);
}

export async function updateLoadStatus(
  id: string,
  orgId: string,
  status: LoadStatus,
  prevStatus?: LoadStatus,
  changedByName?: string,
): Promise<void> {
  const { error } = await supabase
    .from("events")
    .update({ status })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("updateLoadStatus:", error);
    throw error;
  }
  if (changedByName && prevStatus !== status) {
    await appendEventAuditEntry(id, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName,
      prevStatus,
      newStatus:    status,
    });
  }
}

export async function updateLoadTrailer(
  id: string,
  orgId: string,
  trailerId: number | null,
): Promise<void> {
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

export async function checkInStop(
  stopId: string,
  orgId: string,
  lat: number,
  lng: number,
  audit?: {
    eventId: string;
    changedByName: string;
    stopFacility?: string;
    stopType?: string;
    distanceMi?: number;
  },
): Promise<void> {
  const { error } = await supabase
    .from("stops")
    .update({
      arrived_at:  new Date().toISOString(),
      arrived_lat: lat,
      arrived_lng: lng,
    })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (error) {
    console.error("checkInStop:", error);
    throw error;
  }
  if (audit) {
    await appendEventAuditEntry(audit.eventId, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: audit.changedByName,
      stopCheckedIn: {
        stopFacility: audit.stopFacility,
        stopType:     audit.stopType,
        distanceMi:   audit.distanceMi,
      },
    });
  }
}

export async function undoCheckInStop(
  stopId: string,
  orgId: string,
  audit?: {
    eventId: string;
    changedByName: string;
    stopFacility?: string;
    stopType?: string;
  },
): Promise<void> {
  const { error } = await supabase
    .from("stops")
    .update({
      arrived_at:  null,
      arrived_lat: null,
      arrived_lng: null,
    })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (error) {
    console.error("undoCheckInStop:", error);
    throw error;
  }
  if (audit) {
    await appendEventAuditEntry(audit.eventId, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: audit.changedByName,
      stopCheckInUndone: {
        stopFacility: audit.stopFacility,
        stopType:     audit.stopType,
      },
    });
  }
}

export async function fetchTrailers(
  orgId: string,
): Promise<{ id: number; name: string; trailerNumber?: string; category: string }[]> {
  const { data, error } = await supabase
    .from("trailers")
    .select("id,name,trailer_number,category,sort_order")
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true });
  if (error) { console.error("fetchTrailers:", error); return []; }
  return (data ?? []).map((t) => ({
    id:             t.id as number,
    name:           t.name as string,
    trailerNumber:  (t.trailer_number as string | null) ?? undefined,
    category:       t.category as string,
  }));
}
