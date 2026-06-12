-- Email thread ↔ load links (Gmail reconciliation extension).
--
-- Ties a Gmail conversation to a FleetCal load so the extension can show
-- "already in FleetCal / on the calendar" instantly on any future view of
-- that thread, and so replies/forwards in the same thread resolve without
-- re-extracting reference numbers.
--
-- IMPORTANT: Gmail thread ids are per-MAILBOX, not global — the same
-- conversation has a different thread id in each user's account. So the
-- link must be keyed on (gmail_account, thread_id), not thread_id alone.
-- The same load can therefore be linked from several people's mailboxes
-- (one row each, same load_id).

CREATE TABLE IF NOT EXISTS email_thread_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  gmail_account text NOT NULL,                       -- the mailbox the thread_id belongs to (email address)
  thread_id     text NOT NULL,                       -- Gmail thread id, unique only WITHIN gmail_account
  load_id       uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  linked_by     text,                                -- who created the link (gmail account / dispatcher name)
  source        text,                                -- 'auto' (ref match) | 'manual' | 'create' | …
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- A thread can carry MORE THAN ONE load — e.g. a broker sends five weekday
  -- rate cons (five distinct loads) on one email chain. So the link is per
  -- (mailbox, thread, LOAD) and a thread fans out to many rows. Re-linking
  -- the same (thread, load) upserts its row.
  UNIQUE (org_id, gmail_account, thread_id, load_id)
);

CREATE INDEX IF NOT EXISTS idx_email_thread_links_lookup
  ON email_thread_links (org_id, gmail_account, thread_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_links_load
  ON email_thread_links (org_id, load_id);

-- Locked down to the service-role API (matches the RLS posture of the rest
-- of the schema — the bot endpoints use the service-role key, which bypasses
-- RLS; anon/authenticated get nothing).
ALTER TABLE email_thread_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_thread_links FROM anon, authenticated;
