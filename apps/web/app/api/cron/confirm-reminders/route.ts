import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendAutoPushToDriver } from '@/lib/push';
import {
  DEFAULT_NOTIFICATION_RULES,
  type NotificationRules,
} from '@fleetcal/types';

/**
 * Cron — runs every 15-30 minutes (configured externally; this file
 * doesn't care about schedule cadence as long as the window math
 * leaves no gaps). Three automatic notification rules; the synchronous
 * on-assignment push lives in the dispatcher store, not here.
 *
 *   1. Evening confirm sweep   — fires once per driver per local-date
 *                                when the org-local clock crosses the
 *                                rule's timeOfDay. Aggregates every
 *                                unconfirmed scheduled load in the
 *                                next `lookAheadHours` into one push.
 *                                Idempotent via driver_evening_sweeps.
 *   2. Pre-pickup confirm      — per-load, fires once when pickup is
 *                                approximately `hoursBeforePickup`
 *                                hours away. Idempotent via "no
 *                                confirm notification in last 24h".
 *   3. Missing POD reminder    — fires once when an event delivered
 *                                `hoursAfterDelivery` hours ago still
 *                                has no kind='pod' document. Idempotent
 *                                via "no missing-POD notification in
 *                                last 24h".
 *
 * Per-org notification rules + per-driver overrides are honored. A
 * disabled rule is a no-op; a per-driver opt-out is enforced inside
 * sendAutoPushToDriver before the push fans out.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */

const TZ = 'America/Denver';
const CRON_WINDOW_MIN = 30; // assumed external cadence — evening sweep
                            // fires if rule.timeOfDay falls in (now-30min, now].

// ── Time helpers ───────────────────────────────────────────────────────
// events.start is stored as naive Mountain-Time string, "YYYY-MM-DDTHH:mm".

