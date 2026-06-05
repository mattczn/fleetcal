/**
 * Auto driver-notification sweeps. Three rules:
 *
 *   1. Evening confirm sweep — fires once per driver per local-date
 *      when the org-local clock crosses the rule's timeOfDay.
 *      Aggregates every unconfirmed scheduled load in the next
 *      `lookAheadHours` into one push. Idempotent via
 *      driver_evening_sweeps.
 *   2. Pre-pickup confirm    — per-load, fires once when pickup is
 *      ~hoursBeforePickup hours away. Idempotent via "no confirm
 *      notification in last 24h".
 *   3. Missing POD reminder  — fires once when an event delivered
 *      ~hoursAfterDelivery hours ago still has no kind='pod'
 *      document. Idempotent via "no missing-POD nudge in last 24h".
 *
 * Per-org notification rules + per-driver overrides are honored. A
 * disabled rule is a no-op; a per-driver opt-out is enforced inside
 * sendAutoPushToDriver. Manual dispatcher nudges bypass everything.
 *
 * Invoked by the in-process scheduler in apps/api/src/index.ts on a
 * 15-minute cron.
 */
import { supabase } from "../lib/supabase.js";
import { sendAutoPushToDriver } from "../lib/push.js";
import {
  DEFAULT_NOTIFICATION_RULES,
  type NotificationRules,
} from "@fleetcal/types";

const TZ = "America/Denver";
/** Assumed cron cadence — used to widen the evening-sweep + missing-POD
 *  fire windows so a tick that lands a few min off-schedule still
 *  catches the rule. Idempotency dedup prevents repeats. */
const CRON_WINDOW_MIN = 30;

// ── Time helpers ───────────────────────────────────────────────────────

function naiveMT(date: Date): { date: string; time: string; hour: number; minute: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour");
  const hour   = parseInt(hh, 10);
  const minute = parseInt(get("minute"), 10);
  return {
    date:   `${get("year")}-${get("month")}-${get("day")}`,
    time:   `${hh}:${get("minute")}`,
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

/** `[time]` per the notification copy spec — "ddd M/D h:mm A"
 *  (e.g. "Wed 5/21 8:00 AM"). Consistent with the format the
 *  web (notifyDriver / NotifyDriverPopover) uses so lock-screen
 *  copy reads the same regardless of which path fired the push. */
function fmtPickup(naive: string): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return naive;
  const year  = Number(m[1]);
  const month = Number(m[2]);
  const day   = Number(m[3]);
  let hour    = Number(m[4]);
  const min   = Number(m[5]);
  const ampm = hour >= 12 ? "PM" : "AM";
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  const wd = new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "short" });
  return `${wd} ${month}/${day} ${hour}:${String(min).padStart(2, "0")} ${ampm}`;
}

// ── Per-org rules cache (one job invocation = one Map) ────────────────

async function loadOrgRules(orgId: string, cache: Map<string, NotificationRules>): Promise<NotificationRules> {
  const cached = cache.get(orgId);
  if (cached) return cached;
  const { data } = await supabase
    .from("org_settings")
    .select("notification_rules")
    .eq("org_id", orgId)
    .maybeSingle();
  const stored = (data as { notification_rules: NotificationRules | null } | null)
    ?.notification_rules ?? null;
  const resolved: NotificationRules = stored
    ? {
        eveningConfirmSweep: { ...DEFAULT_NOTIFICATION_RULES.eveningConfirmSweep, ...(stored.eveningConfirmSweep ?? {}) },
        prePickupConfirm:    { ...DEFAULT_NOTIFICATION_RULES.prePickupConfirm,    ...(stored.prePickupConfirm    ?? {}) },
        onAssignment:        { ...DEFAULT_NOTIFICATION_RULES.onAssignment,        ...(stored.onAssignment        ?? {}) },
        missingPodReminder:  { ...DEFAULT_NOTIFICATION_RULES.missingPodReminder,  ...(stored.missingPodReminder  ?? {}) },
        loadCancelled:       { ...DEFAULT_NOTIFICATION_RULES.loadCancelled,       ...(stored.loadCancelled       ?? {}) },
        reassignedAway:      { ...DEFAULT_NOTIFICATION_RULES.reassignedAway,      ...(stored.reassignedAway      ?? {}) },
      }
    : DEFAULT_NOTIFICATION_RULES;
  cache.set(orgId, resolved);
  return resolved;
}

// ── Shared row + record helpers ────────────────────────────────────────

