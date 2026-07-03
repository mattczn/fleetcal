-- CRM email verification (Phase 2.5).
--
-- Verify carrier email addresses BEFORE cold-mailing them so bad
-- addresses go straight to the call queue instead of tanking the fresh
-- outreach domain's reputation. FMCSA census emails are frequently
-- years stale (small carriers rotate through Gmail addresses, DBAs,
-- etc.) — a single 5%+ bounce batch on a new domain triggers Google
-- Postmaster spam classification for weeks.
--
-- Columns hang off crm_leads directly (rather than a separate table)
-- because the verification maps 1:1 to a lead's current email — if a
-- user later edits the email, the lead is re-flagged unverified via a
-- PATCH handler and needs re-verification.

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS email_verification_status   text,   -- null = unverified; 'valid' | 'invalid' | 'catchall' | 'disposable' | 'unknown'
  ADD COLUMN IF NOT EXISTS email_verified_at           timestamptz,
  ADD COLUMN IF NOT EXISTS email_verification_provider text,
  ADD COLUMN IF NOT EXISTS email_verification_raw      jsonb;

-- Fast path for the batch verifier ("give me the next N unverified
-- leads with emails in this org").
CREATE INDEX IF NOT EXISTS idx_crm_leads_unverified
  ON crm_leads(org_id, created_at DESC)
  WHERE email IS NOT NULL AND email_verification_status IS NULL;

-- Fast filter on the leads UI ("show me only verified-valid leads").
CREATE INDEX IF NOT EXISTS idx_crm_leads_org_verification
  ON crm_leads(org_id, email_verification_status);
