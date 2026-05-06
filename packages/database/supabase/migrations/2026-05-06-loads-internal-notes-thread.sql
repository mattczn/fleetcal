-- Convert the single internal_note field into a thread of pinned notes.
-- Each entry carries its own author + timestamp so dispatchers can leave
-- multiple notes over time and tell who wrote what.
--
-- Idempotent: re-add the legacy columns if they're missing so the backfill
-- compiles, then drop them once data is migrated.

ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note        text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note_author text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note_at     timestamptz;

ALTER TABLE loads
  ADD COLUMN IF NOT EXISTS internal_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE loads
SET internal_notes = jsonb_build_array(
  jsonb_build_object(
    'id',     gen_random_uuid()::text,
    'text',   internal_note,
    'author', internal_note_author,
    'at',     COALESCE(internal_note_at::text, updated_at::text)
  )
)
WHERE internal_note IS NOT NULL
  AND internal_note <> ''
  AND (internal_notes IS NULL OR internal_notes = '[]'::jsonb);

ALTER TABLE loads DROP COLUMN IF EXISTS internal_note;
ALTER TABLE loads DROP COLUMN IF EXISTS internal_note_author;
ALTER TABLE loads DROP COLUMN IF EXISTS internal_note_at;
