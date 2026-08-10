-- 20260807_resync_invoice_customer.sql
--
-- DATA FIX. Run once, any time. Safe to re-run (idempotent).
--
-- WHAT DRIFTED
--
-- invoices.customer_id is denormalised from the load when the invoice is
-- created, and nothing ever re-synced it. PATCH /v1/loads/:id happily wrote
-- loads.customer_id and left the invoice pointing at the old customer.
--
-- Receivables groups by the INVOICE's customer, so correcting a mis-filed
-- load moved the load and left its invoice behind — visible on Curzon as
-- invoice #11464 (load 1000979, Austin CO → West Valley City UT) sitting in
-- Lighthouse Recycling's ledger while its load correctly read Go Lighthouse.
-- There was no screen that could shift it.
--
-- The code path is fixed as of this commit: the load PATCH now re-points its
-- non-void invoices. That only governs future edits, so this catches the
-- rows that already drifted.
--
-- WHY VOID IS EXCLUDED
--
-- Voiding is an accounting decision that outranks a data correction. A void
-- invoice is expected to still say what it said when it was voided.
--
-- Allocations need nothing: invoice_payments keys on invoice_id, so the
-- money and its proofs follow the invoice.
--
-- REVERSAL: none, and none is wanted — the load is the authority on who was
-- hauled for. If a specific invoice was deliberately billed to a different
-- entity than the load records, fix the LOAD, and the code will now carry
-- the invoice with it.

-- ── 1. DRY RUN — every row this will move, before it moves ───────────

SELECT i.invoice_number,
       i.status,
       i.total,
       l.load_num,
       ci.name AS invoice_says,
       cl.name AS load_says
FROM invoices i
JOIN loads l      ON l.id  = i.load_id
LEFT JOIN customers ci ON ci.id = i.customer_id
LEFT JOIN customers cl ON cl.id = l.customer_id
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status <> 'void'
  AND i.customer_id IS DISTINCT FROM l.customer_id
ORDER BY i.invoice_number;

-- Expected on Curzon prod: ONE row — #11464, invoice says Lighthouse
-- Recycling, load says Go Lighthouse.

-- ── 2. THE FIX ───────────────────────────────────────────────────────

BEGIN;

UPDATE invoices i
SET customer_id = l.customer_id,
    updated_at  = now()
FROM loads l
WHERE l.id = i.load_id
  AND i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status <> 'void'
  AND i.customer_id IS DISTINCT FROM l.customer_id;

COMMIT;

-- ── 3. VERIFY ────────────────────────────────────────────────────────
-- Expect 0. Anything left is a void invoice, deliberately untouched.

SELECT count(*) AS still_drifted
FROM invoices i
JOIN loads l ON l.id = i.load_id
WHERE i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status <> 'void'
  AND i.customer_id IS DISTINCT FROM l.customer_id;

-- Worth knowing: this fixes the rows that exist and the API now keeps them
-- in step, but nothing CONSTRAINS them. If drift reappears, the durable
-- answer is to stop storing invoices.customer_id at all and read it through
-- the load — it is a denormalisation with exactly one writer's worth of
-- value and two writers' worth of risk.
