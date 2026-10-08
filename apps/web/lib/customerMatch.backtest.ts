/**
 * Compare the broker matcher before and after the exact-name +
 * ambiguity changes, over every distinct broker string on real loads.
 *
 * Two things to watch:
 *   - matches that move to a DIFFERENT customer (the fix, or a
 *     regression — read each one)
 *   - matches that stop being automatic and start asking (the cost;
 *     a handful is the point, a flood means AMBIGUITY_MARGIN is wrong)
 *
 * Run from apps/web:  npx tsx lib/customerMatch.backtest.ts
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { matchCustomer } from './customerMatch';
import type { Customer } from './types';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => {
  const line = env.split('\n').find(l => l.startsWith(k + '='));
  if (!line) throw new Error(`missing ${k}`);
  return line.split('=').slice(1).join('=').trim();
};
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const ORG = process.env.ORG_ID ?? 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';

// ── The matcher as it was before this change ────────────────────────
const STOP_WORDS = new Set([
  'llc', 'inc', 'corp', 'co', 'company', 'ltd', 'limited', 'group', 'international',
  'freight', 'logistics', 'transport', 'transportation', 'trucking', 'carriers',
  'carrier', 'solutions', 'services', 'service', 'systems', 'global', 'national',
  'express', 'direct', 'lines', 'line', 'usa', 'us',
]);
const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w)).join(' ').trim();
const wordSet = (s: string) => new Set(s.split(' ').filter(Boolean));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
};
function oldScore(extracted: string, candidate: string): number {
  const normEx = normalizeName(extracted), normCand = normalizeName(candidate);
  const rawEx = extracted.toLowerCase().trim(), rawCand = candidate.toLowerCase().trim();
  if (!normEx || !normCand) {
    if (rawEx === rawCand) return 1.0;
    if (rawCand.includes(rawEx) || rawEx.includes(rawCand)) return 0.85;
    return 0;
  }
  if (normEx === normCand) return 1.0;
  if (normCand.includes(normEx) || normEx.includes(normCand)) return 0.9;
  return jaccard(wordSet(normEx), wordSet(normCand)) * 0.95;
}
function oldMatch(extracted: string, customers: Customer[]) {
  if (!extracted?.trim()) return { status: 'none' as const };
  if (customers.length === 0) return { status: 'new' as const };
  let best: { customer: Customer; score: number } | null = null;
  for (const c of customers) {
    const score = Math.max(...[c.name, ...c.aliases].map(a => oldScore(extracted, a)));
    if (!best || score > best.score) best = { customer: c, score };
  }
  if (!best || best.score < 0.35) return { status: 'new' as const };
  if (best.score >= 0.85) return { status: 'auto' as const, customer: best.customer, score: best.score };
  if (best.score >= 0.5)  return { status: 'confirm' as const, customer: best.customer, score: best.score };
  return { status: 'new' as const };
}

async function main() {
  const { data: custRows, error: e1 } = await sb.from('customers')
    .select('id, name, aliases, short_name').eq('org_id', ORG).order('name');
  if (e1) throw e1;
  const customers = (custRows ?? []).map(c => ({
    id: c.id, name: c.name,
    aliases: Array.isArray(c.aliases) ? c.aliases as string[] : [],
    shortName: c.short_name ?? undefined,
  })) as unknown as Customer[];

  const brokers = new Map<string, number>();
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from('loads').select('broker')
      .eq('org_id', ORG).is('deleted_at', null).not('broker', 'is', null)
      .order('id').range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const b = (r.broker ?? '').trim();
      if (b) brokers.set(b, (brokers.get(b) ?? 0) + 1);
    }
    if (!data || data.length < 1000) break;
    from += 1000;
  }

  console.log(`customers: ${customers.length}   distinct broker strings on loads: ${brokers.size}\n`);

  const changedCustomer: string[] = [];
  const nowAsks: string[] = [];
  const nowAuto: string[] = [];
  let same = 0;

  for (const [broker, count] of [...brokers.entries()].sort((a, b) => b[1] - a[1])) {
    const before = oldMatch(broker, customers);
    const after  = matchCustomer(broker, customers);
    const bc = (before as { customer?: Customer }).customer;
    const ac = (after  as { customer?: Customer }).customer;
    const bId = bc?.id ?? null;
    const aId = ac?.id ?? null;
    const bName = bc?.name ?? before.status;
    const aName = ac?.name ?? after.status;

    if (before.status === after.status && bId === aId) { same++; continue; }
    const line = `  ${String(count).padStart(4)}×  "${broker}"  ${before.status}:${bName} → ${after.status}:${aName}` +
      ('alternative' in after && after.alternative ? ` (or ${after.alternative.name})` : '');
    if (bId !== aId && aId) changedCustomer.push(line);
    else if (before.status === 'auto' && after.status === 'confirm') nowAsks.push(line);
    else if (after.status === 'auto' && before.status !== 'auto') nowAuto.push(line);
    else changedCustomer.push(line);
  }

  console.log(`unchanged: ${same}`);
  console.log(`\n── now resolves to a DIFFERENT customer (${changedCustomer.length}) ──`);
  for (const l of changedCustomer) console.log(l);
  console.log(`\n── was automatic, now asks (${nowAsks.length}) ──`);
  for (const l of nowAsks) console.log(l);
  if (nowAuto.length) {
    console.log(`\n── now automatic where it previously asked (${nowAuto.length}) ──`);
    for (const l of nowAuto) console.log(l);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
