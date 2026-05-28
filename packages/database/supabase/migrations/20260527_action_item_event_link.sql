-- 20260527_action_item_event_link.sql
--
-- Link maintenance work orders (maintenance_action_items) to calendar
-- events (events). Many-to-one: a single in-shop day can carry several
-- work orders (brakes + trans flush + DOT inspection = three orders,
-- one calendar block). The reverse — one work order, one event — is
-- the typical case.
--
-- The link lives on the work-order side because:
--   1. Work orders are the canonical record of "this needs to be done."
--      Calendar events are scheduling/availability artifacts on top.
--   2. Querying "which work orders are scheduled into this event" is
--      the more common direction (the calendar surface fetches it
--      when the dispatcher opens a maintenance block).
--
-- ON DELETE SET NULL is intentional: deleting a calendar event does
-- NOT delete the work order — it just unlinks it. The work order
-- stays open in the maintenance backlog so the dispatcher can
-- reschedule it without re-creating the task / losing the history.
-- This matches our cascade policy elsewhere (events → loads, etc.):
-- the lighter scheduling artifact disappears, the heavier work record
-- survives.

ALTER TABLE maintenance_action_items
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES events(id) ON DELETE SET NULL;

-- Index supports the calendar-side query: "give me every work order
-- linked to event X". Without this, opening a maintenance event would
-- do a full scan of the action-items table.
CREATE INDEX IF NOT EXISTS idx_maint_action_items_event
  ON maintenance_action_items(event_id)
  WHERE event_id IS NOT NULL;
