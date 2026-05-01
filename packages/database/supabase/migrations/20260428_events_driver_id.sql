-- Add driver_id FK to events for stable driver→event linkage.
-- driver_name is kept as a denormalized display cache; driver_id is the source of truth
-- for queries like "loads assigned to driver X" (used by the driver mobile app).

ALTER TABLE events
  ADD COLUMN driver_id bigint REFERENCES drivers(id) ON DELETE SET NULL;

-- Backfill: link existing events whose driver_name matches a driver record in the same org.
UPDATE events e
SET driver_id = d.id
FROM drivers d
WHERE e.driver_name = d.name
  AND e.org_id      = d.org_id
  AND e.driver_name IS NOT NULL
  AND e.driver_id   IS NULL;

CREATE INDEX idx_events_org_driver
  ON events (org_id, driver_id)
  WHERE driver_id IS NOT NULL;
