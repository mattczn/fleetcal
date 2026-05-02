-- ============================================================
-- Drop legacy load-level columns from events
--
-- Phase 2.5c — completes the loads/events split started in 20260501.
-- All load-level fields now live on the `loads` table; events keeps only
-- per-leg fields (start/end, asset/driver assignment, status, trailer,
-- driver_pay, priority, notes for non-revenue, audit_log for per-leg
-- driver-side audit entries).
--
-- Before applying:
--   • web app reads via load:loads(*) join (joinEventLoadToApp converter)
--   • web app writes via Railway (split into load + event by loadFieldSplit)
--   • driver and dispatch apps need joined reads and any dispatch writes
--     to load-level fields will now fail until they're moved to Railway
--
-- KEPT on events:
--   • notes        — event-level (non-revenue's only home for free text)
--   • audit_log    — event-level (driver check-ins, status changes)
-- ============================================================

BEGIN;

-- ── 1. Backfill any remaining orphan revenue events ────────────────────
--
-- Defensive: if any revenue events still have load_id IS NULL (could
-- happen if rows were created between 20260501 apply and the migration
-- of write paths to populate load_id), promote them now.

DO $$
DECLARE
  rec RECORD;
  new_load_id uuid;
BEGIN
  -- Single-event orphans
  FOR rec IN
    SELECT id FROM events
    WHERE event_kind = 'revenue'
      AND load_id IS NULL
      AND relay_group_id IS NULL
  LOOP
    INSERT INTO loads (
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums, notes, audit_log,
      created_at, updated_at, deleted_at
    )
    SELECT
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums,
      CASE
        WHEN special_instructions IS NOT NULL AND notes IS NOT NULL
          THEN special_instructions || E'\n\n' || notes
        WHEN special_instructions IS NOT NULL THEN special_instructions
        ELSE notes
      END,
      audit_log,
      created_at, updated_at, deleted_at
    FROM events WHERE id = rec.id
    RETURNING id INTO new_load_id;

    UPDATE events SET load_id = new_load_id WHERE id = rec.id;
  END LOOP;

  -- Relay orphans (one load per group)
  FOR rec IN
    SELECT DISTINCT relay_group_id, org_id
    FROM events
    WHERE event_kind = 'revenue'
      AND load_id IS NULL
      AND relay_group_id IS NOT NULL
  LOOP
    INSERT INTO loads (
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums, notes, audit_log,
      created_at, updated_at, deleted_at
    )
    SELECT
      e.org_id, e.load_num, e.broker, e.dispatcher, e.created_by_name,
      e.load_price, e.rate_con_pdf, e.accessorials,
      e.ref_nums,
      CASE
        WHEN e.special_instructions IS NOT NULL AND e.notes IS NOT NULL
          THEN e.special_instructions || E'\n\n' || e.notes
        WHEN e.special_instructions IS NOT NULL THEN e.special_instructions
        ELSE e.notes
      END,
      e.audit_log,
      e.created_at, e.updated_at, e.deleted_at
    FROM events e
    WHERE e.relay_group_id = rec.relay_group_id
      AND e.org_id = rec.org_id
    ORDER BY e.start ASC, e.created_at ASC
    LIMIT 1
    RETURNING id INTO new_load_id;

    UPDATE events
      SET load_id = new_load_id
      WHERE relay_group_id = rec.relay_group_id
        AND org_id = rec.org_id;
  END LOOP;
END $$;

-- ── 2. Drop legacy load-level columns from events ─────────────────────

DROP INDEX IF EXISTS idx_events_relay;

ALTER TABLE events
  DROP COLUMN IF EXISTS internal_load_id,
  DROP COLUMN IF EXISTS load_num,
  DROP COLUMN IF EXISTS broker,
  DROP COLUMN IF EXISTS load_price,
  DROP COLUMN IF EXISTS rate_con_pdf,
  DROP COLUMN IF EXISTS accessorials,
  DROP COLUMN IF EXISTS ref_nums,
  DROP COLUMN IF EXISTS special_instructions,
  DROP COLUMN IF EXISTS dispatcher,
  DROP COLUMN IF EXISTS created_by_name,
  DROP COLUMN IF EXISTS relay_group_id;

-- ── 3. Drop legacy internal_load_id machinery ─────────────────────────
--
-- The events.internal_load_id counter table (org_load_id_counters) is
-- replaced by loads_internal_id_counters from 20260501. Drop the legacy
-- counter table and any function that referenced it.

DROP TABLE IF EXISTS org_load_id_counters CASCADE;
DROP FUNCTION IF EXISTS allocate_org_load_id(text);
DROP FUNCTION IF EXISTS events_assign_internal_load_id();

-- ── 4. Drop legacy load_documents.event_id ────────────────────────────
--
-- The 20260501 migration backfilled load_documents.load_id; now drop the
-- old event_id column. Documents that were on non-revenue events (where
-- load_id stays NULL) become unaddressable through the loads endpoint —
-- in practice there are none in production.

ALTER TABLE load_documents DROP COLUMN IF EXISTS event_id;

COMMIT;

-- ============================================================
-- After applying:
--   • events table is per-leg only (asset/driver/start/end/status/trailer/
--     driver_pay/priority + notes for non-revenue + audit_log for per-leg)
--   • All load-level fields exclusively on loads
--   • events.load_id is the relay grouping (two events with same load_id
--     and relay_role set ARE the relay)
--   • Non-revenue events have load_id NULL
-- ============================================================
