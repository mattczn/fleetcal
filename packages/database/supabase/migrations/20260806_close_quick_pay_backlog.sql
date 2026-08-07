-- 20260806_close_quick_pay_backlog.sql
--
-- DATA REPAIR. Run AFTER 20260806_quick_pay_rate.sql (needs the column)
-- and AFTER 20260806_dedupe_double_applied.sql (otherwise it would close
-- invoices that are double-credited, which hides the double credit).
-- Safe to re-run.
--
-- WHAT THIS CLOSES
--
-- Triple T pays 99% under a 1% quick-pay agreement. Settlement required
-- applied >= total, so every one of those payments left a 1% balance the
-- invoice could never shed: 290 invoices sitting in past due for $3.01 and
-- $4.51 apiece, $1,002.63 of receivable that was never receivable. It is
-- the "234 past due" on the Triple T ledger.
--
-- That was not only untidy. `variance_reason` existed on the allocation
-- from the beginning and nothing consulted it, so there was no way to say
-- "this is the whole payment" — and an invoice that never closes never
-- looks settled, which is exactly how the same remittance came to be
-- applied to it a second time.
--
-- WHAT IT DOES
--
-- Stamps variance_reason = 'quick_pay' on the allocation, which is now the
-- signal that closes an invoice at whatever arrived. The dollars are NOT
-- altered: paid_amount stays at what the customer actually sent, and the
-- withheld fee stays visible as the gap between total and paid. Nothing is
-- written off silently.
--
-- WHAT IT DELIBERATELY LEAVES ALONE
--
-- Only shortfalls matching the customer's recorded rate. On Curzon prod
-- that closes 290 invoices and leaves six alone:
--
--   Triple T   withheld 0.1514   4 invoices   $318.00
--   Triple T   withheld 0.1200   1 invoice    $ 81.00
--   Redbone    withheld 0.1241   1 invoice    $200.00
--   Redbone    withheld 0.0709   1 invoice    $200.00
--
-- Those are deductions or short-pays, not the agreement, and they stay
-- open on purpose — they are worth asking about. A blanket tolerance
-- would have buried them.
--
-- REVERSAL:
--   UPDATE invoice_payments SET variance_reason = NULL
--   WHERE variance_reason = 'quick_pay' AND note LIKE '%backfilled 2026-08-06%';
--   -- then re-run recompute (or the UPDATE at the end of this file with
--   -- the CASE inverted).

-- ── 1. DRY RUN ───────────────────────────────────────────────────────

SELECT c.name,
       c.quick_pay_rate,
       count(*)                                        AS invoices_to_close,
       round(sum(i.total - i.paid_amount)::numeric, 2)  AS fee_recognised
FROM invoices  i
JOIN customers c ON c.id = i.customer_id
WHERE i.org_id = '<org>'
  AND i.status IN ('draft', 'sent')
  AND c.quick_pay_rate IS NOT NULL
  AND i.total > 0
  AND i.paid_amount > 0
  AND i.paid_amount < i.total
  -- The shortfall IS the agreed rate, within a cent or two of the payer's
  -- own rounding. Anything else is a different conversation.
  AND abs(i.paid_amount - (i.total * (1 - c.quick_pay_rate))) <= 0.02
GROUP BY c.name, c.quick_pay_rate;

-- Expected on Curzon prod: Triple T Transport, 0.0100, 290 invoices,
-- $1,002.63 recognised as quick-pay fee.

-- ── 2. THE REPAIR ────────────────────────────────────────────────────

BEGIN;

CREATE TEMP TABLE _quick_pay_invoices ON COMMIT DROP AS
SELECT i.id
FROM invoices  i
JOIN customers c ON c.id = i.customer_id
WHERE i.org_id = '<org>'
  AND i.status IN ('draft', 'sent')
  AND c.quick_pay_rate IS NOT NULL
  AND i.total > 0
  AND i.paid_amount > 0
  AND i.paid_amount < i.total
  AND abs(i.paid_amount - (i.total * (1 - c.quick_pay_rate))) <= 0.02;

-- The reason goes on the LARGEST allocation — for an invoice settled by one
-- payment that is the payment, and for one settled by several it is the one
-- the fee was taken from.
UPDATE invoice_payments ip
SET variance_reason = 'quick_pay',
    note            = concat_ws(' · ', nullif(ip.note, ''),
                                'quick pay — backfilled 2026-08-06'),
    updated_at      = now()
FROM (
  SELECT DISTINCT ON (invoice_id) id, invoice_id
  FROM invoice_payments
  WHERE invoice_id IN (SELECT id FROM _quick_pay_invoices)
  ORDER BY invoice_id, amount DESC, created_at ASC
) pick
WHERE ip.id = pick.id
  AND ip.variance_reason IS NULL;

-- Same arithmetic recomputeInvoicePaid() applies, for the same reason as
-- the companion script: a bulk repair can't call the single writer, so it
-- reproduces it exactly. paid_amount is untouched — only the settlement
-- decision changes.
UPDATE invoices i
SET status     = 'paid',
    paid_at    = coalesce(i.paid_at,
                          (SELECT max(ip.paid_on)::timestamptz + interval '12 hours'
                           FROM invoice_payments ip WHERE ip.invoice_id = i.id)),
    updated_at = now()
WHERE i.id IN (SELECT id FROM _quick_pay_invoices);

COMMIT;

-- ── 3. VERIFY ────────────────────────────────────────────────────────
-- What is still open with money on it. Expect only the six outliers above.

SELECT c.name,
       i.invoice_number,
       i.total,
       i.paid_amount,
       round((1 - i.paid_amount / i.total)::numeric, 4) AS withheld
FROM invoices  i
JOIN customers c ON c.id = i.customer_id
WHERE i.org_id = '<org>'
  AND i.status IN ('draft', 'sent')
  AND i.paid_amount > 0
  AND i.paid_amount < i.total
ORDER BY withheld DESC;
