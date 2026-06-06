-- 20260606_trailers_vehicle_details.sql
--
-- Bring trailers up to the same level of detail as trucks: dedicated
-- columns for make + model + VIN + license plate, plus the state +
-- expiration date on the plate. Trailers have more variance than
-- trucks in registration jurisdiction (drop trailers parked across
-- state lines, IRP apportioned plates, etc.) so the state + expiry
-- columns are part of the initial set, not a follow-up.

ALTER TABLE trailers
  ADD COLUMN IF NOT EXISTS make               text,
  ADD COLUMN IF NOT EXISTS model              text,
  ADD COLUMN IF NOT EXISTS vin                text,
  ADD COLUMN IF NOT EXISTS license_plate      text,
  ADD COLUMN IF NOT EXISTS license_state      text,   -- 2-letter state code
  ADD COLUMN IF NOT EXISTS license_expiration date;

-- VIN lookup index — maintenance shops + DMV identify trailers by VIN
-- the same way they do trucks.
CREATE INDEX IF NOT EXISTS idx_trailers_vin
  ON trailers (org_id, vin)
  WHERE vin IS NOT NULL AND vin <> '';

CREATE INDEX IF NOT EXISTS idx_trailers_license_plate
  ON trailers (org_id, license_plate)
  WHERE license_plate IS NOT NULL AND license_plate <> '';

-- Expiration index — needed for "trailers with plates expiring in the
-- next 60 days" reports + notification queries. Partial so we don't
-- index every trailer (most won't have an expiration set yet).
CREATE INDEX IF NOT EXISTS idx_trailers_license_expiration
  ON trailers (org_id, license_expiration)
  WHERE license_expiration IS NOT NULL;
