import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver } from '@/lib/push';

// Naive Mountain-Time string in the same format events.start uses
// ("YYYY-MM-DDTHH:mm"). All comparisons against events.start are string-safe
// because that column stores naive MT.
function nowMTString(offsetMs = 0): string {
  const target = new Date(Date.now() + offsetMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(target);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  // formatToParts can return "24" for hour at midnight on some runtimes
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}`;
}

function fmtPickup(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

interface PendingRow {
  id: string;
  org_id: string;
  driver_id: number;
  start: string;
  load_num: string | null;
}

/**
 * Vercel Cron — runs every 30 minutes (see vercel.json).
 * Sends a one-time push reminder to drivers for scheduled loads
 * starting within the next 12 hours.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 * Set CRON_SECRET in env to a random value.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not set' }, { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const nowMT    = nowMTString(0);
  const cutoffMT = nowMTString(12 * 60 * 60 * 1000);

  const db = getSupabase();
  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, start, load_num')
    .eq('status', 'scheduled')
    .is('deleted_at', null)
    .not('driver_id', 'is', null)
    .is('confirm_reminder_sent_at', null)
    .gte('start', nowMT)
    .lte('start', cutoffMT);

  if (error) {
    console.error('confirm-reminders query:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as PendingRow[];
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await sendPushToDriver(row.org_id, row.driver_id, {
        title: row.load_num ? `Confirm load #${row.load_num}` : 'Confirm load',
        body:  `Pickup at ${fmtPickup(row.start)}. Tap to confirm.`,
        data:  { type: 'confirm_reminder', eventId: row.id, url: `/load/${row.id}` },
      });
      const { error: updErr } = await db
        .from('events')
        .update({ confirm_reminder_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) {
        console.error('confirm-reminders stamp:', row.id, updErr);
        failed++;
      } else {
        sent++;
      }
    } catch (err) {
      console.error('confirm-reminders send:', row.id, err);
      failed++;
    }
  }

  return NextResponse.json({
    ok: true,
    window: { from: nowMT, to: cutoffMT },
    matched: rows.length,
    sent,
    failed,
  });
}
