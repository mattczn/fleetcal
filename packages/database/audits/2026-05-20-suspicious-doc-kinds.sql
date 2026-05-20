-- 2026-05-20-suspicious-doc-kinds.sql
--
-- Audit query: find load_documents rows whose file_name suggests they
-- should be classified as rate_con (or invoice) but whose `kind` is
-- something driver-visible. These are the misclassification leaks the
-- security audit flagged — a dispatcher uploaded a rate con but clicked
-- the wrong button in the kind picker (or the pre-Phase-4.1 merge logic
-- inherited the wrong kind), so the file now surfaces to drivers via
-- the driver-visible filter.
--
-- This is READ-ONLY. Run it in Supabase SQL editor; review the results;
-- decide on a per-row basis whether to:
--   - PATCH /v1/documents/:id with the correct kind (the editor in the
--     web docs panel works for one-off fixes)
--   - Delete the document if it shouldn't exist at all
--   - Leave it (false positive — filename mentions rate-con but it's
--     legitimately a different doc, e.g. a POD that referenced a load
--     number that happened to contain "RC")
--
-- The regex matches:
--   - "rate con", "rate-con", "rate_con", "ratecon"
--   - "rate confirmation"
--   - "RC_", "RC-", "RC.pdf", " RC" (word boundary)
--   - "invoice" (for the invoice variant)

-- 1) Likely rate cons mis-classified
SELECT
  d.id,
  d.org_id,
  l.load_num,
  d.kind,
  d.file_name,
  d.uploaded_at,
  d.uploaded_by_driver_id IS NOT NULL AS uploaded_by_driver
FROM load_documents d
LEFT JOIN loads l ON l.id = d.load_id
WHERE d.kind <> 'rate_con'
  AND (
    d.file_name ~* '(rate.?con|rate.?confirmation)'
    OR d.file_name ~* '(^|[^A-Za-z])RC[._\-]'
  )
ORDER BY d.uploaded_at DESC;

-- 2) Likely invoices mis-classified (driver-visible invoice contents)
SELECT
  d.id,
  d.org_id,
  l.load_num,
  d.kind,
  d.file_name,
  d.uploaded_at
FROM load_documents d
LEFT JOIN loads l ON l.id = d.load_id
WHERE d.kind NOT IN ('invoice', 'rate_con')
  AND d.file_name ~* 'invoice'
ORDER BY d.uploaded_at DESC;

-- 3) Sanity check — driver-uploaded rows that somehow ended up with
--    a dispatcher-only kind. Should be empty after Phase 1's server-
--    side validation lands; non-zero result means historical bad data.
SELECT
  d.id,
  d.org_id,
  d.kind,
  d.file_name,
  d.uploaded_by_driver_id,
  d.uploaded_at
FROM load_documents d
WHERE d.uploaded_by_driver_id IS NOT NULL
  AND d.kind IN ('rate_con', 'invoice', 'driver_sheet')
ORDER BY d.uploaded_at DESC;
