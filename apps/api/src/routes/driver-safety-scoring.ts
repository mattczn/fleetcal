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

// Severity weights — SEVERE is the dominant signal (25x moderate), and
// LOW events are ignored entirely as noise. A driver averaging a lot of
// low-severity brakes isn't the same problem as one who occasionally
// crushes a stop, so we don't want low events padding the penalty.
const SEVERITY_LEVEL_WEIGHT: Record<string, number> = {
  low:      0,
  moderate: 1,
  severe:   25,
};

const EVENT_TYPE_WEIGHT: Record<string, number> = {
  tailgating:  1.5,
  distraction: 1.5,
  cell_phone:  1.5,
  drowsiness:  1.5,
};
const DEFAULT_EVENT_TYPE_WEIGHT = 1.0;

// Scoring is FLEET-MEDIAN-normalized so it self-calibrates. The score
// curve is piecewise linear anchored at the fleet median:
//   0 penalty         → 100
//   = median penalty  → 80  (fleet-average driver)
//   2× median         → 40
//   3× median or worse→ 0
// This means the median driver always sits around 80 regardless of how
// event-heavy the fleet is that month. No more re-tuning a K constant.
const MEDIAN_ANCHOR_SCORE = 80;

/** Minimum miles a driver needs before their penalty is included in
 *  the fleet-median calculation. Sub-500 mi drivers have too noisy a
 *  per-mile rate to reliably represent "average." */
const MIN_MILES_FOR_MEDIAN = 500;

/** Below this many miles we don't score a driver AT ALL — their
 *  penalty-per-mile would swing wildly on any single event and mislead
 *  the dispatcher. Displays as "insufficient data" instead. */
const MIN_MILES_FOR_SCORE  = 200;

/** Small-fleet fallback: when fewer than 3 drivers cleared MIN_MILES_FOR_MEDIAN
 *  we use this reference penalty instead of the unstable calculated
 *  median. Rough Curzon early-data estimate of "one severe event per
 *  2000mi" = ~6 penalty units per 1000mi. */
const FALLBACK_MEDIAN_PENALTY = 6;
const MIN_MEDIAN_ELIGIBLE_DRIVERS = 3;

/** Bottom floor for the effective median used by the score curve.
 *  Even a fleet with a genuinely tiny median penalty (very clean) uses
 *  at least this much so that a driver's first moderate event doesn't
 *  crash their score to 0. Roughly "one severe event per 1000mi is
 *  where the score starts dropping". */
const MIN_EFFECTIVE_MEDIAN = 3;

/** Score floor. Even the worst driver never falls below this — a
 *  literal 0 reads as "we've given up on you" and doesn't leave
 *  headroom for the coaching conversation. Bad drivers still land in
 *  the flagged zone (< 60), just not at zero. */
const MIN_SCORE_FLOOR = 20;

/** Bayesian smoothing: prior "clean miles" added to every driver's
 *  denominator. Interpret as "we assume 15,000 miles of clean driving
 *  as prior evidence — roughly a full month at typical fleet pace —
 *  then integrate the actual events into that prior".
 *
 *  This is the constant that determines how much day-1 or low-mile
 *  data can move a driver's score. With 15k prior:
 *  - A driver with 4 severe events on 500 mi lands around 68 (not 0).
 *  - A driver with 10 severe events on 500 mi still lands near 0 —
 *    truly bad behavior isn't washed away.
 *  - A heavy driver with 10k+ actual miles is barely affected by the
 *    prior (5000 raw miles + 15k prior = 3.75x smoothing → nudged
 *    toward the middle by a small amount, dominated by real data).
 */
const PRIOR_MILES = 15000;

/** Auto-flag thresholds. Now keyed off SEVERE events specifically —
 *  a pile of moderate events isn't a flag, but two severe events in
 *  a month is a pattern worth coaching. */
