/**
 * /v1/tracking — public load tracking for curzontrucking.com/track.
 *
 * Two ways in, both landing on the same payload:
 *
 *   GET  /v1/tracking/:token           — link a dispatcher shared
 *   POST /v1/tracking/lookup {q}       — "does a load match this number?"
 *   POST /v1/tracking/lookup {q, zip}  — number + delivery ZIP unlocks it
 *
 * SECURITY NOTES — read before editing.
 *
 * 1. This route runs on the service-role client, so RLS does not apply. The
 *    explicit column lists below are the ONLY thing standing between a
 *    customer and the company's margins. `events` carries load_price,
 *    driver_pay, rate_per_mile, fuel_surcharge, factoring_company,
 *    invoice_num and payment_status; `loads` carries load_price and
 *    rate_con_pdf. Never `select("*")` here, and never spread a raw row
 *    into the response.
 *
 * 2. The org is pinned server-side. Do NOT copy the `?org_id=` override
 *    from capacity.ts — on this endpoint that would turn the portal into a
 *    cross-tenant reader for every org in FleetCal.
 *
 * 3. The bare-number search deliberately returns no identifying detail
 *    before the ZIP is supplied. loads.internal_load_id is sequential from
 *    10000 and load_num is usually sequential too, so echoing back a
 *    customer name would let anyone walk the numbers and harvest the whole
 *    customer list — which is exactly what the ZIP gate exists to prevent.
 *
 * 4. audit_log is NOT exposed. It carries prevLoadPrice/newLoadPrice,
 *    driverPay, billingStatus, broker and customer changes. The history
 *    feed is rebuilt from scratch below, emitting only status transitions.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import { positionForAsset, milesBetween } from "../lib/motivePosition.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const tracking = new Hono();

const ORG_ID = "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN"; // Curzon Trucking prod — pinned, never from input.

/** Progress bar steps, in order. `scheduled` sits before step one; the
 *  off-path statuses (cancelled / tonu / problem) are not steps at all. */
const STEPS = ["assigned", "dispatched", "en_route", "picked_up", "delivered"] as const;
type Step = (typeof STEPS)[number];

const STEP_LABEL: Record<Step, string> = {
  assigned:   "Assigned",
  dispatched: "Dispatched",
  en_route:   "En route",
  picked_up:  "Picked up",
  delivered:  "Delivered",
};

const EXCEPTION_STATUSES = new Set(["cancelled", "tonu", "problem"]);

// Only these columns ever leave this file.
// Column names verified against the live tables — schema.sql is a stale
// snapshot. commodity and weight live on `loads`, not `events`, and events
// has no pickup_city/delivery_city/trailer_num at all; locations come from
// stops. route_polyline is the already-cached Mapbox geometry for the leg,
// which is what the map draws.
const LOAD_COLS =
  "id, load_num, ref_nums, customer_id, commodity, weight, public_token, tracking_revoked_at, deleted_at";
const EVENT_COLS =
  "id, leg_index, status, start, driver_id, asset_id, trailer_type, route_polyline, audit_log, deleted_at";
const STOP_COLS =
  "id, event_id, sequence, type, facility_name, address, city, state, lat, lng, " +
  "appt_start, appt_end, arrived_at, is_handoff, timezone";

/** Rate limiter for the search path. In-process is fine: apps/api already
 *  requires a single replica for its interval jobs, so there is no second
 *  instance to coordinate with. */
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/** stops has no postal_code column — addresses come back from the geocoder
 *  as free text, so the ZIP is parsed out. Falls back to matching the city
 *  when an address has no 5-digit group. */
function zipMatches(stop: { address?: string | null; city?: string | null }, input: string): boolean {
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return false;

  const zips: string[] = (stop.address ?? "").match(/\b\d{5}\b/g) ?? [];
  if (zips.length) return zips.includes(cleaned);

  return (stop.city ?? "").trim().toLowerCase() === cleaned;
}

