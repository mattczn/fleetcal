/**
 * Strict env loader. Fails loud at startup so we never get halfway through
 * a request before discovering a missing secret.
 *
 * In dev, dotenv pulls from apps/api/.env.local (if present). In prod
 * (Railway), values are injected directly into process.env — no .env file.
 */

import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Load apps/api/.env.local for local dev. Silent if missing — Railway sets
// process.env directly and there's nothing to load.
config({ path: resolve(__dirname, "../../.env.local") });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required env var: ${key}. ` +
      `In dev, copy apps/api/.env.example → apps/api/.env.local and fill it in. ` +
      `In prod, set it on the Railway service.`,
    );
  }
  return value;
}

export const env = {
  port:                   Number(process.env.PORT ?? 8080),
  nodeEnv:                process.env.NODE_ENV ?? "development",
  clerkSecretKey:         required("CLERK_SECRET_KEY"),
  clerkPublishableKey:    required("CLERK_PUBLISHABLE_KEY"),
  supabaseUrl:            required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicApiKey:        required("ANTHROPIC_API_KEY"),
  // Optional — only needed when the Telegram bot is connected.
  botApiKey:              process.env.BOT_API_KEY || undefined,
  botOrgId:               process.env.BOT_ORG_ID || undefined,
  // Optional — invoice email delivery. Without a Resend key the
  // send endpoint refuses email sends (still allows manual/portal).
  resendApiKey:           process.env.RESEND_API_KEY || undefined,
  // The shared transactional From address. ALL outbound invoice
  // emails fly from this single, verified-in-Resend domain. Each
  // send applies a per-org display name (the carrier's company
  // name) and a per-org Reply-To (the carrier's AR email), so the
  // broker sees the carrier on the From line and replies go to
  // the carrier — without us asking every org to verify a domain
  // in our Resend account. This is the pattern Stripe / QuickBooks /
  // Bill.com use.
  invoiceFromEmail:       process.env.INVOICE_FROM_EMAIL || "invoices@fleetcal.app",
  /** Fallback display name used only when the org hasn't set a
   *  company name in its invoice settings. */
  invoiceFromNameFallback: process.env.INVOICE_FROM_NAME  || "Curzon Trucking Invoicing",
  /** Shared secret for internal cron endpoints. When unset, the
   *  endpoint returns 503 so a misconfigured deploy fails loudly. */
  internalCronToken:       process.env.INTERNAL_CRON_TOKEN || undefined,
  /** Mapbox access token for server-side route geometry (route_polyline
   *  compute-on-read). Optional — when unset, the detail endpoints skip
   *  polyline caching and clients fall back to their own route draw. */
  mapboxToken:             process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || undefined,
  /** Comma-separated Clerk org ids allowed to use the INTERNAL sales
   *  CRM (routes/crm.ts + FMCSA sync). Unset = CRM disabled entirely;
   *  requireInternalOrg 404s and the sync job no-ops. */
  crmInternalOrgIds:       (process.env.CRM_INTERNAL_ORG_IDS ?? "")
                             .split(",").map((s) => s.trim()).filter(Boolean),
  /** Optional comma-separated Clerk USER ids additionally allowed —
   *  when set, CRM access requires org allowlist AND user allowlist
   *  (e.g. only the founder, not every org admin). Unset = any member
   *  of an allowlisted org who has the crm.* capabilities. */
  crmInternalUserIds:      (process.env.CRM_INTERNAL_USER_IDS ?? "")
                             .split(",").map((s) => s.trim()).filter(Boolean),
  /** Optional Socrata app token for the FMCSA census pulls
   *  (data.transportation.gov). Works without one, but anonymous
   *  requests get throttled harder. */
  fmcsaSodaAppToken:       process.env.FMCSA_SODA_APP_TOKEN || undefined,
  /** CRM outreach sending identity. MUST be on the dedicated outreach
   *  domain (fleetcalendar.app) — never fleetcal.app, so cold-email
   *  reputation can't touch invoice deliverability. Unset = the send
   *  sweep marks every approved email failed with a clear reason. */
  outreachFromEmail:       process.env.OUTREACH_FROM_EMAIL || undefined,
  outreachFromName:        process.env.OUTREACH_FROM_NAME  || "FleetCal",
  outreachReplyTo:         process.env.OUTREACH_REPLY_TO   || undefined,
  /** Svix signing secret for the Resend webhook (bounce/complaint
   *  ingestion at /v1/crm-public/resend-webhook). Unset = webhook 503s. */
  resendWebhookSecret:     process.env.RESEND_WEBHOOK_SECRET || undefined,
  /** Public API base URL used by CRM email templates only when the
   *  web-side unsubscribe route isn't configured (fallback path). */
  publicApiUrl:            process.env.PUBLIC_API_URL || "https://fleetcalapi-production.up.railway.app",
  /** Public WEB URL used to build user-visible unsubscribe links.
   *  Must be a domain the CRM outreach recipient trusts — Railway
   *  subdomains in a cold email screams "bulk mailer" and tanks
   *  deliverability. The Next.js /unsubscribe/[token] route proxies
   *  to the Railway API. */
  publicWebUrl:            process.env.PUBLIC_WEB_URL || "https://fleetcal.app",
  /** Email-verification provider slug. Only 'never_bounce' shipped
   *  today; the code path exists to swap in ZeroBounce / Kickbox /
   *  Bouncer without touching route or job code. */
  emailVerifierProvider:   process.env.EMAIL_VERIFIER_PROVIDER || "never_bounce",
  /** NeverBounce API key (secret_XXXX). Unset = the verify endpoints
   *  fail loudly and enrollment falls back to require manual verify. */
  neverBounceApiKey:       process.env.NEVERBOUNCE_API_KEY || undefined,
  /** Twilio SMS creds for outbound driver-facing messages
   *  (paystub links; other transactional flows later). Any missing
   *  value disables SMS sending — the paystub send endpoint still
   *  fires push and stamps a send_error so the UI can surface why
   *  SMS didn't go. Driver-app OTP is done via Supabase phone auth
   *  and uses its OWN Twilio config in the Supabase dashboard —
   *  these vars are only for our direct-from-Railway sends. */
  twilioAccountSid:        process.env.TWILIO_ACCOUNT_SID || undefined,
  twilioAuthToken:         process.env.TWILIO_AUTH_TOKEN  || undefined,
  twilioFromNumber:        process.env.TWILIO_FROM_NUMBER || undefined,
} as const;

export const isProd = env.nodeEnv === "production";
