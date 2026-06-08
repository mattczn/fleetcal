/**
 * Daily AI usage sweep — flags orgs at risk of crossing their
 * monthly Anthropic budget cap or spiking compared to their own
 * 7-day baseline, then emails a summary to the super-admin
 * allowlist.
 *
 * Three trigger conditions, any of which adds an org to the
 * report:
 *
 *   1. Cap risk         — spend > 80% of monthly cap.
 *   2. Cap exceeded     — spend ≥ monthly cap (the route has
 *                          already been denying calls; this
 *                          confirms it for the admin).
 *   3. Volume spike     — 24h call count > 3× the org's
 *                          previous 7-day daily average AND
 *                          at least 20 calls today.
 *
 * The 7-day baseline + 20-call floor mean we don't ping the
 * admin every time a new org makes their 5th parse — a baseline
 * needs to exist to be meaningfully exceeded.
 *
 * Anything flagged also bumps `ai_usage_monthly.flagged_at` to
 * now() so the /admin/ai-usage dashboard can badge the rows
 * even before the admin reads the email.
 *
 * Email goes to AI_ADMIN_EMAILS (env, comma-separated) or
 * curzondispatch2@gmail.com as a fallback. Resend is the
 * delivery client (same one the invoice flow uses).
 */

import { supabase as typedSupabase } from "../lib/supabase.js";
import { Resend } from "resend";
import { env } from "../lib/env.js";
import { getOrgIdentity } from "../lib/clerk.js";

// `ai_usage_logs`, `ai_usage_monthly`, and `org_settings.ai_monthly_cap_usd`
// aren't in packages/types/database.ts yet (the generated file is from a
// pre-PR-1 schema dump). Casting to `any` lets us query the new tables
// without committing a regenerated 1500-line types file in this PR. The
// runtime contract is enforced by the migration; the column names we
// reference here all exist in 20260608_ai_usage_tracking.sql + the cap
// migration. Re-generate database.ts via the standard supabase-cli
// script before the next PR if you want strict typing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = typedSupabase as any;

/** Per-row config — fall back to this if the org has no override. */
const DEFAULT_MONTHLY_CAP_USD = 25;
const CAP_RISK_THRESHOLD      = 0.80;   // 80% of cap
const VOLUME_SPIKE_MULTIPLIER = 3;      // 3× the 7-day daily avg
const VOLUME_SPIKE_FLOOR      = 20;     // …only flag if today >= 20 calls

interface FlaggedOrg {
  orgId:        string;
  orgName:      string | null;
  reasons:      string[];     // human-readable summary lines
  monthlySpend: number;
  monthlyCap:   number;
  pctOfCap:     number;
  callsLast24h: number;
  avgDailyCalls: number;
}

export interface AiUsageSweepResult {
  flaggedCount:   number;
  totalOrgsSeen:  number;
  emailSent:      boolean;
  emailError?:    string;
}

