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
import { deriveSeverity, type SeverityLevel } from "@fleetcal/types";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireTruckHistoryOrg, requireModule, requireCapability } from "../middleware/require.js";
import { supabase } from "../lib/supabase.js";
import { sendAutoPushToDriver } from "../lib/push.js";
import { getOrgMotiveKey } from "../lib/motiveIngest.js";

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
  vehicle_number:     string | null;              // Motive-side (kept for drawer diagnostics only)
  asset_id:           number | null;
  asset_name:         string | null;              // fleetcal-side truck name — this is what UIs display
  asset_unit:         string | null;              // fleetcal-side fleet/unit number (e.g. "#2021")
  asset_color:        string | null;              // resolved from assets.color for bell accent bar
  driver_id:          number | null;              // Motive-side driver_id (untrusted)
  driver_first_name:  string | null;
  driver_last_name:   string | null;
  // ── Calendar-resolved (authoritative) — set by the API, NOT stored.
  resolved_driver_id:   number | null;
  resolved_driver_name: string | null;
  resolved_load_num:    string | null;
  resolved_load_title:  string | null;
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
  // Computed by enrichEventsBatch from drivers.name — NOT a stored column.
  // Shows the ACTUAL driver the push went to, which can differ from
  // resolved_driver_name when the dispatcher reassigned before notifying.
  notified_driver_name: string | null;
  // ── Severity (derived from raw.event_intensity + metadata.severity) ──
  severity_level:   SeverityLevel | null;
  severity_score:   number | null;   // 0–100 for the bar meter
  severity_display: string | null;   // e.g. "12.2 mph/s"
  severity_metric:  string | null;   // Motive's metric name — e.g. "Braking intensity"
  severity_inverted: boolean;        // true when lower = worse (tailgating)
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
  const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  // `?since=24h|12h|1h` narrows to the trailing window; used by the
  // Safety Panel to show every alert in the last day (not just unread).
  const sinceMs = parseWindow(url.searchParams.get("since"));
  // `?include=raw,movements` — opt-in payload extras for the panel.
  // Popover doesn't ask for either (raw is multi-KB per row for GPS
  // arrays; movements need a second query per truck).
  const include = new Set((url.searchParams.get("include") ?? "").split(",").map(s => s.trim()).filter(Boolean));

  // `raw` is always fetched from the DB so enrichEventsBatch can derive
  // severity from raw.event_intensity + raw.metadata.severity. We strip
  // it from the response afterwards unless the caller opted in via
  // `include=raw` (the panel needs it for the map's GPS trace + the
  // dashcam block). Popover keeps its lean payload.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("motive_performance_events")
    .select(`${SELECT_COLS},raw,vehicle_id`)
    .eq("org_id", orgId)
    .order("event_time", { ascending: false })
    .limit(limit);
  if (status !== "all") q = q.eq("dispatch_status", status);
  if (sinceMs != null) q = q.gte("event_time", new Date(Date.now() - sinceMs).toISOString());

  const { data, error } = await q;
  if (error) {
    console.error("[GET /v1/performance-events]", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as (PerfEventRow & { raw?: any })[];

  // Batch-resolve calendar driver + load + asset color for every event
  // in the list. 4 queries total regardless of list size. Also derives
  // severity_* from each row's raw payload.
  await enrichEventsBatch(orgId, rows);

  // Strip raw when the caller didn't ask for it — keeps the popover
  // response small (raw carries multi-KB GPS arrays per row).
  if (!include.has("raw")) {
    for (const r of rows) delete (r as { raw?: unknown }).raw;
  }

  // Optional Motive driving_periods sidecar — panel uses this to draw
  // the between-load movement OD line on the map. Pull the periods for
  // every distinct vehicle_id in the result, covering the same trailing
  // window (padded ±2h so a period that started before or ends after
  // still comes through).
  let movements: MovementSidecar[] = [];
  if (include.has("movements") && rows.length > 0) {
    const vehicleIds = Array.from(new Set(rows.map(r => r.vehicle_id)));
    const eventTimes = rows.map(r => Date.parse(r.event_time)).filter(Number.isFinite);
    const windowStart = Math.min(...eventTimes) - 2 * 60 * 60 * 1000;
    const windowEnd   = Math.max(...eventTimes) + 2 * 60 * 60 * 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: mvts } = await (supabase as any)
      .from("motive_driving_periods")
      .select("id, vehicle_id, driver_first_name, driver_last_name, start_time, end_time, origin, destination, origin_lat, origin_lon, destination_lat, destination_lon, miles")
      .eq("org_id", orgId)
      .in("vehicle_id", vehicleIds)
      .gte("start_time", new Date(windowStart).toISOString())
      .lte("start_time", new Date(windowEnd).toISOString())
      .order("start_time", { ascending: false });
    movements = (mvts ?? []) as MovementSidecar[];
  }

  // Unread count — cheap thanks to the partial index; always returned
  // so the bell badge stays fresh even when the panel is filtered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count } = await (supabase as any)
    .from("motive_performance_events")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("dispatch_status", "new");

  return c.json({ events: rows, movements, newCount: count ?? 0 });
});

