/**
 * /v1/timeline — asset-timeline foundation.
 *
 * This is the read+write surface for the new source-agnostic movement
 * system (PR 1 of the asset-timeline build). It does NOT replace
 * /v1/movements — that endpoint stays as the Motive-specific calendar
 * feed for the existing calendar view. This route serves the new
 * /assets/:id/timeline page (PR 2) and the re-link endpoint, which runs
 * the movement linker (lib/movementLinkJob.ts).
 *
 * Endpoints:
 *
 *   GET    /v1/timeline/assets/:assetId?from=&to=
 *      → events + movements + links for the asset in window
 *
 *   POST   /v1/timeline/movements
 *      → create a manual movement (for non-ELD trucks or gap-filling)
 *
 *   PATCH  /v1/timeline/movements/:id
 *      → edit a manual movement (motive rows reject)
 *
 *   DELETE /v1/timeline/movements/:id
 *      → soft-delete a manual movement (motive rows reject)
 *
 *   POST   /v1/timeline/links
 *      → assert a link between a movement and event(s). Inserts a
 *        new fact row; supersedes the prior current link for the
 *        movement in the same transaction.
 *
 *   DELETE /v1/timeline/links/:movementId
 *      → mark the current link as 'unrelated' (still a fact insert +
 *        supersede; the movement stays, the relationship goes).
 */
