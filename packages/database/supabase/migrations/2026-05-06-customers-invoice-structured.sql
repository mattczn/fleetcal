-- Structured invoice routing per broker. Almost all of our customers
-- bill via either AP email or an online portal — capturing those as
-- discrete fields lets us auto-route invoices later instead of having
-- a dispatcher re-read free-form text.
--
-- invoice_instructions stays as the catch-all for additional billing
-- guidance (payment terms, required documents, factor preferences).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS invoice_method text;  -- 'email' | 'portal' | null
ALTER TABLE customers ADD COLUMN IF NOT EXISTS invoice_email  text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS invoice_portal text;  -- e.g. "TriumphPay (https://app.triumphpay.com)"
