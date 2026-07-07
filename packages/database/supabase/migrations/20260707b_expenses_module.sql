-- 20260707b_expenses_module.sql
--
-- Foundation for the /expenses dashboard. Two additions:
--
--   1. ramp_transactions.expense_category — nullable text column for
--      the sub-categorization the /expenses page will drive (maintenance
--      / equipment / load_expenses / office / etc.). No CHECK constraint
--      yet: the canonical set is still being decided. Phase B will pin
--      the enum and add auto-mapping from Ramp's sk_category_name.
--
--   2. Partial index on (org_id, expense_category) to speed the future
--      "show all maintenance-categorized spend for this asset" query
--      that the maintenance module will run once the feedback loop
--      lands.
--
-- The `expenses` module flag itself is code-only (packages/types/
-- modules.ts) — org_settings.modules jsonb already supports arbitrary
-- keys, and absent = enabled, so Curzon gets it ON without a data
-- change.

ALTER TABLE ramp_transactions
  ADD COLUMN IF NOT EXISTS expense_category text;

CREATE INDEX IF NOT EXISTS ramp_transactions_expense_cat_idx
  ON ramp_transactions (org_id, expense_category)
  WHERE expense_category IS NOT NULL AND deleted_at IS NULL;