import { Hono } from "hono";
import type { ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { buildRelayShareMap } from "../lib/relayShare.js";
import { runMovementLinking } from "../lib/movementLinkJob.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const timeline = new Hono<{ Variables: AuthVariables }>();

// Anyone with loads.view can read the timeline. Write-side endpoints
// gate at the route handler since some require asset/load mutation
// capability rather than view.
timeline.use("*", requireCapability("loads.view"));

// ── Shared row types ──────────────────────────────────────────────

interface MovementRow {
  id: string;
  org_id: string;
  asset_id: number;
  driver_id: number | null;
  source: "motive" | "manual" | "derived";
  motive_period_id: number | null;
  start_time: string;
  end_time: string | null;
  duration_min: number | null;
  miles: number | null;
  origin: string | null;
  destination: string | null;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MovementLinkRow {
  id: string;
  org_id: string;
  movement_id: string;
  role: "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loaded_event_id: string | null;
  from_event_id: string | null;
  to_event_id: string | null;
  dwell_stop_id: string | null;
  source: string;
  source_user: string | null;
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
  asserted_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
}

// Wire shapes — camelCased for the client.
interface MovementOut {
  id: string;
  assetId: number;
  driverId?: number;
  source: "motive" | "manual" | "derived";
  motivePeriodId?: number;
  startTime: string;
  endTime?: string;
  durationMin?: number;
  miles?: number;
  origin?: string;
  destination?: string;
  originLat?: number;
  originLon?: number;
  destinationLat?: number;
  destinationLon?: number;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface MovementLinkOut {
  id: string;
  movementId: string;
  role: "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loadedEventId?: string;
  fromEventId?: string;
  toEventId?: string;
  dwellStopId?: string;
  source: string;
  sourceUser?: string;
  confidence?: "high" | "medium" | "low";
  reasoning?: string;
  assertedAt: string;
}

function rowToMovement(r: MovementRow): MovementOut {
  return {
    id:              r.id,
    assetId:         r.asset_id,
    driverId:        r.driver_id ?? undefined,
    source:          r.source,
    motivePeriodId:  r.motive_period_id ?? undefined,
    startTime:       r.start_time,
    endTime:         r.end_time ?? undefined,
    durationMin:     r.duration_min ?? undefined,
    miles:           r.miles ?? undefined,
    origin:          r.origin ?? undefined,
    destination:     r.destination ?? undefined,
    originLat:       r.origin_lat ?? undefined,
    originLon:       r.origin_lon ?? undefined,
    destinationLat:  r.destination_lat ?? undefined,
    destinationLon:  r.destination_lon ?? undefined,
    notes:           r.notes ?? undefined,
    createdBy:       r.created_by,
    createdAt:       r.created_at,
    updatedAt:       r.updated_at,
  };
}

function rowToLink(r: MovementLinkRow): MovementLinkOut {
  return {
    id:             r.id,
    movementId:     r.movement_id,
    role:           r.role,
    loadedEventId:  r.loaded_event_id ?? undefined,
    fromEventId:    r.from_event_id ?? undefined,
    toEventId:      r.to_event_id ?? undefined,
    dwellStopId:    r.dwell_stop_id ?? undefined,
    source:         r.source,
    sourceUser:     r.source_user ?? undefined,
    confidence:     r.confidence ?? undefined,
    reasoning:      r.reasoning ?? undefined,
    assertedAt:     r.asserted_at,
  };
}

const MOVEMENT_COLS =
  "id, org_id, asset_id, driver_id, source, motive_period_id, " +
  "start_time, end_time, duration_min, miles, " +
  "origin, destination, origin_lat, origin_lon, destination_lat, destination_lon, " +
  "notes, created_by, created_at, updated_at";

const LINK_COLS =
  "id, org_id, movement_id, role, " +
  "loaded_event_id, from_event_id, to_event_id, dwell_stop_id, " +
  "source, source_user, confidence, reasoning, " +
  "asserted_at, superseded_at, superseded_by";

// ── GET /assets/:assetId — timeline payload ────────────────────────

interface TimelineEvent {
  id: string;
  title: string | null;
  start: string;
  end: string;
  status: string | null;
  eventKind: string | null;
  nonRevenueType: string | null;
  /** 'pickup' / 'transfer' / 'delivery' for relay legs, null for whole
   *  loads. Derived from leg position: first / middle / last. */
  relayRole: 'pickup' | 'transfer' | 'delivery' | null;
  /** 0-based leg position within the load; null for whole loads. */
  legIndex: number | null;
  loadPrice: number | null;
  /** Server-computed: linehaul + billable accessorials. UI shows it
   *  only when it differs from loadPrice. Maintained by the
   *  loads_compute_total_billable BEFORE trigger. */
  totalBillable: number | null;
  loadNum: string | null;         // loads.load_num
  driverPay: number | null;       // events.driver_pay (per-leg)
  loadedMiles: number | null;     // events.loaded_miles (quoted miles)
  driverName: string | null;
  stops: Array<{
    id: string;
    sequence: number;
    type: string | null;
    /** Relay handoff boundary. Set either by the legacy dedicated
     *  `type:'relay'` marker stop or by the dispatcher flagging any
     *  ordinary stop as a handoff. The client slices each leg's stop
     *  window on these. */
    isHandoff: boolean;
    facilityName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    apptStart: string | null;
    apptEnd: string | null;
    lat: number | null;
    lng: number | null;
  }>;
}

// Per-load attribution result. Inbound convention: a deadhead segment
// is attributed to the load it's repositioning TOWARD. Yard-return at
// the end of the day stays in day overhead.
interface ProfitabilityLoad {
  eventId:           string;
  title:             string | null;
  revenue:           number;       // prorated leg share for relays, full load_price otherwise
  driverPay:         number;       // event.driver_pay (0 if missing)
  netToTruck:        number;       // revenue - driverPay
  loadedMiles:       number;       // sum of movement.miles where link.role='loaded' → this event
  inboundDhMiles:    number;       // sum of movement.miles where link.role='transition' → toEventId = this event
  attributedMiles:   number;       // loadedMiles + inboundDhMiles
  dwellMin:          number;       // sum of movement.duration_min where link.role='dwell' → this event
  rpmLoaded:         number | null;  // revenue / loadedMiles
  rpmAllIn:          number | null;  // revenue / attributedMiles
  deadheadPct:       number | null;  // inboundDhMiles / attributedMiles (0..1)
  /** Present (0..1) only when this event is a relay leg and its
   *  revenue is the prorated leg share. NULL/omitted for non-relay
   *  loads. The full load price is `revenue / relayShare`. UI shows
   *  a "Prorated 60%" badge when this is set. */
  relayShare?:       number | null;
}

interface ProfitabilityDay {
  totalRevenue:        number;
  totalDriverPay:      number;
  netToTruck:          number;
  loadedMiles:         number;       // sum across loads
  inboundDhMiles:      number;       // sum across loads
  attributedMiles:     number;       // loadedMiles + inboundDhMiles
  yardReturnMiles:     number;       // end-of-day transition (only fromEventId, no toEventId)
  unattributedMiles:   number;       // rest + unrelated + unlinked
  totalMiles:          number;       // attributed + yardReturn + unattributed
  dayRpm:              number | null;  // revenue / attributedMiles
  dayRpmTotal:         number | null;  // revenue / totalMiles (brutal honesty)
  deadheadPctOfDay:    number | null;  // (inboundDh + yardReturn) / totalMiles
}

interface ProfitabilityPayload {
  loads: ProfitabilityLoad[];
  day:   ProfitabilityDay;
}

interface TimelinePayload {
  asset: { id: number; name: string; unit: string | null };
  windowFrom: string;
  windowTo: string;
  events: TimelineEvent[];
  movements: MovementOut[];
  links: MovementLinkOut[];   // current truth only (superseded_at IS NULL)
  profitability: ProfitabilityPayload;
}

timeline.get("/assets/:assetId", async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  const from = c.req.query("from");
  const to   = c.req.query("to");

  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO)"] } satisfies ApiErrorResponse, 400);
  }

  // Asset metadata (also confirms the asset belongs to the org).
  const { data: asset, error: aErr } = await sb
    .from("assets")
    .select("id, name, unit")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (aErr || !asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  // Events whose [start, end] intersects the window. Boundary-events
  // (a multi-day load that started before `from`) are included so the
  // timeline doesn't show partial trip endpoints with no context.
  // Soft-deleted events excluded so the dispatcher never sees ghost
  // loads on the timeline.
  const { data: events, error: eErr } = await sb
    .from("events")
    .select("id, load_id, title, start, \"end\", status, event_kind, non_revenue_type, relay_role, leg_index, driver_name, driver_pay, loaded_miles, load:loads(load_price, total_billable, load_num)")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .lt("start", to)
    .gt("end", from)
    .order("start", { ascending: true });
  if (eErr) {
    console.error("[GET /v1/timeline/assets/:id] events:", eErr);
    return c.json({ error: "fetch_failed", detail: eErr.message } satisfies ApiErrorResponse, 500);
  }
  const eventIds = ((events ?? []) as Array<{ id: string }>).map((e) => e.id);

  // Stops for each event — single batched query.
  const { data: stops } = eventIds.length > 0
    ? await sb
        .from("stops")
        .select("id, event_id, sequence, type, is_handoff, facility_name, address, city, state, appt_start, appt_end, lat, lng")
        .in("event_id", eventIds)
        .order("sequence", { ascending: true })
    : { data: [] };
  const stopsByEvent = new Map<string, TimelineEvent["stops"]>();
  for (const s of (stops ?? []) as Array<{
    id: string; event_id: string; sequence: number; type: string | null;
    is_handoff: boolean | null;
    facility_name: string | null; address: string | null; city: string | null; state: string | null;
    appt_start: string | null; appt_end: string | null; lat: number | null; lng: number | null;
  }>) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push({
      id:           s.id,
      sequence:     s.sequence,
      type:         s.type,
      // Handoff boundaries come in two flavors: the original dedicated
      // `type:'relay'` marker stop, and the newer "any stop can be a
      // handoff" flag. The client needs BOTH to slice leg windows —
      // without is_handoff a modern relay looks marker-less and every
      // leg falls back to showing the whole load's stops.
      isHandoff:    s.is_handoff ?? false,
      facilityName: s.facility_name,
      address:      s.address,
      city:         s.city,
      state:        s.state,
      apptStart:    s.appt_start,
      apptEnd:      s.appt_end,
      lat:          s.lat,
      lng:          s.lng,
    });
    stopsByEvent.set(s.event_id, arr);
  }

  // Build a relay-share map by fetching partner legs for any relay
  // events in our window. Partner legs likely live on DIFFERENT assets
  // (that's what a handoff is), so they're not in the current events
  // array — the helper asks the DB for them by load_id.
  //
  // Shared with /v1/fleet/performance and mirroring the dashboard's
  // revenueByAsset chart, so all three prorate identically (including
  // the 1/N fallback when a load has no miles on any leg).
  const relayShareByEventId = await buildRelayShareMap(
    orgId,
    ((events ?? []) as Array<{ id: string; load_id: string | null; relay_role: string | null }>),
  );

  const eventsOut: TimelineEvent[] = ((events ?? []) as Array<{
    id: string; title: string | null; start: string; end: string;
    status: string | null; event_kind: string | null; non_revenue_type: string | null;
    relay_role: string | null; leg_index: number | null;
    driver_name: string | null; driver_pay: number | null; loaded_miles: number | null;
    load: { load_price: number | null; total_billable: number | null; load_num: string | null } | null;
  }>).map((e) => ({
    id:             e.id,
    title:          e.title,
    start:          e.start,
    end:            e.end,
    status:         e.status,
    eventKind:      e.event_kind,
    nonRevenueType: e.non_revenue_type,
    relayRole:      e.relay_role === 'pickup' || e.relay_role === 'transfer' || e.relay_role === 'delivery'
                      ? e.relay_role
                      : null,
    legIndex:       e.relay_role != null ? (e.leg_index ?? null) : null,
    loadPrice:      e.load?.load_price ?? null,
    totalBillable:  e.load?.total_billable ?? null,
    loadNum:        e.load?.load_num   ?? null,
    driverPay:      e.driver_pay ?? null,
    loadedMiles:    e.loaded_miles ?? null,
    driverName:     e.driver_name,
    stops:          stopsByEvent.get(e.id) ?? [],
  }));

  // Movements whose start_time falls in the window OR end_time falls
  // in the window — covers boundary movements both ways.
  const { data: movementRows, error: mErr } = await sb
    .from("movements")
    .select(MOVEMENT_COLS)
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gte("start_time", from)
    .lt("start_time", to)
    .order("start_time", { ascending: true });
  if (mErr) {
    console.error("[GET /v1/timeline/assets/:id] movements:", mErr);
    return c.json({ error: "fetch_failed", detail: mErr.message } satisfies ApiErrorResponse, 500);
  }
  const movementsOut = ((movementRows ?? []) as MovementRow[]).map(rowToMovement);
  const movementIds  = movementsOut.map((m) => m.id);

  // Current-truth links for those movements.
  const { data: linkRows } = movementIds.length > 0
    ? await sb
        .from("movement_links")
        .select(LINK_COLS)
        .eq("org_id", orgId)
        .in("movement_id", movementIds)
        .is("superseded_at", null)
    : { data: [] };
  const linksOut = ((linkRows ?? []) as MovementLinkRow[]).map(rowToLink);

  // ── Profitability attribution (revenue/mile per load + day) ─────
  // Inbound convention: every deadhead mile is attributed to the load
  // it's heading TOWARD. The end-of-day yard return (transition with
  // only a fromEventId) is day overhead. Rest / unrelated / unlinked
  // movements stay in day overhead. See the design discussion in the
  // commit for the rationale — TL;DR: this gives each load a clean
  // "what did it cost to do this load" P&L without double-counting.
  const profitability = computeProfitability(eventsOut, movementsOut, linksOut, relayShareByEventId);

  const res: TimelinePayload = {
    asset:      { id: asset.id, name: asset.name, unit: asset.unit ?? null },
    windowFrom: from,
    windowTo:   to,
    events:     eventsOut,
    movements:  movementsOut,
    links:      linksOut,
    profitability,
  };
  return c.json(res);
});

