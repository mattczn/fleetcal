-- Cache routed loaded miles per event so reports / dashboards don't have
-- to re-call Google Directions on every render. Populated by the load
-- modal when calcRoadMiles resolves; recomputed any time stops change.
--
-- Stored as numeric for sub-mile precision (fractional values are common
-- for short urban legs). Nullable — old events stay null until next edit
-- and the dashboard falls back to haversine until then.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS loaded_miles numeric;
