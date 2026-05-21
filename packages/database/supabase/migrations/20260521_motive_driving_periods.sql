-- 20260521_motive_driving_periods.sql
--
-- Telemetry ingestion table for Motive driving periods (GET /v1/driving_periods).
-- Movements are read-only from our perspective — Motive is the source of
-- truth, we mirror their data so dispatchers can see "what actually
-- moved" alongside the load events they assigned.
--
-- Naming: rows here are NEVER edited by FleetCal users. Edits flow
-- one way (Motive → us via UPSERT on id, including source=2 user
-- edits made inside Motive's own app).
--
-- Excluded fields (per spec): HVB / battery state, lifetime energy
-- output (we run diesel), vehicle year/make/model/vin/metric_units
-- (static, lives in our `assets` table), annotation_status, notes.

CREATE TABLE IF NOT EXISTS motive_driving_periods (
  id                    bigint        PRIMARY KEY,           -- Motive's driving_period.id
  org_id                text          NOT NULL,              -- denormalized for fast per-org queries + future multi-org
  vehicle_id            bigint        NOT NULL,              -- Motive's vehicle.id; maps to assets.motive_vehicle_id (text)
  vehicle_number        text,                                -- vehicle.number — display label
  driver_id             bigint,                              -- nullable; Motive driver id
  driver_first_name     text,
  driver_last_name      text,
  start_time            timestamptz   NOT NULL,
  end_time              timestamptz,                         -- nullable for in-progress periods
  duration              integer,                             -- seconds, as reported
  start_kilometers      double precision,
  end_kilometers        double precision,
  distance              text,                                -- Motive's display string ("12.4 mi" etc)
  origin                text,
  destination           text,
  origin_lat            double precision,
  origin_lon            double precision,
  destination_lat       double precision,
  destination_lon       double precision,
  type                  text,                                -- 'driving' | 'PC' | 'YM'
  status                text,                                -- 'in_progress' | 'complete' | 'interrupted'
  source                integer,                             -- 1=gateway, 2=user edit, 3=unidentified-driver assumption
  miles                 double precision,                    -- (end_km - start_km) * 0.621371 — precomputed for filtering/display
  display_eligible      boolean       NOT NULL DEFAULT false,-- miles >= MIN_MOVEMENT_MILES at ingest time
  ingested_at           timestamptz   NOT NULL DEFAULT now(),
  motive_updated_at     timestamptz                          -- echoes the API's updated_at when present
);

-- Calendar lane query: "give me everything for this truck in this window."
CREATE INDEX IF NOT EXISTS idx_motive_driving_periods_vehicle_start
  ON motive_driving_periods (vehicle_id, start_time);

-- Partial index for the calendar feed — the common path filters to
-- eligible-only and a small date window. Partial keeps the index
-- small even as the table accumulates short / GPS-jitter periods.
CREATE INDEX IF NOT EXISTS idx_motive_driving_periods_eligible
  ON motive_driving_periods (org_id, start_time)
  WHERE display_eligible = true;

-- Cursor table — incremental sync uses ?updated_after=<cursor> to
-- only fetch what's changed since the last successful run. One row
-- per org per sync feed (we expect just 'driving_periods' for now,
-- but the column lets us add 'idle_events' / 'reefer_samples' later
-- without a schema change).
CREATE TABLE IF NOT EXISTS motive_sync_state (
  org_id            text         NOT NULL,
  feed              text         NOT NULL DEFAULT 'driving_periods',
  last_cursor       timestamptz,
  last_synced_at    timestamptz  NOT NULL DEFAULT now(),
  last_run_status   text,                                    -- 'ok' | 'error'
  last_run_detail   text,                                    -- error message when last_run_status='error'
  PRIMARY KEY (org_id, feed)
);
