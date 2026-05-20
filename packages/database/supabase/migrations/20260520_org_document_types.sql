-- 20260520_org_document_types.sql
--
-- Richer document-type configuration per org. Supersedes the
-- driver_visible_doc_kinds JSONB allow-list with a per-type record
-- carrying TWO flags:
--   - enabled        — does this org use this document type at all?
--                     (uncheck to remove from kind pickers across web,
--                     dispatch, and driver apps)
--   - driver_visible — does the driver app surface this kind to drivers?
--                     (false for confidential dispatcher-only kinds)
--
-- The canonical type list is DOCUMENT_KINDS in packages/types/api.ts.
-- Backfill rules per org:
--   - enabled        = true for every kind (admins opt out, not in)
--   - driver_visible:
--       * rate_con / invoice → ALWAYS false (hard policy; the API
--         rejects PATCHes that try to flip these true)
--       * other kinds → mirror legacy driver_visible_doc_kinds when
--         the column is set; default allow-list otherwise.
--
-- driver_visible_doc_kinds is kept for one release as a fallback so
-- code paths that haven't switched over yet keep working. Drop in a
-- follow-up migration once all readers are on document_types.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS document_types jsonb;

UPDATE org_settings AS o
   SET document_types = (
     SELECT jsonb_agg(
       jsonb_build_object(
         'kind',           k.kind,
         'enabled',        true,
         'driver_visible',
           CASE
             WHEN k.kind IN ('rate_con', 'invoice')        THEN false
             WHEN o.driver_visible_doc_kinds IS NULL       THEN (k.kind NOT IN ('rate_con', 'invoice'))
             WHEN o.driver_visible_doc_kinds ? k.kind      THEN true
             ELSE false
           END
       )
     )
     FROM jsonb_array_elements_text('[
       "rate_con","pod","bol","scale","lumper","receipt",
       "driver_sheet","invoice","relay_handoff","other"
     ]'::jsonb) AS k(kind)
   )
 WHERE o.document_types IS NULL;
