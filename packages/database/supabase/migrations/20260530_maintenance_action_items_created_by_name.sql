-- Add resolved display-name columns for the audit columns on
-- maintenance_action_items.
--
-- Until now `created_by` and `completed_by` were stored as raw Clerk
-- user_ids (e.g. user_3Cgz7uSjL0IX359kSOh0PRIHq3b), which leaked into
-- the dispatcher UI's Activity panel as gibberish. The loads table
-- solved this with a sibling `created_by_name` column populated via
-- Clerk on insert (see apps/api/src/lib/clerk.ts getUserDisplayName).
-- We adopt the same pattern here so the audit log reads like
-- "Created May 27, 2026 by Matt Curzon" instead of a UUID-like blob.
--
-- We KEEP the original *_by columns (still NOT NULL on created_by)
-- so the user_id stays available for hard audit — name resolution is
-- a UI nicety, not the source of truth.

ALTER TABLE maintenance_action_items
  ADD COLUMN IF NOT EXISTS created_by_name   text,
  ADD COLUMN IF NOT EXISTS completed_by_name text;
