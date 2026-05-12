-- ============================================================
-- Fix-up: fuel_reports.org_id should be text, not uuid.
--
-- The original 2026-05-12-fuel-reports.sql migration declared
-- `org_id uuid` by mistake. Every other table in this project uses
-- `text` because Clerk org ids look like "org_2abc..." (not a UUID),
-- and the API queries with `.eq("org_id", c.get("orgId"))`. Casting
-- the Clerk string to a uuid column blew up with `invalid input
-- syntax for type uuid` on every read.
--
-- Safe to run once whether the column is already text (no-op) or
-- still uuid (in-place conversion).
-- ============================================================

ALTER TABLE fuel_reports
  ALTER COLUMN org_id TYPE text USING org_id::text;