// ── Profitability attribution ──────────────────────────────────────

function computeProfitability(
  events: TimelineEvent[],
  movements: MovementOut[],
  links: MovementLinkOut[],
  relayShareByEventId: Map<string, number>,
): ProfitabilityPayload {
  // Index by lookup keys we'll need.
  const linkByMovementId = new Map<string, MovementLinkOut>();
  for (const l of links) linkByMovementId.set(l.movementId, l);

  // Only revenue events participate as attribution targets — a
  // non_revenue event (maintenance, vacation) shouldn't have a P&L
  // even if a movement is tagged 'loaded' for it.
  const revenueEvents = events.filter((e) => e.eventKind !== "non_revenue");
  const revenueEventIds = new Set(revenueEvents.map((e) => e.id));

  // Per-load accumulator.
  type Acc = { loadedMiles: number; inboundDhMiles: number; dwellMin: number };
  const accByEvent = new Map<string, Acc>();
  const getAcc = (eventId: string): Acc => {
    let a = accByEvent.get(eventId);
    if (!a) { a = { loadedMiles: 0, inboundDhMiles: 0, dwellMin: 0 }; accByEvent.set(eventId, a); }
    return a;
  };

  // Day-level accumulators for non-attributed driving.
  let yardReturnMiles    = 0;
  let unattributedMiles  = 0;

  for (const m of movements) {
    const miles = m.miles ?? 0;
    if (miles === 0 && m.durationMin == null) continue;

    const link = linkByMovementId.get(m.id);
    if (!link) {
      // No link → unclassified. Treat as unattributed (we don't know
      // which load to credit it to). Surfaces as day overhead.
      unattributedMiles += miles;
      continue;
    }

    switch (link.role) {
      case "loaded": {
        if (link.loadedEventId && revenueEventIds.has(link.loadedEventId)) {
          getAcc(link.loadedEventId).loadedMiles += miles;
        } else {
          unattributedMiles += miles;
        }
        break;
      }
      case "transition": {
        // Inbound attribution: if there's a 'to' event AND it's a
        // revenue event, credit miles to that load. If only a 'from'
        // (heading to yard / end of day), it's the yard-return overhead.
        if (link.toEventId && revenueEventIds.has(link.toEventId)) {
          getAcc(link.toEventId).inboundDhMiles += miles;
        } else if (link.fromEventId && !link.toEventId) {
          yardReturnMiles += miles;
        } else {
          // Transition with no usable refs — treat as unattributed.
          unattributedMiles += miles;
        }
        break;
      }
      case "dwell": {
        // Dwell adds time, not miles (post-coalescing it should be near-
        // zero miles anyway). Time still attributed to the load.
        if (link.loadedEventId && revenueEventIds.has(link.loadedEventId)) {
          getAcc(link.loadedEventId).dwellMin += (m.durationMin ?? 0);
        }
        // Miles, if any, go to unattributed since dwell isn't a driving
        // segment in the cost sense.
        unattributedMiles += miles;
        break;
      }
      case "rest":
      case "unrelated":
      default: {
        unattributedMiles += miles;
        break;
      }
    }
  }

  // Build per-load output. Order by event start so the strip reads
  // left→right matching the timeline above.
  const loads: ProfitabilityLoad[] = revenueEvents
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((e) => {
      const acc = accByEvent.get(e.id) ?? { loadedMiles: 0, inboundDhMiles: 0, dwellMin: 0 };
      // Revenue is total billable (linehaul + accessorials), maintained
      // by the loads_compute_total_billable trigger. Falls back to
      // load_price for legacy rows.
      //
      // Relay legs prorate revenue by per-leg loaded_miles so no leg
      // reports the full load price (which would multiply it by the leg
      // count when summed across legs). Matches the dashboard
      // revenueByAsset chart's logic. Non-relay events get share=1.
      const loadRevenue = e.totalBillable ?? e.loadPrice ?? 0;
      const share = relayShareByEventId.get(e.id) ?? 1;
      const revenue   = loadRevenue * share;
      const isRelayLeg = relayShareByEventId.has(e.id);
      const driverPay = e.driverPay ?? 0;
      // Loaded miles: prefer ELD-attributed (movement_links) when
      // present, else fall back to the stored quoted miles on the
      // event. Non-ELD trucks have no movement attribution and rely
      // entirely on the fallback.
      const loadedMiles = acc.loadedMiles > 0 ? acc.loadedMiles : (e.loadedMiles ?? 0);
      const attributedMiles = loadedMiles + acc.inboundDhMiles;
      const rpmLoaded = loadedMiles > 0 ? revenue / loadedMiles : null;
      const rpmAllIn  = attributedMiles  > 0 ? revenue / attributedMiles : null;
      const deadheadPct = attributedMiles > 0 ? acc.inboundDhMiles / attributedMiles : null;
      return {
        eventId:         e.id,
        title:           e.title,
        revenue,
        driverPay,
        netToTruck:      revenue - driverPay,
        loadedMiles,
        inboundDhMiles:  acc.inboundDhMiles,
        attributedMiles,
        dwellMin:        acc.dwellMin,
        rpmLoaded,
        rpmAllIn,
        deadheadPct,
        relayShare:      isRelayLeg ? share : null,
      };
    });

  // Day-level rollup.
  const totalRevenue   = loads.reduce((s, l) => s + l.revenue, 0);
  const totalDriverPay = loads.reduce((s, l) => s + l.driverPay, 0);
  const loadedMiles    = loads.reduce((s, l) => s + l.loadedMiles, 0);
  const inboundDhMiles = loads.reduce((s, l) => s + l.inboundDhMiles, 0);
  const attributedMiles = loadedMiles + inboundDhMiles;
  const totalMiles      = attributedMiles + yardReturnMiles + unattributedMiles;

  const day: ProfitabilityDay = {
    totalRevenue,
    totalDriverPay,
    netToTruck:        totalRevenue - totalDriverPay,
    loadedMiles,
    inboundDhMiles,
    attributedMiles,
    yardReturnMiles,
    unattributedMiles,
    totalMiles,
    dayRpm:            attributedMiles > 0 ? totalRevenue / attributedMiles : null,
    dayRpmTotal:       totalMiles      > 0 ? totalRevenue / totalMiles      : null,
    deadheadPctOfDay:  totalMiles      > 0
      ? (inboundDhMiles + yardReturnMiles) / totalMiles
      : null,
  };

  return { loads, day };
}

