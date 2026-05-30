-- 20260602_movements_and_movement_links.sql
--
-- The asset-timeline foundation.
--
-- Two new tables that turn the truck's activity log into a queryable
-- graph of facts:
--
--   1. `movements`        — unified, source-agnostic record of every
--                            time a truck moved or sat. Replaces direct
--                            reads of motive_driving_periods for any
--                            new code; lets us add manual + AI-derived
--                            rows on the same footing as Motive ELD
--                            data.
--   2. `movement_links`   — append-only fact table that asserts how a
--                            movement relates to a load event (which
--                            load it's loaded for, which two loads it
--                            transitions between, etc.). Re-running AI
--                            inserts new facts; manual edits supersede
--                            AI ones; old facts are never deleted so
--                            time-travel queries and audit work.
--
-- This is PR 1 of the asset-timeline build. PR 2 lands the timeline
-- page that consumes these tables; PR 3 adds the AI auto-link
-- endpoint.
--
-- Why a NEW movements table instead of evolving motive_driving_periods:
--   • motive_driving_periods.id is Motive's id (bigint, externally
--     defined). Manual movements don't have one; AI-derived ones
--     don't either. Using a UUID PK here gives every source a
--     stable, owned id.
--   • Renaming the existing table would force a 3-app readwrite
--     cutover. Instead, the Motive sync writes to both (motive_*
--     stays as the raw Motive archive, movements becomes the
--     canonical reader surface). Eventually the legacy reads migrate
--     over and motive_driving_periods becomes pure archive.
--
-- Backfill at the bottom: every existing motive_driving_periods row
-- becomes a corresponding movements row with source='motive' so the
-- new asset-timeline code sees historical data immediately.

-- ── movements ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS movements (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL,
  asset_id           bigint      NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- Driver attribution where known. Always nullable — Motive doesn't
  -- always identify the driver (unidentified-driver periods exist), and
  -- manual rows may pre-date driver assignment.
  driver_id          bigint      REFERENCES drivers(id) ON DELETE SET NULL,

  -- Where this row came from. Drives editability rules: motive rows are
  -- read-only history; manual / derived rows can be edited or deleted.
  source             text        NOT NULL CHECK (source IN ('motive','manual','derived')),
  -- Set when source='motive'. Lets us round-trip back to the raw Motive
  -- row for debugging + ensures the Motive sync can dedupe on re-ingest
  -- (UNIQUE constraint).
  motive_period_id   bigint      UNIQUE REFERENCES motive_driving_periods(id) ON DELETE CASCADE,

  start_time         timestamptz NOT NULL,
  end_time           timestamptz,
  -- duration_min = (end_time - start_time) when both set, but stored
  -- explicitly so manual rows can declare a duration without nailing
  -- an end_time, and so we don't recompute on every read.
  duration_min       integer,

  miles              numeric,

  origin             text,
  destination        text,
  origin_lat         numeric,
  origin_lon         numeric,
  destination_lat    numeric,
  destination_lon    numeric,

  -- Free-form context from whoever created the row (dispatcher note,
  -- "estimated from prior load delivery", etc.). Distinct from
  -- movement_links.reasoning, which is per-link justification.
  notes              text,

  -- Audit trail. created_by is 'motive_sync' / 'ai_v1' / clerk user id
  -- depending on origin. updated_at fires on edits; manual rows can
  -- be edited but motive rows are write-once.
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Soft delete for manual rows (lets the dispatcher recover a row
  -- they accidentally removed and keeps the audit trail intact).
  -- Motive rows never get soft-deleted via the API — they're history.
  deleted_at         timestamptz
);

-- Calendar timeline lookups: "all movements for asset X between A and B".
-- The partial index keeps it tight by skipping tombstones.
CREATE INDEX IF NOT EXISTS idx_movements_asset_time
  ON movements (asset_id, start_time)
  WHERE deleted_at IS NULL;

