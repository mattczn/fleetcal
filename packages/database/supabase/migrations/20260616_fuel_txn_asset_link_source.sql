-- 20260616_fuel_txn_asset_link_source.sql
--
-- Tracks WHY a fuel_transaction's asset_id was set. Values:
--   'card'                  — matched via assets.mudflap_card_last4
--   'vehicle_number'        — exact match on assets.unit
--   'vehicle_number_token'  — first-token match (driver appended name)
--   'vin'                   — matched via assets.vin
--   'license_plate'         — matched via assets.license_plate
--   'report'                — mirrored from a linked fuel_report
--   'manual'                — dispatcher explicitly set via /assign
--   NULL                    — no asset_id, or set before this column existed
--
-- Drives the "via card" pill in the UI and the cross-truck warning
-- on manual link (POST /:id/match): if asset_link_source='card' and
-- the new report's asset_id differs from the current asset_id, the
-- endpoint returns 409 with warning=card_truck_mismatch unless the
-- caller passes ?force=true.

ALTER TABLE fuel_transactions
  ADD COLUMN IF NOT EXISTS asset_link_source TEXT;

CREATE INDEX IF NOT EXISTS idx_fuel_txns_asset_link_source
  ON fuel_transactions (org_id, asset_link_source)
  WHERE asset_link_source IS NOT NULL;
