/**
 * CRM routes — INTERNAL sales tooling (Phase 1: leads foundation).
 *
 *   GET    /v1/crm/leads                 — list with filters + paging
 *   POST   /v1/crm/leads                 — add a manual lead
 *   GET    /v1/crm/leads/:id             — lead + activity timeline
 *   PATCH  /v1/crm/leads/:id             — edit fields / move status
 *   POST   /v1/crm/leads/:id/activities  — add a note
 *   GET    /v1/crm/stats                 — pipeline counts
 *   GET    /v1/crm/settings              — resolved CrmSettings
 *   PATCH  /v1/crm/settings              — merge-write crm_settings   (crm.manage)
 *   POST   /v1/crm/sync                  — manual FMCSA sync           (crm.manage)
 *
 * Triple-gated: requireInternalOrg (404s non-allowlisted orgs — the
 * routes are invisible to customer orgs), the `crm` module flag
 * (default-OFF), and crm.access/crm.manage capabilities. Phase 2 adds
 * sequences/enrollments/emails; Phase 3 adds the call queue.
 */

import { Hono } from "hono";
import {
  CRM_EMAIL_STATUSES,
  CRM_LEAD_STATUSES,
  SEND_BLOCKED_STATUSES,
  resolveCrmSettings,
  type ApiErrorResponse,
  type CrmActivity,
  type CrmEmail,
  type CrmLead,
  type CrmLeadStatus,
  type CrmSequence,
  type CrmSequenceStep,
  type CrmSettings,
  type CrmStats,
  type Database,
  type Json,
} from "@fleetcal/types";
import { supabase } from "../lib/supabase.js";
import { syncCrmLeadsForOrg } from "../jobs/crmFmcsaSyncSweep.js";
import { verifyEmailsForOrg } from "../jobs/crmVerifyEmailsBatch.js";
import {
  requireCapability,
  requireInternalOrg,
  requireModule,
} from "../middleware/require.js";
import type { AuthVariables } from "../middleware/clerk.js";

const crm = new Hono<{ Variables: AuthVariables }>();

// Order matters: the internal-org 404 fires before the module/cap 403s
// so non-allowlisted orgs can't distinguish the CRM from a dead route.
crm.use("*", requireInternalOrg, requireModule("crm"), requireCapability("crm.access"));

// ── Row mappers ─────────────────────────────────────────────────────────

const LEAD_COLS =
  "id,org_id,dot_number,source,legal_name,dba_name,email,phone,cell_phone," +
  "phy_street,phy_city,phy_state,phy_zip,power_units,total_drivers," +
  "carrier_operation,interstate_within_100,interstate_beyond_100," +
  "intrastate_within_100,intrastate_beyond_100,hm_ind,mcs150_date," +
  "fmcsa_add_date,status,status_changed_at,owner_user_id,next_action_at," +
  "call_attempts,email_verification_status,email_verified_at,email_verification_provider," +
  "created_at,updated_at";

type LeadRow = Record<string, unknown>;
type CrmLeadUpdate = Database["public"]["Tables"]["crm_leads"]["Update"];

function rowToLead(r: LeadRow): CrmLead {
  return {
    id:              r.id as string,
    dotNumber:       (r.dot_number as number | null) ?? undefined,
    source:          r.source as CrmLead["source"],
    legalName:       r.legal_name as string,
    dbaName:         (r.dba_name as string | null) ?? undefined,
    email:           (r.email as string | null) ?? undefined,
    phone:           (r.phone as string | null) ?? undefined,
    cellPhone:       (r.cell_phone as string | null) ?? undefined,
    phyStreet:       (r.phy_street as string | null) ?? undefined,
    phyCity:         (r.phy_city as string | null) ?? undefined,
    phyState:        (r.phy_state as string | null) ?? undefined,
    phyZip:          (r.phy_zip as string | null) ?? undefined,
    powerUnits:      (r.power_units as number | null) ?? undefined,
    totalDrivers:    (r.total_drivers as number | null) ?? undefined,
    carrierOperation:    (r.carrier_operation as string | null) ?? undefined,
    interstateWithin100: (r.interstate_within_100 as number | null) ?? undefined,
    interstateBeyond100: (r.interstate_beyond_100 as number | null) ?? undefined,
    intrastateWithin100: (r.intrastate_within_100 as number | null) ?? undefined,
    intrastateBeyond100: (r.intrastate_beyond_100 as number | null) ?? undefined,
    hmInd:           (r.hm_ind as boolean | null) ?? undefined,
    mcs150Date:      (r.mcs150_date as string | null) ?? undefined,
    fmcsaAddDate:    (r.fmcsa_add_date as string | null) ?? undefined,
    status:          r.status as CrmLeadStatus,
    statusChangedAt: r.status_changed_at as string,
    ownerUserId:     (r.owner_user_id as string | null) ?? undefined,
    nextActionAt:    (r.next_action_at as string | null) ?? undefined,
    callAttempts:    (r.call_attempts as number) ?? 0,
    emailVerificationStatus:   (r.email_verification_status as CrmLead["emailVerificationStatus"] | null) ?? undefined,
    emailVerifiedAt:           (r.email_verified_at as string | null) ?? undefined,
    emailVerificationProvider: (r.email_verification_provider as string | null) ?? undefined,
    createdAt:       r.created_at as string,
    updatedAt:       r.updated_at as string,
  };
}

