/**
 * FleetCal API server entry.
 *
 * Routes are mounted under /v1. /v1/health is public; everything else
 * requires a valid Clerk session token with an active organization.
 *
 * Deploy: Railway watches this file plus the routes/* tree. If a deploy
 * is needed for changes outside apps/api (e.g. packages/types), nudge
 * this comment to trigger a rebuild.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";

import { env, isProd } from "./lib/env.js";
import { clerkAuth, type AuthVariables } from "./middleware/clerk.js";
import { botAuth } from "./middleware/botAuth.js";
import loadsRoute from "./routes/loads.js";
import closeoutRoute from "./routes/closeout.js";
import botLoadsRoute from "./routes/bot-loads.js";
import eventsRoute from "./routes/events.js";
import documentsRoute from "./routes/documents.js";
import assetsRoute from "./routes/assets.js";
import driversRoute from "./routes/drivers.js";
import customersRoute from "./routes/customers.js";
import trailersRoute from "./routes/trailers.js";
import dispatchersRoute from "./routes/dispatchers.js";
import driverAssetPrefsRoute from "./routes/driver-asset-prefs.js";
import savedLocationsRoute from "./routes/saved-locations.js";
import payrollRoute from "./routes/payroll.js";
import orgSettingsRoute from "./routes/org-settings.js";
import assistantRoute from "./routes/assistant.js";
import checkCallsRoute from "./routes/check-calls.js";
import stopsRoute from "./routes/stops.js";
import driverRoute from "./routes/driver.js";
import pkg from "../package.json" with { type: "json" };

import type { HealthResponse } from "@fleetcal/types";

const app = new Hono<{ Variables: AuthVariables }>();

// ── Global middleware ───────────────────────────────────────────────────

app.use("*", logger());

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin; // server-to-server, native fetch
      // Localhost (web on 3000/4000, mobile dev on 8081-8083, anything else local)
      if (/^http:\/\/localhost:\d+$/.test(origin)) return origin;
      // Any Vercel preview/prod URL
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
      // Future production domain — add here when it exists
      // if (origin === "https://app.fleetcal.com") return origin;
      return null;
    },
    credentials: true,
  }),
);

// ── Public routes ───────────────────────────────────────────────────────

app.get("/v1/health", (c) => {
  const body: HealthResponse = {
    ok:        true,
    service:   "fleetcal-api",
    version:   pkg.version,
    timestamp: new Date().toISOString(),
  };
  return c.json(body);
});

// ── Authenticated routes ────────────────────────────────────────────────

const authed = new Hono<{ Variables: AuthVariables }>();
authed.use("*", clerkAuth);

authed.get("/whoami", (c) =>
  c.json({
    userId: c.get("userId"),
    orgId:  c.get("orgId"),
  }),
);

authed.route("/loads", loadsRoute);
authed.route("/closeout", closeoutRoute);
authed.route("/events", eventsRoute);
authed.route("/documents", documentsRoute);
authed.route("/assets", assetsRoute);
authed.route("/drivers", driversRoute);
authed.route("/customers", customersRoute);
authed.route("/trailers", trailersRoute);
authed.route("/dispatchers", dispatchersRoute);
authed.route("/driver-asset-prefs", driverAssetPrefsRoute);
authed.route("/saved-locations", savedLocationsRoute);
authed.route("/payroll", payrollRoute);
authed.route("/org-settings", orgSettingsRoute);
authed.route("/assistant", assistantRoute);
authed.route("/stops", stopsRoute);
// Top-level /check-calls/:id (DELETE). Per-load list/create paths are
// mounted from inside loadsRoute as /loads/:loadId/check-calls.
authed.route("/check-calls", checkCallsRoute);

// ── Bot routes (API key auth, read-only load access) ────────────────────
// Must be mounted before /v1 so Hono doesn't match /v1/bot/* against the
// Clerk-authenticated group first.

const bot = new Hono<{ Variables: AuthVariables }>();
bot.use("*", botAuth);
bot.route("/loads", botLoadsRoute);
app.route("/v1/bot", bot);

// ── Driver routes (Supabase-JWT auth, scoped to one driver) ─────────────
// Mounted before /v1 to avoid the Clerk middleware. Driver app passes the
// Supabase access_token from its phone-OTP session; driverAuth middleware
// verifies it and resolves to the drivers row.
app.route("/v1/driver", driverRoute);

app.route("/v1", authed);

// ── Error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error("[api] unhandled error:", err);
  return c.json(
    { error: "internal_server_error", ...(isProd ? {} : { message: err.message }) },
    500,
  );
});

// ── Start ───────────────────────────────────────────────────────────────

serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    console.log(`[api] fleetcal-api v${pkg.version} listening on :${info.port}`);
  },
);
