-- Driver-side confirmation state for assigned loads.
--
-- `confirmed_at`     — set when the driver taps "Confirm" in the driver app.
--                      Cleared when the load is reassigned to a different
--                      driver so the new driver re-confirms.
-- `confirmed_by`     — driver_id who confirmed (matches the assignment at
--                      the time of confirmation; survives reassignment as
--                      audit trail until cleared by the reassignment).
--
-- The existing `confirm_reminder_sent_at` column tracks reminder-cron output
-- and is intentionally separate — multiple sweep rules will stamp it.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by bigint REFERENCES drivers(id) ON DELETE SET NULL;

-- Cron sweeps filter by "unconfirmed + has driver + scheduled-ish" — index it.
CREATE INDEX IF NOT EXISTS idx_events_unconfirmed_by_start
  ON events (start)
  WHERE confirmed_at IS NULL
    AND deleted_at IS NULL
    AND driver_id IS NOT NULL
    AND status IN ('scheduled', 'assigned', 'dispatched');

-- Idempotency for the 7 PM driver-local "evening sweep": one row per
-- (org, driver, local-calendar-date). Cron upserts here before sending so
-- duplicate scheduler ticks within the same 60-min window can't double-send.
CREATE TABLE IF NOT EXISTS driver_evening_sweeps (
  org_id        text   NOT NULL,
  driver_id     bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  local_date    date   NOT NULL,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  load_count    int    NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, driver_id, local_date)
);
