/**
 * /v1/lanes — quote targets by region pair (lib/laneRates.ts).
 *
 *   GET  /rates     market, cost, break-even and target per region pair
 *   PUT  /targets   { key: 'fromAreaId>toAreaId', amount | null } — null clears
 *
 * For anyone who can see load prices; setting a target also needs loads.edit.
 * Areas and driver-pay lanes are drawn and priced under /v1/pay-routes.
 */

import { Hono } from "hono";
import type { ApiErrorResponse } from "@fleetcal/types";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireCapability } from "../middleware/require.js";
import { getUserDisplayName } from "../lib/clerk.js";
import { laneRates } from "../lib/laneRates.js";
import { mergeRateConfig, readRateConfig, writeRateConfig } from "../lib/rateCard.js";

const lanes = new Hono<{ Variables: AuthVariables }>();

lanes.get("/rates", requireCapability("loads.view_price"), async (c) => {
  try {
    return c.json(await laneRates(c.get("orgId")));
  } catch (err) {
    console.error("[lanes] rates failed:", err);
    return c.json({ error: "lane_rates_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse, 500);
  }
});

lanes.put("/targets", requireCapability("loads.view_price"), requireCapability("loads.edit"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json().catch(() => null) as { key?: unknown; amount?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  const { config: current, available } = await readRateConfig(orgId);
  if (!available) {
    return c.json({ error: "route_pay_unavailable", detail: "Run 20261019_route_pay_config.sql first." } satisfies ApiErrorResponse, 409);
  }
  const { config, errors } = mergeRateConfig(current, { pairTargets: { [key]: body?.amount ?? null } });
  if (!config) return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
  try {
    await writeRateConfig(orgId, config, await getUserDisplayName(c.get("userId")).catch(() => null));
    return c.json({ key, amount: config.pairTargets?.[key] ?? null });
  } catch (err) {
    console.error("[lanes] target write failed:", err);
    return c.json({ error: "lane_target_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse, 500);
  }
});

export default lanes;
