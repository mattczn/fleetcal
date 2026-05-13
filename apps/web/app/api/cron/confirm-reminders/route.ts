import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver } from '@/lib/push';

/**
 * Vercel Cron — runs every 30 minutes (see vercel.json). Implements two
 * automatic confirm-reminder rules; the last-minute-assignment rule
 * lives in the dispatcher store on driver assignment, not here.
 *
 *   1. Evening sweep        — between 7 PM and 8 PM driver-local
 *                             (currently org-wide MT since events.start
 *                             is stored as naive Mountain Time). One
 *                             push per driver covering ALL unconfirmed
 *                             scheduled loads in the next 18h. Per
 *                             load, also inserts a load_notifications
 *                             row with kind='confirm' so the dispatcher
 *                             timeline + driver pending-count surfaces
 *                             it. Idempotent at the driver level via
 *                             driver_evening_sweeps (org_id, driver_id,
 *                             local_date).
 *   2. Six-hour-out sweep   — per-load: any unconfirmed event whose
 *                             pickup is 5.5–6.5h away gets a one-shot
 *                             push + load_notifications row.
 *                             Idempotent via "no confirm notification
 *                             sent for this event in the last 24h" so
 *                             evening-sweep coverage isn't re-pinged
 *                             6h before pickup.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
 */

// ── Time helpers ───────────────────────────────────────────────────────
// events.start is stored as naive Mountain-Time string, "YYYY-MM-DDTHH:mm".
// All time math compares against MT-string snapshots so we don't have to
// reason about UTC offsets.

const TZ = 'America/Denver';

function naiveMT(date: Date): { date: string; time: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return {
    date:   `${get('year')}-${get('month')}-${get('day')}`,
    time:   `${hh}:${get('minute')}`,
    hour:   parseInt(hh, 10),
    minute: parseInt(get('minute'), 10),
  };
}

function naiveMTString(offsetMs = 0): string {
  const n = naiveMT(new Date(Date.now() + offsetMs));
  return `${n.date}T${n.time}`;
}

function fmtPickup(naive: string): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return naive;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

interface PendingRow {
  id:        string;
  org_id:    string;
  driver_id: number;
  load_id:   string | null;
  start:     string;
  load:      { load_num: string | null } | { load_num: string | null }[] | null;
}

// Best-effort insert into load_notifications. Failures are logged but
// don't stop the sweep — the push has already gone out at this point.
async function recordConfirmNudge(
  db: ReturnType<typeof getSupabase>,
  row: PendingRow,
  sentByName: string,
): Promise<void> {
  const { error } = await db.from('load_notifications').insert({
    org_id:       row.org_id,
    event_id:     row.id,
    load_id:      row.load_id,
    driver_id:    row.driver_id,
    kind:         'confirm',
    sent_by_name: sentByName,
  });
  if (error) {
    console.error('[load_notifications insert]', row.id, error);
  }
}

// ── Rule 1: Evening sweep ──────────────────────────────────────────────
// Fires once per driver per local-date when current MT hour ∈ [19, 20).
// Aggregates all their unconfirmed scheduled loads in the next 18h into
// one push. Per load, records a load_notifications row.

