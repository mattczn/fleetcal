/**
 * /v1/reports — load-shaped aggregations for dashboards + accounting.
 *
 * Distinct from /v1/loads (which is *events*-flavored — one row per leg
 * with the parent load joined onto each event row). This module queries
 * the `loads` table as the primary entity and elevates the pickup leg's
 * event-level fields onto each load so consumers can render one row per
 * load without doing client-side dedupe.
 *
 * Endpoints:
 *   GET /v1/reports/loads — list LoadSummary[]
 *
 * Filter semantics:
 *   pickupFrom / pickupTo     — pickup leg start in [pickupFrom, pickupTo]
 *   deliveryFrom / deliveryTo — delivery leg end   in [deliveryFrom, deliveryTo]
 *   brokers                   — case-insensitive broker name match
 *   customerIds               — exact customer uuid match
 *   status                    — pickup leg status match (any-of)
 *   billingStatus             — load.billing_status match (any-of)
 *   includeDeleted=true       — include soft-deleted loads
 *
 * Pickup vs delivery filters compose AND. They're applied AFTER fetching
 * because we filter on per-leg fields that aren't on the loads table.
 */

import { Hono } from "hono";
import {
  type LoadSummary,
  type LegSummary,
  type ListLoadSummariesResponse,
  type ApiErrorResponse,
  type Accessorial,
  type InternalNote,
  type LoadAuditEntry,
  type RefNum,
  type Stop,
  type StopType,
  type LoadStatus,
  LOAD_STATUSES,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { loadExcludedDrivers, loadExcludedAssetIds, isExcludedEvent } from "../lib/reportExclusions.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

const reports = new Hono<{ Variables: AuthVariables }>();

// Everything under /v1/reports needs reports.access — same set as
// dashboard.access in practice today, kept distinct so a future
// "view dashboard only / no exports" role can be carved out.
reports.use("*", requireCapability("reports.access"));

// ── Row shapes (snake_case from Postgres) ──────────────────────────────

interface LoadRow {
  id:               string;
  internal_load_id: number;
  load_num:         string | null;
  broker:           string | null;
  customer_id:      string | null;
  dispatcher:       string | null;
  created_by_name:  string | null;
  load_price:       number | null;
  /** Server-computed: load_price + billable accessorials. Maintained by
   *  the loads_compute_total_billable BEFORE trigger. */
  total_billable:   number | null;
  rate_con_pdf:     string | null;
  accessorials:     unknown;
  ref_nums:         string | null;
  notes:            string | null;
  internal_notes:   unknown;
  // Load-level fields migrated off events.
  commodity:        string | null;
  weight:           number | null;
  billing_status:   string | null;
  flagged_reason:   string | null;
  flagged_note:     string | null;
  flagged_at:       string | null;
  flagged_by:       string | null;
  verified_at:      string | null;
  verified_by:      string | null;
  invoice_doc_ids:  string[] | null;
  is_tonu:          boolean | null;
  /** Denormalized per-load doc counts maintained by DB trigger.
   *  Shape: { rate_con?: number; pod?: number; bol?: number; ... } */
  document_counts:  Record<string, number> | null;
  audit_log:        unknown;
  deleted_at:       string | null;
  created_at:       string | null;
  updated_at:       string | null;
}

interface EventRow {
  id:           string;
  load_id:      string | null;
  /** Calendar title surfaced as the pickup-leg title on LoadSummary so
   *  single-row consumers (accounting, reports) have a label without
   *  joining back to events. */
  title:        string | null;
  asset_id:     number;
  driver_id:    number | null;
  driver_name:  string | null;
  driver_pay:   number | null;
  start:        string;
  end:          string;
  status:       string;
  priority:     boolean | null;
  relay_role:   string | null;
  loaded_miles: number | null;
  trailer_id:   number | null;
  trailer_type: string | null;
}

interface StopRow {
  id:             string;
  event_id:       string;
  sequence:       number;
  type:           string;
  facility_name:  string | null;
  address:        string | null;
  city:           string | null;
  state:          string | null;
  timezone:       string | null;
  appt_start:     string | null;
  appt_end:       string | null;
  schedule_type:  string | null;
  lat:            number | null;
  lng:            number | null;
  instructions:   string | null;
  geocode_status: string | null;
  arrived_at:     string | null;
  arrived_lat:    number | null;
  arrived_lng:    number | null;
}

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,customer_id,dispatcher,created_by_name," +
  "load_price,total_billable,rate_con_pdf,accessorials,ref_nums,notes,internal_notes," +
  "commodity,weight," +
  "billing_status,flagged_reason,flagged_note,flagged_at,flagged_by," +
  "verified_at,verified_by,invoice_doc_ids,is_tonu,document_counts,audit_log," +
  "deleted_at,created_at,updated_at";

const EVENT_COLS =
  "id,load_id,title,asset_id,driver_id,driver_name,driver_pay,start,end,status,priority," +
  "relay_role,loaded_miles,trailer_id,trailer_type";

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

// ── Row → response converters ──────────────────────────────────────────

function parseJson<T>(raw: unknown): T | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as T; }
    catch { return undefined; }
  }
  return raw as T;
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

