/**
 * CRM email verification — batched.
 *
 * Runs unverified leads' emails through the configured verifier
 * (NeverBounce today) and writes the verdict back to crm_leads. Every
 * verdict except `valid` also flips the lead to `call_queue` — cold
 * email is off the table for that address, but human contact still
 * makes sense (many bad-email leads have a solid phone number).
 *
 * Deduplicates by lowercase email so the same address across multiple
 * leads only costs one verification. Serial (not parallel) so the
 * account's rate limits and remaining balance stay predictable — a
 * one-off "verify 500 tonight" click takes ~5-10 minutes, and the API
 * response for a hard-block or auth failure aborts the batch early
 * instead of running through the whole balance.
 */

import { supabase } from "../lib/supabase.js";
import { getEmailVerifier } from "../lib/emailVerifierNeverBounce.js";
import { EmailVerifierNotConfiguredError } from "../lib/emailVerifier.js";
import type { CrmEmailVerificationStatus } from "@fleetcal/types";

const INTER_CALL_MS = 300;

export interface VerifyBatchResult {
  attempted: number;
  byVerdict: Partial<Record<CrmEmailVerificationStatus, number>>;
  routedToCallQueue: number;
  aborted?: string;
}

export interface VerifyBatchOpts {
  /** Max unique emails to verify this run. Capped by the route. */
  count: number;
  /** Restrict to a specific set of lead ids (overrides the default
   *  "next unverified" scan). Useful for a per-batch "verify these"
   *  action from the leads table. */
  leadIds?: string[];
}

/** Fetch the next batch of unverified-email leads for this org. */
async function fetchUnverifiedLeads(
  orgId: string,
  opts: VerifyBatchOpts,
): Promise<Array<{ id: string; email: string }>> {
  let query = supabase
    .from("crm_leads")
    .select("id,email")
    .eq("org_id", orgId)
    .not("email", "is", null)
    .is("email_verification_status", null);
  if (opts.leadIds?.length) query = query.in("id", opts.leadIds);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(opts.count * 2); // over-fetch a bit; dedupe collapses the rest
  if (error) throw new Error(`unverified fetch failed: ${error.message}`);
  return (data ?? []) as Array<{ id: string; email: string }>;
}

export async function verifyEmailsForOrg(
  orgId: string,
  opts: VerifyBatchOpts,
): Promise<VerifyBatchResult> {
  const result: VerifyBatchResult = { attempted: 0, byVerdict: {}, routedToCallQueue: 0 };
  const verifier = getEmailVerifier();

  const leads = await fetchUnverifiedLeads(orgId, opts);
  if (leads.length === 0) return result;

  // Dedupe by lowercased email — one API call per unique address,
  // then propagate the verdict to every lead sharing it.
  const leadsByEmail = new Map<string, string[]>();
  for (const l of leads) {
    const key = l.email.toLowerCase().trim();
    if (!leadsByEmail.has(key)) leadsByEmail.set(key, []);
    leadsByEmail.get(key)!.push(l.id);
  }

  const uniqueEmails = Array.from(leadsByEmail.keys()).slice(0, opts.count);

  for (const email of uniqueEmails) {
    result.attempted++;
    let verdict: CrmEmailVerificationStatus;
    let raw: unknown;
    try {
      const r = await verifier.verify(email);
      verdict = r.verdict;
      raw = r.raw;
    } catch (err) {
      if (err instanceof EmailVerifierNotConfiguredError) {
        result.aborted = err.message;
        break;
      }
      // Any other provider error: log, treat as `unknown` (retryable),
      // and move on. Do NOT throw — one bad address must not tank the
      // whole batch.
      console.error(`[crm-verify] ${email} failed:`, err);
      verdict = "unknown";
      raw = { error: err instanceof Error ? err.message : String(err) };
    }

    result.byVerdict[verdict] = (result.byVerdict[verdict] ?? 0) + 1;

    // Persist the verdict to every lead sharing this email.
    const now = new Date().toISOString();
    const leadIds = leadsByEmail.get(email)!;
    await supabase
      .from("crm_leads")
      .update({
        email_verification_status:   verdict,
        email_verified_at:           now,
        email_verification_provider: verifier.slug,
        email_verification_raw:      raw as never,
      })
      .in("id", leadIds)
      .eq("org_id", orgId);

    // Any non-valid verdict → route to the call queue (cold email is
    // off the table but the phone number often still works). Only flip
    // leads that are still in the pre-outreach stages — don't rewind a
    // lead we're already talking to.
    if (verdict !== "valid") {
      const { data: routed } = await supabase
        .from("crm_leads")
        .update({ status: "call_queue", status_changed_at: now })
        .in("id", leadIds)
        .eq("org_id", orgId)
        .in("status", ["new", "enriched", "queued"])
        .select("id");
      const routedCount = routed?.length ?? 0;
      if (routedCount > 0) {
        result.routedToCallQueue += routedCount;
        // Log an activity per routed lead so the timeline shows why
        // they moved (searchable, and clear for the salesperson).
        await supabase.from("crm_activities").insert(
          (routed as Array<{ id: string }>).map((l) => ({
            org_id: orgId,
            lead_id: l.id,
            kind: "system" as const,
            body: `Email verification: ${verdict} → routed to call queue`,
            meta: { emailVerificationStatus: verdict, provider: verifier.slug },
            actor_user_id: null,
          })),
        );
      }
    }

    await new Promise((r) => setTimeout(r, INTER_CALL_MS));
  }

  return result;
}
