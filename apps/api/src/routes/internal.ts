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
import { runCrmFmcsaSyncSweep, syncCrmLeadsForOrg } from "../jobs/crmFmcsaSyncSweep.js";
import { runCrmSendSweep } from "../jobs/crmSendSweep.js";

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

// Manual CRM FMCSA sync trigger (dev/ops). Body (all optional):
//   { orgId?: string, maxPages?: number, resetCursorToDot?: number }
// Without orgId, sweeps every org in CRM_INTERNAL_ORG_IDS — same code
// path as the 6h cron. resetCursorToDot rewinds the keyset cursor
// (e.g. to backfill recent registrants); inserts stay idempotent.
internal.post("/crm/fmcsa-sync", async (c) => {
  const body = await c.req
    .json<{ orgId?: string; maxPages?: number; resetCursorToDot?: number }>()
    .catch(() => ({} as { orgId?: string; maxPages?: number; resetCursorToDot?: number }));
  try {
    if (body.orgId) {
      const result = await syncCrmLeadsForOrg(body.orgId, {
        maxPages: body.maxPages,
        resetCursorToDot: body.resetCursorToDot,
      });
      return c.json({ orgId: body.orgId, result });
    }
    const result = await runCrmFmcsaSyncSweep();
    return c.json(result);
  } catch (err) {
    console.error("[POST /v1/internal/crm/fmcsa-sync] failed:", err);
    return c.json(
      { error: "sync_failed", detail: (err as Error).message },
      500,
    );
  }
});

// Manual CRM outreach send-sweep trigger (dev/ops). Runs both passes
// (materialize + send) for every org in CRM_INTERNAL_ORG_IDS — same
// code path as the 10-minute cron. Idempotent.
internal.post("/crm/send-sweep", async (c) => {
  try {
    const result = await runCrmSendSweep();
    return c.json(result);
  } catch (err) {
    console.error("[POST /v1/internal/crm/send-sweep] failed:", err);
    return c.json(
      { error: "sweep_failed", detail: (err as Error).message },
      500,
    );
  }
});

export default internal;
