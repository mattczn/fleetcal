-- 20260726_maintenance_report_status_unify.sql
--
-- Collapse maintenance_reports.status 'reviewed' onto 'dismissed'.
--
-- The two values were never two states — they were two apps naming the
-- same human action differently. The web's triage panel wrote
-- 'dismissed' behind a button labelled "Ignore"; the dispatch app wrote
-- 'reviewed' behind "Mark reviewed". Worse, they disagreed on what the
-- result meant: both apps counted 'reviewed' as STILL PENDING while
-- treating 'dismissed' as settled, so the same report showed up in the
-- pending badge on one surface and not the other depending on which app
-- the dispatcher happened to triage it from.
--
-- 'dismissed' wins because it's the action dispatchers actually take
-- ("ignore this, it's not worth a work order") and it already carried
-- the not-pending semantics everywhere. Every client now writes
-- 'dismissed'; the pending filter everywhere is status = 'open'.
--
-- This backfill exists so the *existing* rows stop rendering as a third
-- colour/label and stop inflating the pending count. Without it, every
-- historical 'reviewed' row would sit in the UI forever relying on the
-- app-side legacy alias.
--
-- The CHECK constraint from 2026-05-12-maintenance.sql deliberately
-- KEEPS 'reviewed' in its allow-list, and so does the API's PATCH
-- validation: dispatch builds already installed on drivers' phones can
-- still send it, and a 400 there would silently break their triage.
-- Every UI renders 'reviewed' identically to 'dismissed'. Drop the value
-- from the constraint only once those builds are confirmed retired.

UPDATE maintenance_reports
   SET status = 'dismissed'
 WHERE status = 'reviewed';
