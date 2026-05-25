-- 20260528_driver_device_permissions.sql
--
-- Track each driver's current device permission state for the two
-- iOS/Android prompts the driver app cares about:
--
--   notifications  — granted means pushes can land on this phone.
--                    A driver with denied here won't get cancel/
--                    reassign/assigned/etc. alerts even if the
--                    org rule is enabled.
--
--   location       — granted means the GPS coords get attached to
--                    inspection submits, fuel reports, and the
--                    arrived/departed timestamps on stops.
--
-- Reported by the driver app on launch and on AppState foreground
-- via POST /v1/driver/permissions. NULL means we haven't received
-- a report yet (driver on an old bundle or never opened the app
-- since this shipped).
--
-- 'undetermined' = OS dialog never shown
-- 'granted'      = user tapped Allow
-- 'denied'       = user tapped Don't Allow or revoked in Settings

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS notifications_permission text,
  ADD COLUMN IF NOT EXISTS location_permission      text,
  ADD COLUMN IF NOT EXISTS permissions_updated_at   timestamptz;

ALTER TABLE drivers
  DROP CONSTRAINT IF EXISTS drivers_notifications_permission_check;
ALTER TABLE drivers
  ADD CONSTRAINT drivers_notifications_permission_check
  CHECK (notifications_permission IS NULL OR notifications_permission IN ('granted', 'denied', 'undetermined'));

ALTER TABLE drivers
  DROP CONSTRAINT IF EXISTS drivers_location_permission_check;
ALTER TABLE drivers
  ADD CONSTRAINT drivers_location_permission_check
  CHECK (location_permission IS NULL OR location_permission IN ('granted', 'denied', 'undetermined'));

NOTIFY pgrst, 'reload schema';
