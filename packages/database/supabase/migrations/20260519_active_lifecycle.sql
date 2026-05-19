-- 20260519_active_lifecycle.sql
--
-- Replace hard-delete semantics with an active_from / active_to
-- lifecycle on assets, drivers, and trailers. "Delete" in the UI
-- now means "retire" — set active_to = today, the row stays, all
-- historical events keep their FK references intact.
--
-- Semantics:
--   active_from = first day the asset/driver/trailer is part of the
--                 fleet. NOT NULL. Backfilled from created_at::date.
--                 New rows default to CURRENT_DATE.
--   active_to   = last day. NULL means currently active. Setting a
--                 date retires; rows are filtered out of the calendar
--                 grid and picker dropdowns when viewing a date past
--                 active_to.
--
-- The existing `assets.hidden` boolean stays — it's a separate
-- concern ("don't show in the calendar even though active", e.g. a
-- backup truck reserved for special freight). active_to is for true
-- end-of-life retirement.
--
-- Also hardens the events foreign keys: assets and trailers move
-- from ON DELETE CASCADE → RESTRICT, and drivers from ON DELETE SET
-- NULL → RESTRICT. With retire-instead-of-delete, hard deletes
-- shouldn't happen at all — but if someone bypasses the API and runs
-- raw SQL, RESTRICT refuses to wipe the asset/driver/trailer while
-- loads still reference it.

-- ── assets ────────────────────────────────────────────────────────────

ALTER TABLE assets ADD COLUMN IF NOT EXISTS active_from date;
UPDATE assets SET active_from = created_at::date WHERE active_from IS NULL;
ALTER TABLE assets ALTER COLUMN active_from SET NOT NULL;
ALTER TABLE assets ALTER COLUMN active_from SET DEFAULT CURRENT_DATE;

ALTER TABLE assets ADD COLUMN IF NOT EXISTS active_to date;

CREATE INDEX IF NOT EXISTS idx_assets_active
  ON assets(org_id, active_from, active_to);

-- ── drivers ───────────────────────────────────────────────────────────

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active_from date;
UPDATE drivers SET active_from = created_at::date WHERE active_from IS NULL;
ALTER TABLE drivers ALTER COLUMN active_from SET NOT NULL;
ALTER TABLE drivers ALTER COLUMN active_from SET DEFAULT CURRENT_DATE;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active_to date;

CREATE INDEX IF NOT EXISTS idx_drivers_active
  ON drivers(org_id, active_from, active_to);

-- ── trailers ──────────────────────────────────────────────────────────

ALTER TABLE trailers ADD COLUMN IF NOT EXISTS active_from date;
UPDATE trailers SET active_from = created_at::date WHERE active_from IS NULL;
ALTER TABLE trailers ALTER COLUMN active_from SET NOT NULL;
ALTER TABLE trailers ALTER COLUMN active_from SET DEFAULT CURRENT_DATE;

ALTER TABLE trailers ADD COLUMN IF NOT EXISTS active_to date;

CREATE INDEX IF NOT EXISTS idx_trailers_active
  ON trailers(org_id, active_from, active_to);

-- ── Foreign-key hardening on events ───────────────────────────────────

-- assets: was ON DELETE CASCADE (would wipe events if asset deleted).
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_asset_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_asset_id_fkey
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT;

-- drivers: was ON DELETE SET NULL (preserves events but loses driver).
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_driver_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE RESTRICT;

-- trailers: harden too. The original constraint name may differ across
-- environments; use IF EXISTS so re-run is safe.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_trailer_id_fkey;
ALTER TABLE events ADD CONSTRAINT events_trailer_id_fkey
  FOREIGN KEY (trailer_id) REFERENCES trailers(id) ON DELETE RESTRICT;
