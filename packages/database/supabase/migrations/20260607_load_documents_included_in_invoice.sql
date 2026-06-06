-- Per-document invoice inclusion flag.
--
-- Previously the dispatcher's "include in invoice" decisions lived in
-- a denormalized text[] on the loads row (loads.invoice_doc_ids).
-- That setup was fragile:
--   • every toggle wrote the whole array, so concurrent edits
--     clobbered each other
--   • a doc could be referenced even after deletion (no FK)
--   • the closeout review queue was auto-persisting on a 500ms
--     debounce; closing the queue mid-debounce dropped the write,
--     making it look like toggles "reverted on reopen"
--
-- The replacement is a per-doc boolean column. NULL means "not
-- explicitly set yet" (client falls back to the auto-include heuristic
-- for PODs uploaded near delivery time); TRUE / FALSE override that
-- with an explicit user choice. The client tracks pending changes
-- locally and PATCHes them on an explicit Save, so timing-based loss
-- is no longer possible.

ALTER TABLE load_documents
  ADD COLUMN IF NOT EXISTS included_in_invoice BOOLEAN DEFAULT NULL;

-- Backfill from the legacy array column: any doc whose id appears in
-- its load's invoice_doc_ids array gets included_in_invoice = TRUE.
-- Other docs stay NULL so the heuristic still applies on first view.
-- Safe to re-run — the AND included_in_invoice IS NULL guard prevents
-- overwriting any explicit writes already made.
UPDATE load_documents ld
SET included_in_invoice = TRUE
FROM loads l
WHERE ld.load_id = l.id
  AND ld.org_id  = l.org_id
  AND l.invoice_doc_ids IS NOT NULL
  AND ld.id = ANY(l.invoice_doc_ids)
  AND ld.included_in_invoice IS NULL;

-- loads.invoice_doc_ids is intentionally left in place for now:
--   • bot-loads and reports.ts still read it (legacy reporting)
--   • the invoice packet assembler falls back to it when no per-doc
--     row is set TRUE (handled in API code, not here)
-- A follow-up migration can drop the column after the read sites
-- migrate to the new field.
