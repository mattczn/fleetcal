import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver, sendAutoPushToDriver } from '@/lib/push';
import { NOTIFICATION_RULE_KEYS, type NotificationRuleKey } from '@fleetcal/types';

const RAILWAY_URL =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

interface SendBody {
  driverId: number;
  title:    string;
  body:     string;
  data?:    Record<string, unknown>;
  /** If set, the server applies the org notification rule + driver
   *  per-rule override check before sending. Without it, the push
   *  fires unconditionally — used for protective notifications
   *  (cancellation, reassign-away) and manual dispatcher nudges. */
  ruleKey?: string;
  /** For on_assignment pushes — the load's start time (naive ISO in
   *  dispatch zone). Used to enforce the `hoursBeforeStart` window. */
  eventStart?: string | null;
}

export async function POST(req: Request) {
  const { orgId, getToken } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const payload = (await req.json().catch(() => null)) as SendBody | null;
  if (!payload || typeof payload.driverId !== 'number' || !payload.title || !payload.body) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Verify the driver belongs to the requesting org
  const db = getSupabase();
  const { data: driver, error } = await db
    .from('drivers')
    .select('id')
    .eq('id', payload.driverId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error)  return NextResponse.json({ error: error.message },        { status: 500 });
  if (!driver) return NextResponse.json({ error: 'Driver not found' },  { status: 404 });

  // Route via auto-fire (rule-gated) or direct (unconditional).
  if (payload.ruleKey && NOTIFICATION_RULE_KEYS.includes(payload.ruleKey as NotificationRuleKey)) {
    const sent = await sendAutoPushToDriver(
      orgId,
      payload.driverId,
      payload.ruleKey as NotificationRuleKey,
      { title: payload.title, body: payload.body, data: payload.data },
      { eventStart: payload.eventStart ?? null },
    );
    // Record into load_notifications so the bell history captures it.
    // We can't insert directly here — the web only has anon Supabase
    // access. Delegate to Railway (which has the service-role key) via
    // the dedicated record-auto-notification endpoint, authenticated
    // with the dispatcher's Clerk JWT.
    if (sent) {
      await recordViaRailway(getToken, payload.ruleKey as NotificationRuleKey, payload.driverId, payload.data);
    }
    return NextResponse.json({ ok: true, sent });
  }
  // Direct (unconditional) — used for protective notifications like
  // reassign-away. Still record so the bumped driver gets a history
  // entry on their bell.
  await sendPushToDriver(orgId, payload.driverId, {
    title: payload.title,
    body:  payload.body,
    data:  payload.data,
  });
  await recordViaRailway(getToken, null, payload.driverId, payload.data);
  return NextResponse.json({ ok: true, sent: true });
}

/**
 * Map (ruleKey, data) onto a LoadNotificationKind and POST to Railway
 * so the row lands in load_notifications under service-role auth.
 *
 * Why not write directly from here? The web Supabase client is anon-
 * keyed and writes to load_notifications fail silently — that bug is
 * what caused the bell history to be empty even though pushes were
 * landing on drivers' phones.
 */
async function recordViaRailway(
  getToken: () => Promise<string | null>,
  ruleKey: NotificationRuleKey | null,
  driverId: number,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  const eventId = typeof data?.eventId === 'string' ? data.eventId : null;
  if (!eventId) return; // can't anchor the row to anything
  const loadId  = typeof data?.loadId  === 'string' ? data.loadId  : null;
  const dataType = typeof data?.type === 'string' ? data.type : null;

  // Map ruleKey + data.type onto a LoadNotificationKind.
  let kind: string | null = null;
  let label = 'Auto';
  if (ruleKey === 'on_assignment') {
    kind = 'assigned';
    label = dataType === 'last_minute_assign' ? 'Auto: assignment (last-minute)' : 'Auto: assignment';
  } else if (ruleKey === 'evening_confirm_sweep' || ruleKey === 'pre_pickup_confirm') {
    kind = 'confirm';
    label = ruleKey === 'evening_confirm_sweep' ? 'Auto: evening sweep' : 'Auto: pre-pickup reminder';
  } else if (ruleKey === 'missing_pod_reminder') {
    kind = 'upload_pod';
    label = 'Auto: missing POD reminder';
  } else if (dataType === 'reassigned_away') {
    kind = 'reassigned_away';
    label = 'Auto: load reassigned';
  } else if (dataType === 'load_cancelled') {
    kind = 'load_cancelled';
    label = 'Auto: load cancelled';
  }
  if (!kind) return;

  try {
    const token = await getToken();
    if (!token) {
      console.error('[driver-push] no Clerk token, skipping record');
      return;
    }
    const res = await fetch(
      `${RAILWAY_URL}/v1/events/${eventId}/record-auto-notification`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ kind, driverId, loadId, sentByName: label }),
      },
    );
    if (!res.ok) {
      console.error('[driver-push] record-auto-notification failed:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[driver-push] record-auto-notification error:', err);
  }
}
