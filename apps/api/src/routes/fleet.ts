/**
 * /v1/fleet — fleet-wide rollups for cross-asset comparison views.
 *
 * Currently surfaces a single endpoint:
 *   GET /v1/fleet/performance?from=&to=&tz=
 *     Returns one row per non-hidden asset summarizing the truck's
 *     performance over the window using the same inbound-attribution
 *     pipeline the timeline page uses (load → start day; movement
 *     miles to either the load they're linked to or the yard/unattr
 *     buckets when not load-linked).
 *
 * Designed for the /performance comparison page; the table sorts on
 * any column to rank trucks.
 */

import { Hono } from "hono";
import type { ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

const fleet = new Hono<{ Variables: AuthVariables }>();

fleet.use("*", requireCapability("loads.view"));

interface FleetAssetPerformance {
  assetId:              number;
  name:                 string;
  unit:                 string | null;
  color:                string;
  motiveLinked:         boolean;
  /** Revenue from loads whose pickup (event.start) falls in the window. */
  totalRevenue:         number;
  totalDriverPay:       number;
  netToTruck:           number;
  loadCount:            number;
  /** Sum of loaded-miles credited to this asset's loads. */
  loadedMiles:          number;
  inboundDhMiles:       number;
  attributedMiles:      number;
  yardReturnMiles:      number;
  unattributedMiles:    number;
  totalMiles:           number;
  /** revenue / attributedMiles. */
  dayRpm:               number | null;
  /** revenue / totalMiles. The brutally-honest one. */
  dayRpmTotal:          number | null;
  /** (inbound dh + yard return) / total miles. */
  deadheadPctOfDay:     number | null;
  avgRevPerLoad:        number | null;
  avgLoadedMilesPerLoad: number | null;
  driverPayPct:         number | null;     // driverPay / revenue
  /** attributedMiles / totalMiles. Inverse of "wasted miles." */
  utilization:          number | null;
  /** Distinct days (org-TZ) the truck moved at all in the window. */
  activeDays:           number;
  /** revenue / total miles for sorting cleanliness (alias for dayRpmTotal). */
  netPerMile:           number | null;     // netToTruck / totalMiles
}

interface FleetPerformanceResponse {
  windowFrom: string;
  windowTo:   string;
  assets:     FleetAssetPerformance[];
}

/** Naive→UTC ISO. The naive string is interpreted in `tz`; result is
 *  the UTC instant of that wall-clock moment. */
function naiveToUtcIso(naive: string, tz: string): string {
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
}

/** Day key (YYYY-MM-DD) for a UTC ISO in org TZ. */
function utcToOrgDayKey(utc: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(utc));
}

