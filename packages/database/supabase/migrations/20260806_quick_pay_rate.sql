-- 20260806_quick_pay_rate.sql
--
-- Records the fee a customer withholds when they pay early, so a payment
-- that arrives short BY AGREEMENT can close its invoice instead of leaving
-- a permanent balance.
--
-- WHY THIS IS A COLUMN AND NOT A CUSTOM FIELD
--
-- Quick pay is a universal freight arrangement, not a Curzon-shaped one:
-- every carrier that takes early payment from a broker deals with a
-- withheld percentage. It also has to be READ BY CODE — the remittance
-- matcher consults it to decide whether a shortfall is expected — and a
-- value the matcher must interpret cannot live in a jsonb bag whose keys
-- are defined per-org. It sits beside `invoice_method` and
-- `invoice_instructions`, which are the same kind of fact.
--
-- WHAT IT MEASURES
--
-- The FRACTION WITHHELD, not the fraction paid. 0.0100 means "pays 99%".
-- Stored as a rate rather than a dollar amount because that is how the
-- agreement is actually written, and because it has to hold across invoice
-- sizes — Triple T's fee is $3.01 on a $301 load and $6.00 on a $600 one.
--
-- NULL means no arrangement: any shortfall stays open, which is the
-- correct default for a customer who is simply underpaying.
--
-- WHY A RATE RATHER THAN A TOLERANCE
--
-- A blanket "close anything within 2%" cannot tell a contracted fee from a
-- broker quietly shorting you inside the threshold. Curzon's own data makes
-- the distinction visible — of 297 open invoices carrying a partial
-- payment on 2026-08-06:
--
--   Triple T   withheld 0.0100   290 invoices   $1,002.63   ← the agreement
--   Triple T   withheld 0.1514     4 invoices   $  318.00   ← something else
--   Triple T   withheld 0.1200     1 invoice    $   81.00   ← something else
--   Redbone    withheld 0.1241     1 invoice    $  200.00   ← something else
--   Redbone    withheld 0.0709     1 invoice    $  200.00   ← something else
--
-- A rate closes the first row and leaves the other six open to be looked
-- at. A 2% tolerance would close the first row and still leave the rest; a
-- 15% one would swallow every deduction Triple T ever takes. Only the rate
-- encodes which of these was agreed to.

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS quick_pay_rate numeric(5,4)
    CHECK (quick_pay_rate IS NULL OR (quick_pay_rate >= 0 AND quick_pay_rate < 0.5));

COMMENT ON COLUMN customers.quick_pay_rate IS
  'Fraction withheld under a quick-pay agreement, e.g. 0.0100 for 1%. '
  'NULL = no arrangement; any shortfall stays open. Read by the remittance '
  'matcher to decide whether a short payment settles its invoice.';

COMMIT;

-- ── Finding the customers that need one ───────────────────────────────
--
-- A quick-pay rate shows up as a tight cluster of identical paid/total
-- ratios just under 1. Run this and set the rate for anything that looks
-- like an agreement rather than a scatter.
--
--   SELECT c.name,
--          round(1 - (i.paid_amount / i.total)::numeric, 4) AS withheld,
--          count(*)                                         AS invoices,
--          round(sum(i.total - i.paid_amount)::numeric, 2)   AS residual
--   FROM invoices i
--   JOIN customers c ON c.id = i.customer_id
--   WHERE i.org_id = '<org>'
--     AND i.status <> 'void'
--     AND i.total > 0
--     AND i.paid_amount > 0
--     AND i.paid_amount < i.total
--   GROUP BY 1, 2
--   HAVING count(*) >= 5
--   ORDER BY invoices DESC;
--
-- On Curzon prod as of 2026-08-06 that returns one unambiguous row:
-- Triple T Transport, withheld 0.0100, 290 invoices, $1,002.63 residual.
--
--   UPDATE customers SET quick_pay_rate = 0.0100
--   WHERE org_id = '<org>' AND name = 'Triple T Transport';
--
-- Setting the rate does NOT retroactively close anything — it only changes
-- what happens on the next payment. To close the invoices already stuck,
-- run 20260806_close_quick_pay_backlog.sql.
