/**
 * CRM outreach email delivery (Resend) — INTERNAL sales tooling.
 *
 * Deliberately separate from invoiceEmail.ts: invoices send from the
 * verified fleetcal.app identity; outreach sends from the dedicated
 * cold-email domain (OUTREACH_FROM_EMAIL on fleetcalendar.app). A spam
 * flag on outreach must never be able to touch invoice deliverability,
 * so the two paths share nothing but the Resend API key.
 *
 * CAN-SPAM is enforced in code, not template discipline:
 *   - sends REFUSE when the physical-address footer is empty
 *   - every body gets the unsubscribe line (auto-appended when the
 *     template forgot {{unsubscribe_url}})
 *   - List-Unsubscribe + one-click headers on every send
 *
 * Plain-text only: higher deliverability for cold outreach, and the
 * merge-var templates stay trivially auditable in the outbox UI.
 */

import { Resend } from "resend";
import type { CrmLead, CrmSettings } from "@fleetcal/types";
import { env } from "./env.js";

let _resend: Resend | null = null;
function client(): Resend {
  if (_resend) return _resend;
  if (!env.resendApiKey) {
    throw new Error(
      "RESEND_API_KEY is not configured. Set it on the API service to enable outreach email delivery.",
    );
  }
  _resend = new Resend(env.resendApiKey);
  return _resend;
}

/** Human-readable reason an outreach send is impossible right now.
 *  Null = good to send. Checked before every send AND surfaced in the
 *  outbox UI so a misconfiguration is loud, not silent. */
export function outreachConfigError(settings: CrmSettings): string | null {
  if (!env.resendApiKey) return "RESEND_API_KEY is not set";
  if (!env.outreachFromEmail) return "OUTREACH_FROM_EMAIL is not set (dedicated outreach domain)";
  if (!settings.physicalAddressFooter.trim()) {
    return "CRM settings are missing the physical-address footer (CAN-SPAM requires one)";
  }
  return null;
}

/**
 * User-visible unsubscribe URL — points at the WEB domain (fleetcal.app
 * by default), not the Railway subdomain, because a
 * `*.up.railway.app` link in cold email hurts deliverability and looks
 * untrustworthy to recipients. The Next.js /unsubscribe/[token] route
 * proxies to the API's /v1/crm-public/unsubscribe/:token endpoint.
 */
export function unsubscribeUrl(token: string): string {
  return `${env.publicWebUrl}/unsubscribe/${token}`;
}

/** {{merge_var}} substitution. Unknown vars render as '' (never leak
 *  braces into a prospect email). */
export function renderTemplate(tpl: string, lead: CrmLead): string {
  const vars: Record<string, string> = {
    legal_name:        lead.legalName,
    dba_or_legal_name: lead.dbaName || lead.legalName,
    city:              lead.phyCity ?? "",
    state:             lead.phyState ?? "",
    power_units:       lead.powerUnits != null ? String(lead.powerUnits) : "",
    unsubscribe_url:   unsubscribeUrl(""),
  };
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => vars[key.toLowerCase()] ?? "");
}

/** Render with the real per-lead unsubscribe link (token required). */
export function renderForLead(tpl: string, lead: CrmLead, unsubToken: string): string {
  const withVars = tpl.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl(unsubToken));
  return renderTemplate(withVars, lead);
}

export interface OutreachSendArgs {
  to: string;
  subject: string;
  /** Already-rendered body (snapshot from crm_emails). */
  body: string;
  unsubToken: string;
  settings: CrmSettings;
}

export interface OutreachSendResult {
  messageId: string;
}

/**
 * Send one outreach email. Throws on config problems or Resend errors —
 * the sweep catches and marks the row failed. Appends the CAN-SPAM
 * footer block (physical address + unsubscribe line when the body
 * doesn't already contain the link).
 */
export async function sendOutreachEmail(args: OutreachSendArgs): Promise<OutreachSendResult> {
  const configError = outreachConfigError(args.settings);
  if (configError) throw new Error(configError);

  const unsub = unsubscribeUrl(args.unsubToken);
  // Compact 2-line CAN-SPAM footer. Address collapses onto one line
  // with "·" separators regardless of how the org wrote it in settings
  // (multi-line entries stay legible), and the unsubscribe line is
  // suppressed when the user already put {{unsubscribe_url}} somewhere
  // in their template body — no duplicate link.
  //
  //   [body]
  //
  //   —
  //   Systematica LLC · 123 Main St · Ogden, UT 84401
  //   Unsubscribe: https://fleetcal.app/unsubscribe/…
  const addressOneLine = args.settings.physicalAddressFooter
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" · ");
  let body = args.body.trimEnd();
  const footerLines = ["—", addressOneLine];
  if (!body.includes(unsub)) footerLines.push(`Unsubscribe: ${unsub}`);
  body += `\n\n${footerLines.join("\n")}`;

  const fromName = args.settings.fromName?.trim() || env.outreachFromName;
  const { data, error } = await client().emails.send({
    from: `${fromName} <${env.outreachFromEmail}>`,
    to: [args.to],
    replyTo: args.settings.replyTo?.trim() || env.outreachReplyTo || env.outreachFromEmail!,
    subject: args.subject,
    text: body,
    headers: {
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (error || !data?.id) {
    throw new Error(`Resend send failed: ${error?.message ?? "no message id returned"}`);
  }
  return { messageId: data.id };
}
