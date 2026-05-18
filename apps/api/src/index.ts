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
import invoicesRoute from "./routes/invoices.js";
import assistantRoute from "./routes/assistant.js";
import checkCallsRoute from "./routes/check-calls.js";
import stopsRoute from "./routes/stops.js";
import driverRoute from "./routes/driver.js";
import fuelReportsRoute from "./routes/fuel-reports.js";
import maintenanceReportsRoute from "./routes/maintenance-reports.js";
import maintenanceActionItemsRoute from "./routes/maintenance-action-items.js";
import driverDocumentsRoute from "./routes/driver-documents.js";
import reportsRoute from "./routes/reports.js";
import internalRoute from "./routes/internal.js";
import { sweepAutoDeliver } from "./lib/autoDeliverSweep.js";
import { runConfirmReminders } from "./jobs/confirmReminders.js";
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
authed.route("/invoices", invoicesRoute);
authed.route("/assistant", assistantRoute);
authed.route("/stops", stopsRoute);
// Top-level /check-calls/:id (DELETE). Per-load list/create paths are
// mounted from inside loadsRoute as /loads/:loadId/check-calls.
authed.route("/check-calls", checkCallsRoute);
authed.route("/fuel-reports", fuelReportsRoute);
authed.route("/maintenance-reports", maintenanceReportsRoute);
authed.route("/maintenance-action-items", maintenanceActionItemsRoute);
authed.route("/driver-documents", driverDocumentsRoute);
authed.route("/reports", reportsRoute);

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

// ── Internal cron endpoints (shared-secret auth) ────────────────────────
// Same precedence trick — mounted before /v1 so the Clerk middleware
// doesn't intercept. INTERNAL_CRON_TOKEN gates access.
app.route("/v1/internal", internalRoute);

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

// ── In-process auto-deliver sweep ───────────────────────────────────────
//
// Runs once shortly after startup, then every hour. This makes the
// auto-deliver behavior work out of the box on a Railway-style single
// container deploy without requiring an external cron service. If we
// ever scale horizontally we'd need to gate this on a "primary
// instance" flag (or move it fully to external cron — the endpoint
// in routes/internal.ts already exists for that).
//
// The sweep itself is idempotent: if multiple workers ran it at once
// the second would simply find nothing to flip.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_STARTUP_DELAY_MS = 30_000;    // wait for app to settle
console.log(`[auto-deliver-sweep] scheduled: startup in ${SWEEP_STARTUP_DELAY_MS / 1000}s, then every ${SWEEP_INTERVAL_MS / 60000}min`);
setTimeout(() => {
  console.log("[auto-deliver-sweep] running startup pass…");
  void sweepAutoDeliver()
    .then((r) => console.log(`[auto-deliver-sweep] startup pass done: swept=${r.swept}`))
    .catch((err) => {
      console.error("[auto-deliver-sweep] startup run failed:", err);
    });
}, SWEEP_STARTUP_DELAY_MS).unref();
setInterval(() => {
  console.log("[auto-deliver-sweep] running hourly pass…");
  void sweepAutoDeliver()
    .then((r) => console.log(`[auto-deliver-sweep] hourly pass done: swept=${r.swept}`))
    .catch((err) => {
      console.error("[auto-deliver-sweep] hourly run failed:", err);
    });
}, SWEEP_INTERVAL_MS).unref();

// ── In-process driver-notification cron ─────────────────────────────────
//
// Runs every 15 minutes — fires the evening confirm sweep,
// pre-pickup reminders, and missing-POD nudges. Configurable per-org
// rules + per-driver overrides live in org_settings / driver_notification_prefs
// and are resolved inside the job (see apps/api/src/jobs/confirmReminders.ts).
//
// Tick cadence (15 min) is half of CRON_WINDOW_MIN (30 min) inside the
// job, so a rule's fire window always catches at least one tick even
// if a previous tick was missed (e.g. brief restart). Idempotency at
// the rule level (driver_evening_sweeps, load_notifications 24h dedup)
// prevents duplicate sends on overlapping ticks.
//
// Safe only with a single replica — if this service is ever scaled
// horizontally we'd need to gate on a "primary instance" flag or
// move the cron to a separate one-shot Railway service.
const CONFIRM_REMINDERS_INTERVAL_MS = 15 * 60 * 1000;
const CONFIRM_REMINDERS_STARTUP_DELAY_MS = 45_000; // wait for app to settle
console.log(`[confirm-reminders] scheduled: startup in ${CONFIRM_REMINDERS_STARTUP_DELAY_MS / 1000}s, then every ${CONFIRM_REMINDERS_INTERVAL_MS / 60000}min`);
function fireConfirmReminders(label: string) {
  void runConfirmReminders()
    .then((r) => {
      const e = r.evening; const p = r.prePickup; const m = r.missingPod;
      console.log(`[confirm-reminders] ${label} done: evening{sent=${e.sent ?? 0},drivers=${e.drivers ?? 0}} prePickup{sent=${p.sent ?? 0},matched=${p.matched ?? 0}} missingPod{sent=${m.sent ?? 0},matched=${m.matched ?? 0}}`);
    })
    .catch((err) => {
      console.error(`[confirm-reminders] ${label} run failed:`, err);
    });
}
setTimeout(() => fireConfirmReminders("startup pass"), CONFIRM_REMINDERS_STARTUP_DELAY_MS).unref();
setInterval(() => fireConfirmReminders("tick"), CONFIRM_REMINDERS_INTERVAL_MS).unref();
