/**
 * Driver-notification configuration types.
 *
 * Two layers:
 *   1. Org-level rules — stored on OrgSettings.notificationRules,
 *      configured by an admin in Settings → Driver App → Notifications.
 *   2. Per-driver overrides — stored in driver_notification_prefs
 *      (sparse table), configured by each driver in their app's
 *      Notifications screen. Sparse: missing row → follow org default.
 *
 * Send-time resolution (apps/api shouldNotifyDriver helper):
 *   1. Org rule disabled?              → don't send.
 *   2. Driver row exists + enabled=false → don't send.
 *   3. Otherwise → send.
 *
 * Manual dispatcher nudges (NotifyDriverPopover) bypass this entirely.
 */

/** Stable identifiers for each auto-fired notification rule. Keep
 *  these in sync with the DB JSON keys + driver_notification_prefs.rule_key. */
export const NOTIFICATION_RULE_KEYS = [
  "evening_confirm_sweep",
  "pre_pickup_confirm",
  "on_assignment",
  "missing_pod_reminder",
  "load_cancelled",
  "reassigned_away",
] as const;
export type NotificationRuleKey = typeof NOTIFICATION_RULE_KEYS[number];

/** Each rule's per-org config. All `enabled` defaults are true except
 *  missing_pod_reminder which is opt-in (new behavior). */
export interface EveningConfirmSweepRule {
  enabled:        boolean;
  /** Local HH:MM in the org's dispatch tz. The cron fires this rule
   *  when the current org-local time falls within [timeOfDay, timeOfDay+15min). */
  timeOfDay:      string;
  /** How far ahead to look for unconfirmed loads (hours). */
  lookAheadHours: number;
}
export interface PrePickupConfirmRule {
  enabled:           boolean;
  /** Fire when pickup is within [hoursBeforePickup-0.5, hoursBeforePickup+0.5) hours. */
  hoursBeforePickup: number;
}
export interface OnAssignmentRule {
  enabled: boolean;
  /** Only fire the immediate push when the assigned load's start time
   *  is within this many hours from now. Loads scheduled further out
   *  rely on the evening confirm sweep instead — no point pinging a
   *  driver about a load that's 4 days away. */
  hoursBeforeStart: number;
  /** Optional quiet-hours window in the org's dispatch tz (HH:MM).
   *  When the current org-local time is inside [start, end), the
   *  synchronous push is suppressed. null/undefined → always fire. */
  quietHoursStart?: string | null;
  quietHoursEnd?:   string | null;
}
export interface MissingPodReminderRule {
  enabled:            boolean;
  /** Fire when an event delivered N hours ago still has no kind='pod'
   *  document and no missing_pod nudge has been sent. */
  hoursAfterDelivery: number;
}
export interface LoadCancelledRule {
  enabled: boolean;
  /** Only fire the cancel push when the load's pickup is within this
   *  many hours from now. Cancels of loads weeks out aren't urgent —
   *  driver sees it on the next schedule open. */
  hoursBeforeStart: number;
}
export interface ReassignedAwayRule {
  enabled: boolean;
  /** Only fire the reassign-away push when the load's pickup is
   *  within this many hours from now. Same reasoning as cancel —
   *  loads far out get picked up via the regular schedule view. */
  hoursBeforeStart: number;
}

export interface NotificationRules {
  eveningConfirmSweep: EveningConfirmSweepRule;
  prePickupConfirm:    PrePickupConfirmRule;
  onAssignment:        OnAssignmentRule;
  missingPodReminder:  MissingPodReminderRule;
  loadCancelled:       LoadCancelledRule;
  reassignedAway:      ReassignedAwayRule;
}

/** Defaults applied when the org has no notification_rules row yet
 *  (or when an individual rule key is missing from the stored JSONB).
 *  Server falls back to these so behavior is well-defined regardless
 *  of DB state. The migration backfills with these same values. */
export const DEFAULT_NOTIFICATION_RULES: NotificationRules = {
  eveningConfirmSweep: { enabled: true,  timeOfDay: "19:00", lookAheadHours: 18 },
  prePickupConfirm:    { enabled: true,  hoursBeforePickup: 6 },
  onAssignment:        { enabled: true,  hoursBeforeStart: 12, quietHoursStart: null, quietHoursEnd: null },
  missingPodReminder:  { enabled: false, hoursAfterDelivery: 24 },
  loadCancelled:       { enabled: true,  hoursBeforeStart: 24 },
  reassignedAway:      { enabled: true,  hoursBeforeStart: 24 },
};

/** UI copy for the four rules — used in both the dispatch web settings
 *  panel and the driver app's notification screen. */
export const NOTIFICATION_RULE_LABEL: Record<NotificationRuleKey, string> = {
  evening_confirm_sweep: "Evening confirm reminder",
  pre_pickup_confirm:    "Pre-pickup confirm reminder",
  on_assignment:         "New load assigned",
  missing_pod_reminder:  "Missing POD reminder",
  load_cancelled:        "Load cancelled",
  reassigned_away:       "Load reassigned away",
};

export const NOTIFICATION_RULE_BLURB: Record<NotificationRuleKey, string> = {
  evening_confirm_sweep: "Daily aggregate push the night before listing unconfirmed loads coming up.",
  pre_pickup_confirm:    "One-shot reminder a few hours before pickup if the load isn't confirmed yet.",
  on_assignment:         "Immediate push when a load is assigned. Optional quiet hours suppress overnight assigns.",
  missing_pod_reminder:  "Nudge the driver to upload a POD when one hasn't landed within the configured window after delivery.",
  load_cancelled:        "Push the driver if a load they were assigned gets cancelled within the configured window before pickup.",
  reassigned_away:       "Push the driver if a load they were assigned gets handed to someone else within the configured window before pickup.",
};

/** Map a NotificationRules key (camelCase JSON) to the matching
 *  NotificationRuleKey (snake_case stable id). Used so the driver
 *  prefs table key and the OrgSettings JSON key stay aligned even
 *  though one is snake and the other is camel. */
export const NOTIFICATION_RULE_KEY_FROM_FIELD: Record<keyof NotificationRules, NotificationRuleKey> = {
  eveningConfirmSweep: "evening_confirm_sweep",
  prePickupConfirm:    "pre_pickup_confirm",
  onAssignment:        "on_assignment",
  missingPodReminder:  "missing_pod_reminder",
  loadCancelled:       "load_cancelled",
  reassignedAway:      "reassigned_away",
};
export const NOTIFICATION_RULE_FIELD_FROM_KEY: Record<NotificationRuleKey, keyof NotificationRules> = {
  evening_confirm_sweep: "eveningConfirmSweep",
  pre_pickup_confirm:    "prePickupConfirm",
  on_assignment:         "onAssignment",
  missing_pod_reminder:  "missingPodReminder",
  load_cancelled:        "loadCancelled",
  reassigned_away:       "reassignedAway",
};

/** Per-driver row in driver_notification_prefs. Sparse — only stored
 *  when the driver has explicitly overridden the org default. */
export interface DriverNotificationPref {
  ruleKey: NotificationRuleKey;
  enabled: boolean;
}
