-- 20260616_assets_mudflap_card_last4.sql
--
-- Adds mudflap_card_last4 to assets so we can deterministically map a
-- Mudflap card transaction → truck without relying on the driver typing
-- the vehicle number at the pump.
--
-- Background: Mudflap card transactions include a card_last4 field.
-- Each physical card lives inside a specific truck (one card per
-- truck), so card_last4 → asset_id is a 1:1 mapping that doesn't
-- depend on driver behavior. This was previously inferred from
-- vehicle_identifiers.vehicle_number, which drivers sometimes left
-- blank or pasted their name into ("2026 Rodrigo"). Storing the
-- card last-4 on the asset makes the matcher rock-solid.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS mudflap_card_last4 TEXT;

-- Partial index — only assets with a card set are interesting for the
-- (org_id, card_last4) lookup the matcher does on every API ingest.
CREATE INDEX IF NOT EXISTS idx_assets_mudflap_card_last4
  ON assets (org_id, mudflap_card_last4)
  WHERE mudflap_card_last4 IS NOT NULL;
