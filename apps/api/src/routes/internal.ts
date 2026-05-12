/**
 * Internal cron endpoints.
 *
 * Protected by a shared bearer token (INTERNAL_CRON_TOKEN). Used by
 * external schedulers (Railway cron, GitHub Actions, cron-job.org) to
 * kick off periodic maintenance jobs. The same jobs also run on an
 * in-process interval inside the API (see index.ts) so the system
 * works out of the box without external infra, but the endpoint
 * lets ops trigger a run on demand or run them at a tighter cadence
 * than the interval default.
 *
 *   POST /v1/internal/auto-deliver
 *     Body: none. Sweeps revenue events whose delivery end is past 24h
 *     and flips them to status='delivered'. Returns { swept, loadIds }.
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env.js";
import { sweepAutoDeliver } from "../lib/autoDeliverSweep.js";

const internal = new Hono();

const internalAuth: MiddlewareHandler = async (c, next) => {
  if (!env.internalCronToken) {
    return c.json(
      { error: "service_unavailable", reason: "internal_cron_not_configured" },
      503,
    );
  }
  const header = c.req.header("Authorization");
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token || token !== env.internalCronToken) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

internal.use("*", internalAuth);

internal.post("/auto-deliver", async (c) => {
  try {
    const result = await sweepAutoDeliver();
    return c.json(result);
  } catch (err) {
    console.error("[POST /v1/internal/auto-deliver] failed:", err);
    return c.json(
      { error: "sweep_failed", detail: (err as Error).message },
      500,
    );
  }
});

export default internal;
