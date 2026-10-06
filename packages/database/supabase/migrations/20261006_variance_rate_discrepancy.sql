-- 20261006_variance_rate_discrepancy.sql
--
-- Adds 'rate_discrepancy' to invoice_payments.variance_reason.
-- Run once; safe to re-run.
--
-- The existing four reasons answer "why is this short" with quick_pay,
-- short_pay, deduction or other. None of them fits the most common real
-- case: we invoiced one rate and the broker paid another, because the
-- booking and the billing disagreed.
--
-- Measured on Curzon: five Triple T invoices on one remittance (D0587060)
-- each implied a base exactly $75 under what we billed — $450 against $525,
-- $600 against $675 — with the quick pay applied correctly to THEIR number.
-- Filing that as short_pay says the broker underpaid; filing it as
-- deduction says they took something off. Both are wrong, and both corrupt
-- the figures that answer "what do deductions cost us" and "what does quick
-- pay cost us".
--
-- It earns its own value because the response differs: a deduction is
-- disputed with the broker, a rate discrepancy is fixed in how the load was
-- booked or billed, and nobody needs calling.
--
-- REVERSAL: re-run the original CHECK after moving rows off the new value:
--   UPDATE invoice_payments SET variance_reason = 'other'
--   WHERE variance_reason = 'rate_discrepancy';

BEGIN;

ALTER TABLE invoice_payments
  DROP CONSTRAINT IF EXISTS invoice_payments_variance_reason_check;

ALTER TABLE invoice_payments
  ADD CONSTRAINT invoice_payments_variance_reason_check
  CHECK (variance_reason IS NULL OR variance_reason IN
    ('quick_pay', 'short_pay', 'deduction', 'rate_discrepancy', 'overpayment', 'other'));

COMMIT;

-- Expect 0 on a fresh run.
SELECT count(*) AS rate_discrepancies
FROM invoice_payments WHERE variance_reason = 'rate_discrepancy';
