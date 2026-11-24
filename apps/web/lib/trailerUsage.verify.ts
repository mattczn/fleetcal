/**
 * Scenarios for trailer usage resolution — in particular the four
 * things that end a link between a trailer and a tractor. Run from
 * apps/web:
 *   npx tsx lib/trailerUsage.verify.ts
 *
 * Times are built relative to the real current moment and the org tz
 * is left undefined, so the fixtures and the function agree on "now"
 * without the function needing a clock injected. Nothing is asserted
 * at exactly now, so a minute ticking over mid-run can't flip a case.
 */
import { getTrailerUsage, HOOK_MAX_DAYS, type CalendarEventLike } from './trailerUsage';

let pass = 0;
const failures: string[] = [];
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

const OURS   = 10;
const THEIRS = 11;
const TRUCK_A = 100;
const TRUCK_B = 200;
const UNASSIGNED = 999;

/** A naive "YYYY-MM-DDTHH:mm" `h` hours from now, same frame the
 *  function uses when orgTz is undefined. */
function at(h: number): string {
  const d = new Date(Date.now() + h * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let seq = 0;
type Fixture = {
  start: string; end: string;
  trailerId?: number; assetId?: number; status?: string; deletedAt?: string;
};
function load(f: Fixture): CalendarEventLike {
  return {
    id: `L${++seq}`,
    trailerId: OURS,
    assetId: TRUCK_A,
    status: 'delivered',
    ...f,
  } as CalendarEventLike;
}

const usage = (events: CalendarEventLike[], opts = {}) =>
  getTrailerUsage(OURS, events, undefined, opts);

// ── nothing at all ──────────────────────────────────────────────────
check('no events is idle', usage([]).status, 'idle');

// ── a live load still wins ──────────────────────────────────────────
const live = load({ start: at(-2), end: at(2), status: 'en_route' });
check('a running load is in use', usage([live]).status, 'in_use');
check('…and it is the load returned', usage([live]).load?.id, live.id);
check('a yard does not cancel a running load',
  usage([live], { atYard: true }).status, 'in_use');

// ── THE ASK: the link outlives the load ─────────────────────────────
const over = load({ start: at(-9), end: at(-3) });
check('a load that ended 3h ago still hooks the trailer',
  usage([over]).status, 'in_use');
check('…and names the load it came from', usage([over]).load?.id, over.id);

// ── rule 1: a yard ends it ──────────────────────────────────────────
check('parked in one of our yards, it is a spare again',
  usage([over], { atYard: true }).status, 'idle');

// ── rule 3: the age bound ───────────────────────────────────────────
check('a hookup just inside the bound survives',
  usage([load({ start: at(-24 * HOOK_MAX_DAYS), end: at(-24 * (HOOK_MAX_DAYS - 1)) })]).status,
  'in_use');
check('a hookup past the bound does not',
  usage([load({ start: at(-24 * 30), end: at(-24 * (HOOK_MAX_DAYS + 1)) })]).status,
  'idle');

// ── rule 2: the truck moved on ──────────────────────────────────────
check('the tractor since taking another trailer breaks the hook',
  usage([over, load({ trailerId: THEIRS, start: at(-1), end: at(5), status: 'en_route' })]).status,
  'idle');
check('a swap SCHEDULED for later has not happened yet',
  usage([over, load({ trailerId: THEIRS, start: at(5), end: at(12), status: 'scheduled' })]).status,
  'in_use');
check('a later load on that tractor recording NO trailer is not a drop',
  usage([over, load({ trailerId: undefined, start: at(-1), end: at(5), status: 'en_route' })]).status,
  'in_use');
check('a later load on that tractor with the SAME trailer keeps it',
  usage([over, load({ start: at(-2), end: at(-1) })]).status,
  'in_use');
check('another TRUCK taking a different trailer is irrelevant',
  usage([over, load({ assetId: TRUCK_B, trailerId: THEIRS, start: at(-1), end: at(5), status: 'en_route' })]).status,
  'in_use');

// ── loads that never ran never hooked anything ──────────────────────
check('a cancelled load leaves nothing hooked',
  usage([load({ start: at(-9), end: at(-3), status: 'cancelled' })]).status, 'idle');
check('a TONU leaves nothing hooked',
  usage([load({ start: at(-9), end: at(-3), status: 'tonu' })]).status, 'idle');
check('a deleted load leaves nothing hooked',
  usage([load({ start: at(-9), end: at(-3), deletedAt: new Date().toISOString() })]).status, 'idle');
check('a cancelled load does not break a real hook either',
  usage([over, load({ trailerId: THEIRS, start: at(-1), end: at(5), status: 'cancelled' })]).status,
  'in_use');

// ── no real tractor to link to ──────────────────────────────────────
check('a load parked on Unassigned hooks nothing',
  usage([load({ start: at(-9), end: at(-3), assetId: UNASSIGNED })],
        { unassignedAssetId: UNASSIGNED }).status,
  'idle');
check('…but the same load hooks fine when that id is a real truck',
  usage([load({ start: at(-9), end: at(-3), assetId: UNASSIGNED })]).status,
  'in_use');

// ── a retired tractor is holding nothing ────────────────────────────
// Real case: P-SWAP pulled #633453 on the 18th and was retired on
// the 22nd. The load is well inside the age bound and the truck
// never took another trailer, so every other rule said "hooked" —
// but the tractor is out of the fleet.
check('a retired tractor cannot hold a hook',
  usage([over], { retiredAssetIds: new Set([TRUCK_A]) }).status, 'idle');
check('another truck being retired is irrelevant',
  usage([over], { retiredAssetIds: new Set([TRUCK_B]) }).status, 'in_use');
check('retirement does not touch a load running RIGHT NOW',
  usage([live], { retiredAssetIds: new Set([TRUCK_A]) }).status, 'in_use');

// ── delivered early, window still open ──────────────────────────────
// The gap this closes: the load is no longer running (delivered) but
// its end hasn't arrived, so it is neither live nor "past its
// window". Without treating delivered as over, the link blanked for
// those hours and came back later — which looks like a glitch.
const early = load({ start: at(-2), end: at(4), status: 'delivered' });
check('delivered early still hooks, mid-window', usage([early]).status, 'in_use');
check('…and names that load', usage([early]).load?.id, early.id);

// ── several finished loads: the most recent wins ────────────────────
const old   = load({ assetId: TRUCK_A, start: at(-72), end: at(-48) });
const newer = load({ assetId: TRUCK_B, start: at(-9), end: at(-3) });
check('the latest finished load decides the truck',
  usage([old, newer]).load?.id, newer.id);
check('…with order of the array irrelevant',
  usage([newer, old]).load?.id, newer.id);

// ── a load in progress whose window has lapsed ──────────────────────
// Common in real data: nobody closed it out. It still hooked the
// trailer, so it reads as hooked rather than vanishing.
check('a stale en_route load whose window lapsed still hooks',
  usage([load({ start: at(-30), end: at(-6), status: 'en_route' })]).status, 'in_use');
check('a problem load still hooked the trailer',
  usage([load({ start: at(-9), end: at(-3), status: 'problem' })]).status, 'in_use');

// ── another trailer's work doesn't leak in ──────────────────────────
check('a load for a different trailer leaves ours idle',
  usage([load({ trailerId: THEIRS, start: at(-9), end: at(-3) })]).status, 'idle');

// ── a future load has not hooked anything yet ───────────────────────
check('a load scheduled for tomorrow hooks nothing today',
  usage([load({ start: at(20), end: at(28), status: 'scheduled' })]).status, 'idle');

// ── live vs left behind ─────────────────────────────────────────────
// Both are in_use — a truck has the trailer either way, which is the
// one thing a dispatcher wants off this field. `live` is the finer
// fact: only a running load's route is where the trailer is going.
check('a running load is live', usage([live]).live, true);
check('a finished load that still holds it is NOT live', usage([over]).live, false);
check('delivered-early mid-window is not live', usage([early]).live, false);
check('an idle trailer is not live', usage([]).live, false);
check('a lapsed en_route load is not live',
  usage([load({ start: at(-30), end: at(-6), status: 'en_route' })]).live, false);

console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
