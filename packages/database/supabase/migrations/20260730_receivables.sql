-- 20260730_receivables.sql
--
-- Accounts receivable: recording that an invoice got paid, and the
-- evidence backing that claim.
--
-- Two tables, deliberately separate:
--
--   payment_proofs   — an artifact that proves money moved. A remittance
--                      advice PDF, a bank transaction line, a check
--                      image. Exists independently of any invoice.
--
--   invoice_payments — money applied TO a specific invoice. Optionally
--                      cites a proof. This is the ledger.
--
-- Why the split, when a `paid_amount` column already exists on invoices:
--
--   1. One proof covers many invoices. A broker ACHs $47,300 covering 14
--      loads; a remittance advice lists all 14 with a per-line amount.
--      That's ONE proof and 14 allocation rows, each carrying its own
--      amount. The predecessor system prorated the deposit across
--      invoices by size, which silently misstated every invoice whenever
--      the broker deducted (say) a lumper on one load out of the 14.
--      Here the per-invoice amount is entered, never derived.
--
--   2. One invoice takes many payments. Partial now, balance in three
--      weeks. A single matched_deposit_id FK cannot express that.
--
--   3. Proof arrives on its own schedule. You mark paid on Tuesday
--      because you saw the balance move; the remittance email lands
--      Thursday. Proof is nullable and attachable after the fact, and
--      the UI can show which "paid" rows are unbacked.
--
-- invoices.paid_amount / paid_at / status stay the fast-read summary
-- and are recomputed from the allocations by the API on every write —
-- see recomputeInvoicePaid() in apps/api/src/lib/invoicePayments.ts.
-- The ledger is the truth; those columns are the index.

-- ── payment_proofs ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_proofs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,

  -- What kind of evidence this is.
  --   remittance       = broker's payment advice (email body or PDF)
  --   bank_transaction = a credit line off a bank feed or statement
  --   check            = physical check / deposit slip
  --   other            = portal screenshot, factoring statement, etc.
  kind          text NOT NULL
                  CHECK (kind IN ('remittance','bank_transaction','check','other')),

  -- How it got into FleetCal. Round one is manual/upload only; csv and
  -- email are here so an ingest adapter can land rows without a
  -- migration. Adapters MUST set external_id for idempotency.
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','upload','csv','email','api')),

  -- Who paid. customer_id is the resolved link (nullable — evidence can
  -- arrive before anyone identifies the payer); payer_raw preserves the
  -- name exactly as it appeared on the ACH descriptor or remittance, which
  -- is what future alias-matching will train on.
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  payer_raw     text,

  occurred_on   date NOT NULL,          -- payment / deposit date
  amount        numeric(12,2) NOT NULL, -- total on the proof, not per-invoice
  reference     text,                   -- check no. / ACH trace / bank txn id

  -- Optional attachment, private bucket, signed-URL reads.
  storage_path  text,
  file_name     text,
  mime_type     text,
  size_bytes    integer,

  note          text,
  -- Verbatim provider payload for adapters, so a re-parse never needs
  -- to re-fetch upstream.
  raw           jsonb,

  -- Idempotency key for automated sources. NULL for hand-entered proofs
  -- (the partial unique index below only constrains non-null rows), so
  -- an operator can record two identical $500 checks on the same day.
  external_id   text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL           -- clerk user id
);

-- Re-running an importer over an overlapping window is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS payment_proofs_external_id_uniq
  ON payment_proofs (org_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Main list: newest evidence first.
CREATE INDEX IF NOT EXISTS payment_proofs_org_date_idx
  ON payment_proofs (org_id, occurred_on DESC);

-- Per-customer drill-in from the Receivables rail.
CREATE INDEX IF NOT EXISTS payment_proofs_customer_idx
  ON payment_proofs (org_id, customer_id, occurred_on DESC)
  WHERE customer_id IS NOT NULL;

-- ── invoice_payments ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  invoice_id    uuid NOT NULL REFERENCES invoices(id)       ON DELETE CASCADE,

  -- Nullable on purpose: "I know it's paid, I don't have the paperwork
  -- yet." ON DELETE SET NULL so deleting a mis-entered proof doesn't
  -- silently erase the payment record with it — the money still moved.
  proof_id      uuid     REFERENCES payment_proofs(id)      ON DELETE SET NULL,

  -- Applied to THIS invoice. Negative is legal: a clawback/chargeback
  -- against an invoice already settled.
  amount        numeric(12,2) NOT NULL,
  paid_on       date NOT NULL,
  method        text CHECK (method IN ('ach','check','wire','factoring','other')),

  -- Set when the applied amount doesn't equal the invoice total. Carried
  -- per-allocation, not per-invoice, because a short-pay is usually a
  -- deduction against one specific load in a multi-load payment.
  variance_reason text
                  CHECK (variance_reason IN
                    ('quick_pay','short_pay','deduction','overpayment','other')),

  note          text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL           -- clerk user id
);

-- Invoice detail drawer + the recompute read path.
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx
  ON invoice_payments (org_id, invoice_id, paid_on DESC);

-- "What did this proof cover?" — the reverse lookup.
CREATE INDEX IF NOT EXISTS invoice_payments_proof_idx
  ON invoice_payments (org_id, proof_id)
  WHERE proof_id IS NOT NULL;

-- Collections-over-time reporting.
CREATE INDEX IF NOT EXISTS invoice_payments_org_date_idx
  ON invoice_payments (org_id, paid_on DESC);

-- One allocation per (invoice, proof) pair. Applying the same proof to
-- the same invoice twice is a double-click or a re-run, never intent.
-- Unbacked allocations (proof_id NULL) are exempt — an invoice can take
-- several manual partial payments.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_invoice_proof_uniq
  ON invoice_payments (invoice_id, proof_id)
  WHERE proof_id IS NOT NULL;

-- ── Triggers ──────────────────────────────────────────────────────
-- set_updated_at() ships in an earlier migration.

-- Drop-then-create so the whole file is safe to re-run by hand in the
-- SQL editor (CREATE TRIGGER has no IF NOT EXISTS).

DROP TRIGGER IF EXISTS payment_proofs_updated_at ON payment_proofs;
CREATE TRIGGER payment_proofs_updated_at
  BEFORE UPDATE ON payment_proofs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS invoice_payments_updated_at ON invoice_payments;
CREATE TRIGGER invoice_payments_updated_at
  BEFORE UPDATE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────
-- Same org-scoped pattern as every other core table (see
-- 20260611_rls_lockdown.sql). auth.jwt()->>'org_id' comes from the
-- Clerk session token. The API writes with the service key and scopes
-- by org_id in every query; these policies cover direct client reads.

ALTER TABLE public.payment_proofs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_proofs_org_rw" ON public.payment_proofs;
CREATE POLICY "payment_proofs_org_rw" ON public.payment_proofs
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "invoice_payments_org_rw" ON public.invoice_payments;
CREATE POLICY "invoice_payments_org_rw" ON public.invoice_payments
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ── Storage ───────────────────────────────────────────────────────
-- Its own private bucket rather than load-documents: a remittance shows
-- broker rates (the same confidentiality argument that split out
-- rate-cons), and a proof spanning 14 loads doesn't belong to any single
-- load's document set.

INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-proofs', 'payment-proofs', false)
ON CONFLICT (id) DO NOTHING;
