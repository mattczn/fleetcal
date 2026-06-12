-- 20260612_events_deferred_to_week.sql
--
-- Persists the per-event payroll defer marker. The web app already
-- has a `deferredToWeek` field on the CalendarEvent type and a
-- "Defer" button on the payroll view that sets it, but until now
-- the field never reached the database: it was missing from the
-- splitForUpdate event whitelist, the API PATCH route's update map,
-- and the events table itself. The optimistic local update made it
-- *look* deferred until the next refresh wiped it.
--
-- weekStart in the web app is the Saturday "YYYY-MM-DD" key. Stored
-- as a date column so range queries (which week is this load in?)
-- stay cheap and the value round-trips as a plain string through
-- PostgREST.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS deferred_to_week date;

-- Index so the payroll-view weekly fetch ("show me every load whose
-- pickup is in this week OR whose deferred_to_week is this week") can
-- find deferred-in loads without scanning the whole events table.
CREATE INDEX IF NOT EXISTS idx_events_deferred_to_week
  ON events (org_id, deferred_to_week)
  WHERE deferred_to_week IS NOT NULL;
