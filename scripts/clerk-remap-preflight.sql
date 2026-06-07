-- =============================================================================
-- Clerk dev → prod remap — PRE-FLIGHT VERIFICATION
-- =============================================================================
--
-- READ-ONLY. Run this against your production Supabase DB BEFORE running
-- clerk-prod-remap.sql to confirm:
--   1. Every table the remap script touches actually exists with an org_id
--   2. Row counts for the dev org are sane (no surprises)
--   3. The Clerk user_id text columns exist and are populated
--   4. The JSONB audit_log structure matches what the remap script expects
--
-- If any of these queries flags something unexpected, update the remap
-- script accordingly before running it on prod.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- (1) Tables with org_id — script's list vs. live schema
-- ─────────────────────────────────────────────────────────────────────────
-- Script_expected = the 41 tables the remap script tries to update.
-- Live_db         = every public table that actually has an org_id column.
-- Mismatch column = MISSING (in live but not script) or EXTRA (in script
-- but not live; harmless, gracefully skipped). Anything in MISSING is a
-- bug — those rows would be left tagged with the old org_id.

WITH script_expected (table_name) AS (
  VALUES
    ('assets'), ('drivers'), ('events'), ('stops'), ('loads'),
    ('driver_asset_prefs'), ('driver_push_tokens'), ('driver_evening_sweeps'),
    ('driver_documents'), ('driver_notification_prefs'),
    ('maintenance_action_items'), ('maintenance_reports'),
    ('maintenance_report_photos'), ('maintenance_action_item_photos'),
    ('maintenance_action_item_events'),
    ('inspection_reports'), ('inspection_photos'),
    ('load_documents'), ('load_notifications'), ('loads_internal_id_counters'),
    ('invoices'), ('fuel_reports'), ('fuel_report_photos'),
    ('fuel_transactions'), ('cost_analysis_reports'),
    ('payroll_records'), ('payroll_adjustments'),
    ('motive_driving_periods'), ('motive_odometer_readings'),
    ('motive_sync_state'), ('movements'), ('movement_links'),
    ('asset_documents'), ('trailer_documents'),
    ('org_settings'), ('check_calls'), ('org_api_keys'),
    ('customers'), ('trailers'), ('saved_locations'), ('dispatchers')
),
live_db AS (
  SELECT table_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'org_id'
)
SELECT
  COALESCE(s.table_name, l.table_name) AS table_name,
  CASE
    WHEN s.table_name IS NULL AND l.table_name IS NOT NULL THEN '⚠ MISSING from remap script (live has it)'
    WHEN s.table_name IS NOT NULL AND l.table_name IS NULL THEN '○ EXTRA in script (script will skip it)'
    ELSE '✓ matched'
  END AS status
FROM script_expected s
FULL OUTER JOIN live_db l USING (table_name)
ORDER BY status DESC, table_name;

-- ─────────────────────────────────────────────────────────────────────────
-- (2) Row counts per table for Curzon dev — sanity check
-- ─────────────────────────────────────────────────────────────────────────
-- Sums up "what's about to move." If a table shows zero rows but Matt
-- swears he has data there, the org_id may already be set to something
-- else (e.g. a manual fix that drifted from the canonical dev id).

