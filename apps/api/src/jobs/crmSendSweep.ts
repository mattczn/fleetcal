/**
 * CRM outreach send sweep — two idempotent passes, every 10 minutes.
 *
 * PASS A (materialize): for each active enrollment that's due
 * (next_send_at <= now), render the NEXT step against the lead into a
 * crm_emails row — status 'pending_approval' (or 'approved' when the
 * org's autoSend is on) — and advance the enrollment pointer. Advancing
 * at materialize time (not send time) keeps the sweep from
 * re-materializing the same step while a batch sits in the outbox
 * awaiting approval. The partial-unique (enrollment_id, step_id) index
 * makes double-materialization a no-op (23505 → skip, mudflap-style).
 *
 * PASS B (send): business-hours window → daily-cap budget → oldest
 * approved first → per-email HARD re-check (lead status + suppression
 * list) inside the loop immediately before the Resend call. An
 * unsubscribe that lands between "approve batch" and this tick still
 * blocks the send — that's the whole point of checking at send time.
 *
 * Both passes are per-org (CRM_INTERNAL_ORG_IDS) and no-op cleanly
 * when the list is empty. Single-replica caveat applies (in-process
 * cron); double-fire is harmless: Pass A dedupes on the unique index,
 * Pass B claims each email row with a conditional UPDATE before
 * sending, so a second concurrent pass skips claimed rows.
 */

import { env } from "../lib/env.js";
import { supabase } from "../lib/supabase.js";
import { sendOutreachEmail, renderForLead, outreachConfigError } from "../lib/crmOutreach.js";
import {
  SEND_BLOCKED_STATUSES,
  resolveCrmSettings,
  type CrmLead,
  type CrmLeadStatus,
  type CrmSettings,
} from "@fleetcal/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause between sends — polite to Resend's rate limits. */
const INTER_SEND_MS = 600;

export interface CrmSendSweepResult {
  skipped: boolean;
  reason?: string;
  orgs?: Array<{
    orgId: string;
    materialized: number;
    sent: number;
    suppressed: number;
    failed: number;
    capRemaining?: number;
    windowOpen?: boolean;
    error?: string;
  }>;
}

// ── Time helpers ────────────────────────────────────────────────────────

/** Hour-of-day (0-23) and weekday flag for "now" in the given IANA tz. */
function nowInTz(timezone: string): { hour: number; isWeekday: boolean; dayKey: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const isWeekday = !["Sat", "Sun"].includes(get("weekday"));
  const dayKey = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour, isWeekday, dayKey };
}

/** UTC instant of local midnight (start of `dayKey`) in `timezone`.
 *
 *  BUG HISTORY: the previous version started from UTC midnight of
 *  dayKey and walked BACK by the offset. For negative-offset zones
 *  (Denver = UTC-6), UTC midnight is 6pm of the PREVIOUS local day,
 *  so walking back 18 hours landed on the previous day's local
 *  midnight — a 24-hour undercount that dumped yesterday's sends
 *  into today's daily-cap budget. First affected batch: Matt's 25
 *  approved on 2026-07-02 stayed queued for a full day because his
 *  25 from 2026-07-01 counted as "today's" usage.
 *
 *  Correct algorithm: interpret `dayKey` as the target LOCAL date,
 *  start from noon UTC of that dayKey (safely away from DST edges),
 *  and iterate the candidate toward the calendar delta between
 *  local-time-of-candidate and (dayKey, 00:00). Converges in ≤ 2
 *  iterations for every real timezone including half-hour offsets
 *  (India UTC+5:30) and 45-minute offsets (Nepal UTC+5:45). */
