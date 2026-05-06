-- Per-broker parse hints. When a rate-con's broker matches a customer
-- (by name or alias), the customer's parse_hints get appended to the AI
-- prompt as a per-broker rule. Lets the org capture broker-specific
-- quirks ("Echo always puts the load # after 'Order:'") without bloating
-- the global prompt.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS parse_hints text;
