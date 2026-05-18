import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver, sendAutoPushToDriver } from '@/lib/push';
import { NOTIFICATION_RULE_KEYS, type NotificationRuleKey } from '@fleetcal/types';

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
  const { orgId } = await auth();
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
    return NextResponse.json({ ok: true, sent });
  }
  await sendPushToDriver(orgId, payload.driverId, {
    title: payload.title,
    body:  payload.body,
    data:  payload.data,
  });
  return NextResponse.json({ ok: true, sent: true });
}