function eventToLeg(e: EventRow, stops: Stop[]): LegSummary {
  return {
    eventId:     e.id,
    relayRole:   (e.relay_role as "pickup" | "delivery" | null) ?? undefined,
    start:       e.start,
    end:         e.end,
    status:      e.status as LoadStatus,
    priority:    e.priority ?? undefined,
    assetId:     e.asset_id,
    driverId:    e.driver_id ?? undefined,
    driverName:  e.driver_name ?? undefined,
    driverPay:   e.driver_pay ?? undefined,
    loadedMiles: e.loaded_miles ?? undefined,
    trailerId:   e.trailer_id ?? undefined,
    stops:       stops.sort((a, b) => a.sequence - b.sequence),
  };
}

/** Pick which event of a load represents its pickup vs delivery side.
 *  A single-leg load returns the same event for both roles — the
 *  delivery side is just "where it ended up." */
function partitionLegs(events: EventRow[]): { pickup: EventRow; delivery: EventRow } {
  if (events.length === 0) {
    throw new Error("load has no events");
  }
  if (events.length === 1) {
    return { pickup: events[0], delivery: events[0] };
  }
  const pickup   = events.find(e => e.relay_role === "pickup")   ?? events[0];
  const delivery = events.find(e => e.relay_role === "delivery") ?? events[events.length - 1];
  return { pickup, delivery };
}

function sumOptional(values: Array<number | null | undefined>): number | undefined {
  let total = 0;
  let any = false;
  let allKnown = true;
  for (const v of values) {
    if (v == null) { allKnown = false; continue; }
    any = true;
    total += v;
  }
  // For loadedMiles we want undefined if ANY leg is missing — partial
  // is misleading. For driverPay we want the sum of known legs. The
  // caller picks via two helpers below.
  return { total, any, allKnown } as unknown as number | undefined;
}

// Force the discriminated return into typed helpers for clarity.
function sumStrict(values: Array<number | null | undefined>): number | undefined {
  const tmp = sumOptional(values) as unknown as { total: number; any: boolean; allKnown: boolean };
  if (!tmp.allKnown) return undefined;
  return tmp.any ? tmp.total : undefined;
}
function sumLenient(values: Array<number | null | undefined>): number | undefined {
  const tmp = sumOptional(values) as unknown as { total: number; any: boolean; allKnown: boolean };
  return tmp.any ? tmp.total : undefined;
}

