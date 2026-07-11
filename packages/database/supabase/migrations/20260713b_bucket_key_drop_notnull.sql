-- 20260713b_bucket_key_drop_notnull.sql
--
-- Phase E moved bucket routing to bucket_id (uuid FK) but left the
-- legacy bucket_key text columns NOT NULL from Phase D. New inserts
-- only write bucket_id, so creating any recurring expense, one-time
-- entry, or auto-file rule failed with a not-null violation on the
-- column nothing writes anymore. Relax it; the columns stay for
-- historical reference until a later cleanup drops them entirely.

ALTER TABLE recurring_expenses  ALTER COLUMN bucket_key DROP NOT NULL;
ALTER TABLE expense_entries     ALTER COLUMN bucket_key DROP NOT NULL;
ALTER TABLE ramp_category_rules ALTER COLUMN bucket_key DROP NOT NULL;
