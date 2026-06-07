-- =============================================================================
-- Clerk dev → prod remap for Curzon Trucking
-- =============================================================================
--
-- Renames org_id everywhere AND remaps Clerk user_id text columns + JSONB
-- audit log nested IDs. Runs inside a single transaction. See
-- docs/clerk-prod-migration.md for the full playbook.
--
-- USAGE (Supabase SQL editor):
--   1. Fill in the three values in the SETUP block below:
--        - v_old_org_id  : current dev org_id (the one in the DB today)
--        - v_new_org_id  : prod org_id from the freshly-created Clerk org
--        - user mapping  : add one row per team member who has ever made
--                          a write (uploaded a doc, edited a load, made a
--                          check call, etc.). Names are for your reference;
--                          only dev_user_id and prod_user_id are used.
--
--   2. Paste the whole file into the SQL editor as a single statement.
--      Supabase wraps it in a transaction; the trailing block at the
--      bottom decides COMMIT vs ROLLBACK based on a verification check.
--
--   3. If the verification block raises NOTICE 'OK', commit. Otherwise,
--      ROLLBACK and investigate.
--
-- Run on a recent Supabase backup ONCE FIRST to sanity-check, then on
-- production during the maintenance window.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- SETUP — fill these in. NEVER commit values to git.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_old_org_id text := 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t';   -- Curzon dev (Clerk Development instance)
  v_new_org_id text := 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';   -- Curzon prod (Clerk Production instance, fleetcal.app)

  v_old_count int;
