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
  // From-address for outbound invoice emails. Must be on a domain
  // verified in Resend. Defaults to a placeholder that will fail
  // verification so misconfig is obvious in logs.
  invoiceFromEmail:       process.env.INVOICE_FROM_EMAIL || "invoices@fleetcal.app",
  invoiceFromName:        process.env.INVOICE_FROM_NAME  || "FleetCal Invoicing",
} as const;

export const isProd = env.nodeEnv === "production";
