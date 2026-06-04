-- 20260607_loads_alvys_import.sql
--
-- Tracking columns for loads imported from external sources (Alvys TMS
-- being the immediate driver; pattern leaves room for any future TMS).
--
--   loads.alvys_load_id    — Alvys load UUID, NULL for non-imported loads.
--                            UNIQUE so re-runs upsert cleanly.
--   loads.imported_source  — 'alvys' | 'manual' | NULL (NULL = native).
--                            Lets the UI tag/badge historical-import rows
--                            and lets reports optionally filter them.
--   loads.imported_at      — when the import script wrote the row. Lets
--                            us tell "first imported" vs "last re-synced"
--                            apart from loads.updated_at, which any later
--                            dispatcher edit will bump.
--
-- The same hook lives on events for the bridge enrichment step (Phase
-- 2 of the importer pulls per-event miles from the legacy my-calendar
-- Supabase by matching on events.alvys_load_id).
--
-- All columns are nullable and indexed partially so non-imported rows
-- pay nothing.

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS alvys_load_id   text,
  ADD COLUMN IF NOT EXISTS imported_source text,
  ADD COLUMN IF NOT EXISTS imported_at     timestamptz;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS alvys_load_id text;

-- Unique on (org_id, alvys_load_id) — two orgs could legitimately import
-- the same Alvys account in the future. Today only one org will, but
-- the constraint is cheap to scope tightly. NULL alvys_load_id is fine
-- (every non-imported load).
CREATE UNIQUE INDEX IF NOT EXISTS uq_loads_org_alvys
  ON loads (org_id, alvys_load_id)
  WHERE alvys_load_id IS NOT NULL;

-- Event lookup for the Phase 2 enrichment pass.
CREATE INDEX IF NOT EXISTS idx_events_alvys
  ON events (alvys_load_id)
  WHERE alvys_load_id IS NOT NULL;
