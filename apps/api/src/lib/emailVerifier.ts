/**
 * Email-verification provider abstraction.
 *
 * Cold-outreach deliverability requires pre-verifying every recipient
 * address — FMCSA census emails are frequently years stale, and even
 * a 3-5% bounce batch on a fresh domain triggers Google Postmaster
 * spam classification that takes weeks to recover from. We route all
 * enrollment through a verifier first; only `valid` addresses become
 * cold-email targets. Everything else lands on the call queue.
 *
 * NeverBounce is the primary implementation; the interface exists so
 * ZeroBounce/Kickbox/Bouncer can drop in later without touching the
 * job or route code.
 */

import type { CrmEmailVerificationStatus } from "@fleetcal/types";

export interface EmailVerificationResult {
  verdict: CrmEmailVerificationStatus;
  /** Raw provider response — stored for debugging and to enable future
   *  re-classification if provider terminology drifts. */
  raw: unknown;
}

export interface EmailVerifier {
  readonly slug: string;
  verify(email: string): Promise<EmailVerificationResult>;
}

export class EmailVerifierNotConfiguredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "EmailVerifierNotConfiguredError";
  }
}
