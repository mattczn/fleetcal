-- 20260524_inspection_duration_location.sql
--
-- Capture two compliance-useful signals on every inspection:
--
--   duration_seconds — how long the driver had the form open before
--     submitting. A 3-second submit on a 59-item list is a tell that
--     the driver rubber-stamped pass on everything; dispatch can sort
--     by duration to spot it.
--
--   location_lat / location_lon — GPS at submit time. Two purposes:
--     (a) confirms the driver was actually with the truck and not
--         filing from their couch, (b) gives DOT auditors a paper trail
--         if a roadside inspector ever asks "where was this performed?"
--
-- Both nullable — old rows pre-migration won't have them, and a driver
-- with location permission denied can still file (we just won't have
-- coords). The form gates submit on neither.

ALTER TABLE inspection_reports
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS location_lat     double precision,
  ADD COLUMN IF NOT EXISTS location_lon     double precision;

-- Tell PostgREST about the new columns immediately so the driver-app
-- POST doesn't hit "could not find column in schema cache".
NOTIFY pgrst, 'reload schema';
