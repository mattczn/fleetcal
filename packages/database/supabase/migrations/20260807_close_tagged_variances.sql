-- 20260807_close_tagged_variances.sql
--
-- DATA FIX. Run once. Safe to re-run.
--
-- Closes invoices whose allocation ALREADY carries a variance_reason but
-- which are still sitting open.
--
-- Nothing was entered wrong. `variance_reason` only started closing an
-- invoice as of the settlement change shipped 2026-08-07, and that rule is
-- evaluated by recomputeInvoicePaid() — which runs when an allocation is
-- WRITTEN. Allocations tagged before the deploy were computed under the old
-- rule and have not been recomputed since, so the reason sits on the record
-- doing nothing.
--
-- On Curzon that is 2 invoices and $400 of phantom balance, both Redbone
-- $200 deductions tagged by hand on 2026-08-06:
--
--   #13760   $2,821.72 billed, $2,621.72 paid, deduction
--   #14175   $1,611.26 billed, $1,411.26 paid, deduction
--
-- The other 310 tagged allocations are quick_pay and already closed.
--
-- This is a ONE-OFF for the pre-deploy backlog. Anything tagged from now on
-- closes on the spot, because writing the allocation triggers the recompute.
--
-- REVERSAL:
--   UPDATE invoices SET status = 'sent'
--   WHERE id IN (...) ;  -- the ids listed by the dry run

-- ── 1. DRY RUN ───────────────────────────────────────────────────────

SELECT DISTINCT
       i.invoice_number,
       c.name AS customer,
       i.total,
       i.paid_amount,
       round((i.total - i.paid_amount)::numeric, 2) AS balance_to_clear,
       ip.variance_reason
FROM invoices i
JOIN invoice_payments ip ON ip.invoice_id = i.id
LEFT JOIN customers c    ON c.id = i.customer_id
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status IN ('draft', 'sent')
  AND ip.variance_reason IS NOT NULL
  AND ip.variance_reason <> 'overpayment'
ORDER BY balance_to_clear DESC;

-- Expected: 2 rows, $400 total.

-- ── 2. THE FIX ───────────────────────────────────────────────────────
-- Same arithmetic recomputeInvoicePaid() applies. paid_amount is NOT
-- touched — the money stays what the customer actually sent, and the
-- deduction stays visible as the gap between total and paid.

BEGIN;

UPDATE invoices i
SET status     = 'paid',
    paid_at    = coalesce(i.paid_at,
                          (SELECT max(ip.paid_on)::timestamptz + interval '12 hours'
                           FROM invoice_payments ip WHERE ip.invoice_id = i.id)),
    updated_at = now()
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status IN ('draft', 'sent')
  AND EXISTS (
    SELECT 1 FROM invoice_payments ip
    WHERE ip.invoice_id = i.id
      AND ip.variance_reason IS NOT NULL
      AND ip.variance_reason <> 'overpayment'
  );

COMMIT;

-- ── 3. VERIFY — expect 0 ─────────────────────────────────────────────

SELECT count(*) AS still_open_with_a_reason
FROM invoices i
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status IN ('draft', 'sent')
  AND EXISTS (
    SELECT 1 FROM invoice_payments ip
    WHERE ip.invoice_id = i.id
      AND ip.variance_reason IS NOT NULL
      AND ip.variance_reason <> 'overpayment'
  );
