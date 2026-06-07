-- 20260607_customers_billing_address.sql
--
-- Add billing_address to customers — free-form text used on every
-- invoice's "Bill To" block. The UI collects it via Google Places
-- autocomplete so the format stays consistent ("Knight-Swift
-- Transportation\n2002 W Wahalla Ln\nPhoenix, AZ 85027") but the
-- column itself is plain text so legacy and AI-extracted values
-- don't get rejected.
--
-- Nullable: existing customers have no value until either a
-- dispatcher fills it in or the rate-con harvester extracts it.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_address text;
