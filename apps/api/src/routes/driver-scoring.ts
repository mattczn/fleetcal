/**
 * /v1/driver-scoring — per-driver accountability scorecard (Curzon-only).
 *
 * Feeds the monthly bonus program + weekly cleanliness deductions. There is
 * NO stored scoring state: every number is derived on demand from data we
 * already capture, so the score can never drift out of sync with the source
 * records.
 *
 *   GET /v1/driver-scoring?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Score model (transparent, weights echoed to the client):
 *   completionPct = inspectionDays / activeDays, capped at 100
 *       activeDays     = distinct days the driver had a load event
 *       inspectionDays = distinct days they submitted ≥1 inspection
 *   dirtyIncidents = cleanliness deductions applied to the driver in-range
 *       (payroll_adjustments linked to a flagged inspection — see below)
 *   score = clamp(completionPct − dirtyIncidents × DIRTY_PENALTY, 0, 100)
 *   bonusEligible = score ≥ BONUS_THRESHOLD AND dirtyIncidents === 0
 *
 * Cleanliness attribution: a "left dirty" flag is filed by the driver who
 * *discovered* it, but the deduction (the "+ Deduction" button on the web
 * dirty panel) is charged to whoever left it dirty — the operator picks the
 * driver, so we count by the deduction's driver_name, not the inspection's
 * driver. We only count deductions whose inspection_report_id points at a
 * cleanliness flag inside the window, so the count tracks real incidents.
 */

import { Hono } from "hono";
import type { ListDriverScoresResponse, DriverScore, ApiErrorResponse } from "@fleetcal/types";

import { supabase } from "../lib/supabase.js";
import { loadExcludedDrivers } from "../lib/reportExclusions.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireTruckHistoryOrg } from "../middleware/require.js";

const scoring = new Hono<{ Variables: AuthVariables }>();

// Curzon-only, same gate as the Truck History module. 404 on denial.
scoring.use("*", requireTruckHistoryOrg);

// ── Score weights (tune here) ─────────────────────────────────────────────
const DIRTY_PENALTY   = 10; // points lost per cleanliness deduction
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
  const idByName = new Map<string, number>();
  for (const d of drivers) {
    nameById.set(d.id, d.name);
    idByName.set((d.name ?? "").trim(), d.id);
  }

  // ── (2) inspection reports in-range ─────────────────────────────────────
  // inspection_reports isn't in the generated Database types yet; cast
  // around it (same as the inspection-reports + driver routes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inspRows, error: iErr } = await (supabase as any)
    .from("inspection_reports")
    .select("id,driver_id,kind,inspection_date,cleanliness_flagged")
    .eq("org_id", orgId)
    .gte("inspection_date", from)
    .lte("inspection_date", to);
  if (iErr) {
    console.error("[GET /v1/driver-scoring] inspections failed:", iErr);
    return c.json({ error: "fetch_failed", detail: iErr.message } satisfies ApiErrorResponse, 500);
  }
  const inspections = (inspRows ?? []) as Array<{
    id: string; driver_id: number; kind: string | null;
    inspection_date: string; cleanliness_flagged: boolean | null;
  }>;
  const flaggedIds = inspections.filter(i => i.cleanliness_flagged).map(i => i.id);

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

  // ── (4) cleanliness deductions linked to in-range flags ─────────────────
  //     Only inspection-linked adjustments count as cleanliness incidents.
  const dedByDriver = new Map<string, { count: number; total: number }>();
  if (flaggedIds.length) {
    const { data: adjRows, error: aErr } = await supabase
      .from("payroll_adjustments")
      .select("driver_name,amount,inspection_report_id")
      .eq("org_id", orgId)
      .in("inspection_report_id", flaggedIds);
    if (aErr) {
      console.error("[GET /v1/driver-scoring] adjustments failed:", aErr);
      return c.json({ error: "fetch_failed", detail: aErr.message } satisfies ApiErrorResponse, 500);
    }
    for (const a of (adjRows ?? []) as Array<{ driver_name: string; amount: number | string }>) {
      const name = (a.driver_name ?? "").trim();
      const prev = dedByDriver.get(name) ?? { count: 0, total: 0 };
      prev.count += 1;
      prev.total += Math.abs(Number(a.amount) || 0);
      dedByDriver.set(name, prev);
    }
  }

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
    a.inspectionDays.add(insp.inspection_date);
    if (insp.kind === "pre_trip") a.preTrips += 1;
    else if (insp.kind === "post_trip") a.postTrips += 1;
  }

  const scores: DriverScore[] = [];
  // Union of drivers that have any activity, inspections, or deductions.
  const activeIds = new Set<number>(acc.keys());
  for (const [name] of dedByDriver) { const id = idByName.get(name); if (id != null) activeIds.add(id); }

  for (const driverId of activeIds) {
    const name = nameById.get(driverId);
    if (!name) continue; // owner-op / unknown — skip
    const a = acc.get(driverId) ?? { activeDays: new Set<string>(), inspectionDays: new Set<string>(), preTrips: 0, postTrips: 0 };
    const activeDays = a.activeDays.size;
    const inspectionDays = a.inspectionDays.size;
    const completionPct = activeDays > 0
      ? clamp(Math.round((inspectionDays / activeDays) * 100), 0, 100)
      : (inspectionDays > 0 ? 100 : 0);
    const ded = dedByDriver.get(name.trim()) ?? { count: 0, total: 0 };
    const score = clamp(completionPct - ded.count * DIRTY_PENALTY, 0, 100);
    scores.push({
      driverId,
      driverName: name,
      activeDays,
      inspectionDays,
      preTrips: a.preTrips,
      postTrips: a.postTrips,
      completionPct,
      dirtyIncidents: ded.count,
      deductionTotal: ded.total,
      score,
      bonusEligible: score >= BONUS_THRESHOLD && ded.count === 0,
    });
  }

  scores.sort((x, y) => y.score - x.score || x.driverName.localeCompare(y.driverName));

  const res: ListDriverScoresResponse = {
    from, to, scores,
    weights: { bonusThreshold: BONUS_THRESHOLD, dirtyPenalty: DIRTY_PENALTY },
  };
  return c.json(res);
});

export default scoring;
