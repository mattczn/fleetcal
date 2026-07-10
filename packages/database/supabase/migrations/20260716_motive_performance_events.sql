-- 20260716_motive_performance_events.sql
--
-- Motive driver performance events (GET /v2/driver_performance_events).
-- Hard acceleration, hard braking, hard cornering — plus any v2-only
-- types (phone use, distraction, drowsiness, etc.) if the fleet's plan
-- surfaces them. We store whatever comes back and let the UI decide
-- what to show; that way adding more event types is a UI change, not
-- another ingest deploy.
--
-- Dispatcher workflow lives on this table:
--   dispatch_status = 'new'       — just landed, shows in the bell
--                     'confirmed' — dispatcher acknowledged, driver assigned
--                     'notified'  — safety push was sent to the driver
--                     'dismissed' — false positive / no action needed
--   assigned_driver_id            — dispatcher's confirmed driver (may
--                                   override Motive's driver_id, which
--                                   can lag by a few minutes on shift
--                                   changes)
--
-- Read-only from Motive's side (we UPSERT on id so Motive can update an
-- event without us duplicating it), read/write on the dispatcher-facing
-- columns.

CREATE TABLE IF NOT EXISTS motive_performance_events (
  id                    bigint       PRIMARY KEY,               -- Motive's event id
  org_id                text         NOT NULL,
  event_type            text         NOT NULL,                  -- 'hard_accel' | 'hard_brake' | 'hard_corner' | v2 types
  event_time            timestamptz  NOT NULL,                  -- start_time from Motive
  end_time              timestamptz,
  duration              double precision,                       -- seconds, as reported (Motive returns floats)
  intensity             text,                                   -- Motive's severity string ('mild' | 'moderate' | 'severe')

  vehicle_id            bigint       NOT NULL,                  -- Motive vehicle.id
  vehicle_number        text,                                   -- vehicle.number — display label
  asset_id              bigint,                                 -- resolved from assets.motive_vehicle_id at ingest time
  driver_id             bigint,                                 -- Motive driver_id (may be null / stale)
  driver_first_name     text,
  driver_last_name      text,

  -- Location at start of the event — used to render a map pin in the
  -- dispatcher drawer.
  lat                   double precision,
  lon                   double precision,
  location_label        text,                                   -- Motive's pre-formatted location string when present

  -- Full Motive payload as we saw it. Lets us surface v2-only fields
  -- (media urls, behavioral classifications) in the UI without another
  -- migration when we add support.
  raw                   jsonb        NOT NULL,

  -- ── Dispatcher workflow columns ────────────────────────────────────
  dispatch_status       text         NOT NULL DEFAULT 'new'
    CHECK (dispatch_status IN ('new','confirmed','dismissed','notified')),
  assigned_driver_id    bigint,                                 -- fleetcal drivers.id (not Motive's driver_id)
  dispatch_note         text,                                   -- optional dispatcher note attached at notify time
  dispatched_at         timestamptz,                            -- when a dispatcher first moved status off 'new'
  dispatched_by_name    text,
  notified_at           timestamptz,                            -- when safety push was sent
  notified_driver_id    bigint,                                 -- which driver (fleetcal id) received it
  notified_message      text,                                   -- message body sent to the driver

  ingested_at           timestamptz  NOT NULL DEFAULT now(),
  motive_updated_at     timestamptz
);

-- Bell feed: newest events for this org.
CREATE INDEX IF NOT EXISTS idx_motive_performance_events_org_time
  ON motive_performance_events (org_id, event_time DESC);

-- Unread-count query: `WHERE org_id = ? AND dispatch_status = 'new'`.
CREATE INDEX IF NOT EXISTS idx_motive_performance_events_org_status
  ON motive_performance_events (org_id, dispatch_status)
  WHERE dispatch_status = 'new';

-- Truck-detail drawer: "recent safety events on this truck".
CREATE INDEX IF NOT EXISTS idx_motive_performance_events_vehicle_time
  ON motive_performance_events (vehicle_id, event_time DESC);

-- Current-driver resolver uses motive_driving_periods, but a partial
-- index on asset_id helps the "safety events for this asset" query
-- once we hook it into the equipment detail page.
CREATE INDEX IF NOT EXISTS idx_motive_performance_events_asset_time
  ON motive_performance_events (asset_id, event_time DESC)
  WHERE asset_id IS NOT NULL;