interface MovementSidecar {
  id: number;
  vehicle_id: number;
  driver_first_name: string | null;
  driver_last_name:  string | null;
  start_time: string;
  end_time:   string | null;
  origin:     string | null;
  destination: string | null;
  origin_lat: number | null;
  origin_lon: number | null;
  destination_lat: number | null;
  destination_lon: number | null;
  miles:      number | null;
}

/** Parse "24h" / "12h" / "1h" / "30m" into milliseconds. Returns null
 *  when the input is missing or malformed. */
function parseWindow(s: string | null): number | null {
  if (!s) return null;
  const m = s.trim().toLowerCase().match(/^(\d+)([hm])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * (m[2] === "h" ? 3_600_000 : 60_000);
}

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

  // Drawer needs the raw payload for the dashcam video block, so
  // detail requests always include it — unlike the popover list, which
  // never asks for `raw` because it's KB per row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: eventRow, error } = await (supabase as any)
    .from("motive_performance_events")
    .select(`${SELECT_COLS},raw,vehicle_id`)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/performance-events/:id]", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!eventRow) return c.json({ error: "not_found" }, 404);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const event = eventRow as PerfEventRow & { raw?: any };

  // Enrich in place — same resolved_* fields the list handler adds.
  await enrichEventsBatch(orgId, [event]);

  // Autofilled driver comes from the FleetCal calendar — not from Motive.
  // We can't trust Motive's driver attribution (see file header).
  const suggested = await resolveCurrentDriver(orgId, event.asset_id, event.event_time);

  return c.json({ event, suggestedDriver: suggested });
});

// ── POST /v1/performance-events/:id/refresh-media ──────────────────────
//
// Re-queries Motive for a single event and refreshes its `raw` payload
// so `camera_media.downloadable_videos` are populated. Use cases:
//   • Event was ingested before we started passing media_required=true —
//     the row has camera_media metadata but no URLs.
//   • URLs expired (Motive signs them ~48h) and the dispatcher wants to
//     review an older event.
//
// Since v2 has no "single event by id" endpoint, we scope the query as
// tightly as possible: vehicle_ids[]=X, start/end_date=event day (±1
// day for TZ edges), media_required=true. The response is capped and
// we grep by id in memory.

