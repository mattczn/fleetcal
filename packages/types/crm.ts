/**
 * @fleetcal/types — CRM (internal sales tooling) shared types.
 *
 * FleetCal-internal lead pipeline: FMCSA census ingest → email
 * outreach sequences → human call queue. These types are shared
 * between apps/api (routes/crm.ts, jobs) and apps/web (/crm pages).
 *
 * NOT a customer feature: every surface is triple-gated (internal-org
 * allowlist + `crm` module flag + `crm.access` capability). See
 * modules.ts DEFAULT_OFF_MODULES.
 */

// ── Pipeline statuses ────────────────────────────────────────────────

/**
 * Lead pipeline. Forward flow:
 *   new → enriched → queued → emailing → call_queue → interested
 *       → demo_scheduled → won | lost
 * Terminal side-exits (from any state): unsubscribed, do_not_contact,
 * disqualified. Everything in SEND_BLOCKED_STATUSES hard-blocks
 * outreach sends — enforced at SEND time in the sweep, not just at
 * enqueue.
 */
export const CRM_LEAD_STATUSES = [
  "new",            // ingested, no usable email yet (needs manual enrichment)
  "enriched",       // has an email; eligible for sequence enrollment
  "queued",         // enrolled in a sequence, first send pending
  "emailing",       // at least one sequence email sent
  "call_queue",     // ready for a human call
  "interested",     // replied / expressed interest
  "demo_scheduled",
  "won",
  "lost",
  "unsubscribed",   // clicked unsubscribe — never contact again
  "do_not_contact", // manual hard-block
  "disqualified",   // not ICP (e.g. long-haul only, bad number)
] as const;
export type CrmLeadStatus = (typeof CRM_LEAD_STATUSES)[number];

/** Statuses that hard-block outreach sends. Checked in the send loop
 *  immediately before the Resend call — not only at enqueue time. */
export const SEND_BLOCKED_STATUSES: readonly CrmLeadStatus[] = [
  "unsubscribed",
  "do_not_contact",
  "won",
  "lost",
  "disqualified",
];

export const CRM_LEAD_SOURCES = ["fmcsa_census", "manual"] as const;
export type CrmLeadSource = (typeof CRM_LEAD_SOURCES)[number];

/**
 * Per-lead email verification verdict. Set by the batch verifier
 * (NeverBounce today; interface allows swap). `null` = unverified. A
 * lead's email must be `valid` before the send sweep will materialize
 * a step for it and before enrollment is allowed — everything else
 * routes to the call queue instead of cold email.
 */
export const CRM_EMAIL_VERIFICATION_STATUSES = [
  "valid",       // safe to send
  "invalid",     // hard-bounces if you send
  "catchall",    // domain accepts everything but delivery uncertain
  "disposable",  // Guerrilla/tempmail — always treat as invalid
  "unknown",     // provider couldn't reach the server; retry later
] as const;
export type CrmEmailVerificationStatus = (typeof CRM_EMAIL_VERIFICATION_STATUSES)[number];

/** Statuses that mean "do NOT cold-email this lead" (route to call
 *  queue instead). `catchall` is included by default because the
 *  bounce-risk is real; a future setting can loosen this per-org. */
export const NON_SENDABLE_VERIFICATION_STATUSES: readonly CrmEmailVerificationStatus[] = [
  "invalid",
  "catchall",
  "disposable",
  "unknown",
];

export const CRM_ACTIVITY_KINDS = [
  "note",
  "status_change",
  "email_sent",
  "email_bounced",
  "email_replied",
  "call",
  "enrolled",
  "unenrolled",
  "unsubscribed",
  "system",
] as const;
export type CrmActivityKind = (typeof CRM_ACTIVITY_KINDS)[number];

/** Call-queue outcome buttons. Status/next-action mapping lives in
 *  the API (routes/crm.ts POST /leads/:id/call-outcome). */
export const CRM_CALL_OUTCOMES = [
  "no_answer",
  "voicemail",
  "bad_number",
  "not_interested",
  "interested",
  "demo_scheduled",
] as const;
export type CrmCallOutcome = (typeof CRM_CALL_OUTCOMES)[number];

// ── Domain shapes (camelCase, converter-mapped from DB rows) ─────────