/** Overall status for a load whose legs may each carry their own. A relay is
 *  one journey to the customer, so the furthest-along leg wins — except that
 *  any leg in trouble surfaces immediately. */
function deriveStatus(legStatuses: string[]): string {
  if (!legStatuses.length) return "scheduled";
  if (legStatuses.some((s) => s === "problem")) return "problem";
  if (legStatuses.every((s) => s === "cancelled")) return "cancelled";
  if (legStatuses.every((s) => s === "tonu")) return "tonu";
  if (legStatuses.every((s) => s === "delivered")) return "delivered";

  const live = legStatuses.filter((s) => !EXCEPTION_STATUSES.has(s) && s !== "delivered");
  const ranked = live.map((s) => STEPS.indexOf(s as Step)).filter((i) => i >= 0);
  if (!ranked.length) return "scheduled";
  return STEPS[Math.max(...ranked)];
}

/** How close the truck has to be to count as "at" a stop. Yards and DCs are
 *  big; half a mile catches the truck on the property without firing on a
 *  highway that happens to run past the fence. */
const ARRIVAL_RADIUS_MI = 0.5;

/** Average speed used to turn remaining miles into a rough ETA. Deliberately
 *  conservative — this is a hint next to the appointment window, not a promise. */
const ETA_MPH = 50;

interface GeoStop { sequence: number; type: string; lat?: number | null; lng?: number | null; }

/** Status inferred from where the truck actually is, so the progress bar
 *  moves without depending on anyone tapping a button in a driver app.
 *  Returns the furthest step the position justifies, or null. */
function geofenceStep(
  position: { lat: number; lon: number },
  stops: GeoStop[]
): { step: Step | null; atSequence: number | null; nearestMiles: number | null } {
  const located = stops.filter((s) => s.lat != null && s.lng != null);
  if (!located.length) return { step: "en_route", atSequence: null, nearestMiles: null };

  const pickupIdx = located.findIndex((s) => s.type === "pickup");

  let nearestIdx = 0;
  let nearestMiles = Infinity;
  located.forEach((s, i) => {
    const d = milesBetween(position.lat, position.lon, s.lat as number, s.lng as number);
    if (d < nearestMiles) { nearestMiles = d; nearestIdx = i; }
  });

  if (nearestMiles <= ARRIVAL_RADIUS_MI) {
    // Past the shipper means the freight is on board. Sitting AT the shipper
    // does not — we can't see a trailer being loaded, so that stays en route.
    const step: Step = pickupIdx >= 0 && nearestIdx > pickupIdx ? "picked_up" : "en_route";
    return { step, atSequence: located[nearestIdx].sequence, nearestMiles };
  }

  return { step: "en_route", atSequence: null, nearestMiles };
}

interface AuditLike {
  changedAt?: string;
  newStatus?: string;
  prevStatus?: string;
}

/** Rebuilds a customer-safe history. Reads audit_log but emits ONLY status
 *  transitions — every pricing, pay, billing, broker and customer field in
 *  those entries is dropped on the floor. */
function buildHistory(
  events: { audit_log?: AuditLike[] | null }[],
  stops: { arrived_at?: string | null; city?: string | null; state?: string | null; type: string }[],
  podUploadedAt: string | null
) {
  const history: { at: string; type: string; label: string }[] = [];

  for (const event of events) {
    for (const entry of event.audit_log ?? []) {
      if (!entry?.newStatus || !entry.changedAt) continue;
      const step = STEP_LABEL[entry.newStatus as Step];
      history.push({
        at: entry.changedAt,
        type: "status",
        label: step ? `Status: ${step}` : `Status: ${entry.newStatus}`,
      });
    }
  }

  for (const stop of stops) {
    if (!stop.arrived_at) continue;
    const where = [stop.city, stop.state].filter(Boolean).join(", ");
    const verb = stop.type === "pickup" ? "Arrived at pickup" : stop.type === "delivery" ? "Arrived at delivery" : "Arrived at stop";
    history.push({ at: stop.arrived_at, type: "arrival", label: where ? `${verb} — ${where}` : verb });
  }

  if (podUploadedAt) {
    history.push({ at: podUploadedAt, type: "document", label: "Proof of delivery uploaded" });
  }

  return history.sort((a, b) => a.at.localeCompare(b.at));
}

