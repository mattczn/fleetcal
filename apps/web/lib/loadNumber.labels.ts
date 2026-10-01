/**
 * Which reference LABELS actually carry the load number?
 *
 * Ground truth: loads where the dispatcher's load_num appears verbatim
 * among the reference values. For those we know which label the load
 * number was hiding under. For every other label we can count how
 * often it is present but is NOT the load number — that's the false
 * positive rate of promoting from that label.
 *
 * Run from apps/web:  npx tsx lib/loadNumber.labels.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function main() {
  const rows = await fetchAll();

  // hit  = label carried the load number on this load
  // miss = label present on a load whose load number is ALSO in the
  //        refs, but under a different label → promoting from this
  //        label would have been wrong
  // unknown = label present on a load whose load number isn't in the
  //        refs at all → no evidence either way
  const stat = new Map<string, { hit: number; miss: number; unknown: number }>();
  const bump = (l: string, k: 'hit' | 'miss' | 'unknown') => {
    const key = norm(l) || '(unlabelled)';
    const s = stat.get(key) ?? { hit: 0, miss: 0, unknown: 0 };
    s[k]++; stat.set(key, s);
  };

  let inRefs = 0, notInRefs = 0, noLoadNum = 0;

  for (const r of rows) {
    const actual = (r.load_num ?? '').trim();
    const refs = parseRefs(r.ref_nums).filter(x => (x?.value ?? '').trim());
    if (refs.length === 0) continue;
    if (!actual) { noLoadNum++; continue; }

    const carrier = refs.find(x => (x.value ?? '').trim() === actual);
    if (carrier) {
      inRefs++;
      for (const x of refs) bump(x.label ?? '', (x.value ?? '').trim() === actual ? 'hit' : 'miss');
    } else {
      notInRefs++;
      for (const x of refs) bump(x.label ?? '', 'unknown');
    }
  }

  console.log(`\nloads with refs + a load number: ${inRefs + notInRefs}`);
  console.log(`  load number IS one of the refs:  ${inRefs} (${(inRefs / (inRefs + notInRefs) * 100).toFixed(1)}%)`);
  console.log(`  load number is NOT in the refs:  ${notInRefs} (${(notInRefs / (inRefs + notInRefs) * 100).toFixed(1)}%)  <-- nothing to promote`);
  console.log(`  loads with refs but no load number: ${noLoadNum}`);

  const ranked = [...stat.entries()]
    .filter(([, s]) => s.hit + s.miss >= 5)
    .map(([label, s]) => ({ label, ...s, precision: s.hit / (s.hit + s.miss) }))
    .sort((a, b) => b.precision - a.precision || b.hit - a.hit);

  console.log(`\nlabel                     hit   miss   precision   (unknown)`);
  console.log(`-------------------------------------------------------------`);
  for (const r of ranked) {
    console.log(`${r.label.padEnd(24)} ${String(r.hit).padStart(5)} ${String(r.miss).padStart(6)}   ${(r.precision * 100).toFixed(0).padStart(6)}%   ${String(r.unknown).padStart(7)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
