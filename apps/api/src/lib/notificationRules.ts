/**
 * Notification-rule resolution. Single source of truth for "should we
 * send notification X to driver Y right now?" Called from both the
 * synchronous notify path (e.g. on-assignment push) and the cron
 * sweeps (evening, pre-pickup, missing POD).
 *
 * Two layers:
 *   1. OrgSettings.notificationRules — admin-configured rule enable +
 *      tunables. Falls back to DEFAULT_NOTIFICATION_RULES if unset.
 *   2. driver_notification_prefs — sparse per-driver overrides. A
 *      missing row means "follow org default".
 *
 * Manual dispatcher nudges (NotifyDriverPopover) must NOT call this —
 * those should always send regardless of prefs (the dispatcher is
 * exercising their override, not auto-fire).
 */
import { supabase } from "./supabase.js";
import {
  DEFAULT_NOTIFICATION_RULES,
  NOTIFICATION_RULE_FIELD_FROM_KEY,
  type NotificationRuleKey,
  type NotificationRules,
} from "@fleetcal/types";

/** Merge an org's stored notification_rules JSONB onto DEFAULT_NOTIFICATION_RULES
 *  so callers always get a fully-populated shape. Each top-level rule
 *  spreads onto the default for that rule (so a rule with only
 *  {enabled: false} stored still gets default timing fields filled in). */
export function resolveOrgNotificationRules(
  stored: NotificationRules | null | undefined,
): NotificationRules {
  if (!stored) return DEFAULT_NOTIFICATION_RULES;
  return {
    eveningConfirmSweep: { ...DEFAULT_NOTIFICATION_RULES.eveningConfirmSweep, ...(stored.eveningConfirmSweep ?? {}) },
    prePickupConfirm:    { ...DEFAULT_NOTIFICATION_RULES.prePickupConfirm,    ...(stored.prePickupConfirm    ?? {}) },
    onAssignment:        { ...DEFAULT_NOTIFICATION_RULES.onAssignment,        ...(stored.onAssignment        ?? {}) },
    missingPodReminder:  { ...DEFAULT_NOTIFICATION_RULES.missingPodReminder,  ...(stored.missingPodReminder  ?? {}) },
    loadCancelled:       { ...DEFAULT_NOTIFICATION_RULES.loadCancelled,       ...(stored.loadCancelled       ?? {}) },
    reassignedAway:      { ...DEFAULT_NOTIFICATION_RULES.reassignedAway,      ...(stored.reassignedAway      ?? {}) },
  };
}

/** Read the org's full notification rules (with defaults filled in). */
export async function getOrgNotificationRules(orgId: string): Promise<NotificationRules> {
  const { data, error } = await supabase
    .from("org_settings")
    .select("notification_rules")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[notificationRules] org_settings lookup failed:", error);
    return DEFAULT_NOTIFICATION_RULES;
  }
  const stored = (data as { notification_rules: NotificationRules | null } | null)?.notification_rules ?? null;
  return resolveOrgNotificationRules(stored);
}

/** Fetch every driver_notification_prefs row for one driver. Returns
 *  a sparse map (only rules the driver has explicitly overridden). */
export async function getDriverNotificationPrefs(
  driverId: number,
): Promise<Map<NotificationRuleKey, boolean>> {
  // driver_notification_prefs lands via 20260518 migration; the
  // generated Database types in packages/types don't include this
  // table yet (regenerate after applying the migration). Cast around it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("driver_notification_prefs")
    .select("rule_key,enabled")
    .eq("driver_id", driverId);
  if (error) {
    console.error("[notificationRules] driver prefs lookup failed:", error);
    return new Map();
  }
  const rows = (data ?? []) as { rule_key: string; enabled: boolean }[];
  const out = new Map<NotificationRuleKey, boolean>();
  for (const r of rows) out.set(r.rule_key as NotificationRuleKey, r.enabled);
  return out;
}

/** Resolve whether a specific notification rule should fire for a
 *  specific driver. Layers org rule → driver override. Returns false
 *  whenever the org rule is disabled OR the driver has opted out.
 *
 *  Does NOT enforce time-of-day (cron tunables like timeOfDay /
 *  hoursBeforePickup are the cron's responsibility); only enforces
 *  rule-level on/off + quiet hours for the on_assignment rule. */
export async function shouldNotifyDriver(
  orgId: string,
  driverId: number,
  ruleKey: NotificationRuleKey,
  rules?: NotificationRules,
  driverPrefs?: Map<NotificationRuleKey, boolean>,
): Promise<boolean> {
  const resolvedRules = rules ?? await getOrgNotificationRules(orgId);
  const ruleField = NOTIFICATION_RULE_FIELD_FROM_KEY[ruleKey];
  const rule = resolvedRules[ruleField];
  if (!rule.enabled) return false;

  const prefs = driverPrefs ?? await getDriverNotificationPrefs(driverId);
  const override = prefs.get(ruleKey);
  if (override === false) return false;

  // on_assignment has optional quiet-hours suppression (org-tz time).
  // The cron rules (evening/prepickup/missingPod) gate timing themselves;
  // only the synchronous on_assignment path checks quiet hours here.
  if (ruleKey === "on_assignment") {
    const start = resolvedRules.onAssignment.quietHoursStart;
    const end   = resolvedRules.onAssignment.quietHoursEnd;
    if (start && end) {
      // TODO: thread the org's dispatch tz when org tz is wired through.
      // For now use the server time (UTC) which is consistent enough for
      // the single-org Curzon install. When multi-org lands, fetch the
      // org's dispatch tz from rate_con_settings.timezone and convert.
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const nowHm = `${hh}:${mm}`;
      const inQuiet = start <= end
        ? (nowHm >= start && nowHm < end)
        : (nowHm >= start || nowHm < end); // wraps midnight
      if (inQuiet) return false;
    }
  }
  return true;
}
