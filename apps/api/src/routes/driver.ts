/**
 * /v1/driver/* — endpoints scoped to the authenticated driver. All routes
 * mounted here go through the `driverAuth` middleware (verifies Supabase
 * JWT, resolves to drivers row), so handlers can trust c.get("driverId")
 * and c.get("orgId") to be the actual driver's identity.
 */
import { Hono } from "hono";
import {
  joinEventLoadToApp,
  type Load,
  type Stop,
  type StopType,
  type DocumentKind,
  DOCUMENT_KINDS,
  DEFAULT_DRIVER_VISIBLE_DOC_KINDS,
  NOTIFICATION_RULE_KEYS,
  driverVisibleDocumentKinds,
  type OrgModule,
  type OrgModuleFlags,
  MVP_LAUNCH_DEFAULTS,
  isModuleEnabled,
  type DriverScorecardResponse,
} from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { deriveSeverity } from "@fleetcal/types";
import { ensureEventRouteCached } from "../lib/routeGeometry.js";
import { isTruckHistoryOrg } from "../middleware/require.js";
import { driverAuth, type DriverAuthVariables } from "../middleware/driverAuth.js";
import { convertIfHeicAtUpload as convertIfHeic, HEIC_DECODE_FAILED } from "../lib/heicToJpeg.js";

const driver = new Hono<{ Variables: DriverAuthVariables }>();

driver.use("*", driverAuth);

// ─────────────────────────────────────────────────────────────────────────
// Column lists + row converters (mirror loads.ts; duplicated here so the
// driver routes can evolve independently without touching the dispatch
// loads route surface).
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
  "trailer_dropoff_lat,trailer_dropoff_lng,trailer_dropoff_at," +
  "route_polyline,route_stops_key";

const LOAD_COLS =
  "id,internal_load_id,load_num,broker,load_price,commodity,weight," +
  // Note: `internal_notes` deliberately excluded — those are dispatch's
  // private commentary on the load; drivers should never see them.
  "dispatcher,notes,accessorials,rate_con_pdf,ref_nums," +
  "document_counts,audit_log,created_by_name,customer_id,deleted_at,created_at,updated_at";

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

interface AssetMini { id: number; name: string; unit: string | null; color: string | null; motive_vehicle_id: string | null }
interface TrailerMini { id: number; name: string; trailer_number: string | null }

// Human-friendly stop-type labels for auto-generated check call bodies.
const STOP_TYPE_LABEL = {
  pickup:    "PICKUP",
  delivery:  "DELIVERY",
  drop:      "DROP",
  drop_hook: "DROP & HOOK",
  stop:      "STOP",
  relay:     "RELAY",
} as const;

/**
 * Take a list of joined event rows + their stop/asset/trailer rows and
 * stitch them into the Load[] domain shape. Same pattern as loads.ts but
 * also copies asset.name/unit and trailer info onto the Load so the
 * driver app doesn't have to do a follow-up lookup.
 */
function buildLoads(
  eventRows:    Record<string, unknown>[],
  stopsByEvent: Map<string, Stop[]>,
  assetsById:   Map<number, AssetMini>,
  trailersById: Map<number, TrailerMini>,
): Load[] {
  return eventRows.map((e) => {
    const ev = e as Record<string, unknown> & {
      load?: Record<string, unknown>[] | Record<string, unknown> | null;
      asset_id: number;
      trailer_id?: number | null;
    };
    const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);
    const joined = joinEventLoadToApp(ev, loadRow);
    joined.stops = (stopsByEvent.get(joined.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence);

    const asset = assetsById.get(ev.asset_id);
    if (asset) {
      joined.assetName = `${asset.name}${asset.unit ? ` #${asset.unit}` : ""}`;
      // motiveVehicleId lives on assets — copy it onto the Load so the
      // driver app can show truck location without a separate query.
      if (asset.motive_vehicle_id) joined.motiveVehicleId = asset.motive_vehicle_id;
    }
    if (ev.trailer_id != null) {
      const t = trailersById.get(ev.trailer_id);
      if (t) joined.trailerName = `#${t.trailer_number ?? t.name}`;
    }
    return joined;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

driver.get("/me", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const { data } = await supabase
    .from("drivers")
    .select("id,name,first_name,last_name,phone,notes,email,address," +
            "license_number,license_state,license_exp,medical_card_exp,dob")
    .eq("id", driverId)
    .eq("org_id", orgId)
    .maybeSingle();
  const row = data as {
    id: number; name: string; first_name: string | null; last_name: string | null;
    phone: string | null; notes: string | null; email: string | null;
    address: string | null; license_number: string | null; license_state: string | null;
    license_exp: string | null; medical_card_exp: string | null; dob: string | null;
  } | null;
  return c.json({
    driverId,
    orgId,
    name:           row?.name ?? c.get("driverName"),
    firstName:      row?.first_name      ?? undefined,
    lastName:       row?.last_name       ?? undefined,
    phone:          row?.phone           ?? c.get("phone"),
    email:          row?.email           ?? undefined,
    address:        row?.address         ?? undefined,
    licenseNumber:  row?.license_number  ?? undefined,
    licenseState:   row?.license_state   ?? undefined,
    licenseExp:     row?.license_exp     ?? undefined,
    medicalCardExp: row?.medical_card_exp?? undefined,
    dob:            row?.dob             ?? undefined,
    notes:          row?.notes           ?? undefined,
  });
});

// PATCH /v1/driver/me — driver edits their own HR / compliance fields.
// The driver can NOT change their own `name`, `notes`, or org binding
// (those are ops decisions); everything else is fair game.
driver.patch("/me", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const update: Record<string, unknown> = {};
  if ("firstName"      in body) update.first_name       = body.firstName      ?? null;
  if ("lastName"       in body) update.last_name        = body.lastName       ?? null;
  if ("phone"          in body) update.phone            = body.phone          ?? null;
  if ("email"          in body) update.email            = body.email          ?? null;
  if ("address"        in body) update.address          = body.address        ?? null;
  if ("licenseNumber"  in body) update.license_number   = body.licenseNumber  ?? null;
  if ("licenseState"   in body) {
    update.license_state = typeof body.licenseState === "string" && body.licenseState.trim()
      ? body.licenseState.toUpperCase() : null;
  }
  if ("licenseExp"     in body) update.license_exp      = body.licenseExp     ?? null;
  if ("medicalCardExp" in body) update.medical_card_exp = body.medicalCardExp ?? null;
  if ("dob"            in body) update.dob              = body.dob            ?? null;

  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no fields"] }, 400);
  }

  // Keep `name` in sync if first/last changed. Drivers don't edit name
  // directly, but we want the display name updated when they fill in
  // first/last name for the first time.
  if (("first_name" in update || "last_name" in update)) {
    const { data: cur } = await supabase
      .from("drivers")
      .select("first_name,last_name,name")
      .eq("id", driverId)
      .eq("org_id", orgId)
      .maybeSingle();
    const curRow = cur as { first_name: string | null; last_name: string | null; name: string } | null;
    const nextFirst = ("first_name" in update ? update.first_name : curRow?.first_name) as string | null;
    const nextLast  = ("last_name"  in update ? update.last_name  : curRow?.last_name)  as string | null;
    const joined = [nextFirst, nextLast].filter(Boolean).join(" ").trim();
    if (joined && joined !== curRow?.name) update.name = joined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await supabase
    .from("drivers")
    .update(update as any)
    .eq("id", driverId)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/driver/me] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

// GET /v1/driver/notification-prefs — sparse map of per-rule overrides
// the driver has set. Missing keys follow the org default.
//
// driver_notification_prefs lands via 20260518 migration; the generated
// Database types don't include it yet (regenerate after applying).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sbAny = supabase as any;

// GET /v1/driver/notifications — recent push notifications received by
// the calling driver. Powers the bell + dropdown in the Schedule tab
// so the driver can see what they were nudged about, in case a push
// got dismissed before they could read it. Joined with loads so each
// card can show the load # + title without a per-row fetch.
//
// Query params:
//   - hours: window in hours (1-720, default 48)
//   - limit: max rows (1-200, default 100)
driver.get("/notifications", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url = new URL(c.req.url);
  const hoursRaw = Number(url.searchParams.get("hours"));
  const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(720, hoursRaw)) : 48;
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 100;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("load_notifications")
    .select(
      "id, event_id, load_id, kind, sent_at, sent_by_name, acknowledged_at, " +
      // PostgREST nested-select: title + load_num live on the events
      // table (loads has load_num too but no title). Join through
      // event_id so each card can show "#45280 · Phoenix → Reno"
      // without a per-notification refetch.
      "events ( load_num, title )",
    )
    .eq("driver_id", driverId)
    .eq("org_id", orgId)
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[GET /v1/driver/notifications] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  type Row = {
    id: string;
    event_id: string;
    load_id: string | null;
    kind: string;
    sent_at: string;
    sent_by_name: string;
    acknowledged_at: string | null;
    events: { load_num: string | null; title: string | null } | { load_num: string | null; title: string | null }[] | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).map(r => {
    // PostgREST returns the nested relation as an object when the FK
    // is to-one, sometimes as a single-element array. Normalize.
    const ev = Array.isArray(r.events) ? (r.events[0] ?? null) : r.events;
    return {
      id:              r.id,
      eventId:         r.event_id,
      loadId:          r.load_id,
      loadNum:         ev?.load_num ?? null,
      loadTitle:       ev?.title    ?? null,
      kind:            r.kind,
      sentAt:          r.sent_at,
      sentByName:      r.sent_by_name,
      acknowledgedAt:  r.acknowledged_at,
    };
  });
  return c.json({ notifications: rows });
});

