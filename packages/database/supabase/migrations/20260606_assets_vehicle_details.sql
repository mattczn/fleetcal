-- 20260606_assets_vehicle_details.sql
--
-- Split the single free-text `truck` column into proper Make + Model
-- fields and add VIN + License Plate. The old `truck` column ("2024
-- Freightliner Cascadia") was inadequate for anything beyond display
-- — no clean way to filter, lookup by make, or feed into other
-- systems (e.g. maintenance categorization by make/model).
--
-- Migration strategy:
--   1. Add 4 new nullable columns. None of them have defaults; rows
--      created before this migration get NULL until backfill.
--   2. Best-effort backfill from existing `truck` data using a
--      heuristic that handles the common forms:
--        - "2024 Freightliner Cascadia"  → make=Freightliner, model=Cascadia
--        - "Freightliner Cascadia"        → make=Freightliner, model=Cascadia
--        - "Cascadia"                     → model=Cascadia (no make)
--      Edge cases that mis-split (e.g. "Mack Anthem MD7") are left
--      for the admin to fix in the UI — the data is preserved either
--      way.
--   3. The `truck` column stays in place for backward compatibility
--      and to give the admin a fallback reference if the heuristic
--      mis-parsed. A separate later migration will drop it once
--      Curzon's truck data is verified.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS make          text,
  ADD COLUMN IF NOT EXISTS model         text,
  ADD COLUMN IF NOT EXISTS vin           text,
  ADD COLUMN IF NOT EXISTS license_plate text;

-- Best-effort backfill. Idempotent — runs only on rows where the new
-- fields are still NULL, so re-applying the migration is a no-op.
UPDATE assets
SET
  make = CASE
    -- "YYYY Make ..." → make is the second token
    WHEN truck ~ '^[0-9]{4}\s+\S+'  THEN split_part(truck, ' ', 2)
    -- "Make Model ..." → make is the first token
    WHEN position(' ' in truck) > 0 THEN split_part(truck, ' ', 1)
    -- Single word → leave make NULL, model gets the word below
    ELSE NULL
  END,
  model = CASE
    -- "YYYY Make Model..." → strip the "YYYY Make " prefix
    WHEN truck ~ '^[0-9]{4}\s+\S+\s+' THEN regexp_replace(truck, '^[0-9]{4}\s+\S+\s+', '')
    -- "YYYY Make" only → no model token
    WHEN truck ~ '^[0-9]{4}\s+\S+$'   THEN NULL
    -- "Make Model..." → strip the "Make " prefix
    WHEN truck ~ '^\S+\s+'            THEN regexp_replace(truck, '^\S+\s+', '')
    -- Single word → that's the model
    ELSE truck
  END
WHERE truck IS NOT NULL
  AND truck <> ''
  AND make  IS NULL
  AND model IS NULL;

-- VIN is an identifier used by maintenance shops + state DMV lookups.
-- Index it so future "find truck by VIN" or "find loads where truck
-- VIN matches inspection report" queries don't seq-scan.
CREATE INDEX IF NOT EXISTS idx_assets_vin
  ON assets (org_id, vin)
  WHERE vin IS NOT NULL AND vin <> '';

-- License plate gets the same treatment — fleets get DMV / toll
-- correspondence keyed by plate, so a fast lookup pays off the moment
-- there's any reason to search by it.
CREATE INDEX IF NOT EXISTS idx_assets_license_plate
  ON assets (org_id, license_plate)
  WHERE license_plate IS NOT NULL AND license_plate <> '';
