/**
 * /v1/truck-profit — each load's profit and each truck-day's time-of-day
 * blocks on the dashboard's numbers (lib/truckProfit.ts).
 *
 *   GET /?from=&to=&pay=current|avg&assetId=
 *
 * Gated like /weekly-target (it's built from the expense buckets) plus
 * the performance module the truck timeline lives under.
 */

import { Hono } from "hono";
import type { ApiErrorResponse, TruckProfitPay } from "@fleetcal/types";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability, requireModule } from "../middleware/require.js";
import { computeTruckProfit } from "../lib/truckProfit.js";

const truckProfit = new Hono<{ Variables: AuthVariables }>();
truckProfit.use("*", requireModule("performance"), requireModule("expenses"), requireCapability("expenses.access"));

truckProfit.get("/", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const isDay = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  if (!isDay(from) || !isDay(to) || from! > to!) {
    return c.json({ error: "validation_failed", errors: ["from and to must be YYYY-MM-DD with from <= to"] } satisfies ApiErrorResponse, 400);
  }
  if (Date.parse(to!) - Date.parse(from!) > 31 * 86_400_000) {
    return c.json({ error: "validation_failed", errors: ["period can't be longer than 31 days"] } satisfies ApiErrorResponse, 400);
  }
  const pay: TruckProfitPay = c.req.query("pay") === "avg" ? "avg" : "current";
  const assetParam = c.req.query("assetId");
  const assetId = assetParam ? Number(assetParam) : null;
  try {
    return c.json(await computeTruckProfit(c.get("orgId"), {
      from: from!, to: to!, pay, assetId: assetId != null && Number.isFinite(assetId) ? assetId : null,
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[GET /v1/truck-profit]", detail);
    return c.json({ error: "truck_profit_failed", detail } satisfies ApiErrorResponse, 500);
  }
});

export default truckProfit;
