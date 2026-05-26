-- 20260529_org_settings_motive_fuel.sql
--
-- Two new JSONB columns on org_settings:
--   • motive_settings — sync toggles + cadences (see MotiveSettings
--     in @fleetcal/types domain.ts). Currently 4 optional fields:
--       odometerSyncEnabled (bool),
--       odometerSyncIntervalHours (number),
--       drivingPeriodsSyncEnabled (bool),
--       drivingPeriodsSyncIntervalMinutes (number).
--   • fuel_settings — currently just buyOnBehalfNames (string[]).
--     The fuel-transactions auto-matcher uses this list to detect
--     "this receipt is from someone fueling for OTHER drivers" and
--     switches to a name-less matching strategy.
--
-- Both are nullable — absence means "use built-in defaults".
-- Validation lives in the API (PATCH /v1/org-settings).
--
-- We use IF NOT EXISTS so re-running the migration is safe.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS motive_settings jsonb;

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS fuel_settings   jsonb;