/** Assembles the public payload for a load id. Returns null if the load is
 *  gone, soft-deleted, or has had its tracking link revoked. */
async function buildPayload(loadId: string) {
  const { data: load } = await sb
    .from("loads")
    .select(LOAD_COLS)
    .eq("id", loadId)
    .eq("org_id", ORG_ID)
    .is("deleted_at", null)
    .maybeSingle();

  if (!load || load.tracking_revoked_at) return null;

  const { data: rawEvents } = await sb
    .from("events")
    .select(EVENT_COLS)
    .eq("load_id", loadId)
    .eq("org_id", ORG_ID)
    .is("deleted_at", null)
    .order("leg_index", { ascending: true });

  const events = rawEvents ?? [];
  if (!events.length) return null;

  const eventIds = events.map((e: { id: string }) => e.id);

  const { data: rawStops } = await sb
    .from("stops")
    .select(STOP_COLS)
    .in("event_id", eventIds)
    .eq("org_id", ORG_ID)
    .order("sequence", { ascending: true });

  // Stops are anchored to their leg, then ordered within it — never matched
  // by position across legs.
  const legOrder = new Map<string, number>(
    events.map((e: { id: string; leg_index: number }) => [e.id, e.leg_index] as [string, number])
  );
  const ordered = (rawStops ?? []).sort(
    (a: { event_id: string; sequence: number }, b: { event_id: string; sequence: number }) =>
      (legOrder.get(a.event_id)! - legOrder.get(b.event_id)!) || (a.sequence - b.sequence)
  );

  // Every leg of a relay carries the FULL stop list, not just its own segment,
  // so concatenating across legs shows the customer each stop once per leg.
  // A relay is one journey to them: collapse to the distinct physical stops,
  // keeping the first occurrence (and therefore the earliest leg's ordering).
  // Sequence is part of the key so a genuine second visit to the same facility
  // still shows twice.
  const seen = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stops: any[] = [];
  for (const stop of ordered) {
    const key = [stop.sequence, stop.type, stop.lat, stop.lng, stop.appt_start].join("|");
    if (seen.has(key)) {
      // Keep the arrival if any leg recorded one.
      const prior = stops.find(
        (s) => s.sequence === stop.sequence && s.type === stop.type
      );
      if (prior && !prior.arrived_at && stop.arrived_at) prior.arrived_at = stop.arrived_at;
      continue;
    }
    seen.add(key);
    stops.push(stop);
  }

  // Relay points are an internal handoff between our own drivers — a yard swap
  // is not a stop on the customer's freight. Real stops that happen to carry a
  // handoff still show; only the pure relay points are dropped.
  const stopsForCustomer = stops.filter((s) => s.type !== "relay");

  const dbStatus = deriveStatus(events.map((e: { status: string }) => e.status));
  const isException = EXCEPTION_STATUSES.has(dbStatus);
  const isClosed = isException || dbStatus === "delivered";

  // Geofence — only for live loads. Dispatch's own status still counts; the
  // position can advance the bar but never walks it backwards.
  let truckPosition = null;
  let geo: ReturnType<typeof geofenceStep> | null = null;

  if (!isClosed) {
    const assetId = events.find((e: { asset_id: number | null }) => e.asset_id)?.asset_id;
    if (assetId) {
      const pos = await positionForAsset(ORG_ID, assetId);
      if (pos) {
        truckPosition = { lat: pos.lat, lon: pos.lon, locatedAt: pos.locatedAt, place: pos.description };
        geo = geofenceStep(pos, stopsForCustomer as GeoStop[]);
      }
    }
  }

  const dbIndex = isException ? -1 : STEPS.indexOf(dbStatus as Step);
  const geoIndex = geo?.step ? STEPS.indexOf(geo.step) : -1;
  const reachedIndex = isException ? -1 : Math.max(dbIndex, geoIndex);
  const status = isException ? dbStatus : (STEPS[reachedIndex] ?? "scheduled");

  // Proof of delivery only. rate_con and invoice are never customer-visible.
  const { data: pods } = await sb
    .from("load_documents")
    .select("id, storage_path, file_name, uploaded_at")
    .in("event_id", eventIds)
    .eq("org_id", ORG_ID)
    .eq("kind", "pod")
    .order("uploaded_at", { ascending: false });

  const documents = [];
  for (const doc of pods ?? []) {
    const { data: signed } = await sb.storage
      .from("load-documents")
      .createSignedUrl(doc.storage_path, 60 * 15);
    if (signed?.signedUrl) {
      documents.push({ fileName: doc.file_name, uploadedAt: doc.uploaded_at, url: signed.signedUrl });
    }
  }

  // Driver contact is scoped to the active window — once a load is delivered
  // there is no reason for a forwarded link to keep exposing a cell number.
  let driver = null;
  const driverId = events.find((e: { driver_id: number | null }) => e.driver_id)?.driver_id;
  if (driverId && !isException && status !== "delivered") {
    const { data: d } = await sb
      .from("drivers")
      .select("first_name, name, phone")
      .eq("id", driverId)
      .eq("org_id", ORG_ID)
      .maybeSingle();
    if (d) {
      driver = {
        firstName: d.first_name || (d.name ?? "").split(" ")[0] || null,
        phone: d.phone ?? null,
      };
    }
  }

  let customerName: string | null = null;
  if (load.customer_id) {
    const { data: customer } = await sb
      .from("customers")
      .select("name")
      .eq("id", load.customer_id)
      .eq("org_id", ORG_ID)
      .maybeSingle();
    customerName = customer?.name ?? null;
  }

  const deliveryStop = [...stopsForCustomer].reverse().find((s: { type: string }) => s.type === "delivery");
  const lastArrival = [...stopsForCustomer].reverse().find((s: { arrived_at?: string | null }) => s.arrived_at);

  let refNums: { label?: string; value?: string }[] = [];
  try {
    const parsed = typeof load.ref_nums === "string" ? JSON.parse(load.ref_nums) : load.ref_nums;
    if (Array.isArray(parsed)) refNums = parsed;
  } catch {
    if (load.ref_nums) refNums = [{ label: "Ref", value: String(load.ref_nums) }];
  }

  const deliveryStopGeo = [...stopsForCustomer].reverse().find(
    (s: { type: string; lat?: number | null }) => s.type === "delivery" && s.lat != null
  );
  let milesToDelivery: number | null = null;
  let etaEstimate: string | null = null;
  if (truckPosition && deliveryStopGeo) {
    milesToDelivery = Math.round(
      milesBetween(truckPosition.lat, truckPosition.lon, deliveryStopGeo.lat, deliveryStopGeo.lng)
    );
    // Straight-line miles at a conservative average — a hint, not a promise.
    etaEstimate = new Date(Date.now() + (milesToDelivery / ETA_MPH) * 3600 * 1000).toISOString();
  }

  return {
    token: load.public_token,
    loadNum: load.load_num,
    customerName,
    refNums,
    commodity: load.commodity ?? null,
    weight: load.weight ?? null,
    trailerType: events[0]?.trailer_type ?? null,
    // Cached Mapbox geometry per leg — the map draws these instead of
    // re-routing on every page view.
    routePolylines: events
      .map((e: { route_polyline?: string | null }) => e.route_polyline)
      .filter(Boolean),

    status,
    statusLabel: isException
      ? status === "problem" ? "Delayed" : status === "tonu" ? "Cancelled" : "Cancelled"
      : STEP_LABEL[status as Step] ?? "Scheduled",
    isException,

    progress: STEPS.map((step, i) => ({
      key: step,
      label: STEP_LABEL[step],
      done: i <= reachedIndex,
      current: i === reachedIndex,
    })),

    stops: stopsForCustomer.map((s: Record<string, unknown>) => ({
      sequence:     s.sequence,
      type:         s.type,
      facilityName: s.facility_name ?? null,
      city:         s.city ?? null,
      state:        s.state ?? null,
      lat:          s.lat ?? null,
      lng:          s.lng ?? null,
      apptStart:    s.appt_start ?? null,
      apptEnd:      s.appt_end ?? null,
      arrivedAt:    s.arrived_at ?? null,
    })),

    driver,
    truckPosition,
    atStopSequence: geo?.atSequence ?? null,
    milesToDelivery,
    etaEstimate,

    delivery: {
      city:  deliveryStop?.city ?? null,
      state: deliveryStop?.state ?? null,
      appt:  deliveryStop?.appt_start ?? null,
      apptEnd: deliveryStop?.appt_end ?? null,
    },
    lastKnown: lastArrival
      ? { at: lastArrival.arrived_at, city: lastArrival.city, state: lastArrival.state }
      : null,

    documents,
    history: buildHistory(events, stopsForCustomer, documents[0]?.uploadedAt ?? null),
  };
}