function startOfDayUtc(dayKey: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return new Date(`${dayKey}T00:00:00Z`); // malformed input — safest fallback
  const [, ys, ms, ds] = match;
  const yTarget = Number(ys);
  const mTarget = Number(ms);
  const dTarget = Number(ds);
  const targetMs = Date.UTC(yTarget, mTarget - 1, dTarget, 0, 0);

  let candidate = new Date(`${dayKey}T12:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(candidate);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    const localMs = Date.UTC(
      Number(get("year")),
      Number(get("month")) - 1,
      Number(get("day")),
      Number(get("hour")) % 24,
      Number(get("minute")),
    );
    const deltaMs = targetMs - localMs;
    if (deltaMs === 0) break;
    candidate = new Date(candidate.getTime() + deltaMs);
  }
  return candidate;
}

// ── Pass A: materialize due steps ───────────────────────────────────────

interface StepRow {
  id: string;
  step_order: number;
  wait_days: number;
  subject_template: string;
  body_template: string;
}

function rowToLeadLite(r: Record<string, unknown>): CrmLead {
  return {
    id: r.id as string,
    source: (r.source as CrmLead["source"]) ?? "manual",
    legalName: r.legal_name as string,
    dbaName: (r.dba_name as string | null) ?? undefined,
    email: (r.email as string | null) ?? undefined,
    phyCity: (r.phy_city as string | null) ?? undefined,
    phyState: (r.phy_state as string | null) ?? undefined,
    powerUnits: (r.power_units as number | null) ?? undefined,
    status: r.status as CrmLeadStatus,
    statusChangedAt: "",
    callAttempts: 0,
    createdAt: "",
    updatedAt: "",
  };
}

async function stopEnrollment(enrollmentId: string, orgId: string, status: string, note: string, leadId: string): Promise<void> {
  await supabase
    .from("crm_enrollments")
    .update({ status, next_send_at: null })
    .eq("id", enrollmentId)
    .eq("org_id", orgId);
  await supabase.from("crm_activities").insert({
    org_id: orgId,
    lead_id: leadId,
    kind: "unenrolled",
    body: note,
    meta: null,
    actor_user_id: null,
  });
}

async function materializeDue(orgId: string, settings: CrmSettings): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: dueRaw } = await supabase
    .from("crm_enrollments")
    .select("id,lead_id,sequence_id,current_step,next_send_at")
    .eq("org_id", orgId)
    .eq("status", "active")
    .lte("next_send_at", nowIso)
    .order("next_send_at", { ascending: true })
    .limit(200);
  const due = (dueRaw ?? []) as Array<{
    id: string; lead_id: string; sequence_id: string; current_step: number;
  }>;
  if (due.length === 0) return 0;

  let materialized = 0;
  for (const enr of due) {
    // Next step for this enrollment
    const { data: stepRaw } = await supabase
      .from("crm_sequence_steps")
      .select("id,step_order,wait_days,subject_template,body_template")
      .eq("org_id", orgId)
      .eq("sequence_id", enr.sequence_id)
      .eq("step_order", enr.current_step + 1)
      .maybeSingle();
    const step = stepRaw as StepRow | null;
    if (!step) {
      // No more steps → sequence complete.
      await supabase
        .from("crm_enrollments")
        .update({ status: "completed", next_send_at: null })
        .eq("id", enr.id)
        .eq("org_id", orgId);
      continue;
    }

    // Lead pre-checks (cheap filter; the HARD check re-runs at send time).
    const { data: leadRaw } = await supabase
      .from("crm_leads")
      .select("id,source,legal_name,dba_name,email,phy_city,phy_state,power_units,status,unsubscribe_token,email_verification_status")
      .eq("id", enr.lead_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!leadRaw) {
      await stopEnrollment(enr.id, orgId, "stopped", "Sequence stopped: lead no longer exists", enr.lead_id);
      continue;
    }
    const leadRow = leadRaw as Record<string, unknown>;
    const lead = rowToLeadLite(leadRow);
    if ((SEND_BLOCKED_STATUSES as readonly string[]).includes(lead.status)) {
      await stopEnrollment(enr.id, orgId, "stopped", `Sequence stopped: lead status is ${lead.status}`, enr.lead_id);
      continue;
    }
    if (!lead.email) {
      await stopEnrollment(enr.id, orgId, "stopped", "Sequence stopped: lead has no email address", enr.lead_id);
      continue;
    }
    // Belt-and-braces email-verification guard. Enrollment already
    // requires 'valid', but a manual DB tweak or a status downgrade
    // between enrollment and materialization must not slip a bad
    // address onto the wire. Unverified emails don't fail — the sweep
    // just defers and picks them up once verification runs.
    const verificationStatus = (leadRow.email_verification_status as string | null) ?? null;
    if (verificationStatus !== "valid") {
      if (verificationStatus == null) {
        continue; // stay enrolled; will send after batch verification lands 'valid'
      }
      await stopEnrollment(enr.id, orgId, "stopped", `Sequence stopped: email verification is ${verificationStatus}`, enr.lead_id);
      continue;
    }
    const { data: suppressed } = await supabase
      .from("crm_suppressions")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", lead.email.toLowerCase())
      .maybeSingle();
    if (suppressed) {
      await stopEnrollment(enr.id, orgId, "stopped", "Sequence stopped: email is on the suppression list", enr.lead_id);
      continue;
    }

    // Render snapshots + insert. 23505 on the (enrollment, step) unique
    // index means a previous pass already materialized this step —
    // advance the pointer anyway (it may have crashed mid-loop before).
    const unsubToken = leadRow.unsubscribe_token as string;
    const subject = renderForLead(step.subject_template, lead, unsubToken);
    const body = renderForLead(step.body_template, lead, unsubToken);
    const { error: insErr } = await supabase.from("crm_emails").insert({
      org_id: orgId,
      lead_id: enr.lead_id,
      enrollment_id: enr.id,
      step_id: step.id,
      to_email: lead.email,
      subject,
      body,
      status: settings.autoSend ? "approved" : "pending_approval",
    });
    if (insErr && insErr.code !== "23505") {
      console.error(`[crm-send-sweep] materialize insert failed for enrollment ${enr.id}:`, insErr.message);
      continue; // leave pointer un-advanced; retried next tick
    }
    if (!insErr) materialized++;

    // Advance pointer + schedule the step AFTER this one.
    const { data: nextStepRaw } = await supabase
      .from("crm_sequence_steps")
      .select("wait_days")
      .eq("org_id", orgId)
      .eq("sequence_id", enr.sequence_id)
      .eq("step_order", step.step_order + 1)
      .maybeSingle();
    const nextStep = nextStepRaw as { wait_days: number } | null;
    await supabase
      .from("crm_enrollments")
      .update(
        nextStep
          ? {
              current_step: step.step_order,
              next_send_at: new Date(Date.now() + nextStep.wait_days * 24 * 60 * 60 * 1000).toISOString(),
            }
          : { current_step: step.step_order, status: "completed", next_send_at: null },
      )
      .eq("id", enr.id)
      .eq("org_id", orgId);

    // Flip lead into the emailing pipeline on first materialization.
    if (lead.status === "enriched" || lead.status === "new") {
      await supabase
        .from("crm_leads")
        .update({ status: "queued", status_changed_at: new Date().toISOString() })
        .eq("id", enr.lead_id)
        .eq("org_id", orgId)
        .in("status", ["enriched", "new"]);
    }
  }
  return materialized;
}

// ── Pass B: send approved ───────────────────────────────────────────────

interface SendPassResult {
  sent: number;
  suppressed: number;
  failed: number;
  capRemaining: number;
  windowOpen: boolean;
}

async function sendApproved(orgId: string, settings: CrmSettings): Promise<SendPassResult> {
  const res: SendPassResult = { sent: 0, suppressed: 0, failed: 0, capRemaining: 0, windowOpen: false };

  // 1. Business-hours window (approved emails just wait outside it).
  const { hour, isWeekday, dayKey } = nowInTz(settings.sendWindow.timezone);
  if (settings.sendWindow.weekdaysOnly && !isWeekday) return res;
  if (hour < settings.sendWindow.startHour || hour >= settings.sendWindow.endHour) return res;
  res.windowOpen = true;

  // 2. Daily cap: sent today, in the org's send timezone.
  const dayStart = startOfDayUtc(dayKey, settings.sendWindow.timezone).toISOString();
  const { count: sentToday } = await supabase
    .from("crm_emails")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("status", "sent")
    .gte("sent_at", dayStart);
  const budget = Math.max(0, settings.dailySendCap - (sentToday ?? 0));
  res.capRemaining = budget;
  if (budget === 0) return res;

  // Config problems: surface loudly on the oldest approved row rather
  // than throwing every tick.
  const configError = outreachConfigError(settings);

  // 3. Oldest approved first, bounded by remaining budget.
  const { data: approvedRaw } = await supabase
    .from("crm_emails")
    .select("id,lead_id,to_email,subject,body")
    .eq("org_id", orgId)
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(budget);
  const approved = (approvedRaw ?? []) as Array<{
    id: string; lead_id: string; to_email: string; subject: string; body: string;
  }>;

  for (const email of approved) {
    if (configError) {
      await supabase
        .from("crm_emails")
        .update({ status: "failed", error: configError })
        .eq("id", email.id)
        .eq("org_id", orgId)
        .eq("status", "approved");
      res.failed++;
      continue;
    }

    // 4. HARD re-checks, inside the loop, immediately before the send.
    const { data: leadRaw } = await supabase
      .from("crm_leads")
      .select("id,status,unsubscribe_token,email")
      .eq("id", email.lead_id)
      .eq("org_id", orgId)
      .maybeSingle();
    const lead = leadRaw as { id: string; status: string; unsubscribe_token: string; email: string | null } | null;
    const { data: suppression } = await supabase
      .from("crm_suppressions")
      .select("id")
      .eq("org_id", orgId)
      .eq("email", email.to_email.toLowerCase())
      .maybeSingle();
    if (!lead || (SEND_BLOCKED_STATUSES as readonly string[]).includes(lead.status) || suppression) {
      await supabase
        .from("crm_emails")
        .update({ status: "suppressed", error: suppression ? "address on suppression list at send time" : `lead status ${lead?.status ?? "missing"} at send time` })
        .eq("id", email.id)
        .eq("org_id", orgId)
        .eq("status", "approved");
      res.suppressed++;
      continue;
    }

    // 5. Claim the row (conditional update) so a concurrent pass can't
    // double-send, then call Resend.
    const { data: claimed } = await supabase
      .from("crm_emails")
      .update({ error: null })
      .eq("id", email.id)
      .eq("org_id", orgId)
      .eq("status", "approved")
      .select("id");
    if (!claimed || claimed.length === 0) continue; // someone else took it

    try {
      const { messageId } = await sendOutreachEmail({
        to: email.to_email,
        subject: email.subject,
        body: email.body,
        unsubToken: lead.unsubscribe_token,
        settings,
      });
      await supabase
        .from("crm_emails")
        .update({ status: "sent", sent_at: new Date().toISOString(), resend_message_id: messageId })
        .eq("id", email.id)
        .eq("org_id", orgId);
      await supabase.from("crm_activities").insert({
        org_id: orgId,
        lead_id: email.lead_id,
        kind: "email_sent",
        body: email.subject,
        meta: { emailId: email.id, resendMessageId: messageId },
        actor_user_id: null,
      });
      await supabase
        .from("crm_leads")
        .update({ status: "emailing", status_changed_at: new Date().toISOString() })
        .eq("id", email.lead_id)
        .eq("org_id", orgId)
        .eq("status", "queued");
      res.sent++;
    } catch (err) {
      await supabase
        .from("crm_emails")
        .update({ status: "failed", error: err instanceof Error ? err.message : String(err) })
        .eq("id", email.id)
        .eq("org_id", orgId);
      res.failed++;
    }
    await sleep(INTER_SEND_MS);
  }

  res.capRemaining = budget - res.sent;
  return res;
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function runCrmSendSweep(): Promise<CrmSendSweepResult> {
  if (env.crmInternalOrgIds.length === 0) {
    return { skipped: true, reason: "no_internal_orgs" };
  }
  const orgs: CrmSendSweepResult["orgs"] = [];
  for (const orgId of env.crmInternalOrgIds) {
    try {
      const { data: settingsRow } = await supabase
        .from("org_settings")
        .select("crm_settings")
        .eq("org_id", orgId)
        .maybeSingle();
      const settings = resolveCrmSettings(
        (settingsRow as { crm_settings?: unknown } | null)?.crm_settings,
      );
      const materialized = await materializeDue(orgId, settings);
      const send = await sendApproved(orgId, settings);
      orgs.push({ orgId, materialized, ...send });
    } catch (err) {
      console.error(`[crm-send-sweep] org ${orgId} failed:`, err);
      orgs.push({
        orgId, materialized: 0, sent: 0, suppressed: 0, failed: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { skipped: false, orgs };
}
