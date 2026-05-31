-- Re-mirror any motive_driving_period whose asset is now Motive-linked
-- but wasn't at original sync time, AND install a self-healing trigger
-- on assets so this never happens again.
--
-- Why this exists
-- ───────────────
-- 20260602's mirror trigger fires on motive_driving_periods INSERT/UPDATE
-- and looks up assets.motive_vehicle_id at that moment. If the asset
-- isn't linked yet (dispatcher links it later), the trigger silently
-- skips — and the Motive sync doesn't re-touch closed periods, so the
-- mirror never catches up. The /timeline page reads from movements and
-- shows zero movements for any truck that was linked AFTER its first
-- sync. (The calendar's movements view doesn't hit this because it
-- reads motive_driving_periods directly.)

-- ── Step 1: catch-up backfill for currently-linked assets ─────────
-- Same SELECT as 20260602's backfill block. Idempotent.

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
  a.id                            AS asset_id,
  'motive',
  mdp.id                          AS motive_period_id,
  mdp.start_time,
  mdp.end_time,
  CASE
    WHEN mdp.duration IS NOT NULL
      THEN GREATEST(0, ROUND(mdp.duration / 60.0))::int
    WHEN mdp.end_time IS NOT NULL
      THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (mdp.end_time - mdp.start_time)) / 60.0))::int
    ELSE NULL
  END                             AS duration_min,
  mdp.miles,
  mdp.origin,
  mdp.destination,
  mdp.origin_lat,
  mdp.origin_lon,
  mdp.destination_lat,
  mdp.destination_lon,
  'motive_link_catchup',
  COALESCE(mdp.start_time, now()) AS created_at
FROM motive_driving_periods mdp
JOIN assets a
  ON a.org_id = mdp.org_id
 AND a.motive_vehicle_id = mdp.vehicle_id::text
ON CONFLICT (motive_period_id) DO NOTHING;

-- ── Step 2: trigger on assets — retro-mirror on link set/change ──
--
-- When motive_vehicle_id is set on an asset (or changed to a new
-- value), grab every motive_driving_period for that vehicle and
-- mirror it into movements. ON CONFLICT DO NOTHING makes this safe
-- to run alongside the period-side trigger.

CREATE OR REPLACE FUNCTION mirror_existing_periods_on_asset_link()
RETURNS trigger AS $$
BEGIN
  -- No-op if the asset isn't (now) Motive-linked.
  IF NEW.motive_vehicle_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- On UPDATE, only act if motive_vehicle_id actually changed.
  IF TG_OP = 'UPDATE' AND OLD.motive_vehicle_id IS NOT DISTINCT FROM NEW.motive_vehicle_id THEN
    RETURN NEW;
  END IF;

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
  WHERE mdp.org_id = NEW.org_id
    AND mdp.vehicle_id::text = NEW.motive_vehicle_id
  ON CONFLICT (motive_period_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mirror_existing_periods_on_asset_link ON assets;
CREATE TRIGGER trg_mirror_existing_periods_on_asset_link
  AFTER INSERT OR UPDATE OF motive_vehicle_id ON assets
  FOR EACH ROW
  EXECUTE FUNCTION mirror_existing_periods_on_asset_link();
