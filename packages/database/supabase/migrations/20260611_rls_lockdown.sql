-- ============================================================================
-- 20260611_rls_lockdown.sql
--
-- CRITICAL SECURITY FIX — closes a project-wide cross-tenant breach.
--
-- Before this migration, nearly every table carried a permissive
-- `USING (true)` policy ("public read/write …", "anon_full_access",
-- "allow all", …). The public anon key (shipped in the web bundle AND
-- committed in apps/dispatch/app.json) could therefore read AND write
-- every org's data, plus the legacy my-calendar tables (AR, owner-op
-- settlements, applicant PII). The legacy apps those policies served are
-- RETIRED — only FleetCal uses this database now.
--
-- ACCESS MODEL AFTER THIS MIGRATION
--   • API (Railway) + Next.js server routes use the SERVICE_ROLE key, which
--     has BYPASSRLS. They are UNAFFECTED by everything below — all normal
--     dispatcher/admin operations keep working.
--   • The browser client carries a Clerk-issued JWT (role `authenticated`,
--     org_id claim) and may touch ONLY:
--         events            — read + write   (calendar realtime + drag-save)
--         loads             — read           (realtime)
--         stops             — read           (realtime)
--         load_documents    — read           (realtime)
--         check_calls       — read           (realtime)
--         storage rate-cons — read + write   (rate-con PDF upload)
--     …all scoped to the caller's org via `(auth.jwt() ->> 'org_id')`.
--   • The raw anon role (logged-out) gets NOTHING.
--
-- DEPENDS ON: the Clerk "supabase" JWT template injecting `org_id`
-- ({{org.id}}) and Supabase Third-Party Auth (Clerk) being configured.
-- If that template is wrong, the calendar will go blank for signed-in
-- users after this runs — see ROLLOUT.
--
-- ROLLOUT (do NOT skip the smoke test):
--   1. Run this whole file in the Supabase SQL editor.
--   2. Immediately, as a SIGNED-IN user in the app:
--        a. Open the calendar — events must load (Realtime).
--        b. Drag/resize an event and save — write must succeed.
--        c. Open a load, upload a rate-con PDF — storage write must succeed.
--        d. Open a load's docs / POD — must still view.
--   3. As a SIGNED-OUT visitor, confirm a raw anon Supabase query returns
--      nothing (see the verification block at the bottom).
--   4. If the calendar is blank → the Clerk org_id claim isn't reaching
--      Postgres. Run 20260611_rls_lockdown_rollback.sql, fix the JWT
--      template, retry. Do NOT launch with it half-applied.
-- ============================================================================

-- ── PHASE 1 — drop every permissive USING(true) policy in `public` ──────────
-- Dynamic so we don't enumerate ~60 legacy policies by name. Leaves the
-- `service only … USING (false)` policies intact (they already deny non-
-- service roles, which is what we want).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual       IS NULL OR qual       = 'true')
      AND (with_check IS NULL OR with_check = 'true')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ── PHASE 2 — enable RLS on every table in `public` ─────────────────────────
-- RLS-on with no matching policy = deny for anon/authenticated. service_role
-- bypasses RLS, so the API/server routes are unaffected. This closes any
-- table that previously had RLS *off* (open to anon via raw GRANTs).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- ── PHASE 3 — org-scoped policies for the 5 browser-reachable tables ─────────
-- events: read + write
CREATE POLICY "fleetcal_events_select" ON public.events
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

CREATE POLICY "fleetcal_events_write" ON public.events
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'org_id') = org_id)
  WITH CHECK ((auth.jwt() ->> 'org_id') = org_id);

-- loads / stops / load_documents / check_calls: read-only (Realtime)
CREATE POLICY "fleetcal_loads_select" ON public.loads
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

CREATE POLICY "fleetcal_stops_select" ON public.stops
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

CREATE POLICY "fleetcal_load_documents_select" ON public.load_documents
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

CREATE POLICY "fleetcal_check_calls_select" ON public.check_calls
  FOR SELECT TO authenticated
  USING ((auth.jwt() ->> 'org_id') = org_id);

-- ── PHASE 4 — strip the broad PostgREST role grants ─────────────────────────
-- Supabase grants anon/authenticated broad table privileges at project
-- setup; that's what made the permissive policies reachable. Revoke
-- everything, then grant back ONLY the browser's 5 tables to authenticated.
-- (RLS above still filters those by org — defense in depth.)
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Future tables created by migrations must NOT silently re-open to anon.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.events         TO authenticated;
GRANT SELECT                          ON public.loads          TO authenticated;
GRANT SELECT                          ON public.stops          TO authenticated;
GRANT SELECT                          ON public.load_documents TO authenticated;
GRANT SELECT                          ON public.check_calls    TO authenticated;

-- ── PHASE 5 — storage: lock legacy buckets, org-scope rate-cons ─────────────
-- Drop the retired my-calendar bucket policies. The hiring-docs bucket
-- allowed public READ *and DELETE* of applicant documents — kill it.
DROP POLICY IF EXISTS "public read hiring-docs"      ON storage.objects;
DROP POLICY IF EXISTS "public upload hiring-docs"    ON storage.objects;
DROP POLICY IF EXISTS "public update hiring-docs"    ON storage.objects;
DROP POLICY IF EXISTS "public delete hiring-docs"    ON storage.objects;
DROP POLICY IF EXISTS "anon read maintenance-docs"   ON storage.objects;
DROP POLICY IF EXISTS "anon upload maintenance-docs" ON storage.objects;
DROP POLICY IF EXISTS "anon update maintenance-docs" ON storage.objects;
DROP POLICY IF EXISTS "anon delete maintenance-docs" ON storage.objects;
DROP POLICY IF EXISTS "allow driver report uploads"  ON storage.objects;

-- Ensure RLS is on for storage (it may have been off → all buckets open).
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- rate-cons: browser uploads at path `<org_id>/<event_id>.pdf` as the
-- logged-in user. Scope to the first path segment = caller's org.
-- (All other buckets — load-documents, asset-documents, trailer-documents,
-- invoice packets — are written/read by the API via service-role + signed
-- URLs, so they need no authenticated policy.)
CREATE POLICY "fleetcal_ratecons_rw" ON storage.objects
  FOR ALL TO authenticated
  USING      (bucket_id = 'rate-cons'
              AND (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id'))
  WITH CHECK (bucket_id = 'rate-cons'
              AND (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id'));

-- ── VERIFICATION (run after COMMIT; all must hold) ──────────────────────────
-- 1) No permissive table policies remain:
--      SELECT tablename, policyname FROM pg_policies
--      WHERE schemaname='public' AND qual='true';   -- expect 0 rows
-- 2) anon has zero table privileges:
--      SELECT grantee, count(*) FROM information_schema.role_table_grants
--      WHERE table_schema='public' AND grantee='anon' GROUP BY grantee;  -- 0
-- 3) authenticated holds exactly the 5 tables:
--      SELECT table_name, privilege_type FROM information_schema.role_table_grants
--      WHERE table_schema='public' AND grantee='authenticated' ORDER BY 1,2;
-- 4) Signed-out anon read returns nothing (run with the anon key, not here).
-- ============================================================================