async function runEveningSweep(db: ReturnType<typeof getSupabase>) {
  const nowMT = naiveMT(new Date());
  if (nowMT.hour !== 19) return { sent: 0, skipped: 'not_evening_window', drivers: 0 };

  const nowStr   = naiveMTString(0);
  const cutoff18 = naiveMTString(18 * 60 * 60 * 1000);

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, load_id, start, load:loads(load_num)')
    .in('status', ['scheduled', 'assigned', 'dispatched'])
    .is('deleted_at', null)
    .is('confirmed_at', null)
    .not('driver_id', 'is', null)
    .gte('start', nowStr)
    .lte('start', cutoff18);
  if (error) { console.error('eveningSweep query:', error); return { sent: 0, error: error.message, drivers: 0 }; }

  const rows = (data ?? []) as PendingRow[];

  type GroupKey = string; // `${org_id}|${driver_id}`
  const groups = new Map<GroupKey, PendingRow[]>();
  for (const r of rows) {
    const key = `${r.org_id}|${r.driver_id}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  let sent = 0; let failed = 0; let alreadySent = 0;
  const today = nowMT.date;

  for (const [key, loads] of groups) {
    const [orgId, driverIdStr] = key.split('|');
    const driverId = Number(driverIdStr);

    // Idempotency claim — atomically insert the (org, driver, date)
    // row. 23505 = duplicate key = already sent today.
    const { error: upsertErr } = await db
      .from('driver_evening_sweeps')
      .insert({ org_id: orgId, driver_id: driverId, local_date: today, load_count: loads.length });
    if (upsertErr) {
      if (upsertErr.code === '23505') { alreadySent++; continue; }
      console.error('eveningSweep claim:', upsertErr); failed++; continue;
    }

    try {
      const firstPickup = loads.map(l => l.start).sort()[0];
      const count = loads.length;
      const body = count === 1
        ? `1 load to confirm — pickup ${fmtPickup(firstPickup)}.`
        : `${count} loads to confirm — first pickup ${fmtPickup(firstPickup)}.`;
      await sendPushToDriver(orgId, driverId, {
        title: count === 1 ? 'Confirm tomorrow\'s load' : `Confirm ${count} upcoming loads`,
        body,
        data: count === 1
          ? { type: 'confirm', eventId: loads[0].id, url: `/load/${loads[0].id}` }
          : { type: 'confirm', url: '/loads' },
      });
      // Per-load timeline rows so each load's pending count + history
      // reflect that the evening sweep covered it.
      await Promise.all(loads.map(l => recordConfirmNudge(db, l, 'Auto: evening sweep')));
      sent++;
    } catch (err) {
      console.error('eveningSweep send:', orgId, driverId, err);
      failed++;
      // Don't undo the idempotency claim — we'd rather miss a push
      // than spam the driver after a transient error.
    }
  }

  return { sent, failed, alreadySent, drivers: groups.size };
}

// ── Rule 2: Six-hour-out sweep ─────────────────────────────────────────
// Per-load reminder fires once when pickup is 5.5–6.5h out. Captures
// loads that were assigned more than 6h before pickup but whose pickup
// time falls outside the evening-sweep's 18h window (e.g., 3 PM next-day
// pickup assigned at 10 AM yesterday).
//
// Idempotency: skip events that already got a 'confirm' notification
// (manual or evening sweep) in the last 24h. This unifies cron output
// with the dispatcher-initiated nudges via load_notifications — no
// more separate confirm_reminder_sent_at flag needed.

async function runSixHourSweep(db: ReturnType<typeof getSupabase>) {
  const fromStr = naiveMTString(5.5 * 60 * 60 * 1000);
  const toStr   = naiveMTString(6.5 * 60 * 60 * 1000);

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, load_id, start, load:loads(load_num)')
    .in('status', ['scheduled', 'assigned', 'dispatched'])
    .is('deleted_at', null)
    .is('confirmed_at', null)
    .not('driver_id', 'is', null)
    .gte('start', fromStr)
    .lte('start', toStr);
  if (error) { console.error('sixHourSweep query:', error); return { sent: 0, error: error.message }; }

  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return { sent: 0, matched: 0 };

  // Pull recent confirm notifications for any of these event_ids so we
  // can skip ones already nudged in the last 24h.
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from('load_notifications')
    .select('event_id')
    .in('event_id', rows.map(r => r.id))
    .eq('kind', 'confirm')
    .gte('sent_at', cutoff24h);
  const recentlyNudged = new Set<string>(((recent ?? []) as { event_id: string }[]).map(r => r.event_id));

  let sent = 0; let failed = 0; let skipped = 0;

  for (const row of rows) {
    if (recentlyNudged.has(row.id)) { skipped++; continue; }
    try {
      const loadObj = Array.isArray(row.load) ? row.load[0] : row.load;
      const loadNum = loadObj?.load_num ?? null;
      await sendPushToDriver(row.org_id, row.driver_id, {
        title: loadNum ? `Confirm load #${loadNum}` : 'Confirm load',
        body:  `Pickup at ${fmtPickup(row.start)}. Tap to confirm.`,
        data:  { type: 'confirm', eventId: row.id, url: `/load/${row.id}` },
      });
      await recordConfirmNudge(db, row, 'Auto: 6h reminder');
      sent++;
    } catch (err) {
      console.error('sixHourSweep send:', row.id, err); failed++;
    }
  }

  return { sent, failed, matched: rows.length, skipped };
}

// ── Entrypoint ─────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not set' }, { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getSupabase();
  const evening = await runEveningSweep(db);
  const sixHour = await runSixHourSweep(db);

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    evening,
    sixHour,
  });
}
