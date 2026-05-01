import { getSupabase } from './supabase';

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
  const db = getSupabase();
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

  let res: Response;
  try {
    res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept':           'application/json',
        'Accept-encoding':  'gzip, deflate',
        'Content-Type':     'application/json',
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

  // Clean up dead tokens — Expo returns DeviceNotRegistered for uninstalled apps
  const dead: string[] = [];
  tickets.forEach((t, i) => {
    if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
      dead.push(tokens[i]);
    }
  });
  if (dead.length > 0) {
    await db.from('driver_push_tokens').delete().in('token', dead);
  }
}
