-- 20260806_dedupe_double_applied.sql
--
-- DATA REPAIR. Run once. Safe to re-run (converges; a second run finds
-- nothing). Run this BEFORE 20260806_close_quick_pay_backlog.sql.
--
-- WHAT WENT WRONG
--
-- The same remittance was applied more than once, so invoices carry the
-- same money twice. On Curzon prod on 2026-08-06: 26 invoices, $13,249.90
-- of duplicate credit. Three ways it got through, all now fixed in code:
--
--  1. The re-upload guard asked "is this invoice status = paid?". A broker
--     paying 99% under a quick-pay agreement leaves the invoice at 'sent'
--     forever, so it never looked settled and a second upload re-applied
--     the whole amount. (Fixed: the parser now checks whether this exact
--     amount is already allocated, which doesn't depend on status.)
--
--  2. The document-level duplicate check ignored any remittance whose
--     reference was a generic word. A Redbone remittance printing "ACH"
--     was uploaded twice, sixty seconds apart, for the identical
--     $6,926.40, and nothing was compared at all. (Fixed: a useless
--     reference now falls back to customer + amount + date.)
--
--  3. Before the one-allocation-per-invoice fix, an itemised Uber
--     remittance wrote one allocation per CHARGE and the unique index on
--     (invoice_id, proof_id) rejected all but the first. Re-uploading then
--     added the correct grouped total on top of that orphan part-charge.
--
-- THE RULE
--
-- One allocation per payment per invoice. Two allocations belong to the
-- same payment when their proofs agree on customer, amount, date AND
-- reference, and both were hand-uploaded — that combination is not
-- something two genuinely distinct payments produce.
--
-- Of each such set, KEEP THE LARGEST. Not the earliest: for the Uber case
-- the later upload holds the complete grouped figure ($745.00) and the
-- earlier holds a stranded single charge ($95.00), so keeping the first
-- would preserve the broken record and delete the good one. Largest is
-- also right for the plain case, where the amounts are equal and the tie
-- breaks on created_at.
--
-- WHY THIS DOESN'T TOUCH BANK LINES
--
-- `source = 'upload'` is load-bearing. Plaid-imported proofs routinely
-- share a customer, amount and date — seven separate $500 payments landed
-- on 2026-04-09 — and they are distinguished only by their references.
-- An earlier draft of this repair grouped on customer+amount+date alone
-- and would have deleted twelve legitimate bank payments.
--
-- REVERSAL: none. Read the dry run first — it prints every row.

-- ── 1. DRY RUN — read this before running anything below ──────────────
-- Every allocation that will be deleted, and what each invoice becomes.

WITH payment_identity AS (
  SELECT ip.id, ip.invoice_id, ip.amount, ip.created_at,
         pp.customer_id, pp.amount AS proof_amount,
         pp.occurred_on, pp.reference
  FROM invoice_payments ip
  JOIN payment_proofs   pp ON pp.id = ip.proof_id
  WHERE pp.source = 'upload'
),
ranked AS (
  SELECT id, invoice_id, amount,
         row_number() OVER (
           PARTITION BY invoice_id, customer_id, proof_amount, occurred_on, reference
           ORDER BY amount DESC, created_at ASC
         ) AS keep_rank
  FROM payment_identity
)
SELECT i.invoice_number,
       i.total,
       i.paid_amount                        AS paid_now,
       round((i.paid_amount - sum(r.amount))::numeric, 2) AS paid_after,
       count(*)                             AS allocations_removed,
       round(sum(r.amount)::numeric, 2)     AS amount_removed
FROM ranked r
JOIN invoices i ON i.id = r.invoice_id
WHERE r.keep_rank > 1
GROUP BY i.invoice_number, i.total, i.paid_amount
ORDER BY amount_removed DESC;

-- Expected on Curzon prod: 26 invoices, $13,249.90 removed. Afterwards 6
-- land exactly on their total and 20 land on exactly 99% of it — those 20
-- are Triple T quick pay and are closed by the companion script.

-- ── 2. THE REPAIR ────────────────────────────────────────────────────

BEGIN;

CREATE TEMP TABLE _dupe_allocs ON COMMIT DROP AS
WITH payment_identity AS (
  SELECT ip.id, ip.invoice_id, ip.amount, ip.created_at,
         pp.customer_id, pp.amount AS proof_amount,
         pp.occurred_on, pp.reference
  FROM invoice_payments ip
  JOIN payment_proofs   pp ON pp.id = ip.proof_id
  WHERE pp.source = 'upload'
),
ranked AS (
  SELECT id, invoice_id,
         row_number() OVER (
           PARTITION BY invoice_id, customer_id, proof_amount, occurred_on, reference
           ORDER BY amount DESC, created_at ASC
         ) AS keep_rank
  FROM payment_identity
)
SELECT id, invoice_id FROM ranked WHERE keep_rank > 1;

DELETE FROM invoice_payments WHERE id IN (SELECT id FROM _dupe_allocs);

-- recomputeInvoicePaid() is normally the ONLY writer of these columns, and
-- that single-writer rule is what keeps the ledger and the summary from
-- drifting. A bulk repair can't call it, so it reproduces exactly the same
-- arithmetic here — sum the allocations, close when they cover the total —
-- and touches only the invoices this script changed.
UPDATE invoices i
SET paid_amount = s.applied,
    paid_at     = CASE WHEN s.applied >= i.total - 0.005 THEN i.paid_at END,
    status      = CASE
                    WHEN s.applied >= i.total - 0.005 THEN i.status
                    WHEN i.status = 'paid'            THEN 'sent'
                    ELSE i.status
                  END,
    updated_at  = now()
FROM (
  SELECT inv.id,
         round(coalesce(sum(ip.amount), 0)::numeric, 2) AS applied
  FROM (SELECT DISTINCT invoice_id AS id FROM _dupe_allocs) inv
  LEFT JOIN invoice_payments ip ON ip.invoice_id = inv.id
  GROUP BY inv.id
) s
WHERE i.id = s.id;

COMMIT;

-- ── 3. VERIFY ────────────────────────────────────────────────────────
-- Expect zero rows. Anything here is an invoice carrying more money than
-- it billed for a reason this script does not explain.

SELECT i.invoice_number, i.total, i.paid_amount,
       round((i.paid_amount - i.total)::numeric, 2) AS excess
FROM invoices i
WHERE i.org_id = '<org>'
  AND i.status <> 'void'
  AND i.paid_amount > i.total + 0.005
ORDER BY excess DESC;

-- On Curzon prod this leaves SIX rows, and they are a different problem:
-- a single allocation larger than the invoice it sits on, which means the
-- money was applied to the wrong invoice or the invoice was underbilled.
--
--   #13645    $415.00 billed, one $585.00 allocation  (Uber VNN46LZGX6R0B7O)
--   #13504    $450.00 billed, one $610.00 allocation  (Uber SUUFTHOWR0OGNVT)
--   #10937    $450.00 billed, $445.50 + $148.50 from two DIFFERENT Triple T
--             remittances (D0600152 and D0600234) — one of them belongs
--             on another invoice
--   #14823    $350.00 billed, one $445.50 allocation  (Triple T D0616806)
--   #10847    $475.00 billed, one $525.00 allocation  (ITS REMIT263165)
--   #11992  $1,200.00 billed, one $1,225.00 allocation (Ardent ACH2084)
--
-- Each needs a person to decide which invoice the money belongs to, so
-- none of them is touched here. Open the proof on each and compare against
-- the document.