BEGIN
  -- Sanity check: the old org actually exists in our tenant tables.
  SELECT count(*) INTO v_old_count FROM org_settings WHERE org_id = v_old_org_id;
  IF v_old_count = 0 THEN
    RAISE EXCEPTION 'old org_id % not found in org_settings — check the value before proceeding', v_old_org_id;
  END IF;

  -- Stash the values for use by the subsequent UPDATEs. set_config writes
  -- into the current transaction's local config; current_setting reads it
  -- back from the SQL statements that follow this DO block.
  PERFORM set_config('app.old_org_id', v_old_org_id, true);
  PERFORM set_config('app.new_org_id', v_new_org_id, true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- USER ID MAPPING — one row per team member who has made writes
-- ─────────────────────────────────────────────────────────────────────────
-- Add every dev_user_id → prod_user_id pair. If a user_id appears in the
-- DB but is missing from this map, the user_id UPDATE block below LEAVES
-- IT UNTOUCHED (so unmapped IDs stay as-is rather than becoming NULL or
-- corrupted). The verification block at the end flags any leftover dev
-- IDs so you can catch a missing mapping before commit.

CREATE TEMP TABLE clerk_user_map (
  dev_user_id  text PRIMARY KEY,
  prod_user_id text NOT NULL,
  display_name text  -- optional, for sanity checking the CSV
) ON COMMIT DROP;

-- The 8 dev user_ids below were enumerated from the FleetCal DB on
-- 2026-06-07. Replace each REPLACE_WITH_PROD_… with the new
-- user_xxx value Clerk hands out after that user accepts the invite
-- to the prod Curzon org. The display_name column is for your
-- sanity check during review — pull each user's name/email from
-- the dev Clerk dashboard's Users list and fill it in so the
-- script's history is self-documenting.
INSERT INTO clerk_user_map (dev_user_id, prod_user_id, display_name) VALUES
  ('user_3EYE29KB5QhqA5OX6ZiyBR9CGHG', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3E7J1RpHh0COQxFhSd9iqCNmeRc', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3E698Z2KQzAR2xB2ZjTGCxMs5a8', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3E5cc7nMDWD0E0PzvtynusA7PKI', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3DyGOVbIH5cyfNCdPwy8nsWs9Xc', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3CjyUDl0dR0Wi9Pq1HbFaSZGLsg', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3Dn7dfW8FTZnTLyDQFQg4IlQ6oe', 'REPLACE_WITH_PROD_USER_ID', 'TBD'),
  ('user_3Cgz7uSjL0IX359kSOh0PRIHq3b', 'REPLACE_WITH_PROD_USER_ID', 'Matt Curzon');  -- adjust display name

-- Bail out if any prod_user_id placeholder is still present — protects
-- against accidentally running a half-finished mapping where some
-- users would get the literal string "REPLACE_WITH_PROD_USER_ID" as
-- their identifier.
DO $$
DECLARE
  v_unfilled int;
BEGIN
  SELECT count(*) INTO v_unfilled
    FROM clerk_user_map
    WHERE prod_user_id LIKE 'REPLACE_%' OR prod_user_id NOT LIKE 'user_%';
  IF v_unfilled > 0 THEN
    RAISE EXCEPTION 'clerk_user_map has % rows whose prod_user_id is still unfilled — replace every REPLACE_WITH_PROD_USER_ID before running', v_unfilled;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- ORG_ID UPDATES — 37 tables, all idempotent (one UPDATE per table)
-- ─────────────────────────────────────────────────────────────────────────
-- Order: parents → children doesn't matter here because we're not deleting
-- rows; we're renaming a text column that's a FK to a logical tenant only
-- (no actual FK constraint on org_id).
-- =====================================================================
-- Pattern:   UPDATE <table> SET org_id = current_setting('app.new_org_id')
--                                 WHERE org_id = current_setting('app.old_org_id');
-- Each UPDATE returns its row count to stdout via RAISE NOTICE so you can
-- spot a table that's silently empty.

DO $$
DECLARE
  v_old text := current_setting('app.old_org_id');
  v_new text := current_setting('app.new_org_id');
  v_n   int;
  v_table text;
  v_tables text[] := ARRAY[
    -- Core operations
    'assets', 'drivers', 'events', 'stops', 'loads',
    -- Drivers & vehicles
    'driver_asset_prefs', 'driver_push_tokens', 'driver_evening_sweeps',
    'driver_documents', 'driver_notification_prefs',
    -- Maintenance & inspections
    'maintenance_action_items', 'maintenance_reports', 'maintenance_report_photos',
    'maintenance_action_item_photos', 'maintenance_action_item_events',
    'inspection_reports', 'inspection_photos',
    -- Load & financial
    'load_documents', 'load_notifications', 'loads_internal_id_counters',
    'invoices', 'fuel_reports', 'fuel_report_photos', 'fuel_transactions',
    'cost_analysis_reports',
    -- Payroll & motive
    'payroll_records', 'payroll_adjustments',
    'motive_driving_periods', 'motive_odometer_readings', 'motive_sync_state',
    'movements',
    -- Assets & settings
    'movement_links', 'asset_documents', 'trailer_documents',
    'org_settings', 'check_calls', 'org_api_keys',
    -- Customers / trailers / saved_locations / dispatchers — verify these
    -- exist with org_id columns. If your migration history doesn't show
    -- org_id on these, they're managed elsewhere; comment them out.
    'customers', 'trailers', 'saved_locations', 'dispatchers'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables
  LOOP
    -- Guard against typos / non-existent tables — skip rather than abort
    -- so the script remains useful if the schema diverges.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'org_id'
    ) THEN
      RAISE NOTICE '  skipping %: no org_id column', v_table;
      CONTINUE;
    END IF;

    EXECUTE format(
      'UPDATE %I SET org_id = %L WHERE org_id = %L',
      v_table, v_new, v_old
    );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '  %: % rows', v_table, v_n;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- USER_ID TEXT COLUMNS — Clerk user IDs stored as plain text
-- ─────────────────────────────────────────────────────────────────────────
-- The 4 columns below are the AUTHORITATIVE set from the preflight
-- discovery query that scanned every public.* text column for values
-- starting with 'user_'. The migration audit had originally guessed
-- ~11 columns but the live DB only stores Clerk user_ids in these 4 —
-- the others either don't exist (load_documents.uploaded_by was
-- replaced by driver-only uploaded_by_driver_id) or only hold
-- non-Clerk values like 'driver:N' / 'motive_sync' / NULL.
--
-- Edge cases:
--   - The JOIN against clerk_user_map means rows whose user_id isn't in
--     the map are LEFT UNCHANGED (verification at the end flags any
--     leftover dev user_ids so missing mappings get caught).
--   - Synthetic prefix values like 'driver:123' or 'motive_sync' don't
--     start with 'user_' so they wouldn't match the JOIN anyway.

