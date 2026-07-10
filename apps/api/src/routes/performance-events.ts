/**
 * /v1/performance-events — dispatcher-side surface for Motive driver
 * performance events (hard-accel / hard-brake / hard-corner + v2 dashcam
 * events). Ingest lives in apps/api/src/lib/motivePerformanceIngest.ts;
 * this route is only the READ + dispatcher-workflow endpoints.
 *
 * Endpoints:
 *   GET  /v1/performance-events?status=new|all&limit=50
 *   GET  /v1/performance-events/:id
 *   PATCH /v1/performance-events/:id                     (dispatch_status,
 *                                                         assigned_driver_id,
 *                                                         dispatch_note)
 *   POST /v1/performance-events/:id/notify-driver        { driverId, message? }
 *
 * Curzon-only initial rollout via requireTruckHistoryOrg (same allowlist
 * driver-scoring uses). Also gated by requireModule("motive_integration") —
 * if the whole ELD surface is off, this feature is meaningless.
 *
 * Current-driver resolution: the authoritative source is the FLEETCAL
 * CALENDAR. We take the event's asset (resolved from Motive vehicle_id
 * via assets.motive_vehicle_id) and find the load event covering the
 * event_time — that event's driver_id is the driver we auto-fill. The
 * Motive-side driver_id/first_name/last_name is NOT trusted: Motive lags
 * on shift changes, drops driver detection when the phone dies, and
 * frequently attributes hard-brakes to whoever *last* signed in.
 * We DO surface Motive's name in the drawer as a "Motive shows X" hint
 * so the dispatcher notices when the two disagree.
 */

import { Hono } from "hono";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireTruckHistoryOrg, requireModule, requireCapability } from "../middleware/require.js";
import { supabase } from "../lib/supabase.js";
import { sendAutoPushToDriver } from "../lib/push.js";

const perf = new Hono<{ Variables: AuthVariables }>();

perf.use(
  "*",
  requireTruckHistoryOrg,
  requireModule("motive_integration"),
  requireCapability("safety.access"),
);

// ── Row shapes ─────────────────────────────────────────────────────────

interface PerfEventRow {
  id:                 number;
  event_type:         string;
  event_time:         string;
  end_time:           string | null;
  duration:           number | null;
  intensity:          string | null;
  vehicle_id:         number;
  vehicle_number:     string | null;
  asset_id:           number | null;
  driver_id:          number | null;
  driver_first_name:  string | null;
  driver_last_name:   string | null;
  lat:                number | null;
  lon:                number | null;
  location_label:     string | null;
  dispatch_status:    "new" | "confirmed" | "dismissed" | "notified";
  assigned_driver_id: number | null;
  dispatch_note:      string | null;
  dispatched_at:      string | null;
  dispatched_by_name: string | null;
  notified_at:        string | null;
  notified_driver_id: number | null;
  notified_message:   string | null;
}

const SELECT_COLS = `
  id, event_type, event_time, end_time, duration, intensity,
  vehicle_id, vehicle_number, asset_id,
  driver_id, driver_first_name, driver_last_name,
  lat, lon, location_label,
  dispatch_status, assigned_driver_id, dispatch_note,
  dispatched_at, dispatched_by_name,
  notified_at, notified_driver_id, notified_message
`.replace(/\s+/g, "");

// ── GET /v1/performance-events ─────────────────────────────────────────

perf.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const status = url.searchParams.get("status") ?? "new";
  const limit  = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("motive_performance_events")
    .select(SELECT_COLS)
    .eq("org_id", orgId)
    .order("event_time", { ascending: false })
    .limit(limit);
  if (status !== "all") q = q.eq("dispatch_status", status);

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/performance-events]", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  // Separate count query so the bell can show unread even when the
  // list is filtered to all/new — cheap thanks to the partial index.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (supabase as any)
    .from("motive_performance_events")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("dispatch_status", "new");

  return c.json({
    events:     (data ?? []) as PerfEventRow[],
    newCount:   count ?? 0,
  });
});

// ── GET /v1/performance-events/:id ─────────────────────────────────────
//
// Full detail plus the resolved current driver from the latest driving-
// period for the vehicle. Dispatcher sees both the Motive-reported driver
// on the event AND the latest-open-period driver — usually the same, but
// when they diverge (shift change mid-event) the drawer surfaces both so
// the dispatcher can choose.

perf.get("/:id", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: eventRow, error } = await (supabase as any)
    .from("motive_performance_events")
    .select(SELECT_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/performance-events/:id]", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!eventRow) return c.json({ error: "not_found" }, 404);

  const event = eventRow as PerfEventRow;

  // Autofilled driver comes from the FleetCal calendar — not from Motive.
  // We can't trust Motive's driver attribution (see file header).
  const suggested = await resolveCurrentDriver(orgId, event.asset_id, event.event_time);

  return c.json({ event, suggestedDriver: suggested });
});

// ── PATCH /v1/performance-events/:id ───────────────────────────────────

