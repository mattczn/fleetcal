-- Open tracking for outreach emails.
--
-- Resend's account-level open tracking (per-domain toggle in the
-- Resend Dashboard) auto-injects a 1x1 tracking pixel into every HTML
-- email we send from the fleetcalendar.app domain. When a recipient's
-- mail client renders the message, the pixel loads and Resend fires
-- an `email.opened` webhook to /v1/crm-public/resend-webhook.
--
-- We store the count of opens plus first + last timestamps. Apple's
-- Mail Privacy Protection pre-loads pixels silently on device open,
-- so the counts will over-report ~30-40% — treat opens as
-- directional, not exact. Reply is the ground-truth engagement
-- signal; opens supplement it.
--
-- Also handling `email.clicked` for Resend's click tracking (rewrites
-- URLs to go through their tracker when the domain has click
-- tracking enabled — currently OFF by default).

ALTER TABLE crm_emails
  ADD COLUMN IF NOT EXISTS open_count       int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_opened_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_opened_at   timestamptz,
  ADD COLUMN IF NOT EXISTS click_count      int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_clicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_clicked_at  timestamptz;

-- Fast filter on the outbox Sent tab: "which sends have been opened?"
CREATE INDEX IF NOT EXISTS idx_crm_emails_org_opened
  ON crm_emails(org_id, last_opened_at DESC)
  WHERE last_opened_at IS NOT NULL;
