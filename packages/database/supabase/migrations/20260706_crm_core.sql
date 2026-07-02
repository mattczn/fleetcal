-- CRM core (Phase 1): internal sales tooling — FMCSA lead ingest,
-- activity timeline, sync cursor state, org-level CRM settings.
--
-- INTERNAL-ONLY feature: surfaced exclusively to orgs in the
-- CRM_INTERNAL_ORG_IDS allowlist + the `crm` module flag (default-OFF,
-- see packages/types/modules.ts DEFAULT_OFF_MODULES). Customer orgs
-- never see these tables' data, but the tables follow the standard
-- org_id multi-tenancy pattern anyway.
--
-- Lead source: FMCSA Company Census File via Socrata SODA API
-- (data.transportation.gov dataset az4n-8mr2). See
-- apps/api/src/lib/fmcsaCensus.ts. Radius fields are DRIVER COUNTS
-- (verified 2026-07-02), not booleans — "local carrier" proxy is
-- within-100 counts > 0 AND beyond-100 counts = 0.

-- ── Leads ────────────────────────────────────────────────────────────

CREATE TABLE crm_leads (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             text NOT NULL,
  -- Null for manually-added leads; unique per org when present.
  dot_number         bigint,
  source             text NOT NULL DEFAULT 'fmcsa_census'
                     CHECK (source IN ('fmcsa_census','manual')),

  legal_name         text NOT NULL,
  dba_name           text,
  email              text,
  phone              text,
  cell_phone         text,
  phy_street         text,
  phy_city           text,
  phy_state          text,
  phy_zip            text,

  power_units        int,
  total_drivers      int,
  -- MCS-150 operation class: A interstate | B intrastate hazmat | C intrastate non-hazmat
  carrier_operation  text,
  -- MCS-150 haul-radius driver counts (census: *_within/beyond_100_miles)
  interstate_within_100  int,
  interstate_beyond_100  int,
  intrastate_within_100  int,
  intrastate_beyond_100  int,
  hm_ind             boolean,
  mcs150_date        date,
  fmcsa_add_date     date,
  -- Full census row snapshot at ingest time (source-migration insurance:
  -- FMCSA moves to MOTUS in 2026; raw keeps whatever the source gave us).
  raw                jsonb,

  status             text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','enriched','queued','emailing','call_queue',
                                       'interested','demo_scheduled','won','lost',
                                       'unsubscribed','do_not_contact','disqualified')),
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  owner_user_id      text,
  -- Call-queue ordering: "call me back after" timestamp.
  next_action_at     timestamptz,
  call_attempts      int NOT NULL DEFAULT 0,
  -- Unguessable token for the public unsubscribe link (Phase 2).
  unsubscribe_token  uuid NOT NULL DEFAULT gen_random_uuid(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER crm_leads_updated_at BEFORE UPDATE ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotent ingest: one row per carrier per org. Partial so manual
-- leads (null dot_number) aren't constrained.
CREATE UNIQUE INDEX idx_crm_leads_org_dot
  ON crm_leads(org_id, dot_number) WHERE dot_number IS NOT NULL;
CREATE UNIQUE INDEX idx_crm_leads_unsub_token ON crm_leads(unsubscribe_token);
CREATE INDEX idx_crm_leads_org_status ON crm_leads(org_id, status);
CREATE INDEX idx_crm_leads_org_state  ON crm_leads(org_id, phy_state);
CREATE INDEX idx_crm_leads_org_next_action
  ON crm_leads(org_id, next_action_at) WHERE status = 'call_queue';

-- ── Activity timeline (append-only) ──────────────────────────────────

CREATE TABLE crm_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  lead_id       uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('note','status_change','email_sent','email_bounced',
                                              'email_replied','call','enrolled','unenrolled',
                                              'unsubscribed','system')),
  body          text,
  -- e.g. {"outcome":"voicemail"} for calls, {"from":"new","to":"queued"}
  -- for status changes.
  meta          jsonb,
  -- Clerk user id; null = system/cron.
  actor_user_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_crm_activities_org_lead
  ON crm_activities(org_id, lead_id, created_at DESC);

-- ── Sync cursor state ─────────────────────────────────────────────────

-- Keyset cursor per (org, source). DOT numbers are assigned
-- monotonically, so cursor = {"lastDotNumber": N} and each sync pulls
-- dot_number > N. Persisted after EVERY page so a mid-run crash
-- resumes where it left off. `source` supports the MOTUS migration.
CREATE TABLE crm_sync_state (
  org_id      text NOT NULL,
  source      text NOT NULL DEFAULT 'fmcsa_census',
  cursor      jsonb NOT NULL DEFAULT '{}',
  last_run_at timestamptz,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source)
);

CREATE TRIGGER crm_sync_state_updated_at BEFORE UPDATE ON crm_sync_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Org-level CRM settings bag ────────────────────────────────────────

-- Typed as CrmSettings in packages/types/crm.ts; resolved against code
-- defaults on read (resolveCrmSettings), never trusted raw from the DB.
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS crm_settings jsonb;