export async function runAiUsageSweep(): Promise<AiUsageSweepResult> {
  const ym = new Date().toISOString().slice(0, 7);

  // ── 1. Active orgs for the month (any spend > 0) ──────────────
  const monthlyRes = await supabase
    .from("ai_usage_monthly")
    .select("org_id, cost_usd, call_count")
    .eq("ym", ym)
    .eq("endpoint", "parse-ratecon");
  if (monthlyRes.error) throw monthlyRes.error;
  const monthly = (monthlyRes.data ?? []) as Array<{
    org_id:     string;
    cost_usd:   string;
    call_count: number;
  }>;

  // ── 2. Per-org cap overrides ──────────────────────────────────
  const orgIds = monthly.map(m => m.org_id);
  let overrideCaps: Record<string, number> = {};
  if (orgIds.length > 0) {
    const settingsRes = await supabase
      .from("org_settings")
      .select("org_id, ai_monthly_cap_usd")
      .in("org_id", orgIds);
    if (!settingsRes.error && settingsRes.data) {
      overrideCaps = Object.fromEntries(
        (settingsRes.data as Array<{ org_id: string; ai_monthly_cap_usd: string | null }>)
          .filter(r => r.ai_monthly_cap_usd != null)
          .map(r => [r.org_id, parseFloat(r.ai_monthly_cap_usd as string)])
      );
    }
  }

  // ── 3. 24h call counts ────────────────────────────────────────
  // One query, group in memory. Anthropic-billed + denied requests
  // both count here — abuse is abuse regardless of which gate fired.
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dailyRes = await supabase
    .from("ai_usage_logs")
    .select("org_id")
    .gte("created_at", last24h);
  const daily24h = new Map<string, number>();
  if (!dailyRes.error && dailyRes.data) {
    for (const r of dailyRes.data as Array<{ org_id: string | null }>) {
      if (r.org_id) daily24h.set(r.org_id, (daily24h.get(r.org_id) ?? 0) + 1);
    }
  }

  // ── 4. 7-day baseline (8 days back through 1 day back) ────────
  // Excludes today so spike-detection doesn't inflate the average
  // with the very calls we're trying to detect.
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const baselineRes = await supabase
    .from("ai_usage_logs")
    .select("org_id")
    .gte("created_at", eightDaysAgo)
    .lt("created_at", last24h);
  const baseline7d = new Map<string, number>();
  if (!baselineRes.error && baselineRes.data) {
    for (const r of baselineRes.data as Array<{ org_id: string | null }>) {
      if (r.org_id) baseline7d.set(r.org_id, (baseline7d.get(r.org_id) ?? 0) + 1);
    }
  }

  // ── 5. Build the flag list ────────────────────────────────────
  const flagged: FlaggedOrg[] = [];
  for (const row of monthly) {
    const orgId       = row.org_id;
    const spend       = parseFloat(row.cost_usd);
    const cap         = overrideCaps[orgId] ?? DEFAULT_MONTHLY_CAP_USD;
    const pctOfCap    = cap > 0 ? spend / cap : 0;
    const today       = daily24h.get(orgId) ?? 0;
    const avg7d       = (baseline7d.get(orgId) ?? 0) / 7;
    const reasons: string[] = [];

    if (pctOfCap >= 1) {
      reasons.push(`Spent $${spend.toFixed(2)} of $${cap.toFixed(2)} cap (${(pctOfCap * 100).toFixed(0)}%) — calls are being denied`);
    } else if (pctOfCap >= CAP_RISK_THRESHOLD) {
      reasons.push(`Spent $${spend.toFixed(2)} of $${cap.toFixed(2)} cap (${(pctOfCap * 100).toFixed(0)}%) — approaching limit`);
    }

    if (today >= VOLUME_SPIKE_FLOOR && avg7d > 0 && today > avg7d * VOLUME_SPIKE_MULTIPLIER) {
      reasons.push(`${today} calls in last 24h vs ${avg7d.toFixed(1)}/day baseline (${(today / avg7d).toFixed(1)}× spike)`);
    }

    if (reasons.length > 0) {
      // Resolve org name. Falls back to org_id on Clerk failure.
      const ident = await getOrgIdentity(orgId);
      flagged.push({
        orgId,
        orgName:        ident?.name ?? null,
        reasons,
        monthlySpend:   spend,
        monthlyCap:     cap,
        pctOfCap,
        callsLast24h:   today,
        avgDailyCalls:  avg7d,
      });
    }
  }

  // ── 6. Persist flagged_at on the monthly rows ─────────────────
  // So the dashboard can badge the rows even before the admin
  // reads the email. Reset every sweep — a row that fell BELOW
  // threshold won't be re-flagged here, but a prior flag stays
  // until an admin manually clears it (PR 3+ extension).
  if (flagged.length > 0) {
    const flaggedIds = flagged.map(f => f.orgId);
    const flaggedRes = await supabase
      .from("ai_usage_monthly")
      .update({ flagged_at: new Date().toISOString() })
      .in("org_id", flaggedIds)
      .eq("ym", ym)
      .eq("endpoint", "parse-ratecon");
    if (flaggedRes.error) {
      console.warn("[ai-usage-sweep] failed to persist flagged_at:", flaggedRes.error.message);
    }
  }

  // ── 7. Email summary ──────────────────────────────────────────
  let emailSent = false;
  let emailError: string | undefined;
  if (flagged.length > 0) {
    try {
      await sendSweepEmail(flagged, ym);
      emailSent = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
      console.error("[ai-usage-sweep] email failed:", emailError);
    }
  }

  return {
    flaggedCount:  flagged.length,
    totalOrgsSeen: monthly.length,
    emailSent,
    emailError,
  };
}