perf.patch("/:id", async (c) => {
  const orgId  = c.get("orgId");
  const id     = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);

  const body = await c.req.json().catch(() => null) as {
    dispatch_status?:    PerfEventRow["dispatch_status"];
    assigned_driver_id?: number | null;
    dispatch_note?:      string | null;
  } | null;
  if (!body) return c.json({ error: "bad_body" }, 400);

  // Only allow moves out of 'new' via this endpoint. Going BACK to 'new'
  // is intentionally not supported — once acted upon, the event stays
  // visible under 'all' and the bell count doesn't rewind.
  if (body.dispatch_status && !["confirmed", "dismissed"].includes(body.dispatch_status)) {
    return c.json({ error: "bad_status" }, 400);
  }

  const patch: Record<string, unknown> = {};
  if (body.dispatch_status) {
    patch.dispatch_status    = body.dispatch_status;
    patch.dispatched_at      = new Date().toISOString();
    // Clerk userId is the only always-present identity in AuthVariables.
    // Human-readable name would need a Clerk lookup — deferring; the
    // drawer will resolve userId → display name on the client via
    // the existing dispatcher directory when it shows history.
    patch.dispatched_by_name = c.get("userId") ?? null;
  }
  if (body.assigned_driver_id !== undefined) patch.assigned_driver_id = body.assigned_driver_id;
  if (body.dispatch_note      !== undefined) patch.dispatch_note      = body.dispatch_note;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("motive_performance_events")
    .update(patch)
    .eq("org_id", orgId)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) {
    console.error("[PATCH /v1/performance-events/:id]", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  if (!data) return c.json({ error: "not_found" }, 404);
  return c.json({ event: data as PerfEventRow });
});

// ── POST /v1/performance-events/:id/notify-driver ──────────────────────
//
// Sends the safety push and marks the event as notified. Guard rails:
//   - safety_alert org rule must be enabled (per-driver override too)
//   - a driver ID is required (dispatcher confirmed)
//   - once notified, this endpoint returns 409 on repeat calls so a
//     double-click doesn't spam the driver

perf.post("/:id/notify-driver", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);

  const body = await c.req.json().catch(() => null) as {
    driverId: number;
    message?: string;
  } | null;
  if (!body || !Number.isFinite(body.driverId)) return c.json({ error: "bad_body" }, 400);

  // Load event + confirm still notifiable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: evRow, error: evErr } = await (supabase as any)
    .from("motive_performance_events")
    .select(SELECT_COLS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (evErr) return c.json({ error: "fetch_failed", detail: evErr.message }, 500);
  if (!evRow) return c.json({ error: "not_found" }, 404);
  const event = evRow as PerfEventRow;
  if (event.dispatch_status === "notified" && event.notified_at) {
    return c.json({ error: "already_notified", notifiedAt: event.notified_at }, 409);
  }

  // Confirm the driver belongs to this org — prevents a spoofed
  // driverId targeting someone else's driver.
  const { data: drv, error: drvErr } = await supabase
    .from("drivers")
    .select("id, name")
    .eq("id", body.driverId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (drvErr) return c.json({ error: "driver_fetch_failed", detail: drvErr.message }, 500);
  if (!drv)  return c.json({ error: "driver_not_in_org" }, 400);

  const label = formatEventLabel(event.event_type);
  const title = "Safety alert from dispatch";
  const bodyText =
    body.message?.trim() ||
    `${label} logged on truck ${event.vehicle_number ?? event.vehicle_id} at ${formatShortTime(event.event_time)}. ` +
    `Please review your driving and reach out to dispatch with any context.`;

  const sent = await sendAutoPushToDriver(orgId, body.driverId, "safety_alert", {
    title,
    body: bodyText,
    data: {
      kind:             "safety_alert",
      performanceEventId: id,
      vehicleNumber:    event.vehicle_number,
      eventType:        event.event_type,
      eventTime:        event.event_time,
    },
  });

  if (!sent) {
    // Rule disabled at org level or per-driver override — surface so
    // the dispatcher knows the push didn't go out. We deliberately do
    // NOT flip dispatch_status to notified in this case.
    return c.json({ error: "notification_suppressed", detail: "org rule or driver override blocks safety_alert pushes" }, 409);
  }

  // Mark notified — idempotent-ish: even if the update loses to a race,
  // the OP-check above prevents double-fire on retry.
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: updErr } = await (supabase as any)
    .from("motive_performance_events")
    .update({
      dispatch_status:    "notified",
      assigned_driver_id: body.driverId,
      notified_at:        now,
      notified_driver_id: body.driverId,
      notified_message:   bodyText,
    })
    .eq("org_id", orgId)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();
  if (updErr) {
    console.error("[POST /v1/performance-events/:id/notify-driver] update failed after push:", updErr);
    // Push already fired — return 200 with a warning rather than 500
    // so the client marks the row locally.
    return c.json({ event: null, warning: "push_sent_but_update_failed" }, 200);
  }
  return c.json({ event: updated as PerfEventRow, driverName: (drv as { name: string }).name });
});

