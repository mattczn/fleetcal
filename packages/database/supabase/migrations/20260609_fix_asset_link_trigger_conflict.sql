-- Fix mirror_existing_periods_on_asset_link() to use the compound
-- (org_id, motive_period_id) UNIQUE that 20260605 introduced.
--
-- 20260605 dropped the column-scoped UNIQUE(motive_period_id) on
-- movements and replaced it with UNIQUE(org_id, motive_period_id).
-- That migration updated the mirror_motive_period_to_movement trigger
-- (the one on motive_driving_periods INSERT/UPDATE), but missed the
-- SIBLING trigger mirror_existing_periods_on_asset_link (the one on
-- assets UPDATE OF motive_vehicle_id). The asset-link trigger still
-- had `ON CONFLICT (motive_period_id) DO NOTHING`, which Postgres
-- rejects with 42P10 "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification" the moment the constraint
-- was renamed.
--
-- Symptom: every PATCH /v1/assets/:id that included motive_vehicle_id
-- bounced with a 500 from the DB. The web store optimistically
-- updated local state and only console.error'd the failure, so the
-- UI showed the new value until refresh, at which point the API
-- served the old value back. Curzon hit this trying to set
-- motive_vehicle_id = 2161561 on truck P-296084.
--
-- Function body is otherwise identical to the 20260604 version —
-- only the ON CONFLICT target changes.

CREATE OR REPLACE FUNCTION mirror_existing_periods_on_asset_link()
RETURNS trigger AS $$
BEGIN
  IF NEW.motive_vehicle_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.motive_vehicle_id IS NOT DISTINCT FROM NEW.motive_vehicle_id THEN
    RETURN NEW;
  END IF;

  -- (a) Re-home motive-sourced movements that already exist for this
  -- org+vehicle but are pinned to a different asset id (the
  -- predecessor / sibling case).
  UPDATE movements m
  SET    asset_id = NEW.id
  FROM   motive_driving_periods mdp
  WHERE  m.motive_period_id = mdp.id
    AND  mdp.org_id            = NEW.org_id
    AND  mdp.vehicle_id::text  = NEW.motive_vehicle_id
    AND  m.source              = 'motive'
    AND  m.asset_id           <> NEW.id;

  -- (b) Backfill periods that don't have a movements row at all.
  INSERT INTO movements (
    id,
    org_id,
    asset_id,
    source,
    motive_period_id,
    start_time,
    end_time,
    duration_min,
    miles,
    origin,
    destination,
    origin_lat,
    origin_lon,
    destination_lat,
    destination_lon,
    created_by,
    created_at
  )
  SELECT
    gen_random_uuid(),
    mdp.org_id,
    NEW.id,
    'motive',
    mdp.id,
    mdp.start_time,
    mdp.end_time,
    CASE
      WHEN mdp.duration IS NOT NULL
        THEN GREATEST(0, ROUND(mdp.duration / 60.0))::int
      WHEN mdp.end_time IS NOT NULL
        THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (mdp.end_time - mdp.start_time)) / 60.0))::int
      ELSE NULL
    END,
    mdp.miles,
    mdp.origin,
    mdp.destination,
    mdp.origin_lat,
    mdp.origin_lon,
    mdp.destination_lat,
    mdp.destination_lon,
    'motive_link_catchup',
    COALESCE(mdp.start_time, now())
  FROM motive_driving_periods mdp
  WHERE mdp.org_id           = NEW.org_id
    AND mdp.vehicle_id::text = NEW.motive_vehicle_id
  ON CONFLICT (org_id, motive_period_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
