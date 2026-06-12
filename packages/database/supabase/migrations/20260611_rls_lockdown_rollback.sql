-- ============================================================================
-- 20260611_rls_lockdown_rollback.sql  — undo 20260611_rls_lockdown.sql
--
-- Run ONLY if a specific screen breaks after the lockdown (a list goes empty
-- / a save fails). It restores the prior, looser state so the app works while
-- you investigate. ⚠️ It re-opens cross-tenant access on the affected tables —
-- bridge only, re-apply the lockdown once the offending screen is fixed.
--
-- Org-scoping is already proven on loads/stops, so wholesale breakage is not
-- expected; if one table misbehaves you can roll back just that table by
-- copying the matching pair of statements rather than the whole file.
-- ============================================================================

-- Restore permissive policies on the {public:true} tables
DROP POLICY IF EXISTS "events_org_rw"  ON public.events;
CREATE POLICY "events_org_scope" ON public.events
  FOR ALL TO authenticated USING ((auth.jwt() ->> 'org_id') = org_id);
CREATE POLICY "org_access" ON public.events FOR ALL USING (true);

DROP POLICY IF EXISTS "assets_org_rw" ON public.assets;
CREATE POLICY "org_access" ON public.assets FOR ALL USING (true);

DROP POLICY IF EXISTS "drivers_org_rw" ON public.drivers;
CREATE POLICY "org_access" ON public.drivers FOR ALL USING (true);

DROP POLICY IF EXISTS "driver_asset_prefs_org_rw" ON public.driver_asset_prefs;
CREATE POLICY "org_access" ON public.driver_asset_prefs FOR ALL USING (true);

DROP POLICY IF EXISTS "org_settings_org_rw" ON public.org_settings;
CREATE POLICY "org_settings_access" ON public.org_settings FOR ALL USING (true);

-- Disable RLS again on the tables that had it off
DROP POLICY IF EXISTS "customers_org_rw"           ON public.customers;
ALTER TABLE public.customers           DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "saved_locations_org_rw"     ON public.saved_locations;
ALTER TABLE public.saved_locations     DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_adjustments_org_rw" ON public.payroll_adjustments;
ALTER TABLE public.payroll_adjustments DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payroll_records_org_rw"     ON public.payroll_records;
ALTER TABLE public.payroll_records     DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "trailers_org_rw"            ON public.trailers;
ALTER TABLE public.trailers            DISABLE ROW LEVEL SECURITY;

-- driver_push_tokens: restore anon grant + disable RLS (prior state)
DROP POLICY IF EXISTS "driver_push_tokens_org_rw" ON public.driver_push_tokens;
ALTER TABLE public.driver_push_tokens DISABLE ROW LEVEL SECURITY;
GRANT ALL ON public.driver_push_tokens TO anon;

-- Telemetry tables back to RLS-off
ALTER TABLE public.ai_usage_logs    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_monthly DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_errors       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_runs        DISABLE ROW LEVEL SECURITY;
-- ============================================================================
