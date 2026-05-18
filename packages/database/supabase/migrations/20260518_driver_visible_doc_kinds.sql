-- 20260518_driver_visible_doc_kinds.sql
--
-- Allow-list of document kinds that the driver app is permitted to
-- show. Stored as JSONB on org_settings so it sits alongside the
-- other per-org preferences and round-trips through the same
-- GET/PATCH /v1/org-settings flow.
--
-- Default: every kind EXCEPT `rate_con` and `invoice`. Both contain
-- broker/financial information drivers shouldn't see. Admins can
-- adjust the list in Settings → Driver App → Visible documents.
--
-- Semantics:
--   - NULL/missing in DB → server applies the default allow-list.
--   - Empty array        → drivers see no documents (admin choice).
--   - New kinds added in the future are HIDDEN by default; the admin
--     must explicitly opt them in via the settings UI.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS driver_visible_doc_kinds jsonb;

-- Backfill existing rows with the default allow-list so behavior is
-- explicit in the DB (no surprise when a future code change loosens
-- the in-server fallback).
UPDATE org_settings
   SET driver_visible_doc_kinds =
       '["pod","bol","scale","lumper","receipt","driver_sheet","relay_handoff","other"]'::jsonb
 WHERE driver_visible_doc_kinds IS NULL;
