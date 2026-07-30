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
  legRoleFor,
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
  type ConfigureLegsRequest,
  type ConfigureLegsResponse,
  isHandoffStop,
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
import { ensureEventRouteCached } from "../lib/routeGeometry.js";
import { getUserDisplayName } from "../lib/clerk.js";
import { appendEventAudit, appendLoadAudit } from "../lib/auditLog.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { checkCallsScopedRouter } from "./check-calls.js";

const loads = new Hono<{ Variables: AuthVariables }>();

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Haversine distance in miles. Used only to weight a leg's share of a
 * load at INSERT time, when routed miles don't exist yet — the same
 * approximation apps/web/lib/legMiles.ts uses for the revenue split.
 */
function straightLineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const STOP_COLS =
  "id,event_id,sequence,type,facility_name,address,city,state,timezone," +
  "appt_start,appt_end,schedule_type,is_handoff,handoff_drop_at,handoff_pickup_at," +
  "lat,lng,instructions,geocode_status," +
  "arrived_at,arrived_lat,arrived_lng";

const EVENT_COLS =
  "id,asset_id,driver_id,driver_name,title,start,end,status,priority," +
  "notes,driver_pay,loaded_miles,deferred_to_week,relay_role,leg_index,event_kind,non_revenue_type,trailer_id," +
  "trailer_type,deleted_at,load_id,created_at,updated_at," +
  "confirmed_at,confirmed_by,confirm_reminder_sent_at," +
  "trailer_dropoff_lat,trailer_dropoff_lng,trailer_dropoff_at,trailer_dropoff_address," +
  "route_polyline,route_stops_key";

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
  is_handoff: boolean | null;
  handoff_drop_at: string | null;
  handoff_pickup_at: string | null;
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
    isHandoff:  s.is_handoff ?? undefined,
    handoffDropAt:  s.handoff_drop_at ?? undefined,
    handoffPickupAt:  s.handoff_pickup_at ?? undefined,
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
 * Fetch the joined Load[] view for a single load id — one entry per leg,
 * in leg order (single-leg loads return one entry). Returns null if the
 * load doesn't exist or doesn't belong to the org. Stops are populated
 * and sorted by sequence.
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
    .order("leg_index", { ascending: true })
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

  const legCount = eventRows.filter((e) => !e.deleted_at).length || eventRows.length;
  return Promise.all(eventRows.map(async (ev) => {
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.legCount = legCount;
    joined.stops = (stopsByEvent.get(ev.id) ?? []).slice().sort(
      (a, b) => a.sequence - b.sequence,
    );
    // Warm the route-geometry cache (route_polyline + loaded_miles) so a
    // load written here (create, split-relay, unsplit-relay) gets its
    // routed miles computed the moment its stops are saved — not only when
    // a human later re-opens it in the modal. Relay-aware so each leg's
    // miles reflect just its own hauled distance. No-op on a cache hit;
    // at most one Mapbox call per cold event; never throws.
    const cached = await ensureEventRouteCached(ev.id, joined.stops, {
      routePolyline: joined.routePolyline,
      routeStopsKey: (ev.route_stops_key as string | null) ?? null,
      loadedMiles:   joined.loadedMiles ?? null,
    }, joined.relayRole ? { legIndex: joined.legIndex ?? 0, legCount } : null);
    joined.routePolyline = cached.routePolyline ?? undefined;
    joined.loadedMiles   = cached.loadedMiles ?? undefined;
    return joined;
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;

/** Bad-request helper. Caller passes the Hono context. */
function badRequest(c: AnyHonoContext, errors: string[]) {
  const res: ApiErrorResponse = { error: "validation_failed", errors };
  return c.json(res, 400);
}

/**
 * Server-side accessorial diff used by PATCH /v1/loads/:id to record
 * create / update / delete events into the load's audit log. Mirrors
 * apps/web/components/calendar/EventModal.tsx::diffAccessorials so
 * the EventModal-edit and load-detail-page-edit paths produce
 * structurally identical AccessorialChange[] entries.
 *
 * The shape `ServerAccessorialSnapshot` is the loose union of fields
 * we actually compare; using `unknown[k]` via index sig keeps us
 * forward-compatible with closeout adding more fields to the JSONB
 * (approvedAt etc.) without false-flagging those as "changes."
 */
interface ServerAccessorialSnapshot {
  id?:             string;
  category?:       string;
  description?:    string;
  amount?:         number;
  billable?:       boolean;
  status?:         string;
  payToDriver?:    boolean;
  payDriverName?:  string;
  // Anything else (closeout-owned approvedAt/approvedBy/etc.) is
  // intentionally absent from the comparable set.
  [k: string]:     unknown;
}
function diffAccessorialsForAudit(
  prev: ServerAccessorialSnapshot[],
  next: ServerAccessorialSnapshot[],
): import("@fleetcal/types").AccessorialChange[] {
  const changes: import("@fleetcal/types").AccessorialChange[] = [];
  const prevMap = new Map<string, ServerAccessorialSnapshot>();
  const nextMap = new Map<string, ServerAccessorialSnapshot>();
  for (const a of prev) if (a?.id) prevMap.set(a.id, a);
  for (const a of next) if (a?.id) nextMap.set(a.id, a);

  // Added → in next, not in prev
  for (const [id, a] of nextMap) {
    if (prevMap.has(id)) continue;
    changes.push({
      action:        "added",
      id,
      category:      a.category ?? "other",
      description:   a.description,
      amount:        typeof a.amount === "number" ? a.amount : undefined,
      newStatus:     a.status,
      newBillable:   a.billable,
      newPayToDriver:   a.payToDriver,
      newPayDriverName: a.payDriverName,
    });
  }

  // Removed → in prev, not in next. Snapshot the prev values so the
  // log is still readable after the row is gone.
  for (const [id, a] of prevMap) {
    if (nextMap.has(id)) continue;
    changes.push({
      action:        "removed",
      id,
      category:      a.category ?? "other",
      description:   a.description,
      amount:        typeof a.amount === "number" ? a.amount : undefined,
      prevStatus:    a.status,
      prevBillable:  a.billable,
      prevPayToDriver:   a.payToDriver,
      prevPayDriverName: a.payDriverName,
    });
  }

  // Updated → in both, but at least one comparable field differs.
  // Only the pairs that actually changed get populated.
  for (const [id, a] of nextMap) {
    const p = prevMap.get(id);
    if (!p) continue;
    const amountChanged       = (p.amount        ?? 0)     !== (a.amount        ?? 0);
    const statusChanged       = (p.status        ?? "")    !== (a.status        ?? "");
    const billableChanged     = !!p.billable               !== !!a.billable;
    const payToDriverChanged  = !!p.payToDriver            !== !!a.payToDriver;
    const payNameChanged      = (p.payDriverName  ?? "")   !== (a.payDriverName  ?? "");
    const categoryChanged     = (p.category       ?? "")   !== (a.category       ?? "");
    const descriptionChanged  = (p.description    ?? "")   !== (a.description    ?? "");
    if (!(amountChanged || statusChanged || billableChanged ||
          payToDriverChanged || payNameChanged ||
          categoryChanged || descriptionChanged)) continue;
    changes.push({
      action:        "updated",
      id,
      category:      a.category ?? "other",
      description:   a.description,
      ...(amountChanged       ? { prevAmount: p.amount, amount: a.amount } : {}),
      ...(statusChanged       ? { prevStatus: p.status, newStatus: a.status } : {}),
      ...(billableChanged     ? { prevBillable: !!p.billable, newBillable: !!a.billable } : {}),
      ...(payToDriverChanged  ? { prevPayToDriver: !!p.payToDriver, newPayToDriver: !!a.payToDriver } : {}),
      ...(payNameChanged      ? { prevPayDriverName: p.payDriverName, newPayDriverName: a.payDriverName } : {}),
      ...(categoryChanged     ? { prevCategory: p.category } : {}),
      ...(descriptionChanged  ? { prevDescription: p.description, newDescription: a.description } : {}),
    });
  }
  return changes;
}

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads — create a load (1..N events, one per leg in leg order)
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
    if (body.events.length < 1 || body.events.length > 10) {
      errors.push("'events' must have 1..10 entries");
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
  //
  // Default status follows the same auto-flip rule as PATCH events:
  // a leg created WITH a driver already on it is `assigned` (driver
  // is on the load but hasn't confirmed yet), a leg without a driver
  // is `scheduled`. The caller can still override by passing `status`
  // explicitly — useful for rate-con AI that already knows the driver
  // confirmed verbally, or for manual closeout backfills.
  // Leg order = array order. Back-compat: legacy 2-leg callers identified
  // legs by relayRole rather than position, so honor an explicit
  // [delivery, pickup] ordering by swapping before positions are assigned.
  const orderedEvents =
    body.events.length === 2 &&
    body.events[0].relayRole === "delivery" &&
    body.events[1].relayRole === "pickup"
      ? [body.events[1], body.events[0]]
      : body.events;

  // ── Driver-pay auto-fill ────────────────────────────────────────────
  // When the org has configured a driverPayPct and the dispatcher who
  // created the load didn't supply driver_pay (typically because they
  // don't have payroll visibility), compute it server-side so reports
  // stay accurate regardless of who created the load.
  //
  // LEG-AWARE. A leg's pay base is that LEG's share of the price, not
  // the whole price — otherwise every leg of a 3-leg load is created
  // carrying the whole load's pay and the load pays out 3×. The share
  // rule mirrors apps/web/lib/legPay.ts exactly: miles-prorated, with an
  // even 1/N split whenever any leg's distance can't be established.
  // Single-leg loads are the same rule with N = 1 (share === price).
  //
  // Distance comes from straight-line stop coords, which is all we have
  // at insert time (routed miles are cached lazily later). Un-geocoded
  // stops simply fall through to the even split.
  const autoDriverPayByIdx: Array<number | null> = orderedEvents.map(() => null);
  {
    const linehaul = typeof body.load.loadPrice === "number" ? body.load.loadPrice : null;
    if (linehaul && linehaul > 0) {
      const { data: settingsRow } = await supabase
        .from("org_settings")
        .select("rate_con_settings")
        .eq("org_id", orgId)
        .maybeSingle();
      const rcs = (settingsRow as { rate_con_settings: { driverPayPct?: number } | null } | null)?.rate_con_settings;
      const pct = typeof rcs?.driverPayPct === "number" ? rcs.driverPayPct : null;
      if (pct != null && pct > 0) {
        const legMiles = orderedEvents.map((ev) => {
          const pts = (ev.stops ?? []).filter(
            (st): st is typeof st & { lat: number; lng: number } => st.lat != null && st.lng != null,
          );
          if (pts.length < 2) return null;
          let total = 0;
          for (let i = 1; i < pts.length; i++) {
            total += straightLineMiles(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
          }
          return total > 0 ? total : null;
        });
        const n = orderedEvents.length;
        const knownAll = n > 1 && legMiles.every((m) => m != null);
        const totalMiles = knownAll ? legMiles.reduce<number>((sum, m) => sum + (m ?? 0), 0) : 0;
        orderedEvents.forEach((ev, i) => {
          // Never overwrite a pay figure the caller actually sent.
          if (ev.driverPay != null && ev.driverPay !== 0) return;
          const share = n <= 1
            ? 1
            : (knownAll && totalMiles > 0 ? (legMiles[i] ?? 0) / totalMiles : 1 / n);
          autoDriverPayByIdx[i] = Math.round(linehaul * share * (pct / 100) * 100) / 100;
        });
        console.log(
          `[POST /v1/loads] auto-filled driver_pay ${JSON.stringify(autoDriverPayByIdx)} `
          + `(linehaul=${linehaul} × ${pct}% across ${n} leg${n === 1 ? "" : "s"}, `
          + `${n <= 1 ? "single leg" : knownAll ? "miles-prorated" : "even split — leg miles unknown"}) for load ${loadRow.id}`,
        );
      }
    }
  }
  const eventInserts = orderedEvents.map((ev, i) =>
    appLoadToEventInsert(
      {
        ...ev,
        loadId:    loadRow.id,
        eventKind: "revenue",
        status:    ev.status ?? (ev.driverId != null ? "assigned" : "scheduled"),
        // Per-leg auto-fill (leg share × pct); null whenever the caller
        // supplied a figure or the org has no configured percentage.
        driverPay: autoDriverPayByIdx[i] != null ? autoDriverPayByIdx[i]! : ev.driverPay,
        // Position is authoritative: leg_index from array order,
        // relay_role derived (first=pickup, last=delivery, mid=transfer).
        legIndex:  i,
        relayRole: legRoleFor(i, orderedEvents.length),
        stops:     [],
      },
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

  // 3. Insert stops (orderedEvents — same ordering eventRows was inserted in)
  const stopInserts = orderedEvents.flatMap((ev, i) =>
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
      is_handoff:  s.isHandoff ?? false,
      handoff_drop_at:  s.handoffDropAt ?? null,
      handoff_pickup_at:  s.handoffPickupAt ?? null,
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

  // Joined fetch via PostgREST nested select.
  //
  // Built as a factory so we can re-issue it with a fresh `.range()` on
  // every page. PostgREST silently caps each response at 1000 rows; on
  // a YTD-sized window with thousands of historical events this clips
  // most of the dataset, which surfaces as "Revenue Over Time chart
  // missing months" + "calendar looks unchanged" because the events
  // store (useCalendarStore) is fed from this endpoint.
  //
  // Mirrors the paging pattern in /v1/reports/loads.
  const buildEventsQuery = () => {
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
    return q;
  };

  type EventRow = Record<string, unknown>;
  const EVENT_PAGE = 1000;
  const rows: EventRow[] = [];
  let evOffset = 0;
  while (true) {
    const { data, error } = await buildEventsQuery().range(evOffset, evOffset + EVENT_PAGE - 1);
    if (error) {
      console.error(`[GET /v1/loads] query failed at offset ${evOffset}:`, error);
      return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
    }
    const batch = (data ?? []) as unknown as EventRow[];
    rows.push(...batch);
    if (batch.length < EVENT_PAGE) break;
    evOffset += batch.length;
  }

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
  //
  // ref_nums is a jsonb array of {label,value} pairs (Order #, PO #,
  // BOL, etc). Cast to text and ilike for partial matching — the
  // surface area is small (~2k loads org-wide) so a sequential scan
  // is fine without an index. If this ever needs to scale, add a
  // GIN index on to_tsvector(ref_nums::text).
  const loadOr = numericId !== null
    ? `internal_load_id.eq.${numericId},load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`
    : `load_num.ilike.${pattern},broker.ilike.${pattern},notes.ilike.${pattern}`;
  const loadIdsP = supabase
    .from("loads")
    .select("id")
    .eq("org_id", orgId)
    .or(loadOr)
    .limit(50);
  // Separate query for ref_nums — PostgREST .or() doesn't reliably
  // accept ::text casts inside the filter string. Running it in
  // parallel and unioning the result ids is the robust path.
  const refNumsIdsP = supabase
    .from("loads")
    .select("id")
    .eq("org_id", orgId)
    .filter("ref_nums::text", "ilike", pattern)
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

  const [loadIdsRes, refNumsIdsRes, eventMatchesRes] = await Promise.all([loadIdsP, refNumsIdsP, eventMatchesP]);
  if (loadIdsRes.error) {
    console.error("[GET /v1/loads/search] load-side query failed:", loadIdsRes.error);
    return c.json({ error: "search_failed", detail: loadIdsRes.error.message } satisfies ApiErrorResponse, 500);
  }
  if (refNumsIdsRes.error) {
    // Don't fail the whole search if the jsonb cast hiccups — log and
    // fall through with the standard load-side matches only.
    console.error("[GET /v1/loads/search] ref_nums query failed:", refNumsIdsRes.error);
  }
  if (eventMatchesRes.error) {
    console.error("[GET /v1/loads/search] event-side query failed:", eventMatchesRes.error);
    return c.json({ error: "search_failed", detail: eventMatchesRes.error.message } satisfies ApiErrorResponse, 500);
  }

  const matchedLoadIds = [...new Set([
    ...((loadIdsRes.data    ?? []) as Array<{ id: string }>).map(r => r.id),
    ...((refNumsIdsRes.data ?? []) as Array<{ id: string }>).map(r => r.id),
  ])];
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
    .select("id,load_id,invoice_id,storage_path,file_name,mime_type,size_bytes,kind,handoff_index,uploaded_at,included_in_invoice")
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
    kind: string; handoff_index: number | null; uploaded_at: string;
    included_in_invoice: boolean | null;
  };
  // Cast via unknown — the generated Supabase types don't know about
  // included_in_invoice until the user reruns the type pull after
  // the 20260607 migration is applied. The runtime always returns
  // the column once the migration has run.
  const docs = (rows ?? []) as unknown as DocRow[];

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
    id:                 d.id,
    loadId:             d.load_id,
    invoiceId:          d.invoice_id  ?? undefined,
    fileName:           d.file_name,
    mimeType:           d.mime_type   ?? undefined,
    sizeBytes:          d.size_bytes  ?? undefined,
    kind:               (d.kind as DocumentKind) ?? "other",
    handoffIndex:       d.handoff_index,
    uploadedAt:         d.uploaded_at,
    signedUrl:          urlByPath.get(d.storage_path),
    includedInInvoice:  d.included_in_invoice,
    storagePath:        d.storage_path,
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
import { isHeic } from "../lib/heicDetect.js";
import { heicToJpeg, rewriteHeicExtension } from "../lib/heicToJpeg.js";

loads.post("/:id/documents", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const loadId = c.req.param("id");

  let body: { file?: File; kind?: string; handoffIndex?: string };
  try { body = await c.req.parseBody() as { file?: File; kind?: string; handoffIndex?: string }; }
  catch (err) {
    console.error("[POST /v1/loads/:id/documents] parseBody:", err);
    return c.json({ error: "validation_failed", errors: ["multipart parse failed"] } satisfies ApiErrorResponse, 400);
  }
  const file = body.file;
  const kind = (body.kind ?? "other").toString();
  // relay_handoff docs may be keyed to a specific handoff ordinal (see
  // the driver upload endpoint) — same optional multipart field here so
  // dispatch-uploaded handoff photos land on the right exchange.
  const handoffIndexRaw = body.handoffIndex != null ? Number(body.handoffIndex) : null;
  const handoffIndex =
    kind === "relay_handoff" && handoffIndexRaw != null && Number.isInteger(handoffIndexRaw) && handoffIndexRaw >= 0
      ? handoffIndexRaw
      : null;
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

  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;

  // HEIC → JPEG transcode. iPhone shoots HEIC by default; pdf-lib
  // (and every browser preview path) can't render it. Before this
  // converted, HEIC uploads silently dropped from invoice packets
  // downstream — Curzon lost POD attachments on the 2026-06-17
  // batch because of exactly this. Now: detect by magic bytes,
  // re-encode as JPEG quality 0.9, store as .jpg. If the decode
  // throws (truncated / corrupted HEIC, OOM), we fall back to
  // rejection so the bad file never reaches load_documents.
  if (isHeic(bytes, file.type)) {
    try {
      const t0 = Date.now();
      const result = await heicToJpeg(bytes);
      bytes      = result.jpegBytes;
      uploadName = rewriteHeicExtension(file.name);
      uploadMime = "image/jpeg";
      console.log(
        "[POST /v1/loads/:id/documents] HEIC → JPEG converted:",
        file.name, `${result.originalBytes}B → ${bytes.length}B in ${Date.now() - t0}ms`,
      );
    } catch (err) {
      console.error("[POST /v1/loads/:id/documents] HEIC decode failed:", file.name, err);
      return c.json(
        {
          error:  "heic_decode_failed",
          detail: "Couldn't convert this HEIC photo. Re-export it as JPG (Photos → File → Export → JPEG) and re-upload.",
        } satisfies ApiErrorResponse,
        415,
      );
    }
  }

  const ext    = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const random = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${eventId}/${Date.now()}_${random}.${ext}`;

  // ─── Idempotency: collapse rapid-fire duplicate uploads ───────────
  // The user has reported single uploads producing 6 audit entries
  // ("BOL document uploaded" × 6 within the same minute). The
  // handler itself only writes once per request, so the root cause
  // is upstream — likely a rapid double-click before the button
  // disables, a browser/proxy retry on a slow response, or a
  // file-input onChange firing multiple times. Each retry generates
  // a unique storage path (Date.now() + random) so nothing collides
  // at the storage or row level; 6 distinct rows survive without a
  // dedup check.
  //
  // Defend with a 60-second window dedup keyed on (load_id, kind,
  // size_bytes). Two requests within 60s with identical kind +
  // byte count are overwhelmingly the same upload being retried.
  // A legitimate re-upload of a corrected file takes longer than
  // 60s in practice (file picker → review → click) and would differ
  // in bytes anyway. Previously this window was 5s but production
  // showed bursts spanning ~30-50s slipping past it. On match,
  // return the existing row instead of writing a second one — no
  // storage upload, no audit append.
  {
    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const { data: dupRow } = await supabase
      .from("load_documents")
      .select("id, load_id, storage_path, file_name, mime_type, size_bytes, kind, uploaded_at")
      .eq("load_id", loadId)
      .eq("org_id", orgId)
      .eq("kind", kind)
      .eq("size_bytes", bytes.length)
      .gt("uploaded_at", sinceIso)
      .order("uploaded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (dupRow) {
      const dup = dupRow as {
        id: string; load_id: string | null; storage_path: string;
        file_name: string; mime_type: string | null; size_bytes: number | null;
        kind: string; uploaded_at: string;
      };
      console.log(
        "[POST /v1/loads/:id/documents] coalesced duplicate upload",
        { loadId, kind, sizeBytes: bytes.length, existingId: dup.id },
      );
      return c.json({
        document: {
          id:         dup.id,
          loadId:     dup.load_id,
          fileName:   dup.file_name,
          mimeType:   dup.mime_type   ?? undefined,
          sizeBytes:  dup.size_bytes  ?? undefined,
          kind:       dup.kind        as "bol" | "pod" | "scale" | "other",
          uploadedAt: dup.uploaded_at,
        },
      });
    }
  }

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
  let displayName = uploadName;
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
      contentType: uploadMime || "application/octet-stream",
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
      mime_type:    uploadMime || null,
      size_bytes:   bytes.length,
      kind,
      handoff_index: handoffIndex,
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
    // PRESERVE-BEFORE-MIRROR: Legacy loads (Alvys imports, anything
    // pre-mirror-logic) carry their original rate-con as a bare
    // storage_path in loads.rate_con_pdf with no matching
    // load_documents row. If we mirror straight to the new upload,
    // that old path is orphaned — the file stays in storage but
    // nothing in the new system references it, so the sidebar can't
    // surface it and the dispatcher loses the original.
    // Fix: before overwriting loads.rate_con_pdf, check if the
    // existing path has a backing load_documents row. If not, mint
    // one so the legacy rate-con joins the kind=rate_con list and
    // stays visible alongside the new upload.
    const { data: loadRow } = await supabase
      .from("loads")
      .select("rate_con_pdf, load_num, created_at")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .maybeSingle();
    const existingPath = (loadRow as { rate_con_pdf: string | null } | null)?.rate_con_pdf ?? null;
    const existingLoadNum = (loadRow as { load_num: string | null } | null)?.load_num ?? null;
    const loadCreatedAt = (loadRow as { created_at: string | null } | null)?.created_at ?? null;
    if (existingPath && !existingPath.startsWith("data:") && existingPath !== storagePath) {
      // Does any load_document already point at this storage path?
      // (Covers the case where the mirror has already been wired and
      // the legacy row has a matching entry — no preservation needed.)
      const { data: existingRow } = await supabase
        .from("load_documents")
        .select("id")
        .eq("load_id", loadId)
        .eq("org_id", orgId)
        .eq("storage_path", existingPath)
        .limit(1)
        .maybeSingle();
      if (!existingRow) {
        // No backing row → mint one so the dispatcher can still see
        // and use the legacy rate-con after the new upload lands.
        // The filename guesses the same convention the regular
        // upload path uses; mime stays unknown (we don't fetch the
        // file just to sniff its bytes).
        const ext = existingPath.split(".").pop()?.toLowerCase() || "pdf";
        const safeNum = (existingLoadNum ?? "").replace(/[^A-Za-z0-9_-]/g, "");
        const legacyName = safeNum ? `${safeNum}_RATE_CON_LEGACY.${ext}` : `rate_con_legacy.${ext}`;
        // Time-stamp the legacy row at the load's own creation time
        // (best proxy we have for "when the rate-con originally
        // landed"). Falls back to 1s before the new upload's NOW so
        // the legacy row is GUARANTEED older than the upload that's
        // about to be inserted — that's what the "Primary" picker
        // sorts on (most recent uploadedAt wins). Without a strictly
        // earlier timestamp, both rows tied at NOW() and the legacy
        // row could win the primary slot via sort instability.
        const legacyUploadedAt = loadCreatedAt
          ?? new Date(Date.now() - 1000).toISOString();
        const { error: preserveErr } = await supabase
          .from("load_documents")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .insert({
            event_id:     eventId,
            load_id:      loadId,
            org_id:       orgId,
            storage_path: existingPath,
            file_name:    legacyName,
            mime_type:    null,
            size_bytes:   null,
            kind:         "rate_con",
            uploaded_at:  legacyUploadedAt,
          } as any);
        if (preserveErr) {
          console.warn(
            "[POST /v1/loads/:id/documents] legacy rate-con preserve failed:",
            preserveErr,
          );
          // Best-effort — keep going so the new upload still lands.
        }
      }
    }
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

  // Dispatcher document upload — write to events.audit_log so the
  // load modal's History panel can show "uploaded BOL.pdf · 3:14pm".
  // Mirrors driver.ts POST /v1/driver/loads/:id/documents, closing the
  // dispatcher-vs-driver asymmetry the audit revealed.
  const uploaderName = await getUserDisplayName(c.get("userId"));
  await appendEventAudit(eventId, orgId, {
    changedAt:        new Date().toISOString(),
    changedByName:    uploaderName ?? "Dispatcher",
    documentUploaded: { fileName: d.file_name, kind: d.kind },
  });

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
// GET /v1/loads/by-internal-id/:n — single load by org-scoped internal id
// ─────────────────────────────────────────────────────────────────────────
//
// Keyed by internal_load_id (the 5+ digit per-org numeric ID shown to
// dispatchers as "#10761"). The load detail page uses this so the URL
// reads /loads/10761 instead of a UUID. Returns the same shape as the
// uuid-keyed GET above: 1 entry for single-leg loads, 2 for relays.
//
// Declared BEFORE the uuid handler so the route matcher doesn't try
// to interpret "by-internal-id" as a uuid.

loads.get("/by-internal-id/:n", async (c) => {
  const orgId = c.get("orgId");
  const raw = c.req.param("n");
  const internalId = Number.parseInt(raw, 10);
  if (!Number.isFinite(internalId) || internalId <= 0 || internalId > 2_147_483_647) {
    return c.json({ error: "invalid_internal_id" } satisfies ApiErrorResponse, 400);
  }

  // Look up the uuid, then hand off to the same join helper used by
  // every other read path — keeps the response shape identical.
  const { data, error } = await supabase
    .from("loads")
    .select("id")
    .eq("org_id", orgId)
    .eq("internal_load_id", internalId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/loads/by-internal-id] lookup failed:", error);
    return c.json({ error: "lookup_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const joined = await fetchLoadJoined((data as { id: string }).id, orgId);
  if (joined === null) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const res: GetLoadResponse = { loads: joined };
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
  if ("weight"       in body) {
    // loads.weight is `integer` — round decimal values (some brokers print
    // "33,309.6") and coerce numeric strings. See appLoadToLoadInsert for
    // the same logic on the CREATE path.
    const w = body.weight as unknown;
    if (w == null || w === '') {
      update.weight = null;
    } else {
      const n = typeof w === 'number' ? w : Number(String(w).replace(/,/g, ''));
      update.weight = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }
  }
  if ("rateConPdf"   in body) update.rate_con_pdf   = body.rateConPdf   ?? null;
  if ("refNums"      in body) update.ref_nums       = body.refNums?.length ? JSON.stringify(body.refNums) : null;
  if ("notes"         in body) update.notes          = body.notes         ?? null;
  if ("internalNotes" in body) update.internal_notes = body.internalNotes ?? [];
  if ("auditLog"      in body) update.audit_log      = body.auditLog      ?? null;

  // Accessorials get a per-id merge instead of a blind overwrite. The
  // EventModal owns category / description / amount / billable /
  // payToDriver / payDriverName, but closeout's ReviewQueue is the
  // only surface that mutates `status` (approved / denied). Before
  // this guard, an idle EventModal save would round-trip the loaded
  // accessorials back without status — silently wiping closeout's
  // approval decisions whenever a dispatcher edited any other field
  // on the load. We read the existing JSONB, preserve status from
  // each existing entry, and overlay the body's editable fields.
  // New ids in the body get inserted; existing ids missing from the
  // body get dropped (dispatcher deleted them).
  // Snapshot the pre-merge accessorials list so the post-write audit
  // block at the bottom of this handler can diff existing vs next and
  // emit a `accessorialsChanged` audit entry. Stays `null` when the
  // request didn't include accessorials at all (no work to diff).
  let existingAccessorialsBeforeMerge: ServerAccessorialSnapshot[] | null = null;

  if ("accessorials" in body) {
    type AccessorialRow = {
      id: string;
      status?: string;
      // We carry these through unchanged from existing rows too. The
      // modal does set these, but they don't have a competing writer
      // — so preserving them is safe whether the modal sends them
      // back or not.
      // Anything not enumerated here gets the body value or null.
      [k: string]: unknown;
    };
    const incoming = (body.accessorials ?? []) as unknown as AccessorialRow[];
    // Always read the existing snapshot — we need it for the audit diff
    // even when the dispatcher wipes the whole list (each row "removed").
    const { data: row, error: readErr } = await supabase
      .from("loads")
      .select("accessorials")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (readErr) {
      console.error("[PATCH /v1/loads/:id] accessorials read failed:", readErr);
      return c.json({ error: "accessorials_read_failed", detail: readErr.message } satisfies ApiErrorResponse, 500);
    }
    const existing = ((row?.accessorials ?? []) as AccessorialRow[]) || [];
    existingAccessorialsBeforeMerge = existing as unknown as ServerAccessorialSnapshot[];

    if (incoming.length === 0) {
      // Empty array → wipe all accessorials. The dispatcher explicitly
      // cleared them in the modal, so closeout state goes with them.
      update.accessorials = null;
    } else {
      const existingById = new Map<string, AccessorialRow>();
      for (const a of existing) if (a?.id) existingById.set(a.id, a);
      const merged = incoming.map((a) => {
        const prev = existingById.get(a.id);
        if (!prev) return a; // new accessorial — take as-is
        // Preserve closeout-owned fields. `status` is the active one;
        // include the approved/denied timestamps + actor if your
        // schema later adds them and we'll keep these forwards-compatible.
        const preserved: Partial<AccessorialRow> = {};
        if (prev.status        !== undefined) preserved.status        = prev.status;
        if (prev.approvedAt    !== undefined) preserved.approvedAt    = prev.approvedAt;
        if (prev.approvedBy    !== undefined) preserved.approvedBy    = prev.approvedBy;
        if (prev.deniedAt      !== undefined) preserved.deniedAt      = prev.deniedAt;
        if (prev.deniedBy      !== undefined) preserved.deniedBy      = prev.deniedBy;
        return { ...a, ...preserved };
      });
      update.accessorials = merged;
    }
  }

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

  // ── Audit log: accessorial change tracking ──────────────────────────
  // The accessorials block above merges incoming vs existing and writes
  // the merged array — but it never recorded WHICH rows were added,
  // removed, or updated. Calendar EventModal computes this client-side
  // and bundles it into the auditLog body it ships up, but loads edited
  // via the load-detail page (apps/web/app/loads/[internalLoadId]/page.tsx)
  // PATCH this endpoint without a precomputed entry, so accessorial
  // changes from that surface were silent. Now they get an audit entry
  // here whenever the merge produced a real diff.
  //
  // Skipped when the caller already sent an auditLog body (EventModal
  // does the diff itself) — we'd double-count otherwise. We also skip
  // the diff entirely when the request didn't include the accessorials
  // field; the previous version recomputed even on unrelated PATCHes.
  if (existingAccessorialsBeforeMerge !== null && !("auditLog" in body)) {
    const next = (update.accessorials ?? []) as ServerAccessorialSnapshot[];
    const diff = diffAccessorialsForAudit(existingAccessorialsBeforeMerge, next);
    if (diff.length > 0) {
      const actorName = await getUserDisplayName(c.get("userId"));
      await appendLoadAudit(loadId, orgId, {
        changedAt:           new Date().toISOString(),
        changedByName:       actorName ?? "Dispatcher",
        accessorialsChanged: diff,
      });
    }
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
  if ("deferredToWeek" in body) {
    // YYYY-MM-DD (Saturday weekStart) or null. PostgREST accepts both;
    // the column is `date` so we don't need to coerce the format.
    update.deferred_to_week = body.deferredToWeek ?? null;
  }
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
  //
  // We also fetch the existing status here (single read, reused) so we
  // can write an audit entry if it changes — the cancel path on the
  // client builds its own entry, but every other dispatcher-driven
  // status flip (scheduled → confirmed → in_transit → delivered →
  // released) was silent before this.
  let prevStatus: string | null = null;
  if ("driverId" in body || "status" in body) {
    const { data: prev } = await supabase
      .from("events")
      .select("driver_id, status")
      .eq("id", eventId)
      .eq("org_id", orgId)
      .maybeSingle();
    const prevRow = prev as { driver_id: number | null; status: string | null } | null;
    prevStatus = prevRow?.status ?? null;
    const prevDriverId = prevRow?.driver_id ?? null;
    const newDriverId  = "driverId" in body ? (body.driverId ?? null) : prevDriverId;
    const driverChanging = "driverId" in body && prevDriverId !== newDriverId;

    if (driverChanging) {
      update.confirmed_at             = null;
      update.confirmed_by             = null;
      update.confirm_reminder_sent_at = null;
    }

    // Status state machine: keep status consistent with driver
    // assignment. The dispatcher's mental model:
    //   - scheduled  = no driver
    //   - assigned   = driver assigned, hasn't confirmed yet
    //   - dispatched = driver confirmed in the app
    //   - en_route+  = driver started the trip in the app
    // Auto-promote/demote ONLY when the dispatcher didn't explicitly
    // set status in this same request (their write wins), and only
    // when the current status is the matching gateway state. Higher
    // states (dispatched / en_route / picked_up / delivered) stay
    // untouched because they were set by the driver-side workflow
    // and a driver swap shouldn't roll them back automatically.
    if (driverChanging && !("status" in body)) {
      if (newDriverId != null && prevStatus === "scheduled") {
        update.status = "assigned";
      } else if (newDriverId == null && prevStatus === "assigned") {
        update.status = "scheduled";
      }
    }
  }

  // Guard: a dispatcher save must never silently REGRESS a driver-owned
  // status. The EventModal re-sends the whole event — including a
  // possibly-stale `status` — on every save, so an edit made after the
  // driver advanced the load in the app (e.g. confirmed → dispatched)
  // would otherwise revert it (dispatched → assigned). Drop a backwards
  // move out of a driver-owned state; forward moves and the exception
  // states (cancelled/tonu/problem) still apply.
  let statusRegressionBlocked = false;
  if (typeof update.status === "string" && prevStatus) {
    const STATUS_RANK: Record<string, number> = {
      scheduled: 0, assigned: 1, dispatched: 2, en_route: 3, picked_up: 4, delivered: 5,
    };
    const EXCEPTION_STATUSES = new Set(["cancelled", "tonu", "problem"]);
    const curRank  = STATUS_RANK[prevStatus] ?? 0;
    const nextRank = STATUS_RANK[update.status] ?? 0;
    if (!EXCEPTION_STATUSES.has(update.status) && curRank >= STATUS_RANK.dispatched && nextRank < curRank) {
      delete update.status;
      statusRegressionBlocked = true;
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

  // Status diff audit. The client-built audit handles the cancel
  // path (with its multi-mode `loadCancelled` shape) but EVERY other
  // status transition by a dispatcher was silent. Now any
  // server-observed status change writes a per-leg audit entry. This
  // also catches programmatic flips from scripts / other callers AND
  // the auto-promotion above (scheduled → assigned when a driver is
  // set, etc.) — `effectiveNewStatus` reads the value we actually
  // wrote, not what was in body.
  const effectiveNewStatus = statusRegressionBlocked
    ? undefined
    : (update.status as string | undefined)
      ?? (("status" in body) ? body.status : undefined);
  if (
    prevStatus !== null &&
    effectiveNewStatus !== undefined &&
    effectiveNewStatus !== prevStatus
  ) {
    const actorName = await getUserDisplayName(c.get("userId"));
    await appendEventAudit(eventId, orgId, {
      changedAt:     new Date().toISOString(),
      changedByName: actorName ?? "Dispatcher",
      prevStatus:    prevStatus as never,
      newStatus:     effectiveNewStatus as never,
    });
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

  // Fetch the load's active legs (ordered: leg_index, then start)
  const { data: existingEventsRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("leg_index", { ascending: true })
    .order("start", { ascending: true });
  if (fetchErr || !existingEventsRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existingEvents = existingEventsRaw as unknown as Array<Record<string, unknown> & {
    id: string; title: string; end: string; priority: boolean;
  }>;
  if (existingEvents.length < 1) {
    return badRequest(c, ["load has no active events"]);
  }

  // The leg being split. Back-compat: single-leg loads may omit
  // targetEventId (the original single→relay flow).
  let targetIdx: number;
  if (body.targetEventId) {
    targetIdx = existingEvents.findIndex((e) => e.id === body.targetEventId);
    if (targetIdx < 0) return badRequest(c, ["targetEventId not found among this load's events"]);
  } else if (existingEvents.length === 1) {
    targetIdx = 0;
  } else {
    return badRequest(c, ["targetEventId required when the load already has multiple legs"]);
  }
  const targetEvent = existingEvents[targetIdx];
  const newLegCount = existingEvents.length + 1;

  // 1. Update the split leg: clamp its end to the handoff
  const { error: targetErr } = await supabase
    .from("events")
    .update({
      end:        body.pickupEnd,
      relay_role: legRoleFor(targetIdx, newLegCount) ?? null,
    })
    .eq("id", targetEvent.id)
    .eq("org_id", orgId);
  if (targetErr) {
    return c.json({ error: "pickup_update_failed", detail: targetErr.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Insert the new leg immediately after the split leg
  const newLegInsert = {
    org_id:      orgId,
    load_id:     loadId,
    asset_id:    body.deliveryAssetId,
    driver_id:   body.deliveryDriverId   ?? null,
    driver_name: body.deliveryDriverName ?? null,
    title:       targetEvent.title,
    start:       body.deliveryStart,
    end:         body.deliveryEnd,
    status:      "scheduled",
    event_kind:  "revenue",
    relay_role:  legRoleFor(targetIdx + 1, newLegCount),
    leg_index:   targetIdx + 1,
    priority:    targetEvent.priority,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: newLegRaw, error: newLegErr } = await supabase
    .from("events")
    .insert(newLegInsert as any)
    .select()
    .single();
  const newLegEvent = newLegRaw as { id: string } | null;
  if (newLegErr || !newLegEvent) {
    // Cleanup: revert the split leg
    await supabase
      .from("events")
      .update({ relay_role: (targetEvent.relay_role as string | null) ?? null, end: targetEvent.end })
      .eq("id", targetEvent.id)
      .eq("org_id", orgId);
    return c.json({ error: "delivery_create_failed", detail: newLegErr?.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Renumber leg_index 0..N and re-derive relay_role on every leg.
  //    (The split leg + new leg were already written above; this pass
  //    shifts the legs AFTER the insertion point and refreshes roles —
  //    e.g. a former delivery leg that's no longer last becomes transfer.)
  const finalOrder: Array<{ id: string }> = [
    ...existingEvents.slice(0, targetIdx + 1),
    newLegEvent,
    ...existingEvents.slice(targetIdx + 1),
  ];
  for (let i = 0; i < finalOrder.length; i++) {
    if (finalOrder[i].id === targetEvent.id || finalOrder[i].id === newLegEvent.id) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("events")
      .update({ leg_index: i, relay_role: legRoleFor(i, finalOrder.length) } as any)
      .eq("id", finalOrder[i].id)
      .eq("org_id", orgId);
  }
  // The split leg's leg_index is unchanged but ensure it's persisted
  // (legacy rows predating leg_index backfill default to 0).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await supabase
    .from("events")
    .update({ leg_index: targetIdx } as any)
    .eq("id", targetEvent.id)
    .eq("org_id", orgId);

  // 4. Replace stops on ALL legs with the full merged list. Every leg
  //    shares the same stops; relay-type stops are the handoff markers
  //    (marker i divides leg i from leg i+1). UIs derive each leg's
  //    window from its leg_index + the markers' positions.
  const legIds = finalOrder.map((l) => l.id);
  await supabase.from("stops").delete().in("event_id", legIds).eq("org_id", orgId);

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
    is_handoff:  s.isHandoff ?? false,
    handoff_drop_at:  s.handoffDropAt ?? null,
    handoff_pickup_at:  s.handoffPickupAt ?? null,
    lat:            s.lat           ?? null,
    lng:            s.lng           ?? null,
    instructions:   s.instructions  ?? null,
    geocode_status: s.geocodeStatus ?? "pending",
  }));
  const stopRows = legIds.flatMap((id) => buildStopRows(id));

  if (stopRows.length) {
    const { error: stopErr } = await supabase.from("stops").insert(stopRows);
    if (stopErr) {
      console.error("[POST /v1/loads/:id/split-relay] stops insert failed:", stopErr);
      // Best-effort: orphan stops are bad but recovery is hard here.
      return c.json({ error: "stops_insert_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  // 5. Handoff photos: a new marker was inserted at ordinal h (its
  //    position among handoff stops). Existing relay_handoff docs at
  //    handoff_index >= h belong to later handoffs — shift them up so
  //    they stay attached to the same physical exchange.
  const newMarkerOrdinal = body.mergedStops
    .slice(0, body.relayStopIndex)
    .filter((s) => isHandoffStop(s)).length;
  const { data: shiftDocsRaw } = await supabase
    .from("load_documents")
    .select("id, handoff_index")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .eq("kind", "relay_handoff")
    .gte("handoff_index", newMarkerOrdinal);
  for (const doc of (shiftDocsRaw ?? []) as Array<{ id: string; handoff_index: number }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("load_documents")
      .update({ handoff_index: doc.handoff_index + 1 } as any)
      .eq("id", doc.id)
      .eq("org_id", orgId);
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
// POST /v1/loads/:id/unsplit-relay — merge two adjacent legs (N → N-1)
// ─────────────────────────────────────────────────────────────────────────

loads.post("/:id/unsplit-relay", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<UnsplitRelayRequest>();

  if (!body?.keepEventId) {
    return badRequest(c, ["keepEventId required"]);
  }

  // Fetch the load's active legs in leg order
  const { data: existingEventsRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("leg_index", { ascending: true })
    .order("start", { ascending: true });
  if (fetchErr || !existingEventsRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existingEvents = existingEventsRaw as unknown as Array<{
    id: string; start: string; end: string; relay_role: string | null;
  }>;
  if (existingEvents.length < 2) {
    return badRequest(c, [`load must have at least 2 events to unsplit; found ${existingEvents.length}`]);
  }

  const keepIdx = existingEvents.findIndex((e) => e.id === body.keepEventId);
  if (keepIdx < 0) {
    return badRequest(c, ["keepEventId not found among this load's events"]);
  }
  // The leg to absorb. Back-compat: on a 2-leg load it's implied.
  let dropIdx: number;
  if (body.mergeEventId) {
    dropIdx = existingEvents.findIndex((e) => e.id === body.mergeEventId);
    if (dropIdx < 0) return badRequest(c, ["mergeEventId not found among this load's events"]);
    if (Math.abs(dropIdx - keepIdx) !== 1) {
      return badRequest(c, ["mergeEventId must be adjacent to keepEventId"]);
    }
  } else if (existingEvents.length === 2) {
    dropIdx = keepIdx === 0 ? 1 : 0;
  } else {
    return badRequest(c, ["mergeEventId required when the load has more than 2 legs"]);
  }
  const keep = existingEvents[keepIdx];
  const drop = existingEvents[dropIdx];

  // 1. Soft-delete the absorbed leg
  const now = new Date().toISOString();
  const { error: dropErr } = await supabase
    .from("events")
    .update({ deleted_at: now })
    .eq("id", drop.id)
    .eq("org_id", orgId);
  if (dropErr) {
    return c.json({ error: "drop_event_failed", detail: dropErr.message } satisfies ApiErrorResponse, 500);
  }

  // 2. Update the kept leg: window covers both legs; role re-derived below
  const newStart = keep.start < drop.start ? keep.start : drop.start;
  const newEnd = keep.end > drop.end ? keep.end : drop.end;
  const remainingCount = existingEvents.length - 1;
  const mergedIdx = Math.min(keepIdx, dropIdx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: keepErr } = await supabase
    .from("events")
    .update({
      start:      newStart,
      end:        newEnd,
      leg_index:  mergedIdx,
      relay_role: legRoleFor(mergedIdx, remainingCount) ?? null,
    } as any)
    .eq("id", keep.id)
    .eq("org_id", orgId);
  if (keepErr) {
    // Revert the drop-event soft-delete on failure
    await supabase.from("events").update({ deleted_at: null }).eq("id", drop.id).eq("org_id", orgId);
    return c.json({ error: "keep_update_failed", detail: keepErr.message } satisfies ApiErrorResponse, 500);
  }

  // 3. Renumber the remaining legs and re-derive roles (a transfer leg
  //    that becomes last turns into the delivery leg, etc.). On a 2-leg
  //    load this clears relay_role on the survivor entirely.
  const finalOrder = existingEvents
    .filter((_, i) => i !== dropIdx)
    .map((e) => e.id);
  for (let i = 0; i < finalOrder.length; i++) {
    if (finalOrder[i] === keep.id) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("events")
      .update({ leg_index: i, relay_role: legRoleFor(i, finalOrder.length) ?? null } as any)
      .eq("id", finalOrder[i])
      .eq("org_id", orgId);
  }

  // 4. Remove the collapsed handoff marker — the relay-type stop between
  //    the two merged legs (ordinal = mergedIdx among relay stops) — from
  //    EVERY remaining leg's stop copy, then re-sequence each.
  for (const legId of finalOrder) {
    const { data: relayStopsRaw } = await supabase
      .from("stops")
      .select("id")
      .eq("event_id", legId)
      .eq("org_id", orgId)
      .eq("type", "relay")
      .order("sequence", { ascending: true });
    const relayStops = (relayStopsRaw ?? []) as Array<{ id: string }>;
    const marker = relayStops[mergedIdx];
    if (marker) {
      await supabase.from("stops").delete().eq("id", marker.id).eq("org_id", orgId);
    } else if (relayStops.length > 0 && finalOrder.length === 1) {
      // Legacy 2-leg loads: just clear all markers on the lone survivor.
      await supabase.from("stops").delete().eq("event_id", legId).eq("org_id", orgId).eq("type", "relay");
    }
    const { data: remainingRaw } = await supabase
      .from("stops")
      .select("id")
      .eq("event_id", legId)
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
  }
  // body.mergedStops is now ignored — the server reconstructs from the
  // kept legs' existing stops minus the collapsed marker. Field accepted
  // for API back-compat but not used.
  void body.mergedStops;

  // 5. Handoff photos: docs on the collapsed handoff lose their ordinal
  //    (kept as legacy load-level photos); later handoffs shift down 1.
  const { data: handoffDocsRaw } = await supabase
    .from("load_documents")
    .select("id, handoff_index")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .eq("kind", "relay_handoff")
    .gte("handoff_index", mergedIdx);
  for (const doc of (handoffDocsRaw ?? []) as Array<{ id: string; handoff_index: number }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("load_documents")
      .update({ handoff_index: doc.handoff_index === mergedIdx ? null : doc.handoff_index - 1 } as any)
      .eq("id", doc.id)
      .eq("org_id", orgId);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  const res: UnsplitRelayResponse = { loads: joined ?? [] };
  return c.json(res);
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /v1/loads/:id/legs — reconcile the load's legs in one call
//
// split-relay / unsplit-relay move one handoff at a time, which forces a
// save per handoff when a dispatcher is authoring a multi-leg relay. This
// takes the whole intended shape at once: the full stop list (handoff
// boundaries flagged) plus one entry per leg, and reconciles events to
// match. See ConfigureLegsRequest for the contract.
// ─────────────────────────────────────────────────────────────────────────

loads.put("/:id/legs", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const loadId = c.req.param("id");
  const body = await c.req.json<ConfigureLegsRequest>();

  // ── Validate ──────────────────────────────────────────────────────────
  const errors: string[] = [];
  if (!Array.isArray(body?.stops)) errors.push("'stops' must be an array");
  if (!Array.isArray(body?.legs) || body.legs.length < 1) {
    errors.push("'legs' must have at least 1 entry");
  }
  if (Array.isArray(body?.legs) && body.legs.length > 10) {
    errors.push("'legs' cannot exceed 10 entries");
  }
  if (Array.isArray(body?.stops) && Array.isArray(body?.legs)) {
    // Legs are the gaps between handoff boundaries, so the counts are
    // two views of the same structure and must agree exactly.
    const handoffCount = body.stops.filter((s) => isHandoffStop(s)).length;
    if (body.legs.length !== handoffCount + 1) {
      errors.push(
        `legs/handoffs mismatch: ${body.legs.length} legs needs ${body.legs.length - 1} handoff stops, found ${handoffCount}`,
      );
    }
    // A boundary can't be the first or last stop — the leg on the far
    // side of it would have no route.
    const lastIdx = body.stops.length - 1;
    if (body.stops.length > 0 && handoffCount > 0) {
      if (isHandoffStop(body.stops[0])) errors.push("the first stop cannot be a handoff");
      if (isHandoffStop(body.stops[lastIdx])) errors.push("the last stop cannot be a handoff");
    }
  }
  for (const [i, leg] of (body?.legs ?? []).entries()) {
    if (typeof leg.assetId !== "number") errors.push(`legs[${i}]: assetId (number) required`);
    if (!leg.start) errors.push(`legs[${i}]: start required`);
    if (!leg.end)   errors.push(`legs[${i}]: end required`);
    if (leg.start && leg.end && leg.start > leg.end) errors.push(`legs[${i}]: start must be <= end`);
  }
  if (errors.length) return badRequest(c, errors);

  // ── Current state ─────────────────────────────────────────────────────
  const { data: existingRaw, error: fetchErr } = await supabase
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("leg_index", { ascending: true })
    .order("start", { ascending: true });
  if (fetchErr || !existingRaw) {
    return c.json({ error: "fetch_failed", detail: fetchErr?.message } satisfies ApiErrorResponse, 500);
  }
  const existing = existingRaw as unknown as Array<Record<string, unknown> & {
    id: string; title: string; priority: boolean;
    status: string | null; driver_name: string | null; start: string | null;
  }>;
  // No ACTIVE legs is a state to converge from, not an error. The load
  // row still exists (checked below) — its events were soft-deleted, or
  // a create half-landed — and the caller is telling us what the legs
  // should be, so build them. Refusing here stranded a load with no way
  // to fix it from the UI, which is the opposite of what a convergent
  // reconcile is for. Only a genuinely missing/foreign load is a 404.
  if (existing.length === 0) {
    const { data: loadRow } = await supabase
      .from("loads")
      .select("id, load_num")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!loadRow) {
      return c.json({
        error:  "not_found",
        detail: "That load no longer exists. Reload the calendar and try again.",
      } satisfies ApiErrorResponse, 404);
    }
    // Any payload eventId is stale by definition when nothing is active.
    for (const leg of body.legs) delete leg.eventId;
    console.warn(`[PUT /v1/loads/:id/legs] load ${loadId} had no active events — rebuilding ${body.legs.length} leg(s)`);
  }
  const existingIds = new Set(existing.map((e) => e.id));

  // A referenced eventId must belong to this load — otherwise a caller
  // could graft another load's leg onto this one. But a STALE id for a
  // leg of this same load (one that was soft-deleted, and lingered in a
  // client cache) is not an attack, it's out-of-date information — and
  // rejecting it dead-ended the dispatcher, who had no way to see or
  // clear the stale reference. Converge instead: forget the id and let
  // the leg be created. Only a genuinely foreign id is refused.
  const { data: everRaw } = await supabase
    .from("events")
    .select("id")
    .eq("load_id", loadId)
    .eq("org_id", orgId);
  const everOnThisLoad = new Set(((everRaw ?? []) as Array<{ id: string }>).map(r => r.id));
  for (const [i, leg] of body.legs.entries()) {
    if (!leg.eventId || existingIds.has(leg.eventId)) continue;
    if (everOnThisLoad.has(leg.eventId)) {
      delete leg.eventId;   // stale reference to a removed leg → new leg
      continue;
    }
    return badRequest(c, [`legs[${i}]: eventId does not belong to this load`]);
  }
  // `expectedEventIds` used to hard-reject a payload whose leg set had
  // drifted. That guarded against the double-submit multiplication —
  // which the reuse-pool below now prevents at the source — while
  // creating a worse failure: a client whose cache was stale sent the
  // same wrong set on every retry and could never save at all, with no
  // way out of the loop. Reconciling is convergent by design (the stop
  // list is the truth and the legs are made to match it), so a drifted
  // view is something to converge, not something to refuse. The field
  // is accepted and ignored for wire compatibility.
  void body.expectedEventIds;

  const keptIds = new Set(body.legs.map((l) => l.eventId).filter(Boolean) as string[]);
  if (new Set(body.legs.filter(l => l.eventId).map(l => l.eventId)).size !== keptIds.size) {
    return badRequest(c, ["the same eventId appears on more than one leg"]);
  }

  // Legs are a route in order, so surviving legs must keep their relative
  // order. If a payload asks to put leg C before leg B, the client has
  // lost track of which event is which physical segment (the classic
  // symptom of matching legs by array index) and applying it would move
  // drivers, pay and paperwork onto routes they never ran. Refuse rather
  // than write a scrambled load.
  const existingOrder = new Map(existing.map((e, i) => [e.id, i]));
  const keptSequence = body.legs
    .map((l) => l.eventId)
    .filter((id): id is string => !!id)
    .map((id) => existingOrder.get(id) ?? -1);
  for (let i = 1; i < keptSequence.length; i++) {
    if (keptSequence[i] <= keptSequence[i - 1]) {
      return badRequest(c, [
        "existing legs would be reordered — legs must stay in their current relative order. Reload the load and try again.",
      ]);
    }
  }

  const legCount = body.legs.length;

  // ── Pin the load's window ─────────────────────────────────────────────
  //
  // A relay leg only SUBDIVIDES a load; it never changes when the load
  // itself runs. Client-side, the modal's start/end fields describe the
  // leg being viewed, so splitting one (which clamps that leg's end to
  // the new handoff) kept dragging the load's delivery time earlier with
  // every handoff added. Rather than rely on the client getting that
  // right in every path, make it structural here: legs TILE the window.
  // The first leg starts when the load starts, the last ends when it
  // ends, and interior boundaries are clamped inside. Omitting
  // loadWindow preserves whatever the load's window already is — the
  // correct behaviour for add/remove — so only a deliberate reschedule
  // moves it.
  const currentWindow = existing.length > 0
    ? {
        start: existing.reduce((min, e) => {
          const s = (e.start as string | null) ?? "";
          return s && (!min || s < min) ? s : min;
        }, ""),
        end: existing.reduce((max, e) => {
          const en = (e.end as string | null) ?? "";
          return en && (!max || en > max) ? en : max;
        }, ""),
      }
    : null;
  const windowStart = body.loadWindow?.start || currentWindow?.start || body.legs[0].start;
  const windowEnd   = body.loadWindow?.end   || currentWindow?.end   || body.legs[legCount - 1].end;

  if (windowStart && windowEnd && windowStart <= windowEnd) {
    const clamp = (v: string) => (v < windowStart ? windowStart : v > windowEnd ? windowEnd : v);
    for (const leg of body.legs) {
      leg.start = clamp(leg.start);
      leg.end   = clamp(leg.end);
      if (leg.end < leg.start) leg.end = leg.start;
    }
    // The boundary legs anchor the window exactly.
    body.legs[0].start = windowStart;
    body.legs[legCount - 1].end = windowEnd;
    if (body.legs[0].end < body.legs[0].start) body.legs[0].end = body.legs[0].start;
    if (body.legs[legCount - 1].end < body.legs[legCount - 1].start) {
      body.legs[legCount - 1].start = body.legs[legCount - 1].end;
    }
  }
  // Shape new legs after an existing one. When nothing is active (the
  // rebuild path above) fall back to the most recent soft-deleted leg so
  // the calendar title survives, then to the load number.
  let template: { title: string; priority: boolean } | undefined = existing[0];
  if (!template) {
    const { data: ghostRaw } = await supabase
      .from("events")
      .select("title, priority")
      .eq("load_id", loadId)
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ghost = ghostRaw as { title: string | null; priority: boolean | null } | null;
    const { data: lr } = await supabase
      .from("loads").select("load_num").eq("id", loadId).eq("org_id", orgId).maybeSingle();
    const loadNum = (lr as { load_num: string | null } | null)?.load_num;
    template = {
      title:    ghost?.title ?? (loadNum ? `Load ${loadNum}` : "Load"),
      priority: ghost?.priority ?? false,
    };
  }

  // ── 1. Update / create each leg in order ──────────────────────────────
  //
  // Payload entries without an eventId mean "this segment has no event
  // yet". They do NOT mean "insert unconditionally": an entry that
  // inserts every time makes the endpoint non-idempotent, so re-sending
  // the same payload (a retry, a double-click, a stale tab) multiplies
  // legs instead of converging. Un-identified entries therefore consume
  // any still-unclaimed existing leg, in order, before creating one.
  // Re-applying the same payload then lands on the same rows.
  const claimed = new Set(body.legs.map((l) => l.eventId).filter(Boolean) as string[]);
  const reusePool = existing.map((e) => e.id).filter((id) => !claimed.has(id));
  let reuseAt = 0;

  const legIds: string[] = [];
  for (const [i, leg] of body.legs.entries()) {
    const shared = {
      asset_id:    leg.assetId,
      driver_id:   leg.driverId   ?? null,
      driver_name: leg.driverName ?? null,
      driver_pay:  leg.driverPay  ?? null,
      start:       leg.start,
      end:         leg.end,
      leg_index:   i,
      relay_role:  legRoleFor(i, legCount) ?? null,
      ...(leg.trailerId   !== undefined ? { trailer_id:   leg.trailerId }   : {}),
      ...(leg.trailerType !== undefined ? { trailer_type: leg.trailerType } : {}),
    };
    // Named leg, or an unnamed one adopting a leftover existing leg.
    const targetId = leg.eventId ?? (reuseAt < reusePool.length ? reusePool[reuseAt++] : undefined);
    if (targetId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await supabase
        .from("events")
        .update({ ...shared, ...(leg.status ? { status: leg.status } : {}) } as any)
        .eq("id", targetId)
        .eq("org_id", orgId);
      if (upErr) {
        return c.json({ error: "leg_update_failed", detail: upErr.message } satisfies ApiErrorResponse, 500);
      }
      legIds.push(targetId);
    } else {
      const insert = {
        ...shared,
        org_id:     orgId,
        load_id:    loadId,
        title:      template.title,
        status:     leg.status ?? (leg.driverId != null ? "assigned" : "scheduled"),
        event_kind: "revenue",
        priority:   template.priority,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: newRaw, error: insErr } = await supabase
        .from("events")
        .insert(insert as any)
        .select("id")
        .single();
      const created = newRaw as { id: string } | null;
      if (insErr || !created) {
        return c.json({ error: "leg_create_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
      }
      legIds.push(created.id);
    }
  }

  // ── 2. Soft-delete legs the caller dropped ────────────────────────────
  // `legIds` is the authoritative surviving set — it includes legs an
  // un-identified payload entry adopted from the reuse pool, which
  // `keptIds` (explicit ids only) would have marked for deletion.
  const survivingIds = new Set(legIds);
  const removedIds = existing.map((e) => e.id).filter((id) => !survivingIds.has(id));
  if (removedIds.length > 0) {
    // Paperwork belongs to the LOAD, not to whichever leg happened to
    // be open when it was uploaded — so removing a leg must never orphan
    // a document. Re-point the removed legs' documents at a surviving
    // leg before deleting; `load_id` already carries them for every
    // load-scoped read, and this keeps `event_id` pointing at something
    // real for the invoice packet and per-leg views.
    //
    // (This replaces a guard that refused to drop a leg holding
    // documents or one past `assigned`. It forced a confirmation dialog
    // for something the dispatcher can already see on screen, and a
    // stale client could trip it with no way to clear the state. The
    // dispatcher confirms by pressing Save; a removed leg's pay goes
    // with the leg, which is the intent, not a loss to warn about.)
    const survivorId = legIds[0];
    if (survivorId) {
      const { error: docErr } = await supabase
        .from("load_documents")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ event_id: survivorId } as any)
        .in("event_id", removedIds)
        .eq("org_id", orgId);
      if (docErr) {
        console.error("[PUT /v1/loads/:id/legs] re-point documents failed:", docErr);
        return c.json({ error: "document_repoint_failed", detail: docErr.message } satisfies ApiErrorResponse, 500);
      }
    }
    const now = new Date().toISOString();
    const { error: delErr } = await supabase
      .from("events")
      .update({ deleted_at: now })
      .in("id", removedIds)
      .eq("org_id", orgId);
    if (delErr) {
      return c.json({ error: "leg_delete_failed", detail: delErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  // ── 3. Write the full stop list to every leg ──────────────────────────
  //     Each leg stores the whole route; per-leg windows are derived from
  //     leg_index + the handoff boundaries (see routeGeometry.legStops).
  await supabase.from("stops").delete().in("event_id", legIds).eq("org_id", orgId);
  const stopRows = legIds.flatMap((eventId) =>
    body.stops.map((s, idx) => ({
      event_id:          eventId,
      org_id:            orgId,
      sequence:          idx + 1,
      type:              s.type,
      facility_name:     s.facilityName  ?? null,
      address:           s.address       ?? null,
      city:              s.city          ?? null,
      state:             s.state         ?? null,
      timezone:          s.timezone      ?? null,
      appt_start:        s.apptStart     ?? null,
      appt_end:          s.apptEnd       ?? null,
      schedule_type:     s.scheduleType  ?? null,
      is_handoff:        s.isHandoff     ?? false,
      handoff_drop_at:   s.handoffDropAt ?? null,
      handoff_pickup_at: s.handoffPickupAt ?? null,
      lat:               s.lat           ?? null,
      lng:               s.lng           ?? null,
      instructions:      s.instructions  ?? null,
      geocode_status:    s.geocodeStatus ?? "pending",
    })),
  );
  if (stopRows.length > 0) {
    const { error: stopErr } = await supabase.from("stops").insert(stopRows);
    if (stopErr) {
      console.error("[PUT /v1/loads/:id/legs] stops insert failed:", stopErr);
      return c.json({ error: "stops_insert_failed", detail: stopErr.message } satisfies ApiErrorResponse, 500);
    }
  }

  // ── 4. Drop handoff photos whose handoff no longer exists ─────────────
  //     Legs can be added or removed here, so a photo pinned to handoff 3
  //     on a load that now has two handoffs has nowhere to live. Null the
  //     ordinal rather than deleting the file — it stays visible as a
  //     load-level handoff photo.
  const maxHandoffIdx = legCount - 2; // handoffs are 0..legCount-2
  const { data: strayDocsRaw } = await supabase
    .from("load_documents")
    .select("id")
    .eq("load_id", loadId)
    .eq("org_id", orgId)
    .eq("kind", "relay_handoff")
    .gt("handoff_index", maxHandoffIdx);
  for (const doc of (strayDocsRaw ?? []) as Array<{ id: string }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await supabase
      .from("load_documents")
      .update({ handoff_index: null } as any)
      .eq("id", doc.id)
      .eq("org_id", orgId);
  }

  const joined = await fetchLoadJoined(loadId, orgId);
  const res: ConfigureLegsResponse = { loads: joined ?? [] };
  return c.json(res);
});

// Mount the per-load check-calls subroutes here so Hono's path merging
// produces /v1/loads/:loadId/check-calls cleanly.
loads.route("/:loadId/check-calls", checkCallsScopedRouter);

// ─────────────────────────────────────────────────────────────────────────
// POST /v1/loads/backfill-heic — convert existing HEIC docs to JPG
// ─────────────────────────────────────────────────────────────────────────
//
// Operational lever for the in-the-wild HEIC photos that landed before
// the upload-side conversion went live. Iterates every load_documents
// row in the caller's org whose mime_type is HEIC/HEIF, downloads each
// from Supabase Storage, transcodes to JPG, writes the new blob,
// updates the row (storage_path / mime_type / file_name), and removes
// the original HEIC blob. Idempotent — re-running after a partial pass
// only touches rows still flagged HEIC.
//
// Single-doc transcode takes ~1-2s. Body accepts an optional
// `loadIds: string[]` to scope to specific loads (e.g. "fix just the
// 6 affected invoices") so we don't process the whole org when a
// dispatcher just wants to re-send a single batch.
//
// Returns a structured summary the UI can show:
//   { total, converted, failed: [{id, storagePath, reason}, ...], skippedRateCon }
loads.post("/backfill-heic", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body  = await c.req.json<{ loadIds?: string[]; dryRun?: boolean }>().catch(() => ({} as { loadIds?: string[]; dryRun?: boolean }));
  const scopedLoadIds = body.loadIds;
  const dryRun        = !!body.dryRun;

  let query = supabase
    .from("load_documents")
    .select("id, load_id, kind, file_name, mime_type, size_bytes, storage_path")
    .eq("org_id", orgId)
    .or("mime_type.ilike.image/heic%,mime_type.ilike.image/heif%");
  if (scopedLoadIds && scopedLoadIds.length) {
    query = query.in("load_id", scopedLoadIds);
  }
  const { data, error } = await query;
  if (error) {
    console.error("[POST /v1/loads/backfill-heic] list failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }

  type Row = {
    id: string; load_id: string | null; kind: string;
    file_name: string; mime_type: string | null; size_bytes: number | null;
    storage_path: string;
  };
  const rows = (data ?? []) as Row[];

  if (dryRun) {
    return c.json({
      total:     rows.length,
      preview:   rows.slice(0, 20).map(r => ({ id: r.id, loadId: r.load_id, kind: r.kind, fileName: r.file_name, mime: r.mime_type })),
      dryRun:    true,
    });
  }

  const failed: Array<{ id: string; storagePath: string; reason: string }> = [];
  let converted = 0;

  for (const row of rows) {
    // Rate-cons live in a different bucket and use a different code
    // path for the invoice packet anyway. Skip them here to keep this
    // tool focused on the POD/BOL/etc. invoice-packet attachments
    // where the silent-drop bug actually bit.
    if (row.kind === "rate_con") {
      failed.push({ id: row.id, storagePath: row.storage_path, reason: "rate_con_skipped" });
      continue;
    }
    const bucket = bucketForKind(row.kind);
    try {
      const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(row.storage_path);
      if (dlErr || !blob) {
        failed.push({ id: row.id, storagePath: row.storage_path, reason: `download_failed: ${dlErr?.message ?? "no blob"}` });
        continue;
      }
      const originalBytes = new Uint8Array(await blob.arrayBuffer());
      // Sanity check — the row says HEIC but the bytes might disagree
      // (mime_type can lie). If the magic bytes aren't HEIC we just
      // rewrite the mime so downstream pdf-lib sniffs the actual
      // format and embeds normally.
      if (!isHeic(originalBytes, row.mime_type)) {
        await supabase
          .from("load_documents")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .update({ mime_type: "image/jpeg" } as any)
          .eq("id", row.id)
          .eq("org_id", orgId);
        converted++;
        continue;
      }

      const result = await heicToJpeg(originalBytes);

      // Write the converted bytes to a fresh storage path so a failed
      // mid-flight retry can't half-overwrite the original. Keep the
      // same filename-with-jpg-ext pattern dispatchers see in the docs
      // panel. Only after the new blob is up AND the DB row points at
      // it do we delete the legacy HEIC blob.
      const ts        = Date.now();
      const rand      = Math.random().toString(36).slice(2, 10);
      const eventDir  = row.storage_path.split("/").slice(0, -1).join("/") || `${orgId}`;
      const newPath   = `${eventDir}/${ts}_${rand}_converted.jpg`;
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(newPath, result.jpegBytes, {
          contentType: "image/jpeg",
          upsert: false,
        });
      if (upErr) {
        failed.push({ id: row.id, storagePath: row.storage_path, reason: `reupload_failed: ${upErr.message}` });
        continue;
      }

      const newFileName = rewriteHeicExtension(row.file_name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updErr } = await supabase
        .from("load_documents")
        .update({
          storage_path: newPath,
          file_name:    newFileName,
          mime_type:    "image/jpeg",
          size_bytes:   result.jpegBytes.length,
        } as any)
        .eq("id", row.id)
        .eq("org_id", orgId);
      if (updErr) {
        // Roll back the upload so the next pass can retry cleanly.
        await supabase.storage.from(bucket).remove([newPath]);
        failed.push({ id: row.id, storagePath: row.storage_path, reason: `db_update_failed: ${updErr.message}` });
        continue;
      }

      // Best-effort cleanup of the legacy HEIC blob. If this fails we
      // just leave the orphan in storage — the DB row already points at
      // the new JPG and the packet builder is happy.
      await supabase.storage.from(bucket).remove([row.storage_path]);
      converted++;
    } catch (err) {
      console.error("[POST /v1/loads/backfill-heic] convert failed:", row.id, err);
      failed.push({ id: row.id, storagePath: row.storage_path, reason: `convert_threw: ${(err as Error)?.message ?? "unknown"}` });
    }
  }

  return c.json({
    total:     rows.length,
    converted,
    failed,
  });
});

export default loads;
