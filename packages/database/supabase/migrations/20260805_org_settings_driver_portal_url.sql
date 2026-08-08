-- 20260805_org_settings_driver_portal_url.sql
--
-- Per-org base URL for driver-facing links (paystubs today; other
-- driver-portal surfaces later).
--
-- WHY
-- ---
-- Paystub SMS links used to be minted from the API's global
-- PUBLIC_WEB_URL env var, so every carrier on the platform shared
-- one driver-facing domain. That works for a single-tenant setup and
-- falls apart the moment two orgs both want their own branded
-- portal (Curzon on curzontrucking.com, Freeway on freewaylogistics.com,
-- etc.). Config lives on the org, not on the process.
--
-- USE
-- ---
-- The paystub send endpoint reads org_settings.driver_portal_url and
-- falls back to PUBLIC_WEB_URL (which itself falls back to fleetcal.app).
-- Any org without an explicit value keeps getting fleetcal.app links —
-- no change until they're ready to serve /paystub/[token] on their own
-- domain.
--
-- Curzon set-up SQL after this lands:
--   update org_settings
--      set driver_portal_url = 'https://www.curzontrucking.com'
--    where org_id = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';

alter table org_settings
  add column if not exists driver_portal_url text;

-- Very light sanity check — must be an https URL when set. Not a full
-- URL parser; just enough to catch a typoed value that would 500 the
-- paystub send endpoint's string concat. Null passes.
alter table org_settings
  drop constraint if exists org_settings_driver_portal_url_check;
alter table org_settings
  add constraint org_settings_driver_portal_url_check
  check (driver_portal_url is null or driver_portal_url ~* '^https://[a-z0-9.-]+(:[0-9]+)?(/.*)?$');

notify pgrst, 'reload schema';