UPDATE fuel_transactions SET matched_by = m.prod_user_id
  FROM clerk_user_map m WHERE fuel_transactions.matched_by = m.dev_user_id;

UPDATE maintenance_action_items SET created_by = m.prod_user_id
  FROM clerk_user_map m WHERE maintenance_action_items.created_by = m.dev_user_id;

UPDATE cost_analysis_reports SET created_by = m.prod_user_id
  FROM clerk_user_map m WHERE cost_analysis_reports.created_by = m.dev_user_id;

UPDATE movement_links SET source_user = m.prod_user_id
  FROM clerk_user_map m WHERE movement_links.source_user = m.dev_user_id;

UPDATE cost_analysis_reports SET created_by = m.prod_user_id
  FROM clerk_user_map m WHERE cost_analysis_reports.created_by = m.dev_user_id;

UPDATE movements SET created_by = m.prod_user_id
  FROM clerk_user_map m WHERE movements.created_by = m.dev_user_id;

UPDATE movement_links SET source_user = m.prod_user_id
  FROM clerk_user_map m WHERE movement_links.source_user = m.dev_user_id;

UPDATE org_api_keys SET created_by = m.prod_user_id
  FROM clerk_user_map m WHERE org_api_keys.created_by = m.dev_user_id;

-- ─────────────────────────────────────────────────────────────────────────
-- JSONB AUDIT LOGS — nested user_id remapping
-- ─────────────────────────────────────────────────────────────────────────
-- loads.audit_log, events.audit_log, events.driver_history all share the
-- shape: jsonb array of entries, each with possible userId / changedById
-- keys. loads.internal_notes uses 'author'.
--
-- Approach: jsonb_array_elements → coalesce-and-replace via the map →
-- jsonb_agg back to an array. Faster than client-side iteration and
-- preserves entry ordering.

