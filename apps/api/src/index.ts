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
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import * as Sentry from "@sentry/node";

import { env, isProd } from "./lib/env.js";
import { clerkAuth, type AuthVariables } from "./middleware/clerk.js";
import { botAuth } from "./middleware/botAuth.js";
import { captureErrors } from "./middleware/captureErrors.js";
import loadsRoute from "./routes/loads.js";
import closeoutRoute from "./routes/closeout.js";
import botLoadsRoute from "./routes/bot-loads.js";
import botEmailThreadRoute from "./routes/bot-email-thread.js";
import eventsRoute from "./routes/events.js";
import documentsRoute from "./routes/documents.js";
import notificationsRoute from "./routes/notifications.js";
import assetsRoute from "./routes/assets.js";
import driversRoute from "./routes/drivers.js";
import customersRoute from "./routes/customers.js";
import trailersRoute from "./routes/trailers.js";
import dispatchersRoute from "./routes/dispatchers.js";
import driverAssetPrefsRoute from "./routes/driver-asset-prefs.js";
import savedLocationsRoute from "./routes/saved-locations.js";
import payrollRoute from "./routes/payroll.js";
import driverScoringRoute from "./routes/driver-scoring.js";
import orgSettingsRoute from "./routes/org-settings.js";
import invoicesRoute from "./routes/invoices.js";
import checkCallsRoute from "./routes/check-calls.js";
import stopsRoute from "./routes/stops.js";
import driverRoute from "./routes/driver.js";
import fuelReportsRoute from "./routes/fuel-reports.js";
import { fuelTxApiKey, fuelTxClerk } from "./routes/fuel-transactions.js";
import { odoApiKey, odoClerk } from "./routes/odometer-readings.js";
import maintenanceReportsRoute from "./routes/maintenance-reports.js";
import inspectionReportsRoute from "./routes/inspection-reports.js";
import maintenanceActionItemsRoute from "./routes/maintenance-action-items.js";
import rampTransactionsRoute from "./routes/ramp-transactions.js";
import expensesRoute from "./routes/expenses.js";
import recurringExpensesRoute from "./routes/recurring-expenses.js";
import expenseEntriesRoute from "./routes/expense-entries.js";
import driverDocumentsRoute from "./routes/driver-documents.js";
import assetDocumentsRoute from "./routes/asset-documents.js";
import trailerDocumentsRoute from "./routes/trailer-documents.js";
import reportsRoute from "./routes/reports.js";
import internalRoute from "./routes/internal.js";
import movementsRoute from "./routes/movements.js";
import timelineRoute from "./routes/timeline.js";
import fleetRoute from "./routes/fleet.js";
import costAnalysisRoute from "./routes/cost-analysis.js";
import capacityRoute from "./routes/capacity.js";
import contactSalesRoute from "./routes/contact-sales.js";
import supportRoute from "./routes/support.js";
import { syncIncrementalAllOrgs, snapshotOdometersAllOrgs } from "./lib/motiveIngest.js";
import { sweepAutoDeliver } from "./lib/autoDeliverSweep.js";
import { runConfirmReminders } from "./jobs/confirmReminders.js";
import { runAiUsageSweep } from "./jobs/aiUsageSweep.js";
import { trackCronRun } from "./lib/cronRun.js";
import { runFuelAutoMatchSweep } from "./jobs/fuelAutoMatchSweep.js";
import { runMudflapSyncSweep } from "./jobs/mudflapSyncSweep.js";
import { runRampSyncSweep } from "./jobs/rampSyncSweep.js";
import { runCrmFmcsaSyncSweep } from "./jobs/crmFmcsaSyncSweep.js";
import { runCrmSendSweep } from "./jobs/crmSendSweep.js";
import { crmRoute } from "./routes/crm.js";
import { crmPublicRoute } from "./routes/crm-public.js";
import pkg from "../package.json" with { type: "json" };

import type { HealthResponse } from "@fleetcal/types";