export interface CrmLead {
  id: string;
  dotNumber?: number;
  source: CrmLeadSource;
  legalName: string;
  dbaName?: string;
  email?: string;
  phone?: string;
  cellPhone?: string;
  phyStreet?: string;
  phyCity?: string;
  phyState?: string;
  phyZip?: string;
  powerUnits?: number;
  totalDrivers?: number;
  /** MCS-150 operation class: A interstate, B intrastate hazmat, C intrastate non-hazmat. */
  carrierOperation?: string;
  /**
   * MCS-150 haul-radius DRIVER COUNTS (verified live 2026-07-02: these
   * census fields are numeric driver counts, not Y/N flags). "Local"
   * ICP proxy = within-100 counts > 0 AND beyond-100 counts === 0.
   */
  interstateWithin100?: number;
  interstateBeyond100?: number;
  intrastateWithin100?: number;
  intrastateBeyond100?: number;
  hmInd?: boolean;
  mcs150Date?: string;
  fmcsaAddDate?: string;
  status: CrmLeadStatus;
  statusChangedAt: string;
  ownerUserId?: string;
  nextActionAt?: string;
  callAttempts: number;
  emailVerificationStatus?: CrmEmailVerificationStatus;
  emailVerifiedAt?: string;
  emailVerificationProvider?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmActivity {
  id: string;
  leadId: string;
  kind: CrmActivityKind;
  body?: string;
  meta?: Record<string, unknown>;
  /** Clerk user id; absent = system/cron. */
  actorUserId?: string;
  createdAt: string;
}

// ── Org-level CRM settings (org_settings.crm_settings jsonb) ────────

export interface CrmIcpFilters {
  powerUnitsMin: number;               // default 4
  powerUnitsMax: number;               // default 10
  /** Two-letter state codes; empty = all US. */
  states: string[];
  /** MCS-150 operation classes to ingest. Default all three. */
  operationClasses: ("A" | "B" | "C")[];
  /** Soft filter: long-haul-only carriers are still ingested but
   *  stamped `disqualified` (never dropped). Default false. */
  localOnly: boolean;
  /** Only ingest for-hire carriers (census classdef contains
   *  "AUTHORIZED FOR HIRE"). Private fleets haul their own goods and
   *  don't buy dispatch software. Default true. */
  forHireOnly?: boolean;
  /** Minimum years since FMCSA registration. Filters out brand-new
   *  paperwork-only carriers that don't yet have revenue to buy
   *  software. Default 1. Set 0 to include new registrants. */
  establishedYearsMin?: number;
  /** Maximum years since FMCSA registration. Older carriers are more
   *  likely to have entrenched software they won't switch off. Default
   *  15 (2010+). Set very high (e.g. 100) to include all. */
  establishedYearsMax?: number;
  /** Must have filed an MCS-150 biennial update within the last N
   *  months (proves the carrier is actively operating, not a zombie
   *  DOT with a paperwork trail). Default 24. */
  mcs150SinceMonths?: number;
  /**
   * Substrings (case-insensitive) that disqualify a lead when found in
   * its legal_name or dba_name. Filters out non-target-buyer verticals
   * that hold FMCSA authority but don't buy dispatch software — towing,
   * aviation, construction, pumping, limo, repair, landscaping,
   * dumpsters. Enforced both at ingest time (fmcsaCensus.icpVerdict)
   * and via a re-run cleanup endpoint (POST /v1/crm/cleanup-nonicp)
   * that reclassifies matching leads already in the DB.
   */
  nameExcludeKeywords?: string[];
}

export interface CrmSettings {
  icp: CrmIcpFilters;
  /** Max outreach emails per day (deliverability warm-up). Default 25. */
  dailySendCap: number;
  sendWindow: {
    startHour: number;                 // default 9 (in `timezone`)
    endHour: number;                   // default 17
    timezone: string;                  // IANA, default "America/Denver"
    weekdaysOnly: boolean;             // default true
  };
  /** false = approval-batch mode (default): sends queue as
   *  pending_approval until approved in the outbox UI. */
  autoSend: boolean;
  /** Outreach identity display overrides. The FROM domain itself comes
   *  from env (OUTREACH_FROM_EMAIL) — never fleetcal.app. */
  fromName: string;
  replyTo: string;
  /** CAN-SPAM physical address footer. Sends REFUSE when empty. */
  physicalAddressFooter: string;
  /** Markdown talk track shown in the call-queue panel. */
  talkTrack: string;
  /** First-run FMCSA cursor seed: ingest starts above this DOT number.
   *  Unset = seeded to the dataset max at first sync (only genuinely
   *  new carriers from then on). */
  syncStartDotNumber?: number;
}

export const CRM_SETTINGS_DEFAULTS: CrmSettings = {
  icp: {
    powerUnitsMin: 4,
    powerUnitsMax: 10,
    states: [],
    operationClasses: ["A", "B", "C"],
    localOnly: false,
    forHireOnly: true,
    establishedYearsMin: 1,
    establishedYearsMax: 15,
    mcs150SinceMonths: 24,
    nameExcludeKeywords: [
      "TOWING", "TOW ",
      "AVIATION", "AIRPORT", "AIRLINE",
      "CONSTRUCTION",
      "PUMPING", "PUMP SERVICE",
      "LIMO", "LIMOUSINE",
      "REPAIR", "MECHANIC", "GARAGE",
      "LANDSCAPING", "LANDSCAPE", "LAWN CARE", "TREE SERVICE",
      "DUMPSTER", "WASTE MANAGEMENT", "GARBAGE", "JUNK REMOVAL", "ROLL OFF", "ROLL-OFF",
    ],
  },
  dailySendCap: 25,
  sendWindow: { startHour: 9, endHour: 17, timezone: "America/Denver", weekdaysOnly: true },
  autoSend: false,
  fromName: "FleetCal",
  replyTo: "",
  physicalAddressFooter: "",
  talkTrack: "",
};

/** Deep-merge stored (partial, never trusted) settings over defaults. */
export function resolveCrmSettings(stored: unknown): CrmSettings {
  const s = (stored ?? {}) as Partial<CrmSettings>;
  return {
    ...CRM_SETTINGS_DEFAULTS,
    ...s,
    icp: { ...CRM_SETTINGS_DEFAULTS.icp, ...(s.icp ?? {}) },
    sendWindow: { ...CRM_SETTINGS_DEFAULTS.sendWindow, ...(s.sendWindow ?? {}) },
  };
}

// ── Outreach (Phase 2) ───────────────────────────────────────────────

export const CRM_ENROLLMENT_STATUSES = [
  "active",
  "paused",
  "completed",     // ran every step
  "stopped",       // manually ended / lead replied / lead blocked
  "unsubscribed",
] as const;
export type CrmEnrollmentStatus = (typeof CRM_ENROLLMENT_STATUSES)[number];

export const CRM_EMAIL_STATUSES = [
  "pending_approval", // materialized, waiting in the outbox
  "approved",         // human-approved (or autoSend), waiting for the send window
  "sent",
  "failed",           // Resend call failed — retryable from the outbox
  "bounced",          // Resend webhook reported a bounce
  "suppressed",       // blocked at send time (unsubscribe/suppression/status)
  "cancelled",        // human-cancelled before send
] as const;
export type CrmEmailStatus = (typeof CRM_EMAIL_STATUSES)[number];

export const CRM_SUPPRESSION_REASONS = ["unsubscribe", "bounce", "complaint", "manual"] as const;
export type CrmSuppressionReason = (typeof CRM_SUPPRESSION_REASONS)[number];

export interface CrmSequence {
  id: string;
  name: string;
  isActive: boolean;
  createdBy?: string;
  steps: CrmSequenceStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CrmSequenceStep {
  id: string;
  sequenceId: string;
  stepOrder: number;        // 1-based
  /** Days after the previous step (step 1: after enrollment). */
  waitDays: number;
  /** Merge vars: {{legal_name}} {{dba_or_legal_name}} {{city}} {{state}}
   *  {{power_units}} {{unsubscribe_url}} (auto-appended if missing). */
  subjectTemplate: string;
  bodyTemplate: string;
}

export interface CrmEnrollment {
  id: string;
  leadId: string;
  sequenceId: string;
  status: CrmEnrollmentStatus;
  /** Last COMPLETED step (0 = none yet). */
  currentStep: number;
  nextSendAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrmEmail {
  id: string;
  leadId: string;
  enrollmentId?: string;
  stepId?: string;
  toEmail: string;
  subject: string;          // rendered snapshot at materialize time
  body: string;
  status: CrmEmailStatus;
  approvedBy?: string;
  approvedAt?: string;
  sentAt?: string;
  resendMessageId?: string;
  error?: string;
  createdAt: string;
  /** Joined for outbox display. */
  leadName?: string;
}

// ── API request/response shapes ──────────────────────────────────────

export interface CrmListLeadsQuery {
  status?: CrmLeadStatus;
  state?: string;
  puMin?: number;
  puMax?: number;
  hasEmail?: boolean;
  /** Filter to "local" leads per the radius-count proxy. */
  local?: boolean;
  /** 'unverified' | one of CrmEmailVerificationStatus. */
  verification?: "unverified" | CrmEmailVerificationStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface CrmListLeadsResponse {
  leads: CrmLead[];
  total: number;
}

export interface CrmLeadDetailResponse {
  lead: CrmLead;
  activities: CrmActivity[];
}

export interface CrmSyncResult {
  fetched: number;
  inserted: number;
  duplicates: number;
  disqualified: number;
  cursorDotNumber?: number;
}

export interface CrmStats {
  byStatus: Partial<Record<CrmLeadStatus, number>>;
  totalLeads: number;
  lastSyncAt?: string;
}
