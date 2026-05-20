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
    // Record into load_notifications so the driver's bell shows the
    // historical entry. Only auto-fire paths land here — the manual
    // dispatcher nudge popover records via /v1/events/:id/notify
    // already (so we'd double-insert if we touched the non-ruleKey
    // branch below). Assignment / reassign-away rows are auto-acked
    // since they're informational and shouldn't count toward the
    // pending badge.
    if (sent) {
      await recordNotification(
        db, orgId, payload.driverId, payload.ruleKey as NotificationRuleKey, payload.data,
      );
    }
    return NextResponse.json({ ok: true, sent });
  }
  // Direct (unconditional) — used for protective notifications like
  // reassign-away. Still record so the new driver and the bumped
  // driver both have a history entry.
  await sendPushToDriver(orgId, payload.driverId, {
    title: payload.title,
    body:  payload.body,
    data:  payload.data,
  });
  await recordNotification(db, orgId, payload.driverId, null, payload.data);
  return NextResponse.json({ ok: true, sent: true });
}

/**
 * Insert a load_notifications row that mirrors a push that was just
 * sent. The bell on the driver app reads this table — without an insert
 * here, drivers see push toasts but nothing in their history.
 *
 * Maps the rule key + data.type onto the LoadNotificationKind union.
 * Informational kinds (assigned, reassigned_away) are auto-acked since
 * the driver isn't expected to do anything in response. Action-required
 * kinds (confirm, upload_pod, mark_pickup…) are left pending so the
 * badge counter reflects them.
 */
async function recordNotification(
  db: ReturnType<typeof getSupabase>,
  orgId: string,
  driverId: number,
  ruleKey: NotificationRuleKey | null,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  const eventId = typeof data?.eventId === 'string' ? data.eventId : null;
  if (!eventId) return; // can't anchor the row to anything
  const loadId  = typeof data?.loadId  === 'string' ? data.loadId  : null;
  const dataType = typeof data?.type === 'string' ? data.type : null;

  // Map ruleKey + data.type onto a LoadNotificationKind (table check
  // constraint). Defensive: if we can't classify it, skip.
  let kind: string | null = null;
  let label = 'Auto';
  let autoAck = false;
  if (ruleKey === 'on_assignment') {
    kind = 'assigned';
    label = dataType === 'last_minute_assign' ? 'Auto: assignment (last-minute)' : 'Auto: assignment';
    autoAck = true; // informational
  } else if (ruleKey === 'evening_confirm_sweep' || ruleKey === 'pre_pickup_confirm') {
    kind = 'confirm';
    label = ruleKey === 'evening_confirm_sweep' ? 'Auto: evening sweep' : 'Auto: pre-pickup reminder';
  } else if (ruleKey === 'missing_pod_reminder') {
    kind = 'upload_pod';
    label = 'Auto: missing POD reminder';
  } else if (dataType === 'reassigned_away') {
    kind = 'reassigned_away';
    label = 'Auto: load reassigned';
    autoAck = true; // informational
  }
  if (!kind) return;

  const { error } = await db.from('load_notifications').insert({
    org_id:          orgId,
    event_id:        eventId,
    load_id:         loadId,
    driver_id:       driverId,
    kind,
    sent_by_name:    label,
    acknowledged_at: autoAck ? new Date().toISOString() : null,
  } as never);
  if (error) console.error('[driver-push] load_notifications insert:', error);
}
