-- ============================================================
-- Invoices
--
-- An invoice is a billable artifact tied to one load. We snapshot the
-- rendered fields (company info, line items, stops, etc.) at issue
-- time so changes to org_settings or the load after the fact don't
-- silently mutate sent invoices — the document the broker received
-- always matches what's in the row.
--
-- Status lifecycle:
--   draft   → just generated, not yet sent
--   sent    → emailed / submitted to a portal
--   paid    → marked paid by accounting
--   void    → cancelled before send (no money changed hands)
--
-- Numbering: defaults to the load's internal_load_id (with optional
-- prefix from org_settings.invoice_settings.invoice_number_prefix).
-- We store the final string so subsequent generators don't have to
-- recompute it.
--
-- One open invoice per load: we enforce that at most ONE non-void
-- invoice exists per (org_id, load_id) via a partial unique index.
-- A void can be re-issued.
-- ============================================================

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text NOT NULL,
  load_id         uuid NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,

  invoice_number  text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'sent', 'paid', 'void')),

  -- Totals in whole dollars (matches load_price's float8 elsewhere).
  -- Stored separately from the snapshot for cheap aggregate queries
  -- (open AR, age buckets, etc.).
  total           double precision NOT NULL DEFAULT 0,

  issued_at       timestamptz NOT NULL DEFAULT now(),
  due_at          timestamptz,

  -- Full rendered payload. Keeps the broker's-eye-view stable even
  -- when org_settings or the load mutate later. Shape mirrors
  -- InvoiceSnapshot in packages/types/domain.ts.
  snapshot        jsonb NOT NULL,

  -- Send tracking. Set when status flips to 'sent'.
  sent_at         timestamptz,
  sent_to         text,                  -- email or portal name actually used
  sent_method     text,                  -- 'email' | 'portal' | 'manual'

  paid_at         timestamptz,
  paid_amount     double precision,
  paid_method     text,                  -- 'ach' | 'check' | 'wire' | 'other'
  paid_note       text,

  void_reason     text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_invoices_org           ON invoices(org_id);
CREATE INDEX idx_invoices_org_status    ON invoices(org_id, status);
CREATE INDEX idx_invoices_load          ON invoices(load_id);
CREATE INDEX idx_invoices_customer      ON invoices(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_invoices_org_issued    ON invoices(org_id, issued_at DESC);

-- One open invoice per load. Void invoices are excluded so a load
-- can be re-invoiced after a void.
CREATE UNIQUE INDEX idx_invoices_load_active
  ON invoices(org_id, load_id)
  WHERE status <> 'void';

-- Invoice number must be unique within an org regardless of status —
-- the broker is looking up "invoice #1002036" and there can only be
-- one of those. Void invoices keep their number reserved.
CREATE UNIQUE INDEX idx_invoices_number_per_org
  ON invoices(org_id, invoice_number);
