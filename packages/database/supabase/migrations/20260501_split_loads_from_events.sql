-- ============================================================
-- Split loads from events
--
-- Introduces a `loads` table for the billable load entity, with `events`
-- becoming pure calendar entries (one or two events per revenue load,
-- one event per non-revenue move).
--
-- This migration is ADDITIVE: it creates new structure and migrates data,
-- but leaves the old columns on `events` in place so app code keeps
-- working until it's updated. A follow-up migration drops the deprecated
-- columns once apps no longer read them.
--
-- Field-level decisions captured in conversation:
--   • driver_pay stays on events (per-leg)
--   • accessorials/rate_con/audit_log on loads (load-level)
--   • notes on BOTH (load-level + event-level / non-revenue's only home)
--   • events.title stays per-event; UI appends "(Pickup)"/"(Delivery)"
--   • internal_load_id resets, new sequence starts at 10000
-- ============================================================

BEGIN;

-- ── 1. loads table ─────────────────────────────────────────────────────

CREATE TABLE loads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              text NOT NULL,
  internal_load_id    integer NOT NULL,             -- 5+ digit, unique per org

  -- Identity
  load_num            text,                          -- broker's load number
  broker              text,
  customer_id         uuid REFERENCES customers(id) ON DELETE SET NULL,
  dispatcher          text,
  created_by_name     text,

  -- Money
  load_price          double precision,
  rate_con_pdf        text,                          -- Storage path in `rate-cons` bucket
  accessorials        jsonb,                         -- load-level (per-leg accessorials are a future refinement)

  -- References & instructions
  ref_nums            text,                          -- JSON array of {label, value}
  notes               text,                          -- load-level notes (broker instructions etc.)

  -- Audit
  audit_log           jsonb,                         -- single history per load

  -- Lifecycle
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  CONSTRAINT loads_internal_load_id_per_org UNIQUE (org_id, internal_load_id)
);

