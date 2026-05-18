/**
 * Expo Push send helpers — server-side. Used by the cron scheduler
 * (apps/api/src/jobs/confirmReminders.ts) to fire auto-notifications
 * to drivers, applying org rules + per-driver overrides.
 *
 * Mirrors apps/web/lib/push.ts. TODO: factor into a shared package
 * (packages/push or similar) once we have a third consumer.
 */
import { supabase } from "./supabase.js";
import {
  DEFAULT_NOTIFICATION_RULES,
  NOTIFICATION_RULE_FIELD_FROM_KEY,
  type NotificationRules,
  type NotificationRuleKey,
} from "@fleetcal/types";

export interface PushPayload {
  title: string;
  body:  string;
  data?: Record<string, unknown>;
}

interface ExpoMessage {
  to:    string;
  title: string;
  body:  string;
  data?: Record<string, unknown>;
  sound?: "default";
  priority?: "high";
}

interface ExpoTicket {
  status:  "ok" | "error";
  id?:     string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send a push notification to all registered devices for a driver.
 * Cleans up tokens that Expo reports as DeviceNotRegistered.
 */
export async function sendPushToDriver(
  orgId: string,
  driverId: number,
  payload: PushPayload,
): Promise<void> {
  const { data, error } = await supabase
    .from("driver_push_tokens")
    .select("token")
    .eq("driver_id", driverId)
    .eq("org_id",    orgId);

  if (error) { console.error("sendPushToDriver fetch tokens:", error); return; }
  const tokens = ((data ?? []) as { token: string }[]).map(r => r.token);
  if (tokens.length === 0) return;

  const messages: ExpoMessage[] = tokens.map(token => ({
    to:       token,
    title:    payload.title,
    body:     payload.body,
    data:     payload.data,
    sound:    "default",
    priority: "high",
  }));

  let res: Response;
  try {
    res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept":           "application/json",
        "Accept-encoding":  "gzip, deflate",
        "Content-Type":     "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error("sendPushToDriver fetch:", err);
    return;
  }

  if (!res.ok) {
    console.error("sendPushToDriver non-2xx:", res.status, await res.text().catch(() => ""));
    return;
  }

  const body = await res.json().catch(() => null) as { data?: ExpoTicket[] } | null;
  const tickets = body?.data ?? [];

  // Clean up dead tokens — Expo returns DeviceNotRegistered for uninstalled apps.
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
      dead.push(tokens[i]);
    }
  });
  if (dead.length > 0) {
    await supabase.from("driver_push_tokens").delete().in("token", dead);
  }
}

/** Resolve the org's notification rules (with defaults filled in). */
async function loadOrgNotificationRules(orgId: string): Promise<NotificationRules> {
  const { data, error } = await supabase
    .from("org_settings")
    .select("notification_rules")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.error("[push] org notification_rules lookup:", error);
    return DEFAULT_NOTIFICATION_RULES;
  }
  const stored = (data as { notification_rules: NotificationRules | null } | null)
    ?.notification_rules ?? null;
  if (!stored) return DEFAULT_NOTIFICATION_RULES;
  return {
    eveningConfirmSweep: { ...DEFAULT_NOTIFICATION_RULES.eveningConfirmSweep, ...(stored.eveningConfirmSweep ?? {}) },
    prePickupConfirm:    { ...DEFAULT_NOTIFICATION_RULES.prePickupConfirm,    ...(stored.prePickupConfirm    ?? {}) },
    onAssignment:        { ...DEFAULT_NOTIFICATION_RULES.onAssignment,        ...(stored.onAssignment        ?? {}) },
    missingPodReminder:  { ...DEFAULT_NOTIFICATION_RULES.missingPodReminder,  ...(stored.missingPodReminder  ?? {}) },
  };
}

/**
 * Auto-fired push variant. Checks the org's notification rule + the
 * driver's per-rule override before sending. Returns true if attempted,
 * false if suppressed. Manual dispatcher nudges bypass this — use the
 * bare sendPushToDriver for those.
 *
 * For on_assignment: optional eventStart (naive ISO) gates the push to
 * loads within the rule's hoursBeforeStart window.
 */
export async function sendAutoPushToDriver(
  orgId: string,
  driverId: number,
  ruleKey: NotificationRuleKey,
  payload: PushPayload,
  opts?: {
    rules?: NotificationRules;
    driverPrefs?: Record<string, boolean>;
    eventStart?: string | null;
  },
): Promise<boolean> {
  const rules = opts?.rules ?? await loadOrgNotificationRules(orgId);
  const rule  = rules[NOTIFICATION_RULE_FIELD_FROM_KEY[ruleKey]];
  if (!rule.enabled) return false;

  if (ruleKey === "on_assignment") {
    if (opts?.eventStart) {
      const startMs = Date.parse(opts.eventStart.replace(" ", "T"));
      if (isFinite(startMs)) {
        const hoursOut = (startMs - Date.now()) / 3_600_000;
        if (hoursOut > rules.onAssignment.hoursBeforeStart) return false;
      }
    }
    const start = rules.onAssignment.quietHoursStart;
    const end   = rules.onAssignment.quietHoursEnd;
    if (start && end) {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const inQuiet = start <= end
        ? (hm >= start && hm < end)
        : (hm >= start || hm < end);
      if (inQuiet) return false;
    }
  }

  // Driver per-rule override (sparse — missing means follow org default).
  // driver_notification_prefs lands via 20260518 migration; the generated
  // Database types don't include it yet (regenerate after applying).
  if (!opts?.driverPrefs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prefRows } = await (supabase as any)
      .from("driver_notification_prefs")
      .select("rule_key,enabled")
      .eq("driver_id", driverId);
    const rows = (prefRows ?? []) as { rule_key: string; enabled: boolean }[];
    const explicit = rows.find(r => r.rule_key === ruleKey);
    if (explicit && explicit.enabled === false) return false;
  } else if (opts.driverPrefs[ruleKey] === false) {
    return false;
  }

  await sendPushToDriver(orgId, driverId, payload);
  return true;
}