fleet.get("/performance", async (c) => {
  const orgId = c.get("orgId");
  const from  = c.req.query("from");
  const to    = c.req.query("to");
  const tz    = c.req.query("tz") || "America/Denver";

  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (YYYY-MM-DD)"] } satisfies ApiErrorResponse, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return c.json({ error: "validation_failed", errors: ["from/to must be YYYY-MM-DD"] } satisfies ApiErrorResponse, 400);
  }

  // Naive boundaries — events use these directly (events.start is naive
  // in org TZ). The 'to' is the start of the day AFTER `to` so an event
  // starting on the last day is included.
  const fromNaive = `${from}T00:00:00`;
  // shift `to` forward by 1 day to make the comparison exclusive on the high end
  const toDate = new Date(`${to}T00:00:00Z`);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusiveDayKey = toDate.toISOString().slice(0, 10);
  const toNaive = `${toExclusiveDayKey}T00:00:00`;
  // Movement window in UTC equivalents.
  const movFrom = naiveToUtcIso(fromNaive, tz);
  const movTo   = naiveToUtcIso(toNaive, tz);

  // ── Assets in org ──────────────────────────────────────────────
  // Filters:
  //   • hidden = false                          (calendar-hidden trucks excluded)
  //   • type != 'Unassigned' AND name != 'Unassigned'
  //                                             (drops the orphan-load pseudo-asset)
  //   • active_from <= window's `to`            (asset existed by the end of window)
  //   • active_to IS NULL OR active_to >= from  (asset wasn't retired before window)
  const { data: assetRows } = await sb
    .from("assets")
    .select("id, name, unit, color, motive_vehicle_id, type")
    .eq("org_id", orgId)
    .eq("hidden", false)
    .neq("type", "Unassigned")
    .neq("name", "Unassigned")
    .lte("active_from", to)
    .or(`active_to.is.null,active_to.gte.${from}`)
    .order("sort_order", { ascending: true });
  const assets = ((assetRows ?? []) as Array<{
    id: number; name: string; unit: string | null; color: string;
    motive_vehicle_id: string | null; type: string | null;
  }>);
  if (assets.length === 0) {
    const res: FleetPerformanceResponse = { windowFrom: from, windowTo: to, assets: [] };
    return c.json(res);
  }

  const assetIds = assets.map((a) => a.id);

  // ── Events for all assets in window (start in window) ─────────
  const { data: eventRows } = await sb
    .from("events")
    .select("id, asset_id, start, \"end\", event_kind, driver_pay, load:loads(load_price, total_billable)")
    .eq("org_id", orgId)
    .in("asset_id", assetIds)
    .is("deleted_at", null)
    .gte("start", fromNaive)
    .lt("start", toNaive);
  const events = ((eventRows ?? []) as Array<{
    id: string; asset_id: number; start: string; end: string;
    event_kind: string | null; driver_pay: number | null;
    load: { load_price: number | null; total_billable: number | null } | null;
  }>);

  // Build per-event maps used by movement attribution + per-asset rollup.
  const eventAssetId = new Map<string, number>();
  const revenueEventIds = new Set<string>();
  for (const e of events) {
    eventAssetId.set(e.id, e.asset_id);
    if (e.event_kind !== "non_revenue") revenueEventIds.add(e.id);
  }

  // ── Movements: in-window + cross-period spillover ─────────────
  //
  // In-window catches the normal case: movements that happened during
  // [from, to]. Spillover catches movements PHYSICALLY outside the
  // window whose link refs an event INSIDE the window — same fix as
  // week-summary. A multi-day load that started in the period but
  // had miles after the window's end still credits those miles to
  // this period (the load's owning bucket).

  const { data: movementRows } = await sb
    .from("movements")
    .select("id, asset_id, miles, start_time")
    .eq("org_id", orgId)
    .in("asset_id", assetIds)
    .is("deleted_at", null)
    .gte("start_time", movFrom)
    .lt("start_time", movTo);
  const inWindowMovements = ((movementRows ?? []) as Array<{
    id: string; asset_id: number; miles: number | null; start_time: string;
  }>);

  // Pull every CURRENT link that references either a window movement
  // OR a window event. Four parallel queries — PostgREST's .or() with
  // .in() on UUID columns gets messy enough that this is cleaner.
  const inWindowMovementIds = inWindowMovements.map((m) => m.id);
  const eventIds = events.map((e) => e.id);
  type LinkRow = {
    movement_id: string; role: string;
    loaded_event_id: string | null;
    from_event_id: string | null;
    to_event_id: string | null;
  };
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

  // Fetch any spillover-movement rows we don't already have (movements
  // physically outside the window but linked to a window event).
  const inWindowSet = new Set(inWindowMovementIds);
  const spilloverMovementIds = Array.from(linkByMovementId.keys()).filter((id) => !inWindowSet.has(id));
  const { data: spilloverMovementRows } = spilloverMovementIds.length > 0
    ? await sb
        .from("movements")
        .select("id, asset_id, miles, start_time")
        .eq("org_id", orgId)
        .in("asset_id", assetIds)
        .is("deleted_at", null)
        .in("id", spilloverMovementIds)
    : { data: [] };
  const movements = [
    ...inWindowMovements,
    ...((spilloverMovementRows ?? []) as Array<{
      id: string; asset_id: number; miles: number | null; start_time: string;
    }>),
  ];

  // ── Per-asset accumulators ────────────────────────────────────
  type Bucket = {
    totalRevenue: number; totalDriverPay: number; loadCount: number;
    loadedMiles: number; inboundDhMiles: number;
    yardReturnMiles: number; unattributedMiles: number;
    /** Set of org-TZ day-keys where this asset had at least one movement. */
    activeDays: Set<string>;
  };
  const buckets = new Map<number, Bucket>();
  for (const a of assets) {
    buckets.set(a.id, {
      totalRevenue: 0, totalDriverPay: 0, loadCount: 0,
      loadedMiles: 0, inboundDhMiles: 0,
      yardReturnMiles: 0, unattributedMiles: 0,
      activeDays: new Set<string>(),
    });
  }

  // Revenue + driver pay → per-asset bucket (load on its start day).
  for (const e of events) {
    if (e.event_kind === "non_revenue") continue;
    const b = buckets.get(e.asset_id);
    if (!b) continue;
    // Revenue uses total_billable (linehaul + billable accessorials),
    // computed by the loads_compute_total_billable trigger. Falls back
    // to load_price for any row predating the backfill, but the trigger
    // guarantees total_billable is populated for every row written
    // after 20260605_loads_total_billable.sql.
    b.totalRevenue   += e.load?.total_billable ?? e.load?.load_price ?? 0;
    b.totalDriverPay += e.driver_pay ?? 0;
    b.loadCount      += 1;
  }

  // Movement miles → per-asset bucket. Loaded/inbound-dh credited via
  // their linked load's asset. Yard return + unattributed credited to
  // the movement's own asset (same one as the trip).
  for (const m of movements) {
    const miles = m.miles ?? 0;
    const b = buckets.get(m.asset_id);
    if (!b) continue;

    // Active-day tracking — any movement (even short, even unattributed)
    // counts toward "the truck moved that day".
    b.activeDays.add(utcToOrgDayKey(m.start_time, tz));

    if (miles === 0) continue;
    const link = linkByMovementId.get(m.id);
    if (!link) { b.unattributedMiles += miles; continue; }

    switch (link.role) {
      case "loaded": {
        if (link.loaded_event_id && revenueEventIds.has(link.loaded_event_id)) {
          // Credit to the linked load's asset (almost always m.asset_id).
          const targetAssetId = eventAssetId.get(link.loaded_event_id) ?? m.asset_id;
          const target = buckets.get(targetAssetId);
          if (target) target.loadedMiles += miles;
          else b.unattributedMiles += miles;
        } else {
          b.unattributedMiles += miles;
        }
        break;
      }
      case "transition": {
        if (link.to_event_id && revenueEventIds.has(link.to_event_id)) {
          const targetAssetId = eventAssetId.get(link.to_event_id) ?? m.asset_id;
          const target = buckets.get(targetAssetId);
          if (target) target.inboundDhMiles += miles;
          else b.unattributedMiles += miles;
        } else if (link.from_event_id && !link.to_event_id) {
          b.yardReturnMiles += miles;
        } else {
          b.unattributedMiles += miles;
        }
        break;
      }
      default:
        b.unattributedMiles += miles;
        break;
    }
  }

  // ── Materialize per-asset rows ────────────────────────────────
  const assetsOut: FleetAssetPerformance[] = assets.map((a) => {
    const b = buckets.get(a.id)!;
    const attributedMiles = b.loadedMiles + b.inboundDhMiles;
    const totalMiles      = attributedMiles + b.yardReturnMiles + b.unattributedMiles;
    const dayRpm          = attributedMiles > 0 ? b.totalRevenue / attributedMiles : null;
    const dayRpmTotal     = totalMiles > 0 ? b.totalRevenue / totalMiles : null;
    const deadheadPct     = totalMiles > 0 ? (b.inboundDhMiles + b.yardReturnMiles) / totalMiles : null;
    const utilization     = totalMiles > 0 ? attributedMiles / totalMiles : null;
    const netToTruck      = b.totalRevenue - b.totalDriverPay;
    const netPerMile      = totalMiles > 0 ? netToTruck / totalMiles : null;

    return {
      assetId:              a.id,
      name:                 a.name,
      unit:                 a.unit,
      color:                a.color,
      motiveLinked:         !!a.motive_vehicle_id,
      totalRevenue:         b.totalRevenue,
      totalDriverPay:       b.totalDriverPay,
      netToTruck,
      loadCount:            b.loadCount,
      loadedMiles:          b.loadedMiles,
      inboundDhMiles:       b.inboundDhMiles,
      attributedMiles,
      yardReturnMiles:      b.yardReturnMiles,
      unattributedMiles:    b.unattributedMiles,
      totalMiles,
      dayRpm,
      dayRpmTotal,
      deadheadPctOfDay:     deadheadPct,
      avgRevPerLoad:        b.loadCount > 0 ? b.totalRevenue / b.loadCount : null,
      avgLoadedMilesPerLoad: b.loadCount > 0 ? b.loadedMiles / b.loadCount : null,
      driverPayPct:         b.totalRevenue > 0 ? b.totalDriverPay / b.totalRevenue : null,
      utilization,
      activeDays:           b.activeDays.size,
      netPerMile,
    };
  });

  // Drop rows that were utterly idle in this window — no loads, no
  // movements at all. The dispatcher doesn't want a wall of zeros
  // from trucks that were parked the whole period.
  const activeAssets = assetsOut.filter(
    (a) => a.loadCount > 0 || a.totalMiles > 0 || a.activeDays > 0,
  );

  const res: FleetPerformanceResponse = {
    windowFrom: from,
    windowTo:   to,
    assets:     activeAssets,
  };
  return c.json(res);
});

export default fleet;
