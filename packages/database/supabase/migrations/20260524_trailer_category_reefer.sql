-- 20260524_trailer_category_reefer.sql
--
-- Add 'Reefer' to the trailers.category CHECK constraint.
--
-- The trailers table was created before this migrations folder
-- existed, so its CHECK constraint on category lives only in the
-- live database. When 'Reefer' was added to packages/types/enums.ts,
-- the UI started offering it as an option but every save with
-- category='Reefer' was rejected at the DB layer with
-- check_violation. This migration recreates the constraint to
-- include Reefer.
--
-- Idempotent: drops any existing variant of the constraint name
-- before creating the new one. Existing rows are unaffected because
-- every prior allowed value is still in the new list.
--
-- The constraint name may not match in older databases (Postgres
-- autogenerates one when none was explicitly set). If the DROPs below
-- don't catch yours, run:
--   SELECT conname, pg_get_constraintdef(c.oid)
--   FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
--   WHERE t.relname = 'trailers' AND c.contype = 'c';
-- and add the actual name to the DROP list.

ALTER TABLE trailers DROP CONSTRAINT IF EXISTS trailers_category_check;
ALTER TABLE trailers DROP CONSTRAINT IF EXISTS trailers_category_chk;

ALTER TABLE trailers ADD CONSTRAINT trailers_category_check
  CHECK (category IN ('Swing', 'Roll Up', 'Reefer', 'Flat Bed', 'Other'));
