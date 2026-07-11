-- 20260712_system_role_subbuckets.sql
--
-- Allow system roles (driver_pay, mudflap_fuel) on SUB-buckets, not
-- just top-level ones. Sub-bucket totals roll up into their parent on
-- the dashboard, so e.g. Fleet Operations → Fuel can receive the
-- Mudflap auto-feed and Fleet Operations still shows the full number.
-- The one-bucket-per-role-per-org unique index stays.

ALTER TABLE expense_buckets
  DROP CONSTRAINT IF EXISTS expense_buckets_system_role_top_level_only;
