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
  // Signature+CAN-SPAM footer, auto-appended to every outreach send:
  //
  //   [body ending "— Matt"]
  //   FleetCal · fleetcal.app        ← attached to signature
  //
  //   —                              ← compliance footer starts
  //   {physicalAddressFooter one-line}
  //   Unsubscribe: {url}
  //
  // The brand+website line lands one \n below the body (no blank line)
  // so it reads as PART of how the sender is signing off — human,
  // personal — rather than as a marketing-footer element competing
  // with the legal address for attention. Recipient who's curious has
  // a natural way to check out the product without needing a link in
  // the CTA (which would pattern-match "marketing template" to spam
  // filters). Address collapses onto one line with " · " separators
  // so multi-line settings entries stay legible. Unsubscribe line is
  // suppressed when the user already included {{unsubscribe_url}} in
  // their template body — no duplicate link.
  const websiteHost = (() => {
    try { return new URL(env.publicWebUrl).host; }
    catch { return "fleetcal.app"; }
  })();
  const addressOneLine = args.settings.physicalAddressFooter
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" · ");
  let body = args.body.trimEnd();
  body += `\nFleetCal · ${websiteHost}`;
  const footerLines = ["—", addressOneLine];
  if (!body.includes(unsub)) footerLines.push(`Unsubscribe: ${unsub}`);
  body += `\n\n${footerLines.join("\n")}`;

  const fromName = args.settings.fromName?.trim() || env.outreachFromName;
  // Send BOTH text and HTML. Recipients on plain-text-preferring
  // clients still see the clean text version we've been sending; HTML
  // clients render the HTML, into which Resend's open-tracking (per-
  // domain toggle in the Resend Dashboard) auto-injects a 1x1 pixel.
  // We can't get opens without HTML, so this is the minimum change.
  //
  // HTML wrapper is intentionally minimal — `pre-wrap` preserves
  // exact line breaks from the plain-text body so the HTML looks
  // identical to text (no marketing-template artifacts to trigger
  // spam heuristics), and URLs are auto-linked so the unsubscribe
  // still works in HTML clients.
  const { data, error } = await client().emails.send({
    from: `${fromName} <${env.outreachFromEmail}>`,
    to: [args.to],
    replyTo: args.settings.replyTo?.trim() || env.outreachReplyTo || env.outreachFromEmail!,
    subject: args.subject,
    text: body,
    html: plainToTrackableHtml(body),
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

/**
 * Wrap plain-text outreach body as minimal HTML that renders exactly
 * like the text version to the recipient while giving Resend a place
 * to inject its open-tracking pixel. `white-space: pre-wrap` is the
 * whole trick — it preserves every `\n` from the plain text so the
 * HTML client sees the same paragraph structure, and we don't need
 * any real HTML markup (no <p>, no <br>) that could pattern-match to
 * marketing templates.
 *
 * URLs (specifically the unsubscribe link) get wrapped in <a> so
 * HTML-only clients can still click them. Everything else stays as-is.
 */
function plainToTrackableHtml(plain: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;")
     .replace(/</g, "&lt;")
     .replace(/>/g, "&gt;")
     .replace(/"/g, "&quot;")
     .replace(/'/g, "&#39;");
  // Escape first, THEN linkify. Reversed order would escape our own
  // <a> tags. The URL regex is intentionally simple — outreach bodies
  // don't contain hostile markup, they come from templates + merge
  // vars we control.
  const escaped = esc(plain);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#1a73e8;text-decoration:underline">${url}</a>`,
  );
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>` +
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;line-height:1.5;color:#202124;white-space:pre-wrap;max-width:640px;">` +
    linked +
    `</div></body></html>`;
}