function rowToActivity(r: Record<string, unknown>): CrmActivity {
  return {
    id:          r.id as string,
    leadId:      r.lead_id as string,
    kind:        r.kind as CrmActivity["kind"],
    body:        (r.body as string | null) ?? undefined,
    meta:        (r.meta as Record<string, unknown> | null) ?? undefined,
    actorUserId: (r.actor_user_id as string | null) ?? undefined,
    createdAt:   r.created_at as string,
  };
}

async function logActivity(
  orgId: string,
  leadId: string,
  kind: CrmActivity["kind"],
  fields: { body?: string; meta?: Record<string, unknown>; actorUserId?: string } = {},
): Promise<void> {
  await supabase.from("crm_activities").insert({
    org_id:        orgId,
    lead_id:       leadId,
    kind,
    body:          fields.body ?? null,
    meta:          (fields.meta ?? null) as Json,
    actor_user_id: fields.actorUserId ?? null,
  });
}

// ── Leads ───────────────────────────────────────────────────────────────

crm.get("/leads", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const status  = url.searchParams.get("status");
  const state   = url.searchParams.get("state");
  const puMin   = url.searchParams.get("puMin");
  const puMax   = url.searchParams.get("puMax");
  const hasEmail = url.searchParams.get("hasEmail");
  const local   = url.searchParams.get("local");
  const verification = url.searchParams.get("verification"); // 'valid'|'invalid'|'unverified'|null
  const q       = url.searchParams.get("q")?.trim();
  const limit   = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset  = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  let query = supabase
    .from("crm_leads")
    .select(LEAD_COLS, { count: "exact" })
    .eq("org_id", orgId);

  if (status && (CRM_LEAD_STATUSES as readonly string[]).includes(status)) {
    query = query.eq("status", status);
  }
  if (state)  query = query.eq("phy_state", state.toUpperCase());
  if (puMin)  query = query.gte("power_units", Number(puMin));
  if (puMax)  query = query.lte("power_units", Number(puMax));
  if (hasEmail === "true")  query = query.not("email", "is", null);
  if (hasEmail === "false") query = query.is("email", null);
  if (verification === "unverified") query = query.is("email_verification_status", null);
  else if (verification) query = query.eq("email_verification_status", verification);
  if (local === "true") {
    // Local proxy: some within-100 drivers, no beyond-100 drivers.
    query = query
      .or("interstate_within_100.gt.0,intrastate_within_100.gt.0")
      .or("interstate_beyond_100.is.null,interstate_beyond_100.eq.0")
      .or("intrastate_beyond_100.is.null,intrastate_beyond_100.eq.0");
  }
  if (q) {
    const like = `%${q.replaceAll("%", "").replaceAll(",", "")}%`;
    const asDot = Number(q);
    query = Number.isInteger(asDot) && asDot > 0
      ? query.or(`legal_name.ilike.${like},dba_name.ilike.${like},dot_number.eq.${asDot}`)
      : query.or(`legal_name.ilike.${like},dba_name.ilike.${like}`);
  }

  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ leads: ((data ?? []) as unknown as LeadRow[]).map(rowToLead), total: count ?? 0 });
});