function naiveMT(date: Date): { date: string; time: string; hour: number; minute: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  const hh = get('hour') === '24' ? '00' : get('hour');
  const hour   = parseInt(hh, 10);
  const minute = parseInt(get('minute'), 10);
  return {
    date:   `${get('year')}-${get('month')}-${get('day')}`,
    time:   `${hh}:${get('minute')}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

function naiveMTString(offsetMs = 0): string {
  const n = naiveMT(new Date(Date.now() + offsetMs));
  return `${n.date}T${n.time}`;
}

function parseHm(hm: string | undefined | null): number | null {
  if (!hm) return null;
  const m = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtPickup(naive: string): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return naive;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

// ── Per-org rules cache (one cron invocation = one Map) ───────────────

type Db = ReturnType<typeof getSupabase>;

async function loadOrgRules(db: Db, orgId: string, cache: Map<string, NotificationRules>): Promise<NotificationRules> {
  const cached = cache.get(orgId);
  if (cached) return cached;
  const { data } = await db
    .from('org_settings')
    .select('notification_rules')
    .eq('org_id', orgId)
    .maybeSingle();
  const stored = (data as { notification_rules: NotificationRules | null } | null)
    ?.notification_rules ?? null;
  const resolved: NotificationRules = stored
    ? {
        eveningConfirmSweep: { ...DEFAULT_NOTIFICATION_RULES.eveningConfirmSweep, ...(stored.eveningConfirmSweep ?? {}) },
        prePickupConfirm:    { ...DEFAULT_NOTIFICATION_RULES.prePickupConfirm,    ...(stored.prePickupConfirm    ?? {}) },
        onAssignment:        { ...DEFAULT_NOTIFICATION_RULES.onAssignment,        ...(stored.onAssignment        ?? {}) },
        missingPodReminder:  { ...DEFAULT_NOTIFICATION_RULES.missingPodReminder,  ...(stored.missingPodReminder  ?? {}) },
      }
    : DEFAULT_NOTIFICATION_RULES;
  cache.set(orgId, resolved);
  return resolved;
}

// ── load_notifications helpers ─────────────────────────────────────────

interface PendingRow {
  id:        string;
  org_id:    string;
  driver_id: number;
  load_id:   string | null;
  start:     string;
  load:      { load_num: string | null } | { load_num: string | null }[] | null;
}

async function recordNudge(
  db: Db,
  orgId: string,
  eventId: string,
  loadId: string | null,
  driverId: number,
  kind: 'confirm' | 'upload_pod',
  sentByName: string,
): Promise<void> {
  const { error } = await db.from('load_notifications').insert({
    org_id:       orgId,
    event_id:     eventId,
    load_id:      loadId,
    driver_id:    driverId,
    kind,
    sent_by_name: sentByName,
  });
  if (error) console.error('[load_notifications insert]', eventId, error);
}

// ── Rule 1: Evening confirm sweep ──────────────────────────────────────

async function runEveningSweep(db: Db, rulesCache: Map<string, NotificationRules>) {
  const nowMT = naiveMT(new Date());

  // Pull every potentially-eligible event in one query (across all
  // orgs), then per-org we filter against the org's configured
  // timeOfDay + lookAheadHours below.
  // 24h look-ahead is the max we'd care about for ANY org (we cap
  // here to bound query cost; rule.lookAheadHours <= 24).
  const cutoff24 = naiveMTString(24 * 60 * 60 * 1000);
  const nowStr   = naiveMTString(0);

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, load_id, start, load:loads(load_num)')
    .in('status', ['scheduled', 'assigned', 'dispatched'])
    .is('deleted_at', null)
    .is('confirmed_at', null)
    .not('driver_id', 'is', null)
    .gte('start', nowStr)
    .lte('start', cutoff24);
  if (error) { console.error('eveningSweep query:', error); return { sent: 0, error: error.message, drivers: 0 }; }

  const rows = (data ?? []) as PendingRow[];

  // Group by (org, driver) AND filter by per-org lookAheadHours.
  type GroupKey = string;
  const groups = new Map<GroupKey, { orgId: string; driverId: number; loads: PendingRow[]; rules: NotificationRules }>();
  for (const r of rows) {
    const rules = await loadOrgRules(db, r.org_id, rulesCache);
    if (!rules.eveningConfirmSweep.enabled) continue;
    // Check if this row's pickup falls inside this org's look-ahead.
    const lookCutoff = naiveMTString(rules.eveningConfirmSweep.lookAheadHours * 60 * 60 * 1000);
    if (r.start > lookCutoff) continue;
    // Only fire at the rule's timeOfDay — but the cron runs every
    // CRON_WINDOW_MIN, so accept any time that falls in
    // (timeOfDay - CRON_WINDOW_MIN, timeOfDay].
    const ruleMin = parseHm(rules.eveningConfirmSweep.timeOfDay);
    if (ruleMin == null) continue;
    const inWindow = nowMT.minutesOfDay >= ruleMin && nowMT.minutesOfDay < ruleMin + CRON_WINDOW_MIN;
    if (!inWindow) continue;

    const key = `${r.org_id}|${r.driver_id}`;
    const entry = groups.get(key) ?? { orgId: r.org_id, driverId: r.driver_id, loads: [], rules };
    entry.loads.push(r);
    groups.set(key, entry);
  }

  let sent = 0; let failed = 0; let alreadySent = 0; let suppressed = 0;
  const today = nowMT.date;

  for (const [, { orgId, driverId, loads }] of groups) {
    // Atomic claim — duplicate key means we already did this driver today.
    const { error: claimErr } = await db
      .from('driver_evening_sweeps')
      .insert({ org_id: orgId, driver_id: driverId, local_date: today, load_count: loads.length });
    if (claimErr) {
      if (claimErr.code === '23505') { alreadySent++; continue; }
      console.error('eveningSweep claim:', claimErr); failed++; continue;
    }

    try {
      const firstPickup = loads.map(l => l.start).sort()[0];
      const count = loads.length;
      const body = count === 1
        ? `1 load to confirm — pickup ${fmtPickup(firstPickup)}.`
        : `${count} loads to confirm — first pickup ${fmtPickup(firstPickup)}.`;
      const did = await sendAutoPushToDriver(orgId, driverId, 'evening_confirm_sweep', {
        title: count === 1 ? 'Confirm tomorrow\'s load' : `Confirm ${count} upcoming loads`,
        body,
        data: count === 1
          ? { type: 'confirm', eventId: loads[0].id, url: `/load/${loads[0].id}` }
          : { type: 'confirm', url: '/loads' },
      });
      if (!did) { suppressed++; continue; }
      // Per-load timeline rows so each load's pending count + history reflect the sweep.
      await Promise.all(loads.map(l => recordNudge(db, orgId, l.id, l.load_id, driverId, 'confirm', 'Auto: evening sweep')));
      sent++;
    } catch (err) {
      console.error('eveningSweep send:', orgId, driverId, err);
      failed++;
    }
  }

  return { sent, failed, alreadySent, suppressed, drivers: groups.size };
}

// ── Rule 2: Pre-pickup confirm reminder ────────────────────────────────

async function runPrePickupSweep(db: Db, rulesCache: Map<string, NotificationRules>) {
  // Pull a 12h window of candidates (covers any reasonable hoursBeforePickup).
  const fromStr = naiveMTString(0);
  const toStr   = naiveMTString(12 * 60 * 60 * 1000);

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, load_id, start, load:loads(load_num)')
    .in('status', ['scheduled', 'assigned', 'dispatched'])
    .is('deleted_at', null)
    .is('confirmed_at', null)
    .not('driver_id', 'is', null)
    .gte('start', fromStr)
    .lte('start', toStr);
  if (error) { console.error('prePickupSweep query:', error); return { sent: 0, error: error.message }; }

  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return { sent: 0, matched: 0 };

  // Filter by each row's org rule (hoursBeforePickup ± 0.5h).
  const eligible: PendingRow[] = [];
  for (const r of rows) {
    const rules = await loadOrgRules(db, r.org_id, rulesCache);
    if (!rules.prePickupConfirm.enabled) continue;
    const pickupMs = Date.parse(r.start.replace(' ', 'T'));
    if (!isFinite(pickupMs)) continue;
    const hoursOut = (pickupMs - Date.now()) / 3_600_000;
    const target   = rules.prePickupConfirm.hoursBeforePickup;
    if (hoursOut < target - 0.5 || hoursOut >= target + 0.5) continue;
    eligible.push(r);
  }
  if (eligible.length === 0) return { sent: 0, matched: rows.length, eligible: 0 };

  // Skip events already nudged for confirm in last 24h (avoid stacking
  // on top of evening sweep coverage).
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from('load_notifications')
    .select('event_id')
    .in('event_id', eligible.map(r => r.id))
    .eq('kind', 'confirm')
    .gte('sent_at', cutoff24h);
  const recentlyNudged = new Set<string>(((recent ?? []) as { event_id: string }[]).map(r => r.event_id));

  let sent = 0; let failed = 0; let skipped = 0; let suppressed = 0;

  for (const row of eligible) {
    if (recentlyNudged.has(row.id)) { skipped++; continue; }
    try {
      const loadObj = Array.isArray(row.load) ? row.load[0] : row.load;
      const loadNum = loadObj?.load_num ?? null;
      const did = await sendAutoPushToDriver(row.org_id, row.driver_id, 'pre_pickup_confirm', {
        title: loadNum ? `Confirm load #${loadNum}` : 'Confirm load',
        body:  `Pickup at ${fmtPickup(row.start)}. Tap to confirm.`,
        data:  { type: 'confirm', eventId: row.id, url: `/load/${row.id}` },
      });
      if (!did) { suppressed++; continue; }
      await recordNudge(db, row.org_id, row.id, row.load_id, row.driver_id, 'confirm', 'Auto: pre-pickup reminder');
      sent++;
    } catch (err) {
      console.error('prePickupSweep send:', row.id, err); failed++;
    }
  }

  return { sent, failed, matched: rows.length, eligible: eligible.length, skipped, suppressed };
}