function buildLoadSummary(load: LoadRow, events: EventRow[], stopsByEvent: Map<string, Stop[]>): LoadSummary {
  const sortedEvents = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const { pickup, delivery } = partitionLegs(sortedEvents);
  const isRelay = sortedEvents.length > 1;

  const legs: LegSummary[] = sortedEvents.map(e => eventToLeg(e, stopsByEvent.get(e.id) ?? []));

  // Flatten stops in leg order. No deduplication needed — each stop
  // belongs to exactly one event in the DB schema, even on relays.
  const stops: Stop[] = legs.flatMap(l => l.stops);

  return {
    loadId:           load.id,
    internalLoadId:   load.internal_load_id,
    loadNum:          load.load_num ?? undefined,
    isRelay,
    // Pickup-leg title elevated to load level so single-row consumers
    // (accounting page, reports) have a label without joining events.
    title:            pickup.title ?? undefined,

    broker:           load.broker ?? undefined,
    customerId:       load.customer_id ?? undefined,
    dispatcher:       load.dispatcher ?? undefined,
    createdByName:    load.created_by_name ?? undefined,

    loadPrice:        load.load_price ?? undefined,
    // Server-computed (loads_compute_total_billable trigger). Read-only
    // mirror of load_price + billable accessorials. UI shows it only
    // when it differs from loadPrice.
    totalBillable:    load.total_billable ?? undefined,
    accessorials:     parseJson<Accessorial[]>(load.accessorials),

    commodity:        load.commodity ?? undefined,
    weight:           load.weight ?? undefined,
    // trailer_type lives per-leg on events; surface the pickup leg's
    // value as the load-level representative.
    trailerType:      pickup.trailer_type ?? undefined,
    refNums:          parseJson<RefNum[]>(load.ref_nums),
    rateConPdf:       load.rate_con_pdf ?? undefined,

    notes:            load.notes ?? undefined,
    internalNotes:    parseJson<InternalNote[]>(load.internal_notes),

    billingStatus:    (load.billing_status as LoadSummary["billingStatus"]) ?? undefined,
    flaggedReason:    load.flagged_reason ?? undefined,
    flaggedNote:      load.flagged_note ?? undefined,
    flaggedAt:        load.flagged_at ?? undefined,
    flaggedBy:        load.flagged_by ?? undefined,
    verifiedAt:       load.verified_at ?? undefined,
    verifiedBy:       load.verified_by ?? undefined,
    invoiceDocIds:    load.invoice_doc_ids ?? undefined,
    isTonu:           load.is_tonu ?? undefined,
    documentCounts:   load.document_counts ?? undefined,

    auditLog:         parseJson<LoadAuditEntry[]>(load.audit_log),

    pickupAt:         pickup.start,
    pickupAssetId:    pickup.asset_id,
    pickupDriverId:   pickup.driver_id ?? undefined,
    pickupDriverName: pickup.driver_name ?? undefined,
    pickupDriverPay:  pickup.driver_pay ?? undefined,
    pickupStatus:     pickup.status as LoadStatus,
    pickupPriority:   pickup.priority ?? undefined,
    pickupLoadedMiles: pickup.loaded_miles ?? undefined,

    deliveryAt:        delivery.end,
    deliveryAssetId:   delivery.asset_id,
    deliveryDriverId:  delivery.driver_id ?? undefined,
    deliveryDriverName: delivery.driver_name ?? undefined,
    deliveryDriverPay: delivery.driver_pay ?? undefined,
    deliveryStatus:    delivery.status as LoadStatus,
    deliveryLoadedMiles: delivery.loaded_miles ?? undefined,

    totalLoadedMiles:  sumStrict(sortedEvents.map(e => e.loaded_miles)),
    totalDriverPay:    sumLenient(sortedEvents.map(e => e.driver_pay)),

    stops,
    legs,

    deletedAt:        load.deleted_at ?? undefined,
    createdAt:        load.created_at ?? undefined,
    updatedAt:        load.updated_at ?? undefined,
  };
}

// ── GET /v1/reports/loads ──────────────────────────────────────────────

