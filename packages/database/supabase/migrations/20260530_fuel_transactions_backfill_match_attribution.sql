-- 20260530_fuel_transactions_backfill_match_attribution.sql
--
-- Backfill driver_id + asset_id on every fuel_transaction that's
-- already linked to a fuel_report. The /match endpoint used to set
-- only fuel_report_id when manual-linking; with the columns added
-- in 20260530_fuel_transactions_driver_asset.sql the dispatch UI
-- now expects the transaction to carry its own driver_id/asset_id
-- so the dropdowns pre-fill without joining through fuel_reports.
--
-- This is a one-time fix-up. New rows ingested after the matcher
-- rewrite (in apps/api/src/lib/fuelMatcher.ts + routes/fuel-
-- transactions.ts) mirror driver_id/asset_id at link time, so the
-- backfill only matters for historical data.
--
-- Safe to re-run: WHERE driver_id IS NULL filters out rows that
-- already have an intentional override.

UPDATE fuel_transactions ft
SET driver_id = fr.driver_id
FROM fuel_reports fr
WHERE ft.fuel_report_id = fr.id
  AND ft.org_id        = fr.org_id
  AND ft.driver_id     IS NULL
  AND fr.driver_id     IS NOT NULL;

UPDATE fuel_transactions ft
SET asset_id = fr.asset_id
FROM fuel_reports fr
WHERE ft.fuel_report_id = fr.id
  AND ft.org_id        = fr.org_id
  AND ft.asset_id      IS NULL
  AND fr.asset_id      IS NOT NULL;
