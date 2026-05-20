-- 20260520_enable_realtime_load_documents.sql
--
-- Add `load_documents` to the supabase_realtime publication so INSERT/
-- UPDATE/DELETE broadcasts fire on the realtime channel. Without this,
-- the web app's RealtimeSync listener for the `load_documents` channel
-- never receives any events — the POD icon + invoice doc indicator
-- don't appear on the calendar card until the page refreshes.
--
-- Background: Supabase Realtime is opt-in per table; tables aren't
-- broadcast unless they're added to the `supabase_realtime` publication.
-- `events`, `stops`, and `loads` were added manually via the Supabase
-- Studio dashboard early in the project but `load_documents` was
-- introduced later and missed that step.
--
-- The DO block makes this idempotent — re-running won't error if the
-- table is already in the publication (Supabase Studio dashboard adds
-- count, or a previous run of this migration).
--
-- REPLICA IDENTITY FULL means UPDATE/DELETE broadcasts include the
-- full OLD row (not just the primary key). Required so the web
-- subscription can filter by `org_id` even on deletes — otherwise the
-- filter never matches and document deletions wouldn't update the UI
-- in real time either.

ALTER TABLE load_documents REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'load_documents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE load_documents;
  END IF;
END $$;
