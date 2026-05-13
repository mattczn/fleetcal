import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver } from '@/lib/push';

/**
 * Vercel Cron — runs every 30 minutes (see vercel.json). Implements the
 * three-rule confirm sweep system:
 *
 *   1. Evening sweep        — between 7 PM and 8 PM driver-local
 *                             (currently org-wide MT since events.start
 *                             is stored as naive Mountain Time). One
 *                             push per driver covering ALL unconfirmed
 *                             scheduled loads in the next 18h.
 *                             Idempotent via driver_evening_sweeps
 *                             (org_id, driver_id, local_date).
 *   2. Six-hour-out sweep   — per-load: any unconfirmed event whose
 *                             pickup is 5.5–6.5h away (matched to the
 *                             30-min cron cadence) gets a one-shot push.
 *                             Idempotent via confirm_reminder_sent_at.
 *   3. Last-minute assign   — handled in the dispatcher store on driver
 *                             assignment, not here.
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
  start:     string;
  load:      { load_num: string | null } | { load_num: string | null }[] | null;
}

// ── Rule 1: Evening sweep ──────────────────────────────────────────────
// Fires once per driver per local-date when current MT hour ∈ [19, 20).
// Aggregates all their unconfirmed scheduled loads in the next 18h into
// one push. Idempotent via driver_evening_sweeps upsert.

async function runEveningSweep(db: ReturnType<typeof getSupabase>) {
  const nowMT = naiveMT(new Date());
  if (nowMT.hour !== 19) return { sent: 0, skipped: 'not_evening_window', drivers: 0 };

  const nowStr   = naiveMTString(0);
  const cutoff18 = naiveMTString(18 * 60 * 60 * 1000);

  // Pull every unconfirmed scheduled-ish load with a driver in the 18h
  // window. Group client-side by driver_id.
  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, start, load:loads(load_num)')
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

    // Idempotency check — has this driver already gotten today's
    // evening sweep? Use an upsert with ignoreDuplicates to claim the
    // (org_id, driver_id, local_date) slot atomically.
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
        // Deep-link to the first load when there's only one; to the
        // loads list when there are multiple.
        data: count === 1
          ? { type: 'evening_sweep', eventId: loads[0].id, url: `/load/${loads[0].id}` }
          : { type: 'evening_sweep', url: '/loads' },
      });
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

async function runSixHourSweep(db: ReturnType<typeof getSupabase>) {
  const fromStr = naiveMTString(5.5 * 60 * 60 * 1000); // pickup is 5.5h from now or later
  const toStr   = naiveMTString(6.5 * 60 * 60 * 1000); // …and 6.5h from now or sooner

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, start, load:loads(load_num)')
    .in('status', ['scheduled', 'assigned', 'dispatched'])
    .is('deleted_at', null)
    .is('confirmed_at', null)
    .is('confirm_reminder_sent_at', null)
    .not('driver_id', 'is', null)
    .gte('start', fromStr)
    .lte('start', toStr);
  if (error) { console.error('sixHourSweep query:', error); return { sent: 0, error: error.message }; }

  const rows = (data ?? []) as PendingRow[];
  let sent = 0; let failed = 0;

  for (const row of rows) {
    try {
      const loadObj = Array.isArray(row.load) ? row.load[0] : row.load;
      const loadNum = loadObj?.load_num ?? null;
      await sendPushToDriver(row.org_id, row.driver_id, {
        title: loadNum ? `Confirm load #${loadNum}` : 'Confirm load',
        body:  `Pickup at ${fmtPickup(row.start)}. Tap to confirm.`,
        data:  { type: 'six_hour_reminder', eventId: row.id, url: `/load/${row.id}` },
      });
      const { error: stampErr } = await db
        .from('events')
        .update({ confirm_reminder_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      if (stampErr) { console.error('sixHourSweep stamp:', row.id, stampErr); failed++; }
      else sent++;
    } catch (err) {
      console.error('sixHourSweep send:', row.id, err); failed++;
    }
  }

  return { sent, failed, matched: rows.length };
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