WITH all_orgid_tables AS (
  SELECT table_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'org_id'
)
SELECT
  table_name,
  (SELECT count(*) FROM (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = aot.table_name
      AND column_name = 'org_id'
  ) e) AS has_org_id,
  -- Inlined dynamic count via a lateral query
  (xpath('/row/count/text()',
         query_to_xml(format('SELECT count(*) FROM public.%I WHERE org_id = %L',
                             aot.table_name, 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t'),
                      true, true, '')))[1]::text::bigint AS curzon_rows
FROM all_orgid_tables aot
ORDER BY curzon_rows DESC NULLS LAST;

-- ─────────────────────────────────────────────────────────────────────────
-- (3) Clerk user_id text columns — exist? populated?
-- ─────────────────────────────────────────────────────────────────────────
-- Verifies each column the remap script tries to update exists on the
-- live schema, AND shows how many distinct user_xxx values are stored
-- (vs. driver:N synthetic values, vs. nulls). Look for any (table,col)
-- pair where:
--   - exists=false → script will fail
--   - distinct_user_ids high but mapping has only 8 rows → you may
--     have missed some users

WITH user_id_columns (table_name, column_name) AS (
  VALUES
    ('asset_documents',                  'uploaded_by'),
    ('load_documents',                   'uploaded_by'),
    ('driver_documents',                 'uploaded_by'),
    ('maintenance_action_items',         'created_by'),
    ('fuel_reports',                     'submitted_by'),
    ('fuel_transactions',                'matched_by'),
    ('maintenance_action_item_photos',   'uploaded_by_dispatcher_user_id'),
    ('cost_analysis_reports',            'created_by'),
    ('movements',                        'created_by'),
    ('movement_links',                   'source_user'),
    ('org_api_keys',                     'created_by')
)
SELECT
  u.table_name,
  u.column_name,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = u.table_name
      AND column_name = u.column_name
  ) AS exists_in_live_schema,
  (xpath('/row/count/text()',
         query_to_xml(format(
           'SELECT count(DISTINCT %I) FROM public.%I WHERE %I LIKE ''user_%%''',
            u.column_name, u.table_name, u.column_name),
           true, true, '')))[1]::text::bigint AS distinct_clerk_user_ids
FROM user_id_columns u
ORDER BY distinct_clerk_user_ids DESC NULLS LAST;

-- ─────────────────────────────────────────────────────────────────────────
-- (4) JSONB audit log — does the structure match remap assumptions?
-- ─────────────────────────────────────────────────────────────────────────
-- The remap script expects:
--   - loads.audit_log[].userId          OR loads.audit_log[].changedById
--   - loads.internal_notes[].author
--   - events.audit_log[].userId         OR events.audit_log[].changedById
--   - events.driver_history[].changedById
--
-- These queries pull a sample of the actual keys used in your data so
-- you can verify they match. Look for any key NOT in the list above
-- whose value looks like a user_xxx string — that's a missed code path.

-- 4a. What keys exist in loads.audit_log entries?
SELECT 'loads.audit_log' AS source,
       jsonb_object_keys(entry) AS key_name,
       count(*) AS occurrences
FROM loads, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
GROUP BY key_name
ORDER BY occurrences DESC;

-- 4b. What keys exist in events.audit_log entries?
SELECT 'events.audit_log' AS source,
       jsonb_object_keys(entry) AS key_name,
       count(*) AS occurrences
FROM events, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
GROUP BY key_name
ORDER BY occurrences DESC;

-- 4c. What keys exist in events.driver_history entries?
SELECT 'events.driver_history' AS source,
       jsonb_object_keys(entry) AS key_name,
       count(*) AS occurrences
FROM events, jsonb_array_elements(coalesce(driver_history, '[]'::jsonb)) entry
GROUP BY key_name
ORDER BY occurrences DESC;

-- 4d. What keys exist in loads.internal_notes entries?
SELECT 'loads.internal_notes' AS source,
       jsonb_object_keys(entry) AS key_name,
       count(*) AS occurrences
FROM loads, jsonb_array_elements(coalesce(internal_notes, '[]'::jsonb)) entry
GROUP BY key_name
ORDER BY occurrences DESC;

-- ─────────────────────────────────────────────────────────────────────────
-- (5) Every Clerk user_id ever stored — the authoritative team list
-- ─────────────────────────────────────────────────────────────────────────
-- Cross-checks the 8 user_ids you provided against everyone who has
-- ever made a write. Any row in this output NOT in your mapping is a
-- missing invite (or a deleted-account ghost).