interface PendingRow {
  id:        string;
  org_id:    string;
  driver_id: number;
  load_id:   string | null;
  start:     string;
  /** events.title — formatted "broker: pickup–delivery" upstream. Used
   *  as [route] in the push copy spec. */
  title:     string;
  load:      { load_num: string | null } | { load_num: string | null }[] | null;
}

interface DeliveredRow {
  id:           string;
  org_id:       string;
  driver_id:    number | null;
  load_id:      string | null;
  title:        string;
  /** Proxy for the actual delivery time — we use events.updated_at on
   *  rows with status='delivered'. The events table doesn't yet have a
   *  delivered_at column (similar to confirmed_at) so this is the
   *  closest thing. Limitation: any later edit to the event will reset
   *  the timer; the 24h notification dedup keeps re-fires bounded to
   *  one extra ping in that edge case. */
  updated_at:   string;
  /** Naive ISO end time. Fed into sendAutoPushToDriver's stale-load
   *  guard so loads whose end is >24h ago skip the push regardless of
   *  what updated_at says. Catches the imported-Alvys case where
   *  enrichment bumped updated_at on long-past deliveries. */
  end:          string;
  load:         { load_num: string | null } | { load_num: string | null }[] | null;
}

async function recordNudge(
  orgId: string,
  eventId: string,
  loadId: string | null,
  driverId: number,
  kind: "confirm" | "upload_pod",
  sentByName: string,
): Promise<void> {
  const { error } = await supabase.from("load_notifications").insert({
    org_id:       orgId,
    event_id:     eventId,
    load_id:      loadId,
    driver_id:    driverId,
    kind,
    sent_by_name: sentByName,
  });
  if (error) console.error("[load_notifications insert]", eventId, error);
}

// ── Rule 1: Evening confirm sweep ──────────────────────────────────────

async function runEveningSweep(rulesCache: Map<string, NotificationRules>) {
  const nowMT = naiveMT(new Date());
  const cutoff24 = naiveMTString(24 * 60 * 60 * 1000);
  const nowStr   = naiveMTString(0);

  const { data, error } = await supabase
    .from("events")
    .select("id, org_id, driver_id, load_id, start, title, load:loads(load_num)")
    .in("status", ["scheduled", "assigned", "dispatched"])
    .is("deleted_at", null)
    .is("confirmed_at", null)
    .not("driver_id", "is", null)
    .gte("start", nowStr)
    .lte("start", cutoff24);
  if (error) { console.error("eveningSweep query:", error); return { sent: 0, error: error.message, drivers: 0 }; }

  const rows = (data ?? []) as PendingRow[];

  type Group = { orgId: string; driverId: number; loads: PendingRow[] };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const rules = await loadOrgRules(r.org_id, rulesCache);
    if (!rules.eveningConfirmSweep.enabled) continue;
    const lookCutoff = naiveMTString(rules.eveningConfirmSweep.lookAheadHours * 60 * 60 * 1000);
    if (r.start > lookCutoff) continue;
    const ruleMin = parseHm(rules.eveningConfirmSweep.timeOfDay);
    if (ruleMin == null) continue;
    const inWindow = nowMT.minutesOfDay >= ruleMin && nowMT.minutesOfDay < ruleMin + CRON_WINDOW_MIN;
    if (!inWindow) continue;
    const key = `${r.org_id}|${r.driver_id}`;
    const entry = groups.get(key) ?? { orgId: r.org_id, driverId: r.driver_id, loads: [] };
    entry.loads.push(r);
    groups.set(key, entry);
  }

  let sent = 0; let failed = 0; let alreadySent = 0; let suppressed = 0;
  const today = nowMT.date;

  for (const [, { orgId, driverId, loads }] of groups) {
    const { error: claimErr } = await supabase
      .from("driver_evening_sweeps")
      .insert({ org_id: orgId, driver_id: driverId, local_date: today, load_count: loads.length } as never);
    if (claimErr) {
      if ((claimErr as { code?: string }).code === "23505") { alreadySent++; continue; }
      console.error("eveningSweep claim:", claimErr); failed++; continue;
    }

    try {
      // Copy spec #12a (single) vs #12b (batch). The single branch
      // leads with the route since there's only one load to confirm;
      // the batch branch can't name a route so it leads with the
      // first pickup time + count.
      const firstLoad = [...loads].sort((a, b) => a.start.localeCompare(b.start))[0];
      const count = loads.length;
      const title = count === 1
        ? "Confirm Tomorrow's Loads"
        : `Confirm ${count} Upcoming Loads`;
      const body = count === 1
        ? `${firstLoad.title} — Pickup ${fmtPickup(firstLoad.start)}. Tap to confirm.`
        : `First pickup ${fmtPickup(firstLoad.start)}. Tap to review.`;
      const did = await sendAutoPushToDriver(orgId, driverId, "evening_confirm_sweep", {
        title,
        body,
        data: count === 1
          ? { type: "confirm", eventId: firstLoad.id, url: `/load/${firstLoad.id}` }
          : { type: "confirm", url: "/loads" },
      });
      if (!did) { suppressed++; continue; }
      await Promise.all(loads.map(l => recordNudge(orgId, l.id, l.load_id, driverId, "confirm", "Auto: evening sweep")));
      sent++;
    } catch (err) {
      console.error("eveningSweep send:", orgId, driverId, err);
      failed++;
    }
  }

  return { sent, failed, alreadySent, suppressed, drivers: groups.size };
}