perf.post("/:id/refresh-media", async (c) => {
  const orgId = c.get("orgId");
  const id    = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row } = await (supabase as any)
    .from("motive_performance_events")
    .select("id, vehicle_id, event_time")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!row) return c.json({ error: "not_found" }, 404);
  const eventRow = row as { id: number; vehicle_id: number; event_time: string };

  const apiKey = await getOrgMotiveKey(orgId);
  if (!apiKey) return c.json({ error: "no_motive_key" }, 400);

  const eventDate = new Date(eventRow.event_time);
  const start = new Date(eventDate.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end   = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    "vehicle_ids[]": String(eventRow.vehicle_id),
    start_date:     start,
    end_date:       end,
    media_required: "true",
    per_page:       "100",
  });
  const url = `https://api.gomotive.com/v2/driver_performance_events?${params.toString()}`;

  const res = await fetch(url, {
    headers: { "x-api-key": apiKey, "Accept": "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[refresh-media] Motive error:", res.status, body.slice(0, 200));
    return c.json({ error: "motive_error", status: res.status }, 502);
  }
  const body = await res.json().catch(() => null) as
    | { driver_performance_events?: Array<{ driver_performance_event?: { id?: number } }> }
    | null;

  // Find the wrapper whose inner event matches our id.
  const match = (body?.driver_performance_events ?? [])
    .map(w => w.driver_performance_event)
    .find(e => e && e.id === id);

  if (!match) {
    // Event exists on our side but Motive returned nothing for it in
    // the window. Could be event drifted out of the truck's day-of
    // set, or the fleet's dashcam plan doesn't back this event type
    // with video. Return 200 with a diagnostic so the client shows
    // "no video available".
    return c.json({ event: null, videoStatus: "not_found_at_motive" });
  }

  // Update raw + return the enriched row so the client can render
  // the video immediately without a second round trip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: updErr } = await (supabase as any)
    .from("motive_performance_events")
    .update({ raw: match })
    .eq("org_id", orgId)
    .eq("id", id)
    .select(`${SELECT_COLS},raw,vehicle_id`)
    .maybeSingle();
  if (updErr) {
    console.error("[refresh-media] update failed:", updErr);
    return c.json({ error: "update_failed", detail: updErr.message }, 500);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = updated as PerfEventRow & { raw?: any };
  await enrichEventsBatch(orgId, [enriched]);
  return c.json({ event: enriched, videoStatus: "refreshed" });
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

  // Enrich in place so we can use asset_name (fleetcal display) and
  // resolved_load_num when composing the push. Never surface Motive's
  // vehicle.number — that's an internal identifier drivers don't see
  // anywhere else in the app.
  await enrichEventsBatch(orgId, [event]);

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
  // "Check-in" not "alert" — the push should feel like a heads-up from
  // dispatch, not a violation notice. Same content, softer framing.
  const title = "Safety check-in from dispatch";
  // Prefer asset_name (fleetcal display) → the Motive-side
  // vehicle_number is never shown to drivers. Fall back to vehicle_number
  // only when the truck isn't linked to an asset row yet, and finally
  // to the numeric vehicle_id as a last-ditch identifier.
  const truckLabel = event.asset_name ?? event.vehicle_number ?? `Vehicle ${event.vehicle_id}`;
  // Format the event time in the org's dispatch timezone (America/Denver
  // for Curzon — same TZ the confirmReminders job uses). Otherwise a
  // driver reading a 6 PM Mountain event sees midnight UTC on their
  // phone, which is confusing on a road trip.
  const timeStr = formatEventLocalTime(event.event_time, "America/Denver");
  // Push body: fact line + light, uniform closer. Same wording every
  // time so drivers know exactly what to expect from a dispatch push.
  const summary =
    `${label} was logged on ${truckLabel} at ${timeStr}. Please drive safe. Tap to review.`;
  const storedMessage = body.message?.trim() || summary;

  const sent = await sendAutoPushToDriver(orgId, body.driverId, "safety_alert", {
    title,
    body: summary,
    data: {
      kind:             "safety_alert",
      performanceEventId: id,
      truckLabel,
      eventType:        event.event_type,
      eventTime:        event.event_time,
      // Deep-link — driver app's useNotificationDeepLink pushes to this
      // route on tap.
      url:              `/safety/${id}`,
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
      notified_message:   storedMessage,
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
  const enriched = updated as PerfEventRow;
  await enrichEventsBatch(orgId, [enriched]);
  return c.json({ event: enriched, driverName: (drv as { name: string }).name });
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

/**
 * Batched calendar resolver for the bell list. Mutates `rows` in place,
 * setting `asset_color`, `resolved_driver_id`, `resolved_driver_name`,
 * and `resolved_load_num`. Same waterfall as resolveCurrentDriver:
 *   1. calendar_active — load event whose window contains event_time
 *   2. calendar_recent — most recent load event ending before event_time
 *   3. asset_default  — driver_asset_prefs default for the asset
 *
 * Cost = 4 queries total regardless of row count (assets + events +
 * driver_asset_prefs + drivers name lookup). Much cheaper than looping
 * resolveCurrentDriver per row.
 */
async function enrichEventsBatch(orgId: string, rows: PerfEventRow[]): Promise<void> {
  if (rows.length === 0) return;

  // (1) Asset lookup — name/unit/color. Name is what dispatchers see
  //     in the calendar column header ("CT-2021"); we render that in
  //     the popover instead of Motive's vehicle.number (which is
  //     sometimes "C412863" or another Motive-only identifier).
  const assetIds = Array.from(new Set(
    rows.map(r => r.asset_id).filter((x): x is number => x != null),
  ));
  interface AssetLookup { name: string | null; unit: string | null; color: string | null }
  const assetById = new Map<number, AssetLookup>();
  if (assetIds.length > 0) {
    const { data: assetRows } = await supabase
      .from("assets")
      .select("id, name, unit, color")
      .eq("org_id", orgId)
      .in("id", assetIds);
    for (const a of (assetRows ?? []) as Array<{ id: number; name: string | null; unit: string | null; color: string | null }>) {
      assetById.set(a.id, { name: a.name, unit: a.unit, color: a.color });
    }
  }

  // (2) Pull ALL calendar events for these assets whose window overlaps
  //     any of our event times. We over-pull slightly — 30-day window
  //     around the min/max event_time — because a bell load only has
  //     ~50 rows and 30d of events for a handful of trucks is small.
  const eventTimes = rows
    .map(r => Date.parse(r.event_time))
    .filter(Number.isFinite);
  const minTs = Math.min(...eventTimes);
  const maxTs = Math.max(...eventTimes);
  const rangeStart = utcMsToNaiveMt(minTs - 30 * 24 * 60 * 60 * 1000);
  const rangeEnd   = utcMsToNaiveMt(maxTs + 30 * 24 * 60 * 60 * 1000);

  interface CalEventRow {
    id: string; asset_id: number;
    driver_id: number | null; driver_name: string | null;
    load_num: string | null; title: string | null;
    start: string; end: string;
  }
  let calRows: CalEventRow[] = [];
  if (assetIds.length > 0 && rangeStart && rangeEnd) {
    const { data } = await supabase
      .from("events")
      .select("id, asset_id, driver_id, driver_name, load_num, title, start, end")
      .eq("org_id", orgId)
      .in("asset_id", assetIds)
      .not("driver_id", "is", null)
      .gte("end", rangeStart)
      .lte("start", rangeEnd);
    calRows = (data ?? []) as CalEventRow[];
  }
  const calByAsset = new Map<number, CalEventRow[]>();
  for (const e of calRows) {
    const arr = calByAsset.get(e.asset_id) ?? [];
    arr.push(e);
    calByAsset.set(e.asset_id, arr);
  }

  // (3) driver_asset_prefs fallback — only for assets that had no
  //     calendar match at all. Fetched lazily below after step 4.
  const prefByAsset = new Map<number, number>();
  const needPref = new Set<number>();

  // (4) Match each perf event against its asset's calendar. Prefer any
  //     event whose window contains event_time; otherwise pick the most
  //     recent event ending before event_time.
  for (const row of rows) {
    const asset = row.asset_id != null ? assetById.get(row.asset_id) : undefined;
    row.asset_name           = asset?.name  ?? null;
    row.asset_unit           = asset?.unit  ?? null;
    row.asset_color          = asset?.color ?? null;
    row.resolved_driver_id   = null;
    row.resolved_driver_name = null;
    row.resolved_load_num    = null;
    row.resolved_load_title  = null;
    if (row.asset_id == null) continue;

    const naiveMt = utcIsoToNaiveMt(row.event_time);
    if (!naiveMt) continue;

    const candidates = calByAsset.get(row.asset_id) ?? [];
    // calendar_active — start <= t <= end. If multiple (relay overlap),
    // prefer the one ending soonest so the pickup leg wins over a stale
    // delivery leg.
    let best: CalEventRow | null = null;
    for (const e of candidates) {
      if (e.start <= naiveMt && e.end >= naiveMt) {
        if (!best || e.end < best.end) best = e;
      }
    }
    // calendar_recent — most recent event that ended before t.
    if (!best) {
      for (const e of candidates) {
        if (e.end <= naiveMt) {
          if (!best || e.end > best.end) best = e;
        }
      }
    }
    if (best && best.driver_id != null) {
      row.resolved_driver_id   = best.driver_id;
      row.resolved_driver_name = best.driver_name;
      row.resolved_load_num    = best.load_num;
      row.resolved_load_title  = best.title;
    } else {
      needPref.add(row.asset_id);
    }
  }

  // (5) driver_asset_prefs for assets with zero calendar match.
  if (needPref.size > 0) {
    const { data: prefs } = await supabase
      .from("driver_asset_prefs")
      .select("asset_id, driver_id")
      .eq("org_id", orgId)
      .in("asset_id", Array.from(needPref));
    for (const p of (prefs ?? []) as Array<{ asset_id: number; driver_id: number }>) {
      prefByAsset.set(p.asset_id, p.driver_id);
    }
  }

  // (6) Names for anything the calendar step didn't resolve — either
  //     driver_asset_prefs fallbacks, OR the notified_driver_id we want
  //     to display on the "Notification sent" block. Both queries funnel
  //     into a single drivers lookup by id.
  const missingNameDriverIds = new Set<number>();
  for (const row of rows) {
    if (row.resolved_driver_id == null && row.asset_id != null) {
      const prefDriverId = prefByAsset.get(row.asset_id);
      if (prefDriverId != null) {
        row.resolved_driver_id = prefDriverId;
        missingNameDriverIds.add(prefDriverId);
      }
    }
    // notified_driver_name is a computed field; we always resolve it
    // from drivers.name when notified_driver_id is set so the record
    // reflects who ACTUALLY got the push (not the calendar autofill,
    // which may have been overridden by the dispatcher).
    if (row.notified_driver_id != null) {
      missingNameDriverIds.add(row.notified_driver_id);
    }
  }
  let nameById = new Map<number, string>();
  if (missingNameDriverIds.size > 0) {
    const { data: drivers } = await supabase
      .from("drivers")
      .select("id, name")
      .eq("org_id", orgId)
      .in("id", Array.from(missingNameDriverIds));
    for (const d of (drivers ?? []) as Array<{ id: number; name: string }>) {
      nameById.set(d.id, d.name);
    }
  }
  for (const row of rows) {
    if (row.resolved_driver_name == null && row.resolved_driver_id != null) {
      row.resolved_driver_name = nameById.get(row.resolved_driver_id) ?? null;
    }
    row.notified_driver_name = row.notified_driver_id != null
      ? (nameById.get(row.notified_driver_id) ?? null)
      : null;

    // (7) Severity — derived from raw.event_intensity + raw.metadata.
    //     Missing raw yields sane defaults (level=low, score=0) so the
    //     UI can safely fill/color from these fields without null
    //     guards. Only stored fields survive to the DB; these are
    //     computed on every read.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (row as any).raw;
    const sev = deriveSeverity(raw, row.event_type);
    row.severity_level    = sev.level;
    row.severity_score    = sev.score;
    row.severity_display  = sev.displayValue;
    row.severity_metric   = sev.metricName;
    row.severity_inverted = sev.isInverted;
  }
}

/** UTC epoch ms → naive Mountain-Time "YYYY-MM-DDTHH:mm" for string
 *  comparison against events.start/end. */
function utcMsToNaiveMt(ms: number): string | null {
  if (!isFinite(ms)) return null;
  return utcIsoToNaiveMt(new Date(ms).toISOString());
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

/** Format an event's UTC timestamp for a driver-facing push. Uses the
 *  org's dispatch timezone so a hard-brake at 6 PM Mountain reads
 *  "Jul 10, 6:51 PM MDT" and not the server's UTC clock. */
function formatEventLocalTime(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone,
    month:        "short",
    day:          "numeric",
    hour:         "numeric",
    minute:       "2-digit",
    timeZoneName: "short",
  });
}
