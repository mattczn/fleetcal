-- 20260521_motive_odometer_readings.sql
--
-- Daily odometer snapshots for each Motive-linked vehicle. One row per
-- vehicle per snapshot — captured by a 6 AM org-tz cron that hits
-- /v1/vehicle_locations and reads current_location.odometer.
--
-- Used to power the asset profile's "Odometer history" line chart and
-- to back any future analytics (utilization, maintenance interval
-- prediction, etc).

CREATE TABLE IF NOT EXISTS motive_odometer_readings (
  id                 bigserial    PRIMARY KEY,
  org_id             text         NOT NULL,
  vehicle_id         bigint       NOT NULL,        -- Motive vehicle.id
  vehicle_number     text,                          -- vehicle.number for label fallback
  odometer_miles     double precision,              -- current_location.odometer
  true_odometer_miles double precision,             -- current_location.true_odometer (gateway-corrected)
  located_at         timestamptz,                   -- when Motive thinks the reading was taken
  captured_at        timestamptz  NOT NULL DEFAULT now()  -- when we recorded the snapshot
);

-- Primary query path: "give me all readings for this vehicle, newest first."
CREATE INDEX IF NOT EXISTS idx_motive_odometer_readings_vehicle_captured
  ON motive_odometer_readings (vehicle_id, captured_at DESC);

-- Per-org filter for multi-tenant queries.
CREATE INDEX IF NOT EXISTS idx_motive_odometer_readings_org_captured
  ON motive_odometer_readings (org_id, captured_at DESC);

-- Note: the idempotency probe (gte/lt on a UTC-day range, scoped to
-- vehicle_id) is already covered by the (vehicle_id, captured_at)
-- index above. An earlier draft of this migration added a
-- (vehicle_id, captured_at::date) expression index, but timestamptz →
-- date isn't IMMUTABLE in Postgres (depends on session tz), so it
-- can't live in an index expression. The range-scan index serves the
-- same purpose without the immutability gotcha.
