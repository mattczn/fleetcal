-- 20260807_proof_kind_statement.sql
--
-- Adds 'statement' to payment_proofs.kind. Run once; safe to re-run.
--
-- WHY A NEW KIND RATHER THAN REUSING 'remittance'
--
-- A remittance advice is ONE payment covering one or more invoices: a
-- payer sent a specific sum on a specific day, and the proof stands for
-- that transfer.
--
-- A factoring or payment portal exports something different. ePayManager's
-- Receivables Report lists every transaction it has settled over a date
-- range — 104 loads and $55,400 in the file that prompted this — with no
-- payment date and no single transfer behind it. Those loads really were
-- paid, and the report is the only record the carrier gets, so it has to
-- be ingestible. But filing it as a remittance would assert that $55,400
-- arrived in one movement on one day. It didn't. Bank reconciliation would
-- then hunt for a deposit that never existed, and the duplicate guard —
-- which matches on customer, amount and date — would be comparing against
-- a payment that is not a payment.
--
-- So the evidence is recorded honestly for what it is: a statement that
-- these invoices were settled, carrying allocations like any other proof,
-- but never claiming to be a single transfer.
--
-- REVERSAL: re-run with the original four-value CHECK, after moving any
-- rows off the new kind:
--   UPDATE payment_proofs SET kind = 'other' WHERE kind = 'statement';

BEGIN;

ALTER TABLE payment_proofs DROP CONSTRAINT IF EXISTS payment_proofs_kind_check;

ALTER TABLE payment_proofs
  ADD CONSTRAINT payment_proofs_kind_check
  CHECK (kind IN ('remittance', 'statement', 'bank_transaction', 'check', 'other'));

COMMENT ON COLUMN payment_proofs.kind IS
  'remittance = one payment covering one or more invoices. '
  'statement = many settlements reported together with no single transfer '
  'behind them (a factoring portal export) — real evidence of payment, but '
  'not a transfer, so bank matching must skip it. '
  'bank_transaction / check / other as before.';

COMMIT;

-- Expect 0 rows: nothing should be mis-filed yet.
SELECT count(*) AS statements_so_far
FROM payment_proofs WHERE kind = 'statement';