// ── Rule 3: Missing POD reminder ───────────────────────────────────────

interface DeliveredRow {
  id:           string;
  org_id:       string;
  driver_id:    number | null;
  load_id:      string | null;
  delivered_at: string | null;
  load:         { load_num: string | null } | { load_num: string | null }[] | null;
}

async function runMissingPodSweep(db: Db, rulesCache: Map<string, NotificationRules>) {
  // Pull events delivered in the last 7 days (cap on how far back we'll
  // remind). The per-org rule then narrows to its hoursAfterDelivery ± 1h.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('events')
    .select('id, org_id, driver_id, load_id, delivered_at, load:loads(load_num)')
    .eq('status', 'delivered')
    .is('deleted_at', null)
    .not('driver_id', 'is', null)
    .not('delivered_at', 'is', null)
    .gte('delivered_at', sevenDaysAgo);
  if (error) { console.error('missingPodSweep query:', error); return { sent: 0, error: error.message }; }

  const rows = (data ?? []) as DeliveredRow[];
  if (rows.length === 0) return { sent: 0, matched: 0 };

  // Filter by org rule window (hoursAfterDelivery, +1h cron jitter).
  const eligible: DeliveredRow[] = [];
  for (const r of rows) {
    if (!r.delivered_at || !r.driver_id || !r.load_id) continue;
    const rules = await loadOrgRules(db, r.org_id, rulesCache);
    if (!rules.missingPodReminder.enabled) continue;
    const hoursSince = (Date.now() - Date.parse(r.delivered_at)) / 3_600_000;
    const target = rules.missingPodReminder.hoursAfterDelivery;
    // Fire only when delivery is at-or-past target by up to one cron
    // interval (avoids spamming every cron tick for days).
    if (hoursSince < target || hoursSince >= target + (CRON_WINDOW_MIN / 60)) continue;
    eligible.push(r);
  }
  if (eligible.length === 0) return { sent: 0, matched: rows.length, eligible: 0 };

  // Skip loads that already have a POD on file.
  const loadIds = [...new Set(eligible.map(r => r.load_id).filter((x): x is string => !!x))];
  const { data: pods } = await db
    .from('load_documents')
    .select('load_id')
    .in('load_id', loadIds)
    .eq('kind', 'pod');
  const haveSomePod = new Set<string>(((pods ?? []) as { load_id: string }[]).map(r => r.load_id));

  // Skip events already nudged for missing POD in last 24h.
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from('load_notifications')
    .select('event_id')
    .in('event_id', eligible.map(r => r.id))
    .eq('kind', 'upload_pod')
    .gte('sent_at', cutoff24h);
  const recentlyNudged = new Set<string>(((recent ?? []) as { event_id: string }[]).map(r => r.event_id));

  let sent = 0; let failed = 0; let skipped = 0; let suppressed = 0;

  for (const row of eligible) {
    if (haveSomePod.has(row.load_id!)) { skipped++; continue; }
    if (recentlyNudged.has(row.id))    { skipped++; continue; }
    try {
      const loadObj = Array.isArray(row.load) ? row.load[0] : row.load;
      const loadNum = loadObj?.load_num ?? null;
      const did = await sendAutoPushToDriver(row.org_id, row.driver_id!, 'missing_pod_reminder', {
        title: loadNum ? `Upload POD for load #${loadNum}` : 'Upload POD',
        body:  `Don't forget — your delivered load is still missing a POD.`,
        data:  { type: 'upload_pod', eventId: row.id, url: `/load/${row.id}` },
      });
      if (!did) { suppressed++; continue; }
      await recordNudge(db, row.org_id, row.id, row.load_id, row.driver_id!, 'upload_pod', 'Auto: missing POD');
      sent++;
    } catch (err) {
      console.error('missingPodSweep send:', row.id, err); failed++;
    }
  }

  return { sent, failed, matched: rows.length, eligible: eligible.length, skipped, suppressed };
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
  const rulesCache = new Map<string, NotificationRules>();

  const evening   = await runEveningSweep(db, rulesCache);
  const prePickup = await runPrePickupSweep(db, rulesCache);
  const missingPod = await runMissingPodSweep(db, rulesCache);

  return NextResponse.json({
    ok: true,
    ranAt: new Date().toISOString(),
    evening,
    prePickup,
    missingPod,
  });
}
