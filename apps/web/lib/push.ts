import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_NOTIFICATION_RULES,
  NOTIFICATION_RULE_FIELD_FROM_KEY,
  type NotificationRules,
  type NotificationRuleKey,
} from '@fleetcal/types';

/**
 * Server-side admin Supabase client (service-role). This module only
 * runs server-side (Next.js API routes, server actions) — never in
 * the browser. The previous getSupabase() flow returned an anon-key
 * client whose Clerk-token bridge is browser-only, so on the server
 * every Supabase call went anon-only and 401'd as soon as RLS was
 * enabled on drivers / driver_push_tokens / org_settings. Service-role
 * bypasses RLS and is the correct pattern for trusted server code.
 */
let _adminClient: SupabaseClient | null = null;
function adminDb(): SupabaseClient {
  if (_adminClient) return _adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var');
  }
  _adminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _adminClient;
}

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
  sound?: 'default';
  priority?: 'high';
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?:    string;
  message?: string;
  details?: { error?: string };
}

/**
 * Send a push notification to all registered devices for a driver.
 * Uses Expo's push API (https://exp.host/--/api/v2/push/send) directly —
 * no Expo account needed, just a free service that fans out to APNs/FCM.
 *
 * Cleans up tokens that Expo reports as DeviceNotRegistered.
 */
export async function sendPushToDriver(
  orgId: string,
  driverId: number,
  payload: PushPayload,
): Promise<void> {
  const db = adminDb();
  const { data, error } = await db
    .from('driver_push_tokens')
    .select('token')
    .eq('driver_id', driverId)
    .eq('org_id',    orgId);

  if (error) { console.error('sendPushToDriver fetch tokens:', error); return; }
  const tokens = (data ?? []).map(r => r.token as string);
  if (tokens.length === 0) return;

  const messages: ExpoMessage[] = tokens.map(token => ({
    to:       token,
    title:    payload.title,
    body:     payload.body,
    data:     payload.data,
    sound:    'default',
    priority: 'high',
  }));

  // Expo's enhanced push security (rolled out 2024+) requires a
  // Bearer access token when the target Expo project has "Send-only
  // access token" enforcement enabled. Without it, Expo returns 200
  // OK at the HTTP layer but every ticket comes back with status
  // 'error' and the actual push never delivers. This is the
  // exact silent failure that killed both Curzon's old installs AND
  // the new FleetCal builds on 2026-06-22 — same project id, same
  // enforcement, both pipelines died at once.
  //
  // Set EXPO_ACCESS_TOKEN in Vercel env (project Settings → Environment
  // Variables). The token is generated in the Expo dashboard at
  // https://expo.dev/accounts/<account>/settings/access-tokens — use a
  // send-only scope. If unset we fall through without auth so dev/local
  // still works for projects that haven't enabled enforcement yet,
  // but we log a warning so the gap is visible in logs.
  const expoAccessToken = process.env.EXPO_ACCESS_TOKEN;
  if (!expoAccessToken) {
    console.warn('[sendPushToDriver] EXPO_ACCESS_TOKEN not set — push will silently fail if Expo project has enhanced security enabled.');
  }

  let res: Response;
  try {
    res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept':           'application/json',
        'Accept-encoding':  'gzip, deflate',
        'Content-Type':     'application/json',
        ...(expoAccessToken ? { 'Authorization': `Bearer ${expoAccessToken}` } : {}),
      },
      body: JSON.stringify(messages),
    });
  } catch (err) {
    console.error('sendPushToDriver fetch:', err);
    return;
  }

  if (!res.ok) {
    console.error('sendPushToDriver non-2xx:', res.status, await res.text().catch(() => ''));
    return;
  }

  const body = await res.json().catch(() => null) as { data?: ExpoTicket[] } | null;
  const tickets = body?.data ?? [];

  // Surface EVERY ticket error — not just DeviceNotRegistered. Without
  // this, an auth failure / project mismatch / quota issue returns
  // status=error tickets that we previously dropped on the floor.
  // The new log line is the diagnostic surface for "I clicked notify
  // and nothing happened" — grep `[sendPushToDriver] expo error` in
  // Vercel function logs.
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (t.status !== 'error') return;
    const errKind = t.details?.error ?? 'unknown';
    console.error(
      `[sendPushToDriver] expo error ticket: kind=${errKind} message=${t.message ?? ''} token=${tokens[i]?.slice(0, 20)}...`,
    );
    if (errKind === 'DeviceNotRegistered') dead.push(tokens[i]);
  });
  if (dead.length > 0) {
    await db.from('driver_push_tokens').delete().in('token', dead);
  }
}

