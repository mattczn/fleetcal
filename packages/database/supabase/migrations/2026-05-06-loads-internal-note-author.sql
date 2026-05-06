-- Stamp who left the pinned internal note and when, so dispatchers can
-- tell at a glance which teammate posted it.

ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note_author text;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS internal_note_at     timestamptz;
