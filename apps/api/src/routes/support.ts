/**
 * /v1/support — public "Contact us" intake from fleetcal.app/support.
 *
 * This is the support address surfaced to the App Store / Play Store as the
 * apps' Support URL. A driver or dispatcher fills the form, we format a
 * clean ticket email and ship it through Resend to SUPPORT_TO (defaults to
 * hello@fleetcal.app). Reply-To is the sender's email, so replying from the
 * inbox lands straight in their thread.
 *
 * Mirrors /v1/contact-sales (same Resend setup, same anti-spam) but this is
 * help intake, not a sales lead: required free-text message + a topic so we
 * can triage which app it's about.
 *
 * Anti-spam (identical to contact-sales — both are unauthenticated):
 *   - Honeypot field `website`: hidden in the page; any value → silently
 *     accept (200) and drop, so the bot gets no 4xx retry signal.
 *   - `loadedAt`: if the form round-trips in under 2s it's a bot → same
 *     silent drop.
 *
 * FROM reuses the verified carrier-invoice domain (env.invoiceFromEmail,
 * usually invoices@fleetcal.app) so there's no second sender domain to
 * verify in Resend. Display name overridden to "FleetCal Support".
 */

import { Hono } from "hono";
import { Resend } from "resend";
import { env } from "../lib/env.js";

const support = new Hono();

interface SupportBody {
  name?:     string;
  email?:    string;
  topic?:    string;   // free-form label, e.g. "Driver app (mobile)"
  message?:  string;
  // Anti-spam
  website?:  string;   // honeypot — must be empty
  loadedAt?: number;   // ms epoch from the client; gate at >2s
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

support.post("/", async (c) => {
  let body: SupportBody;
  try {
    body = await c.req.json<SupportBody>();
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

  // Real validation. The page requires these on the client too, but we
  // re-check server-side because a direct POST can skip the UI.
  const name    = (body.name    ?? "").trim();
  const email   = (body.email   ?? "").trim();
  const message = (body.message ?? "").trim();
  const topic   = (body.topic   ?? "").trim();

  const errors: string[] = [];
  if (!name) errors.push("name required");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("valid email required");
  if (!message) errors.push("message required");
  if (errors.length) {
    return c.json({ error: "validation_failed", errors }, 400);
  }

  if (!env.resendApiKey) {
    return c.json({ error: "email_not_configured" }, 503);
  }

  const toEmail =
    process.env.SUPPORT_TO ||
    process.env.CONTACT_SALES_TO ||
    process.env.CONTACT_TO_EMAIL ||
    "hello@fleetcal.app";

  const subject =
    `Support${topic ? ` · ${topic}` : ""} — ${name}`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#202124;font-size:14px;line-height:1.5;">
      <h2 style="margin:0 0 6px;font-size:18px;">New support request</h2>
      <div style="color:#5f6368;margin-bottom:18px;">via fleetcal.app/support</div>

      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;width:120px;vertical-align:top;">From</td><td style="padding:6px 0;font-weight:600;">${esc(name)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Email</td><td style="padding:6px 0;"><a href="mailto:${esc(email)}" style="color:#1967d2;text-decoration:none;">${esc(email)}</a></td></tr>
        ${topic ? `<tr><td style="padding:6px 12px 6px 0;color:#5f6368;vertical-align:top;">Topic</td><td style="padding:6px 0;">${esc(topic)}</td></tr>` : ""}
      </table>

      <div style="margin-top:18px;"><div style="color:#3c4043;font-weight:600;margin-bottom:6px;">Message</div><div style="white-space:pre-wrap;background:#f8f9fa;border:1px solid #e8eaed;border-radius:6px;padding:12px;">${esc(message)}</div></div>

      <div style="margin-top:24px;color:#5f6368;font-size:12px;">Reply to this email and it will go straight to ${esc(email)}.</div>
    </div>
  `.trim();

  const text =
    `New support request · fleetcal.app/support\n` +
    `\n` +
    `From:  ${name}\n` +
    `Email: ${email}\n` +
    (topic ? `Topic: ${topic}\n` : "") +
    `\n` +
    `Message\n${message}\n`;

  const resend = new Resend(env.resendApiKey);
  try {
    const { error } = await resend.emails.send({
      from:    `FleetCal Support <${env.invoiceFromEmail}>`,
      to:      [toEmail],
      replyTo: email,
      subject,
      html,
      text,
    });
    if (error) {
      console.error("[support] resend error:", error);
      return c.json({ error: "send_failed" }, 502);
    }
    return c.json({ ok: true });
  } catch (err) {
    console.error("[support] resend threw:", err);
    return c.json({ error: "send_failed" }, 500);
  }
});

export default support;
