/**
 * Twilio SMS sender — direct-to-API, no npm SDK.
 *
 * We only need to POST one message; the `twilio` npm package would drag
 * in a few MB of transport + webhook helpers we don't use. Fetch + Basic
 * auth against the Messages endpoint is 20 lines and the wire format is
 * frozen documented behavior.
 *
 * Env: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_NUMBER (all
 * required). Any missing → sendSms returns { ok:false, kind:"not_configured" }
 * so callers can surface "SMS not set up" in the UI without treating it
 * as an outage.
 *
 * NOT the driver-app OTP path. Supabase phone auth handles those — its
 * Twilio creds live in the Supabase dashboard. These env vars only feed
 * transactional sends we originate directly (paystub links, later
 * expansions).
 */

import { env } from "./env.js";

export type SendSmsResult =
  | { ok: true;  sid: string }
  | { ok: false; kind: "not_configured" | "twilio_error" | "network"; detail: string };

export function isSmsConfigured(): boolean {
  return !!(env.twilioAccountSid && env.twilioAuthToken && env.twilioFromNumber);
}

export async function sendSms(args: { to: string; body: string }): Promise<SendSmsResult> {
  if (!isSmsConfigured()) {
    return {
      ok:     false,
      kind:   "not_configured",
      detail: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER not all set",
    };
  }

  const sid   = env.twilioAccountSid as string;
  const token = env.twilioAuthToken  as string;
  const from  = env.twilioFromNumber as string;

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ To: args.to, From: from, Body: args.body });

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type":  "application/x-www-form-urlencoded",
        "Accept":        "application/json",
      },
      body: form.toString(),
    });
  } catch (err) {
    return {
      ok:     false,
      kind:   "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const text = await res.text();
  if (!res.ok) {
    // Twilio's error body is JSON with { message, code, more_info }. Grab
    // message when we can, fall back to the raw text otherwise so
    // debugging never gets stuck on an opaque failure.
    let msg = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: number };
      if (parsed.message) msg = `${parsed.message}${parsed.code != null ? ` (code ${parsed.code})` : ""}`;
    } catch { /* fall through with raw text */ }
    return { ok: false, kind: "twilio_error", detail: msg.slice(0, 500) };
  }

  const parsed = JSON.parse(text) as { sid?: string };
  if (!parsed.sid) {
    return { ok: false, kind: "twilio_error", detail: "response missing sid" };
  }
  return { ok: true, sid: parsed.sid };
}

/** Normalize a stored phone to E.164 for Twilio. Accepts
 *  "+1801…" (passthrough), "1801…" (add +), "801…" (assume US → +1).
 *  Returns null on anything else so callers can flag bad numbers
 *  clearly rather than silently sending nowhere. */
export function toE164US(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+\d{10,15}$/.test(digits) ? digits : null;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits))  return `+1${digits}`;
  return null;
}
