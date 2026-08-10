-- 20260807_invoice_followups.sql
--
-- Flag an invoice for follow-up, and record a date the payer has promised.
-- Run once; safe to re-run.
--
-- Loads have carried flagged_reason / flagged_note / flagged_at / flagged_by
-- since 2026-05 and the pattern works, so this mirrors it rather than
-- inventing a second vocabulary for the same idea. An operator who has
-- flagged a load for a missing POD should recognise this immediately.
--
-- promised_pay_date is the new part, and it is deliberately NOT an aging
-- input. An invoice with a promise stays exactly as overdue as it was: the
-- 31+ bucket keeps meaning "this money is 31+ days late", not "…except the
-- ones someone said they'd pay". A promise is a claim by the party who has
-- already not paid; it belongs on the row as context, not in the arithmetic.
-- The Receivables filter surfaces them without removing them.
--
-- Nullable throughout. An unflagged invoice is the overwhelming majority and
-- carries five nulls, which costs nothing.
--
-- REVERSAL: drop the five columns. No other table references them.

BEGIN;

ALTER TABLE invoices
  -- Structured tag, so a list can be grouped and counted. Free text alone
  -- can't answer "how many are disputed".
  ADD COLUMN IF NOT EXISTS flagged_reason     text
    CHECK (flagged_reason IS NULL OR flagged_reason IN
      ('awaiting_payment','disputed','short_paid','missing_paperwork',
       'billing_error','collections','other')),
  -- What you're waiting on, who you spoke to, what they said.
  ADD COLUMN IF NOT EXISTS flagged_note       text,
  ADD COLUMN IF NOT EXISTS flagged_at         timestamptz,
  ADD COLUMN IF NOT EXISTS flagged_by         text,
  -- "They said it's processing on the 15th."
  ADD COLUMN IF NOT EXISTS promised_pay_date  date;

-- The working query is "show me what I'm chasing" — a small slice of a large
-- table, so a partial index keeps it off the whole invoice book.
CREATE INDEX IF NOT EXISTS invoices_flagged_idx
  ON invoices (org_id, flagged_at DESC)
  WHERE flagged_at IS NOT NULL;

-- "What did someone promise, and has that date passed" — the other half of
-- the follow-up list, and the one that catches a promise that came and went.
CREATE INDEX IF NOT EXISTS invoices_promised_idx
  ON invoices (org_id, promised_pay_date)
  WHERE promised_pay_date IS NOT NULL;

COMMENT ON COLUMN invoices.promised_pay_date IS
  'Date the payer said the money would be sent. Context only — never an '
  'input to aging, because a promise from someone who has not paid is not '
  'evidence that the invoice is less late than it is.';

COMMIT;

-- Expect 0 / 0 on a fresh run.
SELECT count(*) FILTER (WHERE flagged_at IS NOT NULL)        AS flagged,
       count(*) FILTER (WHERE promised_pay_date IS NOT NULL) AS promised
FROM invoices;