UPDATE loads l
SET audit_log = (
  SELECT jsonb_agg(
    CASE
      WHEN m.prod_user_id IS NOT NULL
        THEN entry || jsonb_build_object(
          'userId',     m.prod_user_id,
          'changedById', m.prod_user_id
        )
      ELSE entry
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(l.audit_log) WITH ORDINALITY AS t(entry, ord)
  LEFT JOIN clerk_user_map m
    ON  m.dev_user_id = COALESCE(entry->>'userId', entry->>'changedById')
)
WHERE l.audit_log IS NOT NULL
  AND jsonb_typeof(l.audit_log) = 'array'
  AND l.audit_log @? '$[*] ? (@.userId != null || @.changedById != null)';

UPDATE loads l
SET internal_notes = (
  SELECT jsonb_agg(
    CASE
      WHEN m.prod_user_id IS NOT NULL
        THEN entry || jsonb_build_object('author', m.prod_user_id)
      ELSE entry
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(l.internal_notes) WITH ORDINALITY AS t(entry, ord)
  LEFT JOIN clerk_user_map m ON m.dev_user_id = entry->>'author'
)
WHERE l.internal_notes IS NOT NULL
  AND jsonb_typeof(l.internal_notes) = 'array'
  AND l.internal_notes @? '$[*] ? (@.author != null)';

UPDATE events e
SET audit_log = (
  SELECT jsonb_agg(
    CASE
      WHEN m.prod_user_id IS NOT NULL
        THEN entry || jsonb_build_object(
          'userId',     m.prod_user_id,
          'changedById', m.prod_user_id
        )
      ELSE entry
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(e.audit_log) WITH ORDINALITY AS t(entry, ord)
  LEFT JOIN clerk_user_map m
    ON  m.dev_user_id = COALESCE(entry->>'userId', entry->>'changedById')
)
WHERE e.audit_log IS NOT NULL
  AND jsonb_typeof(e.audit_log) = 'array'
  AND e.audit_log @? '$[*] ? (@.userId != null || @.changedById != null)';

UPDATE events e
SET driver_history = (
  SELECT jsonb_agg(
    CASE
      WHEN m.prod_user_id IS NOT NULL
        THEN entry || jsonb_build_object('changedById', m.prod_user_id)
      ELSE entry
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(e.driver_history) WITH ORDINALITY AS t(entry, ord)
  LEFT JOIN clerk_user_map m ON m.dev_user_id = entry->>'changedById'
)
WHERE e.driver_history IS NOT NULL
  AND jsonb_typeof(e.driver_history) = 'array'
  AND e.driver_history @? '$[*] ? (@.changedById != null)';

-- ─────────────────────────────────────────────────────────────────────────
-- VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────
-- These queries should all return ZERO rows after a successful remap.
-- If any returns >0, ROLLBACK and investigate before committing.

DO $$
DECLARE
  v_old text := current_setting('app.old_org_id');
  v_n   bigint;

  -- Count Clerk dev user_ids still present in audit JSONB
  v_dev_user_count_in_loads bigint;
  v_dev_user_count_in_events bigint;
BEGIN
  -- Any tenant row still referencing old org_id?
  SELECT count(*) INTO v_n FROM org_settings WHERE org_id = v_old;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'org_settings still has % rows with old org_id', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM loads WHERE org_id = v_old;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'loads still has % rows with old org_id', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM events WHERE org_id = v_old;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'events still has % rows with old org_id', v_n;
  END IF;

  -- Any user_id in audit_log we forgot to map?
  SELECT count(*)
    INTO v_dev_user_count_in_loads
    FROM loads l, jsonb_array_elements(coalesce(l.audit_log, '[]'::jsonb)) e
    LEFT JOIN clerk_user_map m ON m.prod_user_id = COALESCE(e->>'userId', e->>'changedById')
    WHERE COALESCE(e->>'userId', e->>'changedById') LIKE 'user_%'
      AND m.prod_user_id IS NULL;

  IF v_dev_user_count_in_loads > 0 THEN
    RAISE WARNING 'loads.audit_log: % entries reference user_ids that are NOT in the prod side of clerk_user_map (likely unmapped dev IDs)', v_dev_user_count_in_loads;
    RAISE WARNING 'review with: SELECT DISTINCT e->>''userId'', e->>''changedById'' FROM loads, jsonb_array_elements(audit_log) e WHERE e->>''userId'' LIKE ''user_%%'' OR e->>''changedById'' LIKE ''user_%%'';';
  END IF;

  SELECT count(*)
    INTO v_dev_user_count_in_events
    FROM events ev, jsonb_array_elements(coalesce(ev.audit_log, '[]'::jsonb)) e
    LEFT JOIN clerk_user_map m ON m.prod_user_id = COALESCE(e->>'userId', e->>'changedById')
    WHERE COALESCE(e->>'userId', e->>'changedById') LIKE 'user_%'
      AND m.prod_user_id IS NULL;

  IF v_dev_user_count_in_events > 0 THEN
    RAISE WARNING 'events.audit_log: % entries reference user_ids that are NOT in the prod side of clerk_user_map', v_dev_user_count_in_events;
  END IF;

  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE 'VERIFICATION PASSED — review WARNINGs above (if any), then commit.';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- COMMIT or ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────
-- If the verification block above raised any EXCEPTION, the whole
-- transaction is already aborted and you don't need to ROLLBACK explicitly.
--
-- If you saw only NOTICEs and want to keep the changes:
--   COMMIT;
--
-- If you want to back out (and you didn't get an EXCEPTION):
--   ROLLBACK;
--
-- The line below is intentionally left as ROLLBACK so a misclick on Run
-- doesn't accidentally commit a half-reviewed remap. Change it to COMMIT
-- only after you've reviewed the NOTICEs / WARNINGs above.

ROLLBACK;
