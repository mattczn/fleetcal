/**
 * /v1/driver-safety-scoring — per-driver safety scorecard (Curzon-only).
 *
 * Derived on-demand from motive_performance_events + motive_driving_periods.
 * No stored scoring state, no daily job — matches the design of the
 * inspection scorecard so the numbers can never drift.
 *
 *   GET /v1/driver-safety-scoring?days=30
 *
 * Formula (transparent — every constant lives in this file):
 *
 *   For each event in the window attributed to this driver:
 *     event_penalty = (severity_level_weight × severity_score / 100)
 *                     × event_type_weight
 *                     × recency_weight
 *
 *   penalty_total   = Σ event_penalty
 *   penalty_per_1k  = penalty_total / (miles_driven / 1000)
 *   safety_score    = clamp(100 - penalty_per_1k × K, 0, 100)
 *
 * Weights:
 *   severity_level:  low=1, moderate=3, severe=10
 *   event_type:      tailgating/distraction/cell_phone/drowsiness = 1.5
 *                    others = 1.0
 *   recency:         linear falloff — today = 1.0, day 30 = 0.5
 *
 * Auto-flag rule: safety_score < 60 AND totalEvents ≥ 5 AND milesDriven ≥ 500.
 * Bottom-quartile-ish while requiring enough events to not flag on a fluke
 * and enough miles to not flag a driver who barely drove.
 *
 * Attribution to a driver uses the notified_driver_id first (dispatcher-
 * confirmed) then resolved_driver_id (calendar-derived). Motive's
 * driver_id is never used — Motive lags on shift changes and we don't
 * trust it (see performance-events.ts header for the rationale).
 */

import { Hono } from "hono";
import type {
  ListDriverSafetyScoresResponse,
  DriverSafetyScoreRow,
  DriverSafetyFleetSummary,
  ApiErrorResponse,
} from "@fleetcal/types";
import { deriveSeverity } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { loadExcludedDrivers } from "../lib/reportExclusions.js";
import type { AuthVariables } from "../middleware/clerk.js";
import {
  requireTruckHistoryOrg,
  requireModule,
  requireCapability,
} from "../middleware/require.js";

const safetyScoring = new Hono<{ Variables: AuthVariables }>();

safetyScoring.use(
  "*",
  requireTruckHistoryOrg,
  requireModule("motive_integration"),
  requireCapability("safety.access"),
);

// ── Constants (tune here) ─────────────────────────────────────────────

const SEVERITY_LEVEL_WEIGHT: Record<string, number> = {
  low:      1,
  moderate: 3,
  severe:   10,
};

const EVENT_TYPE_WEIGHT: Record<string, number> = {
  tailgating:  1.5,
  distraction: 1.5,
  cell_phone:  1.5,
  drowsiness:  1.5,
};
const DEFAULT_EVENT_TYPE_WEIGHT = 1.0;

/** Penalty-to-score scale. Tuned so a fleet-average driver
 *  (few moderate events per 1000 miles) lands ~85. Adjust if the score
 *  band feels compressed after real data lands. */
const PENALTY_SCALE = 12;

/** Auto-flag thresholds. Stack rather than OR so a driver isn't flagged
 *  off a single bad brake or a low-mileage month. */
const FLAG_MAX_SCORE     = 60;
const FLAG_MIN_EVENTS    = 5;
const FLAG_MIN_MILES     = 500;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** YYYY-MM-DD of a Date (UTC). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Handler ───────────────────────────────────────────────────────────

