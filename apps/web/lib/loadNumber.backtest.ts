/**
 * Backtest promoteLoadNumber against real Curzon loads.
 *
 * Ground truth = the load_num a dispatcher ended up with. Two
 * populations matter, and they pull in opposite directions:
 *
 *   RECOVERABLE — the load number appears verbatim among the
 *     references, i.e. the extractor filed it in the wrong place.
 *     This is the reported failure. Here we want the guard to fire
 *     and to pick the right one.
 *
 *   NOT RECOVERABLE — the load number is nowhere in the references.
 *     If the extractor had returned an empty Load # on one of these,
 *     any promotion is a WRONG number in the field that drives
 *     invoicing. Here we want the guard to decline.
 *
 * Run from apps/web:  npx tsx lib/loadNumber.backtest.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { promoteLoadNumber } from './loadNumber';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => {
  const line = env.split('\n').find(l => l.startsWith(k + '='));
  if (!line) throw new Error(`missing ${k}`);
  return line.split('=').slice(1).join('=').trim();
};
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const ORG = process.env.ORG_ID ?? 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';

interface Row { internal_load_id: number; load_num: string | null; ref_nums: string | null; broker: string | null; }

async function fetchAll(): Promise<Row[]> {
  const out: Row[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('loads')
      .select('internal_load_id, load_num, ref_nums, broker')
      .eq('org_id', ORG).is('deleted_at', null)
      .is('imported_source', null)
      .not('ref_nums', 'is', null)
      .order('internal_load_id').range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

const parseRefs = (s: string | null): Array<{ label?: string; value?: string }> => {
  if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j : []; } catch { return []; }
};

async function main() {
  const rows = await fetchAll();

  let recovRight = 0, recovWrong = 0, recovDeclined = 0;
  let safeDeclined = 0, safeWrong = 0;
  const wrongPicks: string[] = [];
  const falsePromotes = new Map<string, number>();
  const missedLabels = new Map<string, number>();

  for (const r of rows) {
    const actual = (r.load_num ?? '').trim();
    const refs = parseRefs(r.ref_nums).filter(x => (x?.value ?? '').trim());
    if (!actual || refs.length === 0) continue;

    const res = promoteLoadNumber('', r.ref_nums);
    const recoverable = refs.some(x => (x.value ?? '').trim() === actual);

    if (recoverable) {
      if (!res.promoted) {
        recovDeclined++;
        const held = refs.find(x => (x.value ?? '').trim() === actual);
        const l = (held?.label ?? '(unlabelled)').toLowerCase().trim();
        missedLabels.set(l, (missedLabels.get(l) ?? 0) + 1);
      } else if (res.loadNum === actual) recovRight++;
      else {
        recovWrong++;
        if (wrongPicks.length < 20) wrongPicks.push(`  ${r.internal_load_id} ${(r.broker ?? '').slice(0, 22).padEnd(23)} human=${actual.padEnd(14)} guard=${res.loadNum} (${res.fromLabel})`);
      }
    } else {
      if (res.promoted) {
        safeWrong++;
        const l = (res.fromLabel ?? '').toLowerCase().trim();
        falsePromotes.set(l, (falsePromotes.get(l) ?? 0) + 1);
      } else safeDeclined++;
    }
  }

  const recov = recovRight + recovWrong + recovDeclined;
  const safe  = safeDeclined + safeWrong;
  const pct = (n: number, d: number) => `${(n / (d || 1) * 100).toFixed(1)}%`;

  console.log(`\nloads carrying reference numbers: ${rows.length}`);
  console.log(`\n── RECOVERABLE: the load number is among the refs (n=${recov}) ──`);
  console.log(`  picked the right one:  ${recovRight} (${pct(recovRight, recov)})`);
  console.log(`  picked a wrong one:    ${recovWrong} (${pct(recovWrong, recov)})`);
  console.log(`  declined (left empty): ${recovDeclined} (${pct(recovDeclined, recov)})`);
  console.log(`\n── NOT RECOVERABLE: the load number is not in the refs (n=${safe}) ──`);
  console.log(`  declined, as it should:      ${safeDeclined} (${pct(safeDeclined, safe)})`);
  console.log(`  promoted a wrong number:     ${safeWrong} (${pct(safeWrong, safe)})`);

  const promoted = recovRight + recovWrong + safeWrong;
  console.log(`\n── overall, when the guard fires (n=${promoted}) ──`);
  console.log(`  it writes the number the dispatcher would have: ${recovRight} (${pct(recovRight, promoted)})`);

  if (falsePromotes.size) {
    console.log(`\n  labels behind the wrong promotions:`);
    for (const [l, c] of [...falsePromotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(c).padStart(4)}  ${l}`);
  }
  if (missedLabels.size) {
    console.log(`\n  labels we declined that DID hold the load number (lost recall):`);
    for (const [l, c] of [...missedLabels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(c).padStart(4)}  ${l}`);
  }
  if (wrongPicks.length) {
    console.log(`\n  wrong picks inside the recoverable set:`);
    for (const l of wrongPicks) console.log(l);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
