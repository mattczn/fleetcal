/**
 * /v1/contact-sales — public lead intake from fleetcal.app/contact-sales.
 *
 * POST handler that takes the wizard's answers, formats a clean lead
 * email, and ships it through Resend to CONTACT_SALES_TO (defaults to
 * hello@fleetcal.app). Reply-To is set to the prospect's email so a
 * reply from the inbox lands directly in their thread.
 *
 * Defenses against bot spam:
 *   - Honeypot field `website` is always-hidden in the page; any value
 *     means a bot filled it. We accept the request silently (200 ok)
 *     and drop the message so the bot doesn't get a 4xx-based retry
 *     signal.
 *   - `loadedAt` timestamp: if the form took less than 2s end-to-end,
 *     same silent-drop. A human reading + answering 5 questions can't
 *     hit that.
 *
 * The FROM address reuses the carrier-invoice domain (env.invoiceFromEmail,
 * usually invoices@fleetcal.app) so we don't have to verify a second
 * sender domain in Resend. Display name overridden to "FleetCal Sales".
 */

import { Hono } from "hono";
import { Resend } from "resend";
import { env } from "../lib/env.js";

const contactSales = new Hono();

interface ContactSalesBody {
  fleetSize?:   string;   // "1-4" | "5-9" | "10-14" | "15+"
  currentTool?: string;   // free-form (option label)
  freightType?: string;   // free-form (option label)
  topPain?:     string;   // free-form (option label)
  name?:        string;
  email?:       string;
  phone?:       string;
  company?:     string;
  message?:     string;
  // Anti-spam
  website?:     string;   // honeypot — must be empty
  loadedAt?:    number;   // ms epoch from the client; gate at >2s
}

/** Map fleet-size label → the recommended plan tier. Sales reads this
 *  first so they know which conversation to lead with. Wizard sends
 *  the human label ("1 to 4") not a value code. */
function recommendPlan(fleetSize: string | undefined): string {
  switch (fleetSize) {
    case "1 to 4":     return "Owner Op  ($99/mo · 1–4 trucks)";
    case "5 to 9":     return "Growth    ($149/mo · 5–9 trucks)";
    case "10 to 14":   return "Fleet     ($199/mo · 10–14 trucks)";
    case "15 or more": return "Custom    (15+ trucks · sales-led)";
    default:           return "(unknown — fleet size not provided)";
  }
}

/** HTML attribute / text escaper. No real templating here, so just the
 *  five characters that change meaning in an HTML body. */
