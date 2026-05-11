-- ============================================================
-- load_documents.invoice_id
--
-- When the API renders + persists the merged invoice packet PDF as a
-- load_documents row (kind='invoice'), we need a stable link from
-- that doc back to the invoice it represents. Without this column,
-- re-rendering the packet (e.g. on email send after a draft edit)
-- would either accumulate orphan rows or rely on fragile path-
-- matching to find the previous version.
--
-- ON DELETE SET NULL: if an invoice is hard-deleted, we keep the
-- archived PDF row as a history artifact — the broker still got that
-- file. We just orphan the link.
-- ============================================================

ALTER TABLE load_documents
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_load_documents_invoice
  ON load_documents(invoice_id) WHERE invoice_id IS NOT NULL;