// Sentry — init BEFORE the Hono app so any startup-time exception
// (env var missing, route registration crash, port-already-in-use) is
// captured. DSN comes from SENTRY_DSN. Missing DSN = no-op, no crash.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:                process.env.SENTRY_DSN,
    environment:        process.env.NODE_ENV ?? "development",
    release:            pkg.version,
    tracesSampleRate:   0.1,
    // Suppress noise from the Hono logger middleware which produces
    // INFO-level breadcrumbs for every request; we only want errors.
    integrations:       (defaults) => defaults,
  });

  // Catch any unhandled async rejection. Process-level rather than per-
  // request because some bugs (lib internals) reject promises that
  // never bubble back to a handler.
  process.on("unhandledRejection", (reason) => {
    console.error("[api] unhandledRejection:", reason);
    Sentry.captureException(reason, { tags: { source: "unhandledRejection" } });
  });
  process.on("uncaughtException", (err) => {
    console.error("[api] uncaughtException:", err);
    Sentry.captureException(err, { tags: { source: "uncaughtException" } });
  });
}

const app = new Hono<{ Variables: AuthVariables }>();

// ── Global middleware ───────────────────────────────────────────────────

app.use("*", logger());

// Capture every 4xx/5xx response into the api_errors table for the
// /admin/errors dashboard. Mounts globally so it sees public routes
// AND authenticated ones — and runs the request-body snapshot BEFORE
// the handler reads the stream. See captureErrors.ts for the long
// explainer + skip rules.
app.use("*", captureErrors);

// Security headers on every response.
//
// What we override vs. Hono's defaults:
//   - HSTS bumped to 1 year (was 6 months) to match the web app and the
//     industry standard. `includeSubDomains` covers any future api.*.fleetcal.app.
//   - xFrameOptions: DENY — nothing should ever embed the API in an iframe.
//   - referrerPolicy: tighter than the default `no-referrer` for our case
//     because we want cross-origin requests from fleetcal.app to be
//     identifiable by origin (not URL) in logs/analytics.
//   - permissionsPolicy: explicitly disable browser APIs the API never
//     needs. Defense in depth against a hypothetical XSS payload trying
//     to read mic/camera/geo through the API origin.
//   - crossOriginResourcePolicy: 'cross-origin' — the API IS called from
//     the fleetcal.app web app, which is a different origin. The default
//     'same-origin' would break every request from the dashboard.
//   - crossOriginEmbedderPolicy disabled — `require-corp` would break
//     embeds of any third-party resources (Stripe webhooks, etc.).
//   - originAgentCluster disabled — niche optimisation that can break
//     shared workers across subdomains.
//
// CSP intentionally not set on the API. Nothing serves HTML here — every
// route returns JSON. A restrictive CSP would be belt-and-braces, but it
// adds no real protection because there's no HTML for a script to execute
// from.
app.use(
  "*",
  secureHeaders({
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions:           "DENY",
    xContentTypeOptions:     "nosniff",
    referrerPolicy:          "strict-origin-when-cross-origin",
    permissionsPolicy:       { geolocation: [], microphone: [], camera: [], usb: [] },
    crossOriginResourcePolicy: "cross-origin",
    crossOriginEmbedderPolicy: false,
    originAgentCluster:        false,
  }),
);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return origin; // server-to-server, native fetch
      // Localhost (web on 3000/4000, mobile dev on 8081-8083, anything else local)
      if (/^http:\/\/localhost:\d+$/.test(origin)) return origin;
      // Any Vercel preview/prod URL
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return origin;
      // Production custom domain — both apex and www
      if (/^https:\/\/(www\.)?fleetcal\.app$/.test(origin)) return origin;
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

// Public broker capacity endpoint — fed to curzontrucking.com /capacity.
// Aggregate counts only, no PII. Optional CAPACITY_API_KEY gate.
app.route("/v1/capacity", capacityRoute);

// Public lead intake — fleetcal.app/contact-sales wizard POSTs here,
// the route emails CONTACT_SALES_TO (defaults to hello@fleetcal.app)
// via Resend. Honeypot + time-gate stops drive-by spam.
app.route("/v1/contact-sales", contactSalesRoute);