CREATE INDEX idx_loads_org              ON loads(org_id);
CREATE INDEX idx_loads_org_active       ON loads(org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_loads_internal_load_id ON loads(org_id, internal_load_id);
CREATE INDEX idx_loads_customer_id      ON loads(customer_id) WHERE customer_id IS NOT NULL;

-- updated_at trigger (uses the existing set_updated_at function from schema.sql)
CREATE TRIGGER loads_updated_at
  BEFORE UPDATE ON loads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. internal_load_id allocator ──────────────────────────────────────
--
-- New counter table separate from the legacy org_load_id_counters (which
-- still allocates events.internal_load_id). Once the events column is
-- dropped (next migration), the legacy counter becomes orphan and we'll
-- drop it then.

CREATE TABLE loads_internal_id_counters (
  org_id  text PRIMARY KEY,
  last_id integer NOT NULL DEFAULT 9999             -- next allocation will be 10000
);

CREATE OR REPLACE FUNCTION allocate_loads_internal_id(p_org_id text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_next integer;
BEGIN
  -- Upsert + atomic increment
  INSERT INTO loads_internal_id_counters (org_id, last_id)
    VALUES (p_org_id, 10000)
    ON CONFLICT (org_id) DO UPDATE
      SET last_id = loads_internal_id_counters.last_id + 1
    RETURNING last_id INTO v_next;
  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION loads_assign_internal_load_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.internal_load_id IS NULL OR NEW.internal_load_id = 0 THEN
    NEW.internal_load_id := allocate_loads_internal_id(NEW.org_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER loads_set_internal_load_id
  BEFORE INSERT ON loads
  FOR EACH ROW EXECUTE FUNCTION loads_assign_internal_load_id();

-- ── 3. events.load_id ──────────────────────────────────────────────────

-- ON DELETE CASCADE: hard-deleting a load deletes its events (1 or 2).
-- Soft-delete (which is the normal flow) sets deleted_at instead.
ALTER TABLE events
  ADD COLUMN load_id uuid REFERENCES loads(id) ON DELETE CASCADE;

CREATE INDEX idx_events_load_id ON events(load_id) WHERE load_id IS NOT NULL;

-- ── 4. load_documents.load_id ──────────────────────────────────────────

ALTER TABLE load_documents
  ADD COLUMN load_id uuid REFERENCES loads(id) ON DELETE CASCADE;

CREATE INDEX idx_load_documents_load_id ON load_documents(load_id) WHERE load_id IS NOT NULL;

-- The old event_id FK stays for now; dropped in the follow-up migration.

-- ── 5. Data migration ──────────────────────────────────────────────────
--
-- Strategy:
--   • event_kind='non_revenue' events → no load, load_id stays NULL
--   • event_kind='revenue' AND relay_group_id IS NULL → 1 load, 1 event
--   • event_kind='revenue' AND relay_group_id IS NOT NULL → 1 load, 2 events
--
-- For relay groups, we pick the canonical event for load-level field
-- sourcing as the row with the earliest start (the pickup leg). If the
-- pair was edited inconsistently, the pickup wins.

DO $$
DECLARE
  rec RECORD;
  new_load_id uuid;
BEGIN
  -- ── 5a. Single-event revenue loads ──────────────────────────────────
  FOR rec IN
    SELECT id FROM events
    WHERE event_kind = 'revenue'
      AND relay_group_id IS NULL
      AND deleted_at IS NULL
  LOOP
    INSERT INTO loads (
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums, notes, audit_log,
      created_at, updated_at
    )
    SELECT
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums,
      -- merge special_instructions into notes if both set
      CASE
        WHEN special_instructions IS NOT NULL AND notes IS NOT NULL
          THEN special_instructions || E'\n\n' || notes
        WHEN special_instructions IS NOT NULL THEN special_instructions
        ELSE notes
      END,
      audit_log,
      created_at, updated_at
    FROM events WHERE id = rec.id
    RETURNING id INTO new_load_id;

    UPDATE events SET load_id = new_load_id WHERE id = rec.id;
  END LOOP;

  -- ── 5b. Relay revenue loads ─────────────────────────────────────────
  FOR rec IN
    SELECT DISTINCT relay_group_id, org_id
    FROM events
    WHERE event_kind = 'revenue'
      AND relay_group_id IS NOT NULL
      AND deleted_at IS NULL
  LOOP
    -- Insert one load using load-level fields from the pickup (earliest start)
    INSERT INTO loads (
      org_id, load_num, broker, dispatcher, created_by_name,
      load_price, rate_con_pdf, accessorials,
      ref_nums, notes, audit_log,
      created_at, updated_at
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
      e.created_at, e.updated_at
    FROM events e
    WHERE e.relay_group_id = rec.relay_group_id
      AND e.org_id = rec.org_id
    ORDER BY e.start ASC, e.created_at ASC
    LIMIT 1
    RETURNING id INTO new_load_id;

    -- Both legs point at the same load
    UPDATE events
      SET load_id = new_load_id
      WHERE relay_group_id = rec.relay_group_id
        AND org_id = rec.org_id;
  END LOOP;

  -- ── 5c. load_documents — migrate event_id → load_id ─────────────────
  -- Each document attaches to its event's load (if any). Documents on
  -- non-revenue events are left with load_id NULL.
  UPDATE load_documents ld
    SET load_id = e.load_id
    FROM events e
    WHERE ld.event_id = e.id
      AND e.load_id IS NOT NULL;
END $$;

COMMIT;

-- ============================================================
-- After applying:
--   • loads has one row per revenue-load (single or relay)
--   • events.load_id is set for revenue events, NULL for non-revenue
--   • load_documents has load_id set for documents on revenue events
--   • Old columns on events are still present and populated; app code
--     continues to function unchanged
--   • New loads created from this point on get internal_load_id from the
--     loads counter (≥ 10000). Existing events still get internal_load_id
--     from the legacy events counter; that machinery is untouched.
--
-- Next: rewrite app code to read load-level fields via loads.load_id,
-- then run the second migration to drop the deprecated event columns.
-- ============================================================