safetyScoring.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url   = new URL(c.req.url);

  // Fixed 1-month window per product spec — "driver score should only
  // be 1 month". Deeper history stays available in the SafetyPanel /
  // reports surface. Days is still tunable so I can point the same
  // endpoint at the prev 30-day window for the trend field below.
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") ?? 30)));

  const now = new Date();
  const to  = now;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const fromIso = from.toISOString();
  const toIso   = to.toISOString();

  // Previous-window bounds (for prevSafetyScore trend). Same length
  // immediately preceding the current window.
  const prevFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  const prevTo   = from;

  // ── (1) drivers roster (respect the same exclusions as reports) ────
  const excluded = await loadExcludedDrivers(orgId);
  const { data: driverRows, error: dErr } = await supabase
    .from("drivers")
    .select("id,name")
    .eq("org_id", orgId);
  if (dErr) {
    console.error("[GET /v1/driver-safety-scoring] drivers failed:", dErr);
    return c.json({ error: "fetch_failed", detail: dErr.message } satisfies ApiErrorResponse, 500);
  }
  const drivers = ((driverRows ?? []) as Array<{ id: number; name: string }>)
    .filter(d => !excluded.idSet.has(d.id));
  const nameById = new Map<number, string>();
  for (const d of drivers) nameById.set(d.id, d.name);

  // ── (2) safety events in-range — pull attribution + raw for severity ─
  // We fetch raw here even though it's heavy because deriveSeverity()
  // needs the event_intensity subfield. Cap at 5000 per fetch which is
  // way beyond even the noisiest 30-day Curzon window (~500-1000).
  interface EventRow {
    id:              number;
    event_type:      string;
    event_time:      string;
    notified_driver_id: number | null;
    assigned_driver_id: number | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw:             any;
  }
  const [{ data: currRows, error: eErr }, { data: prevRows, error: eErr2 }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .gte("event_time", fromIso)
      .lte("event_time", toIso)
      .limit(5000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .gte("event_time", prevFrom.toISOString())
      .lte("event_time", prevTo.toISOString())
      .limit(5000),
  ]);
  if (eErr || eErr2) {
    console.error("[GET /v1/driver-safety-scoring] events failed:", eErr ?? eErr2);
    return c.json({ error: "fetch_failed", detail: (eErr ?? eErr2)!.message } satisfies ApiErrorResponse, 500);
  }

  // ── (3) miles-driven per driver from motive_driving_periods ────────
  // We only credit periods that (a) belong to the org, (b) landed inside
  // the window, and (c) are display_eligible (matches how movements are
  // counted elsewhere — avoids GPS-jitter periods inflating the
  // denominator).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: periodRows, error: pErr } = await (supabase as any)
    .from("motive_driving_periods")
    .select("driver_id, driver_first_name, driver_last_name, miles, start_time")
    .eq("org_id", orgId)
    .eq("display_eligible", true)
    .gte("start_time", fromIso)
    .lte("start_time", toIso)
    .limit(50_000);
  if (pErr) {
    console.error("[GET /v1/driver-safety-scoring] periods failed:", pErr);
    return c.json({ error: "fetch_failed", detail: pErr.message } satisfies ApiErrorResponse, 500);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currPrev = (periodRows ?? []) as Array<{
    driver_id: number | null;
    driver_first_name: string | null;
    driver_last_name:  string | null;
    miles: number | null;
    start_time: string;
  }>;

  // Motive's driver_id ≠ fleetcal drivers.id. Match by name, case-
  // insensitive, since drivers.motive_driver_id doesn't exist yet.
  // Fallback: unmatched miles roll into an "unattributed" bucket that
  // we ignore for the fleet median (they don't belong to any tracked
  // driver anyway).
  const nameToFleetcalId = new Map<string, number>();
  for (const d of drivers) nameToFleetcalId.set(d.name.trim().toLowerCase(), d.id);

  const milesByDriverId = new Map<number, number>();
  for (const p of currPrev) {
    if (p.miles == null || p.miles <= 0) continue;
    const motiveName = [p.driver_first_name, p.driver_last_name].filter(Boolean).join(" ").trim().toLowerCase();
    if (!motiveName) continue;
    const fleetcalId = nameToFleetcalId.get(motiveName);
    if (fleetcalId == null) continue;
    milesByDriverId.set(fleetcalId, (milesByDriverId.get(fleetcalId) ?? 0) + p.miles);
  }

  // ── (4) Aggregate events per driver, computing penalty as we go ────
  type Acc = {
    totalEvents:   number;
    severeEvents:  number;
    penaltyTotal:  number;
  };
  const acc = new Map<number, Acc>();
  const prevAcc = new Map<number, Acc>();

  function bump(bucket: Map<number, Acc>, driverId: number, eventPenalty: number, isSevere: boolean) {
    const a = bucket.get(driverId) ?? { totalEvents: 0, severeEvents: 0, penaltyTotal: 0 };
    a.totalEvents++;
    if (isSevere) a.severeEvents++;
    a.penaltyTotal += eventPenalty;
    bucket.set(driverId, a);
  }

  function driverForEvent(e: EventRow): number | null {
    // notified > assigned > null. resolved_driver_id isn't stored on
    // the row (it's computed at read time by enrichEventsBatch), so
    // for scoring we use the two persisted attribution columns.
    if (e.notified_driver_id) return e.notified_driver_id;
    if (e.assigned_driver_id) return e.assigned_driver_id;
    return null;
  }

  const nowMs = Date.now();
  for (const rawE of ((currRows ?? []) as EventRow[])) {
    const driverId = driverForEvent(rawE);
    if (driverId == null || !nameById.has(driverId)) continue;
    const sev = deriveSeverity(rawE.raw, rawE.event_type);
    const levelWeight = SEVERITY_LEVEL_WEIGHT[sev.level] ?? 1;
    const typeWeight  = EVENT_TYPE_WEIGHT[rawE.event_type] ?? DEFAULT_EVENT_TYPE_WEIGHT;
    // Recency: 1.0 at t=now, 0.5 at t=now-days*24h (linear).
    const ageMs = Math.max(0, nowMs - Date.parse(rawE.event_time));
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const recencyWeight = clamp(1 - (ageDays / days) * 0.5, 0.5, 1);
    // sev.score is 0-100; divide so a maxed-out severe event
    // contributes exactly its level_weight × type_weight × recency to
    // the penalty (keeps the score axis interpretable).
    const eventPenalty = levelWeight * (sev.score / 100) * typeWeight * recencyWeight;
    bump(acc, driverId, eventPenalty, sev.level === "severe");
  }
  const prevWindowMs = days * 24 * 60 * 60 * 1000;
  for (const rawE of ((prevRows ?? []) as EventRow[])) {
    const driverId = driverForEvent(rawE);
    if (driverId == null || !nameById.has(driverId)) continue;
    const sev = deriveSeverity(rawE.raw, rawE.event_type);
    const levelWeight = SEVERITY_LEVEL_WEIGHT[sev.level] ?? 1;
    const typeWeight  = EVENT_TYPE_WEIGHT[rawE.event_type] ?? DEFAULT_EVENT_TYPE_WEIGHT;
    // For the previous window, "recency" is measured relative to the
    // end of that window (prevTo), not now.
    const ageMs = Math.max(0, prevTo.getTime() - Date.parse(rawE.event_time));
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const recencyWeight = clamp(1 - (ageDays / days) * 0.5, 0.5, 1);
    const eventPenalty = levelWeight * (sev.score / 100) * typeWeight * recencyWeight;
    bump(prevAcc, driverId, eventPenalty, sev.level === "severe");
  }

  // ── (5) Compute score per driver + fleet aggregates ────────────────
  const rowsUnranked: Array<Omit<DriverSafetyScoreRow, "rank">> = drivers.map(d => {
    const a = acc.get(d.id) ?? { totalEvents: 0, severeEvents: 0, penaltyTotal: 0 };
    const miles = milesByDriverId.get(d.id) ?? 0;
    const pa = prevAcc.get(d.id) ?? { totalEvents: 0, severeEvents: 0, penaltyTotal: 0 };

    // Score is undefined when miles=0 (would divide by zero AND we
    // can't judge a driver who didn't drive). null in that case.
    let safetyScore: number | null = null;
    let penaltyPer1kMi = 0;
    if (miles > 0) {
      penaltyPer1kMi = a.penaltyTotal / (miles / 1000);
      safetyScore = Math.round(clamp(100 - penaltyPer1kMi * PENALTY_SCALE, 0, 100));
    }

    let prevSafetyScore: number | null = null;
    if (miles > 0) {
      // Use CURRENT-window miles as a proxy denominator — Motive's
      // miles table is expensive to double-query, and the trend is only
      // meaningful when the driver is still active. This slightly
      // underweights prev-period severity when a driver's mileage
      // dropped (rare); accepted for MVP.
      const prevPenaltyPer1k = pa.penaltyTotal / (miles / 1000);
      prevSafetyScore = Math.round(clamp(100 - prevPenaltyPer1k * PENALTY_SCALE, 0, 100));
    }

    const flagged =
      safetyScore != null &&
      safetyScore < FLAG_MAX_SCORE &&
      a.totalEvents >= FLAG_MIN_EVENTS &&
      miles >= FLAG_MIN_MILES;

    return {
      driverId:       d.id,
      driverName:     d.name,
      safetyScore,
      totalEvents:    a.totalEvents,
      severeEvents:   a.severeEvents,
      milesDriven:    Math.round(miles * 10) / 10,
      penaltyPer1kMi: Math.round(penaltyPer1kMi * 100) / 100,
      flagged,
      prevSafetyScore,
    };
  });

  // Rank 1..N by safetyScore desc. Ties get the same rank (dense
  // ranking would skip numbers, competition ranking preserves them).
  const scored = rowsUnranked.filter(r => r.safetyScore != null);
  scored.sort((a, b) => (b.safetyScore ?? 0) - (a.safetyScore ?? 0));
  const rankByDriver = new Map<number, number>();
  let lastScore: number | null = null;
  let lastRank = 0;
  scored.forEach((row, idx) => {
    if (lastScore == null || row.safetyScore !== lastScore) {
      lastRank = idx + 1;
      lastScore = row.safetyScore;
    }
    rankByDriver.set(row.driverId, lastRank);
  });

  const rows: DriverSafetyScoreRow[] = rowsUnranked
    .map(r => ({ ...r, rank: rankByDriver.get(r.driverId) ?? null }))
    // Default sort: worst score first (dispatchers care about who
    // needs attention, not who's already fine). Nulls (no miles) at
    // the bottom.
    .sort((a, b) => {
      if (a.safetyScore == null) return 1;
      if (b.safetyScore == null) return -1;
      return a.safetyScore - b.safetyScore;
    });

  const scoresOnly = rows.map(r => r.safetyScore).filter((s): s is number => s != null);
  const fleetMean   = scoresOnly.length > 0
    ? Math.round((scoresOnly.reduce((a, b) => a + b, 0) / scoresOnly.length) * 10) / 10
    : null;
  const fleetMedian = median(scoresOnly);

  const fleet: DriverSafetyFleetSummary = {
    driverCount: rows.length,
    fleetMedian,
    fleetMean,
    fleetMiles:  Math.round(Array.from(milesByDriverId.values()).reduce((a, b) => a + b, 0) * 10) / 10,
    fleetEvents: (currRows ?? []).length,
    fromDate:    isoDate(from),
    toDate:      isoDate(to),
    days,
  };

  return c.json({ drivers: rows, fleet } satisfies ListDriverSafetyScoresResponse);
});

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : sorted[mid];
}

export default safetyScoring;
