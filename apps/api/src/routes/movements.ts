/**
 * /v1/movements — Motive driving-periods feed for the dispatcher
 * calendar's "Movements" mode.
 *
 *   POST /v1/movements/sync   — manual trigger (backfill or incremental).
 *                               Body: { mode: 'backfill' | 'incremental',
 *                                       windowDays?: number }
 *   GET  /v1/movements        — calendar feed for ?from=&to= (ISO dates),
 *                               returns display_eligible movements
 *                               grouped/keyed by vehicleId.
 */

import { Hono } from "hono";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { syncBackfill, syncIncremental } from "../lib/motiveIngest.js";

const movements = new Hono<{ Variables: AuthVariables }>();

// ── Manual sync (dispatcher / admin button) ─────────────────────────────

movements.post("/sync", requireCapability("org.settings.edit"), async (c) => {
  const orgId = c.get("orgId");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const mode = body?.mode === "backfill" ? "backfill" : "incremental";
  const windowDays = Number.isFinite(body?.windowDays) ? Math.max(1, Math.min(90, body.windowDays)) : 7;

  try {
    const result = mode === "backfill"
      ? await syncBackfill(orgId, {
          startDate: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000),
          endDate:   new Date(),
        })
      : await syncIncremental(orgId);
    return c.json({ ok: true, result });
  } catch (err) {
    console.error("[POST /v1/movements/sync] failed:", err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// ── Calendar feed ───────────────────────────────────────────────────────

interface MovementCard {
  id:             number;
  vehicleId:      number;
  vehicleNumber:  string | null;
  startTime:      string;
  endTime:        string | null;
  miles:          number | null;
  durationMin:    number | null;
  origin:         string | null;
  destination:    string | null;
}

interface ListMovementsResponse {
  /** Keyed by vehicleId (Motive's). The dispatcher web maps these to
   *  our asset.id via assets.motive_vehicle_id at render time. */
  byVehicle: Record<string, MovementCard[]>;
}

movements.get("/", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const from = url.searchParams.get("from");
  const to   = url.searchParams.get("to");
  if (!from || !to) {
    return c.json({ error: "validation_failed", errors: ["from and to required (ISO timestamps)"] }, 400);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("motive_driving_periods")
    .select(
      "id, vehicle_id, vehicle_number, start_time, end_time, miles, duration, origin, destination",
    )
    .eq("org_id", orgId)
    .eq("display_eligible", true)
    .gte("start_time", from)
    .lte("start_time", to)
    .order("start_time", { ascending: true });
  if (error) {
    console.error("[GET /v1/movements] failed:", error);
    return c.json({ error: "fetch_failed", detail: error.message }, 500);
  }

  const byVehicle: Record<string, MovementCard[]> = {};
  for (const r of ((data ?? []) as unknown as Array<{
    id: number; vehicle_id: number | null; vehicle_number: string | null;
    start_time: string; end_time: string | null; miles: number | null;
    duration: number | null; origin: string | null; destination: string | null;
  }>)) {
    if (r.vehicle_id == null) continue;
    const key = String(r.vehicle_id);
    const card: MovementCard = {
      id:            r.id,
      vehicleId:     r.vehicle_id,
      vehicleNumber: r.vehicle_number,
      startTime:     r.start_time,
      endTime:       r.end_time,
      miles:         r.miles,
      durationMin:   r.duration != null ? Math.round(r.duration / 60) : null,
      origin:        r.origin,
      destination:   r.destination,
    };
    const arr = byVehicle[key] ?? [];
    arr.push(card);
    byVehicle[key] = arr;
  }

  const res: ListMovementsResponse = { byVehicle };
  return c.json(res);
});

export default movements;
