-- 20260527_loads_document_counts.sql
--
-- Denormalize document counts onto loads.document_counts (jsonb).
-- Previously the calendar's "POD uploaded" icon was computed at read
-- time by joining load_documents to events:
--
--   GET /v1/loads / GET /v1/events/:id → load joined → SECOND query
--   for load_documents → aggregate by kind → attach to response
--
-- That worked when everything refetched cleanly, but the icon would
-- silently disappear when:
--   - Supabase realtime didn't deliver the load_documents change
--   - The second query was skipped on the relay partner leg
--   - The calendar store updated the event from a path that didn't
--     re-run the doc-count query (load updates, audit log writes, etc.)
--
-- Storing the counts ON the load row eliminates the join entirely.
-- Triggers keep them in sync — any insert/update/delete on
-- load_documents rebuilds the affected load's counts. The calendar
-- query becomes:
--
--   SELECT ..., document_counts FROM loads
--
-- and the icon is always correct because the count is part of the
-- same row everything else reads.

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS document_counts jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill from existing load_documents in one pass. Loads with no
-- documents stay at the default '{}'.
WITH agg AS (
  SELECT load_id,
         jsonb_object_agg(kind, n) AS counts
    FROM (
      SELECT load_id, kind, COUNT(*)::int AS n
        FROM load_documents
       WHERE load_id IS NOT NULL
       GROUP BY load_id, kind
    ) per_kind
   GROUP BY load_id
)
UPDATE loads l
   SET document_counts = agg.counts
  FROM agg
 WHERE l.id = agg.load_id;

-- ── Trigger function: rebuild document_counts for affected load(s)
--
-- INSERT  → recompute NEW.load_id
-- DELETE  → recompute OLD.load_id
-- UPDATE  → recompute NEW.load_id; if load_id changed, also recompute
--           OLD.load_id (doc moved between loads — rare but possible
--           via the dispatcher's "reassign document" flow)
--
-- Each recompute is a single SELECT + UPDATE on one row, so even a
-- bulk doc insert (10 PDFs at once) costs ~10ms per row in the
-- trigger. Acceptable at fleet scale.
CREATE OR REPLACE FUNCTION refresh_load_document_counts(p_load_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  new_counts jsonb;
BEGIN
  IF p_load_id IS NULL THEN RETURN; END IF;
  SELECT COALESCE(jsonb_object_agg(kind, cnt), '{}'::jsonb)
    INTO new_counts
    FROM (
      SELECT kind, COUNT(*)::int AS cnt
        FROM load_documents
       WHERE load_id = p_load_id
       GROUP BY kind
    ) per_kind;
  UPDATE loads SET document_counts = new_counts WHERE id = p_load_id;
END;
$$;

CREATE OR REPLACE FUNCTION trg_load_documents_refresh_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_load_document_counts(OLD.load_id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM refresh_load_document_counts(NEW.load_id);
  ELSE  -- UPDATE
    PERFORM refresh_load_document_counts(NEW.load_id);
    IF NEW.load_id IS DISTINCT FROM OLD.load_id THEN
      PERFORM refresh_load_document_counts(OLD.load_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS load_documents_refresh_counts ON load_documents;
CREATE TRIGGER load_documents_refresh_counts
AFTER INSERT OR UPDATE OR DELETE ON load_documents
FOR EACH ROW EXECUTE FUNCTION trg_load_documents_refresh_counts();

NOTIFY pgrst, 'reload schema';
