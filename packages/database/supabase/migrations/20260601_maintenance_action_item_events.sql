-- 20260601_maintenance_action_item_events.sql
--
-- Promote the WO ↔ event link from 1:1 to many-to-many.
--
-- An open / in-progress work order can be carried across multiple
-- maintenance blocks ("scheduled into Tuesday's shop day, deferred,
-- finally finished Friday") and we want the WO to appear on every
-- scheduled day so the dispatcher's calendar tells the full story.
-- With 1:1, deferring meant losing the prior link history; the new
-- shape preserves it.
--
-- The original maintenance_action_items.event_id column stays as a
-- denormalized "primary / most-recently-linked" hint for back-compat
-- readers (anything that hasn't been migrated to read eventIds yet).
-- The API layer keeps it in sync — sets it to the most recent linked
-- event id, clears to NULL when the join is empty.
--
-- Cascades:
--   • Deleting an event       → cascade-removes its join rows.
--                                The WO survives (the existing
--                                ON DELETE SET NULL on event_id
--                                also fires, clearing the
--                                denormalized hint). Matches the
--                                product rule: deleting a calendar
--                                block should never destroy a work
--                                order — just unschedule it.
--   • Deleting a work order   → cascade-removes its join rows
--                                (no dangling joins pointing at
--                                deleted action items).

CREATE TABLE IF NOT EXISTS maintenance_action_item_events (
  action_item_id uuid        NOT NULL REFERENCES maintenance_action_items(id) ON DELETE CASCADE,
  event_id       uuid        NOT NULL REFERENCES events(id)                   ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_item_id, event_id)
);

-- Both directions are indexed because both lookups happen in hot paths:
--   • By event_id     — EventModal's "WOs linked to this event"
--   • By action_item  — equipment board's bulk join for the WO list
CREATE INDEX IF NOT EXISTS idx_maint_aie_event
  ON maintenance_action_item_events(event_id);
CREATE INDEX IF NOT EXISTS idx_maint_aie_action_item
  ON maintenance_action_item_events(action_item_id);

-- Backfill the existing 1:1 links so nothing is lost when the
-- column-based reads switch over to join-based reads.
INSERT INTO maintenance_action_item_events (action_item_id, event_id)
SELECT id, event_id
  FROM maintenance_action_items
 WHERE event_id IS NOT NULL
ON CONFLICT DO NOTHING;
