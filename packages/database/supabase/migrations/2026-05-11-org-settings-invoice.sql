-- Org-level invoice configuration. Stored as JSON so we can iterate on
-- the shape without DDL churn — same pattern rate_con_settings uses.
-- The application normalizes empty objects to InvoiceSettings defaults
-- (see packages/types/domain.ts), so a NULL/{} row is treated as "no
-- invoice info filled in yet".

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS invoice_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
