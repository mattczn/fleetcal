-- Make the asset-link trigger handle "swap" cases where the truck's
-- previous asset row already owns the mirrored movement rows.
--
-- Why this exists
-- ───────────────
-- 20260603 fixed the "asset linked AFTER periods synced" case: when
-- motive_vehicle_id gets set on an asset, the trigger backfills any
-- periods that weren't yet mirrored. But it relied on ON CONFLICT DO
-- NOTHING on movements.motive_period_id — which means if a PREVIOUS
-- asset (a retired/replaced predecessor) already had those periods
-- mirrored under its id, the new asset's link wouldn't pick them up.
--
-- Real-world example: user retires CT-2022 (asset 52, link 2184525),
-- creates a fresh CT-2022 row (asset 34, link 2184525). Movements
-- stay pinned to asset 52; the timeline page shows nothing for the
-- new asset 34. (The calendar didn't notice because it reads
-- motive_driving_periods directly, not movements.)
--
-- The fix: the asset-link trigger also UPDATEs the movements table to
-- reassign any rows for this org+vehicle to the newly-linked asset.

-- ── Step 1: replace the trigger function with one that reassigns ──

CREATE OR REPLACE FUNCTION mirror_existing_periods_on_asset_link()
RETURNS trigger AS $$
BEGIN
  -- No-op when the asset isn't (now) Motive-linked.
  IF NEW.motive_vehicle_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- On UPDATE, only act when motive_vehicle_id actually changed.
  IF TG_OP = 'UPDATE' AND OLD.motive_vehicle_id IS NOT DISTINCT FROM NEW.motive_vehicle_id THEN
    RETURN NEW;
  END IF;

  -- (a) Re-home any movements rows that already exist for this
  -- org+vehicle but are pinned to a different asset id (the
  -- predecessor / sibling case). Targets motive-sourced rows only —
  -- we never want to retarget a hand-entered manual movement.
  UPDATE movements m
  SET    asset_id = NEW.id
  FROM   motive_driving_periods mdp
  WHERE  m.motive_period_id = mdp.id
    AND  mdp.org_id            = NEW.org_id
    AND  mdp.vehicle_id::text  = NEW.motive_vehicle_id
    AND  m.source              = 'motive'
    AND  m.asset_id           <> NEW.id;

  -- (b) Backfill any periods that don't have a movements row at all
  -- (the "linked late, no row exists" case — what 20260603 handled).
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
  ON CONFLICT (motive_period_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The trigger itself stays as 20260603 created it. Re-declare for
-- safety in case 20260603 was applied differently than expected.
DROP TRIGGER IF EXISTS trg_mirror_existing_periods_on_asset_link ON assets;
CREATE TRIGGER trg_mirror_existing_periods_on_asset_link
  AFTER INSERT OR UPDATE OF motive_vehicle_id ON assets
  FOR EACH ROW
  EXECUTE FUNCTION mirror_existing_periods_on_asset_link();

-- ── Step 2: prevent two assets in the same org from linking to the
--          same Motive vehicle simultaneously. ────────────────────
--
-- This is a partial unique index — only enforced when motive_vehicle_id
-- IS NOT NULL, so retired/unlinked assets don't fight for the same
-- slot. Two different orgs can still link to the same Motive id
-- (which shouldn't happen in practice, but we keep cross-org scope
-- intentionally open in case Motive ever returns a shared vehicle).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_assets_motive_per_org
  ON assets (org_id, motive_vehicle_id)
  WHERE motive_vehicle_id IS NOT NULL;
