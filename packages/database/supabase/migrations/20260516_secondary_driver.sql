-- 20260516_secondary_driver.sql
--
-- Add an optional SECONDARY driver to driver_asset_prefs.
--
-- Why: some drivers don't have their own truck and instead share
-- another driver's asset when they work (e.g. a fill-in driver who
-- covers for the primary on their days off). We want to model this
-- so picking that driver in the load modal auto-fills the same asset
-- their primary uses.
--
-- The existing `driver_id` column stays as the PRIMARY driver. We
-- add `secondary_driver_id` as an optional second driver. The PK
-- remains (asset_id) so there's still at most one row per asset,
-- but each row can name up to two drivers.
--
-- A driver can be primary for one asset and/or secondary for another;
-- the reverse lookup in code prefers primary when a driver appears
-- in both columns of different rows.

ALTER TABLE driver_asset_prefs
  ADD COLUMN IF NOT EXISTS secondary_driver_id bigint
    REFERENCES drivers(id) ON DELETE SET NULL;
