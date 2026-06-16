-- 20260616_asset_activity_periods.sql
--
-- Multiple activity periods per asset.
--
-- Background: assets had a single `active_from` / `active_to` window,
-- which couldn't represent real-life fleet patterns like "out for
-- engine rebuild March–April, back May–August, retired September."
-- People worked around this by creating duplicate asset rows when a
-- truck came back online, which split history across two `asset_id`s
-- and broke reporting + ELD linkage.
--
-- Model: `asset_activity_periods` is the new source of truth. Each
-- row is a half-open date range [start_date, end_date]; `end_date`
-- NULL means the period is currently open. Multiple periods per
-- asset are allowed, but no two may overlap.
--
-- Backwards compat: existing code reads `assets.active_from` and
-- `assets.active_to` everywhere. Rather than touch every read site at
-- once, we keep those columns and a trigger maintains them as a
-- denormalized view of the periods:
--   active_from = MIN(period.start_date)
--   active_to   = NULL if any open period exists; else MAX(end_date)
-- So "is this asset active right now" stays correct via the old
-- predicate `active_to IS NULL`, and the existing unique-name index
-- (`assets_unique_active_name_per_org`) continues to function. Read
-- sites get migrated to query periods directly over time.
--
-- Backfill: for each existing asset, insert one row reflecting its
-- current (active_from, active_to). Idempotent via NOT EXISTS guard.

-- Required for the no-overlap exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS asset_activity_periods (
  id              BIGSERIAL PRIMARY KEY,
  asset_id        BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  org_id          TEXT   NOT NULL,
  start_date      DATE   NOT NULL,
  end_date        DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_name TEXT,
  CONSTRAINT aap_end_after_start
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_aap_asset      ON asset_activity_periods (asset_id);
CREATE INDEX IF NOT EXISTS idx_aap_org        ON asset_activity_periods (org_id);
CREATE INDEX IF NOT EXISTS idx_aap_open       ON asset_activity_periods (asset_id) WHERE end_date IS NULL;

-- No two periods for the same asset may overlap. daterange uses
-- inclusive start, exclusive end ('[)'); COALESCE(end_date, 'infinity')
-- treats an open period as extending to infinity for the overlap check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aap_no_overlap'
  ) THEN
    ALTER TABLE asset_activity_periods
      ADD CONSTRAINT aap_no_overlap
      EXCLUDE USING GIST (
        asset_id WITH =,
        daterange(start_date, COALESCE(end_date, 'infinity'::date), '[)') WITH &&
      );
  END IF;
END $$;

-- ── Backfill: one period per existing asset ────────────────────────────
INSERT INTO asset_activity_periods (asset_id, org_id, start_date, end_date)
SELECT a.id, a.org_id,
       COALESCE(a.active_from, CURRENT_DATE),
       a.active_to
  FROM assets a
 WHERE NOT EXISTS (
   SELECT 1 FROM asset_activity_periods p WHERE p.asset_id = a.id
 );

-- ── Sync trigger ───────────────────────────────────────────────────────
-- After any period change, recompute the asset's legacy active_from /
-- active_to so existing reads stay correct. We use a single aggregate
-- query rather than 2-3 subqueries for speed on tables with many
-- periods per asset.
CREATE OR REPLACE FUNCTION sync_asset_activity_legacy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  aid        BIGINT;
  v_min_start DATE;
  v_has_open  BOOLEAN;
  v_max_end   DATE;
BEGIN
  aid := COALESCE(NEW.asset_id, OLD.asset_id);

  SELECT MIN(start_date),
         BOOL_OR(end_date IS NULL),
         MAX(end_date)
    INTO v_min_start, v_has_open, v_max_end
    FROM asset_activity_periods
   WHERE asset_id = aid;

  UPDATE assets
     SET active_from = v_min_start,
         active_to   = CASE WHEN v_has_open THEN NULL ELSE v_max_end END
   WHERE id = aid;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_aap_sync ON asset_activity_periods;
CREATE TRIGGER trg_aap_sync
AFTER INSERT OR UPDATE OR DELETE ON asset_activity_periods
FOR EACH ROW EXECUTE FUNCTION sync_asset_activity_legacy();
