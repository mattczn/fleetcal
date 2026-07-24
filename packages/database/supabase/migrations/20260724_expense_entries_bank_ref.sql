-- 20260724_expense_entries_bank_ref.sql
--
-- Anchor expense entries to the bank transaction they represent, so
-- imports can dedupe mechanically instead of re-matching by amount and
-- date each close. Populated by the monthly-close tooling (and the H1
-- backfill generated from the July 2026 full-bank audit).
--
--   bank_account — last-4 of the Chase account/card ('0365', '9481', …)
--   bank_date    — the BANK's posting/transaction date (QB dates drift)
--   bank_amount  — signed amount as the bank recorded it
--
-- Multiple entries MAY share one bank ref (QB legitimately splits one
-- charge into components), so this is an anchor, not a unique key.
-- NULL means "no bank counterpart known" — synthetic adjustments, or
-- rows whose bank match couldn't be established.

ALTER TABLE expense_entries
  ADD COLUMN IF NOT EXISTS bank_account text,
  ADD COLUMN IF NOT EXISTS bank_date    date,
  ADD COLUMN IF NOT EXISTS bank_amount  numeric(12, 2);

CREATE INDEX IF NOT EXISTS idx_expense_entries_bank_ref
  ON expense_entries (org_id, bank_account, bank_date, bank_amount)
  WHERE bank_account IS NOT NULL;
