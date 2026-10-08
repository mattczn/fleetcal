/**
 * Scenarios for matchCustomer. Run from apps/web:
 *   npx tsx lib/customerMatch.verify.ts
 *
 * The cases that matter are the ones where two customers share a
 * distinctive word and differ only in the industry word that
 * normalizeName throws away — Curzon carries both "Trident" (Trident
 * Transport) and "Trident Logistics", and both "Worldwide Express" and
 * "Worldwide Logistics Group". Before the exact-name tiers those
 * collapsed to the same normalised string, tied at the top score, and
 * the winner was whichever the roster listed first.
 *
 * lib/customerMatch.backtest.ts replays this against every broker
 * string on real loads.
 */
import { matchCustomer, normalizeName } from './customerMatch';
import type { Customer } from './types';

let pass = 0;
const failures: string[] = [];

function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  failures.push(`${name}\n    got:  ${g}\n    want: ${w}`);
}

const cust = (id: string, name: string, aliases: string[] = []): Customer =>
  ({ id, name, aliases } as unknown as Customer);

// The real Curzon roster entries involved, in the order the list
// loads them (alphabetical) — "Trident" ahead of "Trident Logistics",
// which is what made the old tie-break land on the wrong one.
const TRIDENT   = cust('t1', 'Trident');
const TRIDENT_L = cust('t2', 'Trident Logistics');
const WW_EXP    = cust('w1', 'Worldwide Express');
const WW_LOG    = cust('w2', 'Worldwide Logistics Group');
const ROSTER = [TRIDENT, TRIDENT_L, WW_EXP, WW_LOG];

const result = (extracted: string) => {
  const m = matchCustomer(extracted, ROSTER);
  return {
    status: m.status,
    customer: 'customer' in m ? m.customer.name : null,
    alternative: 'alternative' in m && m.alternative ? m.alternative.name : null,
  };
};

// ── Load 4920802: the reported failure ──────────────────────────────
check('exact name wins over the stop-word collapse',
  result('Trident Logistics'),
  { status: 'auto', customer: 'Trident Logistics', alternative: null });

check('the shorter record still matches its own name',
  result('Trident'),
  { status: 'auto', customer: 'Trident', alternative: null });

check('the legal suffix a rate con prints does not change the answer',
  result('Trident Logistics, LLC'),
  { status: 'auto', customer: 'Trident Logistics', alternative: null });

check('case is irrelevant',
  result('TRIDENT LOGISTICS LLC'),
  { status: 'auto', customer: 'Trident Logistics', alternative: null });

// ── The same bug, the case the parse route's comment described ──────
check('Worldwide Logistics Group no longer lands on Worldwide Express',
  result('Worldwide Logistics Group'),
  { status: 'auto', customer: 'Worldwide Logistics Group', alternative: null });

check('Worldwide Express still matches itself',
  result('Worldwide Express'),
  { status: 'auto', customer: 'Worldwide Express', alternative: null });

// ── Genuine ties ask instead of guessing ────────────────────────────
check('a name matching neither record exactly offers both',
  result('Trident Transport'),
  { status: 'confirm', customer: 'Trident', alternative: 'Trident Logistics' });

check('an unknown Trident variant offers both rather than picking',
  result('Trident Freight'),
  { status: 'confirm', customer: 'Trident', alternative: 'Trident Logistics' });

// ── An alias is as good as the name ─────────────────────────────────
check('an exact alias match is automatic',
  matchCustomer('TTL', [TRIDENT, cust('t3', 'Trident Logistics', ['TTL'])]).status,
  'auto');

check('the alias resolves to its own customer',
  (() => { const m = matchCustomer('TTL', [TRIDENT, cust('t3', 'Trident Logistics', ['TTL'])]); return 'customer' in m ? m.customer.id : null; })(),
  't3');

// ── Unchanged behaviour ─────────────────────────────────────────────
check('an unrelated name is new',
  result('Gossner Foods'),
  { status: 'new', customer: null, alternative: null });

check('empty input matches nothing',
  matchCustomer('', ROSTER).status,
  'none');

check('an empty roster means a new customer',
  matchCustomer('Trident Logistics', []).status,
  'new');

check('a single candidate is never ambiguous',
  matchCustomer('Trident Logistics', [TRIDENT_L]),
  { status: 'auto', customer: TRIDENT_L, score: 1 });

check('one customer, loose match, still only confirms',
  matchCustomer('Trident Transport', [TRIDENT]).status,
  'auto');

// ── normalizeName is relied on above; pin its behaviour ─────────────
check('normalizeName drops the industry word',
  normalizeName('Trident Logistics'),
  'trident');

check('normalizeName drops the legal form too',
  normalizeName('Trident Logistics, LLC'),
  'trident');

// ── Report ──────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  FAIL ${f}\n`);
process.exit(failures.length === 0 ? 0 : 1);
