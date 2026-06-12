-- Store Gmail's internal (legacy hex) thread id alongside the FMfcg… permalink.
--
-- The extension links on the permalink id (from the URL hash), but Gmail's
-- INBOX-LIST rows only expose the legacy hex id (data-legacy-thread-id). To
-- stamp a ✓ on linked rows in the list, we need to match by that id — so we
-- store it on the link row. Backfilled by the extension as linked emails are
-- opened (it reads the legacy id from the open conversation and upserts).

ALTER TABLE email_thread_links
  ADD COLUMN IF NOT EXISTS legacy_thread_id text;

CREATE INDEX IF NOT EXISTS idx_email_thread_links_legacy
  ON email_thread_links (org_id, gmail_account, legacy_thread_id);
