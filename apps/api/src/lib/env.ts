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
} as const;

export const isProd = env.nodeEnv === "production";
