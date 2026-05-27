-- 20260530_fuel_transactions_driver_asset.sql
--
-- Adds driver_id + asset_id directly on fuel_transactions so a card
-- transaction can be attributed to a driver + truck even when there's
-- no paired driver fuel_report. Previously the only way to attribute
-- a transaction was to link it to a fuel_report (which carried
-- driver_id + asset_id indirectly) — fine when the driver filed at
-- the pump, useless when they didn't.
--
-- Both columns nullable: the receipt's free-text driver_name +
-- matched_truck don't always resolve to a known driver/asset, and
-- legacy imported rows from my-calendar won't have been resolved yet.
-- The dispatch UI surfaces unresolved rows as "Card only" badges with
-- a dropdown to manually assign.
--
-- ON DELETE SET NULL on both FKs — if a driver retires (hard-delete)
-- or a truck is decommissioned, historical transactions keep their
-- $ + gallons data, they just lose the named link. Same pattern as
-- fuel_reports' driver_id/asset_id refs in 2026-05-12-fuel-reports.sql.

ALTER TABLE fuel_transactions
  ADD COLUMN IF NOT EXISTS driver_id  bigint REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS asset_id   bigint REFERENCES assets(id)  ON DELETE SET NULL;

-- Filtering by driver in the unified fuel table + KPI dashboard.
CREATE INDEX IF NOT EXISTS fuel_transactions_driver_idx
  ON fuel_transactions (org_id, driver_id, transaction_date DESC)
  WHERE driver_id IS NOT NULL AND deleted_at IS NULL;

-- Filtering by asset (per-truck cost analysis).
CREATE INDEX IF NOT EXISTS fuel_transactions_asset_idx
  ON fuel_transactions (org_id, asset_id, transaction_date DESC)
  WHERE asset_id IS NOT NULL AND deleted_at IS NULL;
