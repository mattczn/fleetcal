-- Backfill columns missing from org_settings on databases where the
-- original 20260428_org_settings.sql migration was a no-op (CREATE TABLE
-- IF NOT EXISTS skipped because the table was bootstrapped earlier with
-- only motive_api_key + org_id). Idempotent.

ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS show_driver_pay boolean     NOT NULL DEFAULT false;
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();
ALTER TABLE org_settings ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();