reports.get("/loads", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const q = url.searchParams;

  const pickupFrom    = q.get("pickupFrom")   ?? undefined;
  const pickupTo      = q.get("pickupTo")     ?? undefined;
  const deliveryFrom  = q.get("deliveryFrom") ?? undefined;
  const deliveryTo    = q.get("deliveryTo")   ?? undefined;
  const brokersParam  = q.get("brokers")      ?? undefined;
  const customersParam = q.get("customerIds") ?? undefined;
  const statusParam   = q.get("status")       ?? undefined;
  const billingParam  = q.get("billingStatus") ?? undefined;
  const includeDeleted = q.get("includeDeleted") === "true";
  // Pagination is opt-in. When the caller passes ?limit explicitly
  // (accounting page does this with its BUCKET_LIMIT), honor it. When
  // omitted (dashboard's case), return EVERYTHING — capping silently
  // at 1000 was the bug that made the dashboard report $768K when the
  // real total was ~$1.84M. The inner loads-table query pages through
  // Supabase already, so there's no perf reason to truncate here.
  const explicitLimit = q.get("limit");
  const limit  = explicitLimit ? Math.min(Math.max(parseInt(explicitLimit, 10) || 1000, 1), 10000) : Infinity;
  const offset = Math.max(parseInt(q.get("offset") ?? "0", 10) || 0, 0);

  // Validate status values up front.
  let statusList: LoadStatus[] | undefined;
  if (statusParam) {
    const parts = statusParam.split(",").map(s => s.trim()).filter(Boolean);
    const invalid = parts.filter(s => !LOAD_STATUSES.includes(s as LoadStatus));
    if (invalid.length) {
      return c.json(
        { error: "validation_failed", errors: [`unknown status values: ${invalid.join(",")}`] } satisfies ApiErrorResponse,
        400,
      );
    }
    statusList = parts as LoadStatus[];
  }

  // ── Stage 1: query the loads table ─────────────────────────────────
  //
  // Page through results — Supabase / PostgREST caps a single response
  // at 1000 rows by default. Without paging, an org with >1000 loads
  // (e.g. after the Alvys historical import) silently truncates to
  // the first 1000, which the dashboard shows as "$768K across 990
  // loads" when the actual total should be much higher.
  const buildLoadsQuery = () => {
    let q = supabase
      .from("loads")
      .select(LOAD_COLS)
      .eq("org_id", orgId)
      .order("id", { ascending: true });

    if (!includeDeleted) q = q.is("deleted_at", null);

    if (brokersParam) {
      const names = brokersParam.split(",").map(s => s.trim()).filter(Boolean);
      const escaped = names.map(n => n.replace(/[%,()"]/g, "\\$&"));
      const orFilter = escaped.map(n => `broker.ilike."${n}"`).join(",");
      q = q.or(orFilter);
    }

    if (customersParam) {
      const ids = customersParam.split(",").map(s => s.trim()).filter(Boolean);
      q = q.in("customer_id", ids);
    }

    if (billingParam) {
      const statuses = billingParam.split(",").map(s => s.trim()).filter(Boolean);
      q = q.in("billing_status", statuses);
    }

    return q;
  };

  // Short-circuit when a filter param was supplied but empty (matches old behavior).
  if (brokersParam   && brokersParam.split(",").map(s => s.trim()).filter(Boolean).length   === 0) return c.json({ loads: [], total: 0 } satisfies ListLoadSummariesResponse);
  if (customersParam && customersParam.split(",").map(s => s.trim()).filter(Boolean).length === 0) return c.json({ loads: [], total: 0 } satisfies ListLoadSummariesResponse);
  if (billingParam   && billingParam.split(",").map(s => s.trim()).filter(Boolean).length   === 0) return c.json({ loads: [], total: 0 } satisfies ListLoadSummariesResponse);

  const LOAD_PAGE = 1000;
  let allLoads: LoadRow[] = [];
  let loadOffset = 0;
  while (true) {
    const { data: loadRows, error: loadErr } = await buildLoadsQuery().range(loadOffset, loadOffset + LOAD_PAGE - 1);
    if (loadErr) {
      console.error(`[GET /v1/reports/loads] loads query failed at offset ${loadOffset}:`, loadErr);
      return c.json({ error: "list_failed", detail: loadErr.message } satisfies ApiErrorResponse, 500);
    }
    const batch = (loadRows ?? []) as unknown as LoadRow[];
    allLoads = allLoads.concat(batch);
    if (batch.length < LOAD_PAGE) break;
    loadOffset += batch.length;
  }
  if (allLoads.length === 0) {
    return c.json({ loads: [], total: 0 } satisfies ListLoadSummariesResponse);
  }

  // ── Stage 2: fetch every event whose load_id is in our load set ───
  //
  // PostgREST encodes `.in("col", [ids])` into the request URL. With
  // ~400+ loads (typical for a one-month report), the URL pushes past
  // Node's 16KB header limit and the underlying TLS socket throws
  // HeadersOverflowError. Batch the IN-list so each request stays
  // well under the cap — 200 UUIDs ≈ 7.5KB which leaves room for
  // auth headers, the SELECT clause, and other params.
  const loadIds = allLoads.map(l => l.id);
  const BATCH = 200;
  const eventRows: EventRow[] = [];
  for (let i = 0; i < loadIds.length; i += BATCH) {
    const slice = loadIds.slice(i, i + BATCH);
    const { data, error: evErr } = await supabase
      .from("events")
      .select(EVENT_COLS)
      .eq("org_id", orgId)
      // Exclude soft-deleted events. Without this filter, a load
      // whose ONLY events have been deleted still surfaces in
      // LoadSummary — buildLoadSummary picks pickupAt off the
      // zombie event, the report includes the load, and the
      // dashboard's revenue total over-counts. We diagnosed this
      // against Curzon's data: 2 phantom Uber Freight loads and a
      // chain of test loads were inflating Dashboard's count vs
      // Payroll's. Filter here keeps both surfaces in agreement.
      .is("deleted_at", null)
      .in("load_id", slice);
    if (evErr) {
      console.error("[GET /v1/reports/loads] events query failed:", evErr);
      return c.json({ error: "list_failed", detail: evErr.message } satisfies ApiErrorResponse, 500);
    }
    for (const e of (data ?? []) as unknown as EventRow[]) eventRows.push(e);
  }
  // Drop events whose driver is flagged exclude_from_reports (owner-op
  // support). Filtering events — rather than loads — means a mixed
  // load (one leg owner-op, one leg company) loses just the excluded
  // leg from rollups; the load itself still surfaces if any leg
  // remains. Loads whose every leg was excluded fall out of the
  // report naturally because buildLoadSummary requires at least one
  // surviving event.
  const excluded = await loadExcludedDrivers(orgId);
  // Trucks flagged exclude_from_reports drop out entirely, regardless of
  // driver — so an owner-op truck that the owner occasionally runs a load
  // on still stays out of the rollups.
  const excludedAssets = await loadExcludedAssetIds(orgId);
  const eventsByLoad = new Map<string, EventRow[]>();
  for (const e of eventRows) {
    if (!e.load_id) continue;
    if (isExcludedEvent(excluded, e)) continue;
    if (e.asset_id != null && excludedAssets.has(e.asset_id)) continue;
    const arr = eventsByLoad.get(e.load_id) ?? [];
    arr.push(e);
    eventsByLoad.set(e.load_id, arr);
  }

  // ── Stage 3: stops in batched queries (same header-limit reason) ───
  const eventIds = eventRows.map(e => e.id);
  const stopsByEvent = new Map<string, Stop[]>();
  for (let i = 0; i < eventIds.length; i += BATCH) {
    const slice = eventIds.slice(i, i + BATCH);
    if (slice.length === 0) continue;
    const { data: stopRows, error: stopErr } = await supabase
      .from("stops")
      .select(STOP_COLS)
      .in("event_id", slice);
    if (stopErr) {
      console.error("[GET /v1/reports/loads] stops query failed:", stopErr);
      return c.json({ error: "list_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
    for (const s of (stopRows ?? []) as unknown as StopRow[]) {
      const arr = stopsByEvent.get(s.event_id) ?? [];
      arr.push(rowToStop(s));
      stopsByEvent.set(s.event_id, arr);
    }
  }

  // ── Stage 3.5: latest POD upload time per load ────────────────────
  // Used by the drivers scorecard to compute "POD within 24h of
  // delivery." We pull max(uploaded_at) WHERE kind='pod' for the
  // loads in this report window — one query in BATCH chunks,
  // grouped client-side. Cheap enough to include in every list
  // response; only the drivers page reads it today, but it's a
  // natural extension of documentCounts which other report
  // consumers might want later.
  const podUploadedAtByLoad = new Map<string, string>();
  for (let i = 0; i < loadIds.length; i += BATCH) {
    const slice = loadIds.slice(i, i + BATCH);
    if (slice.length === 0) continue;
    const { data: podRows, error: podErr } = await supabase
      .from("load_documents")
      .select("load_id, uploaded_at")
      .eq("org_id", orgId)
      .eq("kind", "pod")
      .in("load_id", slice)
      .order("uploaded_at", { ascending: false });
    if (podErr) {
      console.warn("[GET /v1/reports/loads] POD upload times query failed (non-fatal):", podErr.message);
      break; // skip enrichment; consumers see undefined and fall back gracefully
    }
    for (const r of (podRows ?? []) as Array<{ load_id: string | null; uploaded_at: string }>) {
      if (!r.load_id) continue;
      // First row per load wins (ordered desc by uploaded_at).
      if (!podUploadedAtByLoad.has(r.load_id)) {
        podUploadedAtByLoad.set(r.load_id, r.uploaded_at);
      }
    }
  }

  // ── Stage 4: build LoadSummary[] ───────────────────────────────────
  let summaries: LoadSummary[] = [];
  for (const load of allLoads) {
    const evs = eventsByLoad.get(load.id) ?? [];
    if (evs.length === 0) continue; // orphan load with no events — skip
    const s = buildLoadSummary(load, evs, stopsByEvent);
    s.podUploadedAt = podUploadedAtByLoad.get(load.id);
    summaries.push(s);
  }

  // ── Stage 5: post-fetch filters on per-leg fields ──────────────────
  if (pickupFrom) summaries = summaries.filter(s => s.pickupAt >= pickupFrom);
  if (pickupTo)   summaries = summaries.filter(s => s.pickupAt <= pickupTo);
  if (deliveryFrom) summaries = summaries.filter(s => s.deliveryAt >= deliveryFrom);
  if (deliveryTo)   summaries = summaries.filter(s => s.deliveryAt <= deliveryTo);
  if (statusList) summaries = summaries.filter(s => statusList!.includes(s.pickupStatus));

  // ── Stage 6: sort + paginate ───────────────────────────────────────
  summaries.sort((a, b) => b.pickupAt.localeCompare(a.pickupAt));
  const total = summaries.length;
  const paged = summaries.slice(offset, offset + limit);

  const res: ListLoadSummariesResponse = { loads: paged, total };
  return c.json(res);
});

export default reports;