export default perf;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Autofill driver from the FleetCal CALENDAR (not from Motive).
 *
 * Logic:
 *   1. If asset_id unresolved (event vehicle_id doesn't map to any
 *      fleetcal asset), return null and let the dispatcher pick manually.
 *   2. Find the calendar event on that asset covering event_time.
 *      Calendar `start`/`end` are naive Mountain Time strings
 *      ("YYYY-MM-DDTHH:mm"), so we convert event_time (UTC) to the same
 *      shape and do a plain string BETWEEN — the alphanumeric ordering
 *      is monotonic within the format. Prefer the row with the tightest
 *      window (soonest end after event_time) to disambiguate overlapping
 *      relays cleanly.
 *   3. Fall back to the most recent event that ENDED before event_time
 *      on the same asset — covers the case where an alert lands during a
 *      brief gap between events (deadhead into next load).
 *   4. If we still have nothing, the driver_asset_prefs default driver
 *      for the asset is a last-ditch guess. Better than nothing on a
 *      truck that's been scheduled but not dispatched yet.
 */
async function resolveCurrentDriver(
  orgId: string,
  assetId: number | null,
  eventTimeUtc: string,
): Promise<{
  fleetcalDriverId: number | null;
  displayName:      string | null;
  source:           "calendar_active" | "calendar_recent" | "asset_default" | null;
  calendarEventId:  string | null;
  loadNum:          string | null;
} | null> {
  if (assetId == null) return null;

  const naiveMt = utcIsoToNaiveMt(eventTimeUtc);
  if (!naiveMt) return null;

  // (1) Active event covering event_time — start <= t <= end.
  const { data: active } = await supabase
    .from("events")
    .select("id, driver_id, driver_name, load_num, start, end")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .not("driver_id", "is", null)
    .lte("start", naiveMt)
    .gte("end",   naiveMt)
    .order("end", { ascending: true })
    .limit(1);

  const activeRow = (active ?? [])[0] as
    | { id: string; driver_id: number; driver_name: string | null; load_num: string | null }
    | undefined;
  if (activeRow) {
    return {
      fleetcalDriverId: activeRow.driver_id,
      displayName:      activeRow.driver_name ?? (await lookupDriverName(activeRow.driver_id)),
      source:           "calendar_active",
      calendarEventId:  activeRow.id,
      loadNum:          activeRow.load_num,
    };
  }

  // (2) Most recent event that ended at or before event_time.
  const { data: prior } = await supabase
    .from("events")
    .select("id, driver_id, driver_name, load_num")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .not("driver_id", "is", null)
    .lte("end", naiveMt)
    .order("end", { ascending: false })
    .limit(1);

  const priorRow = (prior ?? [])[0] as
    | { id: string; driver_id: number; driver_name: string | null; load_num: string | null }
    | undefined;
  if (priorRow) {
    return {
      fleetcalDriverId: priorRow.driver_id,
      displayName:      priorRow.driver_name ?? (await lookupDriverName(priorRow.driver_id)),
      source:           "calendar_recent",
      calendarEventId:  priorRow.id,
      loadNum:          priorRow.load_num,
    };
  }

  // (3) Default driver assigned to this asset (driver_asset_prefs).
  const { data: pref } = await supabase
    .from("driver_asset_prefs")
    .select("driver_id")
    .eq("org_id", orgId)
    .eq("asset_id", assetId)
    .maybeSingle();
  const prefDriverId = (pref as { driver_id: number } | null)?.driver_id ?? null;
  if (prefDriverId != null) {
    return {
      fleetcalDriverId: prefDriverId,
      displayName:      await lookupDriverName(prefDriverId),
      source:           "asset_default",
      calendarEventId:  null,
      loadNum:          null,
    };
  }

  return null;
}

async function lookupDriverName(driverId: number): Promise<string | null> {
  const { data } = await supabase
    .from("drivers")
    .select("name")
    .eq("id", driverId)
    .maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

/** Convert a UTC ISO timestamp to a naive Mountain-Time "YYYY-MM-DDTHH:mm"
 *  string so it can string-compare against events.start / events.end. */
function utcIsoToNaiveMt(iso: string): string | null {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

function formatEventLabel(eventType: string): string {
  switch (eventType) {
    case "hard_accel":       return "A hard acceleration";
    case "hard_brake":       return "A hard brake";
    case "hard_corner":      return "A hard cornering";
    case "tailgating":       return "A tailgating event";
    case "cell_phone":       return "A phone-use event";
    case "distraction":      return "A distraction event";
    case "drowsiness":       return "A drowsiness event";
    case "seatbelt":         return "A seatbelt violation";
    default:                 return `A ${eventType.replace(/_/g, " ")} event`;
  }
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  return isFinite(d.getTime())
    ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : iso;
}