// ── POST /movements — create a manual movement ────────────────────

interface CreateMovementBody {
  assetId:         number;
  driverId?:       number;
  startTime:       string;
  endTime?:        string;
  durationMin?:    number;
  miles?:          number;
  origin?:         string;
  destination?:    string;
  originLat?:      number;
  originLon?:      number;
  destinationLat?: number;
  destinationLon?: number;
  notes?:          string;
}

timeline.post("/movements", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  let body: CreateMovementBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  if (!Number.isFinite(body.assetId) || !body.startTime) {
    return c.json({ error: "validation_failed", errors: ["assetId and startTime required"] } satisfies ApiErrorResponse, 400);
  }

  // Confirm the asset belongs to the org before insert.
  const { data: asset } = await sb
    .from("assets")
    .select("id")
    .eq("id", body.assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  const { data, error } = await sb
    .from("movements")
    .insert({
      org_id:           orgId,
      asset_id:         body.assetId,
      driver_id:        body.driverId ?? null,
      source:           "manual",
      start_time:       body.startTime,
      end_time:         body.endTime ?? null,
      duration_min:     body.durationMin ?? null,
      miles:            body.miles ?? null,
      origin:           body.origin ?? null,
      destination:      body.destination ?? null,
      origin_lat:       body.originLat ?? null,
      origin_lon:       body.originLon ?? null,
      destination_lat:  body.destinationLat ?? null,
      destination_lon:  body.destinationLon ?? null,
      notes:            body.notes ?? null,
      created_by:       userId,
    })
    .select(MOVEMENT_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/timeline/movements] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ movement: rowToMovement(data as MovementRow) });
});

// ── PATCH /movements/:id — edit manual movement ───────────────────

interface UpdateMovementBody {
  startTime?:      string;
  endTime?:        string | null;
  durationMin?:    number | null;
  miles?:          number | null;
  origin?:         string | null;
  destination?:    string | null;
  originLat?:      number | null;
  originLon?:      number | null;
  destinationLat?: number | null;
  destinationLon?: number | null;
  notes?:          string | null;
}

