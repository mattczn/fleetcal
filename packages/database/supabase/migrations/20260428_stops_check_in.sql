-- Driver-side stop check-in: records arrival timestamp + GPS coords for each stop.
-- Powers proof of arrival, detention claim evidence, and per-stop progress in dispatch.
-- Departure tracking will be added in a follow-up migration.

ALTER TABLE stops
  ADD COLUMN arrived_at  timestamptz,
  ADD COLUMN arrived_lat numeric,
  ADD COLUMN arrived_lng numeric;

-- Drivers update their own stop check-ins from the mobile app
GRANT UPDATE ON stops TO authenticated;
