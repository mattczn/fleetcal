-- Org-scoped rate-con AI settings. Replaces the per-browser localStorage
-- where prompt variables, custom instructions, and field selection used
-- to live, so all dispatchers in the org share the same parse behavior.
--
-- One JSONB column for fast iteration on shape; if the schema settles
-- we can promote individual keys to columns later.
--
-- Expected shape:
--   {
--     "promptVariables": { "systemRole", "titleFormat", "specialInstructionsFormat", "timezone" },
--     "promptInstructions": "<freeform broker rules>",
--     "fieldSettings": { "<fieldId>": <bool> }
--   }

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS rate_con_settings jsonb NOT NULL DEFAULT '{}'::jsonb;
