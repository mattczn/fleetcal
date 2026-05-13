-- Dispatcher → driver nudge timeline.
--
-- Every push sent on behalf of a load (manual button, cron sweep, etc.)
-- records a row here. Dispatchers see a chronological history in the
-- load modal; drivers see a pending count badge on the load card.
--
-- A row is "pending" until the driver does the thing the nudge asked for
-- (status advances, POD uploaded, trailer reported, etc.) at which point
-- the server stamps `acknowledged_at`.

CREATE TABLE load_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text   NOT NULL,
  event_id        uuid   NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  load_id         uuid   REFERENCES loads(id) ON DELETE CASCADE,
  driver_id       bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  -- Valid kinds: 'confirm', 'mark_pickup', 'mark_delivery',
  -- 'upload_pod', 'report_trailer'. Stored as text (not an enum) so the
  -- set can evolve without a migration.
  kind            text   NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  -- Name shown in the audit timeline. 'Auto: evening sweep' /
  -- 'Auto: 6h reminder' for cron-fired rows.
  sent_by_name    text   NOT NULL,
  acknowledged_at timestamptz
);

-- Driver-side pending-count query: scan all unacknowledged rows for the
-- driver, group by event_id.
CREATE INDEX idx_load_notifications_driver_pending
  ON load_notifications (driver_id, event_id)
  WHERE acknowledged_at IS NULL;

-- Dispatcher-side history-by-load query: list all notifications for an
-- event ordered by sent_at desc.
CREATE INDEX idx_load_notifications_event_sent
  ON load_notifications (event_id, sent_at DESC);

-- Repeat-suppression check: "did we send this kind for this event in
-- the last N minutes?" → used by the soft-confirm dialog and by cron
-- to avoid double-sending across rule overlaps.
CREATE INDEX idx_load_notifications_event_kind_sent
  ON load_notifications (event_id, kind, sent_at DESC);