function esc(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

contactSales.post("/", async (c) => {
  let body: ContactSalesBody;
  try {
    body = await c.req.json<ContactSalesBody>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // Honeypot — silently accept + drop.
  if (body.website && body.website.trim().length > 0) {
    return c.json({ ok: true });
  }
  // Time gate — same silent drop.
  if (body.loadedAt && Date.now() - body.loadedAt < 2000) {
    return c.json({ ok: true });
  }

  // Real validation. The wizard already requires these on the client,
  // but we re-check server-side because a direct POST can skip the UI.
  const name  = (body.name  ?? "").trim();
  const email = (body.email ?? "").trim();
  if (!name) {
    return c.json({ error: "validation_failed", errors: ["name required"] }, 400);
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: "validation_failed", errors: ["valid email required"] }, 400);
  }

  if (!env.resendApiKey) {
    return c.json({ error: "email_not_configured" }, 503);
  }

  const company     = (body.company     ?? "").trim();
  const phone       = (body.phone       ?? "").trim();
  const fleetSize   = (body.fleetSize   ?? "").trim();
  const currentTool = (body.currentTool ?? "").trim();
  const freightType = (body.freightType ?? "").trim();
  const topPain     = (body.topPain     ?? "").trim();
  const message     = (body.message     ?? "").trim();

  const toEmail =
    process.env.CONTACT_SALES_TO ||
    process.env.CONTACT_TO_EMAIL ||
    "hello@fleetcal.app";

  const subject =
    `New lead: ${company || name}` +
    (fleetSize ? ` · ${fleetSize} trucks` : "");

  const recommended = recommendPlan(fleetSize);

  // Plain-text-ish HTML — lead landing in an inbox, not a marketing
  // template. Two-column key/value table for the answers + a small
  // recommended-plan callout at the top.
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#202124;font-size:14px;line-height:1.5;">
      <h2 style="margin:0 0 6px;font-size:18px;">New contact-sales submission</h2>
      <div style="color:#5f6368;margin-bottom:18px;">via fleetcal.app/contact-sales</div>

      <div style="background:#e8f0fe;border-left:3px solid #1a73e8;padding:10px 14px;border-radius:4px;margin-bottom:18px;">
        <div style="font-size:12px;color:#1967d2;text-transform:uppercase;letter-spacing:.08em;font-weight:600;">Recommended plan</div>
        <div style="font-weight:600;margin-top:4px;">${esc(recommended)}</div>
      </div>

      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;width:160px;vertical-align:top;">Name</td><td style="padding:6px 0;font-weight:600;">${esc(name)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Email</td><td style="padding:6px 0;"><a href="mailto:${esc(email)}" style="color:#1967d2;text-decoration:none;">${esc(email)}</a></td></tr>
        ${phone   ? `<tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Phone</td><td style="padding:6px 0;">${esc(phone)}</td></tr>` : ""}
        ${company ? `<tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Company</td><td style="padding:6px 0;">${esc(company)}</td></tr>` : ""}
        <tr><td colspan="2" style="padding:14px 0 6px;color:#3c4043;font-weight:600;border-top:1px solid #e8eaed;">Qualification</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Fleet size</td><td style="padding:6px 0;">${esc(fleetSize) || "—"}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Using today</td><td style="padding:6px 0;">${esc(currentTool) || "—"}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Primary freight</td><td style="padding:6px 0;">${esc(freightType) || "—"}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Pain points</td><td style="padding:6px 0;">${esc(topPain) || "—"}</td></tr>
      </table>

      ${message
        ? `<div style="margin-top:18px;"><div style="color:#3c4043;font-weight:600;margin-bottom:6px;">Anything else they said</div><div style="white-space:pre-wrap;background:#f8f9fa;border:1px solid #e8eaed;border-radius:6px;padding:12px;">${esc(message)}</div></div>`
        : ""}

      <div style="margin-top:24px;color:#5f6368;font-size:12px;">Reply to this email and it will go straight to ${esc(email)}.</div>
    </div>
  `.trim();

  // Plain-text alternative for clients that prefer it.
  const text =
    `New contact-sales submission · fleetcal.app/contact-sales\n` +
    `\n` +
    `Recommended plan: ${recommended}\n` +
    `\n` +
    `Name:    ${name}\n` +
    `Email:   ${email}\n` +
    (phone   ? `Phone:   ${phone}\n` : "") +
    (company ? `Company: ${company}\n` : "") +
    `\n` +
    `Qualification\n` +
    `Fleet size:      ${fleetSize   || "—"}\n` +
    `Using today:     ${currentTool || "—"}\n` +
    `Primary freight: ${freightType || "—"}\n` +
    `Pain points:     ${topPain     || "—"}\n` +
    (message ? `\nAnything else:\n${message}\n` : "");

  const resend = new Resend(env.resendApiKey);
  try {
    const { error } = await resend.emails.send({
      from:    `FleetCal Sales <${env.invoiceFromEmail}>`,
      to:      [toEmail],
      replyTo: email,
      subject,
      html,
      text,
    });
    if (error) {
      console.error("[contact-sales] resend error:", error);
      return c.json({ error: "send_failed" }, 502);
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error("[contact-sales] resend threw:", err);
    return c.json({ error: "send_failed" }, 500);
  }
});

export default contactSales;
