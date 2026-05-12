-- ============================================================
-- loads.follow_ups
--
-- Threaded follow-up history per load. Captures who chased what
-- and when (broker AP, driver, etc.), with optional resolution
-- actions baked in to each entry — flipping an accessorial's
-- status, clearing a manual flag, etc.
--
-- Stored as JSONB because the shape evolves with the closeout
-- workflow (new categories, new resolution types) and we don't
-- need to query individual entries from SQL — the closeout UI
-- reads the whole array, displays a timeline, and writes the
-- merged result back.
--
-- Combined with the existing loads.flagged_reason + accessorials
-- jsonb, this is the audit trail for Flagged-bucket work in
-- /closeout.
-- ============================================================

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS follow_ups jsonb NOT NULL DEFAULT '[]'::jsonb;