const FLAG_MAX_SCORE     = 60;
const FLAG_MIN_SEVERE    = 2;
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
    // Exclude events with an ACCEPTED dispute — dispatch already
    // agreed those were misattributed / wrongly flagged, so they
    // shouldn't hurt anyone's score. Pending disputes still count
    // (otherwise drivers could dispute everything to game the score).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .neq("dispute_status", "accepted")
      .gte("event_time", fromIso)
      .lte("event_time", toIso)
      .limit(5000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_performance_events")
      .select("id, event_type, event_time, notified_driver_id, assigned_driver_id, raw")
      .eq("org_id", orgId)
      .neq("dispute_status", "accepted")
      .gte("event_time", prevFrom.toISOString())
      .lte("event_time", prevTo.toISOString())
      .limit(5000),
  ]);
  if (eErr || eErr2) {
    console.error("[GET /v1/driver-safety-scoring] events failed:", eErr ?? eErr2);
    return c.json({ error: "fetch_failed", detail: (eErr ?? eErr2)!.message } satisfies ApiErrorResponse, 500);
  }

  // ── (3) Miles per driver — CALENDAR-attributed, not Motive ─────────
  // Same waterfall as safety-event attribution: for each driving_period
  // find the fleetcal calendar event covering that period's start_time
  // on the SAME asset and credit the miles to that event's driver_id.
  // Motive's driver_first_name/last_name is intentionally NOT used —
  // it's the same untrusted signal we reject on the event side (Motive
  // lags on shift changes, misattributes on shared trucks, and drops
  // to null on unidentified driving).
  //
  // Waterfall:
  //   1. Covering event (start ≤ period.start_time ≤ end) → event.driver_id
  //   2. Most recent event ending ≤ period.start_time on that asset
  //      → covers deadhead + between-load gaps
  //   3. driver_asset_prefs default for the asset → truck's usual driver
  //   4. Drop the miles (unattributed → don't inflate any denominator)
  //
  // Fetch periods + assets + calendar events in parallel to keep the
  // handler under a second.

  const [{ data: periodRows, error: pErr }, { data: assetRows, error: aErr }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("motive_driving_periods")
      .select("vehicle_id, miles, start_time")
      .eq("org_id", orgId)
      .eq("display_eligible", true)
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .limit(50_000),
    supabase
      .from("assets")
      .select("id, motive_vehicle_id")
      .eq("org_id", orgId)
      .not("motive_vehicle_id", "is", null),
  ]);
  if (pErr || aErr) {
    console.error("[GET /v1/driver-safety-scoring] periods/assets failed:", pErr ?? aErr);
    return c.json({ error: "fetch_failed", detail: (pErr ?? aErr)!.message } satisfies ApiErrorResponse, 500);
  }
  const periods = (periodRows ?? []) as Array<{
    vehicle_id: number;
    miles: number | null;
    start_time: string;
  }>;

  // motive_vehicle_id → fleetcal asset.id. Stringify both sides — the
  // column has been observed as string vs number depending on when the
  // row was written (see motiveIngest.ts for the same defensive cast).
  const vehicleIdToAssetId = new Map<string, number>();
  for (const r of (assetRows ?? []) as Array<{ id: number; motive_vehicle_id: number | string | null }>) {
    if (r.motive_vehicle_id != null) vehicleIdToAssetId.set(String(r.motive_vehicle_id), r.id);
  }

  // Batch-fetch calendar events for the ASSETS in scope over the
  // window (padded ±3 days to catch cross-window loads). Same pattern
  // as enrichEventsBatch — one query, in-memory match afterwards.
  const assetIdsInScope = Array.from(new Set(
    periods.map(p => vehicleIdToAssetId.get(String(p.vehicle_id))).filter((x): x is number => x != null),
  ));
  interface CalEventRow {
    id: string; asset_id: number;
    driver_id: number | null; start: string; end: string;
  }
  let calRows: CalEventRow[] = [];
  if (assetIdsInScope.length > 0) {
    const rangeStart = utcMsToNaiveMt(from.getTime() - 3 * 24 * 60 * 60 * 1000);
    const rangeEnd   = utcMsToNaiveMt(to.getTime()   + 3 * 24 * 60 * 60 * 1000);
    if (rangeStart && rangeEnd) {
      const { data } = await supabase
        .from("events")
        .select("id, asset_id, driver_id, start, end")
        .eq("org_id", orgId)
        .in("asset_id", assetIdsInScope)
        .not("driver_id", "is", null)
        .gte("end",   rangeStart)
        .lte("start", rangeEnd);
      calRows = (data ?? []) as CalEventRow[];
    }
  }
  const calByAsset = new Map<number, CalEventRow[]>();
  for (const e of calRows) {
    const arr = calByAsset.get(e.asset_id) ?? [];
    arr.push(e);
    calByAsset.set(e.asset_id, arr);
  }

  // driver_asset_prefs fallback — one query for every asset in scope.
  const prefByAsset = new Map<number, number>();
  if (assetIdsInScope.length > 0) {
    const { data: prefs } = await supabase
      .from("driver_asset_prefs")
      .select("asset_id, driver_id")
      .eq("org_id", orgId)
      .in("asset_id", assetIdsInScope);
    for (const p of (prefs ?? []) as Array<{ asset_id: number; driver_id: number }>) {
      prefByAsset.set(p.asset_id, p.driver_id);
    }
  }

  const milesByDriverId = new Map<number, number>();
  let milesUnattributed = 0;
  for (const p of periods) {
    if (p.miles == null || p.miles <= 0) continue;
    const assetId = vehicleIdToAssetId.get(String(p.vehicle_id));
    if (assetId == null) { milesUnattributed += p.miles; continue; }

    const naiveMt = utcIsoToNaiveMt(p.start_time);
    if (!naiveMt) { milesUnattributed += p.miles; continue; }

    // Waterfall: covering → most-recent-ending → asset default.
    const candidates = calByAsset.get(assetId) ?? [];
    let driverId: number | null = null;
    let bestActive: CalEventRow | null = null;
    for (const e of candidates) {
      if (e.start <= naiveMt && e.end >= naiveMt) {
        if (!bestActive || e.end < bestActive.end) bestActive = e;
      }
    }
    if (bestActive) {
      driverId = bestActive.driver_id;
    } else {
      let bestPrior: CalEventRow | null = null;
      for (const e of candidates) {
        if (e.end <= naiveMt) {
          if (!bestPrior || e.end > bestPrior.end) bestPrior = e;
        }
      }
      if (bestPrior) driverId = bestPrior.driver_id;
    }
    if (driverId == null) driverId = prefByAsset.get(assetId) ?? null;

    if (driverId != null && nameById.has(driverId)) {
      milesByDriverId.set(driverId, (milesByDriverId.get(driverId) ?? 0) + p.miles);
    } else {
      milesUnattributed += p.miles;
    }
  }

  // ── (4) Aggregate events per driver, computing penalty as we go ────
  type Acc = {
    totalEvents:    number;
    moderateEvents: number;
    severeEvents:   number;
    penaltyTotal:   number;
  };
  const acc = new Map<number, Acc>();
  const prevAcc = new Map<number, Acc>();

  function bump(
    bucket: Map<number, Acc>,
    driverId: number,
    eventPenalty: number,
    level: "low" | "moderate" | "severe",
  ) {
    const a = bucket.get(driverId) ?? { totalEvents: 0, moderateEvents: 0, severeEvents: 0, penaltyTotal: 0 };
    a.totalEvents++;
    if (level === "moderate") a.moderateEvents++;
    if (level === "severe")   a.severeEvents++;
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
    bump(acc, driverId, eventPenalty, sev.level);
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
    bump(prevAcc, driverId, eventPenalty, sev.level);
  }

  // ── (5) Compute score per driver + fleet aggregates ────────────────
  //
  // Two-pass: first compute each driver's penaltyPer1kMi, then compute
  // the fleet median from drivers with meaningful miles, then convert
  // penalty → score using the median-anchored curve. Second pass makes
  // the score self-calibrate to the fleet.
  const perDriver = drivers.map(d => {
    const a = acc.get(d.id) ?? { totalEvents: 0, moderateEvents: 0, severeEvents: 0, penaltyTotal: 0 };
    const pa = prevAcc.get(d.id) ?? { totalEvents: 0, moderateEvents: 0, severeEvents: 0, penaltyTotal: 0 };
    const miles = milesByDriverId.get(d.id) ?? 0;
    // Bayesian denominator (miles + PRIOR_MILES) — see PRIOR_MILES doc.
    // Ratio is only meaningful when the driver actually drove; miles=0
    // stays at 0 penalty (score comes back null via MIN_MILES_FOR_SCORE
    // check below anyway).
    const denominator = (miles + PRIOR_MILES) / 1000;
    const penaltyPer1kMi = miles > 0 ? a.penaltyTotal / denominator : 0;
    // Prev-period trend uses the CURRENT window's miles as a proxy
    // denominator — Motive's miles table would double the query cost
    // to fetch prev-period miles, and the trend is only meaningful when
    // the driver is still active anyway.
    const prevPenaltyPer1k = miles > 0 ? pa.penaltyTotal / denominator : 0;
    return { driver: d, acc: a, prevAcc: pa, miles, penaltyPer1kMi, prevPenaltyPer1k };
  });

  // Fleet-median penalty across drivers with enough miles to make their
  // per-mile rate stable. Fewer than N eligible drivers → fall back to
  // a hardcoded reference so the score doesn't swing wildly on a
  // 2-driver fleet.
  const eligibleForMedian = perDriver
    .filter(r => r.miles >= MIN_MILES_FOR_MEDIAN)
    .map(r => r.penaltyPer1kMi);
  const fleetMedianPenalty = eligibleForMedian.length >= MIN_MEDIAN_ELIGIBLE_DRIVERS
    ? median(eligibleForMedian) ?? FALLBACK_MEDIAN_PENALTY
    : FALLBACK_MEDIAN_PENALTY;

  const rowsUnranked: Array<Omit<DriverSafetyScoreRow, "rank">> = perDriver.map(r => {
    const { driver: d, acc: a, miles, penaltyPer1kMi, prevPenaltyPer1k } = r;

    // Score is null when we don't have enough miles to trust the
    // per-mile rate. Below MIN_MILES_FOR_SCORE a single event would
    // swing the number wildly, so we show "insufficient data" instead
    // of a misleading 0 or 100.
    const safetyScore = miles >= MIN_MILES_FOR_SCORE
      ? scoreFromPenalty(penaltyPer1kMi, fleetMedianPenalty)
      : null;
    const prevSafetyScore = miles >= MIN_MILES_FOR_SCORE
      ? scoreFromPenalty(prevPenaltyPer1k, fleetMedianPenalty)
      : null;

    // Auto-flag: severe events drive it, not total. Two severe events
    // in a month with enough miles to matter and a below-60 score
    // trips the coaching signal.
    const flagged =
      safetyScore != null &&
      safetyScore < FLAG_MAX_SCORE &&
      a.severeEvents >= FLAG_MIN_SEVERE &&
      miles >= FLAG_MIN_MILES;

    return {
      driverId:        d.id,
      driverName:      d.name,
      safetyScore,
      totalEvents:     a.totalEvents,
      moderateEvents:  a.moderateEvents,
      severeEvents:    a.severeEvents,
      milesDriven:     Math.round(miles * 10) / 10,
      penaltyPer1kMi:  Math.round(penaltyPer1kMi * 100) / 100,
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
    driverCount:        rows.length,
    fleetMedian,
    fleetMean,
    fleetMiles:         Math.round(Array.from(milesByDriverId.values()).reduce((a, b) => a + b, 0) * 10) / 10,
    fleetEvents:        (currRows ?? []).length,
    fleetMedianPenalty: Math.round(fleetMedianPenalty * 100) / 100,
    medianIsFallback:   eligibleForMedian.length < MIN_MEDIAN_ELIGIBLE_DRIVERS,
    fromDate:           isoDate(from),
    toDate:             isoDate(to),
    days,
  };

  return c.json({ drivers: rows, fleet } satisfies ListDriverSafetyScoresResponse);
});

