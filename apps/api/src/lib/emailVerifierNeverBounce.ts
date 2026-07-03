/**
 * NeverBounce single-email verification.
 *
 * Docs: developers.neverbounce.com/reference/single-check
 * GET https://api.neverbounce.com/v4.2/single/check?key=…&email=…
 * → { result: 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown', ... }
 *
 * Auth: query-parameter `key` (secret_XXXX…). NeverBounce does NOT
 * accept Authorization bearer tokens.
 *
 * Cost: ~$0.008 per verification at pay-as-you-go; ~$0.004 at 100k+
 * tier. Pre-paid; balance is billed against the account's Bulk Credits.
 *
 * A single verify takes 300-1500ms typical, 8-15s max on slow-mail
 * servers. We cap the fetch at 20s and treat everything else as
 * `unknown` (retryable, doesn't move the lead into a terminal status).
 */

import { env } from "./env.js";
import { EmailVerifierNotConfiguredError, type EmailVerifier, type EmailVerificationResult } from "./emailVerifier.js";
import type { CrmEmailVerificationStatus } from "@fleetcal/types";

const BASE_URL = "https://api.neverbounce.com/v4.2/single/check";

type NeverBounceResult = "valid" | "invalid" | "disposable" | "catchall" | "unknown";
interface NeverBounceResponse {
  status?: string;
  result?: NeverBounceResult;
  message?: string;
  execution_time?: number;
  flags?: string[];
  suggested_correction?: string;
}

function mapVerdict(nb: NeverBounceResult | undefined): CrmEmailVerificationStatus {
  switch (nb) {
    case "valid":      return "valid";
    case "invalid":    return "invalid";
    case "disposable": return "disposable";
    case "catchall":   return "catchall";
    default:           return "unknown";
  }
}

export const neverBounceVerifier: EmailVerifier = {
  slug: "never_bounce",

  async verify(email: string): Promise<EmailVerificationResult> {
    if (!env.neverBounceApiKey) {
      throw new EmailVerifierNotConfiguredError("NEVERBOUNCE_API_KEY not set");
    }
    const url = new URL(BASE_URL);
    url.searchParams.set("key", env.neverBounceApiKey);
    url.searchParams.set("email", email);
    // Give the verifier plenty of time on a slow server. Anything past
    // this and we bail — the batch keeps moving.
    url.searchParams.set("timeout", "15");

    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      // 5xx: NeverBounce transient; verdict=unknown so the batch keeps
      // moving and we retry next run.
      if (res.status >= 500) {
        return { verdict: "unknown", raw: { httpStatus: res.status, error: "provider_5xx" } };
      }
      throw new Error(`NeverBounce ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
    }

    const json = (await res.json()) as NeverBounceResponse;
    // API-level failure ({status: 'auth_failure'|'general_failure'|...})
    if (json.status && json.status !== "success") {
      throw new Error(`NeverBounce error: ${json.status} ${json.message ?? ""}`);
    }
    return { verdict: mapVerdict(json.result), raw: json };
  },
};

/** Resolve the active verifier for the deployment. Extend the switch
 *  when adding other providers; keep the callers agnostic. */
export function getEmailVerifier(): EmailVerifier {
  const provider = env.emailVerifierProvider || "never_bounce";
  switch (provider) {
    case "never_bounce": return neverBounceVerifier;
    default:
      throw new EmailVerifierNotConfiguredError(`Unknown EMAIL_VERIFIER_PROVIDER: ${provider}`);
  }
}