/** Build + send the digest email. Quiet plain-text + simple HTML;
 *  the goal is "Matt skims this on his phone and decides what to
 *  do," not a marketing-grade design. */
async function sendSweepEmail(orgs: FlaggedOrg[], ym: string): Promise<void> {
  if (!env.resendApiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }
  const recipients = (process.env.AI_ADMIN_EMAILS ?? "curzondispatch2@gmail.com")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0) {
    throw new Error("No admin recipients configured (AI_ADMIN_EMAILS)");
  }

  const subject = `FleetCal AI usage alert — ${orgs.length} org${orgs.length === 1 ? "" : "s"} flagged (${ym})`;

  const lines: string[] = [];
  lines.push(`${orgs.length} org${orgs.length === 1 ? " was" : "s were"} flagged in today's sweep.`);
  lines.push("");
  for (const o of orgs) {
    lines.push(`• ${o.orgName ?? o.orgId}`);
    for (const r of o.reasons) lines.push(`    – ${r}`);
    lines.push(`    open: https://fleetcal.app/admin/ai-usage`);
    lines.push("");
  }

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #202124; font-size: 14px; line-height: 1.55; max-width: 640px;">
  <p><strong>${orgs.length}</strong> org${orgs.length === 1 ? " was" : "s were"} flagged in today's AI usage sweep (${ym}).</p>
  <table style="border-collapse: collapse; width: 100%; margin-top: 16px;">
    <thead>
      <tr style="background: #f1f3f4; color: #5f6368; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <th style="text-align: left;  padding: 8px 10px; border-bottom: 1px solid #dadce0;">Org</th>
        <th style="text-align: right; padding: 8px 10px; border-bottom: 1px solid #dadce0;">Spend</th>
        <th style="text-align: right; padding: 8px 10px; border-bottom: 1px solid #dadce0;">% cap</th>
        <th style="text-align: right; padding: 8px 10px; border-bottom: 1px solid #dadce0;">24h calls</th>
      </tr>
    </thead>
    <tbody>
      ${orgs.map(o => `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #e8eaed; font-weight: 600;">
            ${escapeHtml(o.orgName ?? o.orgId)}
            <div style="font-size: 11px; color: #5f6368; font-weight: 400; margin-top: 2px;">
              ${o.reasons.map(escapeHtml).join("<br>")}
            </div>
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #e8eaed; text-align: right; font-variant-numeric: tabular-nums;">
            $${o.monthlySpend.toFixed(2)} / $${o.monthlyCap.toFixed(2)}
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #e8eaed; text-align: right; font-variant-numeric: tabular-nums; color: ${o.pctOfCap >= 1 ? "#c5221f" : o.pctOfCap >= 0.8 ? "#b06000" : "#202124"};">
            ${(o.pctOfCap * 100).toFixed(0)}%
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #e8eaed; text-align: right; font-variant-numeric: tabular-nums;">
            ${o.callsLast24h} (avg ${o.avgDailyCalls.toFixed(1)})
          </td>
        </tr>
      `).join("")}
    </tbody>
  </table>
  <p style="margin-top: 16px;">
    <a href="https://fleetcal.app/admin/ai-usage" style="color: #1a73e8; font-weight: 600; text-decoration: none;">
      Open AI Usage dashboard →
    </a>
  </p>
  <p style="color: #5f6368; font-size: 12px; margin-top: 24px;">
    Daily sweep · sent by apps/api · suppress by removing the address from <code>AI_ADMIN_EMAILS</code>.
  </p>
</div>`;

  const resend = new Resend(env.resendApiKey);
  const result = await resend.emails.send({
    from:    "FleetCal <noreply@fleetcal.app>",
    to:      recipients,
    subject,
    text:    lines.join("\n"),
    html,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