timeline.patch("/movements/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");
  let body: UpdateMovementBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  const { data: existing } = await sb
    .from("movements")
    .select("id, source, deleted_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existing) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }
  if (existing.source === "motive") {
    return c.json({
      error: "motive_movement_immutable",
      detail: "Motive-sourced movements can't be edited (they're synced from the ELD).",
    } satisfies ApiErrorResponse, 400);
  }
  if (existing.deleted_at) {
    return c.json({ error: "movement_deleted" } satisfies ApiErrorResponse, 400);
  }

  // Build the partial update only including supplied fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: any = {};
  if ("startTime"      in body) update.start_time       = body.startTime;
  if ("endTime"        in body) update.end_time         = body.endTime;
  if ("durationMin"    in body) update.duration_min     = body.durationMin;
  if ("miles"          in body) update.miles            = body.miles;
  if ("origin"         in body) update.origin           = body.origin;
  if ("destination"    in body) update.destination      = body.destination;
  if ("originLat"      in body) update.origin_lat       = body.originLat;
  if ("originLon"      in body) update.origin_lon       = body.originLon;
  if ("destinationLat" in body) update.destination_lat  = body.destinationLat;
  if ("destinationLon" in body) update.destination_lon  = body.destinationLon;
  if ("notes"          in body) update.notes            = body.notes;

  const { data, error } = await sb
    .from("movements")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(MOVEMENT_COLS)
    .single();
  if (error || !data) {
    console.error("[PATCH /v1/timeline/movements/:id] update:", error);
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ movement: rowToMovement(data as MovementRow) });
});

// ── DELETE /movements/:id — soft delete (manual only) ─────────────

timeline.delete("/movements/:id", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const { data: existing } = await sb
    .from("movements")
    .select("id, source")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existing) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }
  if (existing.source === "motive") {
    return c.json({
      error: "motive_movement_immutable",
      detail: "Motive-sourced movements are history — mark them 'unrelated' via a link instead of deleting.",
    } satisfies ApiErrorResponse, 400);
  }

  const { error } = await sb
    .from("movements")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[DELETE /v1/timeline/movements/:id]:", error);
    return c.json({ error: "delete_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ ok: true });
});

// ── POST /links — assert a link (append + supersede) ──────────────

interface AssertLinkBody {
  movementId:      string;
  role:            "loaded" | "transition" | "dwell" | "rest" | "unrelated";
  loadedEventId?:  string;
  fromEventId?:    string;
  toEventId?:      string;
  dwellStopId?:    string;
  source?:         string;   // defaults to 'manual'
  confidence?:     "high" | "medium" | "low";
  reasoning?:      string;
}

timeline.post("/links", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  let body: AssertLinkBody;
  try { body = await c.req.json(); } catch {
    return c.json({ error: "invalid_json" } satisfies ApiErrorResponse, 400);
  }

  if (!body.movementId || !body.role) {
    return c.json({ error: "validation_failed", errors: ["movementId and role required"] } satisfies ApiErrorResponse, 400);
  }

  // Validate the role <-> refs combo matches the DB CHECK so we can
  // return a friendly error instead of a Postgres constraint message.
  const roleValid =
    (body.role === "loaded"      && !!body.loadedEventId) ||
    (body.role === "transition"  && (!!body.fromEventId || !!body.toEventId)) ||
    (body.role === "dwell"       && !!body.loadedEventId) ||
    (body.role === "rest" || body.role === "unrelated");
  if (!roleValid) {
    return c.json({
      error: "validation_failed",
      errors: ["role/event-references combination invalid (see API docs)"],
    } satisfies ApiErrorResponse, 400);
  }

  // Confirm the movement belongs to the org.
  const { data: movement } = await sb
    .from("movements")
    .select("id, org_id")
    .eq("id", body.movementId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!movement) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }

  const source = body.source ?? "manual";
  const isManual = source === "manual";

  // 1. Insert the new fact.
  const { data: inserted, error: insErr } = await sb
    .from("movement_links")
    .insert({
      org_id:           orgId,
      movement_id:      body.movementId,
      role:             body.role,
      loaded_event_id:  body.loadedEventId ?? null,
      from_event_id:    body.fromEventId   ?? null,
      to_event_id:      body.toEventId     ?? null,
      dwell_stop_id:    body.dwellStopId   ?? null,
      source,
      source_user:      isManual ? userId : null,
      confidence:       body.confidence ?? null,
      reasoning:        body.reasoning  ?? null,
    })
    .select(LINK_COLS)
    .single();
  if (insErr || !inserted) {
    console.error("[POST /v1/timeline/links] insert:", insErr);
    return c.json({ error: "insert_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
  }
  const newLink = inserted as MovementLinkRow;

  // 2. Mark all prior current links for this movement as superseded.
  //    (Exclude the row we just inserted by id.)
  const { error: supErr } = await sb
    .from("movement_links")
    .update({ superseded_at: new Date().toISOString(), superseded_by: newLink.id })
    .eq("org_id", orgId)
    .eq("movement_id", body.movementId)
    .is("superseded_at", null)
    .neq("id", newLink.id);
  if (supErr) {
    // The new fact still landed; surface the supersede issue but don't
    // 500 the whole call. Readers filter on superseded_at IS NULL so the
    // worst-case is two "current" rows until next cleanup.
    console.error("[POST /v1/timeline/links] supersede:", supErr);
  }

  return c.json({ link: rowToLink(newLink) });
});

// ── DELETE /links/:movementId — mark current link 'unrelated' ─────

timeline.delete("/links/:movementId", requireCapability("loads.edit"), async (c) => {
  const orgId  = c.get("orgId");
  const userId = c.get("userId");
  const movementId = c.req.param("movementId");

  const { data: movement } = await sb
    .from("movements")
    .select("id")
    .eq("id", movementId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!movement) {
    return c.json({ error: "movement_not_found" } satisfies ApiErrorResponse, 404);
  }

  // Insert an 'unrelated' fact + supersede previous in one go.
  const { data: inserted, error: insErr } = await sb
    .from("movement_links")
    .insert({
      org_id:      orgId,
      movement_id: movementId,
      role:        "unrelated",
      source:      "manual",
      source_user: userId,
      reasoning:   "Cleared via DELETE /v1/timeline/links/:movementId",
    })
    .select(LINK_COLS)
    .single();
  if (insErr || !inserted) {
    console.error("[DELETE /v1/timeline/links/:movementId]:", insErr);
    return c.json({ error: "insert_failed", detail: insErr?.message } satisfies ApiErrorResponse, 500);
  }

  const { error: supErr } = await sb
    .from("movement_links")
    .update({ superseded_at: new Date().toISOString(), superseded_by: (inserted as MovementLinkRow).id })
    .eq("org_id", orgId)
    .eq("movement_id", movementId)
    .is("superseded_at", null)
    .neq("id", (inserted as MovementLinkRow).id);
  if (supErr) {
    console.error("[DELETE /v1/timeline/links/:movementId] supersede:", supErr);
  }

  return c.json({ link: rowToLink(inserted as MovementLinkRow) });
});

