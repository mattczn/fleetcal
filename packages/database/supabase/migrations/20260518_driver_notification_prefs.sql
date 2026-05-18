-- 20260518_driver_notification_prefs.sql
--
-- Per-driver opt-outs for auto-fired notification rules. Sparse table:
-- only rows for drivers who've explicitly toggled a rule (so a missing
-- row means "follow the org default"). The driver app writes via
-- PATCH /v1/driver/notification-prefs.
--
-- Resolution at send time (server-side, in apps/api):
--   1. Org rule disabled?            → don't send
--   2. Driver row exists + enabled=false → don't send
--   3. Otherwise                      → send
--
-- Manual dispatcher nudges (NotifyDriverPopover) bypass this and
-- always send — drivers can't fully silence their dispatcher.

CREATE TABLE IF NOT EXISTS driver_notification_prefs (
  driver_id   bigint NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  org_id      text   NOT NULL,
  rule_key    text   NOT NULL,
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_driver_notif_prefs_org_driver
  ON driver_notification_prefs(org_id, driver_id);

-- Keep updated_at fresh on row edits.
CREATE TRIGGER driver_notification_prefs_updated_at
  BEFORE UPDATE ON driver_notification_prefs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