// POST /v1/driver/notifications/mark-viewed — ack all the driver's
// pending informational notifications (assigned, reassigned_away).
// Action-required kinds (confirm, upload_pod, mark_pickup, etc.) are
// intentionally NOT touched here — those auto-ack server-side when the
// driver does the thing, so clearing them on bell open would falsely
// signal "handled" when the driver hasn't actually confirmed / uploaded.
//
// Called by the driver bell when the panel is opened so the red badge
// clears for informational pings the user has now seen.
driver.post("/notifications/mark-viewed", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const { error } = await supabase
    .from("load_notifications")
    .update({ acknowledged_at: new Date().toISOString() } as never)
    .eq("driver_id", driverId)
    .eq("org_id", orgId)
    .in("kind", ["assigned", "reassigned_away", "load_cancelled"])
    .is("acknowledged_at", null);
  if (error) {
    console.error("[POST /v1/driver/notifications/mark-viewed] failed:", error);
    return c.json({ error: "ack_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

// POST /v1/driver/permissions — driver app reports current OS-level
// permission state for notifications + location. Called on launch
// and on AppState foreground change so a driver who toggled either
// off in Settings shows up in the dispatch profile right away.
//
// Accepts a partial body — either or both fields can be omitted
// (e.g. unsupported on a particular platform). NULL stored when
// omitted, distinguishing "never reported" from "reported as denied."
driver.post("/permissions", async (c) => {
  const driverId = c.get("driverId");
  type Perm = "granted" | "denied" | "undetermined";
  let body: { notifications?: Perm | null; location?: Perm | null };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const validate = (v: unknown): Perm | null | undefined => {
    if (v === undefined) return undefined; // leave existing value
    if (v === null) return null;
    return v === "granted" || v === "denied" || v === "undetermined" ? v : undefined;
  };
  const n = validate(body.notifications);
  const l = validate(body.location);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const update: Record<string, any> = { permissions_updated_at: new Date().toISOString() };
  if (n !== undefined) update.notifications_permission = n;
  if (l !== undefined) update.location_permission      = l;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("drivers")
    .update(update)
    .eq("id", driverId);
  if (error) {
    console.error("[POST /v1/driver/permissions] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

// POST /v1/driver/push-token — register/refresh this device's Expo push
// token. Moved off the direct client→Supabase upsert (which broke for
// every driver after the 2026-06-11 RLS lockdown: driver_push_tokens
// got an org-scoped RLS policy keyed on `auth.jwt() ->> 'org_id'`, but
// the driver app authenticates via Supabase phone-OTP whose JWT carries
// no org_id claim → every upsert silently denied, no tokens registered
// fleet-wide for ~10 days). This endpoint runs the upsert with the
// service-role client (bypasses RLS) and resolves driver+org from the
// driverAuth-verified JWT so the client can't spoof another driver.
driver.post("/push-token", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  let body: { token?: string; platform?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }

  const token = (body.token ?? "").trim();
  if (!token) {
    return c.json({ error: "validation_failed", errors: ["token required"] }, 400);
  }
  const platform = body.platform === "android" ? "android" : "ios";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("driver_push_tokens")
    .upsert(
      {
        driver_id:    driverId,
        org_id:       orgId,
        token,
        platform,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "token" },
    );
  if (error) {
    console.error("[POST /v1/driver/push-token] upsert failed:", error);
    return c.json({ error: "upsert_failed", detail: error.message }, 500);
  }
  return c.json({ ok: true });
});

driver.get("/notification-prefs", async (c) => {
  const driverId = c.get("driverId");
  const { data, error } = await sbAny
    .from("driver_notification_prefs")
    .select("rule_key,enabled")
    .eq("driver_id", driverId);
  if (error) {
    console.error("[GET /v1/driver/notification-prefs] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const rows = (data ?? []) as { rule_key: string; enabled: boolean }[];
  const prefs: Record<string, boolean> = {};
  for (const r of rows) prefs[r.rule_key] = r.enabled;
  return c.json({ prefs });
});

// PATCH /v1/driver/notification-prefs — set/clear one override.
//   body: { ruleKey: string, enabled: boolean | null }
//   null clears the override (driver falls back to org default).
driver.patch("/notification-prefs", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const body = await c.req.json<{ ruleKey?: string; enabled?: boolean | null }>();
  const ruleKey = (body.ruleKey ?? "").trim();
  if (!NOTIFICATION_RULE_KEYS.includes(ruleKey as never)) {
    return c.json({ error: "validation_failed", errors: ["unknown ruleKey"] }, 400);
  }
  if (body.enabled === null) {
    // Clear override: delete the row so resolution falls back to default.
    const { error: delErr } = await sbAny
      .from("driver_notification_prefs")
      .delete()
      .eq("driver_id", driverId)
      .eq("rule_key", ruleKey);
    if (delErr) {
      console.error("[PATCH /v1/driver/notification-prefs] delete failed:", delErr);
      return c.json({ error: "delete_failed", detail: delErr.message }, 500);
    }
  } else if (body.enabled === true || body.enabled === false) {
    const { error: upErr } = await sbAny
      .from("driver_notification_prefs")
      .upsert(
        { driver_id: driverId, org_id: orgId, rule_key: ruleKey, enabled: body.enabled },
        { onConflict: "driver_id,rule_key" },
      );
    if (upErr) {
      console.error("[PATCH /v1/driver/notification-prefs] upsert failed:", upErr);
      return c.json({ error: "upsert_failed", detail: upErr.message }, 500);
    }
  } else {
    return c.json({ error: "validation_failed", errors: ["enabled must be true, false, or null"] }, 400);
  }

  // Return the full refreshed map.
  const { data: rows2 } = await sbAny
    .from("driver_notification_prefs")
    .select("rule_key,enabled")
    .eq("driver_id", driverId);
  const prefs: Record<string, boolean> = {};
  for (const r of (rows2 ?? []) as { rule_key: string; enabled: boolean }[]) {
    prefs[r.rule_key] = r.enabled;
  }
  return c.json({ prefs });
});

// GET /v1/driver/loads — every (non-deleted) load assigned to the auth'd
// driver, ordered by start time. Takes optional ?from / ?to date filters
// (same semantics as /v1/loads — overlap with the window).
driver.get("/loads", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");

  let q = supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .order("start", { ascending: true });
  if (from) q = q.gte("end", from);
  if (to)   q = q.lte("start", to);

  const { data: events, error } = await q;
  if (error) {
    console.error("[GET /v1/driver/loads] failed:", error);
    return c.json({ error: "list_failed", detail: error.message }, 500);
  }
  const rows = (events ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) return c.json({ loads: [] });

  const eventIds = rows.map((r) => r.id as string);
  const assetIds = Array.from(new Set(rows.map((r) => r.asset_id as number)));
  const trailerIds = Array.from(new Set(
    rows.map((r) => r.trailer_id as number | null).filter((x): x is number => x != null),
  ));

  const [stopsRes, assetsRes, trailersRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).in("event_id", eventIds),
    supabase.from("assets").select("id,name,unit,color,motive_vehicle_id").in("id", assetIds),
    trailerIds.length > 0
      ? supabase.from("trailers").select("id,name,trailer_number").in("id", trailerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (stopsRes.error)    console.error("[GET /v1/driver/loads] stops:",    stopsRes.error);
  if (assetsRes.error)   console.error("[GET /v1/driver/loads] assets:",   assetsRes.error);
  if (trailersRes.error) console.error("[GET /v1/driver/loads] trailers:", trailersRes.error);

  const stopsByEvent = new Map<string, Stop[]>();
  for (const s of (stopsRes.data ?? []) as unknown as StopRow[]) {
    const arr = stopsByEvent.get(s.event_id) ?? [];
    arr.push(rowToStop(s));
    stopsByEvent.set(s.event_id, arr);
  }
  const assetsById = new Map<number, AssetMini>();
  for (const a of (assetsRes.data ?? []) as unknown as AssetMini[]) assetsById.set(a.id, a);
  const trailersById = new Map<number, TrailerMini>();
  for (const t of (trailersRes.data ?? []) as unknown as TrailerMini[]) trailersById.set(t.id, t);

  // documentCounts is denormalized on loads.document_counts now —
  // joinEventLoadToApp reads it directly off the load row. No extra
  // query needed for the doc-icon overlay / "delivered without POD"
  // chip.

  // Pending dispatcher nudges per event, used for the driver-app badge.
  // Single batched query for the visible page.
  const pendingByEvent = new Map<string, string[]>();
  if (eventIds.length > 0) {
    const { data: notifs } = await supabase
      .from("load_notifications")
      .select("event_id, kind")
      .in("event_id", eventIds)
      .is("acknowledged_at", null);
    for (const n of (notifs ?? []) as Array<{ event_id: string; kind: string }>) {
      const arr = pendingByEvent.get(n.event_id) ?? [];
      arr.push(n.kind);
      pendingByEvent.set(n.event_id, arr);
    }
  }

  const loads = buildLoads(rows, stopsByEvent, assetsById, trailersById);
  for (const l of loads) {
    const pending = pendingByEvent.get(l.id);
    if (pending && pending.length > 0) l.pendingNotificationKinds = pending;
  }
  return c.json({ loads });
});

// GET /v1/driver/loads/:id — single load by event id, scoped to the auth'd
// driver. Includes the relay partner leg's stops + driver name when this
// is one half of a relay so the driver can see what comes after their leg.
driver.get("/loads/:id", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const { data: row, error } = await supabase
    .from("events")
    .select(`${EVENT_COLS}, load:loads(${LOAD_COLS})`)
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error("[GET /v1/driver/loads/:id] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  if (!row) return c.json({ error: "not_found" }, 404);

  const ev = row as unknown as Record<string, unknown> & {
    asset_id: number;
    trailer_id: number | null;
    relay_role: string | null;
    load?: Record<string, unknown>[] | Record<string, unknown> | null;
  };
  const loadRow = Array.isArray(ev.load) ? (ev.load[0] ?? null) : (ev.load ?? null);

  const [stopsRes, assetRes, trailerRes] = await Promise.all([
    supabase.from("stops").select(STOP_COLS).eq("event_id", id),
    supabase.from("assets").select("id,name,unit,color,motive_vehicle_id").eq("id", ev.asset_id).maybeSingle(),
    ev.trailer_id != null
      ? supabase.from("trailers").select("id,name,trailer_number").eq("id", ev.trailer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const stopsByEvent = new Map<string, Stop[]>();
  stopsByEvent.set(
    id,
    ((stopsRes.data ?? []) as unknown as StopRow[]).map(rowToStop).sort((a, b) => a.sequence - b.sequence),
  );
  const assetsById = new Map<number, AssetMini>();
  if (assetRes.data) assetsById.set(ev.asset_id, assetRes.data as unknown as AssetMini);
  const trailersById = new Map<number, TrailerMini>();
  if (trailerRes.data && ev.trailer_id != null) {
    trailersById.set(ev.trailer_id, trailerRes.data as unknown as TrailerMini);
  }

  const [load] = buildLoads([ev], stopsByEvent, assetsById, trailersById);

  // Warm the route-geometry cache so the driver RouteMap draws from the
  // stored polyline instead of calling Google Directions on the device.
  const routeCache = await ensureEventRouteCached(id, stopsByEvent.get(id) ?? [], {
    routePolyline: load.routePolyline,
    routeStopsKey: (ev.route_stops_key as string | null) ?? null,
    loadedMiles:   load.loadedMiles ?? null,
  }, load.relayRole ?? null);
  load.routePolyline = routeCache.routePolyline ?? undefined;
  load.loadedMiles   = routeCache.loadedMiles ?? undefined;

  // Relay partner — same load_id, different event id. Surface stops + driver
  // name so the driver knows where their leg hands off (or starts from).
  // Also surface the partner's trailer-dropoff pin so the delivery driver
  // can find the trailer at the handoff lot.
  if (loadRow && (loadRow as { id?: string }).id && ev.relay_role) {
    const partnerLoadId = (loadRow as { id: string }).id;
    const { data: partner } = await supabase
      .from("events")
      .select("id, driver_name, trailer_dropoff_lat, trailer_dropoff_lng, trailer_dropoff_at, trailer_dropoff_address")
      .eq("load_id", partnerLoadId)
      .eq("org_id", orgId)
      .neq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (partner) {
      const partnerEv = partner as unknown as {
        id: string; driver_name: string | null;
        trailer_dropoff_lat: number | null;
        trailer_dropoff_lng: number | null;
        trailer_dropoff_at:  string | null;
        trailer_dropoff_address: string | null;
      };
      const { data: partnerStops } = await supabase
        .from("stops")
        .select(STOP_COLS)
        .eq("event_id", partnerEv.id);
      load.partnerEventId   = partnerEv.id;
      load.partnerDriverName = partnerEv.driver_name ?? undefined;
      load.partnerStops      = ((partnerStops ?? []) as unknown as StopRow[])
        .map(rowToStop)
        .sort((a, b) => a.sequence - b.sequence);
      load.partnerTrailerDropoffLat     = partnerEv.trailer_dropoff_lat ?? undefined;
      load.partnerTrailerDropoffLng     = partnerEv.trailer_dropoff_lng ?? undefined;
      load.partnerTrailerDropoffAt      = partnerEv.trailer_dropoff_at  ?? undefined;
      load.partnerTrailerDropoffAddress = partnerEv.trailer_dropoff_address ?? undefined;
    }
  }

  // documentCounts is denormalized on loads.document_counts and read
  // by joinEventLoadToApp off the load row — no extra query needed.

  // Pending dispatcher nudges — drives the load-detail banner.
  const { data: pending } = await supabase
    .from("load_notifications")
    .select("kind")
    .eq("event_id", id)
    .eq("org_id", orgId)
    .is("acknowledged_at", null);
  if (pending && pending.length > 0) {
    load.pendingNotificationKinds = (pending as Array<{ kind: string }>).map(p => p.kind);
  }

  return c.json({ load });
});

/** Resolve an org's effective module flags — the SAME MVP-defaults merge
 *  the web's /v1/org-settings uses, so the driver app gates on identical
 *  values. No stored map (new orgs) → pure MVP defaults; stored map →
 *  defaults overlaid by the org's explicit choices (Curzon keeps fuel /
 *  maintenance ON). */
async function getOrgModules(orgId: string): Promise<OrgModuleFlags> {
  const { data } = await supabase
    .from("org_settings")
    .select("modules")
    .eq("org_id", orgId)
    .maybeSingle();
  const stored = (data as { modules: OrgModuleFlags | null } | null)?.modules ?? null;
  const has = stored !== null && Object.keys(stored).length > 0;
  return has ? { ...MVP_LAUNCH_DEFAULTS, ...stored } : { ...MVP_LAUNCH_DEFAULTS };
}

/** Server-enforce a driver-app module gate: true if ANY of the given
 *  modules is enabled for the org. A hidden tab can't be reached via the
 *  API once the submit handler calls this. */
async function orgHasAnyModule(orgId: string, ...modules: OrgModule[]): Promise<boolean> {
  const flags = await getOrgModules(orgId);
  return modules.some((m) => isModuleEnabled(m, flags));
}

// GET /v1/driver/org-settings — the subset of org_settings the driver app
// actually reads. Returns:
//   - showDriverPay: gates the Pay row on the driver-app load card
//   - timezone:      sanitized IANA from rate_con_settings.promptVariables.timezone
//                    so the driver app can render all "now"/"today" math in
//                    the org's dispatch zone instead of the device's tz.
driver.get("/org-settings", async (c) => {
  const orgId = c.get("orgId");
  const { data, error } = await supabase
    .from("org_settings")
    .select("show_driver_pay,rate_con_settings,document_types,driver_visible_doc_kinds,modules")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // 42P01/42703 = table or column doesn't exist; treat as defaults.
    if (error.code !== "42P01" && error.code !== "42703") {
      console.error("[GET /v1/driver/org-settings] failed:", error);
      return c.json({ error: "fetch_failed", detail: error.message }, 500);
    }
  }
  const row = data as {
    show_driver_pay:   boolean;
    rate_con_settings: { promptVariables?: { timezone?: string } } | null;
    document_types:    Array<{ kind: string; enabled: boolean; driverVisible: boolean }> | null;
    driver_visible_doc_kinds: string[] | null;
    modules:           OrgModuleFlags | null;
  } | null;
  const showDriverPay = row?.show_driver_pay ?? false;
  const rawTz = row?.rate_con_settings?.promptVariables?.timezone ?? null;
  const timezone = sanitizeTz(rawTz);
  // Compute the driver's allowed upload kinds server-side from the
  // canonical config. The driver app uses this to populate its kind
  // picker; we send only the resolved list (not the full per-kind
  // record) because the driver UI doesn't need the enabled/visibility
  // breakdown — it only cares which kinds it may show.
  //
  // Hardening: if document_types is set but every row resolves to
  // not-visible (admin clicked through settings into a bad state, or
  // a partial save dropped the array), fall through to defaults
  // instead of returning []. An empty list silently breaks the
  // driver's upload picker AND read filter — drivers MUST be able to
  // upload at least POD/BOL to do their job. An admin who genuinely
  // wants to lock down a specific kind can disable it individually;
  // a wholesale empty result is treated as a config glitch.
  // Use the canonical resolver from @fleetcal/types — it merges
  // stored rows over per-kind defaults (matching the dispatcher
  // Settings panel's display logic), then filters to enabled +
  // driverVisible. Without this, a sparse document_types array
  // would silently exclude every kind that wasn't explicitly toggled
  // even though the panel shows them as on.
  let driverUploadKinds: string[];
  if (row?.document_types && Array.isArray(row.document_types)) {
    driverUploadKinds = driverVisibleDocumentKinds(row.document_types);
  } else if (row?.driver_visible_doc_kinds) {
    driverUploadKinds = row.driver_visible_doc_kinds;
  } else {
    // Default: everything except rate_con + invoice. Matches the
    // server-side default used by the docs-list endpoint.
    driverUploadKinds = [...DEFAULT_DRIVER_VISIBLE_DOC_KINDS];
  }
  if (driverUploadKinds.length === 0) {
    console.warn(
      "[GET /v1/driver/org-settings] document_types resolved to empty for org",
      orgId,
      "— falling back to defaults",
    );
    driverUploadKinds = [...DEFAULT_DRIVER_VISIBLE_DOC_KINDS];
  }
  driverUploadKinds = ensureMandatoryDriverKinds(driverUploadKinds, orgId, "org-settings");
  // Module flags (same MVP-defaults merge as the web) so the driver app
  // can gate the Report tab / inspections / compliance per org.
  const storedModules = row?.modules ?? null;
  const hasModules = storedModules !== null && Object.keys(storedModules).length > 0;
  const modules: OrgModuleFlags = hasModules ? { ...MVP_LAUNCH_DEFAULTS, ...storedModules } : { ...MVP_LAUNCH_DEFAULTS };
  // Curzon-only Truck History module — gates the "View truck history" +
  // "Post-Trip Inspection" surfaces in the driver app.
  const truckHistoryEnabled = isTruckHistoryOrg(orgId);
  return c.json({ settings: { showDriverPay, timezone, driverUploadKinds, modules, truckHistoryEnabled } });
});

// GET /v1/driver/scorecard — the signed-in driver's own inspection score for
// the month to date. Same completion math as the dispatcher /v1/driver-scoring
// (inspection days ÷ on-road days, ≥1 inspection covers a day), scoped to this
// driver. Cleanliness is intentionally NOT part of the score. Gated to the
// Truck History module — other orgs get enabled:false and render nothing.
const SCORECARD_BONUS_THRESHOLD = 85; // keep in sync with driver-scoring.ts
driver.get("/scorecard", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const now = new Date();
  const to   = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

  if (!isTruckHistoryOrg(orgId)) {
    const off: DriverScorecardResponse = {
      enabled: false, from, to,
      activeDays: 0, inspectionDays: 0, preTrips: 0, postTrips: 0,
      completionPct: 0, score: 0, bonusEligible: false, bonusThreshold: SCORECARD_BONUS_THRESHOLD,
    };
    return c.json(off);
  }

  const fromTs = `${from}T00:00:00.000Z`;
  const toTs   = `${to}T23:59:59.999Z`;

  const [inspRes, evRes] = await Promise.all([
    sbAny
      .from("inspection_reports")
      .select("kind,inspection_date")
      .eq("org_id", orgId)
      .eq("driver_id", driverId)
      .gte("inspection_date", from)
      .lte("inspection_date", to),
    supabase
      .from("events")
      .select("start")
      .eq("org_id", orgId)
      .eq("driver_id", driverId)
      .gte("start", fromTs)
      .lte("start", toTs)
      .limit(2000),
  ]);
  if (inspRes.error || evRes.error) {
    console.error("[GET /v1/driver/scorecard] failed:", inspRes.error ?? evRes.error);
    return c.json({ error: "fetch_failed" }, 500);
  }

  const inspections = (inspRes.data ?? []) as Array<{ kind: string | null; inspection_date: string }>;
  const events      = (evRes.data ?? []) as Array<{ start: string }>;

  const activeDaySet = new Set<string>();
  for (const ev of events) activeDaySet.add(ev.start.slice(0, 10));
  const inspectionDaySet = new Set<string>();
  let preTrips = 0, postTrips = 0;
  for (const insp of inspections) {
    inspectionDaySet.add(insp.inspection_date); // ≥1 inspection covers the day
    if (insp.kind === "pre_trip") preTrips++;
    else if (insp.kind === "post_trip") postTrips++;
  }
  const activeDays = activeDaySet.size;
  const inspectionDays = inspectionDaySet.size;
  const completionPct = activeDays > 0
    ? Math.max(0, Math.min(100, Math.round((inspectionDays / activeDays) * 100)))
    : (inspectionDays > 0 ? 100 : 0);
  const score = completionPct;

  const res: DriverScorecardResponse = {
    enabled: true, from, to,
    activeDays, inspectionDays, preTrips, postTrips,
    completionPct, score,
    bonusEligible: score >= SCORECARD_BONUS_THRESHOLD,
    bonusThreshold: SCORECARD_BONUS_THRESHOLD,
  };
  return c.json(res);
});

// POD + BOL are operationally required for trucking workflows — proof
// of delivery is what drives invoicing, BOL is the freight contract.
// There's no legitimate fleet config where drivers should be blocked
// from seeing or uploading these. The dispatcher settings panel's
// driverVisible toggle is for the niche kinds (scale, lumper, etc.);
// these two are non-negotiable floor. Logs once per request when the
// floor had to add anything so we can spot orgs whose config wiped them.
const MANDATORY_DRIVER_KINDS = ["pod", "bol"] as const;

function ensureMandatoryDriverKinds(
  kinds: string[],
  orgId: string,
  source: string,
): string[] {
  const set = new Set(kinds);
  const added: string[] = [];
  for (const k of MANDATORY_DRIVER_KINDS) {
    if (!set.has(k)) { set.add(k); added.push(k); }
  }
  if (added.length > 0) {
    console.warn(
      `[${source}] org ${orgId} config missing mandatory driver kinds`,
      added,
      "— added to allow-list",
    );
  }
  return [...set];
}

// Pull the IANA portion ("America/Denver") out of values like
// "Mountain Time (America/Denver)" stored on rate_con_settings.
// Returns null when the value doesn't contain a parseable IANA tz.
function sanitizeTz(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/[A-Za-z]+\/[A-Za-z_+\-]+(?:\/[A-Za-z_+\-]+)?/);
  const candidate = m ? m[0] : raw.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}

// GET /v1/driver/trailers — list of trailers in the driver's org for the
// trailer picker. Sort order matches the dispatch app.
// GET /v1/driver/suggested-asset — best guess at the truck the driver is
// currently in. Used by the fuel + maintenance forms to pre-select.
//
// Lookup order:
//   1. Any non-deleted revenue OR non-revenue event assigned to this
//      driver whose [start, end] overlaps the window [now-6h, now+6h].
//      Take the event with the closest start to now.
//   2. The driver_asset_prefs row for this driver, if any.
//   3. null — caller shows the picker without a default.
driver.get("/suggested-asset", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const now    = new Date();
  const lookback = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const lookahead = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  // 1) Active / near-active events for this driver. Overlap with
  //    [lookback, lookahead] is: end >= lookback AND start <= lookahead.
  const { data: events } = await supabase
    .from("events")
    .select("asset_id, start")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .is("deleted_at", null)
    .gte("end",   lookback.toISOString())
    .lte("start", lookahead.toISOString())
    .order("start", { ascending: true });

  const eventRows = (events ?? []) as Array<{ asset_id: number | null; start: string }>;
  if (eventRows.length > 0) {
    const nowMs = now.getTime();
    let best = eventRows[0];
    let bestDist = Math.abs(new Date(best.start).getTime() - nowMs);
    for (const e of eventRows.slice(1)) {
      const d = Math.abs(new Date(e.start).getTime() - nowMs);
      if (d < bestDist) { best = e; bestDist = d; }
    }
    if (best.asset_id != null) {
      return c.json({ assetId: best.asset_id, source: "event" });
    }
  }

  // 2) Stored preference.
  const { data: pref } = await supabase
    .from("driver_asset_prefs")
    .select("asset_id")
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .maybeSingle();
  const prefRow = pref as { asset_id: number } | null;
  if (prefRow?.asset_id != null) {
    return c.json({ assetId: prefRow.asset_id, source: "preference" });
  }

  return c.json({ assetId: null, source: null });
});

// GET /v1/driver/assets — every non-hidden asset in the driver's org.
// Used by the fuel-report form (driver picks which truck they're fueling).
// Returns the lean shape the form needs — full asset detail lives in the
// dispatch surface.
driver.get("/assets", async (c) => {
  const orgId = c.get("orgId");
  // Filter out retired assets (active_to is set) — drivers shouldn't see
  // them in pickers for fuel reports, inspections, or maintenance.
  // hidden=false covers admin-hidden trucks; active_to IS NULL covers
  // ones that have been formally retired via the lifecycle flow.
  const { data, error } = await supabase
    .from("assets")
    .select("id, name, unit, truck, color, type, sort_order")
    .eq("org_id", orgId)
    .eq("hidden", false)
    .is("active_to", null)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/driver/assets] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const assets = (data ?? []).map((a) => {
    const r = a as { id: number; name: string; unit: string | null; truck: string | null; color: string; type: string };
    return {
      id:    r.id,
      name:  r.name,
      unit:  r.unit  ?? undefined,
      truck: r.truck ?? undefined,
      color: r.color,
      type:  r.type,
    };
  });
  return c.json({ assets });
});

driver.get("/trailers", async (c) => {
  const orgId = c.get("orgId");
  // Same retirement filter as /assets — keep retired trailers out of
  // the driver-facing pickers.
  const { data, error } = await supabase
    .from("trailers")
    .select("id, name, trailer_number, category, sort_order")
    .eq("org_id", orgId)
    .is("active_to", null)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[GET /v1/driver/trailers] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const trailers = (data ?? []).map((t) => {
    const r = t as { id: number; name: string; trailer_number: string | null; category: string };
    return {
      id:            r.id,
      name:          r.name,
      trailerNumber: r.trailer_number ?? undefined,
      category:      r.category,
    };
  });
  return c.json({ trailers });
});

// ─────────────────────────────────────────────────────────────────────────
// Audit-log helper — read-modify-write append on events.audit_log JSONB.
// Driver-paced edits are sequential per device, so optimistic update is
// fine; high-contention writes would need a postgres function instead.
// ─────────────────────────────────────────────────────────────────────────

interface AuditEntry {
  changedAt:    string;
  changedByName: string;
  prevStatus?:  string;
  newStatus?:   string;
  trailerChanged?: { prev?: string; next?: string };
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?:  { fileName: string; kind: string };
  stopCheckedIn?:    { stopFacility?: string; stopType?: string; distanceMi?: number };
  stopCheckInUndone?: { stopFacility?: string; stopType?: string };
  /** Driver tapped Confirm in the driver app — see POST /loads/:id/confirm. */
  loadConfirmed?:    boolean;
}

/** Same 60s dedup window as the shared auditLog.ts helpers. The driver
 *  app retries on network blip and can fire the same status flip 2-3
 *  times in a burst; without this we get triplicate "Status changed
 *  scheduled → picked_up" entries at identical timestamps. */
const DRIVER_AUDIT_DEDUP_WINDOW_MS = 60_000;

/** Deterministic JSON used for dedup-key equality — recursive key sort.
 *  Postgres jsonb does NOT preserve key insertion order, so entries read
 *  back from `events.audit_log` come in jsonb's canonical order while
 *  the candidate we build in JS uses the AuditEntry interface order.
 *  Plain `JSON.stringify` produces different strings for the same data;
 *  see the long writeup in lib/auditLog.ts for why every prior fix
 *  attempt missed this. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

async function appendAudit(
  eventId: string,
  orgId:   string,
  entry:   AuditEntry,
): Promise<void> {
  const { data, error } = await supabase
    .from("events")
    .select("audit_log")
    .eq("id", eventId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) { console.error("[driver/appendAudit] read:", error); return; }
  const existing = ((data as { audit_log: AuditEntry[] | null } | null)?.audit_log) ?? [];

  // Dedup: scan last 10 entries; skip when one within the window has the
  // same semantic content (everything except changedAt). Uses
  // stableStringify so jsonb's key reordering doesn't break the check.
  const candidateMs = Date.parse(entry.changedAt ?? "");
  if (Number.isFinite(candidateMs)) {
    const tail = existing.slice(-10);
    const { changedAt: _candidateChangedAt, ...candidateRest } = entry;
    void _candidateChangedAt;
    const candidateContent = stableStringify(candidateRest);
    for (let i = tail.length - 1; i >= 0; i--) {
      const prev = tail[i];
      const prevMs = Date.parse(prev.changedAt ?? "");
      if (!Number.isFinite(prevMs)) continue;
      if (Math.abs(candidateMs - prevMs) > DRIVER_AUDIT_DEDUP_WINDOW_MS) continue;
      const { changedAt: _prevChangedAt, ...prevRest } = prev;
      void _prevChangedAt;
      const prevContent = stableStringify(prevRest);
      if (prevContent === candidateContent) return;
    }
  }

  const next = [...existing, entry];
  const { error: writeErr } = await supabase
    .from("events")
    .update({ audit_log: next as never })
    .eq("id", eventId)
    .eq("org_id", orgId);
  if (writeErr) console.error("[driver/appendAudit] write:", writeErr);
}

// Auto-log a system-generated check call for driver-side events
// (check-ins, status flips, confirm). Dispatchers see these in the
// load modal's Check Calls panel alongside manually-logged calls.
// channel='note', with_party='driver' since these are all driver
// actions. No-op on non-revenue events (loadId is null).
async function recordDriverCheckCall(
  loadId:  string | null | undefined,
  orgId:   string,
  byName:  string,
  body:    string,
  ts?:     string,
): Promise<void> {
  if (!loadId) return; // non-revenue events have no parent load

  // Dedup guard: skip the insert if an identical entry (same load,
  // same body, same author) was logged in the last 60 seconds. Catches
  // accidental double-taps + any retry behavior that fires the same
  // server call twice for one driver action. Keeps the check-calls
  // timeline clean regardless of client-side cause.
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: recent } = await supabase
    .from("check_calls")
    .select("id")
    .eq("org_id",  orgId)
    .eq("load_id", loadId)
    .eq("body",    body)
    .eq("by_name", byName)
    .gte("ts",     cutoff)
    .limit(1)
    .maybeSingle();
  if (recent) return;

  const { error } = await supabase
    .from("check_calls")
    .insert({
      org_id:     orgId,
      load_id:    loadId,
      ts:         ts ?? new Date().toISOString(),
      by_name:    byName,
      channel:    "note",
      with_party: "driver",
      body,
    } as never);
  if (error) {
    console.error("[recordDriverCheckCall]", loadId, body, error);
  }
}

// Stamp acknowledged_at on any pending load_notifications matching the
// driver action that just happened. Idempotent — re-running ack for
// the same kind is a no-op since we only target rows where
// acknowledged_at IS NULL. Cheap query (covered by the
// idx_load_notifications_driver_pending partial index).
async function ackLoadNotifications(
  eventId: string,
  orgId: string,
  kinds: readonly string[],
): Promise<void> {
  if (kinds.length === 0) return;
  const { error } = await supabase
    .from("load_notifications")
    .update({ acknowledged_at: new Date().toISOString() } as never)
    .eq("event_id", eventId)
    .eq("org_id", orgId)
    .in("kind", kinds as unknown as string[])
    .is("acknowledged_at", null);
  if (error) {
    console.error("[ackLoadNotifications]", eventId, kinds, error);
  }
}

// Fetch the event ensuring it belongs to the auth'd driver. Used as a
// pre-check before mutating writes — refuses 404 / 403 explicitly so
// the driver app can show a clear error rather than a silent no-op.
async function loadDriverEvent(eventId: string, driverId: number, orgId: string) {
  const { data, error } = await supabase
    .from("events")
    .select("id, driver_id, org_id, status, trailer_id, deleted_at, confirmed_at")
    .eq("id", eventId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string; driver_id: number | null; org_id: string; status: string;
    trailer_id: number | null; deleted_at: string | null; confirmed_at: string | null;
  };
  if (row.org_id !== orgId)        return { row: null, reason: "wrong_org"   as const };
  if (row.driver_id !== driverId)  return { row: null, reason: "not_driver"  as const };
  if (row.deleted_at)              return { row: null, reason: "deleted"     as const };
  return { row, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────
// Write endpoints
// ─────────────────────────────────────────────────────────────────────────

// PATCH /v1/driver/loads/:id — partial update for the fields a driver can
// change: status and trailer. Both audit-logged with the driver's name.
driver.patch("/loads/:id", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id   = c.req.param("id");
  const body = await c.req.json<{ status?: string; trailerId?: number | null }>();

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (found.row === null) return c.json({ error: "forbidden", reason: found.reason }, 403);
  const prev = found.row;

  const update: Record<string, unknown> = {};
  if (body.status !== undefined)    update.status     = body.status;
  if (body.trailerId !== undefined) update.trailer_id = body.trailerId;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["nothing to update"] }, 400);
  }

  // Auto-stamp confirmed_at when status advances past 'scheduled' and
  // the driver never explicitly confirmed. Covers the "skip the green
  // banner and just tap Start Trip" path. The two actions (Confirm
  // and Start Trip) are now equivalent acknowledgments.
  const POST_SCHEDULED = new Set(["dispatched", "en_route", "picked_up", "delivered"]);
  const advancingPastScheduled =
    body.status !== undefined && POST_SCHEDULED.has(body.status) && !prev.confirmed_at;
  if (advancingPastScheduled) {
    update.confirmed_at = new Date().toISOString();
    update.confirmed_by = driverId;
  }

  const { error } = await supabase
    .from("events")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[PATCH /v1/driver/loads/:id] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }

  // Audit each kind of change separately so the timeline reads cleanly.
  // Driver-side picked_up / delivered transitions are logged to
  // check_calls instead (see recordDriverCheckCall below), so we skip
  // those here to keep the history panel focused on dispatcher-only
  // edits + trailer / document changes. en_route + dispatched still
  // log so the history shows when the trip kicked off.
  const logToAudit =
    body.status !== undefined &&
    body.status !== prev.status &&
    body.status !== "picked_up" &&
    body.status !== "delivered";
  if (logToAudit) {
    await appendAudit(id, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: driverName,
      prevStatus:   prev.status,
      newStatus:    body.status,
    });
  }
  if (body.status !== undefined && body.status !== prev.status) {
    // Auto-acknowledge any pending load_notifications that this status
    // transition satisfies. e.g., reaching picked_up acks both
    // 'mark_pickup' and any 'confirm' nudges (since picked_up implies
    // the driver accepted the load).
    const ackKinds: string[] = [];
    if (advancingPastScheduled) ackKinds.push("confirm");
    if (body.status === "picked_up" || body.status === "delivered") {
      ackKinds.push("mark_pickup");
    }
    if (body.status === "delivered") ackKinds.push("mark_delivery");
    if (ackKinds.length) await ackLoadNotifications(id, orgId, ackKinds);

    // Surface picked_up + delivered to the check-calls panel for
    // active dispatcher visibility. Only fire on these two — earlier
    // transitions (dispatched/en_route) aren't useful as call logs.
    if (body.status === "picked_up" || body.status === "delivered") {
      const { data: evRow } = await supabase
        .from("events")
        .select("load_id")
        .eq("id", id)
        .maybeSingle();
      const loadId = (evRow as { load_id: string | null } | null)?.load_id ?? null;
      const label  = body.status === "picked_up" ? "Marked picked up" : "Marked delivered";
      await recordDriverCheckCall(loadId, orgId, driverName, label);
    }
  }
  if (body.trailerId !== undefined && body.trailerId !== prev.trailer_id) {
    await appendAudit(id, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: driverName,
      trailerChanged: {
        prev: prev.trailer_id != null ? String(prev.trailer_id) : undefined,
        next: body.trailerId != null  ? String(body.trailerId)  : undefined,
      },
    });
    // Driver picked a trailer — acks any pending 'report_trailer' nudge.
    if (body.trailerId != null) {
      await ackLoadNotifications(id, orgId, ["report_trailer"]);
    }
  }

  return c.json({ ok: true });
});

// POST /v1/driver/loads/:id/confirm — driver confirms an assigned load.
// Sets events.confirmed_at = now() and events.confirmed_by = driver_id.
// Also advances status to 'dispatched' from either 'scheduled' or
// 'assigned' (these are the two pre-confirm states — see the load
// status semantics doc in events.ts PATCH). Confirm replaces the
// legacy "Accept Load" CTA — they're the same conceptual action
// (driver acknowledges they're taking the load).
//
// Idempotent: re-confirming the same load just returns ok with the
// existing timestamp (we don't bump it; UI shows "Confirmed 2h ago"
// type relative times against the first stamp).
driver.post("/loads/:id/confirm", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id         = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found) return c.json({ error: "not_found" }, 404);
  if (found.row === null) return c.json({ error: "forbidden", reason: found.reason }, 403);

  // Fetch current state so we can no-op idempotently AND know whether
  // we still need to bump status (driver might tap Confirm after
  // already starting the trip in some edge case).
  const { data: stateRow } = await supabase
    .from("events")
    .select("confirmed_at, status")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const existing = (stateRow as { confirmed_at: string | null; status: string } | null);
  if (existing?.confirmed_at) {
    return c.json({ ok: true, confirmedAt: existing.confirmed_at });
  }

  const nowIso = new Date().toISOString();
  // Advance status from either pre-confirm state ('scheduled' or
  // 'assigned') to 'dispatched'. If the driver is already at en_route
  // / picked_up / etc., the trip has moved past confirm — leave it.
  const willBumpStatus = existing?.status === "scheduled" || existing?.status === "assigned";
  const update: Record<string, unknown> = {
    confirmed_at: nowIso,
    confirmed_by: driverId,
  };
  if (willBumpStatus) update.status = "dispatched";

  const { error } = await supabase
    .from("events")
    .update(update as never)
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) {
    console.error("[POST /v1/driver/loads/:id/confirm] failed:", error);
    return c.json({ error: "update_failed", detail: error.message }, 500);
  }

  // Confirmation is logged to check_calls (see recordDriverCheckCall
  // below), not the audit history. Dispatchers track in-flight driver
  // actions in the check-calls panel; the history view is reserved
  // for dispatcher-side edits + trailer / document changes.

  // Driver explicitly confirmed — ack any pending 'confirm' nudges
  // for this event so the dispatcher's pending-count drops to zero.
  await ackLoadNotifications(id, orgId, ["confirm"]);

  // Log to the check-calls timeline so dispatchers see the
  // confirmation alongside their manual call/text logs.
  const { data: evRow } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", id)
    .maybeSingle();
  await recordDriverCheckCall(
    (evRow as { load_id: string | null } | null)?.load_id ?? null,
    orgId, driverName, "Confirmed load", nowIso,
  );
  return c.json({ ok: true, confirmedAt: nowIso });
});

// POST /v1/driver/stops/:id/check-in — record arrival at a stop. Body:
// { lat, lng }. Server stamps arrived_at = now() so the device clock
// can't drift the timeline.
driver.post("/stops/:id/check-in", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const stopId = c.req.param("id");
  const body = await c.req.json<{ lat: number; lng: number; distanceMi?: number }>();

  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return c.json({ error: "validation_failed", errors: ["lat/lng required"] }, 400);
  }

  // Verify the stop belongs to a load assigned to the auth'd driver before
  // letting them mark it. Fetches the stop + parent event in one nested
  // select; rejects if the parent isn't theirs.
  const { data: stopRow, error: stopErr } = await supabase
    .from("stops")
    .select("id, event_id, type, facility_name, org_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopErr || !stopRow) return c.json({ error: "not_found" }, 404);
  const stop = stopRow as { id: string; event_id: string; type: string; facility_name: string | null; org_id: string };
  if (stop.org_id !== orgId) return c.json({ error: "forbidden" }, 403);

  const found = await loadDriverEvent(stop.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { error: writeErr } = await supabase
    .from("stops")
    .update({
      arrived_at:  new Date().toISOString(),
      arrived_lat: body.lat,
      arrived_lng: body.lng,
    })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (writeErr) {
    console.error("[POST /v1/driver/stops/:id/check-in] failed:", writeErr);
    return c.json({ error: "update_failed", detail: writeErr.message }, 500);
  }

  // Stop check-in is logged to check_calls only (see below) — it's a
  // driver-on-the-road action, not a record-keeping edit.

  // Surface the check-in to the dispatcher's check-calls panel as
  // well as the load_notifications timeline.
  const { data: evRow } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", stop.event_id)
    .maybeSingle();
  const loadId = (evRow as { load_id: string | null } | null)?.load_id ?? null;
  const stopLabel = STOP_TYPE_LABEL[stop.type as keyof typeof STOP_TYPE_LABEL] ?? stop.type.toUpperCase();
  const facility  = stop.facility_name ? ` — ${stop.facility_name}` : "";
  const distNote  = body.distanceMi != null
    ? (body.distanceMi < 0.1 ? " (on-site)" : ` (${body.distanceMi.toFixed(1)} mi off)`)
    : "";
  await recordDriverCheckCall(
    loadId, orgId, driverName,
    `Checked in at ${stopLabel}${facility}${distNote}`,
  );

  return c.json({ ok: true });
});

// POST /v1/driver/stops/:id/check-out — undo the check-in. Clears the
// arrived_at/lat/lng triple and audits the undo.
driver.post("/stops/:id/check-out", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const stopId = c.req.param("id");

  const { data: stopRow, error: stopErr } = await supabase
    .from("stops")
    .select("id, event_id, type, facility_name, org_id")
    .eq("id", stopId)
    .maybeSingle();
  if (stopErr || !stopRow) return c.json({ error: "not_found" }, 404);
  const stop = stopRow as { id: string; event_id: string; type: string; facility_name: string | null; org_id: string };
  if (stop.org_id !== orgId) return c.json({ error: "forbidden" }, 403);

  const found = await loadDriverEvent(stop.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { error: writeErr } = await supabase
    .from("stops")
    .update({ arrived_at: null, arrived_lat: null, arrived_lng: null })
    .eq("id", stopId)
    .eq("org_id", orgId);
  if (writeErr) {
    console.error("[POST /v1/driver/stops/:id/check-out] failed:", writeErr);
    return c.json({ error: "update_failed", detail: writeErr.message }, 500);
  }

  // Check-out (undo check-in) — logged to check_calls instead of the
  // audit history to keep the on-road timeline in one place.
  const { data: evRow } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", stop.event_id)
    .maybeSingle();
  const loadId = (evRow as { load_id: string | null } | null)?.load_id ?? null;
  const stopLabel = STOP_TYPE_LABEL[stop.type as keyof typeof STOP_TYPE_LABEL] ?? stop.type.toUpperCase();
  const facility  = stop.facility_name ? ` — ${stop.facility_name}` : "";
  await recordDriverCheckCall(
    loadId, orgId, driverName,
    `Undid check-in at ${stopLabel}${facility}`,
  );

  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Documents — list, upload, delete, signed URL
// ─────────────────────────────────────────────────────────────────────────

// Drivers ONLY interact with the load-documents bucket. The rate-cons
// bucket is dispatcher-confidential by policy — even if a driver got
// a tampered list of doc IDs that included a rate_con row, every
// signed-URL mint here goes through load-documents and would 404 on
// rate_con blobs (which physically live in the rate-cons bucket post-
// Phase 3.1 split). The visibility filter (driverVisibleKinds) also
// excludes rate_con from the list, so this is defense in depth.
const DOC_BUCKET = "load-documents";

interface DocRow {
  id: string;
  event_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string;
  uploaded_at: string;
  uploaded_by_driver_id: number | null;
  notes: string | null;
}

function rowToDoc(r: DocRow) {
  return {
    id:           r.id,
    eventId:      r.event_id,
    storagePath:  r.storage_path,
    fileName:     r.file_name,
    mimeType:     r.mime_type ?? undefined,
    sizeBytes:    r.size_bytes ?? undefined,
    kind:         r.kind,
    uploadedAt:   r.uploaded_at,
    uploadedByDriverId: r.uploaded_by_driver_id ?? undefined,
    notes:        r.notes ?? undefined,
  };
}

// GET /v1/driver/loads/:id/documents — list documents for a load assigned
// to the auth'd driver, newest first.
//
// `:id` is an event id. For relay loads the two legs share a single
// loads.id but each leg has its own event, so we resolve the event's
// load_id and query by that — both pickup and delivery drivers then
// see the same handoff photos. Non-revenue events have no load_id;
// we fall back to event_id-scoped listing in that case.
driver.get("/loads/:id/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  // Apply the org's driver-visible kinds allow-list. Server-side filter
  // so even a tampered client can't see hidden kinds. Resolution order:
  //   1. document_types (new richer config; enabled && driverVisible)
  //   2. driver_visible_doc_kinds (legacy fallback for orgs that haven't
  //      been migrated yet — the 20260520 migration backfills the new
  //      column, but the fallback keeps brand-new orgs safe.)
  //   3. DEFAULT_DRIVER_VISIBLE_DOC_KINDS — global default
  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("driver_visible_doc_kinds, document_types")
    .eq("org_id", orgId)
    .maybeSingle();
  const s = settingsRow as {
    driver_visible_doc_kinds: string[] | null;
    document_types: Array<{ kind: string; enabled: boolean; driverVisible: boolean }> | null;
  } | null;
  // Same canonical resolver as /org-settings — see note there. Critical
  // that both endpoints stay in lockstep, otherwise the picker (driven
  // by /org-settings) and the read list (driven by this endpoint) can
  // diverge, leaving the driver to upload kinds they then can't see.
  let visibleKinds: string[];
  if (s?.document_types && Array.isArray(s.document_types)) {
    visibleKinds = driverVisibleDocumentKinds(s.document_types);
  } else if (s?.driver_visible_doc_kinds) {
    visibleKinds = s.driver_visible_doc_kinds;
  } else {
    visibleKinds = [...DEFAULT_DRIVER_VISIBLE_DOC_KINDS];
  }
  // Hardening: if the resolved set ends up empty, fall back to the
  // global defaults rather than silently returning zero documents.
  // The previous "return [] immediately" behavior was indistinguishable
  // on the client from "driver has no docs on this load" and made it
  // impossible for drivers to see a dispatcher-uploaded POD when an
  // admin accidentally wiped the document_types config. Matches the
  // same fallback the /org-settings endpoint applies to driverUploadKinds.
  if (visibleKinds.length === 0) {
    console.warn(
      "[GET /v1/driver/loads/:id/documents] visibleKinds empty for org",
      orgId,
      "— falling back to defaults",
    );
    visibleKinds = [...DEFAULT_DRIVER_VISIBLE_DOC_KINDS];
  }
  // POD + BOL floor — see ensureMandatoryDriverKinds for the rationale.
  // Without this, a dispatcher who flipped POD's driverVisible off in
  // settings can't be seen by their drivers even after the dispatcher
  // uploads one — which is precisely the bug the user reported when
  // their PODs weren't showing in the driver app.
  visibleKinds = ensureMandatoryDriverKinds(visibleKinds, orgId, "loads/:id/documents");

  const { data: ev } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", id)
    .maybeSingle();
  const loadId = (ev as { load_id: string | null } | null)?.load_id ?? null;

  const baseQuery = supabase
    .from("load_documents")
    .select("*")
    .eq("org_id", orgId)
    .in("kind", visibleKinds)
    .order("uploaded_at", { ascending: false });
  const { data, error } = await (loadId
    ? baseQuery.eq("load_id", loadId)
    : baseQuery.eq("event_id", id));

  if (error) {
    console.error("[GET /v1/driver/loads/:id/documents] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  const rows = (data ?? []) as DocRow[];

  // Batch-mint signed URLs so thumbnails render without a per-doc round-trip.
  const urlByPath = new Map<string, string>();
  if (rows.length > 0) {
    const { data: signed, error: signErr } = await supabase.storage
      .from(DOC_BUCKET)
      .createSignedUrls(rows.map((r) => r.storage_path), 3600);
    if (signErr) {
      console.error("[GET /v1/driver/loads/:id/documents] sign failed:", signErr);
    } else {
      for (const u of signed ?? []) {
        if (u.path && u.signedUrl) urlByPath.set(u.path, u.signedUrl);
      }
    }
  }

  const documents = rows.map((r) => ({
    ...rowToDoc(r),
    signedUrl: urlByPath.get(r.storage_path),
  }));
  return c.json({ documents });
});

// POST /v1/driver/loads/:id/documents — multipart upload. Form fields:
//   file (binary), kind ("bol" | "pod" | "scale" | "other")
// Server writes to the load-documents bucket with the service role key
// and inserts a load_documents row, then audits.
driver.post("/loads/:id/documents", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id = c.req.param("id");

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  let body: { file?: File; kind?: string };
  try { body = await c.req.parseBody() as { file?: File; kind?: string }; }
  catch (err) {
    console.error("[POST /v1/driver/loads/:id/documents] parseBody:", err);
    return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400);
  }
  const file = body.file;
  const kind = (body.kind ?? "other").toString();
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }
  // Validate kind is in the canonical enum.
  if (!DOCUMENT_KINDS.includes(kind as DocumentKind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`] }, 400);
  }
  // Drivers must not upload kinds that are dispatcher-confidential by
  // Drivers must not upload kinds that are dispatcher-confidential by
  // policy — rate_con contains broker rates, invoice is the customer-
  // facing financial doc. Both are also driverVisible=false-locked, so
  // even if an attacker mis-allowed them server-side, the read filter
  // would still hide them. Reject at the write boundary regardless.
  //
  // driver_sheet IS allowed — it's driver-visible by default and the
  // driver legitimately uploads their pay sheet from the field. Earlier
  // this list excluded it; that was the cause of the 403 on legitimate
  // driver-sheet uploads.
  const DRIVER_FORBIDDEN_UPLOAD_KINDS = new Set<DocumentKind>([
    "rate_con", "invoice",
  ]);
  if (DRIVER_FORBIDDEN_UPLOAD_KINDS.has(kind as DocumentKind)) {
    return c.json({
      error:  "forbidden",
      errors: [`kind '${kind}' is not allowed for driver uploads`],
    }, 403);
  }

  // Resolve load_id from the event so the document is reachable from
  // load-scoped reads (web app queries by load_id post-2.5a). Non-revenue
  // events have no load — load_id stays null, matching legacy behavior.
  const { data: ev } = await supabase
    .from("events")
    .select("load_id")
    .eq("id", id)
    .maybeSingle();
  const loadId = (ev as { load_id: string | null } | null)?.load_id ?? null;

  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;
  {
    const conv = await convertIfHeic(file, bytes);
    if ("failed" in conv) return c.json(HEIC_DECODE_FAILED, 415);
    bytes = conv.bytes; uploadName = conv.name; uploadMime = conv.mime;
  }
  const ext   = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const random = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${random}.${ext}`;

  // Build the display filename the same way as POST /v1/loads/:id/documents
  // (loads.ts) so dispatcher-uploaded and driver-uploaded docs follow one
  // convention: "{LOAD_NUM}_{KIND}{_N}.{ext}". Suffix _N appears when the
  // load already has another doc of the same kind. Falls back to the
  // client-sent name if the load has no load_num (non-revenue, untagged).
  let displayName = uploadName;
  if (loadId) {
    const { data: loadInfo } = await supabase
      .from("loads")
      .select("load_num")
      .eq("id", loadId)
      .eq("org_id", orgId)
      .maybeSingle();
    const loadNum = (loadInfo as { load_num: string | null } | null)?.load_num ?? null;
    if (loadNum) {
      const safeNum = loadNum.replace(/[^A-Za-z0-9_-]/g, "");
      const kindLabel = kind.toUpperCase();
      const { count: priorCount } = await supabase
        .from("load_documents")
        .select("id", { head: true, count: "exact" })
        .eq("load_id", loadId)
        .eq("org_id", orgId)
        .eq("kind", kind);
      const suffix = (priorCount ?? 0) > 0 ? `_${(priorCount ?? 0) + 1}` : "";
      displayName = `${safeNum}_${kindLabel}${suffix}.${ext}`;
    }
  }

  const { error: uploadErr } = await supabase.storage
    .from(DOC_BUCKET)
    .upload(storagePath, bytes, {
      contentType: uploadMime || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST /v1/driver/loads/:id/documents] storage upload:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  const { data, error } = await supabase
    .from("load_documents")
    .insert({
      event_id:              id,
      load_id:               loadId,
      org_id:                orgId,
      storage_path:          storagePath,
      file_name:             displayName,
      mime_type:             uploadMime || null,
      size_bytes:            bytes.length,
      kind,
      uploaded_by_driver_id: driverId,
    } as never)
    .select("*")
    .single();
  if (error || !data) {
    // Attempt to clean up the orphaned blob; not critical if it fails.
    void supabase.storage.from(DOC_BUCKET).remove([storagePath]);
    console.error("[POST /v1/driver/loads/:id/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  const doc = rowToDoc(data as DocRow);

  await appendAudit(id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    documentUploaded: { fileName: doc.fileName, kind: doc.kind },
  });

  // POD upload acks any pending 'upload_pod' nudge on this event so the
  // dispatcher's pending count drops. Other kinds (BOL, scale, other)
  // don't auto-ack POD nudges.
  if (kind === "pod") {
    await ackLoadNotifications(id, orgId, ["upload_pod"]);
  }

  return c.json({ document: doc });
});

// DELETE /v1/driver/loads/documents/:id — remove a LOAD-attached
// document the driver uploaded (POD, BOL, scale ticket, etc).
// Storage object + DB row come down together; audit logged.
//
// NOTE: distinct path from the /documents/:id handler further down,
// which deletes the driver's PROFILE documents (license, medical
// card, etc). Both used to share /documents/:id, which collided —
// Hono picked the first-registered and broke profile-doc delete with
// a 404. Splitting the routes by entity keeps each scoped to its own
// table.
driver.delete("/loads/documents/:id", async (c) => {
  const driverId   = c.get("driverId");
  const orgId      = c.get("orgId");
  const driverName = c.get("driverName");
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return c.json({ error: "not_found" }, 404);
  const doc = data as DocRow;

  // Authorize: parent event must be assigned to this driver.
  const found = await loadDriverEvent(doc.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const [storageRes, dbRes] = await Promise.all([
    supabase.storage.from(DOC_BUCKET).remove([doc.storage_path]),
    supabase.from("load_documents").delete().eq("id", id).eq("org_id", orgId),
  ]);
  if (storageRes.error) console.error("[DELETE /v1/driver/documents/:id] storage:", storageRes.error);
  if (dbRes.error)      console.error("[DELETE /v1/driver/documents/:id] db:",      dbRes.error);

  await appendAudit(doc.event_id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    documentDeleted: { fileName: doc.file_name, kind: doc.kind },
  });

  return c.json({ ok: true });
});

// PATCH /v1/driver/documents/:id — let a driver re-categorize a doc
// on their load. Kind-only by design — filename is server-controlled
// (auto-named at upload via {LOAD_NUM}_{KIND}.{ext}), so we don't let
// drivers rename. Restricted to the org's driver-allowed upload kinds
// so rate_con / invoice / driver_sheet are never reachable here.
driver.patch("/loads/documents/:id", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const driverName = c.get("driverName");
  const id = c.req.param("id");

  const body = await c.req.json<{ kind?: string }>();
  const nextKind = body.kind;
  if (typeof nextKind !== "string" || !nextKind) {
    return c.json({ error: "validation_failed", errors: ["kind required"] }, 400);
  }
  if (!DOCUMENT_KINDS.includes(nextKind as DocumentKind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DOCUMENT_KINDS.join("|")}`] }, 400);
  }
  // Resolve the org's allowed driver kinds from document_types
  // (with legacy + default fallbacks, matching the docs-list endpoint).
  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("document_types, driver_visible_doc_kinds")
    .eq("org_id", orgId)
    .maybeSingle();
  const s = settingsRow as {
    document_types: Array<{ kind: string; enabled: boolean; driverVisible: boolean }> | null;
    driver_visible_doc_kinds: string[] | null;
  } | null;
  let allowed: string[];
  if (s?.document_types && Array.isArray(s.document_types)) {
    allowed = s.document_types.filter(t => t.enabled && t.driverVisible).map(t => t.kind);
  } else if (s?.driver_visible_doc_kinds) {
    allowed = s.driver_visible_doc_kinds;
  } else {
    allowed = ["pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "relay_handoff", "other"];
  }
  // Hard-block dispatcher-only kinds even if the org somehow has them
  // in the allow-list. The PATCH endpoint should never be a path that
  // hides documents from drivers (kind=rate_con would do that) or
  // mislabels them as invoices.
  const DRIVER_FORBIDDEN = new Set(["rate_con", "invoice"]);
  if (!allowed.includes(nextKind) || DRIVER_FORBIDDEN.has(nextKind)) {
    return c.json({ error: "forbidden", errors: [`kind '${nextKind}' is not allowed for driver edits`] }, 403);
  }

  // Authorize: doc must belong to a load assigned to this driver.
  const { data, error: fetchErr } = await supabase
    .from("load_documents")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (fetchErr || !data) return c.json({ error: "not_found" }, 404);
  const doc = data as DocRow;
  const found = await loadDriverEvent(doc.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const prevKind = doc.kind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: updErr } = await supabase
    .from("load_documents")
    .update({ kind: nextKind } as any)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("*")
    .single();
  if (updErr || !updated) {
    console.error("[PATCH /v1/driver/documents/:id] update failed:", updErr);
    return c.json({ error: "update_failed", detail: updErr?.message }, 500);
  }

  await appendAudit(doc.event_id, orgId, {
    changedAt:    new Date().toISOString(),
    changedByName: driverName,
    // Re-use the documentUploaded shape for the audit message since
    // there isn't a dedicated "kind changed" entry today. The fileName
    // makes the row identifiable in the audit log.
    documentUploaded: { fileName: doc.file_name, kind: `${prevKind} → ${nextKind}` },
  });

  return c.json({ document: rowToDoc(updated as DocRow) });
});

// GET /v1/driver/documents/:id/url — short-lived signed URL for viewing.
// Same authorization as DELETE — must be the driver's load.
driver.get("/loads/documents/:id/url", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");

  const { data, error } = await supabase
    .from("load_documents")
    .select("event_id, storage_path")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !data) return c.json({ error: "not_found" }, 404);
  const row = data as { event_id: string; storage_path: string };

  const found = await loadDriverEvent(row.event_id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  const { data: signed, error: signErr } = await supabase.storage
    .from(DOC_BUCKET)
    .createSignedUrl(row.storage_path, 3600);
  if (signErr || !signed) {
    console.error("[GET /v1/driver/documents/:id/url] sign:", signErr);
    return c.json({ error: "sign_failed", detail: signErr?.message }, 500);
  }
  return c.json({ url: signed.signedUrl });
});

// ─────────────────────────────────────────────────────────────────────────
// Live truck location for a load (Motive ELD lookup)
// ─────────────────────────────────────────────────────────────────────────

interface MotiveLocation { description: string; lat: number; lon: number; locatedAt: string; }

// Per-org cache for Motive lookups. One bulk fetch returns every
// vehicle in the org, so the rate is bounded by 1 Motive request per
// TTL regardless of how many drivers are polling at once. Dropped
// from 10 min to 60s — 'view assigned truck' is a real-time use case
// and 10-min-old coords were too stale for drivers to trust.
//
// 60s × 60 = 60 Motive requests / hour / org. Well inside Motive's
// rate limits on all tiers; Motive itself only updates the
// underlying ping every few seconds anyway.
const motiveCache = new Map<string, { locations: Map<string, MotiveLocation>; fetchedAt: number }>();
const MOTIVE_CACHE_TTL_MS = 60 * 1000;

async function fetchMotiveLocations(orgId: string, force = false): Promise<Map<string, MotiveLocation>> {
  const cached = motiveCache.get(orgId);
  if (!force && cached && Date.now() - cached.fetchedAt < MOTIVE_CACHE_TTL_MS) return cached.locations;

  const { data: settingsRow } = await supabase
    .from("org_settings")
    .select("motive_api_key")
    .eq("org_id", orgId)
    .maybeSingle();
  const apiKey = (settingsRow as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) {
    const empty = new Map<string, MotiveLocation>();
    motiveCache.set(orgId, { locations: empty, fetchedAt: Date.now() });
    return empty;
  }

  try {
    const res = await fetch("https://api.keeptruckin.com/v1/vehicle_locations?per_page=50", {
      headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`Motive ${res.status}`);
    const json = await res.json() as {
      vehicles?: Array<{ vehicle: { id: number; current_location: { description: string; lat: number; lon: number; located_at: string } | null } }>;
    };
    const map = new Map<string, MotiveLocation>();
    for (const v of json.vehicles ?? []) {
      const cl = v.vehicle.current_location;
      if (cl) map.set(String(v.vehicle.id), {
        description: cl.description, lat: cl.lat, lon: cl.lon, locatedAt: cl.located_at,
      });
    }
    motiveCache.set(orgId, { locations: map, fetchedAt: Date.now() });
    return map;
  } catch (err) {
    console.warn("[driver/motive] fetch failed:", err);
    return cached?.locations ?? new Map();
  }
}

// GET /v1/driver/loads/:id/truck-location — current Motive position +
// asset color for the load's bound vehicle. Returns 404 silently when
// the asset has no Motive vehicle id, no location, or the org doesn't
// have a Motive API key configured.
//
// Query params:
//   ?force=true — skip the per-org Motive cache and hit Motive directly.
//                 Used by the driver app's manual "refresh location"
//                 button so the driver can force-fetch the latest ping
//                 if the cached value looks too stale.
driver.get("/loads/:id/truck-location", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id = c.req.param("id");
  const force = new URL(c.req.url).searchParams.get("force") === "true";

  const found = await loadDriverEvent(id, driverId, orgId);
  if (!found || found.row === null) return c.json({ error: "forbidden" }, 403);

  // Get the asset_id off the event, then look up its motive_vehicle_id + color.
  const { data: ev } = await supabase
    .from("events")
    .select("asset_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const assetId = (ev as { asset_id: number } | null)?.asset_id;
  if (!assetId) return c.json({ error: "not_found" }, 404);

  const { data: asset } = await supabase
    .from("assets")
    .select("motive_vehicle_id, color")
    .eq("id", assetId)
    .maybeSingle();
  const assetRow = asset as { motive_vehicle_id: string | null; color: string | null } | null;
  const vehicleId = assetRow?.motive_vehicle_id;
  if (!vehicleId) return c.json({ error: "not_found" }, 404);

  const locations = await fetchMotiveLocations(orgId, force);
  const loc = locations.get(vehicleId);
  if (!loc) return c.json({ error: "not_found" }, 404);

  return c.json({
    lat:         loc.lat,
    lon:         loc.lon,
    locatedAt:   loc.locatedAt,
    description: loc.description,
    color:       assetRow?.color ?? null,
  });
});

// POST /v1/driver/events/:id/trailer-dropoff — pickup-leg driver
// stores their phone's GPS coords as the actual trailer-drop location
// at a relay handoff. The delivery-leg driver reads this back via the
// partnerTrailerDropoff* fields on their load detail.
//
// Body: { lat: number, lng: number }
//
// Authorization: the event must be assigned to the calling driver
// AND have relay_role='pickup' — delivery-leg drivers can't save a
// dropoff because they're not the one dropping anything. Non-relay
// events get the same forbidden response; this endpoint is
// relay-pickup-only.
driver.post("/events/:id/trailer-dropoff", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: "validation_failed", errors: ["lat and lng required (numbers)"] }, 400);
  }

  // Verify the event belongs to this driver + is a relay pickup leg.
  const { data: ev } = await supabase
    .from("events")
    .select("id, driver_id, relay_role")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const evRow = ev as { id: string; driver_id: number | null; relay_role: string | null } | null;
  if (!evRow) return c.json({ error: "not_found" }, 404);
  if (evRow.driver_id !== driverId) return c.json({ error: "forbidden" }, 403);
  if (evRow.relay_role !== "pickup") {
    return c.json({ error: "not_relay_pickup", detail: "Trailer dropoff is only saved on relay pickup legs." }, 400);
  }

  const now = new Date().toISOString();
  const { error: upErr } = await supabase
    .from("events")
    .update({
      trailer_dropoff_lat: lat,
      trailer_dropoff_lng: lng,
      trailer_dropoff_at:  now,
    } as never)
    .eq("id", id)
    .eq("org_id", orgId);
  if (upErr) {
    console.error("[POST /v1/driver/events/:id/trailer-dropoff] update:", upErr);
    return c.json({ error: "update_failed", detail: upErr.message }, 500);
  }

  return c.json({
    trailerDropoffLat: lat,
    trailerDropoffLng: lng,
    trailerDropoffAt:  now,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fuel reports — driver-side surface. Submit + list-mine.
//
// driver_id and submitted_by are forced from the auth context; the
// driver can't post on behalf of another driver. Dispatch's surface
// for cross-driver views lives at /v1/fuel-reports (Clerk auth).
// ─────────────────────────────────────────────────────────────────────────

interface FuelReportRowDriver {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number;
  reported_at:    string;
  state:          string;
  latitude:       number | null;
  longitude:      number | null;
  diesel_gallons: number;
  def_gallons:    number | null;
  odometer:       number | null;
  transaction_id: string | null;
  match_status:   string;
  submitted_by:   string;
  notes:          string | null;
  created_at:     string;
}

const FUEL_REPORT_COLS =
  "id,org_id,driver_id,asset_id,reported_at,state,latitude,longitude," +
  "diesel_gallons,def_gallons,odometer,transaction_id,match_status," +
  "submitted_by,notes,created_at";

function rowToFuelReportDriver(r: FuelReportRowDriver) {
  return {
    id:            r.id,
    orgId:         r.org_id,
    driverId:      r.driver_id,
    assetId:       r.asset_id,
    reportedAt:    r.reported_at,
    state:         r.state,
    latitude:      r.latitude  ?? undefined,
    longitude:     r.longitude ?? undefined,
    dieselGallons: Number(r.diesel_gallons),
    defGallons:    r.def_gallons != null ? Number(r.def_gallons) : undefined,
    odometer:      r.odometer ?? undefined,
    transactionId: r.transaction_id ?? undefined,
    matchStatus:   r.match_status,
    submittedBy:   r.submitted_by,
    notes:         r.notes ?? undefined,
    createdAt:     r.created_at,
  };
}

// POST /v1/driver/fuel-reports — driver submits a fuel-up
driver.post("/fuel-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  if (!(await orgHasAnyModule(orgId, "fuel"))) {
    return c.json({ error: "module_disabled", detail: "Fuel reporting is not enabled for this org." }, 403);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const errors: string[] = [];
  const assetId       = Number(body.assetId);
  const dieselGallons = Number(body.dieselGallons);
  if (!Number.isFinite(assetId)) errors.push("assetId required");
  if (!Number.isFinite(dieselGallons) || dieselGallons <= 0) errors.push("dieselGallons must be > 0");
  const stateRaw = typeof body.state === "string" ? body.state.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(stateRaw)) errors.push("state must be 2-letter US abbreviation");
  if (body.defGallons != null) {
    const v = Number(body.defGallons);
    if (!Number.isFinite(v) || v < 0) errors.push("defGallons must be >= 0");
  }
  if (body.odometer != null) {
    const v = Number(body.odometer);
    if (!Number.isInteger(v) || v < 0) errors.push("odometer must be a non-negative integer");
  }
  if (errors.length) return c.json({ error: "validation_failed", errors }, 400);

  // Defensive: make sure the asset belongs to this org. The DB FK
  // guarantees the asset row exists, but not that it's in our org.
  const { data: assetRow } = await supabase
    .from("assets")
    .select("id")
    .eq("id", assetId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!assetRow) return c.json({ error: "asset_not_found" }, 404);

  const insertRow = {
    org_id:         orgId,
    driver_id:      driverId,
    asset_id:       assetId,
    reported_at:    typeof body.reportedAt === "string" ? body.reportedAt : new Date().toISOString(),
    state:          stateRaw,
    latitude:       typeof body.latitude  === "number" ? body.latitude  : null,
    longitude:      typeof body.longitude === "number" ? body.longitude : null,
    diesel_gallons: dieselGallons,
    def_gallons:    body.defGallons != null ? Number(body.defGallons) : null,
    odometer:       body.odometer    != null ? Number(body.odometer)   : null,
    notes:          typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
    submitted_by:   `driver:${driverId}`,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_reports")
    .insert(insertRow as any)
    .select(FUEL_REPORT_COLS)
    .single();
  if (error || !data) {
    console.error("[POST /v1/driver/fuel-reports] insert failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ fuelReport: rowToFuelReportDriver(data as unknown as FuelReportRowDriver) });
});

// ─────────────────────────────────────────────────────────────────────────
// Maintenance reports — driver-side surface.
//
//   POST /v1/driver/maintenance-reports         — submit
//   POST /v1/driver/maintenance-reports/:id/photos — upload photo
//   GET  /v1/driver/maintenance-reports/mine    — driver's own history
//   GET  /v1/driver/maintenance-reports/history — recent reports on a
//                                                  specific asset/trailer,
//                                                  any driver in the org
// ─────────────────────────────────────────────────────────────────────────

interface MaintReportRowDriver {
  id:             string;
  org_id:         string;
  driver_id:      number;
  asset_id:       number | null;
  trailer_id:     number | null;
  description:    string;
  reported_at:    string;
  latitude:       number | null;
  longitude:      number | null;
  state:          string | null;
  status:         string;
  action_item_id: string | null;
  submitted_by:   string;
  created_at:     string;
}

const MAINT_REPORT_COLS_DRIVER =
  "id,org_id,driver_id,asset_id,trailer_id,description,reported_at," +
  "latitude,longitude,state,status,action_item_id,submitted_by,created_at";

const MAINT_PHOTO_BUCKET_DRIVER = "maintenance-photos";

function rowToMaintReportDriver(r: MaintReportRowDriver) {
  return {
    id:           r.id,
    orgId:        r.org_id,
    driverId:     r.driver_id,
    assetId:      r.asset_id   ?? undefined,
    trailerId:    r.trailer_id ?? undefined,
    description:  r.description,
    reportedAt:   r.reported_at,
    latitude:     r.latitude   ?? undefined,
    longitude:    r.longitude  ?? undefined,
    state:        r.state      ?? undefined,
    status:       r.status,
    actionItemId: r.action_item_id ?? undefined,
    submittedBy:  r.submitted_by,
    createdAt:    r.created_at,
  };
}

interface MaintPhotoRowDriver {
  id:           string;
  report_id:    string;
  storage_path: string;
  file_name:    string;
  mime_type:    string | null;
  size_bytes:   number | null;
  uploaded_at:  string;
}

/**
 * Fetch maintenance_report_photos for every reportId in `ids` and
 * mint signed read URLs for each in a single bucket batch. Returns a
 * map keyed by reportId → photo array, ready to attach to the
 * caller's response shape. Photo URLs expire after an hour — clients
 * are expected to re-fetch the list if they outlive the TTL.
 *
 * Used by /maintenance-reports/mine and /history so drivers can
 * actually SEE the photos they (or co-drivers) attached, not just
 * see that some were uploaded.
 */
async function fetchMaintReportPhotosMap(
  ids: string[],
): Promise<Map<string, Array<{
  id: string; fileName: string; mimeType?: string; sizeBytes?: number;
  uploadedAt: string; signedUrl?: string;
}>>> {
  const out = new Map<string, Array<{
    id: string; fileName: string; mimeType?: string; sizeBytes?: number;
    uploadedAt: string; signedUrl?: string;
  }>>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("maintenance_report_photos")
    .select("id, report_id, storage_path, file_name, mime_type, size_bytes, uploaded_at")
    .in("report_id", ids)
    .order("uploaded_at", { ascending: true });
  if (error) {
    console.error("[fetchMaintReportPhotosMap] photos:", error);
    return out;
  }
  const rows = (data ?? []) as MaintPhotoRowDriver[];
  if (rows.length === 0) return out;
  const paths = rows.map(r => r.storage_path);
  const { data: signed } = await supabase.storage
    .from(MAINT_PHOTO_BUCKET_DRIVER)
    .createSignedUrls(paths, 60 * 60);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  for (const r of rows) {
    const arr = out.get(r.report_id) ?? [];
    arr.push({
      id:         r.id,
      fileName:   r.file_name,
      mimeType:   r.mime_type ?? undefined,
      sizeBytes:  r.size_bytes ?? undefined,
      uploadedAt: r.uploaded_at,
      signedUrl:  urlByPath.get(r.storage_path),
    });
    out.set(r.report_id, arr);
  }
  return out;
}

driver.post("/maintenance-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  if (!(await orgHasAnyModule(orgId, "maintenance"))) {
    return c.json({ error: "module_disabled", detail: "Maintenance reporting is not enabled for this org." }, 403);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "validation_failed", errors: ["invalid JSON"] }, 400); }

  const errors: string[] = [];
  const description = typeof body.description === 'string' ? body.description.trim() : "";
  if (!description) errors.push("description required");

  const assetId   = body.assetId   != null ? Number(body.assetId)   : null;
  const trailerId = body.trailerId != null ? Number(body.trailerId) : null;
  const hasAsset   = assetId   != null && Number.isFinite(assetId);
  const hasTrailer = trailerId != null && Number.isFinite(trailerId);
  if (hasAsset && hasTrailer)   errors.push("exactly one of assetId / trailerId");
  if (!hasAsset && !hasTrailer) errors.push("one of assetId / trailerId required");
  if (errors.length) return c.json({ error: "validation_failed", errors }, 400);

  // Defensive: confirm the asset/trailer is in this org so the driver
  // can't reach into another org's records via a guessed id.
  if (hasAsset) {
    const { data: row } = await supabase
      .from("assets").select("id").eq("id", assetId!).eq("org_id", orgId).maybeSingle();
    if (!row) return c.json({ error: "asset_not_found" }, 404);
  } else {
    const { data: row } = await supabase
      .from("trailers").select("id").eq("id", trailerId!).eq("org_id", orgId).maybeSingle();
    if (!row) return c.json({ error: "trailer_not_found" }, 404);
  }

  // Step-3 of the inspection flow files reports for failed items, tagged
  // source='inspection' and linked back to the originating inspection + item
  // so the known-damage view can dedupe and the web queue can badge them.
  const fromInspection = body.source === 'inspection';
  const inspectionReportId = fromInspection && typeof body.inspectionReportId === 'string'
    ? body.inspectionReportId : null;
  const inspectionItemId = fromInspection && typeof body.inspectionItemId === 'string'
    ? body.inspectionItemId : null;
  // Verify the linked inspection is this driver's, in this org — don't let a
  // client forge a link to someone else's report.
  if (inspectionReportId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: insp } = await (supabase as any)
      .from("inspection_reports")
      .select("id")
      .eq("id", inspectionReportId).eq("org_id", orgId).eq("driver_id", driverId)
      .maybeSingle();
    if (!insp) return c.json({ error: "inspection_not_found" }, 404);
  }

  const insertRow = {
    org_id:       orgId,
    driver_id:    driverId,
    asset_id:     hasAsset   ? assetId   : null,
    trailer_id:   hasTrailer ? trailerId : null,
    description,
    reported_at:  typeof body.reportedAt === 'string' ? body.reportedAt : new Date().toISOString(),
    latitude:     typeof body.latitude  === 'number' ? body.latitude  : null,
    longitude:    typeof body.longitude === 'number' ? body.longitude : null,
    state:        typeof body.state     === 'string' && body.state.trim()
                    ? body.state.trim().toUpperCase() : null,
    submitted_by: `driver:${driverId}`,
    source:               fromInspection ? 'inspection' : 'driver',
    inspection_report_id: inspectionReportId,
    inspection_item_id:   inspectionItemId,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_reports")
    .insert(insertRow as any)
    .select(MAINT_REPORT_COLS_DRIVER)
    .single();
  if (error || !data) {
    console.error("[POST /v1/driver/maintenance-reports] failed:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ report: rowToMaintReportDriver(data as unknown as MaintReportRowDriver) });
});

// Photo upload — multipart. One file per request to keep the wire
// shape simple from React Native; the driver app loops over selected
// photos and posts each.
driver.post("/maintenance-reports/:id/photos", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // Confirm the report exists in this org AND belongs to this driver
  // (drivers can only attach photos to their own reports).
  const { data: rep, error: repErr } = await supabase
    .from("maintenance_reports")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (repErr) return c.json({ error: "fetch_failed", detail: repErr.message }, 500);
  if (!rep) return c.json({ error: "not_found" }, 404);
  if ((rep as { driver_id: number }).driver_id !== driverId) {
    return c.json({ error: "not_authorized" }, 403);
  }

  let body: { file?: File };
  try { body = await c.req.parseBody() as { file?: File }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }
  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }

  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;
  {
    const conv = await convertIfHeic(file, bytes);
    if ("failed" in conv) return c.json(HEIC_DECODE_FAILED, 415);
    bytes = conv.bytes; uploadName = conv.name; uploadMime = conv.mime;
  }
  const ext = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(MAINT_PHOTO_BUCKET_DRIVER)
    .upload(storagePath, bytes, {
      contentType: uploadMime || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST .../photos] storage:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("maintenance_report_photos")
    .insert({
      report_id:    id,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    uploadMime || null,
      size_bytes:   bytes.length,
    } as any)
    .select("id, file_name, mime_type, size_bytes, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(MAINT_PHOTO_BUCKET_DRIVER).remove([storagePath]);
    console.error("[POST .../photos] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ photo: data });
});

driver.get("/maintenance-reports/mine", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url      = new URL(c.req.url);
  const limit    = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);
  const { data, error } = await supabase
    .from("maintenance_reports")
    .select(MAINT_REPORT_COLS_DRIVER)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  const rows = (data ?? []) as unknown as MaintReportRowDriver[];
  const photosByReport = await fetchMaintReportPhotosMap(rows.map(r => r.id));
  return c.json({
    reports: rows.map(r => ({
      ...rowToMaintReportDriver(r),
      photos: photosByReport.get(r.id) ?? [],
    })),
  });
});

// History on a SPECIFIC asset/trailer, regardless of which driver
// filed it. Used by the driver app's "what's already been reported on
// this truck" rail — so the next driver doesn't duplicate.
driver.get("/maintenance-reports/history", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);
  const assetRaw   = url.searchParams.get("assetId");
  const trailerRaw = url.searchParams.get("trailerId");
  const limit      = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 50);

  const hasAsset   = assetRaw && Number.isFinite(Number(assetRaw));
  const hasTrailer = trailerRaw && Number.isFinite(Number(trailerRaw));
  if (hasAsset === hasTrailer) {
    return c.json({ error: "validation_failed", errors: ["exactly one of assetId / trailerId"] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = supabase
    .from("maintenance_reports")
    .select(MAINT_REPORT_COLS_DRIVER)
    .eq("org_id", orgId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (hasAsset)   q = q.eq("asset_id",   Number(assetRaw));
  if (hasTrailer) q = q.eq("trailer_id", Number(trailerRaw));

  const { data, error } = await q;
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  const rows = (data ?? []) as MaintReportRowDriver[];
  const photosByReport = await fetchMaintReportPhotosMap(rows.map(r => r.id));
  return c.json({
    reports: rows.map(r => ({
      ...rowToMaintReportDriver(r),
      photos: photosByReport.get(r.id) ?? [],
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Truck History module (Curzon-only, gated by TRUCK_HISTORY_ORG_IDS).
//   GET /v1/driver/equipment/:kind/:id/history
// Aggregates, for one truck or trailer: recent driver events (who drove it),
// known damage (open action items + un-converted open reports, with photos),
// recent inspection defects (last 30d + failed-item photos), and the last
// post-trip cleanliness photo. Read-only; everything comes from tables the
// org already writes to.
// ─────────────────────────────────────────────────────────────────────────

type PhotoOut = { id: string; fileName?: string; caption?: string | null; itemId?: string | null; uploadedAt: string; signedUrl?: string };

async function signPathsMap(bucket: string): Promise<(paths: string[]) => Promise<Map<string, string>>> {
  return async (paths: string[]) => {
    const map = new Map<string, string>();
    if (paths.length === 0) return map;
    const { data } = await supabase.storage.from(bucket).createSignedUrls(paths, 60 * 60);
    for (const s of (data ?? []) as Array<{ path: string; signedUrl: string }>) map.set(s.path, s.signedUrl);
    return map;
  };
}

async function fetchActionItemPhotosMapDriver(ids: string[]): Promise<Map<string, PhotoOut[]>> {
  const out = new Map<string, PhotoOut[]>();
  if (ids.length === 0) return out;
  const { data } = await supabase
    .from("maintenance_action_item_photos")
    .select("id, action_item_id, storage_path, file_name, uploaded_at")
    .in("action_item_id", ids)
    .order("uploaded_at", { ascending: true });
  const rows = (data ?? []) as Array<{ id: string; action_item_id: string; storage_path: string; file_name: string; uploaded_at: string }>;
  const urlByPath = await (await signPathsMap(MAINT_PHOTO_BUCKET_DRIVER))(rows.map(r => r.storage_path));
  for (const r of rows) {
    const arr = out.get(r.action_item_id) ?? [];
    arr.push({ id: r.id, fileName: r.file_name, uploadedAt: r.uploaded_at, signedUrl: urlByPath.get(r.storage_path) });
    out.set(r.action_item_id, arr);
  }
  return out;
}

async function fetchInspectionPhotosMap(ids: string[]): Promise<Map<string, PhotoOut[]>> {
  const out = new Map<string, PhotoOut[]>();
  if (ids.length === 0) return out;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from("inspection_photos")
    .select("id, report_id, item_id, caption, storage_path, uploaded_at")
    .in("report_id", ids)
    .order("uploaded_at", { ascending: true });
  const rows = (data ?? []) as Array<{ id: string; report_id: string; item_id: string | null; caption: string | null; storage_path: string; uploaded_at: string }>;
  const urlByPath = await (await signPathsMap("inspection-photos"))(rows.map(r => r.storage_path));
  for (const r of rows) {
    const arr = out.get(r.report_id) ?? [];
    arr.push({ id: r.id, itemId: r.item_id ?? null, caption: r.caption ?? null, uploadedAt: r.uploaded_at, signedUrl: urlByPath.get(r.storage_path) });
    out.set(r.report_id, arr);
  }
  return out;
}

driver.get("/equipment/:kind/:id/history", async (c) => {
  const orgId = c.get("orgId");
  if (!isTruckHistoryOrg(orgId)) return c.json({ error: "not_found" }, 404);
  const kind = c.req.param("kind");
  const id   = Number(c.req.param("id"));
  if ((kind !== "asset" && kind !== "trailer") || !Number.isFinite(id)) {
    return c.json({ error: "validation_failed", errors: ["kind must be asset|trailer and id numeric"] }, 400);
  }
  const col = kind === "asset" ? "asset_id" : "trailer_id";
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  // 1) Recent drivers who have ACTUALLY driven this equipment: events that
  //    have already started (start <= now — excludes future/scheduled trips)
  //    and have a named driver (an unassigned event isn't a driver). Newest
  //    first, capped at 5.
  const nowIso = new Date().toISOString();
  const { data: evRows } = await sb
    .from("events")
    .select("id, driver_name, start, end, status, title, load:loads(load_num, internal_load_id)")
    .eq("org_id", orgId).eq(col, id).is("deleted_at", null)
    .not("driver_name", "is", null)
    .lte("start", nowIso)
    .order("start", { ascending: false }).limit(5);
  const recentEvents = ((evRows ?? []) as Array<Record<string, unknown>>)
    // Defensive: drop blank driver names the `is null` filter can't catch.
    .filter((e) => typeof e.driver_name === "string" && e.driver_name.trim() !== "")
    .map((e) => {
    const l = Array.isArray(e.load) ? (e.load[0] ?? null) : (e.load ?? null);
    return {
      id: e.id, driverName: (e.driver_name as string | null) ?? null,
      start: e.start, end: e.end, status: e.status, title: e.title,
      loadNum: (l as { load_num?: string } | null)?.load_num ?? null,
      internalLoadId: (l as { internal_load_id?: number } | null)?.internal_load_id ?? null,
    };
  });

  // 2) Known damage: open action items (ops-confirmed) + un-converted open
  //    reports (pending). Deduped — a report with an action item is
  //    represented by that action item, so we only pull action_item_id IS NULL.
  const [aiRes, repRes] = await Promise.all([
    sb.from("maintenance_action_items")
      .select("id, title, description, priority, status, out_of_service, created_at")
      .eq("org_id", orgId).eq(col, id).in("status", ["open", "in_progress"])
      .order("created_at", { ascending: false }),
    sb.from("maintenance_reports")
      .select("id, description, status, reported_at, source, inspection_item_id")
      .eq("org_id", orgId).eq(col, id).is("action_item_id", null).in("status", ["open", "reviewed"])
      .order("reported_at", { ascending: false }),
  ]);
  const actionItems = (aiRes.data ?? []) as Array<Record<string, unknown>>;
  const pendingReports = (repRes.data ?? []) as Array<Record<string, unknown>>;
  const [aiPhotos, repPhotos] = await Promise.all([
    fetchActionItemPhotosMapDriver(actionItems.map((a) => a.id as string)),
    fetchMaintReportPhotosMap(pendingReports.map((r) => r.id as string)),
  ]);
  const knownDamage = [
    ...actionItems.map((a) => ({
      source: "action_item" as const, id: a.id, title: a.title, description: (a.description as string | null) ?? null,
      priority: a.priority, status: a.status, outOfService: !!a.out_of_service,
      reportedAt: a.created_at, fromInspection: false, photos: aiPhotos.get(a.id as string) ?? [],
    })),
    ...pendingReports.map((r) => ({
      source: "report" as const, id: r.id, title: null, description: r.description,
      priority: null, status: r.status, outOfService: false,
      reportedAt: r.reported_at, fromInspection: r.source === "inspection", photos: repPhotos.get(r.id as string) ?? [],
    })),
  ];

  // 3) Recent inspection defects (last 30 days) + failed-item photos.
  const { data: inspRows } = await sb
    .from("inspection_reports")
    .select("id, kind, inspection_date, signed_by, items, trailer_items, cleanliness_flagged")
    .eq("org_id", orgId).eq(col, id).eq("has_defects", true)
    .gte("inspection_date", thirtyDaysAgo)
    .order("inspection_date", { ascending: false }).limit(30);
  const inspections = (inspRows ?? []) as Array<Record<string, unknown>>;
  const inspPhotos = await fetchInspectionPhotosMap(inspections.map((i) => i.id as string));
  const recentInspectionDefects = inspections.map((i) => {
    const all = [...((i.items as Array<{ id: string; label: string; section: string; status: string; notes?: string }>) ?? []),
                 ...((i.trailer_items as Array<{ id: string; label: string; section: string; status: string; notes?: string }>) ?? [])];
    // Cleanliness is its own category (surfaced by cleanliness_flagged + the
    // last-cleanliness-photo), NOT a mechanical inspection defect — exclude it.
    const failed = all.filter((it) => it.status === "fail" && it.id !== "cleanliness")
      .map((it) => ({ id: it.id, label: it.label, section: it.section, notes: it.notes ?? null }));
    return {
      id: i.id, kind: i.kind, date: i.inspection_date, signedBy: i.signed_by,
      cleanlinessFlagged: !!i.cleanliness_flagged, failedItems: failed,
      // Cleanliness photos belong to the left-dirty surface, not the defect card.
      photos: (inspPhotos.get(i.id as string) ?? []).filter((p) => p.itemId !== "cleanliness"),
    };
  // Drop inspections whose only "defect" was cleanliness — they're not
  // mechanical defects and belong to the left-dirty surface instead.
  }).filter((d) => d.failedItems.length > 0);

  // 4) Most recent cab cleanliness photo across ANY inspection kind (pre or
  //    post). It's a photo of the cab's condition regardless of when taken, and
  //    it must SURVIVE a later inspection that had no photo (clean cab) — so we
  //    look photo-first over the recent inspections rather than at a single
  //    latest report.
  let lastCleanlinessPhoto: { signedUrl?: string; uploadedAt: string; date: string; signedBy: string } | null = null;
  const { data: recentInsp } = await sb
    .from("inspection_reports")
    .select("id, inspection_date, signed_by")
    .eq("org_id", orgId).eq(col, id)
    .order("inspection_date", { ascending: false }).order("submitted_at", { ascending: false })
    .limit(30);
  const cleanInspRows = (recentInsp ?? []) as Array<{ id: string; inspection_date: string; signed_by: string }>;
  if (cleanInspRows.length) {
    const inspById = new Map(cleanInspRows.map((r) => [r.id, r]));
    const { data: cps } = await sb
      .from("inspection_photos")
      .select("report_id, storage_path, uploaded_at")
      .in("report_id", cleanInspRows.map((r) => r.id)).eq("item_id", "cleanliness")
      .order("uploaded_at", { ascending: false }).limit(1);
    const cp = ((cps ?? []) as Array<{ report_id: string; storage_path: string; uploaded_at: string }>)[0];
    if (cp) {
      const insp = inspById.get(cp.report_id);
      const urlByPath = await (await signPathsMap("inspection-photos"))([cp.storage_path]);
      lastCleanlinessPhoto = {
        signedUrl: urlByPath.get(cp.storage_path), uploadedAt: cp.uploaded_at,
        date: insp?.inspection_date ?? cp.uploaded_at.slice(0, 10), signedBy: insp?.signed_by ?? "",
      };
    }
  }

  return c.json({ recentEvents, knownDamage, recentInspectionDefects, lastCleanlinessPhoto });
});

// ─────────────────────────────────────────────────────────────────────────
// Driver documents — driver self-service.
//   POST /v1/driver/documents       — upload (multipart: file + kind)
//   GET  /v1/driver/documents       — list mine
//   DELETE /v1/driver/documents/:id — remove mine
// The ops surface (/v1/drivers/:id/documents) writes to the same table.
// ─────────────────────────────────────────────────────────────────────────

const DRIVER_DOC_BUCKET_SELF = "driver-documents";
const DRIVER_DOC_KINDS_SELF = ['license','medical_card','mvr','other'] as const;
type DriverDocKindSelf = typeof DRIVER_DOC_KINDS_SELF[number];

interface DriverDocRowSelf {
  id:           string;
  org_id:       string;
  driver_id:    number;
  kind:         string;
  storage_path: string;
  file_name:    string;
  mime_type:    string | null;
  size_bytes:   number | null;
  expires_on:   string | null;
  notes:        string | null;
  uploaded_at:  string;
  uploaded_by:  string;
}

const DRIVER_DOC_COLS_SELF =
  "id,org_id,driver_id,kind,storage_path,file_name,mime_type,size_bytes," +
  "expires_on,notes,uploaded_at,uploaded_by";

function rowToDriverDocSelf(r: DriverDocRowSelf, signedUrl?: string) {
  return {
    id:         r.id,
    orgId:      r.org_id,
    driverId:   r.driver_id,
    kind:       r.kind as DriverDocKindSelf,
    fileName:   r.file_name,
    mimeType:   r.mime_type ?? undefined,
    sizeBytes:  r.size_bytes ?? undefined,
    expiresOn:  r.expires_on ?? undefined,
    notes:      r.notes ?? undefined,
    uploadedAt: r.uploaded_at,
    uploadedBy: r.uploaded_by,
    signedUrl,
  };
}

driver.post("/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  let body: { file?: File; kind?: string; expiresOn?: string; notes?: string };
  try { body = await c.req.parseBody() as typeof body; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }

  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }
  const kind = (body.kind ?? "other").toString() as DriverDocKindSelf;
  if (!(DRIVER_DOC_KINDS_SELF as readonly string[]).includes(kind)) {
    return c.json({ error: "validation_failed", errors: [`kind must be one of ${DRIVER_DOC_KINDS_SELF.join("|")}`] }, 400);
  }

  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;
  {
    const conv = await convertIfHeic(file, bytes);
    if ("failed" in conv) return c.json(HEIC_DECODE_FAILED, 415);
    bytes = conv.bytes; uploadName = conv.name; uploadMime = conv.mime;
  }
  const ext  = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${driverId}/${kind}_${Date.now()}_${rand}.${ext}`;

  const { error: upErr } = await supabase.storage
    .from(DRIVER_DOC_BUCKET_SELF)
    .upload(storagePath, bytes, {
      contentType: uploadMime || "application/octet-stream",
      upsert: false,
    });
  if (upErr) {
    console.error("[POST /v1/driver/documents] storage:", upErr);
    return c.json({ error: "upload_failed", detail: upErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("driver_documents")
    .insert({
      org_id:       orgId,
      driver_id:    driverId,
      kind,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    uploadMime || null,
      size_bytes:   bytes.length,
      expires_on:   body.expiresOn?.trim() || null,
      notes:        body.notes?.trim() || null,
      uploaded_by:  `driver:${driverId}`,
    } as any)
    .select(DRIVER_DOC_COLS_SELF)
    .single();
  if (error || !data) {
    void supabase.storage.from(DRIVER_DOC_BUCKET_SELF).remove([storagePath]);
    console.error("[POST /v1/driver/documents] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET_SELF).createSignedUrl(storagePath, 3600);
  return c.json({ document: rowToDriverDocSelf(data as unknown as DriverDocRowSelf, signed?.signedUrl) });
});

driver.get("/documents", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const { data, error } = await supabase
    .from("driver_documents")
    .select(DRIVER_DOC_COLS_SELF)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("uploaded_at", { ascending: false });
  if (error) return c.json({ error: "fetch_failed", detail: error.message }, 500);
  const rows = (data ?? []) as unknown as DriverDocRowSelf[];
  if (rows.length === 0) return c.json({ documents: [] });

  const paths = rows.map(r => r.storage_path);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: signed } = await supabase.storage.from(DRIVER_DOC_BUCKET_SELF).createSignedUrls(paths, 3600);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as Array<{ path: string; signedUrl: string }>) {
    urlByPath.set(s.path, s.signedUrl);
  }
  return c.json({
    documents: rows.map(r => rowToDriverDocSelf(r, urlByPath.get(r.storage_path))),
  });
});

driver.delete("/documents/:id", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // Ownership check + path lookup in one round trip.
  const { data } = await supabase
    .from("driver_documents")
    .select("storage_path, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const row = data as { storage_path: string; driver_id: number } | null;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.driver_id !== driverId) return c.json({ error: "not_authorized" }, 403);

  const { error } = await supabase
    .from("driver_documents")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId);
  if (error) return c.json({ error: "delete_failed", detail: error.message }, 500);
  void supabase.storage.from(DRIVER_DOC_BUCKET_SELF).remove([row.storage_path]);
  return c.json({ ok: true });
});

// POST /v1/driver/fuel-reports/:id/photos — upload a receipt photo.
// One file per request (keeps RN FormData simple). Driver can only
// attach to their own reports.
const FUEL_RECEIPT_BUCKET = "fuel-receipts";
driver.post("/fuel-reports/:id/photos", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  const { data: rep, error: repErr } = await supabase
    .from("fuel_reports")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (repErr) return c.json({ error: "fetch_failed", detail: repErr.message }, 500);
  if (!rep) return c.json({ error: "not_found" }, 404);
  if ((rep as { driver_id: number }).driver_id !== driverId) {
    return c.json({ error: "not_authorized" }, 403);
  }

  let body: { file?: File };
  try { body = await c.req.parseBody() as { file?: File }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }
  const file = body.file;
  if (!file || typeof file === "string") {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }

  const ext  = (file.name.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;
  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;
  {
    const conv = await convertIfHeic(file, bytes);
    if ("failed" in conv) return c.json(HEIC_DECODE_FAILED, 415);
    bytes = conv.bytes; uploadName = conv.name; uploadMime = conv.mime;
  }

  const { error: uploadErr } = await supabase.storage
    .from(FUEL_RECEIPT_BUCKET)
    .upload(storagePath, bytes, {
      contentType: uploadMime || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST fuel/photos] storage:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase
    .from("fuel_report_photos")
    .insert({
      report_id:    id,
      org_id:       orgId,
      storage_path: storagePath,
      file_name:    file.name,
      mime_type:    uploadMime || null,
      size_bytes:   bytes.length,
    } as any)
    .select("id, file_name, mime_type, size_bytes, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(FUEL_RECEIPT_BUCKET).remove([storagePath]);
    console.error("[POST fuel/photos] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ photo: data });
});

// GET /v1/driver/fuel-reports — the driver's own submission history.
// Useful for the "my recent submissions" rail on the form screen.
driver.get("/fuel-reports", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const url      = new URL(c.req.url);
  const limit    = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);

  const { data, error } = await supabase
    .from("fuel_reports")
    .select(FUEL_REPORT_COLS)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .order("reported_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[GET /v1/driver/fuel-reports] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  return c.json({
    fuelReports: (data ?? []).map(r => rowToFuelReportDriver(r as unknown as FuelReportRowDriver)),
  });
});

// ─── Inspections (DVIR) ───────────────────────────────────────────────
//
// Drivers submit one or more inspection reports per day — usually a
// pre-trip first thing in the morning, plus another whenever they
// switch equipment. The schedule-tab card states (red / green) are
// derived from /today.

interface InspectionItem {
  id:      string;
  section: string;
  label:   string;
  status:  "pass" | "fail" | "na";
  notes?:  string;
}

interface InspectionBody {
  assetId?:        number | null;
  trailerId?:      number | null;
  /** Pre-trip (default, and what every existing single daily DVIR was) or
   *  post-trip. Post-trip is the end-of-shift condition/cleanliness pass. */
  kind?:           "pre_trip" | "post_trip";
  items:           InspectionItem[];
  trailerItems?:   InspectionItem[];
  notes?:          string;
  signedBy?:       string;
  durationSeconds?: number | null;
  locationLat?:    number | null;
  locationLon?:    number | null;
  /** Driver-local YYYY-MM-DD for the day this inspection covers.
   *  REQUIRED for correctness — without it the server falls back to
   *  UTC date which off-by-ones any submission after the driver's
   *  local 7pm-ish (when UTC has already rolled to tomorrow). New
   *  clients always send it; older clients omit it and the server
   *  fall-back kicks in. */
  inspectionDate?: string;
}

driver.post("/inspections", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  if (!(await orgHasAnyModule(orgId, "fuel", "maintenance"))) {
    return c.json({ error: "module_disabled", detail: "Inspections are not enabled for this org." }, 403);
  }
  let body: InspectionBody;
  try {
    body = await c.req.json() as InspectionBody;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (body.assetId == null && body.trailerId == null) {
    return c.json({ error: "validation_failed", errors: ["Pick a truck and/or trailer to inspect."] }, 400);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: "validation_failed", errors: ["At least one checklist item is required."] }, 400);
  }

  const allItems = [...(body.items ?? []), ...(body.trailerItems ?? [])];
  // Cleanliness is its own category (tracked via cleanliness_flagged), not a
  // mechanical defect — a dirty cab alone must NOT mark the inspection as
  // having defects (which would flag it red in the grid + defect lists).
  const hasDefects = allItems.some(i => i.id !== "cleanliness" && i.status === "fail");
  const kind = body.kind === "post_trip" ? "post_trip" : "pre_trip";
  // Denormalized cleanliness flag — set when the "cleanliness" checklist item
  // (Condition section) is failed. Keep this id in sync with the driver app's
  // CLEANLINESS_ITEM_ID in InspectionFormScreen.
  const cleanlinessFlagged = allItems.some(i => i.id === "cleanliness" && i.status === "fail");

  // Driver-name fallback for the signature — most clients should pass
  // it explicitly, but if not, derive from the drivers row.
  let signedBy = body.signedBy?.trim();
  if (!signedBy) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("drivers")
      .select("name, first_name, last_name")
      .eq("id", driverId)
      .maybeSingle();
    const d = data as { name?: string | null; first_name?: string | null; last_name?: string | null } | null;
    signedBy = (d?.name ?? `${d?.first_name ?? ""} ${d?.last_name ?? ""}`.trim()) || "Driver";
  }

  // Inspection date: prefer the driver's local date if the client
  // sent one (YYYY-MM-DD). UTC fallback only kicks in for older
  // driver-app builds that don't send the field. Validate strictly
  // so a malformed client can't poison the date — anything that
  // doesn't match the format gets discarded and we fall through to
  // server UTC.
  const VALID_YMD = /^\d{4}-\d{2}-\d{2}$/;
  const clientDate = typeof body.inspectionDate === "string" && VALID_YMD.test(body.inspectionDate)
    ? body.inspectionDate
    : null;
  const today = clientDate ?? new Date().toISOString().slice(0, 10);

  // Sanitize duration + coords — clamp to plausible ranges so a bogus
  // client value can't poison the row. Duration capped at 24h (anything
  // longer means a stuck form, not a real inspection).
  const dur = Number.isFinite(body.durationSeconds) && body.durationSeconds! >= 0
    ? Math.min(Math.round(body.durationSeconds!), 24 * 3600)
    : null;
  const lat = Number.isFinite(body.locationLat) && Math.abs(body.locationLat!) <=  90 ? body.locationLat! : null;
  const lon = Number.isFinite(body.locationLon) && Math.abs(body.locationLon!) <= 180 ? body.locationLon! : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: saved, error } = await (supabase as any)
    .from("inspection_reports")
    .insert({
      org_id:           orgId,
      driver_id:        driverId,
      asset_id:         body.assetId    ?? null,
      trailer_id:       body.trailerId  ?? null,
      kind,
      inspection_date:  today,
      items:            body.items,
      trailer_items:    body.trailerItems ?? null,
      notes:            body.notes ?? null,
      has_defects:      hasDefects,
      cleanliness_flagged: cleanlinessFlagged,
      signed_by:        signedBy,
      duration_seconds: dur,
      location_lat:     lat,
      location_lon:     lon,
    })
    .select("id, submitted_at, has_defects, kind")
    .maybeSingle();
  if (error) {
    console.error("[POST /v1/driver/inspections] failed:", error);
    return c.json({ error: "insert_failed", detail: error.message }, 500);
  }

  return c.json({ inspection: saved });
});

// POST /v1/driver/inspections/:id/photos — upload one photo against
// an existing inspection. itemId is optional — when present, the
// photo is tied to that specific checklist row (so the dispatch view
// can show "Service brakes — fail [📷 photo]"); when absent, it's a
// general "this is the truck I inspected" photo.
//
// Pattern mirrors /maintenance-reports/:id/photos exactly so the
// driver client's upload helper is interchangeable. Bucket created
// out-of-band: `inspection-photos`.
const INSPECTION_PHOTO_BUCKET = "inspection-photos";

driver.post("/inspections/:id/photos", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = c.req.param("id");

  // Confirm the inspection exists in this org AND was filed by this
  // driver — drivers can only attach photos to their own inspections.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rep, error: repErr } = await (supabase as any)
    .from("inspection_reports")
    .select("id, driver_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (repErr) return c.json({ error: "fetch_failed", detail: repErr.message }, 500);
  if (!rep) return c.json({ error: "not_found" }, 404);
  if ((rep as { driver_id: number }).driver_id !== driverId) {
    return c.json({ error: "not_authorized" }, 403);
  }

  let body: { file?: File; itemId?: string; caption?: string; target?: string };
  try { body = await c.req.parseBody() as { file?: File; itemId?: string; caption?: string; target?: string }; }
  catch { return c.json({ error: "validation_failed", errors: ["multipart parse failed"] }, 400); }
  const file = body.file;
  if (!file || typeof file === 'string') {
    return c.json({ error: "validation_failed", errors: ["file required"] }, 400);
  }

  // target = 'truck' | 'trailer' | undefined. Reject anything else so
  // the DB check constraint never fires — failing here is a clearer
  // error than a 500 from a constraint violation. undefined → NULL so
  // legacy clients without the field still upload.
  let target: "truck" | "trailer" | null = null;
  if (body.target === "truck" || body.target === "trailer") {
    target = body.target;
  } else if (body.target != null && body.target !== "") {
    return c.json({ error: "validation_failed", errors: ["target must be 'truck' or 'trailer'"] }, 400);
  }

  let bytes      = new Uint8Array(await file.arrayBuffer());
  let uploadName = file.name;
  let uploadMime = file.type;
  {
    const conv = await convertIfHeic(file, bytes);
    if ("failed" in conv) return c.json(HEIC_DECODE_FAILED, 415);
    bytes = conv.bytes; uploadName = conv.name; uploadMime = conv.mime;
  }
  const ext = (uploadName.split(".").pop() ?? "bin").toLowerCase();
  const rand = Math.random().toString(36).slice(2, 10);
  const storagePath = `${orgId}/${id}/${Date.now()}_${rand}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(INSPECTION_PHOTO_BUCKET)
    .upload(storagePath, bytes, {
      contentType: uploadMime || "application/octet-stream",
      upsert: false,
    });
  if (uploadErr) {
    console.error("[POST /v1/driver/inspections/:id/photos] storage:", uploadErr);
    return c.json({ error: "upload_failed", detail: uploadErr.message }, 500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("inspection_photos")
    .insert({
      report_id:    id,
      item_id:      body.itemId ?? null,
      target,
      storage_path: storagePath,
      caption:      body.caption ?? null,
    })
    .select("id, item_id, target, storage_path, caption, uploaded_at")
    .single();
  if (error || !data) {
    void supabase.storage.from(INSPECTION_PHOTO_BUCKET).remove([storagePath]);
    console.error("[POST /v1/driver/inspections/:id/photos] insert:", error);
    return c.json({ error: "insert_failed", detail: error?.message }, 500);
  }
  return c.json({ photo: data });
});

driver.get("/inspections/today", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  // Accept ?date=YYYY-MM-DD from the client (driver's local day).
  // Falls back to UTC for older app builds that don't send it —
  // same off-by-one risk near midnight, but consistent with how
  // those builds wrote rows in the first place.
  const VALID_YMD = /^\d{4}-\d{2}-\d{2}$/;
  const dateParam = new URL(c.req.url).searchParams.get("date");
  const today = (dateParam && VALID_YMD.test(dateParam))
    ? dateParam
    : new Date().toISOString().slice(0, 10);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("inspection_reports")
    .select(`
      id, asset_id, trailer_id, kind, inspection_date, has_defects, submitted_at, signed_by,
      asset:assets(name, unit),
      trailer:trailers(name, trailer_number)
    `)
    .eq("org_id", orgId)
    .eq("driver_id", driverId)
    .eq("inspection_date", today)
    .order("submitted_at", { ascending: false });
  if (error) {
    console.error("[GET /v1/driver/inspections/today] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }
  return c.json({ inspections: data ?? [] });
});

// ─────────────────────────────────────────────────────────────────────────
// Safety alerts — motive_performance_events rows the DISPATCHER notified
// this driver about. The row itself is created by ingest before any
// notification happens; only rows with notified_driver_id = <this driver>
// are visible here. Message body renders only when the driver opens the
// detail, so the push notification remains a short summary.
// Severity is derived from raw.event_intensity + raw.metadata.severity
// via the shared deriveSeverity helper so the driver-app meter and the
// dispatch meter agree.
// ─────────────────────────────────────────────────────────────────────────

driver.get("/safety-alerts", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  // Fetch raw so we can derive severity server-side. Raw is stripped
  // before responding — we only expose the small severity fields the
  // meter needs, not Motive's multi-KB GPS arrays.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("motive_performance_events")
    .select(`
      id, event_type, event_time, intensity, location_label,
      asset_id, vehicle_number,
      notified_at, notified_message, notified_driver_id,
      dispute_status, disputed_at, dispute_reason,
      dispute_reviewed_at, dispute_resolution,
      raw
    `)
    .eq("org_id", orgId)
    .eq("notified_driver_id", driverId)
    .order("notified_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[GET /v1/driver/safety-alerts]", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  // Resolve fleetcal truck names — dispatchers see "CT-2026" so drivers
  // should too. Batch fetch to avoid an N+1.
  const alertRows = (data ?? []) as Array<{ asset_id: number | null }>;
  const assetIds: number[] = Array.from(new Set(
    alertRows
      .map(r => r.asset_id)
      .filter((x): x is number => x != null),
  ));
  const assetById = new Map<number, { name: string | null; unit: string | null }>();
  if (assetIds.length > 0) {
    const { data: assets } = await supabase
      .from("assets")
      .select("id, name, unit")
      .eq("org_id", orgId)
      .in("id", assetIds);
    for (const a of (assets ?? []) as Array<{ id: number; name: string | null; unit: string | null }>) {
      assetById.set(a.id, { name: a.name, unit: a.unit });
    }
  }

  const alerts = (data ?? []).map((r: {
    id: number; event_type: string; event_time: string; intensity: string | null;
    location_label: string | null; asset_id: number | null; vehicle_number: string | null;
    notified_at: string; notified_message: string | null;
    dispute_status: "none" | "pending" | "accepted" | "rejected";
    disputed_at: string | null; dispute_reason: string | null;
    dispute_reviewed_at: string | null; dispute_resolution: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any;
  }) => {
    const sev = deriveSeverity(r.raw, r.event_type);
    return {
      id:             r.id,
      event_type:     r.event_type,
      event_time:     r.event_time,
      intensity:      r.intensity,
      location_label: r.location_label,
      truck_name:     (r.asset_id != null ? assetById.get(r.asset_id)?.name : null) ?? r.vehicle_number ?? null,
      truck_unit:     r.asset_id != null ? (assetById.get(r.asset_id)?.unit ?? null) : null,
      notified_at:    r.notified_at,
      notified_message:  r.notified_message,
      severity_level:    sev.level,
      severity_score:    sev.score,
      severity_display:  sev.displayValue,
      severity_metric:   sev.metricName,
      severity_inverted: sev.isInverted,
      dispute_status:      r.dispute_status,
      disputed_at:         r.disputed_at,
      dispute_reason:      r.dispute_reason,
      dispute_reviewed_at: r.dispute_reviewed_at,
      dispute_resolution:  r.dispute_resolution,
    };
  });

  return c.json({ alerts });
});

// ── POST /v1/driver/safety-alerts/:id/dispute ─────────────────────────
//
// Driver opens an alert and challenges it. Requires the event was
// notified to THIS driver (privacy — a driver can't dispute someone
// else's alert), and that no dispute exists yet (dispute_status='none').
// Body: { reason: string }. Reason is required and stored verbatim for
// the dispatcher to review.

driver.post("/safety-alerts/:id/dispute", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");
  const id       = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);

  const body = await c.req.json().catch(() => null) as { reason?: string } | null;
  const reason = body?.reason?.trim();
  if (!reason) return c.json({ error: "reason_required" }, 400);
  if (reason.length > 1000) return c.json({ error: "reason_too_long" }, 400);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabase as any)
    .from("motive_performance_events")
    .select("id, notified_driver_id, dispute_status")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!existing) return c.json({ error: "not_found" }, 404);
  const row = existing as { notified_driver_id: number | null; dispute_status: string };
  if (row.notified_driver_id !== driverId) {
    // Same 404 (not 403) — don't leak the existence of other drivers'
    // alerts to a fishing request.
    return c.json({ error: "not_found" }, 404);
  }
  if (row.dispute_status !== "none") {
    return c.json({ error: "already_disputed", status: row.dispute_status }, 409);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error: updErr } = await (supabase as any)
    .from("motive_performance_events")
    .update({
      dispute_status: "pending",
      disputed_at:    new Date().toISOString(),
      dispute_reason: reason,
    })
    .eq("org_id", orgId)
    .eq("id", id)
    .select("id, dispute_status, disputed_at, dispute_reason")
    .maybeSingle();
  if (updErr) {
    console.error("[POST /v1/driver/safety-alerts/:id/dispute]", updErr);
    return c.json({ error: "update_failed", detail: updErr.message }, 500);
  }
  return c.json({ ok: true, event: updated });
});

// ─────────────────────────────────────────────────────────────────────────
// Safety score — 30-day rolling, calendar-attributed, scoped to the
// authed driver only.
//
// Same formula as the dispatch-side /v1/driver-safety-scoring endpoint
// (severe=25, moderate=1, low=0; recency-weighted; median-anchored) but
// only exposes THIS driver's numbers so we don't leak fleet peers'
// scores to a driver. Fleet-median penalty is used as the anchor so the
// score the driver sees matches what dispatch sees on /drivers.
//
// If the score can't be computed (no miles this window) we return
// safetyScore: null — the app renders a "no ELD miles this month" tile.
// ─────────────────────────────────────────────────────────────────────────

driver.get("/safety-score", async (c) => {
  const driverId = c.get("driverId");
  const orgId    = c.get("orgId");

  const now      = new Date();
  const days     = 30;
  const fromIso  = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const toIso    = now.toISOString();
  const prevFromIso = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000).toISOString();
  const prevToIso   = fromIso;

  // Load THIS driver's events (both windows) + org-wide events for
  // fleet median penalty. Attribution: notified > assigned, matching
  // the dispatch endpoint.
  const [{ data: myEventsCurr }, { data: myEventsPrev }, { data: allEventsCurr }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .neq("dispute_status", "accepted")
      .or(`notified_driver_id.eq.${driverId},assigned_driver_id.eq.${driverId}`)
      .gte("event_time", fromIso)
      .lte("event_time", toIso)
      .limit(2000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .neq("dispute_status", "accepted")
      .or(`notified_driver_id.eq.${driverId},assigned_driver_id.eq.${driverId}`)
      .gte("event_time", prevFromIso)
      .lte("event_time", prevToIso)
      .limit(2000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .neq("dispute_status", "accepted")
      .gte("event_time", fromIso)
      .lte("event_time", toIso)
      .limit(5000),
  ]);

  // Miles for THIS driver — calendar-attributed, same waterfall as the
  // dispatch endpoint. We need periods + assets + calendar events.
  const [{ data: periods }, { data: assetRows }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_driving_periods")
      .select("vehicle_id, miles, start_time")
      .eq("org_id", orgId)
      .eq("display_eligible", true)
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .limit(20_000),
    supabase
      .from("assets")
      .select("id, motive_vehicle_id")
      .eq("org_id", orgId)
      .not("motive_vehicle_id", "is", null),
  ]);
  const vehicleIdToAssetId = new Map<string, number>();
  for (const r of (assetRows ?? []) as Array<{ id: number; motive_vehicle_id: number | string | null }>) {
    if (r.motive_vehicle_id != null) vehicleIdToAssetId.set(String(r.motive_vehicle_id), r.id);
  }
  const assetIdsInScope = Array.from(new Set(
    ((periods ?? []) as Array<{ vehicle_id: number }>)
      .map(p => vehicleIdToAssetId.get(String(p.vehicle_id)))
      .filter((x): x is number => x != null),
  ));
  interface CalRow { asset_id: number; driver_id: number | null; start: string; end: string }
  let calRows: CalRow[] = [];
  if (assetIdsInScope.length > 0) {
    const rangeStart = utcMsToNaiveDenver(new Date(fromIso).getTime() - 3 * 24 * 60 * 60 * 1000);
    const rangeEnd   = utcMsToNaiveDenver(new Date(toIso).getTime()   + 3 * 24 * 60 * 60 * 1000);
    if (rangeStart && rangeEnd) {
      const { data } = await supabase
        .from("events")
        .select("asset_id, driver_id, start, end")
        .eq("org_id", orgId)
        .in("asset_id", assetIdsInScope)
        .not("driver_id", "is", null)
        .gte("end",   rangeStart)
        .lte("start", rangeEnd);
      calRows = (data ?? []) as CalRow[];
    }
  }
  const calByAsset = new Map<number, CalRow[]>();
  for (const e of calRows) {
    const arr = calByAsset.get(e.asset_id) ?? [];
    arr.push(e);
    calByAsset.set(e.asset_id, arr);
  }
  const { data: prefs } = assetIdsInScope.length > 0
    ? await supabase
        .from("driver_asset_prefs")
        .select("asset_id, driver_id")
        .eq("org_id", orgId)
        .in("asset_id", assetIdsInScope)
    : { data: [] };
  const prefByAsset = new Map<number, number>();
  for (const p of (prefs ?? []) as Array<{ asset_id: number; driver_id: number }>) {
    prefByAsset.set(p.asset_id, p.driver_id);
  }

  // Attribute miles per driver — same logic as the dispatch endpoint.
  const milesByDriver = new Map<number, number>();
  for (const p of (periods ?? []) as Array<{ vehicle_id: number; miles: number | null; start_time: string }>) {
    if (p.miles == null || p.miles <= 0) continue;
    const assetId = vehicleIdToAssetId.get(String(p.vehicle_id));
    if (assetId == null) continue;
    const naive = utcMsToNaiveDenver(Date.parse(p.start_time));
    if (!naive) continue;
    const candidates = calByAsset.get(assetId) ?? [];
    let attribDriverId: number | null = null;
    let bestActive: CalRow | null = null;
    for (const e of candidates) {
      if (e.start <= naive && e.end >= naive) {
        if (!bestActive || e.end < bestActive.end) bestActive = e;
      }
    }
    if (bestActive) {
      attribDriverId = bestActive.driver_id;
    } else {
      let bestPrior: CalRow | null = null;
      for (const e of candidates) {
        if (e.end <= naive) {
          if (!bestPrior || e.end > bestPrior.end) bestPrior = e;
        }
      }
      if (bestPrior) attribDriverId = bestPrior.driver_id;
    }
    if (attribDriverId == null) attribDriverId = prefByAsset.get(assetId) ?? null;
    if (attribDriverId != null) {
      milesByDriver.set(attribDriverId, (milesByDriver.get(attribDriverId) ?? 0) + p.miles);
    }
  }

  // Score constants — MUST match driver-safety-scoring.ts. If those
  // constants change, update these too or extract into a shared module.
  const SEV_WEIGHT: Record<string, number> = { low: 0, moderate: 1, severe: 10 };
  const TYPE_WEIGHT: Record<string, number> = {
    tailgating:          1.5,
    distraction:         1.5,
    cell_phone:          1.5,
    phone_use:           1.5,
    drowsiness:          1.5,
    stop_sign_violation: 0.3,
    seat_belt_violation: 0.5,
    seatbelt:            0.5,
  };
  const NON_SCORED_EVENTS = new Set([
    "camera_obstruction",
    "driver_facing_cam_obstruction",
  ]);
  const MEDIAN_ANCHOR = 80;
  const MIN_MILES_FOR_MEDIAN = 500;
  const MIN_MILES_FOR_SCORE  = 200;    // below this → score = null ("insufficient data")
  const FALLBACK_MEDIAN = 6;
  const MIN_MEDIAN_ELIGIBLE = 3;
  const MIN_EFFECTIVE_MEDIAN = 3;
  const MIN_SCORE_FLOOR = 20;
  // Bayesian prior — must match driver-safety-scoring.ts. Sized to
  // roughly one week of per-truck mileage so a full 30-day window of
  // actual data dominates the prior.
  const PRIOR_MILES = 5000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type EventRow = { event_type: string; event_time: string; notified_driver_id: number | null; assigned_driver_id: number | null; raw: any };

  function penaltyFor(events: EventRow[], relTo: number): { total: number; moderate: number; severe: number; totalCount: number } {
    let total = 0, moderate = 0, severe = 0, totalCount = 0;
    for (const e of events) {
      if (NON_SCORED_EVENTS.has(e.event_type)) continue;
      const sev = deriveSeverity(e.raw, e.event_type);
      const lw = SEV_WEIGHT[sev.level] ?? 0;
      const tw = TYPE_WEIGHT[e.event_type] ?? 1;
      const ageDays = Math.max(0, relTo - Date.parse(e.event_time)) / (24 * 60 * 60 * 1000);
      const rw = Math.max(0.5, Math.min(1, 1 - (ageDays / days) * 0.5));
      total += lw * (sev.score / 100) * tw * rw;
      totalCount++;
      if (sev.level === "moderate") moderate++;
      if (sev.level === "severe")   severe++;
    }
    return { total, moderate, severe, totalCount };
  }

  const myMiles = milesByDriver.get(driverId) ?? 0;
  const myCurr = penaltyFor((myEventsCurr ?? []) as EventRow[], now.getTime());
  const myPrev = penaltyFor((myEventsPrev ?? []) as EventRow[], new Date(fromIso).getTime());

  // Fleet-median penalty from ALL drivers with enough miles this window.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgByDriver = new Map<number, { total: number }>();
  for (const e of ((allEventsCurr ?? []) as EventRow[])) {
    if (NON_SCORED_EVENTS.has(e.event_type)) continue;
    const dId = e.notified_driver_id ?? e.assigned_driver_id;
    if (dId == null) continue;
    const sev = deriveSeverity(e.raw, e.event_type);
    const lw = SEV_WEIGHT[sev.level] ?? 0;
    const tw = TYPE_WEIGHT[e.event_type] ?? 1;
    const ageDays = Math.max(0, now.getTime() - Date.parse(e.event_time)) / (24 * 60 * 60 * 1000);
    const rw = Math.max(0.5, Math.min(1, 1 - (ageDays / days) * 0.5));
    const acc = orgByDriver.get(dId) ?? { total: 0 };
    acc.total += lw * (sev.score / 100) * tw * rw;
    orgByDriver.set(dId, acc);
  }
  const perDriverPenalties: number[] = [];
  for (const [dId, acc] of orgByDriver) {
    const miles = milesByDriver.get(dId) ?? 0;
    if (miles < MIN_MILES_FOR_MEDIAN) continue;
    // Smoothed rate — matches how individual drivers' scores are
    // computed. Small effect on high-mile drivers (who qualify for
    // the median), consistent formula everywhere.
    perDriverPenalties.push(acc.total / ((miles + PRIOR_MILES) / 1000));
  }
  const medianPen = perDriverPenalties.length >= MIN_MEDIAN_ELIGIBLE
    ? median(perDriverPenalties) ?? FALLBACK_MEDIAN
    : FALLBACK_MEDIAN;

  function scoreFor(penaltyPer1k: number): number {
    // 0 events → 100 always. Fleet median doesn't punish a driver who
    // did nothing wrong.
    if (penaltyPer1k <= 0) return 100;
    const m = Math.max(medianPen, MIN_EFFECTIVE_MEDIAN);
    if (penaltyPer1k <= m) {
      return Math.round(Math.max(MEDIAN_ANCHOR, Math.min(100,
        MEDIAN_ANCHOR + (100 - MEDIAN_ANCHOR) * (m - penaltyPer1k) / m)));
    }
    if (penaltyPer1k >= 3 * m) return MIN_SCORE_FLOOR;
    return Math.round(Math.max(MIN_SCORE_FLOOR, Math.min(MEDIAN_ANCHOR,
      MEDIAN_ANCHOR - (MEDIAN_ANCHOR - MIN_SCORE_FLOOR) * (penaltyPer1k - m) / (2 * m))));
  }

  const myDenominator = (myMiles + PRIOR_MILES) / 1000;
  const safetyScore = myMiles >= MIN_MILES_FOR_SCORE
    ? scoreFor(myCurr.total / myDenominator)
    : null;
  const prevSafetyScore = myMiles >= MIN_MILES_FOR_SCORE
    ? scoreFor(myPrev.total / myDenominator)
    : null;
  const flagged = safetyScore != null && safetyScore < 60 && myCurr.severe >= 2 && myMiles >= 500;

  return c.json({
    safetyScore,
    prevSafetyScore,
    totalEvents:    myCurr.totalCount,
    moderateEvents: myCurr.moderate,
    severeEvents:   myCurr.severe,
    milesDriven:    Math.round(myMiles * 10) / 10,
    flagged,
    days,
    fromDate: fromIso.slice(0, 10),
    toDate:   toIso.slice(0, 10),
  });
});

// ── Naive-Denver + median helpers (duplicated from driver-safety-scoring
// intentionally — this route is loaded by the driver JWT, and pulling
// them from the dispatch route creates a circular import risk. Small
// enough to keep local.)

function utcMsToNaiveDenver(ms: number): string | null {
  if (!isFinite(ms)) return null;
  const d = new Date(ms);
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

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export default driver;
