/**
 * /v1/pay-routes — routes, their pay history from settled payroll, the
 * standards set on them, and suggested pay for legs (lib/routePay.ts).
 *
 *   GET   /                 every route with paid history or a standard
 *   POST  /suggest          { legs: [{ key, eventId? | stops?, legIndex? }] }
 *   PUT   /standard         { routeKey, amount | null, note? } — null clears
 *   PUT   /name             { routeKey, name | null } — null clears
 *   PATCH /places/:id       { name }
 *
 * Suggestions are for anyone who can see driver pay (they show next to the
 * pay field on a load as well as on payroll); the routes list and setting
 * standards are payroll's.
 */

import { Hono } from "hono";
import type { ApiErrorResponse, PaySuggestRequest } from "@fleetcal/types";
import type { AuthVariables } from "../middleware/clerk.js";
import { requireAnyCapability, requireCapability, requireModule } from "../middleware/require.js";
import { getUserDisplayName } from "../lib/clerk.js";
import { RoutePayUnavailableError, listPayRoutes, renamePlace, setRouteName, setRouteStandard, suggestPay } from "../lib/routePay.js";

const payRoutes = new Hono<{ Variables: AuthVariables }>();
payRoutes.use("*", requireModule("payroll"));

const fail = (err: unknown) => {
  if (err instanceof RoutePayUnavailableError) {
    return { status: 409 as const, body: { error: "route_pay_unavailable", detail: err.message } satisfies ApiErrorResponse };
  }
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[pay-routes]", detail);
  return { status: 500 as const, body: { error: "route_pay_failed", detail } satisfies ApiErrorResponse };
};

payRoutes.get("/", requireCapability("payroll.access"), async (c) => {
  try {
    return c.json(await listPayRoutes(c.get("orgId")));
  } catch (err) {
    const f = fail(err);
    return c.json(f.body, f.status);
  }
});

payRoutes.post("/suggest", requireAnyCapability("payroll.access", "loads.view_driver_pay"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as PaySuggestRequest | null;
  if (!body || !Array.isArray(body.legs) || body.legs.length > 500
    || body.legs.some((l) => !l || typeof l.key !== "string" || (!l.eventId && !Array.isArray(l.stops)))) {
    return c.json({ error: "validation_failed", errors: ["legs: up to 500 of { key, eventId } or { key, stops, legIndex? }"] } satisfies ApiErrorResponse, 400);
  }
  try {
    return c.json({ suggestions: await suggestPay(c.get("orgId"), body) });
  } catch (err) {
    const f = fail(err);
    return c.json(f.body, f.status);
  }
});

payRoutes.put("/standard", requireCapability("payroll.adjust"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { routeKey?: unknown; amount?: unknown; note?: unknown } | null;
  const routeKey = typeof body?.routeKey === "string" && /^\d+(>\d+)+$/.test(body.routeKey) ? body.routeKey : null;
  const amount = body?.amount === null ? null : typeof body?.amount === "number" && body.amount >= 0 && body.amount < 100_000 ? body.amount : undefined;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  if (!routeKey || amount === undefined) {
    return c.json({ error: "validation_failed", errors: ["routeKey (place ids joined by '>') and amount (number, or null to clear) are required"] } satisfies ApiErrorResponse, 400);
  }
  try {
    const userId = c.get("userId");
    await setRouteStandard(c.get("orgId"), routeKey, amount, note, {
      id: userId, name: await getUserDisplayName(userId).catch(() => null),
    });
    return c.json({ ok: true });
  } catch (err) {
    const f = fail(err);
    return c.json(f.body, f.status);
  }
});

payRoutes.put("/name", requireCapability("payroll.adjust"), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { routeKey?: unknown; name?: unknown } | null;
  const routeKey = typeof body?.routeKey === "string" && /^\d+(>\d+)+$/.test(body.routeKey) ? body.routeKey : null;
  const name = body?.name === null ? null : typeof body?.name === "string" ? body.name.trim().slice(0, 120) : undefined;
  if (!routeKey || name === undefined) {
    return c.json({ error: "validation_failed", errors: ["routeKey and name (text, or null to clear) are required"] } satisfies ApiErrorResponse, 400);
  }
  try {
    const userId = c.get("userId");
    await setRouteName(c.get("orgId"), routeKey, name || null, await getUserDisplayName(userId).catch(() => null));
    return c.json({ ok: true });
  } catch (err) {
    const f = fail(err);
    return c.json(f.body, f.status);
  }
});

payRoutes.patch("/places/:id", requireCapability("payroll.adjust"), async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!Number.isInteger(id) || !name) {
    return c.json({ error: "validation_failed", errors: ["a place id and a name are required"] } satisfies ApiErrorResponse, 400);
  }
  try {
    await renamePlace(c.get("orgId"), id, name);
    return c.json({ ok: true });
  } catch (err) {
    const f = fail(err);
    return c.json(f.body, f.status);
  }
});

export default payRoutes;