crm.post("/leads", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<Partial<CrmLead>>();
  if (!body.legalName?.trim()) {
    return c.json({ error: "validation_failed", errors: ["legalName required"] } satisfies ApiErrorResponse, 400);
  }
  const email = body.email?.trim().toLowerCase() || null;
  const { data, error } = await supabase
    .from("crm_leads")
    .insert({
      org_id:     orgId,
      source:     "manual",
      dot_number: body.dotNumber ?? null,
      legal_name: body.legalName.trim(),
      dba_name:   body.dbaName?.trim() || null,
      email,
      phone:      body.phone?.trim() || null,
      cell_phone: body.cellPhone?.trim() || null,
      phy_street: body.phyStreet?.trim() || null,
      phy_city:   body.phyCity?.trim() || null,
      phy_state:  body.phyState?.trim().toUpperCase() || null,
      phy_zip:    body.phyZip?.trim() || null,
      power_units: body.powerUnits ?? null,
      status:     email ? "enriched" : "new",
    })
    .select(LEAD_COLS)
    .single();
  if (error || !data) {
    // 23505 = duplicate dot_number for this org
    const dup = error?.code === "23505";
    return c.json(
      { error: dup ? "duplicate_dot_number" : "insert_failed", detail: error?.message } satisfies ApiErrorResponse,
      dup ? 409 : 500,
    );
  }
  const lead = rowToLead(data as unknown as LeadRow);
  await logActivity(orgId, lead.id, "system", { body: "Lead added manually", actorUserId: userId });
  return c.json({ lead }, 201);
});

crm.get("/leads/:id", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    return c.json({ error: "fetch_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const { data: activityRows } = await supabase
    .from("crm_activities")
    .select("id,lead_id,kind,body,meta,actor_user_id,created_at")
    .eq("org_id", orgId)
    .eq("lead_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  return c.json({
    lead: rowToLead(data as unknown as LeadRow),
    activities: ((activityRows ?? []) as unknown as Record<string, unknown>[]).map(rowToActivity),
  });
});

crm.patch("/leads/:id", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<Partial<CrmLead>>();

  const { data: existingRaw } = await supabase
    .from("crm_leads")
    .select("id,status")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!existingRaw) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  const prevStatus = (existingRaw as { status: CrmLeadStatus }).status;

  const update: CrmLeadUpdate = {};
  if ("legalName" in body && body.legalName?.trim()) update.legal_name = body.legalName.trim();
  if ("dbaName" in body)    update.dba_name   = body.dbaName?.trim() || null;
  if ("email" in body) {
    update.email = body.email?.trim().toLowerCase() || null;
    // Editing the email invalidates any prior verification — the new
    // address must be re-verified before enrollment can proceed.
    update.email_verification_status   = null;
    update.email_verified_at           = null;
    update.email_verification_provider = null;
    update.email_verification_raw      = null;
  }
  if ("phone" in body)      update.phone      = body.phone?.trim() || null;
  if ("cellPhone" in body)  update.cell_phone = body.cellPhone?.trim() || null;
  if ("phyStreet" in body)  update.phy_street = body.phyStreet?.trim() || null;
  if ("phyCity" in body)    update.phy_city   = body.phyCity?.trim() || null;
  if ("phyState" in body)   update.phy_state  = body.phyState?.trim().toUpperCase() || null;
  if ("phyZip" in body)     update.phy_zip    = body.phyZip?.trim() || null;
  if ("powerUnits" in body) update.power_units = body.powerUnits ?? null;
  if ("ownerUserId" in body)  update.owner_user_id  = body.ownerUserId ?? null;
  if ("nextActionAt" in body) update.next_action_at = body.nextActionAt ?? null;

  const statusChanging =
    "status" in body && body.status != null && body.status !== prevStatus;
  if (statusChanging) {
    if (!(CRM_LEAD_STATUSES as readonly string[]).includes(body.status!)) {
      return c.json({ error: "validation_failed", errors: [`invalid status: ${body.status}`] } satisfies ApiErrorResponse, 400);
    }
    update.status = body.status;
    update.status_changed_at = new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["no editable fields in body"] } satisfies ApiErrorResponse, 400);
  }

  const { data, error } = await supabase
    .from("crm_leads")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(LEAD_COLS)
    .single();
  if (error || !data) {
    return c.json({ error: "update_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }

  if (statusChanging) {
    await logActivity(orgId, id, "status_change", {
      meta: { from: prevStatus, to: body.status },
      actorUserId: userId,
    });
    // Hard-block transitions: suppress the address, stop enrollments,
    // cancel queued sends — the manual equivalents of the unsubscribe
    // link. (won/lost/disqualified block sends via SEND_BLOCKED_STATUSES
    // at send time but don't suppress the address forever.)
    if (body.status === "unsubscribed" || body.status === "do_not_contact") {
      const leadEmail = (data as unknown as LeadRow).email as string | null;
      if (leadEmail) {
        const { error: suppErr } = await supabase.from("crm_suppressions").insert({
          org_id: orgId,
          email: leadEmail.toLowerCase(),
          reason: body.status === "unsubscribed" ? "unsubscribe" : "manual",
          lead_id: id,
        });
        if (suppErr && suppErr.code !== "23505") {
          console.error("[PATCH /v1/crm/leads/:id] suppression insert failed:", suppErr.message);
        }
      }
      await supabase
        .from("crm_enrollments")
        .update({ status: "stopped", next_send_at: null })
        .eq("org_id", orgId)
        .eq("lead_id", id)
        .in("status", ["active", "paused"]);
      await supabase
        .from("crm_emails")
        .update({ status: "cancelled", error: `lead marked ${body.status}` })
        .eq("org_id", orgId)
        .eq("lead_id", id)
        .in("status", ["pending_approval", "approved"]);
    }
  }

  return c.json({ lead: rowToLead(data as unknown as LeadRow) });
});

crm.post("/leads/:id/activities", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<{ body?: string }>();
  if (!body.body?.trim()) {
    return c.json({ error: "validation_failed", errors: ["body required"] } satisfies ApiErrorResponse, 400);
  }
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!lead) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  const { data, error } = await supabase
    .from("crm_activities")
    .insert({ org_id: orgId, lead_id: id, kind: "note", body: body.body.trim(), actor_user_id: userId })
    .select("id,lead_id,kind,body,meta,actor_user_id,created_at")
    .single();
  if (error || !data) {
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ activity: rowToActivity(data as Record<string, unknown>) }, 201);
});

