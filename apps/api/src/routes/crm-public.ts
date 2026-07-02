/**
 * Public (unauthenticated) CRM endpoints — mounted BEFORE the Clerk
 * group in index.ts, same precedence trick as /v1/internal.
 *
 *   GET|POST /v1/crm-public/unsubscribe/:token — one-click unsubscribe
 *   POST     /v1/crm-public/resend-webhook     — bounce/complaint ingest
 *
 * The unsubscribe token is the lead's unguessable uuid — possession IS
 * authorization (the standard pattern for list-unsubscribe links; a
 * guessed uuid can only ever unsubscribe someone, never read data).
 * GET serves humans clicking the link; POST serves RFC 8058 one-click
 * from mail clients. Both are idempotent.
 *
 * The Resend webhook is svix-signed. Verification is implemented with
 * node:crypto (HMAC-SHA256 over `${id}.${timestamp}.${payload}`, secret
 * = base64 after the whsec_ prefix) — deliberately no svix dependency
 * for one signature check.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { supabase } from "../lib/supabase.js";

const crmPublic = new Hono();

// ── Unsubscribe ─────────────────────────────────────────────────────────

const UNSUB_HTML = (name: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title></head>
<body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; color: #202124;">
<h2 style="font-weight: 600;">You're unsubscribed</h2>
<p>${name} won't receive any more emails from FleetCal. Sorry for the interruption.</p>
</body></html>`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleUnsubscribe(token: string): Promise<{ leadName: string } | null> {
  if (!UUID_RE.test(token)) return null;
  const { data: leadRaw } = await supabase
    .from("crm_leads")
    .select("id,org_id,legal_name,email,status")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  const lead = leadRaw as {
    id: string; org_id: string; legal_name: string; email: string | null; status: string;
  } | null;
  if (!lead) return null;

  // Suppress the address (idempotent — unique on lower(email)).
  if (lead.email) {
    const { error } = await supabase.from("crm_suppressions").insert({
      org_id: lead.org_id,
      email: lead.email.toLowerCase(),
      reason: "unsubscribe",
      lead_id: lead.id,
    });
    if (error && error.code !== "23505") {
      console.error("[crm-public/unsubscribe] suppression insert failed:", error.message);
    }
  }

  // Flip the lead, stop enrollments, cancel queued emails — all no-ops
  // on a second click.
  if (lead.status !== "unsubscribed") {
    await supabase
      .from("crm_leads")
      .update({ status: "unsubscribed", status_changed_at: new Date().toISOString() })
      .eq("id", lead.id);
    await supabase.from("crm_activities").insert({
      org_id: lead.org_id,
      lead_id: lead.id,
      kind: "unsubscribed",
      body: "Clicked unsubscribe link",
      meta: null,
      actor_user_id: null,
    });
  }
  await supabase
    .from("crm_enrollments")
    .update({ status: "unsubscribed", next_send_at: null })
    .eq("org_id", lead.org_id)
    .eq("lead_id", lead.id)
    .in("status", ["active", "paused"]);
  await supabase
    .from("crm_emails")
    .update({ status: "cancelled", error: "lead unsubscribed" })
    .eq("org_id", lead.org_id)
    .eq("lead_id", lead.id)
    .in("status", ["pending_approval", "approved"]);

  return { leadName: lead.legal_name };
}

crmPublic.get("/unsubscribe/:token", async (c) => {
  const result = await handleUnsubscribe(c.req.param("token"));
  // Unknown token still renders the page — no probing oracle for which
  // tokens exist, and the human outcome ("stop emailing me") reads done.
  return c.html(UNSUB_HTML(result?.leadName ?? "This address"));
});

// RFC 8058 one-click (mail clients POST with no body expectations).
crmPublic.post("/unsubscribe/:token", async (c) => {
  await handleUnsubscribe(c.req.param("token"));
  return c.text("OK");
});

// ── Resend webhook (bounces / complaints) ───────────────────────────────

/** Verify the svix signature. Returns true iff valid. */
function verifySvix(secret: string, id: string, timestamp: string, payload: string, signatures: string): boolean {
  // Reject stale timestamps (svix default tolerance is 5 minutes).
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`)
    .digest();
  // svix-signature is space-separated "v1,<base64>" entries (key rotation).
  for (const part of signatures.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    try {
      const given = Buffer.from(sig, "base64");
      if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    } catch { /* malformed base64 — try next */ }
  }
  return false;
}

interface ResendWebhookEvent {
  type?: string;
  data?: { email_id?: string };
}

crmPublic.post("/resend-webhook", async (c) => {
  if (!env.resendWebhookSecret) {
    return c.json({ error: "service_unavailable", reason: "webhook_secret_not_configured" }, 503);
  }
  const svixId = c.req.header("svix-id");
  const svixTimestamp = c.req.header("svix-timestamp");
  const svixSignature = c.req.header("svix-signature");
  const payload = await c.req.text();
  if (
    !svixId || !svixTimestamp || !svixSignature ||
    !verifySvix(env.resendWebhookSecret, svixId, svixTimestamp, payload, svixSignature)
  ) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(payload) as ResendWebhookEvent;
  } catch {
    return c.json({ error: "bad_payload" }, 400);
  }

  // Only bounce/complaint move the needle; ack everything else.
  const kind = event.type === "email.bounced" ? "bounce"
             : event.type === "email.complained" ? "complaint"
             : null;
  const messageId = event.data?.email_id;
  if (!kind || !messageId) return c.json({ ok: true });

  const { data: emailRaw } = await supabase
    .from("crm_emails")
    .select("id,org_id,lead_id,to_email")
    .eq("resend_message_id", messageId)
    .maybeSingle();
  const email = emailRaw as { id: string; org_id: string; lead_id: string; to_email: string } | null;
  // Unknown message id (e.g. an invoice email's event) → ack, ignore.
  if (!email) return c.json({ ok: true });

  await supabase
    .from("crm_emails")
    .update({ status: "bounced", error: event.type })
    .eq("id", email.id);
  const { error: suppErr } = await supabase.from("crm_suppressions").insert({
    org_id: email.org_id,
    email: email.to_email.toLowerCase(),
    reason: kind,
    lead_id: email.lead_id,
  });
  if (suppErr && suppErr.code !== "23505") {
    console.error("[crm-public/resend-webhook] suppression insert failed:", suppErr.message);
  }
  await supabase
    .from("crm_enrollments")
    .update({ status: "stopped", next_send_at: null })
    .eq("org_id", email.org_id)
    .eq("lead_id", email.lead_id)
    .in("status", ["active", "paused"]);
  await supabase.from("crm_activities").insert({
    org_id: email.org_id,
    lead_id: email.lead_id,
    kind: "email_bounced",
    body: `${event.type} (${email.to_email})`,
    meta: { emailId: email.id },
    actor_user_id: null,
  });

  return c.json({ ok: true });
});

export { crmPublic as crmPublicRoute };