-- Org-scoped scans (cron jobs, reports).
CREATE INDEX IF NOT EXISTS idx_movements_org_time
  ON movements (org_id, start_time)
  WHERE deleted_at IS NULL;

-- Reverse lookup: given a Motive period id, find the movements row.
-- Used by the Motive sync's UPSERT (already covered by UNIQUE) and by
-- the cost-analysis path that needs to walk back to Motive's raw data.
CREATE INDEX IF NOT EXISTS idx_movements_motive_period
  ON movements (motive_period_id)
  WHERE motive_period_id IS NOT NULL;

-- ── movement_links ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS movement_links (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL,
  movement_id        uuid        NOT NULL REFERENCES movements(id) ON DELETE CASCADE,

  -- Five-way classification. Keep this as text + CHECK rather than a
  -- DB enum so adding new role kinds later doesn't require an enum
  -- migration (we have lots of orgs and enum changes are painful).
  role               text        NOT NULL CHECK (role IN ('loaded','transition','dwell','rest','unrelated')),

  -- Per-role event references. Constraint below enforces which combo
  -- of these is meaningful for each role.
  loaded_event_id    uuid        REFERENCES events(id) ON DELETE CASCADE,
  from_event_id      uuid        REFERENCES events(id) ON DELETE CASCADE,
  to_event_id        uuid        REFERENCES events(id) ON DELETE CASCADE,
  -- For 'dwell' specifically: which stop on the load. Enables receiver-
  -- level analytics ("avg dwell at receiver X across all loads") that
  -- can't be reconstructed if we only have loaded_event_id.
  dwell_stop_id      uuid        REFERENCES stops(id) ON DELETE CASCADE,

  -- Per-role validity:
  --   loaded      → loaded_event_id required
  --   transition  → at least one of from/to_event_id (start-of-day and
  --                  end-of-day transitions have only one side)
  --   dwell       → loaded_event_id + dwell_stop_id
  --   rest, unrelated → no event refs required
  CONSTRAINT movement_links_role_refs CHECK (
    (role = 'loaded'      AND loaded_event_id IS NOT NULL) OR
    (role = 'transition'  AND (from_event_id IS NOT NULL OR to_event_id IS NOT NULL)) OR
    (role = 'dwell'       AND loaded_event_id IS NOT NULL) OR
    (role IN ('rest','unrelated'))
  ),

  -- Provenance: who/what asserted this link.
  -- source = 'ai_v1' | 'ai_v2' | 'manual' | 'rule_xxx' — open-ended so
  -- new agents/heuristics can write their own facts without schema
  -- changes.
  source             text        NOT NULL,
  source_user        text,                   -- clerk user id when source='manual'
  confidence         text        CHECK (confidence IN ('high','medium','low')),
  -- One paragraph: "Origin city matches pickup; time within 30 min of
  -- appointment." AI fills this; manual rows can leave it blank or
  -- attach a note. This is gold for explainability and future training.
  reasoning          text,

  -- Append-only versioning. A new fact for the same movement inserts a
  -- new row and stamps superseded_at on the prior current row. Queries
  -- for "current truth" filter superseded_at IS NULL.
  asserted_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at      timestamptz,
  superseded_by      uuid        REFERENCES movement_links(id) ON DELETE SET NULL
);

-- "Current truth for this movement" — the single hottest query in the
-- system. Partial index keeps it small even as history accumulates.
CREATE INDEX IF NOT EXISTS idx_movement_links_current_by_movement
  ON movement_links (movement_id)
  WHERE superseded_at IS NULL;

-- Per-load reverse lookups. Each indexed only on current facts so the
-- per-load aggregation queries ("loaded miles for Load A") stay fast.
CREATE INDEX IF NOT EXISTS idx_movement_links_loaded_event
  ON movement_links (loaded_event_id)
  WHERE superseded_at IS NULL AND loaded_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movement_links_from_event
  ON movement_links (from_event_id)
  WHERE superseded_at IS NULL AND from_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movement_links_to_event
  ON movement_links (to_event_id)
  WHERE superseded_at IS NULL AND to_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_movement_links_dwell_stop
  ON movement_links (dwell_stop_id)
  WHERE superseded_at IS NULL AND dwell_stop_id IS NOT NULL;

