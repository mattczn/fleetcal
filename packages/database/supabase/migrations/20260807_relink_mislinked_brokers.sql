-- 20260807_relink_mislinked_brokers.sql
--
-- DATA FIX. Run once. Safe to re-run. Run AFTER
-- 20260807_resync_invoice_customer.sql.
--
-- WHAT WENT WRONG
--
-- loads.broker is free text that predates loads.customer_id, and nothing
-- ever required the two to agree. An audit of all 4,383 linked live loads
-- on Curzon found 695 where they disagree:
--
--   672  spelling variants of the same outfit ("Uber Freight" vs
--        "Uber Freight LLC", "Lighthouse" vs "Lighthouse Recycling").
--        Cosmetic; the link is right. Normalised in section 3.
--
--    17  the text names a DIFFERENT COMPANY from the link. $30,806 of
--        revenue attributed to the wrong broker. These are section 2, and
--        they are the reason this file exists.
--
-- Confirmed by Matt on 2026-08-07: PT is not Titan Concepts, Loop is not
-- TransLoop, and Blue Grace is not Capacity Express. (TCI Global IS Titan
-- Concepts — that pair is a completed merge and is left alone.)
--
-- Every affected invoice is already PAID, so re-linking moves settled
-- revenue between customers. Allocations need no attention — they key on
-- invoice_id, so the money and its proofs follow the invoice, and the
-- invoice follows the load.
--
-- The code path is fixed as of this commit: a load linked to a customer now
-- takes its broker text FROM that customer, so a label and a link for the
-- same fact can no longer drift.

-- ── 1. DRY RUN ───────────────────────────────────────────────────────

SELECT l.broker            AS text_says,
       c.name              AS linked_to,
       count(*)            AS loads,
       sum(l.load_price)   AS value
FROM loads l
JOIN customers c ON c.id = l.customer_id
WHERE l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.broker IN ('PT', 'loop', 'Blue Grace')
GROUP BY 1, 2
ORDER BY loads DESC;

-- Expected: PT ⇒ Titan Concepts (15, $22,856); PT ⇒ PT Brokers (4, already
-- correct); loop ⇒ TransLoop (1); Blue Grace ⇒ Capacity Express (1).

-- ── 2. RE-LINK ───────────────────────────────────────────────────────

BEGIN;

-- 2a. PT → PT Brokers. The customer already existed; 4 loads were on it and
--     15 were not. Targeted by broker text AND current (wrong) link so the
--     4 correct ones are untouched and a re-run is a no-op.
UPDATE loads
SET customer_id = '266c3ff4-d43e-4d32-9a49-aeed1ebed305',   -- PT Brokers
    broker      = 'PT Brokers',
    updated_at  = now()
WHERE org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND deleted_at IS NULL
  AND broker = 'PT'
  AND customer_id = '80c55151-dfdf-4755-a638-43664dd22527'; -- Titan Concepts

-- 2b + 2c. Loop and Blue Grace have NO customer record — there is nothing
--     to link them to, and inventing a broker record is Matt's call, not a
--     script's. Create the customer in the UI, then run the matching block.
--
--     Loop  — load 150108, internal 14522, $1,600, invoice #14522 paid
--     UPDATE loads SET customer_id = '<new Loop id>', broker = 'Loop',
--            updated_at = now()
--     WHERE org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN' AND load_num = '150108';
--
--     Blue Grace — load BG1072739525, internal 14369, $900, invoice #14369 paid
--     UPDATE loads SET customer_id = '<new BlueGrace id>', broker = 'BlueGrace',
--            updated_at = now()
--     WHERE org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN' AND load_num = 'BG1072739525';

-- Carry the invoices with their loads. Same rule the API now applies on
-- every load edit; repeated here because this script bypasses the API.
UPDATE invoices i
SET customer_id = l.customer_id,
    updated_at  = now()
FROM loads l
WHERE l.id = i.load_id
  AND i.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND i.status <> 'void'
  AND i.customer_id IS DISTINCT FROM l.customer_id;

COMMIT;

-- ── 3. NORMALISE THE 672 SPELLING VARIANTS ───────────────────────────
--
-- Run only after section 2. This rewrites broker text to the linked
-- customer's name wherever they merely differ in spelling — which, once
-- the genuine mismatches above are re-linked, is all that remains.
--
-- Deliberately SEPARATE from section 2: had this run first it would have
-- overwritten "PT" with "TITAN CONCEPTS INTERNATIONAL, LLC" and destroyed
-- the only evidence that those 15 loads were mis-linked at all. The
-- disagreeing text was the bug report.

BEGIN;

UPDATE loads l
SET broker     = c.name,
    updated_at = now()
FROM customers c
WHERE c.id = l.customer_id
  AND l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.broker IS DISTINCT FROM c.name;

COMMIT;

-- ── 4. VERIFY ────────────────────────────────────────────────────────
-- Expect 0 once Loop and Blue Grace have been given customer records.

SELECT l.broker, c.name AS linked_to, count(*)
FROM loads l
JOIN customers c ON c.id = l.customer_id
WHERE l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.broker IS DISTINCT FROM c.name
GROUP BY 1, 2;

-- Unlinked loads are NOT covered by any of this and keep their free text —
-- 154 on Curzon. That is the case the column legitimately exists for.