WITH all_user_ids AS (
  SELECT DISTINCT uploaded_by  AS user_id FROM asset_documents               WHERE uploaded_by LIKE 'user_%'
  UNION SELECT DISTINCT uploaded_by FROM load_documents                       WHERE uploaded_by LIKE 'user_%'
  UNION SELECT DISTINCT uploaded_by FROM driver_documents                     WHERE uploaded_by LIKE 'user_%'
  UNION SELECT DISTINCT created_by FROM maintenance_action_items              WHERE created_by  LIKE 'user_%'
  UNION SELECT DISTINCT submitted_by FROM fuel_reports                        WHERE submitted_by LIKE 'user_%'
  UNION SELECT DISTINCT matched_by FROM fuel_transactions                     WHERE matched_by  LIKE 'user_%'
  UNION SELECT DISTINCT uploaded_by_dispatcher_user_id FROM maintenance_action_item_photos WHERE uploaded_by_dispatcher_user_id LIKE 'user_%'
  UNION SELECT DISTINCT created_by FROM cost_analysis_reports                 WHERE created_by  LIKE 'user_%'
  UNION SELECT DISTINCT created_by FROM movements                             WHERE created_by  LIKE 'user_%'
  UNION SELECT DISTINCT source_user FROM movement_links                       WHERE source_user LIKE 'user_%'
  UNION SELECT DISTINCT created_by FROM org_api_keys                          WHERE created_by  LIKE 'user_%'
),
jsonb_user_ids AS (
  SELECT DISTINCT entry->>'userId' AS user_id
    FROM loads, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
    WHERE entry->>'userId' LIKE 'user_%'
  UNION SELECT DISTINCT entry->>'changedById'
    FROM loads, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
    WHERE entry->>'changedById' LIKE 'user_%'
  UNION SELECT DISTINCT entry->>'author'
    FROM loads, jsonb_array_elements(coalesce(internal_notes, '[]'::jsonb)) entry
    WHERE entry->>'author' LIKE 'user_%'
  UNION SELECT DISTINCT entry->>'userId'
    FROM events, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
    WHERE entry->>'userId' LIKE 'user_%'
  UNION SELECT DISTINCT entry->>'changedById'
    FROM events, jsonb_array_elements(coalesce(audit_log, '[]'::jsonb)) entry
    WHERE entry->>'changedById' LIKE 'user_%'
  UNION SELECT DISTINCT entry->>'changedById'
    FROM events, jsonb_array_elements(coalesce(driver_history, '[]'::jsonb)) entry
    WHERE entry->>'changedById' LIKE 'user_%'
),
all_distinct_users AS (
  SELECT user_id FROM all_user_ids
  UNION
  SELECT user_id FROM jsonb_user_ids
)
SELECT
  user_id,
  CASE WHEN user_id IN (
    'user_3EYE29KB5QhqA5OX6ZiyBR9CGHG',
    'user_3E7J1RpHh0COQxFhSd9iqCNmeRc',
    'user_3E698Z2KQzAR2xB2ZjTGCxMs5a8',
    'user_3E5cc7nMDWD0E0PzvtynusA7PKI',
    'user_3DyGOVbIH5cyfNCdPwy8nsWs9Xc',
    'user_3CjyUDl0dR0Wi9Pq1HbFaSZGLsg',
    'user_3Dn7dfW8FTZnTLyDQFQg4IlQ6oe',
    'user_3Cgz7uSjL0IX359kSOh0PRIHq3b'
  ) THEN '✓ in your 8-user map'
       ELSE '⚠ NOT in your 8-user map — invite this user too!'
  END AS coverage
FROM all_distinct_users
ORDER BY coverage DESC, user_id;

-- ─────────────────────────────────────────────────────────────────────────
-- (6) Storage paths — informational only
-- ─────────────────────────────────────────────────────────────────────────
-- The remap renames the org_id COLUMN but leaves storage paths
-- (e.g. "org_3Cgzom31.../load_abc.../doc.pdf") unchanged. URLs continue
-- to resolve because the buckets are RLS-disabled. This query just
-- shows the magnitude of paths that would still reference the old id
-- so you're not surprised by it later.

SELECT
  bucket_id,
  count(*) AS files_with_old_org_id_path
FROM storage.objects
WHERE name LIKE 'org_3Cgzom31hVxbq6WR3FjVTbL6K3t/%'
GROUP BY bucket_id
ORDER BY files_with_old_org_id_path DESC;
