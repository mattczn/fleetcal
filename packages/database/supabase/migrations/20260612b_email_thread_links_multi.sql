-- Allow a Gmail thread to link to MANY loads (multi-rate-con chains).
--
-- The original 20260612_email_thread_links.sql keyed the unique constraint on
-- (org_id, gmail_account, thread_id) — one load per thread. Brokers like ITS
-- send several weekday rate cons (distinct loads) on a single chain, so the
-- key must include load_id. This migration is idempotent and safe to run on a
-- DB that already applied the original (it swaps the constraint) or hasn't
-- (it no-ops if the table doesn't exist yet — apply the original first).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'email_thread_links') THEN

    -- Drop the old single-load unique constraint if it's still there. The
    -- name is Postgres's auto-generated default for that UNIQUE(...).
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'email_thread_links_org_id_gmail_account_thread_id_key') THEN
      ALTER TABLE email_thread_links
        DROP CONSTRAINT email_thread_links_org_id_gmail_account_thread_id_key;
    END IF;

    -- Add the multi-load unique constraint unless one on those columns
    -- already exists (this name, or the default name a fresh apply of the
    -- updated original migration would create).
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname IN (
                     'email_thread_links_thread_load_key',
                     'email_thread_links_org_id_gmail_account_thread_id_load_id_key')) THEN
      ALTER TABLE email_thread_links
        ADD CONSTRAINT email_thread_links_thread_load_key
        UNIQUE (org_id, gmail_account, thread_id, load_id);
    END IF;

  END IF;
END $$;