// ── Stats ───────────────────────────────────────────────────────────────

crm.get("/stats", async (c) => {
  const orgId = c.get("orgId");
  // Small pipeline (thousands of leads) — count per status in one
  // round-trip each; fine at this scale, revisit if it ever isn't.
  const byStatus: CrmStats["byStatus"] = {};
  let totalLeads = 0;
  await Promise.all(
    CRM_LEAD_STATUSES.map(async (status) => {
      const { count } = await supabase
        .from("crm_leads")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("status", status);
      if (count) { byStatus[status] = count; totalLeads += count; }
    }),
  );
  const { data: syncRow } = await supabase
    .from("crm_sync_state")
    .select("last_run_at")
    .eq("org_id", orgId)
    .eq("source", "fmcsa_census")
    .maybeSingle();
  const stats: CrmStats = {
    byStatus,
    totalLeads,
    lastSyncAt: (syncRow as { last_run_at?: string } | null)?.last_run_at ?? undefined,
  };
  return c.json({ stats });
});

// ── Settings ────────────────────────────────────────────────────────────

crm.get("/settings", async (c) => {
  const orgId = c.get("orgId");
  const { data } = await supabase
    .from("org_settings")
    .select("crm_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const settings = resolveCrmSettings((data as { crm_settings?: unknown } | null)?.crm_settings);
  return c.json({ settings });
});

crm.patch("/settings", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<Partial<CrmSettings>>();
  // Merge over the currently-resolved settings so a partial PATCH
  // (e.g. just dailySendCap) doesn't wipe the rest.
  const { data: current } = await supabase
    .from("org_settings")
    .select("crm_settings")
    .eq("org_id", orgId)
    .maybeSingle();
  const cur = resolveCrmSettings((current as { crm_settings?: unknown } | null)?.crm_settings);
  // Deep-merge the nested bags so a partial PATCH (e.g. just
  // icp.powerUnitsMax) keeps the org's other stored values instead of
  // silently resetting them to code defaults.
  const merged = resolveCrmSettings({
    ...cur,
    ...body,
    icp:        { ...cur.icp,        ...(body.icp ?? {}) },
    sendWindow: { ...cur.sendWindow, ...(body.sendWindow ?? {}) },
  });
  const { error } = await supabase
    .from("org_settings")
    .upsert({ org_id: orgId, crm_settings: merged as unknown as Json }, { onConflict: "org_id" });
  if (error) {
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  return c.json({ settings: merged });
});

// ── Sequences (Phase 2) ─────────────────────────────────────────────────

const STEP_COLS = "id,sequence_id,step_order,wait_days,subject_template,body_template";

function rowToStep(r: Record<string, unknown>): CrmSequenceStep {
  return {
    id:              r.id as string,
    sequenceId:      r.sequence_id as string,
    stepOrder:       r.step_order as number,
    waitDays:        r.wait_days as number,
    subjectTemplate: r.subject_template as string,
    bodyTemplate:    r.body_template as string,
  };
}

crm.get("/sequences", async (c) => {
  const orgId = c.get("orgId");
  const { data: seqRaw, error } = await supabase
    .from("crm_sequences")
    .select("id,name,is_active,created_by,created_at,updated_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  if (error) {
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const seqs = (seqRaw ?? []) as Record<string, unknown>[];
  const ids = seqs.map((s) => s.id as string);
  const stepsBySeq = new Map<string, CrmSequenceStep[]>();
  if (ids.length > 0) {
    const { data: stepRaw } = await supabase
      .from("crm_sequence_steps")
      .select(STEP_COLS)
      .eq("org_id", orgId)
      .in("sequence_id", ids)
      .order("step_order", { ascending: true });
    for (const r of (stepRaw ?? []) as Record<string, unknown>[]) {
      const step = rowToStep(r);
      const arr = stepsBySeq.get(step.sequenceId) ?? [];
      arr.push(step);
      stepsBySeq.set(step.sequenceId, arr);
    }
  }
  const sequences: CrmSequence[] = seqs.map((s) => ({
    id:        s.id as string,
    name:      s.name as string,
    isActive:  s.is_active as boolean,
    createdBy: (s.created_by as string | null) ?? undefined,
    steps:     stepsBySeq.get(s.id as string) ?? [],
    createdAt: s.created_at as string,
    updatedAt: s.updated_at as string,
  }));
  return c.json({ sequences });
});

crm.post("/sequences", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: string }>();
  if (!body.name?.trim()) {
    return c.json({ error: "validation_failed", errors: ["name required"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("crm_sequences")
    .insert({ org_id: orgId, name: body.name.trim(), created_by: userId })
    .select("id,name,is_active,created_by,created_at,updated_at")
    .single();
  if (error || !data) {
    return c.json({ error: "insert_failed", detail: error?.message } satisfies ApiErrorResponse, 500);
  }
  const s = data as Record<string, unknown>;
  return c.json({
    sequence: {
      id: s.id as string, name: s.name as string, isActive: s.is_active as boolean,
      createdBy: (s.created_by as string | null) ?? undefined, steps: [],
      createdAt: s.created_at as string, updatedAt: s.updated_at as string,
    } satisfies CrmSequence,
  }, 201);
});

crm.patch("/sequences/:id", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; isActive?: boolean }>();
  const update: Database["public"]["Tables"]["crm_sequences"]["Update"] = {};
  if (body.name?.trim()) update.name = body.name.trim();
  if (typeof body.isActive === "boolean") update.is_active = body.isActive;
  if (Object.keys(update).length === 0) {
    return c.json({ error: "validation_failed", errors: ["nothing to update"] } satisfies ApiErrorResponse, 400);
  }
  const { data, error } = await supabase
    .from("crm_sequences")
    .update(update)
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id")
    .maybeSingle();
  if (error) {
    return c.json({ error: "update_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  return c.json({ ok: true });
});

// Replace the full step list transactionally-ish: delete + reinsert.
// Rendered crm_emails rows keep their snapshots (step_id goes stale via
// ON DELETE SET NULL — the outbox shows exactly what was rendered).
crm.put("/sequences/:id/steps", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const body = await c.req.json<{ steps?: Array<Partial<CrmSequenceStep>> }>();
  if (!Array.isArray(body.steps)) {
    return c.json({ error: "validation_failed", errors: ["steps array required"] } satisfies ApiErrorResponse, 400);
  }
  const errors: string[] = [];
  body.steps.forEach((s, i) => {
    if (!s.subjectTemplate?.trim()) errors.push(`step ${i + 1}: subjectTemplate required`);
    if (!s.bodyTemplate?.trim())    errors.push(`step ${i + 1}: bodyTemplate required`);
    if (s.waitDays != null && (s.waitDays < 0 || s.waitDays > 90)) errors.push(`step ${i + 1}: waitDays out of range`);
  });
  if (errors.length) return badRequestCrm(c, errors);

  const { data: seq } = await supabase
    .from("crm_sequences")
    .select("id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!seq) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  await supabase.from("crm_sequence_steps").delete().eq("sequence_id", id).eq("org_id", orgId);
  if (body.steps.length > 0) {
    const rows = body.steps.map((s, i) => ({
      org_id:           orgId,
      sequence_id:      id,
      step_order:       i + 1,
      wait_days:        s.waitDays ?? 0,
      subject_template: s.subjectTemplate!.trim(),
      body_template:    s.bodyTemplate!.trim(),
    }));
    const { error: insErr } = await supabase.from("crm_sequence_steps").insert(rows);
    if (insErr) {
      return c.json({ error: "steps_insert_failed", detail: insErr.message } satisfies ApiErrorResponse, 500);
    }
  }
  const { data: stepRaw } = await supabase
    .from("crm_sequence_steps")
    .select(STEP_COLS)
    .eq("org_id", orgId)
    .eq("sequence_id", id)
    .order("step_order", { ascending: true });
  return c.json({ steps: ((stepRaw ?? []) as Record<string, unknown>[]).map(rowToStep) });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHonoContext = any;
function badRequestCrm(c: AnyHonoContext, errors: string[]) {
  return c.json({ error: "validation_failed", errors } satisfies ApiErrorResponse, 400);
}

// ── Enrollments (Phase 2) ───────────────────────────────────────────────

crm.post("/leads/:id/enroll", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const leadId = c.req.param("id");
  const body = await c.req.json<{ sequenceId?: string }>();
  if (!body.sequenceId) {
    return c.json({ error: "validation_failed", errors: ["sequenceId required"] } satisfies ApiErrorResponse, 400);
  }

  const { data: leadRaw } = await supabase
    .from("crm_leads")
    .select("id,status,email,email_verification_status")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const lead = leadRaw as {
    id: string; status: string; email: string | null;
    email_verification_status: string | null;
  } | null;
  if (!lead) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  if ((SEND_BLOCKED_STATUSES as readonly string[]).includes(lead.status)) {
    return c.json({ error: "lead_blocked", detail: `lead status is ${lead.status}` } satisfies ApiErrorResponse, 409);
  }
  if (!lead.email) {
    return c.json({ error: "lead_has_no_email" } satisfies ApiErrorResponse, 409);
  }
  // Verified-`valid`-only enrollment. Cold-mailing an unverified or
  // known-bad address on a fresh domain is exactly how we lose sender
  // reputation. Unverified leads go through /crm/verify-emails first;
  // non-valid verdicts already got routed to the call queue.
  if (lead.email_verification_status == null) {
    return c.json({ error: "email_unverified", detail: "Verify this lead's email first (Verify batch)." } satisfies ApiErrorResponse, 409);
  }
  if (lead.email_verification_status !== "valid") {
    return c.json({ error: "email_not_deliverable", detail: `email verification: ${lead.email_verification_status}` } satisfies ApiErrorResponse, 409);
  }
  const { data: seq } = await supabase
    .from("crm_sequences")
    .select("id,is_active")
    .eq("id", body.sequenceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!seq) return c.json({ error: "sequence_not_found" } satisfies ApiErrorResponse, 404);

  const { data, error } = await supabase
    .from("crm_enrollments")
    .insert({
      org_id: orgId,
      lead_id: leadId,
      sequence_id: body.sequenceId,
      status: "active",
      current_step: 0,
      next_send_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    const dup = error?.code === "23505";
    return c.json(
      { error: dup ? "already_enrolled" : "insert_failed", detail: error?.message } satisfies ApiErrorResponse,
      dup ? 409 : 500,
    );
  }
  await logActivity(orgId, leadId, "enrolled", { meta: { sequenceId: body.sequenceId }, actorUserId: userId });
  await supabase
    .from("crm_leads")
    .update({ status: "queued", status_changed_at: new Date().toISOString() })
    .eq("id", leadId)
    .eq("org_id", orgId)
    .in("status", ["new", "enriched"]);
  return c.json({ enrollmentId: (data as { id: string }).id }, 201);
});

crm.post("/enrollments/:id/:action", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const id = c.req.param("id");
  const action = c.req.param("action");
  if (!["pause", "resume", "stop"].includes(action)) {
    return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);
  }
  const { data: enrRaw } = await supabase
    .from("crm_enrollments")
    .select("id,lead_id,status,next_send_at")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const enr = enrRaw as { id: string; lead_id: string; status: string; next_send_at: string | null } | null;
  if (!enr) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  if (action === "pause") {
    if (enr.status !== "active") {
      return c.json({ error: "invalid_state", detail: `cannot pause a ${enr.status} enrollment` } satisfies ApiErrorResponse, 409);
    }
    await supabase.from("crm_enrollments").update({ status: "paused" }).eq("id", id).eq("org_id", orgId);
  } else if (action === "resume") {
    if (enr.status !== "paused") {
      return c.json({ error: "invalid_state", detail: `cannot resume a ${enr.status} enrollment` } satisfies ApiErrorResponse, 409);
    }
    // Anything that came due while paused sends on the next sweep tick.
    await supabase
      .from("crm_enrollments")
      .update({ status: "active", next_send_at: enr.next_send_at ?? new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", orgId);
  } else {
    await supabase
      .from("crm_enrollments")
      .update({ status: "stopped", next_send_at: null })
      .eq("id", id)
      .eq("org_id", orgId);
    await supabase
      .from("crm_emails")
      .update({ status: "cancelled", error: "enrollment stopped" })
      .eq("org_id", orgId)
      .eq("enrollment_id", id)
      .in("status", ["pending_approval", "approved"]);
    await logActivity(orgId, enr.lead_id, "unenrolled", { body: "Sequence stopped manually", actorUserId: userId });
  }
  return c.json({ ok: true });
});

crm.post("/leads/:id/mark-replied", async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const leadId = c.req.param("id");
  const { data: lead } = await supabase
    .from("crm_leads")
    .select("id,status")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!lead) return c.json({ error: "not_found" } satisfies ApiErrorResponse, 404);

  await supabase
    .from("crm_enrollments")
    .update({ status: "stopped", next_send_at: null })
    .eq("org_id", orgId)
    .eq("lead_id", leadId)
    .in("status", ["active", "paused"]);
  await supabase
    .from("crm_emails")
    .update({ status: "cancelled", error: "lead replied" })
    .eq("org_id", orgId)
    .eq("lead_id", leadId)
    .in("status", ["pending_approval", "approved"]);
  await supabase
    .from("crm_leads")
    .update({ status: "interested", status_changed_at: new Date().toISOString() })
    .eq("id", leadId)
    .eq("org_id", orgId);
  await logActivity(orgId, leadId, "email_replied", { body: "Marked replied", actorUserId: userId });
  // Future: Gmail API polling of the outreach inbox keyed on
  // In-Reply-To of stored resend_message_ids replaces this manual step.
  return c.json({ ok: true });
});

// ── Outbox / approval queue (Phase 2) ───────────────────────────────────

const EMAIL_COLS =
  "id,lead_id,enrollment_id,step_id,to_email,subject,body,status," +
  "approved_by,approved_at,sent_at,resend_message_id,error,created_at";

function rowToEmail(r: Record<string, unknown>, leadName?: string): CrmEmail {
  return {
    id:              r.id as string,
    leadId:          r.lead_id as string,
    enrollmentId:    (r.enrollment_id as string | null) ?? undefined,
    stepId:          (r.step_id as string | null) ?? undefined,
    toEmail:         r.to_email as string,
    subject:         r.subject as string,
    body:            r.body as string,
    status:          r.status as CrmEmail["status"],
    approvedBy:      (r.approved_by as string | null) ?? undefined,
    approvedAt:      (r.approved_at as string | null) ?? undefined,
    sentAt:          (r.sent_at as string | null) ?? undefined,
    resendMessageId: (r.resend_message_id as string | null) ?? undefined,
    error:           (r.error as string | null) ?? undefined,
    createdAt:       r.created_at as string,
    leadName,
  };
}

crm.get("/emails", async (c) => {
  const orgId = c.get("orgId");
  const url = new URL(c.req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

  let query = supabase
    .from("crm_emails")
    .select(EMAIL_COLS, { count: "exact" })
    .eq("org_id", orgId);
  if (status && (CRM_EMAIL_STATUSES as readonly string[]).includes(status)) {
    query = query.eq("status", status);
  }
  const { data, count, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    return c.json({ error: "list_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  // Join lead names for display (one IN query).
  const leadIds = [...new Set(rows.map((r) => r.lead_id as string))];
  const nameById = new Map<string, string>();
  if (leadIds.length > 0) {
    const { data: leadRows } = await supabase
      .from("crm_leads")
      .select("id,legal_name,dba_name")
      .eq("org_id", orgId)
      .in("id", leadIds);
    for (const l of (leadRows ?? []) as Array<{ id: string; legal_name: string; dba_name: string | null }>) {
      nameById.set(l.id, l.dba_name || l.legal_name);
    }
  }
  return c.json({
    emails: rows.map((r) => rowToEmail(r, nameById.get(r.lead_id as string))),
    total: count ?? 0,
  });
});

// Approve a batch. Body {ids?: string[]} — omitted = approve ALL
// pending_approval for the org (the one-click daily approval). The
// sweep still re-checks suppression at send time; approval is consent,
// not a bypass.
crm.post("/emails/approve-batch", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({} as { ids?: string[] }));

  let query = supabase
    .from("crm_emails")
    .update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("status", "pending_approval");
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    query = query.in("id", body.ids);
  }
  const { data, error } = await query.select("id");
  if (error) {
    return c.json({ error: "approve_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  // Kick an immediate send pass so approval feels instant when inside
  // the send window (fire-and-forget; the 10-min cron is the backstop).
  void import("../jobs/crmSendSweep.js").then(({ runCrmSendSweep }) =>
    runCrmSendSweep().catch((err) => console.error("[approve-batch] inline send pass failed:", err)),
  );
  return c.json({ approved: data?.length ?? 0 });
});

crm.post("/emails/:id/cancel", async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("crm_emails")
    .update({ status: "cancelled", error: "cancelled from outbox" })
    .eq("id", id)
    .eq("org_id", orgId)
    .in("status", ["pending_approval", "approved", "failed"])
    .select("id");
  if (error) {
    return c.json({ error: "cancel_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "not_cancellable" } satisfies ApiErrorResponse, 409);
  }
  return c.json({ ok: true });
});

// Retry a failed send: back to approved; the next sweep picks it up.
crm.post("/emails/:id/retry", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const id = c.req.param("id");
  const { data, error } = await supabase
    .from("crm_emails")
    .update({ status: "approved", error: null })
    .eq("id", id)
    .eq("org_id", orgId)
    .eq("status", "failed")
    .select("id");
  if (error) {
    return c.json({ error: "retry_failed", detail: error.message } satisfies ApiErrorResponse, 500);
  }
  if (!data || data.length === 0) {
    return c.json({ error: "not_retryable" } satisfies ApiErrorResponse, 409);
  }
  return c.json({ ok: true });
});

// ── Email verification (Phase 2.5) ──────────────────────────────────────

crm.post("/verify-emails", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req
    .json<{ count?: number; leadIds?: string[] }>()
    .catch(() => ({} as { count?: number; leadIds?: string[] }));
  // Hard-cap at 1000/click to keep API costs bounded even on a runaway
  // button. Bigger batches: fire the click multiple times.
  const count = Math.max(1, Math.min(body.count ?? 100, 1000));
  try {
    const result = await verifyEmailsForOrg(orgId, {
      count,
      leadIds: Array.isArray(body.leadIds) && body.leadIds.length > 0 ? body.leadIds : undefined,
    });
    return c.json({ result });
  } catch (err) {
    console.error("[POST /v1/crm/verify-emails] failed:", err);
    return c.json(
      { error: "verify_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse,
      502,
    );
  }
});

// ── Manual sync trigger ─────────────────────────────────────────────────

crm.post("/sync", requireCapability("crm.manage"), async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req
    .json<{ maxPages?: number; fromScratch?: boolean }>()
    .catch(() => ({} as { maxPages?: number; fromScratch?: boolean }));
  try {
    const result = await syncCrmLeadsForOrg(orgId, {
      // A from-scratch walk of the whole established-carrier set needs
      // ~30 pages; the normal button click caps lower to keep UI-
      // triggered runs snappy.
      maxPages: body.maxPages != null
        ? Math.min(body.maxPages, 50)
        : (body.fromScratch ? 30 : undefined),
      fromScratch: body.fromScratch,
    });
    return c.json({ result });
  } catch (err) {
    console.error("[POST /v1/crm/sync] failed:", err);
    return c.json(
      { error: "sync_failed", detail: err instanceof Error ? err.message : String(err) } satisfies ApiErrorResponse,
      502,
    );
  }
});

export { crm as crmRoute };
