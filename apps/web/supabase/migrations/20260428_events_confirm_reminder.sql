ALTER TABLE events
  ADD COLUMN IF NOT EXISTS confirm_reminder_sent_at timestamptz;

-- Partial index to keep the cron scan cheap as the table grows
CREATE INDEX IF NOT EXISTS idx_events_pending_confirm_reminder
  ON events (start)
  WHERE status = 'scheduled'
    AND deleted_at IS NULL
    AND driver_id IS NOT NULL
    AND confirm_reminder_sent_at IS NULL;
