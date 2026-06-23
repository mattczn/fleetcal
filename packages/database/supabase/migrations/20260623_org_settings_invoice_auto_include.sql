-- Invoice-packet auto-include doc kinds.
--
-- JSONB array of DocumentKind strings (e.g. '["pod","bol"]') listing which
-- document kinds are automatically bundled into an invoice packet when the
-- dispatcher hasn't explicitly toggled a doc on/off. Explicit per-doc
-- choices (load_documents.included_in_invoice = true/false) always win;
-- this only governs the untouched (null) default.
--
-- Default '["pod"]' keeps PODs auto-attached (brokers require proof of
-- delivery) while every other kind — BOL, scale, fuel receipt, lumper,
-- driver sheet — becomes explicit opt-in. This closes the gap where an
-- untouched fuel receipt rode along to a broker even though the closeout
-- screen showed it as excluded.
--
-- Consumed by the SINGLE shared selection rule isDocIncludedInPacket
-- (@fleetcal/types invoicePacket.ts), used by both the closeout UI and the
-- server packet builder (resolvePacketDocsForLoad) so "selected" always
-- equals "included".

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS invoice_auto_include_kinds jsonb NOT NULL
    DEFAULT '["pod"]'::jsonb;
