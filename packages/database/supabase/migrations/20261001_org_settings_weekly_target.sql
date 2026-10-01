-- 20261001_org_settings_weekly_target.sql
--
-- Overrides for the dashboard's weekly-target calculator
-- (lib/weeklyTarget.ts). Every value the calculator uses is computed
-- from the org's own data; this column only stores what the user
-- chose to override, plus each expense bucket's cost behavior
-- (fixed / per_mile / revenue_pct / exclude). Null = all computed.

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS weekly_target_settings jsonb;