-- Time-travel queries: "what links existed on Tuesday at 3pm?" use
-- (asserted_at, superseded_at) ranges. Not a hot path yet but cheap
-- to index.
CREATE INDEX IF NOT EXISTS idx_movement_links_asserted_at
  ON movement_links (asserted_at);

-- ── Auto-update updated_at on movements ───────────────────────────

CREATE OR REPLACE FUNCTION set_movements_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_updated_at ON movements;
CREATE TRIGGER trg_movements_updated_at
  BEFORE UPDATE ON movements
  FOR EACH ROW
  EXECUTE FUNCTION set_movements_updated_at();

-- ── Backfill from motive_driving_periods ──────────────────────────
--
-- One-time copy so the new asset-timeline code sees historical data
-- immediately. Idempotent: re-running this migration is a no-op
-- because of the UNIQUE constraint on motive_period_id.
--
-- We compute duration_min from start/end where Motive's `duration`
-- field is missing (it's seconds in Motive's API but we sometimes
-- get nulls on in-progress periods).
--
-- asset_id resolution: motive_driving_periods.vehicle_id is Motive's
-- vehicle id, not our asset id. The join through assets.motive_vehicle_id
-- maps it. Rows whose vehicle has no matching asset (orphan vehicles)
-- are skipped — they'd have nowhere to belong on the timeline anyway.

INSERT INTO movements (
  id,
  org_id,
  asset_id,
  driver_id,
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
  NULL                            AS driver_id,  -- Motive's driver id ≠ our drivers.id; could backfill later
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
  END                              AS duration_min,
  mdp.miles,
  mdp.origin,
  mdp.destination,
  mdp.origin_lat,
  mdp.origin_lon,
  mdp.destination_lat,
  mdp.destination_lon,
  'motive_sync_backfill',
  COALESCE(mdp.start_time, now())  AS created_at
FROM motive_driving_periods mdp
JOIN assets a
  ON a.org_id = mdp.org_id
 AND a.motive_vehicle_id = mdp.vehicle_id::text
ON CONFLICT (motive_period_id) DO NOTHING;

-- ── Ongoing dual-write trigger ────────────────────────────────────
--
-- The Motive sync's cron + manual /v1/movements/sync writes to
-- motive_driving_periods. Without a trigger, every new sync would
-- leave the `movements` table behind. Rather than touching the
-- TypeScript ingest in two places (one per table) and risking the
-- two going out of sync, we mirror at the DB layer:
--
--   INSERT into motive_driving_periods → INSERT into movements
--   UPDATE motive_driving_periods      → UPDATE movements (matched
--                                         by motive_period_id)
--
-- ON CONFLICT in the function body makes it idempotent — re-running
-- the Motive sync on the same period just refreshes the mirror.

CREATE OR REPLACE FUNCTION mirror_motive_period_to_movement()
RETURNS trigger AS $$
DECLARE
  v_asset_id bigint;
BEGIN
  -- Resolve our asset id from Motive's vehicle id. If there's no
  -- matching asset (orphan vehicle that hasn't been linked yet),
  -- skip the mirror — the dispatcher will configure the asset
  -- later and a subsequent UPDATE on this row will catch it.
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
  ON CONFLICT (motive_period_id) DO UPDATE SET
    -- Refresh mutable fields on re-sync. asset_id and org_id stay
    -- pinned to the original (a vehicle being reassigned to a new
    -- asset id is a manual operation, not a sync side-effect).
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

DROP TRIGGER IF EXISTS trg_mirror_motive_period_to_movement ON motive_driving_periods;
CREATE TRIGGER trg_mirror_motive_period_to_movement
  AFTER INSERT OR UPDATE ON motive_driving_periods
  FOR EACH ROW
  EXECUTE FUNCTION mirror_motive_period_to_movement();
