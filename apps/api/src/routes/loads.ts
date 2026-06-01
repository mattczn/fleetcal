/**
 * /v1/loads — load CRUD against the split (loads + events) schema.
 *
 * All handlers require Clerk auth (mounted under the authed sub-app); the
 * orgId is read from the JWT and used to scope every query.
 *
 * Endpoints:
 *   POST   /v1/loads                            — create
 *   GET    /v1/loads                            — list (with filters)
 *   GET    /v1/loads/:id                        — single by load uuid
 *   PATCH  /v1/loads/:id                        — update load-level fields
 *   PATCH  /v1/loads/:id/events/:eventId        — update event-level fields
 *   POST   /v1/loads/:id/split-relay            — convert single → relay
 *   DELETE /v1/loads/:id                        — soft-delete
 *
 * Atomicity: PostgREST has no transactions, so multi-step writes use
 * sequential inserts/updates with best-effort cleanup on failure.
 */

import { Hono } from "hono";
import {
  appLoadToLoadInsert,
  appLoadToEventInsert,
  joinEventLoadToApp,
  type CreateLoadRequest,
  type CreateLoadResponse,
  type ListLoadsResponse,
  type GetLoadResponse,
  type UpdateLoadRequest,
  type UpdateLoadResponse,
  type UpdateEventRequest,
  type UpdateEventResponse,
  type SplitRelayRequest,
  type SplitRelayResponse,
  type UnsplitRelayRequest,
  type UnsplitRelayResponse,
  type DeleteLoadResponse,
  type RestoreLoadResponse,
  type GetRateConUrlResponse,
  type ListDocumentsResponse,
  type DocumentSummary,
  type DocumentKind,
  DOCUMENT_KINDS,
  type ApiErrorResponse,
  type Load,
  type LoadStatus,
  LOAD_STATUSES,
  type Stop,
  type StopType,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { getUserDisplayName } from "../lib/clerk.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { checkCallsScopedRouter } from "./check-calls.js";

const loads = new Hono<{ Variables: AuthVariables }>();

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,relay_role,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at," +
  "trailer_dropoff_lat,trailer_dropoff_lng,trailer_dropoff_at,trailer_dropoff_address";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,total_billable,commodity,weight," +
  "dispatcher,notes,internal_notes," +
  "accessorials,rate_con_pdf,ref_nums," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids,document_counts," +
  "audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

interface StopRow {
  id: string;
  event_id: string;
  sequence: number;
  type: string;
  facility_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  timezone: string | null;
  appt_start: string | null;
  appt_end: string | null;
  schedule_type: string | null;
  lat: number | null;
  lng: number | null;
  instructions: string | null;
  geocode_status: string | null;
  arrived_at: string | null;
  arrived_lat: number | null;
  arrived_lng: number | null;
}

function rowToStop(s: StopRow): Stop {
  return {
    id:            s.id,
    eventId:       s.event_id,
    sequence:      s.sequence,
    type:          s.type as StopType,
    facilityName:  s.facility_name ?? undefined,
    address:       s.address       ?? undefined,
    city:          s.city          ?? undefined,
    state:         s.state         ?? undefined,
    timezone:      s.timezone      ?? undefined,
    apptStart:     s.appt_start    ?? undefined,
    apptEnd:       s.appt_end      ?? undefined,
    scheduleType:  (s.schedule_type as Stop["scheduleType"]) ?? undefined,
    lat:           s.lat           ?? undefined,
    lng:           s.lng           ?? undefined,
    instructions:  s.instructions  ?? undefined,
    geocodeStatus: (s.geocode_status as Stop["geocodeStatus"]) ?? "pending",
    arrivedAt:     s.arrived_at    ?? undefined,
    arrivedLat:    s.arrived_lat   ?? undefined,
    arrivedLng:    s.arrived_lng   ?? undefined,
  };
}

/**
 * Fetch the joined Load[] view for a single load id (1 entry for single,
 * 2 for relay). Returns null if the load doesn't exist or doesn't belong
 * to the org. Stops are populated and sorted by sequence.
 */
async function fetchLoadJoined(
  loadId: string,
  orgId: string,
): Promise<Load[] | null> {
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .select(LOAD_COLS)
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (loadErr || !loadRow) return null;

  const { data: eventRowsRaw, error: evErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .order("start", { ascending: true });
  if (evErr || !eventRowsRaw) return [];
  const eventRows = eventRowsRaw as unknown as Array<Record<string, unknown> & { id: string }>;

  const { data: stopRowsRaw } = await supabase
    .from("stops")
    .select(STOP_COLS)
    .in("event_id", eventRows.map((e) => e.id));

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopRowsRaw ?? []) as unknown as StopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }

  // documentCounts now comes from loads.document_counts (denormalized
  // by the load_documents_refresh_counts trigger). joinEventLoadToApp
  // reads it off the load row — no extra query needed.

  return eventRows.map((ev) => {
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(ev.id) ?? []).slice().sort(
      (a, b) => a.sequence - b.sequence,
    );
    return joined;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;

/** Bad-request helper. Caller passes the Hono context. */
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads — create a load (1 or 2 events)
// ─────────────────────────────────────────────────────────────────────────

loads.post("/", requireCapability("loads.create"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<CreateLoadRequest>();

  // Validation
  const errors: string[] = [];
  if (!body || typeof body !== "object") errors.push("body must be an object");
  if (!body?.load || typeof body.load !== "object") errors.push("missing 'load' object");
  if (!Array.isArray(body?.events)) {
    errors.push("'events' must be an array");
  } else {
    if (body.events.length < 1 || body.events.length > 2) {
      errors.push("'events' must have 1 or 2 entries");
    }
    if (body.events.length === 2) {
      const roles = body.events.map((e) => e.relayRole);
      if (!roles.includes("pickup") || !roles.includes("delivery") || roles[0] === roles[1]) {
        errors.push("relay loads need exactly one 'pickup' and one 'delivery' relayRole");
      }
    }
    for (const [i, ev] of body.events.entries()) {
      if (!ev.title?.trim()) errors.push(`events[${i}]: title required`);
      if (!ev.start) errors.push(`events[${i}]: start required`);
      if (!ev.end) errors.push(`events[${i}]: end required`);
      if (typeof ev.assetId !== "number") errors.push(`events[${i}]: assetId (number) required`);
      if (ev.start && ev.end && ev.start > ev.end) errors.push(`events[${i}]: start must be <= end`);
    }
  }
  if (errors.length) return badRequest(c, errors);

  // 1. Insert load
  const loadInsert = appLoadToLoadInsert(body.load, orgId);

  // Backfill created_by_name from Clerk when the client didn't pass it.
  // Manual creation via EventModal always sets the field, but
  // programmatic flows (rate-con parser, bulk paste, future batch
  // imports) frequently forget, leaving the dispatcher UI's audit
  // panel showing "—" instead of who actually created the load.
  // Looking it up from the JWT's userId here closes the gap for every
  // path that goes through POST /v1/loads, which is all of them.
  if (!loadInsert.created_by_name) {
    const name = await getUserDisplayName(userId);
    if (name) loadInsert.created_by_name = name;
  }

  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .insert(loadInsert)
    .select()
    .single();
  if (loadErr || !loadRow) {
    console.error("[POST /v1/loads] load insert failed:", loadErr);
    return c.json({ error: "load_insert_failed", detail: loadErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Insert events
  const eventInserts = body.events.map((ev) =>
    appLoadToEventInsert(
      { ...ev, loadId: loadRow.id, eventKind: "revenue", status: ev.status ?? "scheduled", stops: [] },
      orgId,
    ),
  );
  const { data: eventRows, error: evErr } = await supabase
    .from("events")
    .insert(eventInserts)
    .select();
  if (evErr || !eventRows || eventRows.length !== body.events.length) {
    console.error("[POST /v1/loads] events insert failed:", evErr);
    await supabase.from("loads").delete().eq("id", loadRow.id);
    return c.json({ error: "events_insert_failed", detail: evErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Insert stops
  const stopInserts = body.events.flatMap((ev, i) =>
    (ev.stops ?? []).map((s, idx) => ({
      event_id:       eventRows[i].id,
      org_id:         orgId,
      sequence:       idx + 1,
      type:           s.type,
      facility_name:  s.facilityName  ?? null,
      address:        s.address       ?? null,
      city:           s.city          ?? null,
      state:          s.state         ?? null,
      timezone:       s.timezone      ?? null,
      appt_start:     s.apptStart     ?? null,
      appt_end:       s.apptEnd       ?? null,
      schedule_type:  s.scheduleType  ?? null,
      lat:            s.lat           ?? null,
      lng:            s.lng           ?? null,
      instructions:   s.instructions  ?? null,
      geocode_status: s.geocodeStatus ?? "pending",
    })),
  );
  if (stopInserts.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopInserts);
    if (stopErr) {
      console.error("[POST /v1/loads] stops insert failed:", stopErr);
      await supabase.from("loads").delete().eq("id", loadRow.id);
      return c.json({ error: "stops_insert_failed", detail: stopErr?.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchLoadJoined(loadRow.id, orgId);
  const res: CreateLoadResponse = { loads: joined ?? [] };
  return c.json(res, 201);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads — list with filters
// ─────────────────────────────────────────────────────────────────────────

loads.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const statusParam = url.searchParams.get("status");
  const assetIdParam = url.searchParams.get("assetId");
  const brokersParam = url.searchParams.get("brokers");
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";

  // Validate status values if provided
  let statusList: LoadStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = parts.filter((s) => !LOAD_STATUSES.includes(s as LoadStatus));
    if (invalid.length) return badRequest(c, [`unknown status values: ${invalid.join(",")}`]);
    statusList = parts as LoadStatus[];
  }

  let assetIds: number[] | undefined;
  if (assetIdParam) {
    const parts = assetIdParam.split(",").map((s) => s.trim()).filter(Boolean);
    const parsed = parts.map((s) => Number(s));
    if (parsed.some((n) => !Number.isFinite(n))) return badRequest(c, ["assetId must be numeric"]);
    assetIds = parsed;
  }

  // Brokers filter: PostgREST .or() can't span the nested loads relation,
  // so we resolve broker names → matching load_ids first, then filter
  // events by those IDs.
  let brokerLoadIds: string[] | undefined;
  if (brokersParam) {
    const names = brokersParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) {
      return c.json({ loads: [] } satisfies ListLoadsResponse);
    }
    const escaped = names.map((n) => n.replace(/[%,()"]/g, "\\$&"));
    const orFilter = escaped.map((n) => `broker.ilike."${n}"`).join(",");
    const { data, error } = await supabase
      .from("loads")
      .select("id")
      .eq("org_id", orgId)
      .or(orFilter);
    if (error) {
      console.error("[GET /v1/loads] broker resolve failed:", error);
      return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    brokerLoadIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (brokerLoadIds.length === 0) {
      return c.json({ loads: [] } satisfies ListLoadsResponse);
    }
  }

  // Joined fetch via PostgREST nested select
  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .order("start", { ascending: true });

  if (!includeDeleted) q = q.is("deleted_at", null);
  if (from) q = q.gte("end", from);
  if (to) q = q.lte("start", to);
  if (statusList) q = q.in("status", statusList);
  if (assetIds) q = q.in("asset_id", assetIds);
  if (brokerLoadIds) q = q.in("load_id", brokerLoadIds);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/loads] query failed:", error);
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = events ?? [];

  // Fetch stops in one query for all events
  const eventIds = (rows as unknown as Array<Record<string, unknown>>).map((r) => r.id as string);
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

  // documentCounts is now stored on loads.document_counts (kept in
  // sync by the load_documents_refresh_counts trigger) and read by
  // joinEventLoadToApp directly off the load row. The previous batch
  // doc-count query has been removed — saving one DB roundtrip per
  // list response and eliminating the stale-icon bug where the
  // calendar's cached events array held a stale count after a POD
  // upload realtime event was missed.

  const result: Load[] = rows.map((e) => {
    const ev = e as unknown as Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    return joined;
  });

  const res: ListLoadsResponse = { loads: result };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads/search — search loads by load-level + event-level fields
// ─────────────────────────────────────────────────────────────────────────
//
// Query params:
//   q     — search string (min 2 chars; shorter returns empty)
//   limit — max results, default 20, capped at 50
//
// Matches:
//   load-level   — loads.load_num, broker, notes, internal_load_id (if numeric)
//   event-level  — events.title, driver_name, notes
//
// Implementation: PostgREST .or() can't span nested relations, so we run
// the load-side and event-side filters separately and union by event id.
// Excludes soft-deleted; sorted newest start first.

loads.get("/search", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "20", 10) || 20, 1), 50);

  if (q.length < 2) {
    return c.json({ loads: [] } satisfies ListLoadsResponse);
  }

  // Escape PostgREST-special chars in the LIKE pattern.
  const escaped = q.replace(/[%,()]/g, "\\$&");
  const pattern = `%${escaped}%`;
  // internal_load_id is an int4 column — gate on max int4 to avoid overflow on long numeric queries (e.g. phone numbers).
  const parsedNum = /^\d+$/.test(q) ? Number(q) : NaN;
  const numericId = Number.isFinite(parsedNum) && parsedNum <= 2147483647 ? parsedNum : null;

  // 1) Load-side matches → list of load_ids whose loads-row fields hit.
  //
  // NOTE: `.is("deleted_at", null)` filter intentionally removed —
  // dispatchers want to find cancelled-keep-load AND fully-deleted
  // loads via search without bouncing between the calendar and the
  // Recently Deleted tray. The status of each result (active /
  // cancelled / deleted) is rendered as a pill in the dropdown.
  const loadOr = numericId !== null
    ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
    : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;
  const loadIdsP = supabase
    .from("loads")
    .select("id")
    .eq("org_id", orgId)
    .or(loadOr)
    .limit(50);

  // 2) Event-side matches → joined events whose event-row fields hit.
  //    Same filter relaxation as above — soft-deleted events count.
  const eventMatchesP = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .or(`title.ilike.${pattern},driver_name.ilike.${pattern},notes.ilike.${pattern}`)
    .order("start", { ascending: false })
    .limit(limit);

  const [loadIdsRes, eventMatchesRes] = await Promise.all([loadIdsP, eventMatchesP]);
  if (loadIdsRes.error) {
    console.error("[GET /v1/loads/search] load-side query failed:", loadIdsRes.error);
    return c.json({ error: "search_failed", detail: loadIdsRes.error.message } satisfies ApiErrorResponse, 500);
  }
  if (eventMatchesRes.error) {
    console.error("[GET /v1/loads/search] event-side query failed:", eventMatchesRes.error);
    return c.json({ error: "search_failed", detail: eventMatchesRes.error.message } satisfies ApiErrorResponse, 500);
  }

  const matchedLoadIds = ((loadIdsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
  let loadMatches: unknown[] = [];
  if (matchedLoadIds.length > 0) {
    const { data, error } = await supabase
      .from("events")
      .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
      .eq("org_id", orgId)
      // Same filter relaxation as the other two queries above —
      // search returns cancelled-keep-load + fully-deleted too.
      .in("load_id", matchedLoadIds)
      .order("start", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[GET /v1/loads/search] load-events query failed:", error);
      return c.json({ error: "search_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    loadMatches = data ?? [];
  }

  // Union by event id, newest start first. Stops aren't fetched here —
  // search results don't display stop detail (callers re-fetch on click).
  const seen = new Set<string>();
  const merged: Load[] = [];
  for (const r of [
    ...(eventMatchesRes.data ?? []),
    ...(loadMatches as Array<Record<string, unknown>>),
  ] as Array<Record<string, unknown> & { load?: Record<string, unknown>[] | Record<string, unknown> | null }>) {
    const id = r.id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const loadRow = Array.isArray(r.load) ? (r.load[0] ?? null) : (r.load ?? null);
    merged.push(joinEventLoadToApp(r, loadRow));
  }
  merged.sort((a, b) => b.start.localeCompare(a.start));

  const res: ListLoadsResponse = { loads: merged.slice(0, limit) };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads/:loadId/documents — list driver-uploaded documents
// ─────────────────────────────────────────────────────────────────────────
//
// Returns documents attached to the load, with 1-hour signed URLs minted
// server-side in a single batch call. If a URL expires before the user
// clicks (rare), the caller can refresh via GET /v1/documents/:id/url.

loads.get("/:id/documents", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const { data: rows, error } = await supabase
    .from("load_documents")
    .select("id,load_id,invoice_id,storage_path,file_name,mime_type,size_bytes,kind,uploaded_at")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.error("[GET /v1/loads/:id/documents] read failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  type DocRow = {
    id: string; load_id: string | null; invoice_id: string | null;
    storage_path: string;
    file_name: string; mime_type: string | null; size_bytes: number | null;
    kind: string; uploaded_at: string;
  };
  const docs = (rows ?? []) as DocRow[];

  // Batch-mint signed URLs, grouped by bucket. Rate cons live in
  // their own bucket so we can't mint them in the same call as the
  // rest; bucketForKind decides which bucket each doc's blob lives in.
  // Legacy rows whose rate_con blob is still in load-documents fall
  // through the dual-bucket fallback below.
  const urlByPath = new Map<string, string>();
  if (docs.length > 0) {
    const byBucket = new Map<string, DocRow[]>();
    for (const d of docs) {
      const bucket = bucketForKind(d.kind);
      const arr = byBucket.get(bucket) ?? [];
      arr.push(d);
      byBucket.set(bucket, arr);
    }
    await Promise.all(
      Array.from(byBucket.entries()).map(async ([bucket, group]) => {
        const { data: signed, error: signErr } = await supabase.storage
          .from(bucket)
          .createSignedUrls(group.map((d) => d.storage_path), 3600);
        if (signErr) {
          console.error("[GET /v1/loads/:id/documents] sign failed for bucket", bucket, signErr);
          return;
        }
        for (const u of signed ?? []) {
          if (u.path && u.signedUrl) urlByPath.set(u.path, u.signedUrl);
        }
      }),
    );
    // Fallback pass — try the *other* bucket for any doc that didn't
    // mint a URL above. Covers the legacy state where some rate_con
    // blobs still live in load-documents pre-migration.
    const unsigned = docs.filter((d) => !urlByPath.has(d.storage_path));
    if (unsigned.length > 0) {
      const fallbackByBucket = new Map<string, DocRow[]>();
      for (const d of unsigned) {
        const [primary, fallback] = bucketReadOrder(d.kind);
        if (!fallback || fallback === primary) continue;
        const arr = fallbackByBucket.get(fallback) ?? [];
        arr.push(d);
        fallbackByBucket.set(fallback, arr);
      }
      await Promise.all(
        Array.from(fallbackByBucket.entries()).map(async ([bucket, group]) => {
          const { data: signed } = await supabase.storage
            .from(bucket)
            .createSignedUrls(group.map((d) => d.storage_path), 3600);
          for (const u of signed ?? []) {
            if (u.path && u.signedUrl) urlByPath.set(u.path, u.signedUrl);
          }
        }),
      );
    }
  }

  const documents: DocumentSummary[] = docs.map((d) => ({
    id:         d.id,
    loadId:     d.load_id,
    invoiceId:  d.invoice_id  ?? undefined,
    fileName:   d.file_name,
    mimeType:   d.mime_type   ?? undefined,
    sizeBytes:  d.size_bytes  ?? undefined,
    kind:       (d.kind as DocumentKind) ?? "other",
    uploadedAt: d.uploaded_at,
    signedUrl:  urlByPath.get(d.storage_path),
  }));

  const res: ListDocumentsResponse = { documents };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/documents — dispatcher uploads a paperwork file
// ─────────────────────────────────────────────────────────────────────────
//
// Multipart body: file (binary) + kind ("bol" | "pod" | "scale" | "other").
// Resolves the load's first event so the document is reachable through
// event-scoped queries too (the driver app and audit log both key off
// event_id; matching that schema keeps things consistent).

// Bucket constants moved to ../lib/docBuckets.ts so every route uses
// the same kind → bucket rule. Kept as a local alias for the previous
// occurrences in this file that referred to it bare.
import { bucketForKind, bucketReadOrder, DOC_BUCKET, RATE_CON_BUCKET } from "../lib/docBuckets.js";

loads.post("/:id/documents", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const loadId = c.req.param("id");

  let body: { file?: File; kind?: string };
  try { body = await c.req.parseBody() as { file?: File; kind?: string }; }
  catch (err) {
    console.error("[POST /v1/loads/:id/documents] parseBody:", err);
    return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400);
  }
  const file = body.file;
  const kind = (body.kind ?? "other").toString();
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] } satisfies ApiErrorResponse, 400);
  }
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`] } satisfies ApiErrorResponse, 400);
  }

  // Pick the pickup leg's event id for the doc's event_id when relay,
  // else the single event for the load. Doc still links to the load
  // via load_id so the closeout queue's per-load grouping still works.
  const { data: legs, error: legsErr } = await supabase
    .from("events")
    .select("id, relay_role")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null);
  if (legsErr) {
    console.error("[POST /v1/loads/:id/documents] load events fetch:", legsErr);
    return c.json({ error: "fetch_failed", detail: legsErr.message } satisfies ApiErrorResponse, 500);
  }
  const legRows = (legs ?? []) as Array<{ id: string; relay_role: string | null }>;
  const eventId =
       legRows.find(e => e.relay_role === "pickup")?.id
    ?? legRows[0]?.id
    ?? null;
  if (!eventId) {
    return c.json({ error: "not_found", detail: "no event for load" } satisfies ApiErrorResponse, 404);
  }

  const bytes  = new Uint8Array(await file.arrayBuffer());
  const ext    = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const random = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${eventId}/${Date.now()}_${random}.${ext}`;

  // Build a display filename in the {LoadNum}_{KIND}{_N}.{ext} convention
  // so dispatchers can read the file list at a glance without opening
  // each one. Falls back to the original name if we can't resolve a
  // load number for the load (rare — usually backfilled on create).
  // Suffix _N is added when there's already a doc of the same kind on
  // this load so users can tell them apart.
  const { data: loadInfo } = await supabase
    .from("loads")
    .select("load_num")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const loadNum = (loadInfo as { load_num: string | null } | null)?.load_num ?? null;
  let displayName = file.name;
  if (loadNum) {
    const safeNum = loadNum.replace(/[^A-Za-z0-9_-]/g, "");
    const kindLabel = kind.toUpperCase();
    // Count existing docs of this kind for the load to pick a suffix.
    const { count: priorCount } = await supabase
      .from("load_documents")
      .select("id", { head: true, count: "exact" })
      .eq("load_id", loadId)
      .eq("org_id", orgId)
      .eq("kind", kind);
    const suffix = (priorCount ?? 0) > 0 ? `_${(priorCount ?? 0) + 1}` : "";
    displayName = `${safeNum}_${kindLabel}${suffix}.${ext}`;
  }

  // Pick the bucket by kind. Rate cons go to the dedicated rate-cons
  // bucket so a future bucket-level policy can lock them away from
  // any code path that mints driver-facing signed URLs. Everything
  // else (POD/BOL/etc.) stays in load-documents.
  const targetBucket = bucketForKind(kind);
  const { error: uploadErr } = await supabase.storage
    .from(targetBucket)
    .upload(storagePath, bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST /v1/loads/:id/documents] storage upload:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message } satisfies ApiErrorResponse, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("load_documents")
    .insert({
      event_id:     eventId,
      load_id:      loadId,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    displayName,
      mime_type:    file.type || null,
      size_bytes:   bytes.length,
      kind,
    } as any)
    .select("id, load_id, storage_path, file_name, mime_type, size_bytes, kind, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(targetBucket).remove([storagePath]);
    console.error("[POST /v1/loads/:id/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  type DocRow = {
    id: string; load_id: string | null; storage_path: string;
    file_name: string; mime_type: string | null; size_bytes: number | null;
    kind: string; uploaded_at: string;
  };
  const d = data as DocRow;

  // Rate-con mirror: a newly uploaded rate confirmation becomes the
  // load's "current" rate-con. We keep the history in load_documents
  // (kind=rate_con) so older versions stay accessible, but point
  // loads.rate_con_pdf at the latest so the review queue's primary
  // Rate Con panel + the AI rate-con parser flow keep working with
  // a single canonical pointer.
  if (kind === "rate_con") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: mirrorErr } = await supabase
      .from("loads")
      .update({ rate_con_pdf: storagePath } as any)
      .eq("id", loadId)
      .eq("org_id", orgId);
    if (mirrorErr) {
      // Non-fatal — the doc is uploaded and visible in the docs list.
      console.warn("[POST /v1/loads/:id/documents] rate_con mirror failed:", mirrorErr);
    }
  }

  return c.json({
    document: {
      id:         d.id,
      loadId:     d.load_id,
      fileName:   d.file_name,
      mimeType:   d.mime_type   ?? undefined,
      sizeBytes:  d.size_bytes  ?? undefined,
      kind:       d.kind        as "bol" | "pod" | "scale" | "other",
      uploadedAt: d.uploaded_at,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads/:id/rate-con-url — viewable URL for the load's rate-con PDF
// ─────────────────────────────────────────────────────────────────────────

loads.get("/:id/rate-con-url", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const { data, error } = await supabase
    .from("loads")
    .select("rate_con_pdf")
    .eq("id", loadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/loads/:id/rate-con-url] read failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const val = (data as { rate_con_pdf: string | null }).rate_con_pdf;

  // Legacy: base64 data URLs stored before the storage migration — pass through.
  if (val && val.startsWith("data:")) {
    const res: GetRateConUrlResponse = { url: val };
    return c.json(res);
  }

  // Storage path → 1-hour signed URL. Rate cons live in the rate-cons
  // bucket going forward (post-Phase 3.1 split), with legacy rows
  // possibly still in load-documents. Try the canonical rate-cons
  // bucket first, fall back to load-documents for legacy data.
  if (val) {
    for (const bucket of bucketReadOrder("rate_con")) {
      const { data: signed } = await supabase.storage
        .from(bucket)
        .createSignedUrl(val, 3600);
      if (signed) {
        const res: GetRateConUrlResponse = { url: signed.signedUrl };
        return c.json(res);
      }
    }
    console.warn("[GET /v1/loads/:id/rate-con-url] sign failed in both buckets for path", val);
  }

  // Fallback: `loads.rate_con_pdf` is null or its path no longer signs
  // (mirror didn't run, file was moved, etc.). Look for the most recent
  // `kind=rate_con` row in `load_documents` and use that. This keeps the
  // Rate Con panel working even when the mirror got out of sync.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: docs } = await supabase
    .from("load_documents")
    .select("storage_path, uploaded_at")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .eq("kind", "rate_con")
    .order("uploaded_at", { ascending: false })
    .limit(1);
  const docRow = (docs ?? [])[0] as { storage_path: string } | undefined;
  if (docRow?.storage_path) {
    for (const bucket of bucketReadOrder("rate_con")) {
      const { data: signed } = await supabase.storage
        .from(bucket)
        .createSignedUrl(docRow.storage_path, 3600);
      if (signed) {
        // Best-effort: refresh the mirror so future requests skip the
        // fallback. Don't block on this.
        void supabase
          .from("loads")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .update({ rate_con_pdf: docRow.storage_path } as any)
          .eq("id", loadId)
          .eq("org_id", orgId);
        const res: GetRateConUrlResponse = { url: signed.signedUrl };
        return c.json(res);
      }
    }
  }

  const res: GetRateConUrlResponse = { url: null };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /v1/loads/:id — single load by uuid
// ─────────────────────────────────────────────────────────────────────────

loads.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const joined = await fetchLoadJoined(loadId, orgId);
  if (joined === null) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const res: GetLoadResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/loads/:id — update load-level fields
// ─────────────────────────────────────────────────────────────────────────

loads.patch("/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<UpdateLoadRequest>();

  // Whitelist load-level fields. Anything not listed here is ignored.
  const update: Record<string, unknown> = {};
  if ("loadNum"      in body) update.load_num       = body.loadNum      ?? null;
  if ("broker"       in body) update.broker         = body.broker       ?? null;
  if ("customerId"   in body) update.customer_id    = body.customerId   ?? null;
  if ("dispatcher"   in body) update.dispatcher     = body.dispatcher   ?? null;
  if ("loadPrice"    in body) update.load_price     = body.loadPrice    ?? null;
  if ("commodity"    in body) update.commodity      = body.commodity    ?? null;
  if ("weight"       in body) update.weight         = body.weight       ?? null;
  if ("rateConPdf"   in body) update.rate_con_pdf   = body.rateConPdf   ?? null;
  if ("accessorials" in body) update.accessorials   = body.accessorials ?? null;
  if ("refNums"      in body) update.ref_nums       = body.refNums?.length ? JSON.stringify(body.refNums) : null;
  if ("notes"         in body) update.notes          = body.notes         ?? null;
  if ("internalNotes" in body) update.internal_notes = body.internalNotes ?? [];
  if ("auditLog"      in body) update.audit_log      = body.auditLog      ?? null;

  if (Object.keys(update).length === 0) {
    return badRequest(c, ["no allowed fields supplied; nothing to update"]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("loads")
    .update(update as any)
    .eq("id", loadId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/loads/:id] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateLoadResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /v1/loads/:id/events/:eventId — update event-level fields
// ─────────────────────────────────────────────────────────────────────────

loads.patch("/:id/events/:eventId", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const eventId = c.req.param("eventId");
  const body = await c.req.json<UpdateEventRequest>();

  // Validate status if provided
  if (body.status && !LOAD_STATUSES.includes(body.status)) {
    return badRequest(c, [`invalid status: ${body.status}`]);
  }
  if (body.start && body.end && body.start > body.end) {
    return badRequest(c, ["start must be <= end"]);
  }

  // Whitelist event-level fields
  const update: Record<string, unknown> = {};
  if ("title"       in body) update.title        = body.title;
  if ("start"       in body) update.start        = body.start;
  if ("end"         in body) update.end          = body.end;
  if ("status"      in body) update.status       = body.status;
  if ("assetId"     in body) update.asset_id     = body.assetId;
  if ("driverId"    in body) update.driver_id    = body.driverId    ?? null;
  if ("driverName"  in body) update.driver_name  = body.driverName  ?? null;
  if ("trailerId"   in body) update.trailer_id   = body.trailerId   ?? null;
  if ("trailerType" in body) update.trailer_type = body.trailerType ?? null;
  if ("driverPay"   in body) update.driver_pay   = body.driverPay   ?? null;
  if ("loadedMiles" in body) update.loaded_miles = body.loadedMiles ?? null;
  if ("eventNotes"  in body) update.notes        = body.eventNotes  ?? null;
  if ("priority"    in body) update.priority     = body.priority    ?? false;
  if ("trailerDropoffAddress" in body)
    update.trailer_dropoff_address = (body.trailerDropoffAddress as string | null | undefined) ?? null;

  if (Object.keys(update).length === 0) {
    return badRequest(c, ["no allowed fields supplied; nothing to update"]);
  }

  // If the driver is changing, blow away any prior driver's confirmation
  // and the reminder-sent stamp. The new driver re-confirms; the cron
  // sweep is allowed to nudge them again. (Status/asset changes don't
  // clear — same driver, still on the hook.) The dispatcher client is
  // responsible for sending the "load reassigned" push to the old driver
  // since it already runs the assignment-push flow.
  if ("driverId" in body) {
    const { data: prev } = await supabase
      .from("events")
      .select("driver_id")
      .eq("id", eventId)
      .eq("org_id", orgId)
      .maybeSingle();
    const prevRow = prev as { driver_id: number | null } | null;
    if ((prevRow?.driver_id ?? null) !== (body.driverId ?? null)) {
      update.confirmed_at             = null;
      update.confirmed_by             = null;
      update.confirm_reminder_sent_at = null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("events")
    .update(update as any)
    .eq("id", eventId)
    .eq("load_id", loadId) // ensures the event belongs to this load
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/loads/:id/events/:eventId] update failed:", error);
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: UpdateEventResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/split-relay — convert single → relay
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/split-relay", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<SplitRelayRequest>();

  // Validation
  const errors: string[] = [];
  if (!body.pickupEnd)      errors.push("pickupEnd required");
  if (!body.deliveryStart)  errors.push("deliveryStart required");
  if (!body.deliveryEnd)    errors.push("deliveryEnd required");
  if (typeof body.deliveryAssetId !== "number") errors.push("deliveryAssetId (number) required");
  if (!Array.isArray(body.mergedStops) || body.mergedStops.length < 2) errors.push("mergedStops must have at least 2 entries");
  if (typeof body.relayStopIndex !== "number") errors.push("relayStopIndex (number) required");
  if (body.relayStopIndex < 0 || (body.mergedStops && body.relayStopIndex >= body.mergedStops.length - 1)) {
    errors.push("relayStopIndex must be in [0, mergedStops.length - 2]");
  }
  if (body.pickupEnd && body.deliveryStart && body.pickupEnd > body.deliveryStart) {
    errors.push("pickupEnd must be <= deliveryStart");
  }
  if (body.deliveryStart && body.deliveryEnd && body.deliveryStart > body.deliveryEnd) {
    errors.push("deliveryStart must be <= deliveryEnd");
  }
  if (errors.length) return badRequest(c, errors);

  // Fetch the load and verify it has exactly one event
  const { data: existingEventsRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (fetchErr || !existingEventsRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existingEvents = existingEventsRaw as unknown as Array<Record<string, unknown> & {
    id: string; title: string; end: string; priority: boolean;
  }>;
  if (existingEvents.length !== 1) {
    return badRequest(c, [`load must have exactly 1 event to split; found ${existingEvents.length}`]);
  }
  const pickupEvent = existingEvents[0];

  // 1. Update the existing event → pickup leg
  const { error: pickupErr } = await supabase
    .from("events")
    .update({
      end:        body.pickupEnd,
      relay_role: "pickup",
    })
    .eq("id", pickupEvent.id)
    .eq("org_id", orgId);
  if (pickupErr) {
    return c.json({ error: "pickup_update_failed", detail: pickupErr.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Create the delivery leg event
  const deliveryInsert = {
    org_id:      orgId,
    load_id:     loadId,
    asset_id:    body.deliveryAssetId,
    driver_id:   body.deliveryDriverId   ?? null,
    driver_name: body.deliveryDriverName ?? null,
    title:       pickupEvent.title,
    start:       body.deliveryStart,
    end:         body.deliveryEnd,
    status:      "scheduled",
    event_kind:  "revenue",
    relay_role:  "delivery",
    priority:    pickupEvent.priority,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: deliveryEventRaw, error: delivErr } = await supabase
    .from("events")
    .insert(deliveryInsert as any)
    .select()
    .single();
  const deliveryEvent = deliveryEventRaw as { id: string } | null;
  if (delivErr || !deliveryEvent) {
    // Cleanup: revert pickup event role
    await supabase
      .from("events")
      .update({ relay_role: null, end: pickupEvent.end })
      .eq("id", pickupEvent.id)
      .eq("org_id", orgId);
    return c.json({ error: "delivery_create_failed", detail: delivErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Replace stops on both legs with the full merged list. Both legs
  //    share the same stops; the relay-type stop (at relayStopIndex) is the
  //    handoff marker. The modal greys out the other leg's stops based on
  //    relay_role + the relay marker's position. (relayStopIndex is still
  //    accepted for forward-compat but isn't used to partition anymore.)
  void body.relayStopIndex;
  await supabase.from("stops").delete().eq("event_id", pickupEvent.id).eq("org_id", orgId);

  const buildStopRows = (eventId: string) => body.mergedStops.map((s, idx) => ({
    event_id:       eventId,
    org_id:         orgId,
    sequence:       idx + 1,
    type:           s.type,
    facility_name:  s.facilityName  ?? null,
    address:        s.address       ?? null,
    city:           s.city          ?? null,
    state:          s.state         ?? null,
    timezone:       s.timezone      ?? null,
    appt_start:     s.apptStart     ?? null,
    appt_end:       s.apptEnd       ?? null,
    schedule_type:  s.scheduleType  ?? null,
    lat:            s.lat           ?? null,
    lng:            s.lng           ?? null,
    instructions:   s.instructions  ?? null,
    geocode_status: s.geocodeStatus ?? "pending",
  }));
  const stopRows = [...buildStopRows(pickupEvent.id), ...buildStopRows(deliveryEvent.id)];

  if (stopRows.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopRows);
    if (stopErr) {
      console.error("[POST /v1/loads/:id/split-relay] stops insert failed:", stopErr);
      // Best-effort: orphan stops are bad but recovery is hard here.
      return c.json({ error: "stops_insert_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  const res: SplitRelayResponse = { loads: joined ?? [] };
  return c.json(res, 200);
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /v1/loads/:id — soft-delete the load and its events
// ─────────────────────────────────────────────────────────────────────────

loads.delete("/:id", requireCapability("loads.delete"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const now = new Date().toISOString();

  // Soft-delete the load
  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .update({ deleted_at: now })
    .eq("id", loadId)
    .eq("org_id", orgId)
    .select()
    .maybeSingle();
  if (loadErr) {
    return c.json({ error: "delete_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!loadRow) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }

  // Soft-delete the events tied to this load
  const { error: evErr } = await supabase
    .from("events")
    .update({ deleted_at: now })
    .eq("load_id", loadId)
    .eq("org_id", orgId);
  if (evErr) {
    // Roll back the load delete; events are still active
    await supabase
      .from("loads")
      .update({ deleted_at: null })
      .eq("id", loadId)
      .eq("org_id", orgId);
    return c.json({ error: "events_delete_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }

  const res: DeleteLoadResponse = { ok: true, loadId };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/restore — undelete a soft-deleted load + its events
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/restore", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");

  const { data: loadRow, error: loadErr } = await supabase
    .from("loads")
    .update({ deleted_at: null })
    .eq("id", loadId)
    .eq("org_id", orgId)
    .select()
    .maybeSingle();
  if (loadErr) {
    return c.json({ error: "restore_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
  }
  if (!loadRow) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }

  const { error: evErr } = await supabase
    .from("events")
    .update({ deleted_at: null })
    .eq("load_id", loadId)
    .eq("org_id", orgId);
  if (evErr) {
    return c.json({ error: "events_restore_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  if (!joined) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const res: RestoreLoadResponse = { loads: joined };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/:id/unsplit-relay — collapse 2-event relay back to single
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/unsplit-relay", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<UnsplitRelayRequest>();

  if (!body?.keepEventId) {
    return badRequest(c, ["keepEventId required"]);
  }

  // Fetch the load's active events
  const { data: existingEventsRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (fetchErr || !existingEventsRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existingEvents = existingEventsRaw as unknown as Array<{
    id: string; end: string; relay_role: string | null;
  }>;
  if (existingEvents.length !== 2) {
    return badRequest(c, [`load must have exactly 2 events to unsplit; found ${existingEvents.length}`]);
  }

  const keep = existingEvents.find((e) => e.id === body.keepEventId);
  const drop = existingEvents.find((e) => e.id !== body.keepEventId);
  if (!keep || !drop) {
    return badRequest(c, ["keepEventId not found among this load's events"]);
  }

  // 1. Soft-delete the dropped event
  const now = new Date().toISOString();
  const { error: dropErr } = await supabase
    .from("events")
    .update({ deleted_at: now })
    .eq("id", drop.id)
    .eq("org_id", orgId);
  if (dropErr) {
    return c.json({ error: "drop_event_failed", detail: dropErr.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Update the kept event: clear relay_role, extend end to the later of the two
  const newEnd = keep.end > drop.end ? keep.end : drop.end;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: keepErr } = await supabase
    .from("events")
    .update({ end: newEnd, relay_role: null } as any)
    .eq("id", keep.id)
    .eq("org_id", orgId);
  if (keepErr) {
    // Revert the drop-event soft-delete on failure
    await supabase.from("events").update({ deleted_at: null }).eq("id", drop.id).eq("org_id", orgId);
    return c.json({ error: "keep_update_failed", detail: keepErr.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Drop the relay-marker stop from the kept event. Both legs share
  //    the full stops list (split-relay duplicates them); the kept event
  //    already has every real stop, so we just remove relay-type stops.
  await supabase
    .from("stops")
    .delete()
    .eq("event_id", keep.id)
    .eq("org_id", orgId)
    .eq("type", "relay");
  // Re-sequence remaining stops (1..N).
  const { data: remainingRaw } = await supabase
    .from("stops")
    .select("id")
    .eq("event_id", keep.id)
    .eq("org_id", orgId)
    .order("sequence", { ascending: true });
  const remaining = (remainingRaw ?? []) as Array<{ id: string }>;
  for (let i = 0; i < remaining.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("stops")
      .update({ sequence: i + 1 } as any)
      .eq("id", remaining[i].id)
      .eq("org_id", orgId);
  }
  // body.mergedStops is now ignored — the server reconstructs from the
  // kept event's existing stops minus the relay marker. Field accepted
  // for API back-compat but not used.
  void body.mergedStops;

  const joined = await fetchLoadJoined(loadId, orgId);
  const res: UnsplitRelayResponse = { loads: joined ?? [] };
  return c.json(res);
});

// Mount the per-load check-calls subroutes here so Hono's path merging
// produces /v1/loads/:loadId/check-calls cleanly.
loads.route("/:loadId/check-calls", checkCallsScopedRouter);

export default loads;
