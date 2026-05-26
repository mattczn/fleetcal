-- 20260529_odometer_readings_source_agnostic.sql
--
-- Extends `motive_odometer_readings` so it can hold readings from
-- non-Motive sources (historical imports from another fleet system,
-- manual gauge readings, OBD-II hardware, etc.). The table name
-- stays for backward compat — it's now source-agnostic despite the
-- name. Future migration can rename if anyone cares.
--
-- Two changes:
--   1. vehicle_id (Motive's bigint id) becomes nullable. Imported
--      readings rarely have one — they came from a system that
--      didn't talk to Motive.
--   2. New `asset_id` column (bigint, FK to assets.id). Set on
--      imported readings + (eventually) on Motive readings too once
--      we have the vehicle_id→asset_id lookup done at write time.
--      Index on it so the asset profile's odometer chart can hit a
--      single column instead of going through motive_vehicle_id.
--   3. New `source` column ('motive' | 'import' | 'manual') so we
--      can tell where each reading came from. Useful when chart
--      tooltips need to say "from Motive" vs "from historical import".
--
-- No data loss — existing rows keep their vehicle_id, asset_id stays
-- NULL until backfilled, source defaults to 'motive'.

ALTER TABLE motive_odometer_readings
  ALTER COLUMN vehicle_id DROP NOT NULL;

ALTER TABLE motive_odometer_readings
  ADD COLUMN IF NOT EXISTS asset_id bigint REFERENCES assets(id) ON DELETE SET NULL;

ALTER TABLE motive_odometer_readings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'motive'
    CHECK (source IN ('motive', 'import', 'manual'));

-- Per-asset queries (asset profile odometer chart, import idempotency).
CREATE INDEX IF NOT EXISTS idx_motive_odometer_readings_asset_captured
  ON motive_odometer_readings (asset_id, captured_at DESC)
  WHERE asset_id IS NOT NULL;

-- Per-org filter (no change but recreated for clarity since we're
-- here). Keeps the existing one — this is just an explainer comment.

-- At least one of vehicle_id / asset_id must be set so a reading is
-- always attributable. (Both can be set when the writer knows the
-- pairing; either alone is fine.)
ALTER TABLE motive_odometer_readings
  ADD CONSTRAINT motive_odometer_readings_has_target
    CHECK (vehicle_id IS NOT NULL OR asset_id IS NOT NULL);