// ── POST /assets/:assetId/auto-link — re-link a truck's window ──────
//
// The timeline's "Re-link day / week" buttons and the fleet page's bulk
// re-link. Runs the movement linker (lib/movementLinker.ts, spec in
// docs/movement-linking.md) for this truck over [from, to] — the same
// rules the 6-hourly job applies, written as source 'rule_v1'. Manual
// links are never touched. (This used to ask Claude to classify clusters
// from city names; the rules engine uses coordinates and replaced it.)

timeline.post("/assets/:assetId/auto-link", requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  const from = Date.parse(c.req.query("from") ?? "");
  const to   = Date.parse(c.req.query("to") ?? "");
  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 45 * 86_400_000) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO), from < to, at most 45 days"] } satisfies ApiErrorResponse, 400);
  }
  const { data: asset } = await sb.from("assets").select("id").eq("id", assetId).eq("org_id", orgId).maybeSingle();
  if (!asset) return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);

  try {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const r = await runMovementLinking(orgId, {
      from: day(from - 86_400_000),
      to: day(to + 86_400_000),
      assetIds: [assetId],
      utcWindow: { from, to },
    });
    return c.json({
      ok: true as const,
      linksWritten:   r.linksWritten + r.linksCleared,
      manualSkipped:  r.manualKept,
      totalMovements: r.drives,
      message: r.skipped
        ?? (r.drives === 0 ? "No settled driving in this window (the last 6 hours wait for the next run)." : undefined),
    });
  } catch (err) {
    console.error("[timeline auto-link] linker failed:", err);
    return c.json({ error: "relink_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse, 500);
  }
});

// ── GET /assets/:assetId/week-summary — per-day P&L for one truck ──
//
// Returns a 7-element array of compact profitability summaries (Sat
// through Fri) so the timeline page can paint a week-strip without
// 7 separate timeline payload fetches. Same attribution logic as the
// single-day endpoint — just iterated 7 times with day-bounded event
// filtering applied server-side (matches the client-side filter).
//
// Inputs:
//   - assetId          path param
//   - weekStart=YYYY-MM-DD   first day of the week (Saturday)
//   - tz=America/Denver      org TZ for naive-day boundary resolution
//
// Cheap intentionally: skips the heavy stops + links + movement detail
// payload; only needs events + movements + current-link rows.

interface WeekDaySummary {
  dayKey:           string;
  totalRevenue:     number;
  totalDriverPay:   number;
  loadCount:        number;
  loadedMiles:      number;
  inboundDhMiles:   number;
  attributedMiles:  number;
  yardReturnMiles:  number;
  unattributedMiles: number;
  totalMiles:       number;
  dayRpm:           number | null;
  dayRpmTotal:      number | null;
  deadheadPctOfDay: number | null;
}

interface WeekSummaryResponse {
  weekStart: string;
  days:      WeekDaySummary[];
  weekTotal: WeekDaySummary;
}

/** Naive-string day boundary in the org's TZ. Reused from the client
 *  shape so server + client agree on what "today" means. */
function shiftDayKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

