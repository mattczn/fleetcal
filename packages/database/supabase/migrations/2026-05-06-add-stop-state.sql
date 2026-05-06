-- Add a `state` column to the stops table so reverse-geocoding from
-- Google can stash the administrative_area_level_1 (e.g. "UT", "CA")
-- alongside the city. Existing rows are left null and get filled in
-- by /v1/admin/backfill-stop-geocode.
--
-- Run on Supabase via SQL Editor → New query → Paste → Run.
ALTER TABLE stops
  ADD COLUMN IF NOT EXISTS state text;
