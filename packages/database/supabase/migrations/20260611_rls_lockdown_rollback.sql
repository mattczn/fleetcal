-- ============================================================================
-- 20260611_rls_lockdown_rollback.sql
--
-- EMERGENCY ROLLBACK for 20260611_rls_lockdown.sql.
--
-- Run this ONLY if, immediately after applying the lockdown, signed-in
-- users get a blank calendar / failed event saves — which means the Clerk
-- "supabase" JWT template isn't delivering the `org_id` claim to Postgres,
-- so the org-scoped policies match nothing.
--
-- This restores the PRE-LOCKDOWN behavior (anon full access) so the app
-- works again while you fix the JWT template. ⚠️ It re-opens the breach —
-- treat it as a few-minutes bridge, not a resting state. Re-apply the
-- lockdown the moment the template is verified.
--
-- It does NOT perfectly recreate the dozens of legacy policy names; it
-- restores functional anon access via grants + one permissive policy per
-- browser table, which is enough to un-break the app.
-- ============================================================================

-- Restore broad grants the lockdown revoked.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

-- Drop the org-scoped policies we added.
DROP POLICY IF EXISTS "fleetcal_events_select"          ON public.events;
DROP POLICY IF EXISTS "fleetcal_events_write"           ON public.events;
DROP POLICY IF EXISTS "fleetcal_loads_select"           ON public.loads;
DROP POLICY IF EXISTS "fleetcal_stops_select"           ON public.stops;
DROP POLICY IF EXISTS "fleetcal_load_documents_select"  ON public.load_documents;
DROP POLICY IF EXISTS "fleetcal_check_calls_select"     ON public.check_calls;
DROP POLICY IF EXISTS "fleetcal_ratecons_rw"            ON storage.objects;

-- Re-open the browser tables with permissive policies (matches old state).
CREATE POLICY "public read events"  ON public.events FOR SELECT USING (true);
CREATE POLICY "public write events" ON public.events FOR ALL    USING (true);
CREATE POLICY "public read loads"            ON public.loads          FOR SELECT USING (true);
CREATE POLICY "public read stops"            ON public.stops          FOR SELECT USING (true);
CREATE POLICY "public read load_documents"   ON public.load_documents FOR SELECT USING (true);
CREATE POLICY "public read check_calls"      ON public.check_calls    FOR SELECT USING (true);

-- NOTE: this intentionally leaves the *other* tables locked (RLS on, no
-- policy → service-role only). Those aren't browser-reachable, so the app
-- still works and you've at least kept the legacy/PII tables closed. If
-- something unexpected breaks, the table it needs is browser-reachable and
-- should be added to the lockdown's PHASE 3 allow-list, not re-opened here.
-- ============================================================================