timeline.get("/assets/:assetId/week-summary", async (c) => {
  const orgId = c.get("orgId");
  const assetId = Number(c.req.param("assetId"));
  const weekStart = c.req.query("weekStart");
  const tz = c.req.query("tz") || "America/Denver";

  if (!Number.isFinite(assetId)) {
    return c.json({ error: "validation_failed", errors: ["assetId must be numeric"] } satisfies ApiErrorResponse, 400);
  }
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return c.json({ error: "validation_failed", errors: ["weekStart=YYYY-MM-DD required"] } satisfies ApiErrorResponse, 400);
  }

  const { data: asset } = await sb
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!asset) {
    return c.json({ error: "asset_not_found" } satisfies ApiErrorResponse, 404);
  }

  // Single-pass design (replaces the old per-day loop that
  // double-counted overnight loads):
  //   1. Fetch the entire week's events + movements + links once.
  //   2. Bucket every entity into exactly ONE day:
  //        - a LOAD lives in its start-day bucket (revenue, pay,
  //          loaded miles, inbound dh — all credited there, even if
  //          the load delivers a day later).
  //        - a MOVEMENT lives in its start-time-day bucket for the
  //          yard-return / unattributed pile (miles that aren't tied
  //          to a load, like an end-of-day return).
  //   3. Per-day cards now sum exactly to the week total. Overnight
  //      loads no longer get counted twice.
  //
  // The display side (timeline grid + day-card row) still shows the
  // load on every day it intersects — that's the right visual
  // ("this load touches today"). Only the aggregation honors the
  // start-day rule.

  const weekStartNaive = `${weekStart}T00:00:00`;
  const weekEndExclusive = shiftDayKey(weekStart, 7);
  const weekEndNaive   = `${weekEndExclusive}T00:00:00`;

  // ── Events in the week (bucket by start day) ────────────────────
  const { data: events } = await sb
    .from("events")
    .select("id, load_id, relay_role, start, \"end\", event_kind, driver_pay, loaded_miles, load:loads(load_price, total_billable)")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gte("start", weekStartNaive)
    .lt("start", weekEndNaive);
  const eventList = ((events ?? []) as Array<{
    id: string; load_id: string | null; relay_role: string | null;
    start: string; end: string;
    event_kind: string | null; driver_pay: number | null;
    loaded_miles: number | null;
    load: { load_price: number | null; total_billable: number | null } | null;
  }>);

  // Build the same relay-share map used by the day endpoint so each
  // relay leg's revenue is its proportional share of the load price,
  // not the full price. Without this, the week-summary's daily
  // totalRevenue double-counts every relay it touches.
  const weekRelayShareByEventId = await buildRelayShareMap(orgId, eventList);
  /** event.id → its bucket dayKey (the load's start day). */
  const eventBucketDay = new Map<string, string>();
  const revenueEventIds = new Set<string>();
  for (const e of eventList) {
    eventBucketDay.set(e.id, e.start.slice(0, 10));
    if (e.event_kind !== "non_revenue") revenueEventIds.add(e.id);
  }

  // ── Movements in the week (bucket by start day in org TZ) ───────
  const naiveToUtcIso = (naive: string) => {
    const local = new Date(naive);
    const tzFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(local);
    const [d, t] = tzFmt.split(', ');
    const [mo, dd, yyyy] = d.split('/');
    const [hh, mi, ss] = t.split(':');
    const localAsUtc = Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mi, +ss);
    const offsetMs = localAsUtc - local.getTime();
    return new Date(local.getTime() - offsetMs).toISOString();
  };
  const movFrom = naiveToUtcIso(weekStartNaive);
  const movTo   = naiveToUtcIso(weekEndNaive);

  // ── Movements: within-week window + cross-week spillover ───────
  //
  // The within-window fetch catches normal-case movements. The
  // spillover fetch grabs movements that PHYSICALLY happened outside
  // the week but whose link points to a load IN the week (e.g. a load
  // pickup Fri end-of-week + delivery Sat start-of-next-week — last
  // week's loaded miles include both Fri and Sat morning driving so
  // RPM math stays honest).

  const { data: movementRows } = await sb
    .from("movements")
    .select("id, miles, start_time")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .is("deleted_at", null)
    .gte("start_time", movFrom)
    .lt("start_time", movTo);
  const inWindowMovements = ((movementRows ?? []) as Array<{
    id: string; miles: number | null; start_time: string;
  }>);

  /** Resolve a movement's bucket day from start_time in org TZ. */
  const utcToOrgDayKey = (utc: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utc));

  // Fetch every CURRENT link that touches our week — either by
  // movement-id (within-window movements) or by event-id reference
  // (spillover from a movement physically outside the week).
  const inWindowMovementIds = inWindowMovements.map((m) => m.id);
  const eventIds = eventList.map((e) => e.id);
  type LinkRow = {
    movement_id: string; role: string;
    loaded_event_id: string | null;
    from_event_id: string | null;
    to_event_id: string | null;
  };
  // Two parallel fetches kept simple: by-movement-id (in-window) and
  // by-event-ref (link spillover). PostgREST's .or() with .in() on
  // UUID columns is finicky enough that two clean queries are easier
  // than one combined string-built filter.
  const [byMovement, spilloverA, spilloverB, spilloverC] = await Promise.all([
    inWindowMovementIds.length > 0
      ? sb.from("movement_links")
          .select("movement_id, role, loaded_event_id, from_event_id, to_event_id")
          .eq("org_id", orgId)
          .in("movement_id", inWindowMovementIds)
          .is("superseded_at", null)
      : Promise.resolve({ data: [] as LinkRow[] }),
    eventIds.length > 0
      ? sb.from("movement_links")
          .select("movement_id, role, loaded_event_id, from_event_id, to_event_id")
          .eq("org_id", orgId)
          .in("loaded_event_id", eventIds)
          .is("superseded_at", null)
      : Promise.resolve({ data: [] as LinkRow[] }),
    eventIds.length > 0
      ? sb.from("movement_links")
          .select("movement_id, role, loaded_event_id, from_event_id, to_event_id")
          .eq("org_id", orgId)
          .in("from_event_id", eventIds)
          .is("superseded_at", null)
      : Promise.resolve({ data: [] as LinkRow[] }),
    eventIds.length > 0
      ? sb.from("movement_links")
          .select("movement_id, role, loaded_event_id, from_event_id, to_event_id")
          .eq("org_id", orgId)
          .in("to_event_id", eventIds)
          .is("superseded_at", null)
      : Promise.resolve({ data: [] as LinkRow[] }),
  ]);
  const linkByMovementId = new Map<string, LinkRow>();
  for (const set of [byMovement, spilloverA, spilloverB, spilloverC]) {
    for (const l of ((set.data ?? []) as LinkRow[])) {
      linkByMovementId.set(l.movement_id, l);
    }
  }

  // Fetch any spillover-movement rows we don't already have. These are
  // the physically-outside-window movements that link to in-window loads.
  const inWindowSet = new Set(inWindowMovementIds);
  const spilloverMovementIds = Array.from(linkByMovementId.keys()).filter((id) => !inWindowSet.has(id));
  const { data: spilloverMovementRows } = spilloverMovementIds.length > 0
    ? await sb
        .from("movements")
        .select("id, miles, start_time")
        .eq("org_id", orgId)
        .eq("asset_id", assetId)
        .is("deleted_at", null)
        .in("id", spilloverMovementIds)
    : { data: [] };
  const movementsList = [
    ...inWindowMovements,
    ...((spilloverMovementRows ?? []) as Array<{
      id: string; miles: number | null; start_time: string;
    }>),
  ];

  // ── Initialize per-day accumulators ─────────────────────────────
  type Bucket = {
    totalRevenue: number; totalDriverPay: number; loadCount: number;
    loadedMiles: number; inboundDhMiles: number;
    yardReturnMiles: number; unattributedMiles: number;
  };
  const buckets = new Map<string, Bucket>();
  for (let i = 0; i < 7; i++) {
    const k = shiftDayKey(weekStart, i);
    buckets.set(k, {
      totalRevenue: 0, totalDriverPay: 0, loadCount: 0,
      loadedMiles: 0, inboundDhMiles: 0,
      yardReturnMiles: 0, unattributedMiles: 0,
    });
  }

  // ── Load revenue + driver pay → load's start-day bucket ─────────
  //
  // loadCount counts LOADS, not legs. This endpoint is scoped to one
  // asset, so the usual relay case (each truck runs one leg) already
  // counts 1 per truck — but a truck that runs two legs of the SAME
  // relay on the same day would otherwise book that load twice. Track
  // the load ids already counted per day. (A truck running two legs of
  // one load on DIFFERENT days still counts once per day, so the week
  // total stays equal to the sum of its day bars.)
  const countedLoadsByDay = new Map<string, Set<string>>();
  for (const e of eventList) {
    if (e.event_kind === "non_revenue") continue;
    const day = eventBucketDay.get(e.id);
    if (!day) continue;
    const b = buckets.get(day);
    if (!b) continue;     // event outside the week (shouldn't happen given the query)
    // Total billable (linehaul + billable accessorials), prorated by
    // relay-leg share so the legs of one relay don't each contribute
    // the full load price. driverPay is already per-leg, no prorate.
    const loadRev = e.load?.total_billable ?? e.load?.load_price ?? 0;
    const share = weekRelayShareByEventId.get(e.id) ?? 1;
    b.totalRevenue   += loadRev * share;
    b.totalDriverPay += e.driver_pay ?? 0;
    if (e.load_id) {
      let seen = countedLoadsByDay.get(day);
      if (!seen) { seen = new Set<string>(); countedLoadsByDay.set(day, seen); }
      if (!seen.has(e.load_id)) { seen.add(e.load_id); b.loadCount += 1; }
    } else {
      // Standalone revenue event with no load row — count it directly.
      b.loadCount += 1;
    }
  }

  // ── Movement miles → load's start-day OR movement's own start-day ─
  //
  // Track which events got ELD-attributed loaded miles via movement
  // links. Events NOT in this set fall back to events.loaded_miles
  // (the stored quoted miles) in the post-pass below. This makes
  // non-ELD trucks show their loaded miles instead of 0, without
  // double-counting for ELD trucks where movement attribution is the
  // more accurate source.
  const eventsWithEldLoadedMiles = new Set<string>();
  for (const m of movementsList) {
    const miles = m.miles ?? 0;
    if (miles === 0) continue;
    const link = linkByMovementId.get(m.id);
    const movDay = utcToOrgDayKey(m.start_time);

    if (!link) {
      const b = buckets.get(movDay);
      if (b) b.unattributedMiles += miles;
      continue;
    }
    switch (link.role) {
      case "loaded": {
        const loadDay = link.loaded_event_id && eventBucketDay.get(link.loaded_event_id);
        const b = loadDay && revenueEventIds.has(link.loaded_event_id!)
          ? buckets.get(loadDay)
          : buckets.get(movDay);
        if (b) {
          if (loadDay && revenueEventIds.has(link.loaded_event_id!)) {
            b.loadedMiles += miles;
            eventsWithEldLoadedMiles.add(link.loaded_event_id!);
          } else {
            b.unattributedMiles += miles;
          }
        }
        break;
      }
      case "transition": {
        const toDay = link.to_event_id && eventBucketDay.get(link.to_event_id);
        if (toDay && revenueEventIds.has(link.to_event_id!)) {
          const b = buckets.get(toDay);
          if (b) b.inboundDhMiles += miles;
        } else if (link.from_event_id && !link.to_event_id) {
          const b = buckets.get(movDay);
          if (b) b.yardReturnMiles += miles;
        } else {
          const b = buckets.get(movDay);
          if (b) b.unattributedMiles += miles;
        }
        break;
      }
      default: {
        const b = buckets.get(movDay);
        if (b) b.unattributedMiles += miles;
        break;
      }
    }
  }

  // ── Loaded-miles fallback for events without ELD attribution ────
  // Every load has a stored loaded_miles value (from the rate con /
  // routing on save). For revenue events that didn't get ELD-attributed
  // loaded miles via movement_links above, add the stored value to
  // their bucket so non-ELD trucks (and pre-link ELD weeks) show their
  // real loaded miles instead of 0.
  for (const e of eventList) {
    if (e.event_kind === "non_revenue") continue;
    if (eventsWithEldLoadedMiles.has(e.id)) continue;
    const quoted = e.loaded_miles ?? 0;
    if (quoted === 0) continue;
    const day = eventBucketDay.get(e.id);
    if (!day) continue;
    const b = buckets.get(day);
    if (!b) continue;
    b.loadedMiles += quoted;
  }

  // ── Materialize per-day summaries ───────────────────────────────
  const days: WeekDaySummary[] = [];
  for (let i = 0; i < 7; i++) {
    const dayKey = shiftDayKey(weekStart, i);
    const b = buckets.get(dayKey)!;
    const attributedMiles = b.loadedMiles + b.inboundDhMiles;
    const totalMiles      = attributedMiles + b.yardReturnMiles + b.unattributedMiles;
    days.push({
      dayKey,
      totalRevenue:     b.totalRevenue,
      totalDriverPay:   b.totalDriverPay,
      loadCount:        b.loadCount,
      loadedMiles:      b.loadedMiles,
      inboundDhMiles:   b.inboundDhMiles,
      attributedMiles,
      yardReturnMiles:  b.yardReturnMiles,
      unattributedMiles: b.unattributedMiles,
      totalMiles,
      dayRpm:           attributedMiles > 0 ? b.totalRevenue / attributedMiles : null,
      dayRpmTotal:      totalMiles > 0 ? b.totalRevenue / totalMiles : null,
      deadheadPctOfDay: totalMiles > 0 ? (b.inboundDhMiles + b.yardReturnMiles) / totalMiles : null,
    });
  }

  // Week rollup.
  const weekRevenue    = days.reduce((s, d) => s + d.totalRevenue, 0);
  const weekDriverPay  = days.reduce((s, d) => s + d.totalDriverPay, 0);
  const weekLoadCount  = days.reduce((s, d) => s + d.loadCount, 0);
  const weekLoaded     = days.reduce((s, d) => s + d.loadedMiles, 0);
  const weekInboundDh  = days.reduce((s, d) => s + d.inboundDhMiles, 0);
  const weekAttributed = weekLoaded + weekInboundDh;
  const weekYardReturn = days.reduce((s, d) => s + d.yardReturnMiles, 0);
  const weekUnattr     = days.reduce((s, d) => s + d.unattributedMiles, 0);
  const weekTotalMiles = weekAttributed + weekYardReturn + weekUnattr;

  const res: WeekSummaryResponse = {
    weekStart,
    days,
    weekTotal: {
      dayKey:           weekStart,
      totalRevenue:     weekRevenue,
      totalDriverPay:   weekDriverPay,
      loadCount:        weekLoadCount,
      loadedMiles:      weekLoaded,
      inboundDhMiles:   weekInboundDh,
      attributedMiles:  weekAttributed,
      yardReturnMiles:  weekYardReturn,
      unattributedMiles: weekUnattr,
      totalMiles:       weekTotalMiles,
      dayRpm:           weekAttributed > 0 ? weekRevenue / weekAttributed : null,
      dayRpmTotal:      weekTotalMiles > 0 ? weekRevenue / weekTotalMiles : null,
      deadheadPctOfDay: weekTotalMiles > 0 ? (weekInboundDh + weekYardReturn) / weekTotalMiles : null,
    },
  };
  return c.json(res);
});

export default timeline;
