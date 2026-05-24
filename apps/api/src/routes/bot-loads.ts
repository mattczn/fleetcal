/**
 * Read-only load endpoints for the Telegram bot.
 * Mounted under /v1/bot/loads via botAuth middleware (no Clerk required).
 */

import { Hono } from "hono";
import { joinEventLoadToApp, type ListLoadsResponse, type ApiErrorResponse, type Load, type LoadStatus, LOAD_STATUSES, type Stop, type StopType } from "@fleetcal/types";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";

const botLoads = new Hono<{ Variables: AuthVariables }>();

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids," +
  "document_counts,audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

interface StopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  appt_start: string | null;
  appt_end: string | null;
  schedule_type: string | null;
  instructions: string | null;
  geocode_status: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

function rowToStop(s: StopRow): Stop {
  return {
    id: s.id,
    eventId: s.event_id,
    sequence: s.sequence,
    type: s.type as StopType,
    facilityName: s.facility_name ?? undefined,
    address: s.address ?? undefined,
    city: s.city ?? undefined,
    state: s.state ?? undefined,
    lat: s.lat ?? undefined,
    lng: s.lng ?? undefined,
    timezone: s.timezone ?? undefined,
    apptStart: s.appt_start ?? undefined,
    apptEnd: s.appt_end ?? undefined,
    scheduleType: (s.schedule_type as Stop["scheduleType"]) ?? undefined,
    instructions: s.instructions ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
  };
}

// GET /v1/bot/loads — list loads with optional filters
botLoads.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const statusParam = url.searchParams.get("status");

  let statusList: LoadStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((s) => !LOAD_STATUSES.includes(s as LoadStatus));
    if (invalid.length) {
      return c.json({ error: "bad_request", detail: `unknown status: ${invalid.join(",")}` } satisfies ApiErrorResponse, 400);
    }
    statusList = parts as LoadStatus[];
  }

  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });

  if (from) q = q.gte("end", from);
  if (to) q = q.lte("start", to);
  if (statusList) q = q.in("status", statusList);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/bot/loads] query failed:", error);
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const rows = events ?? [];
  const eventIds = (rows as Array<Record<string, unknown>>).map((r) => r.id as string);
  const stopsByEvent = new Map<string, Stop[]>();

  if (eventIds.length) {
    const { data: stopRows } = await supabase
      .from("stops")
      .select(STOP_COLS)
      .in("event_id", eventIds);
    for (const s of (stopRows ?? []) as unknown as StopRow[]) {
      const arr = stopsByEvent.get(s.event_id) ?? [];
      arr.push(rowToStop(s));
      stopsByEvent.set(s.event_id, arr);
    }
  }

  const result: Load[] = rows.map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    return joined;
  });

  return c.json({ loads: result } satisfies ListLoadsResponse);
});

// GET /v1/bot/loads/search — search by load number or driver name
botLoads.get("/search", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Number(limitParam ?? 20) || 20, 50);

  if (q.length < 2) return c.json({ loads: [] } satisfies ListLoadsResponse);

  const isNumeric = /^\d+$/.test(q);

  // Load-side matches: load_num, internal_load_id
  const loadOrParts = [`load_num.ilike.%${q}%`];
  if (isNumeric) loadOrParts.push(`internal_load_id.eq.${q}`);

  const { data: matchedLoads } = await supabase
    .from("loads")
    .select("id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(loadOrParts.join(","));

  const loadIds = ((matchedLoads ?? []) as Array<{ id: string }>).map((r) => r.id);

  // Event-side matches: title, driver_name
  const { data: matchedEvents } = await supabase
    .from("events")
    .select("id")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .or(`title.ilike.%${q}%,driver_name.ilike.%${q}%`);

  const eventIds = new Set(((matchedEvents ?? []) as Array<{ id: string }>).map((r) => r.id));

  // Fetch full event rows for all matches
  let evQ = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: false })
    .limit(limit);

  const allIds = [...new Set([...loadIds, ...Array.from(eventIds)])];
  if (loadIds.length && eventIds.size) {
    evQ = evQ.or(`id.in.(${Array.from(eventIds).join(",")}),load_id.in.(${loadIds.join(",")})`);
  } else if (loadIds.length) {
    evQ = evQ.in("load_id", loadIds);
  } else if (eventIds.size) {
    evQ = evQ.in("id", Array.from(eventIds));
  } else {
    return c.json({ loads: [] } satisfies ListLoadsResponse);
  }

  const { data: events, error } = await evQ;
  if (error) {
    console.error("[GET /v1/bot/loads/search] query failed:", error);
    return c.json({ error: "search_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const result: Load[] = (events ?? []).map((e) => {
    const ev = e as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = [];
    return joined;
  });

  // dedupe relay legs — keep one per loadId
  const seen = new Set<string>();
  const deduped = result.filter((l) => {
    const key = l.loadId ?? l.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return c.json({ loads: deduped } satisfies ListLoadsResponse);
});

export default botLoads;
