-- ───────────────────────────────────────────────────────────────────
-- sms_consents — audit trail for SMS opt-in / opt-out events.
--
-- Every row records an affirmative consent action taken by the
-- owner of a phone number. The web form at /sms-consent inserts
-- a row here; later, STOP-keyword webhooks from Twilio will mark
-- existing rows revoked_at.
--
-- This table is the SINGLE source of truth a TCPA defense relies
-- on: it answers "did this phone number consent, when, and how".
-- Twilio's brand vetting may also ask for a sample.
--
-- Schema notes:
--   - phone is stored E.164 normalized (e.g. +15551234567) so a
--     STOP reply from Twilio (which arrives in E.164) can match
--     directly.
--   - org_id is NULLABLE because the public consent form doesn't
--     require the visitor to belong to an organization. When a
--     dispatcher captures consent inside the app, we'll set it.
--   - source is a free-form label of where the consent was
--     captured ('web_form', 'driver_app', 'dispatcher_attestation',
--     etc.). Lets us slice the table later if a specific channel
--     was misconfigured.
--   - We DO NOT enforce uniqueness on phone. A driver re-opting-in
--     after STOP creates a NEW row; the latest row's revoked_at
--     determines current status.
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE sms_consents (
  id            bigserial PRIMARY KEY,
  phone         text NOT NULL,
  consented_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  user_agent    text,
  ip_address    text,
  org_id        text,
  source        text NOT NULL DEFAULT 'web_form',
  -- Verbatim copy of the disclosure language the user agreed to.
  -- Stored so the consent record survives future edits to the
  -- consent page UI — if we ever change the consent text, old
  -- rows still show what the user actually saw.
  consent_text  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Lookup by phone for STOP-keyword handling — the most frequent
-- read pattern at SMS-send time.
CREATE INDEX sms_consents_phone_idx ON sms_consents (phone, consented_at DESC);

-- Org-scoped audit queries — "show me everyone in my org who has
-- consented" from the future settings panel.
CREATE INDEX sms_consents_org_id_idx ON sms_consents (org_id, consented_at DESC)
  WHERE org_id IS NOT NULL;
