-- ============================================================================
-- 20260611_rls_lockdown.sql  (FleetCal project: vgybqmvmorjhlgbsssmi)
--
-- Closes cross-tenant access on the FleetCal database. Verified state
-- (pg_class.relrowsecurity + pg_policies, 2026-06-11): most tables are
-- already correct (RLS on, either org-scoped or service-role-only), but a
-- set of tables either carry a permissive `{public: true}` policy or have
-- RLS OFF entirely. Because the `authenticated` Postgres role holds table
-- grants on everything, those tables are readable/writable by ANY logged-in
-- user across ALL orgs — a problem once public signup is open.
--
-- This migration ONLY touches the broken tables. It uses the exact
-- org-scoped pattern already live & working on loads/stops/load_documents/
-- check_calls:  TO authenticated USING ((auth.jwt() ->> 'org_id') = org_id).
-- The API + Next server routes use the service-role key (BYPASSRLS) and are
-- unaffected.
--
-- BROWSER DIRECT ACCESS (verified in code) that must keep working:
--   events            — read (realtime) + write (useCalendarStore)
--   driver_push_tokens — read/write (lib/push.ts registers/prunes tokens)
--   loads/stops/load_documents/check_calls — read (realtime) [already scoped]
-- Everything else is mediated by the service-role API.
--
-- ROLLOUT: run in the SQL editor, then smoke-test as a signed-in user:
--   calendar loads + drag-save; trailers/assets/drivers/customers/saved
--   locations lists load; payroll page loads; settings page loads; and
--   (if you use push) a driver push token still registers. Org-scoping is
--   already proven on loads/stops, so a blank calendar is not expected —
--   but if anything goes empty, see 20260611_rls_lockdown_rollback.sql.
-- ============================================================================

-- ── 1. events — drop the leftover permissive policy, keep org scope ─────────
-- events already has events_org_scope {authenticated:org_id} AND a stray
-- org_access {public:true} (the permissive one wins). Replace both with one
-- canonical read+write org-scoped policy (browser does update/delete here).
DROP POLICY IF EXISTS "org_access"        ON public.events;
DROP POLICY IF EXISTS "events_org_scope"  ON public.events;
CREATE POLICY "events_org_rw" ON public.events
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ── 2. tables with a permissive {public:true} policy → org-scope them ───────
DROP POLICY IF EXISTS "org_access" ON public.assets;
CREATE POLICY "assets_org_rw" ON public.assets
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "org_access" ON public.drivers;
CREATE POLICY "drivers_org_rw" ON public.drivers
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "org_access" ON public.driver_asset_prefs;
CREATE POLICY "driver_asset_prefs_org_rw" ON public.driver_asset_prefs
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

DROP POLICY IF EXISTS "org_settings_access" ON public.org_settings;
CREATE POLICY "org_settings_org_rw" ON public.org_settings
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);
-- ^ FOLLOW-UP (post-launch, not a cross-tenant issue): org_settings holds
--   role_overrides. A FOR ALL policy lets a logged-in user write their OWN
--   org's settings directly, bypassing the API's capability checks (a
--   dispatcher could grant themselves caps within their org). Tighten to
--   FOR SELECT once you confirm the settings UI saves via the API, not the
--   browser supabase client. Same note applies to payroll_* below.

-- ── 3. tables with RLS OFF → enable + org-scope ─────────────────────────────
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customers_org_rw" ON public.customers
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

ALTER TABLE public.saved_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "saved_locations_org_rw" ON public.saved_locations
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

ALTER TABLE public.payroll_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payroll_adjustments_org_rw" ON public.payroll_adjustments
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

ALTER TABLE public.payroll_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payroll_records_org_rw" ON public.payroll_records
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- trailers: RLS is OFF and the 4 existing "org members can …" policies are
-- both inert (RLS off) AND use the wrong claim path (auth.jwt()->'o'->>'id',
-- the old nested form — this project uses the top-level org_id claim). Drop
-- them and replace with one correct policy.
ALTER TABLE public.trailers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "org members can select trailers" ON public.trailers;
DROP POLICY IF EXISTS "org members can insert trailers" ON public.trailers;
DROP POLICY IF EXISTS "org members can update trailers" ON public.trailers;
DROP POLICY IF EXISTS "org members can delete trailers" ON public.trailers;
CREATE POLICY "trailers_org_rw" ON public.trailers
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- driver_push_tokens: RLS OFF *and* the anon role has table grants → this is
-- the one ANONYMOUS hole (raw public key can read/write push tokens). Enable
-- RLS, revoke anon, org-scope. lib/push.ts writes these from the browser
-- with a Clerk org JWT, so the authenticated org-scoped policy covers it.
ALTER TABLE public.driver_push_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_push_tokens FROM anon;
CREATE POLICY "driver_push_tokens_org_rw" ON public.driver_push_tokens
  FOR ALL TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- ── 4. server-only telemetry with RLS OFF → lock (service-role only) ────────
-- The admin UI reads these via service-role server routes, never the browser.
-- RLS on + no policy = only the service-role key can touch them.
ALTER TABLE public.ai_usage_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_monthly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_errors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_runs        ENABLE ROW LEVEL SECURITY;

-- ── 5. revoke leftover anon grants (hygiene) ────────────────────────────────
-- These 5 are already RLS-locked (no policy), so the grants were inert, but
-- anon has no business holding them. driver_push_tokens handled above.
REVOKE ALL ON public.driver_evening_sweeps      FROM anon;
REVOKE ALL ON public.loads_internal_id_counters FROM anon;
REVOKE ALL ON public.motive_sync_state          FROM anon;
REVOKE ALL ON public.org_api_keys               FROM anon;
REVOKE ALL ON public.org_load_id_counters       FROM anon;

-- ── VERIFICATION (run after; all must hold) ─────────────────────────────────
-- No permissive {public:true} policies remain:
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname='public' AND qual='true';            -- expect 0 rows
-- No RLS-off tables remain in public:
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=false; -- 0
-- anon holds no table grants:
--   SELECT count(*) FROM information_schema.role_table_grants
--   WHERE table_schema='public' AND grantee='anon';        -- expect 0
-- ============================================================================
