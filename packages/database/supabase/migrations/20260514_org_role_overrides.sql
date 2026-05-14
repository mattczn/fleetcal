-- Per-org overrides for the role → capability matrix.
--
-- Default capability sets live in @fleetcal/types/permissions (the
-- ROLE_CAPABILITIES export). This column lets an Admin override the
-- defaults on a per-role, per-capability basis — e.g. take
-- "dashboard.access" away from Dispatcher without touching code.
--
-- Shape:
--   { dispatcher: { 'dashboard.access': false },
--     maintenance: { 'fuel.access': true },
--     ... }
--
-- A key being PRESENT means there's an explicit override. ABSENT keys
-- fall back to the hardcoded default. This lets us distinguish
-- "explicitly revoked" from "never granted by default" so resetting
-- a role's overrides back to defaults is unambiguous.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS role_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN org_settings.role_overrides IS
  'Per-role capability overrides. Defaults live in @fleetcal/types/permissions.';