// ── Rule 2: Pre-pickup confirm reminder ────────────────────────────────

async function runPrePickupSweep(rulesCache: Map<string, NotificationRules>) {
  const fromStr = naiveMTString(0);
  const toStr   = naiveMTString(12 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("events")
    .select("id, org_id, driver_id, load_id, start, title, load:loads(load_num)")
    .in("status", ["scheduled", "assigned", "dispatched"])
    .is("deleted_at", null)
    .is("confirmed_at", null)
    .not("driver_id", "is", null)
    .gte("start", fromStr)
    .lte("start", toStr);
  if (error) { console.error("prePickupSweep query:", error); return { sent: 0, error: error.message }; }

  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return { sent: 0, matched: 0 };

  const eligible: PendingRow[] = [];
  for (const r of rows) {
    const rules = await loadOrgRules(r.org_id, rulesCache);
    if (!rules.prePickupConfirm.enabled) continue;
    const pickupMs = Date.parse(r.start.replace(" ", "T"));
    if (!isFinite(pickupMs)) continue;
    const hoursOut = (pickupMs - Date.now()) / 3_600_000;
    const target   = rules.prePickupConfirm.hoursBeforePickup;
    if (hoursOut < target - 0.5 || hoursOut >= target + 0.5) continue;
    eligible.push(r);
  }
  if (eligible.length === 0) return { sent: 0, matched: rows.length, eligible: 0 };

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("load_notifications")
    .select("event_id")
    .in("event_id", eligible.map(r => r.id))
    .eq("kind", "confirm")
    .gte("sent_at", cutoff24h);
  const recentlyNudged = new Set<string>(((recent ?? []) as { event_id: string }[]).map(r => r.event_id));

  let sent = 0; let failed = 0; let skipped = 0; let suppressed = 0;

  for (const row of eligible) {
    if (recentlyNudged.has(row.id)) { skipped++; continue; }
    try {
      // Copy spec #13 — pre-pickup confirm reminder. [route] = event
      // title (broker: pickup–delivery). The load.load_num join is
      // kept for downstream code but isn't used in the push copy.
      const did = await sendAutoPushToDriver(row.org_id, row.driver_id, "pre_pickup_confirm", {
        title: "Confirm Pickup",
        body:  `${row.title} — Pickup ${fmtPickup(row.start)}. Tap to confirm.`,
        data:  { type: "confirm", eventId: row.id, url: `/load/${row.id}` },
      });
      if (!did) { suppressed++; continue; }
      await recordNudge(row.org_id, row.id, row.load_id, row.driver_id, "confirm", "Auto: pre-pickup reminder");
      sent++;
    } catch (err) {
      console.error("prePickupSweep send:", row.id, err); failed++;
    }
  }

  return { sent, failed, matched: rows.length, eligible: eligible.length, skipped, suppressed };
}

// ── Rule 3: Missing POD reminder ───────────────────────────────────────

async function runMissingPodSweep(rulesCache: Map<string, NotificationRules>) {
  // Per-org targeted query. Pulling all delivered events in the last 7d
  // and filtering in JS hits PostgREST's default 1000-row cap once the
  // org has any volume — narrow at the SQL level by the org's actual
  // hoursAfterDelivery window (~1h wide per tick).
  // notification_rules column lands via the 20260518 migration; the
  // generated Database types still don't know about it. Cast around.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: orgRows, error: orgErr } = await (supabase as any)
    .from("org_settings")
    .select("org_id, notification_rules");
  if (orgErr) { console.error("missingPodSweep org query:", orgErr); return { sent: 0, error: orgErr.message }; }

  const orgsList = (orgRows ?? []) as { org_id: string; notification_rules: NotificationRules | null }[];

  const eligible: DeliveredRow[] = [];
  let totalMatched = 0;
  for (const orgRow of orgsList) {
    const rules = await loadOrgRules(orgRow.org_id, rulesCache);
    if (!rules.missingPodReminder.enabled) continue;
    const target = rules.missingPodReminder.hoursAfterDelivery;
    // Window: events where status flipped to delivered between
    // (target+1)h ago and target h ago. 1-hour wide; tolerates one
    // cron tick of drift. Idempotency via load_notifications dedup.
    const windowEnd   = new Date(Date.now() - target       * 3_600_000).toISOString();
    const windowStart = new Date(Date.now() - (target + 1) * 3_600_000).toISOString();
    const { data: events, error: evErr } = await supabase
      .from("events")
      .select("id, org_id, driver_id, load_id, updated_at, title, \"end\", load:loads(load_num)")
      .eq("org_id", orgRow.org_id)
      .eq("status", "delivered")
      .is("deleted_at", null)
      .not("driver_id", "is", null)
      .gte("updated_at", windowStart)
      .lt("updated_at", windowEnd);
    if (evErr) { console.error("missingPodSweep org events:", orgRow.org_id, evErr); continue; }
    const rows = (events ?? []) as DeliveredRow[];
    totalMatched += rows.length;
    for (const r of rows) {
      if (!r.driver_id || !r.load_id) continue;
      eligible.push(r);
    }
  }
  if (eligible.length === 0) return { sent: 0, matched: totalMatched, eligible: 0 };

  const loadIds = [...new Set(eligible.map(r => r.load_id).filter((x): x is string => !!x))];
  const { data: pods } = await supabase
    .from("load_documents")
    .select("load_id")
    .in("load_id", loadIds)
    .eq("kind", "pod");
  const haveSomePod = new Set<string>(((pods ?? []) as { load_id: string }[]).map(r => r.load_id));

  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await supabase
    .from("load_notifications")
    .select("event_id")
    .in("event_id", eligible.map(r => r.id))
    .eq("kind", "upload_pod")
    .gte("sent_at", cutoff24h);
  const recentlyNudged = new Set<string>(((recent ?? []) as { event_id: string }[]).map(r => r.event_id));

  let sent = 0; let failed = 0; let skipped = 0; let suppressed = 0;

  for (const row of eligible) {
    if (haveSomePod.has(row.load_id!)) { skipped++; continue; }
    if (recentlyNudged.has(row.id))    { skipped++; continue; }
    try {
      // Copy spec #14 — missing-POD reminder. Only one where [route]
      // doesn't lead the body (sentence structure reads better). Risks
      // truncation on lock screen with a long broker:city–city title;
      // accept that since POD reminders get opened regardless of
      // preview.
      const did = await sendAutoPushToDriver(row.org_id, row.driver_id!, "missing_pod_reminder", {
        title: "Reminder: Upload Paperwork",
        body:  `We still need the POD for ${row.title}. Please upload ASAP.`,
        data:  { type: "upload_pod", eventId: row.id, url: `/load/${row.id}` },
      }, { eventEnd: row.end });
      if (!did) { suppressed++; continue; }
      await recordNudge(row.org_id, row.id, row.load_id, row.driver_id!, "upload_pod", "Auto: missing POD");
      sent++;
    } catch (err) {
      console.error("missingPodSweep send:", row.id, err); failed++;
    }
  }

  return { sent, failed, matched: totalMatched, eligible: eligible.length, skipped, suppressed };
}

// ── Entrypoint ─────────────────────────────────────────────────────────

/**
 * Run all three sweeps. Returns a summary object — log it after each
 * tick so we can grep Railway logs for "[cron]" to audit fires.
 */
export async function runConfirmReminders(): Promise<{
  ranAt:      string;
  evening:    Awaited<ReturnType<typeof runEveningSweep>>;
  prePickup:  Awaited<ReturnType<typeof runPrePickupSweep>>;
  missingPod: Awaited<ReturnType<typeof runMissingPodSweep>>;
}> {
  const rulesCache = new Map<string, NotificationRules>();
  const evening    = await runEveningSweep(rulesCache);
  const prePickup  = await runPrePickupSweep(rulesCache);
  const missingPod = await runMissingPodSweep(rulesCache);
  return {
    ranAt: new Date().toISOString(),
    evening,
    prePickup,
    missingPod,
  };
}
