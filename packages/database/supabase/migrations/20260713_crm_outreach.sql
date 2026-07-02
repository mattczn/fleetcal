-- CRM outreach (Phase 2): email sequences, enrollments, send log /
-- approval queue, suppression list. See 20260706_crm_core.sql for the
-- Phase-1 tables and the internal-only gating notes.
--
-- Key invariants enforced here:
--   * one ACTIVE enrollment per lead (partial unique)
--   * one email per (enrollment, step) — the per-step dedupe that makes
--     the materialize pass idempotent (partial unique, cancelled rows
--     excluded so a cancelled step can be re-materialized)
--   * suppression is EMAIL-keyed (unique on lower(email) per org) so a
--     suppressed address stays dead even if the lead is re-ingested

CREATE TABLE crm_sequences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER crm_sequences_updated_at BEFORE UPDATE ON crm_sequences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_crm_sequences_org ON crm_sequences(org_id);

CREATE TABLE crm_sequence_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           text NOT NULL,
  sequence_id      uuid NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
  step_order       int  NOT NULL,
  -- Days after the previous step (step 1: after enrollment).
  wait_days        int  NOT NULL DEFAULT 0,
  subject_template text NOT NULL,
  body_template    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);
CREATE TRIGGER crm_sequence_steps_updated_at BEFORE UPDATE ON crm_sequence_steps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_crm_sequence_steps_org_seq ON crm_sequence_steps(org_id, sequence_id);

CREATE TABLE crm_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,
  lead_id      uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  sequence_id  uuid NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','paused','completed','stopped','unsubscribed')),
  -- Last COMPLETED step (0 = none). Advanced at materialize time so the
  -- queue doesn't re-materialize while a batch awaits approval.
  current_step int  NOT NULL DEFAULT 0,
  next_send_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER crm_enrollments_updated_at BEFORE UPDATE ON crm_enrollments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX idx_crm_enrollments_one_active
  ON crm_enrollments(org_id, lead_id) WHERE status = 'active';
CREATE INDEX idx_crm_enrollments_due
  ON crm_enrollments(org_id, next_send_at) WHERE status = 'active';

-- Send log + approval queue. One row per (enrollment, step).
CREATE TABLE crm_emails (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            text NOT NULL,
  lead_id           uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  enrollment_id     uuid REFERENCES crm_enrollments(id) ON DELETE SET NULL,
  step_id           uuid REFERENCES crm_sequence_steps(id) ON DELETE SET NULL,
  to_email          text NOT NULL,
  -- Rendered snapshots at materialize time: what the outbox shows is
  -- exactly what sends, even if the template changes afterward.
  subject           text NOT NULL,
  body              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending_approval'
                    CHECK (status IN ('pending_approval','approved','sent','failed',
                                      'bounced','suppressed','cancelled')),
  approved_by       text,
  approved_at       timestamptz,
  sent_at           timestamptz,
  resend_message_id text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER crm_emails_updated_at BEFORE UPDATE ON crm_emails
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX idx_crm_emails_step_dedupe
  ON crm_emails(enrollment_id, step_id)
  WHERE enrollment_id IS NOT NULL AND step_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX idx_crm_emails_org_status ON crm_emails(org_id, status);
CREATE INDEX idx_crm_emails_org_sent   ON crm_emails(org_id, sent_at DESC) WHERE status = 'sent';
CREATE INDEX idx_crm_emails_resend_id  ON crm_emails(resend_message_id) WHERE resend_message_id IS NOT NULL;

-- Suppression list — checked at SEND time, inside the send loop.
CREATE TABLE crm_suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text NOT NULL,
  -- Stored lowercased by app code; the unique index enforces it too.
  email      text NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('unsubscribe','bounce','complaint','manual')),
  lead_id    uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_crm_suppressions_org_email ON crm_suppressions(org_id, lower(email));
