-- 20260606_drivers_exclude_from_reports.sql
--
-- Owner-operator support. The fleet may dispatch loads for a driver
-- whose revenue should NOT roll up into the carrier's own KPIs (their
-- own truck, own authority, own settlement) — most commonly an
-- owner-operator the dispatcher manages but doesn't own.
--
-- A flag on the driver row is the cleanest model for this:
--   • Loads still exist normally in the calendar / accounting /
--     closeout — they need to be dispatched, billed, and paperwork'd
--     just like any other.
--   • Aggregate reports (dashboard Total Revenue, Fleet Performance
--     leaderboards, payroll) skip events whose driver_id points at
--     an excluded driver.
--   • Filter applies at the event level — if an excluded driver
--     happens to cover a load on a company truck (rare but possible),
--     it still gets excluded; if a company driver covers a load on
--     the owner-op's truck (also rare), it stays counted.
--
-- Default false so the column is backwards-compatible — existing
-- drivers continue to count until explicitly flagged.

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS exclude_from_reports boolean NOT NULL DEFAULT false;

-- Partial index — most fleets have 0 excluded drivers, so a regular
-- index would be mostly empty pages. Partial keeps it tight.
CREATE INDEX IF NOT EXISTS idx_drivers_excluded
  ON drivers (org_id)
  WHERE exclude_from_reports = true;
