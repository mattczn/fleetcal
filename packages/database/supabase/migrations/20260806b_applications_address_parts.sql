-- 20260806b_applications_address_parts.sql
--
-- Structured address on applicants.
--
-- A single free-text address field is fine to display and useless to work
-- with: you can't sort by state, can't validate a ZIP, and can't tell a
-- missing apartment number from a missing street. Applicants get the parts.
--
-- `drivers.address` and `driver_contracts.contractor_address` stay single
-- text columns on purpose — the contract prints one address line, and those
-- are composed from these parts at hire time. Splitting the driver record too
-- would mean touching the driver modal and every read of that column, which
-- is a separate change.

ALTER TABLE driver_applications
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city          text,
  ADD COLUMN IF NOT EXISTS state         text,
  ADD COLUMN IF NOT EXISTS postal_code   text;

-- Carry anything already captured in the free-text column into line 1 rather
-- than dropping it. `address` is kept as the composed value going forward.
UPDATE driver_applications
   SET address_line1 = address
 WHERE address_line1 IS NULL
   AND address IS NOT NULL;

COMMENT ON COLUMN driver_applications.address IS
  'Composed single-line address, derived from the parts. Written on save; do not edit directly.';