// Public support intake — fleetcal.app/support contact form POSTs here
// (this is the apps' App Store / Play Store Support URL). Emails
// SUPPORT_TO (defaults to hello@fleetcal.app). Same honeypot + time-gate.
app.route("/v1/support", supportRoute);

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
authed.route("/notifications", notificationsRoute);
authed.route("/assets", assetsRoute);
authed.route("/drivers", driversRoute);
authed.route("/customers", customersRoute);
authed.route("/trailers", trailersRoute);
authed.route("/dispatchers", dispatchersRoute);
authed.route("/driver-asset-prefs", driverAssetPrefsRoute);
authed.route("/saved-locations", savedLocationsRoute);
authed.route("/payroll", payrollRoute);
authed.route("/driver-scoring", driverScoringRoute);
authed.route("/org-settings", orgSettingsRoute);
authed.route("/invoices", invoicesRoute);
authed.route("/stops", stopsRoute);
// Top-level /check-calls/:id (DELETE). Per-load list/create paths are
// mounted from inside loadsRoute as /loads/:loadId/check-calls.
authed.route("/check-calls", checkCallsRoute);
authed.route("/fuel-reports", fuelReportsRoute);
authed.route("/fuel-transactions", fuelTxClerk);
authed.route("/odometer-readings", odoClerk);
authed.route("/movements", movementsRoute);
authed.route("/timeline",  timelineRoute);
authed.route("/fleet",     fleetRoute);
authed.route("/cost-analysis", costAnalysisRoute);
authed.route("/maintenance-reports", maintenanceReportsRoute);
authed.route("/inspection-reports", inspectionReportsRoute);
authed.route("/maintenance-action-items", maintenanceActionItemsRoute);
authed.route("/ramp-transactions", rampTransactionsRoute);
authed.route("/expenses", expensesRoute);
authed.route("/recurring-expenses", recurringExpensesRoute);
authed.route("/expense-entries", expenseEntriesRoute);
authed.route("/driver-documents", driverDocumentsRoute);
authed.route("/asset-documents", assetDocumentsRoute);
authed.route("/trailer-documents", trailerDocumentsRoute);
authed.route("/reports", reportsRoute);
// INTERNAL sales CRM — triple-gated inside the route group
// (internal-org allowlist → 404, crm module flag, crm.* capabilities).
authed.route("/crm", crmRoute);

// ── Bot routes (API key auth, read-only load access) ────────────────────
// Must be mounted before /v1 so Hono doesn't match /v1/bot/* against the
// Clerk-authenticated group first.

const bot = new Hono<{ Variables: AuthVariables }>();
bot.use("*", botAuth);
bot.route("/loads", botLoadsRoute);
bot.route("/email-thread", botEmailThreadRoute);
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

// CRM public endpoints — unsubscribe links from outreach emails land
// here (token IS the auth) plus the svix-signed Resend webhook. Same
// mount-before-Clerk precedence trick.
app.route("/v1/crm-public", crmPublicRoute);

// Fuel transactions inbound-email — API key auth, NOT Clerk. Must
// mount before /v1 so /v1/fuel-transactions/inbound-email resolves
// here instead of falling through to the Clerk-authed branch.
app.route("/v1/fuel-transactions", fuelTxApiKey);

// Odometer bulk import — same pattern. Lets a sync script POST
// historical readings without juggling Clerk session JWTs.
app.route("/v1/odometer-readings", odoApiKey);

app.route("/v1", authed);

// ── Error handler ───────────────────────────────────────────────────────

