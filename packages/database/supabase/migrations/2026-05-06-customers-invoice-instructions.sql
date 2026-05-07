-- Free-form invoice/billing instructions per broker. Surfaced on the
-- customer record so dispatchers know how to bill (portal, email,
-- required docs, payment terms) without re-reading the rate-con. The
-- two-pass rate-con parser auto-fills this on first capture.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS invoice_instructions text;