// ── GET /v1/tracking/:token ────────────────────────────────────────────────
tracking.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return c.json({ error: "Not found" }, 404);
  }

  const { data: load } = await sb
    .from("loads")
    .select("id")
    .eq("public_token", token)
    .eq("org_id", ORG_ID)
    .is("deleted_at", null)
    .maybeSingle();

  if (!load) return c.json({ error: "Not found" }, 404);

  const payload = await buildPayload(load.id);
  if (!payload) return c.json({ error: "Not found" }, 404);

  c.header("Cache-Control", "private, max-age=30");
  return c.json(payload);
});

// ── POST /v1/tracking/lookup ───────────────────────────────────────────────
tracking.post("/lookup", async (c) => {
  if (rateLimited(clientIp(c))) {
    return c.json({ error: "Too many lookups. Please try again later." }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const q = String(body.q ?? "").trim();
  const zip = String(body.zip ?? "").trim();

  if (q.length < 3) {
    return c.json({ error: "Enter a load or reference number." }, 400);
  }

  // Match on the broker's load number, our internal id, or any reference
  // number the customer was given.
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const filters = [`load_num.ilike.%${q}%`, `ref_nums.ilike.%${q}%`];
  if (numeric !== null) filters.push(`internal_load_id.eq.${numeric}`);

  const { data: candidates } = await sb
    .from("loads")
    .select("id")
    .eq("org_id", ORG_ID)
    .is("deleted_at", null)
    .is("tracking_revoked_at", null)
    .or(filters.join(","))
    .limit(25);

  const ids = (candidates ?? []).map((l: { id: string }) => l.id);
  if (!ids.length) {
    return c.json({ found: false });
  }

  // Step one confirms a match exists and nothing else. Returning the customer
  // name here would defeat the ZIP gate entirely — see note 3 at the top.
  if (!zip) {
    return c.json({ found: true, count: ids.length, needsZip: true });
  }

  for (const id of ids) {
    const payload = await buildPayload(id);
    if (!payload) continue;

    const { data: deliveryStops } = await sb
      .from("stops")
      .select("address, city, type, event_id")
      .in("event_id", (
        await sb.from("events").select("id").eq("load_id", id).is("deleted_at", null)
      ).data?.map((e: { id: string }) => e.id) ?? [])
      .eq("org_id", ORG_ID)
      .eq("type", "delivery");

    if ((deliveryStops ?? []).some((s: { address?: string; city?: string }) => zipMatches(s, zip))) {
      c.header("Cache-Control", "private, max-age=30");
      return c.json(payload);
    }
  }

  return c.json({ found: true, verified: false, error: "That ZIP code doesn't match the delivery address on file." }, 404);
});

export default tracking;
