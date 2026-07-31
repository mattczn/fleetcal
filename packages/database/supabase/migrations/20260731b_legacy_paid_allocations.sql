-- 20260731b_legacy_paid_allocations.sql
--
-- ONE-OFF DATA FIX. Two rows. Run once, any time.
--
-- Two invoices were marked paid through the old mark-paid path, before
-- it was rewired to write the allocation ledger. They carry paid_at but
-- no invoice_payments row and a NULL paid_amount.
--
-- That combination is a trap rather than cosmetic: paid_amount/paid_at
-- are DERIVED from the ledger by recomputeInvoicePaid(), so the next
-- write that touches either invoice recomputes applied = 0, decides it
-- isn't settled, and silently flips it back to 'sent'. Nobody would
-- connect the cause to the effect.
--
-- Found by auditing after the Alvys backfill: 531 paid invoices, 529
-- with allocations, 2 without. The backfill itself is clean — these two
-- predate it.
--
-- Their real payment date is known (paid_at, 2026-06-06), so the
-- allocation uses it. paid_at is then normalised to that date at 12:00Z
-- because that is precisely what recompute produces, which makes the
-- first later recompute a no-op instead of a silent 9-hour shift.
--
-- REVERSAL:
--   DELETE FROM invoice_payments WHERE created_by = 'system:legacy-paid-fix';
--   -- (paid_amount/paid_at are then whatever recompute next derives)

BEGIN;

INSERT INTO invoice_payments (
  org_id, invoice_id, proof_id, amount, paid_on, method, note, created_by
)
SELECT
  i.org_id,
  i.id,
  NULL,                                       -- no evidence on file; say so
  i.total,
  (i.paid_at AT TIME ZONE 'UTC')::date,
  NULL,
  'Marked paid before the allocation ledger existed; reconstructed from paid_at',
  'system:legacy-paid-fix'
FROM invoices i
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status = 'paid'
  AND i.paid_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id);

UPDATE invoices i
SET paid_amount = p.amount,
    paid_at     = ((p.paid_on::text || 'T12:00:00Z')::timestamptz)
FROM invoice_payments p
WHERE p.invoice_id = i.id
  AND p.created_by = 'system:legacy-paid-fix';

COMMIT;

-- Expect: 2 rows, $2,835.83. After this, every paid invoice in the org
-- is backed by the ledger and no recompute can un-pay one.
SELECT count(*) AS fixed, round(sum(amount)::numeric, 2) AS amount
FROM invoice_payments
WHERE created_by = 'system:legacy-paid-fix';
