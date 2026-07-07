/**
 * /v1/driver-scoring — per-driver inspection scorecard (Curzon-only).
 *
 * Scores drivers purely on how consistently they fill in inspections. There
 * is NO stored scoring state: every number is derived on demand from data we
 * already capture, so the score can never drift out of sync.
 *
 *   GET /v1/driver-scoring?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Score model (transparent, weights echoed to the client):
 *   completionPct = inspectionDays / activeDays, capped at 100
 *       activeDays     = distinct days the driver had a load event ("on road")
 *       inspectionDays = distinct days they submitted ≥1 inspection
 *   score = completionPct
 *   bonusEligible = score ≥ BONUS_THRESHOLD
 *
 * Only ONE inspection per day is needed to count that day. Drivers are asked
 * to do both pre- and post-trip, but a day is "covered" as soon as either is
 * submitted — inspectionDays counts distinct days, not distinct inspections.
 *
 * Cleanliness is intentionally OUT of the score: dirty-cab accountability is
 * handled separately (personal follow-up + the "+ Deduction" payroll button
 * on the Equipment dirty panel), so it doesn't touch a driver's score here.
 */

import { Hono } from "hono";
import type { ListDriverScoresResponse, DriverScore, ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { loadExcludedDrivers } from "../lib/reportExclusions.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireTruckHistoryOrg, requireCapability } from "../middleware/require.js";

const scoring = new Hono<{ Variables: AuthVariables }>();

// Curzon-only (404 on denial), AND requires the per-role scorecard.access
// capability — so a maintenance user in an internal org still can't pull
// driver scores unless an admin grants it in the Role Permissions matrix.
scoring.use("*", requireTruckHistoryOrg, requireCapability("scorecard.access"));

// ── Score weights (tune here) ─────────────────────────────────────────────
const BONUS_THRESHOLD = 85; // score needed to be bonus-eligible

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** YYYY-MM-DD of a Date (UTC). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

scoring.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);

  // Default window = trailing 30 days ending today.
  const now = new Date();
  const to   = url.searchParams.get("to")   || isoDate(now);
  const from = url.searchParams.get("from") || isoDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  // to is a date; make the events upper bound inclusive of the whole day.
  const fromTs = `${from}T00:00:00.000Z`;
  const toTs   = `${to}T23:59:59.999Z`;

  // ── (1) drivers (exclude owner-ops flagged out of reports) ──────────────
  const excluded = await loadExcludedDrivers(orgId);
  const { data: driverRows, error: dErr } = await supabase
    .from("drivers")
    .select("id,name")
    .eq("org_id", orgId);
  if (dErr) {
    console.error("[GET /v1/driver-scoring] drivers failed:", dErr);
    return c.json({ error: "fetch_failed", detail: dErr.message } satisfies ApiErrorResponse, 500);
  }
  const drivers = ((driverRows ?? []) as Array<{ id: number; name: string }>)
    .filter(d => !excluded.idSet.has(d.id));
  const nameById = new Map<number, string>();
  for (const d of drivers) nameById.set(d.id, d.name);

  // ── (2) inspection reports in-range ─────────────────────────────────────
  // inspection_reports isn't in the generated Database types yet; cast
  // around it (same as the inspection-reports + driver routes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inspRows, error: iErr } = await (supabase as any)
    .from("inspection_reports")
    .select("driver_id,kind,inspection_date")
    .eq("org_id", orgId)
    .gte("inspection_date", from)
    .lte("inspection_date", to);
  if (iErr) {
    console.error("[GET /v1/driver-scoring] inspections failed:", iErr);
    return c.json({ error: "fetch_failed", detail: iErr.message } satisfies ApiErrorResponse, 500);
  }
  const inspections = (inspRows ?? []) as Array<{
    driver_id: number; kind: string | null; inspection_date: string;
  }>;

  // ── (3) load events in-range → active days ──────────────────────────────
  const { data: evRows, error: eErr } = await supabase
    .from("events")
    .select("driver_id,start")
    .eq("org_id", orgId)
    .not("driver_id", "is", null)
    .gte("start", fromTs)
    .lte("start", toTs)
    .limit(5000);
  if (eErr) {
    console.error("[GET /v1/driver-scoring] events failed:", eErr);
    return c.json({ error: "fetch_failed", detail: eErr.message } satisfies ApiErrorResponse, 500);
  }
  const events = (evRows ?? []) as Array<{ driver_id: number | null; start: string }>;

  // ── Aggregate per driver ────────────────────────────────────────────────
  type Acc = {
    activeDays: Set<string>;
    inspectionDays: Set<string>;
    preTrips: number;
    postTrips: number;
  };
  const acc = new Map<number, Acc>();
  const ensure = (id: number): Acc => {
    let a = acc.get(id);
    if (!a) { a = { activeDays: new Set(), inspectionDays: new Set(), preTrips: 0, postTrips: 0 }; acc.set(id, a); }
    return a;
  };

  for (const ev of events) {
    if (ev.driver_id == null) continue;
    ensure(ev.driver_id).activeDays.add(ev.start.slice(0, 10));
  }
  for (const insp of inspections) {
    if (insp.driver_id == null) continue;
    const a = ensure(insp.driver_id);
    a.inspectionDays.add(insp.inspection_date); // ≥1 inspection covers the day
    if (insp.kind === "pre_trip") a.preTrips += 1;
    else if (insp.kind === "post_trip") a.postTrips += 1;
  }

  const scores: DriverScore[] = [];
  for (const [driverId, a] of acc) {
    const name = nameById.get(driverId);
    if (!name) continue; // owner-op / unknown — skip
    const activeDays = a.activeDays.size;
    const inspectionDays = a.inspectionDays.size;
    const completionPct = activeDays > 0
      ? clamp(Math.round((inspectionDays / activeDays) * 100), 0, 100)
      : (inspectionDays > 0 ? 100 : 0);
    const score = completionPct;
    scores.push({
      driverId,
      driverName: name,
      activeDays,
      inspectionDays,
      preTrips: a.preTrips,
      postTrips: a.postTrips,
      completionPct,
      score,
      bonusEligible: score >= BONUS_THRESHOLD,
    });
  }

  scores.sort((x, y) => y.score - x.score || x.driverName.localeCompare(y.driverName));

  const res: ListDriverScoresResponse = {
    from, to, scores,
    weights: { bonusThreshold: BONUS_THRESHOLD },
  };
  return c.json(res);
});

export default scoring;
