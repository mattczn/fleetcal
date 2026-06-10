-- ───────────────────────────────────────────────────────────────────
-- invoice_packet doc kind — split the existing "invoice" classification.
--
-- Before this change, every load_documents row tagged kind='invoice'
-- was actually the FULL packet (invoice + rate-con + POD + etc.). The
-- name was misleading and there was no way to also keep the bare
-- invoice PDF on the load. From this point forward:
--
--   kind='invoice'        → bare invoice PDF only
--   kind='invoice_packet' → the full merged broker-facing packet
--
-- This migration relabels historical rows so they keep the right
-- meaning. The file content doesn't change — only the classification.
-- Every existing kind='invoice' row was a packet (built by
-- persistInvoicePacket), so blanket-renaming them is correct.
-- ───────────────────────────────────────────────────────────────────

UPDATE load_documents
SET kind = 'invoice_packet'
WHERE kind = 'invoice';

-- Also relabel the per-org document-type config so settings panels and
-- driver-visibility helpers see the new kind. New orgs (no row) get
-- the default via the api.ts DEFAULT_DOCUMENT_TYPES list; existing
-- orgs need an in-place rewrite of the JSONB array.
--
-- Pattern: walk every org's document_types array, swap the kind
-- string on the row whose kind='invoice', and append a fresh
-- 'invoice_packet' row that mirrors the same enabled / driverVisible
-- flags. Idempotent — running twice produces no-op because the
-- WHERE filter requires an 'invoice' entry to exist.
UPDATE org_settings
SET document_types = (
  SELECT jsonb_agg(elem)
  FROM (
    SELECT jsonb_set(elem, '{kind}', '"invoice_packet"') AS elem
    FROM jsonb_array_elements(document_types) elem
    WHERE elem->>'kind' = 'invoice'
    UNION ALL
    SELECT elem
    FROM jsonb_array_elements(document_types) elem
    WHERE elem->>'kind' <> 'invoice'
    UNION ALL
    -- Add a fresh kind='invoice' row so the bare-invoice option exists.
    SELECT jsonb_build_object(
      'kind', 'invoice',
      'enabled', true,
      'driverVisible', false
    )
  ) sub
)
WHERE document_types @> '[{"kind":"invoice"}]'::jsonb;
