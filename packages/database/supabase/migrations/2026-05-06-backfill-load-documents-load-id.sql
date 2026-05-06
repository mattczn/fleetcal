-- Backfill load_id on driver-uploaded documents.
--
-- The driver upload endpoint historically wrote only event_id on insert,
-- which meant docs uploaded after the loads/events split were unreachable
-- from the web's load-scoped GET /v1/loads/:id/documents query.
-- Endpoint is now fixed to set both columns; this catches existing rows.

UPDATE load_documents ld
SET load_id = e.load_id
FROM events e
WHERE ld.event_id = e.id
  AND ld.load_id IS NULL
  AND e.load_id IS NOT NULL;