/** Resolve the per-org notification rules (with defaults filled in). */
async function loadOrgNotificationRules(orgId: string): Promise<NotificationRules> {
  const db = adminDb();
  const { data, error } = await db
    .from('org_settings')
    .select('notification_rules')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    console.error('[push] org notification_rules lookup:', error);
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
    loadCancelled:       { ...DEFAULT_NOTIFICATION_RULES.loadCancelled,       ...(stored.loadCancelled       ?? {}) },
    reassignedAway:      { ...DEFAULT_NOTIFICATION_RULES.reassignedAway,      ...(stored.reassignedAway      ?? {}) },
  };
}

/**
 * Auto-fired push variant. Checks the org's notification rule + the
 * driver's per-rule override before sending. Returns true if the push
 * was attempted, false if suppressed by config.
 *
 * Manual dispatcher nudges (NotifyDriverPopover) should use the bare
 * sendPushToDriver — they're an escape hatch and bypass rules.
 *
 * For on_assignment specifically:
 *   - Optional `eventStart` (naive ISO in dispatch zone) gates the
 *     push to loads starting within `hoursBeforeStart` from now. Far-
 *     out assignments rely on the evening confirm sweep instead.
 *   - Optional quiet-hours window suppresses pushes between start/end.
 */
export async function sendAutoPushToDriver(
  orgId: string,
  driverId: number,
  ruleKey: NotificationRuleKey,
  payload: PushPayload,
  opts?: {
    rules?: NotificationRules;
    driverPrefs?: Record<string, boolean>;
    /** Naive ISO of the event start ("YYYY-MM-DDTHH:mm"); used by
     *  on_assignment rule to enforce hoursBeforeStart. Ignored for
     *  other rules. */
    eventStart?: string | null;
  },
): Promise<boolean> {
  const db = adminDb();
  const rules = opts?.rules ?? await loadOrgNotificationRules(orgId);
  const rule  = rules[NOTIFICATION_RULE_FIELD_FROM_KEY[ruleKey]];
  if (!rule.enabled) return false;

  if (ruleKey === 'on_assignment') {
    // Window check: only push when the load is starting soon enough.
    // Treat the naive ISO as local server time (good enough for the
    // single-org Curzon install; thread org tz in when multi-org lands).
    if (opts?.eventStart) {
      const startMs = Date.parse(opts.eventStart.replace(' ', 'T'));
      if (isFinite(startMs)) {
        const hoursOut = (startMs - Date.now()) / 3_600_000;
        if (hoursOut > rules.onAssignment.hoursBeforeStart) return false;
      }
    }
    // Quiet hours apply to on_assignment only — cron rules manage
    // their own timing via tunables.
    const start = rules.onAssignment.quietHoursStart;
    const end   = rules.onAssignment.quietHoursEnd;
    if (start && end) {
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const inQuiet = start <= end
        ? (hm >= start && hm < end)
        : (hm >= start || hm < end); // wraps midnight
      if (inQuiet) return false;
    }
  }

  // Cancel + reassign-away both gate on "is the pickup within
  // hoursBeforeStart from now". Same pattern as on_assignment but
  // without the quiet-hours suppression — these are protective
  // notifications and an overnight cancel is exactly the kind of
  // thing the driver wants to know about before they hit the road.
  // Loads in the past get filtered too (hoursOut <= 0) so we don't
  // ping about cancellations of loads already in progress / delivered.
  if (ruleKey === 'load_cancelled' || ruleKey === 'reassigned_away') {
    if (!opts?.eventStart) return false;
    const startMs = Date.parse(opts.eventStart.replace(' ', 'T'));
    if (!isFinite(startMs)) return false;
    const hoursOut = (startMs - Date.now()) / 3_600_000;
    const windowH  = ruleKey === 'load_cancelled'
      ? rules.loadCancelled.hoursBeforeStart
      : rules.reassignedAway.hoursBeforeStart;
    if (hoursOut <= 0 || hoursOut > windowH) return false;
  }

  // Driver per-rule override (sparse — missing means follow org default).
  if (!opts?.driverPrefs) {
    const { data: prefRows } = await db
      .from('driver_notification_prefs')
      .select('rule_key,enabled')
      .eq('driver_id', driverId);
    const rows = (prefRows ?? []) as { rule_key: string; enabled: boolean }[];
    const explicit = rows.find(r => r.rule_key === ruleKey);
    if (explicit && explicit.enabled === false) return false;
  } else if (opts.driverPrefs[ruleKey] === false) {
    return false;
  }

  await sendPushToDriver(orgId, driverId, payload);
  return true;
}
