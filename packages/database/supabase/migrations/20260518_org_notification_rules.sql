-- 20260518_org_notification_rules.sql
--
-- Per-org driver-notification configuration. Stored as JSONB on
-- org_settings to keep the existing GET/PATCH /v1/org-settings flow
-- as the single round-trip surface. Four rules, each independently
-- toggleable + tunable:
--
--   evening_confirm_sweep  — daily "you have unconfirmed loads
--                            tomorrow" aggregate push.
--                            params: timeOfDay (HH:MM, org-local),
--                            lookAheadHours.
--   pre_pickup_confirm     — fires once when pickup is within N
--                            hours and the load isn't yet confirmed.
--                            param: hoursBeforePickup.
--   on_assignment          — synchronous push when a load is
--                            assigned to a driver. params: optional
--                            quietHoursStart / quietHoursEnd (org
--                            local; suppress within this window).
--   missing_pod_reminder   — N hours after delivered, if no POD on
--                            the load, nudge the driver.
--                            param: hoursAfterDelivery.
--
-- Manual dispatcher nudges (NotifyDriverPopover) bypass these rules
-- entirely — they're an escape hatch and should always go through.
--
-- Defaults below match the existing hardcoded behavior plus the new
-- POD reminder (off by default — opt-in).

ALTER TABLE org_settings
  ADD COLUMN IF NOT EXISTS notification_rules jsonb;

UPDATE org_settings
   SET notification_rules = '{
         "eveningConfirmSweep": {
           "enabled": true,
           "timeOfDay": "19:00",
           "lookAheadHours": 18
         },
         "prePickupConfirm": {
           "enabled": true,
           "hoursBeforePickup": 6
         },
         "onAssignment": {
           "enabled": true
         },
         "missingPodReminder": {
           "enabled": false,
           "hoursAfterDelivery": 24
         }
       }'::jsonb
 WHERE notification_rules IS NULL;