app.onError((err, c) => {
  // Capture to Sentry with whatever request context we have. The event
  // ID is what we hand back to the user — they can paste it into a
  // support ticket and we can find the full stack trace in Sentry in
  // one click. If Sentry isn't initialised (no SENTRY_DSN locally),
  // captureException returns undefined and we fall back to a synthetic
  // ID so the error response shape stays consistent.
  const errorId = Sentry.captureException(err, {
    tags: {
      route:  c.req.path,
      method: c.req.method,
      org_id: c.get("orgId") ?? "anonymous",
    },
  }) ?? `local-${Date.now().toString(36)}`;

  console.error(`[api] unhandled error [${errorId}]:`, err);

  return c.json(
    {
      error:   "internal_server_error",
      errorId,
      // Only leak the raw message in non-prod so users don't see stack
      // detail in production, but the error ID always comes back.
      ...(isProd ? {} : { message: err.message }),
    },
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
async function fireAutoDeliverSweep(label: string): Promise<void> {
  console.log(`[auto-deliver-sweep] running ${label}…`);
  try {
    await trackCronRun("auto-deliver-sweep", async () => {
      const r = await sweepAutoDeliver();
      console.log(`[auto-deliver-sweep] ${label} done: swept=${r.swept}`);
      return { meta: { swept: r.swept } };
    });
  } catch (err) {
    console.error(`[auto-deliver-sweep] ${label} failed:`, err);
  }
}
setTimeout(() => void fireAutoDeliverSweep("startup pass"), SWEEP_STARTUP_DELAY_MS).unref();
setInterval(() => void fireAutoDeliverSweep("hourly pass"), SWEEP_INTERVAL_MS).unref();

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
async function fireConfirmReminders(label: string): Promise<void> {
  try {
    await trackCronRun("confirm-reminders", async () => {
      const r = await runConfirmReminders();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = r.evening    as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = r.prePickup  as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = r.missingPod as any;
      console.log(
        `[confirm-reminders] ${label} done: ` +
        `evening{sent=${e.sent ?? 0},drivers=${e.drivers ?? 0},suppressed=${e.suppressed ?? 0},alreadySent=${e.alreadySent ?? 0}} ` +
        `prePickup{sent=${p.sent ?? 0},matched=${p.matched ?? 0},eligible=${p.eligible ?? 0},suppressed=${p.suppressed ?? 0}} ` +
        `missingPod{sent=${m.sent ?? 0},matched=${m.matched ?? 0},eligible=${m.eligible ?? 0},suppressed=${m.suppressed ?? 0}}`,
      );
      return { meta: { evening: e, prePickup: p, missingPod: m } };
    });
  } catch (err) {
    console.error(`[confirm-reminders] ${label} run failed:`, err);
  }
}
setTimeout(() => void fireConfirmReminders("startup pass"), CONFIRM_REMINDERS_STARTUP_DELAY_MS).unref();
setInterval(() => void fireConfirmReminders("tick"), CONFIRM_REMINDERS_INTERVAL_MS).unref();

// ── Motive driving-periods incremental sync ─────────────────────────────
//
// Per-org `updated_after`-cursor pull every MOTIVE_SYNC_INTERVAL_MS
// (default 5 min). Only orgs that have a motive_api_key set get
// queried. Initial backfill is dispatcher-triggered from settings.
//
// Single-replica caveat applies (same as the other in-process crons):
// scaling the API horizontally would duplicate the sync. The cadence
// is conservative enough to make accidental double-runs harmless.

const MOTIVE_SYNC_INTERVAL_MS  = Number(process.env.MOTIVE_SYNC_INTERVAL_MS  ?? 5 * 60 * 1000);
const MOTIVE_SYNC_STARTUP_DELAY = Number(process.env.MOTIVE_SYNC_STARTUP_DELAY_MS ?? 60_000);

async function fireMovementsSync(label: string): Promise<void> {
  try {
    await trackCronRun("motive-sync", async () => {
      const results = await syncIncrementalAllOrgs();
      if (results.length > 0) {
        const total = results.reduce((sum, r) => sum + r.rowsUpserted, 0);
        console.log(`[api] movements sync (${label}): ${results.length} org(s), ${total} rows`);
        return { meta: { orgs: results.length, rowsUpserted: total } };
      }
      return { meta: { orgs: 0, rowsUpserted: 0 } };
    });
  } catch (err) {
    console.error("[api] movements sync failed:", err);
  }
}
setTimeout(() => void fireMovementsSync("startup pass"), MOTIVE_SYNC_STARTUP_DELAY).unref();
setInterval(() => void fireMovementsSync("tick"), MOTIVE_SYNC_INTERVAL_MS).unref();

// ── Daily odometer snapshot ────────────────────────────────────────────
//
// Records one row per Motive-linked vehicle per day. The snapshot
// function itself is idempotent (it skips vehicles that already have
// a row for today UTC), so we can fire-and-forget every hour and miss
// at most one hour of accuracy across DST changes / startup timing.
//
// Default cadence: every hour, gated by the in-snapshot "did we
// already capture today" check. We DON'T do a strict 24h interval
// because container restarts would reset the timer and could skip a
// day entirely.

const ODOMETER_CHECK_INTERVAL_MS = Number(process.env.ODOMETER_CHECK_INTERVAL_MS ?? 60 * 60 * 1000);
const ODOMETER_STARTUP_DELAY_MS  = Number(process.env.ODOMETER_STARTUP_DELAY_MS  ?? 90_000);

async function fireOdometerSnapshot(label: string): Promise<void> {
  try {
    await trackCronRun("odometer-snapshot", async () => {
      const results = await snapshotOdometersAllOrgs();
      const inserted = results.reduce((s, r) => s + r.rowsInserted, 0);
      const skipped  = results.reduce((s, r) => s + r.rowsSkipped,  0);
      if (inserted > 0 || results.length > 0) {
        console.log(`[api] odometer snapshot (${label}): ${results.length} org(s), ${inserted} inserted, ${skipped} skipped (already had today)`);
      }
      return { meta: { orgs: results.length, inserted, skipped } };
    });
  } catch (err) {
    console.error("[api] odometer snapshot failed:", err);
  }
}
setTimeout(() => void fireOdometerSnapshot("startup pass"), ODOMETER_STARTUP_DELAY_MS).unref();
setInterval(() => void fireOdometerSnapshot("hourly tick"), ODOMETER_CHECK_INTERVAL_MS).unref();

// ── Mudflap Carriers API sync ──────────────────────────────────────────
//
// Pulls recent card transactions from the Mudflap Carriers API into
// fuel_transactions on a fixed interval — the automated equivalent of
// the manual "Sync Mudflap" button on the Equipment page. Without it,
// card-side transactions only land when a dispatcher clicks sync; the
// fuel-auto-match sweep below then pairs each one to its driver report.
//
// Pulls a rolling MUDFLAP_SYNC_WINDOW_DAYS-day window (default 3) each
// run. The ingest is idempotent (a duplicate provider_transaction_id
// counts as a duplicate, not an error), so overlapping windows are
// cheap and self-heal any gap from a missed run. See
// jobs/mudflapSyncSweep.ts for the org-scoping + no-token-skip logic.
//
// Cadence: every 30 min — Mudflap delivers a receipt ~30 min after the
// pump swipe, so a 30-min pull keeps card transactions fresh for the
// 15-min match sweep to pair.
//
// Single-replica caveat: same as the other in-process crons. The
// idempotent ingest makes accidental double-runs harmless.

const MUDFLAP_SYNC_INTERVAL_MS   = Number(process.env.MUDFLAP_SYNC_INTERVAL_MS   ?? 30 * 60 * 1000);
const MUDFLAP_SYNC_STARTUP_DELAY = Number(process.env.MUDFLAP_SYNC_STARTUP_DELAY_MS ?? 150_000);

async function fireMudflapSync(label: string): Promise<void> {
  try {
    await trackCronRun("mudflap-sync", async () => {
      const r = await runMudflapSyncSweep();
      if (r.skipped || !r.result) {
        return { meta: { skipped: true, reason: r.reason ?? "skipped" } };
      }
      const { fetched, inserted, duplicates, failed, assetLinked } = r.result;
      if (fetched > 0) {
        console.log(
          `[mudflap-sync] ${label}: fetched=${fetched}, inserted=${inserted}, ` +
          `duplicates=${duplicates}, failed=${failed}, assetLinked=${assetLinked} (${r.from}→${r.to})`,
        );
      }
      return { meta: { fetched, inserted, duplicates, failed, assetLinked, from: r.from, to: r.to } };
    });
  } catch (err) {
    console.error(`[mudflap-sync] ${label} failed:`, err);
  }
}
setTimeout(() => void fireMudflapSync("startup pass"), MUDFLAP_SYNC_STARTUP_DELAY).unref();
setInterval(() => void fireMudflapSync("tick"), MUDFLAP_SYNC_INTERVAL_MS).unref();

// ── Ramp sync ─────────────────────────────────────────────────────────
//
// Pulls a rolling RAMP_SYNC_WINDOW_DAYS-day window (default 7) of Ramp
// card transactions each run into ramp_transactions and runs the memo→
// asset matcher inline. Same env-gated no-op behavior as Mudflap: with
// no RAMP_CLIENT_ID/RAMP_CLIENT_SECRET the sweep skips cleanly. See
// jobs/rampSyncSweep.ts.
//
// Single-replica caveat: same as the other in-process crons. Ingest is
// idempotent (unique constraint on provider_transaction_id) so
// accidental double-runs are safe.

const RAMP_SYNC_INTERVAL_MS   = 30 * 60 * 1000;
const RAMP_SYNC_STARTUP_DELAY = 180_000;

async function fireRampSync(label: string): Promise<void> {
  try {
    await trackCronRun("ramp-sync", async () => {
      const r = await runRampSyncSweep();
      if (r.skipped || !r.result) {
        return { meta: { skipped: true, reason: r.reason ?? "skipped" } };
      }
      const { fetched, inserted, updated, duplicates, failed, autoMatched, notApplicable } = r.result;
      if (fetched > 0) {
        console.log(
          `[ramp-sync] ${label}: fetched=${fetched}, inserted=${inserted}, updated=${updated}, ` +
          `duplicates=${duplicates}, failed=${failed}, autoMatched=${autoMatched}, ` +
          `notApplicable=${notApplicable} (${r.from}→${r.to})`,
        );
      }
      return { meta: { fetched, inserted, updated, duplicates, failed, autoMatched, notApplicable, from: r.from, to: r.to } };
    });
  } catch (err) {
    console.error(`[ramp-sync] ${label} failed:`, err);
  }
}
setTimeout(() => void fireRampSync("startup pass"), RAMP_SYNC_STARTUP_DELAY).unref();
setInterval(() => void fireRampSync("tick"), RAMP_SYNC_INTERVAL_MS).unref();

// ── Fuel auto-match sweep ──────────────────────────────────────────────
//
// Re-attempts matching for unmatched fuel_transactions in the past
// 24h. The inline matcher fires at /inbound-email ingest (the common
// case: driver report exists by the time Mudflap delivers the
// receipt). The sweep catches the asymmetric cases:
//
//   • Driver fueled but filed their report AFTER Mudflap had already
//     polled — the transaction is already in 'unmatched' state, and
//     would stay there forever without a periodic retry.
//   • Dispatcher entered a driver fuel report manually on the
//     driver's behalf, days after the fact.
//   • Inline match transiently failed (DB hiccup, candidate fetch
//     error) — the sweep is a safety net.
//
// Cadence: every 15 min. Mudflap polls every ~30 min, so the worst-
// case lag between transaction arrival and a successful match is
// ~30 min (one Mudflap cycle) + ~15 min (next sweep). The sweep is
// idempotent — matched rows fall out of the `match_status = unmatched`
// filter, so subsequent runs over the same 24h window cost nothing.
//
// Single-replica caveat: same as the other in-process crons. The
// sweep is idempotent so accidental double-runs are harmless, but
// scaling horizontally still wants a primary-instance gate.

const FUEL_AUTO_MATCH_INTERVAL_MS    = Number(process.env.FUEL_AUTO_MATCH_INTERVAL_MS ?? 15 * 60 * 1000);
const FUEL_AUTO_MATCH_STARTUP_DELAY  = Number(process.env.FUEL_AUTO_MATCH_STARTUP_DELAY_MS ?? 120_000);

async function fireFuelAutoMatch(label: string): Promise<void> {
  try {
    await trackCronRun("fuel-auto-match", async () => {
      const result = await runFuelAutoMatchSweep();
      if (result.scanned > 0 || result.matched > 0) {
        console.log(
          `[fuel auto-match] ${label}: scanned=${result.scanned}, matched=${result.matched}` +
          (Object.keys(result.byOrg).length > 1
            ? ` (${Object.entries(result.byOrg).map(([org, b]) => `${org}: ${b.matched}/${b.scanned}`).join(', ')})`
            : ''),
        );
      }
      return { meta: { scanned: result.scanned, matched: result.matched, byOrg: result.byOrg } };
    });
  } catch (err) {
    console.error(`[fuel auto-match] ${label} failed:`, err);
  }
}
setTimeout(() => void fireFuelAutoMatch("startup pass"), FUEL_AUTO_MATCH_STARTUP_DELAY).unref();
setInterval(() => void fireFuelAutoMatch("tick"), FUEL_AUTO_MATCH_INTERVAL_MS).unref();

// ── Daily AI-usage sweep ───────────────────────────────────────────────
//
// Flags orgs over their monthly Anthropic budget cap (or sudden 24h
// volume spikes vs their 7-day baseline) and emails a digest to the
// super-admin allowlist. See jobs/aiUsageSweep.ts for the full flag
// criteria.
//
// Daily cadence: 24h interval with a small startup pass on boot, so
// a deploy never delays the first run by more than a few minutes.
// Idempotent — re-flagging an already-flagged org just refreshes
// flagged_at; no duplicate emails because the digest reports the
// current snapshot, not deltas.
//
// Single-replica caveat: same as the other in-process crons. If the
// service is ever scaled horizontally we'd need to gate on a
// "primary instance" flag — for now the unique deploy is the gate.
const AI_USAGE_SWEEP_INTERVAL_MS   = Number(process.env.AI_USAGE_SWEEP_INTERVAL_MS   ?? 24 * 60 * 60 * 1000);
const AI_USAGE_SWEEP_STARTUP_DELAY = Number(process.env.AI_USAGE_SWEEP_STARTUP_DELAY ?? 5 * 60 * 1000);
async function fireAiUsageSweep(label: string): Promise<void> {
  try {
    await trackCronRun("ai-usage-sweep", async () => {
      const r = await runAiUsageSweep();
      console.log(
        `[ai-usage-sweep] ${label}: flagged=${r.flaggedCount}/${r.totalOrgsSeen}, emailSent=${r.emailSent}`
        + (r.emailError ? ` (email error: ${r.emailError})` : "")
      );
      return { meta: { flagged: r.flaggedCount, total: r.totalOrgsSeen, emailSent: r.emailSent, emailError: r.emailError } };
    });
  } catch (err) {
    console.error(`[ai-usage-sweep] ${label} failed:`, err);
  }
}
setTimeout(() => void fireAiUsageSweep("startup pass"), AI_USAGE_SWEEP_STARTUP_DELAY).unref();
setInterval(() => void fireAiUsageSweep("daily tick"), AI_USAGE_SWEEP_INTERVAL_MS).unref();

// ── CRM FMCSA lead sync (INTERNAL) ─────────────────────────────────────
//
// Ingests newly-registered carriers from the FMCSA census (Socrata)
// into crm_leads for the internal sales CRM. No-ops when
// CRM_INTERNAL_ORG_IDS is unset. The dataset refreshes daily, so a
// 6-hour interval is generous; the CRM UI's "Sync now" button covers
// anything more urgent. Idempotent — duplicate DOT numbers hit the
// (org_id, dot_number) unique index and are counted, not inserted,
// and the keyset cursor persists per page so reruns resume cleanly.
//
// Single-replica caveat: same as the other in-process crons. If the
// service is ever scaled horizontally we'd need to gate on a
// "primary instance" flag — for now the unique deploy is the gate.
const CRM_FMCSA_SYNC_INTERVAL_MS   = Number(process.env.CRM_FMCSA_SYNC_INTERVAL_MS   ?? 6 * 60 * 60 * 1000);
const CRM_FMCSA_SYNC_STARTUP_DELAY = Number(process.env.CRM_FMCSA_SYNC_STARTUP_DELAY ?? 3 * 60 * 1000);
async function fireCrmFmcsaSync(label: string): Promise<void> {
  try {
    await trackCronRun("crm-fmcsa-sync", async () => {
      const r = await runCrmFmcsaSyncSweep();
      if (r.skipped) {
        console.log(`[crm-fmcsa-sync] ${label}: skipped (${r.reason})`);
        return { meta: { skipped: true, reason: r.reason } };
      }
      const summary = (r.orgs ?? [])
        .map((o) => o.error
          ? `${o.orgId}: ERROR ${o.error}`
          : `${o.orgId}: +${o.result?.inserted ?? 0} (${o.result?.duplicates ?? 0} dup, ${o.result?.disqualified ?? 0} dq, cursor=${o.result?.cursorDotNumber ?? "?"})`)
        .join("; ");
      console.log(`[crm-fmcsa-sync] ${label}: ${summary}`);
      return { meta: { orgs: r.orgs } };
    });
  } catch (err) {
    console.error(`[crm-fmcsa-sync] ${label} failed:`, err);
  }
}
setTimeout(() => void fireCrmFmcsaSync("startup pass"), CRM_FMCSA_SYNC_STARTUP_DELAY).unref();
setInterval(() => void fireCrmFmcsaSync("tick"), CRM_FMCSA_SYNC_INTERVAL_MS).unref();

// ── CRM outreach send sweep (INTERNAL) ─────────────────────────────────
//
// Two idempotent passes (see jobs/crmSendSweep.ts): materialize due
// sequence steps into the approval outbox, then send approved emails —
// business-hours window, daily warm-up cap, and a HARD per-email
// suppression re-check inside the send loop immediately before each
// Resend call. approve-batch also kicks this inline for instant sends;
// the 10-minute tick is the backstop. No-ops when CRM_INTERNAL_ORG_IDS
// is unset.
//
// Single-replica caveat: same as the other in-process crons. Double-
// fire is harmless — materialization dedupes on the (enrollment, step)
// unique index and sends claim rows with a conditional UPDATE.
const CRM_SEND_SWEEP_INTERVAL_MS   = Number(process.env.CRM_SEND_SWEEP_INTERVAL_MS   ?? 10 * 60 * 1000);
const CRM_SEND_SWEEP_STARTUP_DELAY = Number(process.env.CRM_SEND_SWEEP_STARTUP_DELAY ?? 4 * 60 * 1000);
async function fireCrmSendSweep(label: string): Promise<void> {
  try {
    await trackCronRun("crm-send-sweep", async () => {
      const r = await runCrmSendSweep();
      if (r.skipped) {
        console.log(`[crm-send-sweep] ${label}: skipped (${r.reason})`);
        return { meta: { skipped: true, reason: r.reason } };
      }
      const summary = (r.orgs ?? [])
        .map((o) => o.error
          ? `${o.orgId}: ERROR ${o.error}`
          : `${o.orgId}: mat=${o.materialized} sent=${o.sent} sup=${o.suppressed} fail=${o.failed}${o.windowOpen === false ? " (window closed)" : ""}`)
        .join("; ");
      console.log(`[crm-send-sweep] ${label}: ${summary}`);
      return { meta: { orgs: r.orgs } };
    });
  } catch (err) {
    console.error(`[crm-send-sweep] ${label} failed:`, err);
  }
}
setTimeout(() => void fireCrmSendSweep("startup pass"), CRM_SEND_SWEEP_STARTUP_DELAY).unref();
setInterval(() => void fireCrmSendSweep("tick"), CRM_SEND_SWEEP_INTERVAL_MS).unref();
