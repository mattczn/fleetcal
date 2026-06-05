-- Movements: scope uniqueness to (org_id, motive_period_id).
--
-- The original UNIQUE(motive_period_id) was too narrow. Two orgs
-- sharing a Motive setup (e.g. a prod org and a demo org seeded with
-- duplicate vehicle_ids) generate identical period_ids when sync runs
-- against either. Whichever org's trigger fired first claimed the
-- movements row; every subsequent org's trigger hit the conflict and
-- ran the UPDATE branch on that *other* org's row instead of creating
-- its own. Net effect: ~90% of one org's daily movements silently
-- routed to the other org, leaving the timeline view nearly empty
-- (while the calendar view kept working because it reads the raw
-- motive_driving_periods table, not movements).
--
-- Fix: drop the column-scoped UNIQUE, add a compound (org_id,
-- motive_period_id) UNIQUE, and rewrite the mirror trigger's
-- ON CONFLICT target to match.

ALTER TABLE movements
  DROP CONSTRAINT IF EXISTS movements_motive_period_id_key;

ALTER TABLE movements
  ADD CONSTRAINT movements_org_motive_period_key
  UNIQUE (org_id, motive_period_id);

-- Re-create the mirror trigger function with the new conflict target.
-- Function body is unchanged otherwise — same field mappings, same
-- nullable-asset skip, same field set on UPDATE.

CREATE OR REPLACE FUNCTION mirror_motive_period_to_movement()
RETURNS trigger AS $$
DECLARE
  v_asset_id bigint;
BEGIN
  SELECT id INTO v_asset_id
    FROM assets
   WHERE org_id = NEW.org_id
     AND motive_vehicle_id = NEW.vehicle_id::text
   LIMIT 1;

  IF v_asset_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO movements (
    org_id, asset_id, source, motive_period_id,
    start_time, end_time, duration_min, miles,
    origin, destination,
    origin_lat, origin_lon, destination_lat, destination_lon,
    created_by, created_at
  )
  VALUES (
    NEW.org_id, v_asset_id, 'motive', NEW.id,
    NEW.start_time, NEW.end_time,
    CASE
      WHEN NEW.duration IS NOT NULL
        THEN GREATEST(0, ROUND(NEW.duration / 60.0))::int
      WHEN NEW.end_time IS NOT NULL
        THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 60.0))::int
      ELSE NULL
    END,
    NEW.miles,
    NEW.origin, NEW.destination,
    NEW.origin_lat, NEW.origin_lon, NEW.destination_lat, NEW.destination_lon,
    'motive_sync', COALESCE(NEW.start_time, now())
  )
  ON CONFLICT (org_id, motive_period_id) DO UPDATE SET
    start_time      = EXCLUDED.start_time,
    end_time        = EXCLUDED.end_time,
    duration_min    = EXCLUDED.duration_min,
    miles           = EXCLUDED.miles,
    origin          = EXCLUDED.origin,
    destination     = EXCLUDED.destination,
    origin_lat      = EXCLUDED.origin_lat,
    origin_lon      = EXCLUDED.origin_lon,
    destination_lat = EXCLUDED.destination_lat,
    destination_lon = EXCLUDED.destination_lon;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
