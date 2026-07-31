-- 20260731_alvys_invoice_backfill.sql
--
-- ONE-OFF DATA BACKFILL — not a schema change. Safe to run once.
--
-- Curzon invoiced through Alvys before FleetCal owned billing. Those
-- loads came across as `loads` rows with revenue and a billing_status,
-- but no `invoices` row was ever generated — so ~$1.97M of billed work
-- was invisible to Receivables, which reads the invoices table. This
-- reconstructs an invoice per load from what the load already knows.
--
-- The reconstruction, per Matt:
--   amount     = the load's billable total (the load amount IS the
--                invoiced amount for this era)
--   issued_at  = the load's own date, i.e. the pickup leg's start —
--                "assume the invoice was sent on the load date"
--   due_at     = issued + 30 days, so aging means something. Without a
--                due date every one of these buckets as "Current"
--                forever and a 2025 invoice reads as not-yet-due.
--   status     = paid where the load is already billing_status='paid',
--                otherwise sent
--
-- Paid ones also get an `invoice_payments` allocation. That is not
-- optional bookkeeping: invoices.paid_amount/paid_at are DERIVED from
-- the allocation ledger by recomputeInvoicePaid(), so a paid invoice
-- with no allocation is a live trap — the next write that touches it
-- recomputes applied=0 and silently flips it back to 'sent'. The
-- allocation is written so that a later recompute is a no-op:
-- paid_on = issued date, paid_at = that date at 12:00Z, method NULL,
-- which is exactly what recompute would produce.
--
-- Expected on a clean run against Curzon prod
-- (org_3Ck09w6LuEjiX4WgxJEPyiyjuXN), measured 2026-07-31:
--   invoices inserted     2560   $1,972,729.49
--     status=sent         2031   $1,635,928.71
--     status=paid          529     $336,800.78
--   allocations inserted   529     $336,800.78
--   invoices  1497 -> 4057
--   AR open   $1,149,624 -> $2,785,552.71
--   issued_at spans 2025-12-29 .. 2026-05-26
--
-- Known imperfections, accepted deliberately:
--   * 680 of these loads carry no customer_id, so their invoices group
--     under "No customer" on Receivables until a customer is attached.
--   * 2 loads have a zero/absent amount and are skipped — an invoice
--     for $0 is noise, not history.
--   * The snapshot is a reconstruction, not the document a broker
--     received. It is marked as such so nothing mistakes it for one.
--
-- REVERSAL — everything written here is tagged, so this undoes it whole.
-- Keep this to hand before running:
--
--   DELETE FROM invoice_payments WHERE created_by = 'system:alvys-backfill';
--   DELETE FROM invoices         WHERE snapshot->>'backfill' = 'alvys';
--
-- The inserts run inside a transaction so a mid-way failure leaves
-- nothing behind. The verification SELECT is deliberately AFTER the
-- COMMIT: the Supabase SQL editor only surfaces the final result set,
-- so a check-then-rollback inside the transaction would not actually be
-- visible in time to act on. Commit, read the numbers, and run the two
-- DELETEs above if they disagree with the expectations.

BEGIN;

-- ── Invoices ──────────────────────────────────────────────────────

INSERT INTO invoices (
  org_id, load_id, customer_id, invoice_number, status, total,
  issued_at, due_at, snapshot, sent_at, sent_method
)
SELECT
  l.org_id,
  l.id,
  l.customer_id,
  -- Same numbering rule the app uses: the load's internal id. Verified
  -- to collide with no existing invoice number and to be unique within
  -- this set, which the two unique indexes on invoices would enforce
  -- anyway.
  l.internal_load_id::text,
  CASE WHEN l.billing_status = 'paid' THEN 'paid' ELSE 'sent' END,
  COALESCE(l.total_billable, l.load_price, 0),
  pickup.issued_at,
  pickup.issued_at + interval '30 days',
  jsonb_build_object(
    'backfill',     'alvys',
    'backfillNote', 'Reconstructed from the load record. Invoiced in Alvys before FleetCal owned billing; this is not the document the broker received.',
    'loadNumber',   COALESCE(l.load_num, l.internal_load_id::text),
    'brokerName',   COALESCE(l.broker, ''),
    'pickupDate',   to_char(pickup.issued_at, 'YYYY-MM-DD'),
    'totalCharges', COALESCE(l.total_billable, l.load_price, 0),
    'balanceDue',   COALESCE(l.total_billable, l.load_price, 0),
    'stops',        '[]'::jsonb,
    'lineItems',    jsonb_build_array(jsonb_build_object(
                      'label',  'Linehaul',
                      'amount', COALESCE(l.total_billable, l.load_price, 0)
                    ))
  ),
  -- "Assume the invoice was sent on the load date."
  pickup.issued_at,
  'manual'
