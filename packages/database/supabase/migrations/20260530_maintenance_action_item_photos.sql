-- Photos attached directly to a maintenance_action_items row.
--
-- Until now the only photos on a work order were inherited from the
-- linked driver report (when the work order was created via /convert).
-- This table lets dispatchers attach NEW photos to ANY work order —
-- regardless of whether it came from a report — for "after the
-- repair" evidence, parts receipts, before/after photos for the
-- carrier's records, etc.
--
-- Shape mirrors maintenance_report_photos so the API + UI can render
-- both with the same code path. We reuse the existing
-- 'maintenance-photos' Supabase Storage bucket; storage_paths for
-- this table live under "<org>/action_items/<item-id>/..." so they
-- can't collide with report uploads ("<org>/<report-id>/...").
--
-- ON DELETE CASCADE on the parent so deleting a work order also
-- cleans up its photos (rows in this table; the storage bucket
-- cleanup happens in the API delete handler).

CREATE TABLE IF NOT EXISTS maintenance_action_item_photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_item_id  uuid NOT NULL REFERENCES maintenance_action_items(id) ON DELETE CASCADE,
  org_id          text NOT NULL,
  storage_path    text NOT NULL,
  file_name       text NOT NULL,
  mime_type       text,
  size_bytes      integer,
  /** Clerk user_id of the dispatcher who uploaded — for audit. The
   *  resolved display name isn't stored here; we render via the
   *  same Clerk lookup the *_by_name columns use if ever shown. */
  uploaded_by     text,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maintenance_action_item_photos_item_idx
  ON maintenance_action_item_photos (action_item_id);

-- Tell PostgREST to refresh its schema cache so the new table is
-- queryable immediately after this migration runs.
NOTIFY pgrst, 'reload schema';