/** UTC epoch ms → naive Mountain-Time "YYYY-MM-DDTHH:mm" string for
 *  string-compare against events.start / events.end (which are stored
 *  as naive Mountain Time — see events schema comment). Same helper as
 *  the one in performance-events.ts; duplicated locally to avoid a
 *  cross-route import and keep the scoring endpoint self-contained. */
function utcMsToNaiveMt(ms: number): string | null {
  if (!isFinite(ms)) return null;
  return utcIsoToNaiveMt(new Date(ms).toISOString());
}
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

/** Convert a driver's penalty-per-1000-miles to a 0–100 score using
 *  the fleet-median-anchored curve. Median penalty → 80, zero → 100,
 *  2× median → 40, 3× or worse → 0. Piecewise linear on each side of
 *  the median so the curve stays interpretable.
 *
 *  When the median is at or near zero (a clean fleet with no eligible
 *  drivers), we cap the low end so a driver with any penalty doesn't
 *  divide by zero and collapse to 0. */
function scoreFromPenalty(penalty: number, medianPen: number): number {
  // No events attributed → perfect score. This branch is the whole
  // point of the fix: a driver who did nothing wrong should not have
  // their score bounced around by the fleet median.
  if (penalty <= 0) return 100;
  // Anchor floor prevents a squeaky-clean fleet's tiny median from
  // producing a "3× median" band so small that a driver's first
  // moderate event crashes them to 0.
  const effectiveMedian = Math.max(medianPen, MIN_EFFECTIVE_MEDIAN);
  if (penalty <= effectiveMedian) {
    // 80 at median, 100 at 0 — linear.
    const raw = MEDIAN_ANCHOR_SCORE + (100 - MEDIAN_ANCHOR_SCORE) * (effectiveMedian - penalty) / effectiveMedian;
    return Math.round(clamp(raw, MEDIAN_ANCHOR_SCORE, 100));
  }
  const upperBound = effectiveMedian * 3;
  if (penalty >= upperBound) return MIN_SCORE_FLOOR;
  // MEDIAN_ANCHOR at median, MIN_SCORE_FLOOR at 3× median — linear.
  const raw = MEDIAN_ANCHOR_SCORE - (MEDIAN_ANCHOR_SCORE - MIN_SCORE_FLOOR) * (penalty - effectiveMedian) / (upperBound - effectiveMedian);
  return Math.round(clamp(raw, MIN_SCORE_FLOOR, MEDIAN_ANCHOR_SCORE));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : sorted[mid];
}

export default safetyScoring;