FROM loads l
CROSS JOIN LATERAL (
  -- Pickup leg = lowest leg_index. events.start is naive Mountain wall
  -- time (see schema.sql), so it needs the zone applied rather than
  -- being read as UTC — otherwise every date shifts by 6-7 hours and
  -- some land on the previous day.
  SELECT (e.start::timestamp AT TIME ZONE 'America/Denver') AS issued_at
  FROM events e
  WHERE e.load_id = l.id
  ORDER BY e.leg_index NULLS LAST, e.start
  LIMIT 1
) AS pickup
WHERE l.org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN'
  AND l.deleted_at IS NULL
  AND l.billing_status IN ('invoiced', 'paid')
  AND COALESCE(l.total_billable, l.load_price, 0) > 0
  -- Idempotent: re-running inserts nothing, and it never competes with
  -- an invoice the app generated.
  AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.load_id = l.id);

-- ── Allocations for the already-paid ones ─────────────────────────

INSERT INTO invoice_payments (
  org_id, invoice_id, proof_id, amount, paid_on, method, note, created_by
)
SELECT
  i.org_id,
  i.id,
  NULL,                       -- no evidence exists for these; that's honest
  i.total,
  (i.issued_at AT TIME ZONE 'UTC')::date,
  NULL,
  'Alvys-era payment, backfilled from the load record',
  'system:alvys-backfill'
FROM invoices i
WHERE i.snapshot->>'backfill' = 'alvys'
  AND i.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id
  );

-- Mirror the ledger onto the invoice summary columns, matching
-- recomputeInvoicePaid() exactly (paid_at = paid_on at 12:00Z, method
-- NULL) so the first later recompute is a no-op rather than a change.
UPDATE invoices i
SET paid_amount = p.amount,
    paid_at     = ((p.paid_on::text || 'T12:00:00Z')::timestamptz),
    paid_method = NULL
FROM invoice_payments p
WHERE p.invoice_id = i.id
  AND p.created_by = 'system:alvys-backfill'
  AND i.snapshot->>'backfill' = 'alvys';

-- ── Verify AFTER committing ───────────────────────────────────────
-- One result set, because the editor shows only the last one. Read it
-- against the expectations at the top of this file; if it disagrees,
-- run the two DELETEs from the REVERSAL block.

COMMIT;

SELECT
  (SELECT count(*)                                    FROM invoices WHERE snapshot->>'backfill' = 'alvys')                        AS invoices_inserted,
  (SELECT count(*)                                    FROM invoices WHERE snapshot->>'backfill' = 'alvys' AND status = 'sent')    AS status_sent,
  (SELECT count(*)                                    FROM invoices WHERE snapshot->>'backfill' = 'alvys' AND status = 'paid')    AS status_paid,
  (SELECT round(sum(total)::numeric, 2)               FROM invoices WHERE snapshot->>'backfill' = 'alvys')                        AS total_backfilled,
  (SELECT round(sum(total)::numeric, 2)               FROM invoices WHERE snapshot->>'backfill' = 'alvys' AND status = 'sent')    AS open_added,
  (SELECT count(*)                                    FROM invoices WHERE snapshot->>'backfill' = 'alvys' AND customer_id IS NULL) AS no_customer,
  (SELECT min(issued_at)::date                        FROM invoices WHERE snapshot->>'backfill' = 'alvys')                        AS earliest,
  (SELECT max(issued_at)::date                        FROM invoices WHERE snapshot->>'backfill' = 'alvys')                        AS latest,
  (SELECT count(*)                                    FROM invoice_payments WHERE created_by = 'system:alvys-backfill')           AS allocations_inserted,
  (SELECT round(sum(amount)::numeric, 2)              FROM invoice_payments WHERE created_by = 'system:alvys-backfill')           AS allocated;
