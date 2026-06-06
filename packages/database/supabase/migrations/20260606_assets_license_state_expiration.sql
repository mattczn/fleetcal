-- 20260606_assets_license_state_expiration.sql
--
-- Mirror the license_state + license_expiration columns just added
-- to trailers. The previous assets vehicle-details migration covered
-- make/model/vin/license_plate but stopped short of state + expiry —
-- trucks need the same paperwork-tracking columns trailers do
-- (IRP-apportioned plates, state-specific renewal dates).

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS license_state      text,   -- 2-letter state code
  ADD COLUMN IF NOT EXISTS license_expiration date;

CREATE INDEX IF NOT EXISTS idx_assets_license_expiration
  ON assets (org_id, license_expiration)
  WHERE license_expiration IS NOT NULL;
