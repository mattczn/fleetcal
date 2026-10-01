/**
 * End-to-end check of the Load # extraction against real rate cons.
 *
 * The backtest measures the guard; this measures the MODEL — it pulls
 * real PDFs out of the rate-cons bucket, runs the same pass-1 prompt
 * the route builds, and reports how often Load # comes back empty and
 * whether the guard then recovers it. Run it after any change to the
 * loadNum / refNums extraction hints in lib/fields.ts.
 *
 * Needs a working ANTHROPIC_API_KEY in apps/web/.env.local (the parse
 * route's own key — the eval bills the same account the app does).
 *
 * Run from apps/web:
 *   npx tsx lib/loadNumber.eval.ts            # 20 docs, Freight Tec first
 *   BROKER='uber' LIMIT=10 npx tsx lib/loadNumber.eval.ts
 */
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import { buildRateConPrompt, DEFAULT_PROMPT_VARIABLES } from './prompt';
import { promoteLoadNumber } from './loadNumber';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k: string) => {
  const line = env.split('\n').find(l => l.startsWith(k + '='));
  if (!line) throw new Error(`missing ${k} in apps/web/.env.local`);
  return line.split('=').slice(1).join('=').trim();
};

const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'));
const anthropic = new Anthropic({ apiKey: get('ANTHROPIC_API_KEY') });

const ORG    = process.env.ORG_ID ?? 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';
const MODEL  = 'claude-haiku-4-5-20251001';   // same as the route's pass 1
const LIMIT  = Number(process.env.LIMIT ?? 20);
const BROKER = process.env.BROKER ?? 'freight tec';

interface Row { internal_load_id: number; load_num: string | null; ref_nums: string | null; broker: string | null; rate_con_pdf: string | null; }

/** The named broker first (that's the reported failure), then a spread
 *  of other brokers so a hint change that fixes one and breaks the
 *  rest is visible in the same run. */
async function pickDocs(): Promise<Row[]> {
  const { data, error } = await sb.from('loads')
    .select('internal_load_id, load_num, ref_nums, broker, rate_con_pdf')
    .eq('org_id', ORG).is('deleted_at', null).is('imported_source', null)
    .not('rate_con_pdf', 'is', null)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) throw error;
  const rows = (data ?? []) as Row[];

  const target = new RegExp(BROKER.replace(/\s+/g, '\\s*'), 'i');
  const primary = rows.filter(r => target.test(r.broker ?? '')).slice(0, Math.ceil(LIMIT / 2));
  const seen = new Set<string>();
  const others: Row[] = [];
  for (const r of rows) {
    const b = (r.broker ?? '').toLowerCase();
    if (!b || target.test(b) || seen.has(b)) continue;
    seen.add(b);
    others.push(r);
    if (primary.length + others.length >= LIMIT) break;
  }
  return [...primary, ...others];
}

async function download(path: string): Promise<string | null> {
  const { data, error } = await sb.storage.from('rate-cons').download(path);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) return null;
  return buf.toString('base64');
}

async function main() {
  const docs = await pickDocs();
  // Only the two fields under test, so a run is cheap and the result
  // isolates the hint change rather than the whole schema.
  const prompt = buildRateConPrompt(['loadNum', 'refNums'], '', DEFAULT_PROMPT_VARIABLES);
  console.log(`model=${MODEL}  docs=${docs.length}\n`);

  let modelFilled = 0, guardRecovered = 0, stillEmpty = 0, matchesSaved = 0, scored = 0;

  for (const d of docs) {
    const b64 = d.rate_con_pdf ? await download(d.rate_con_pdf) : null;
    if (!b64) { console.log(`  ${d.internal_load_id} — PDF unavailable, skipped`); continue; }

    let out: Record<string, unknown>;
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: prompt },
        ] }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '';
      const m = text.match(/\{[\s\S]*\}/);
      out = JSON.parse(m ? m[0] : text);
    } catch (err) {
      console.log(`  ${d.internal_load_id} — call failed: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }

    const raw   = String(out.loadNum ?? '').trim();
    const after = promoteLoadNumber(out.loadNum, out.refNums);
    const saved = (d.load_num ?? '').trim();

    if (raw) modelFilled++;
    else if (after.promoted) guardRecovered++;
    else stillEmpty++;
    if (saved) { scored++; if (after.loadNum === saved) matchesSaved++; }

    const how = raw ? 'model' : after.promoted ? `guard(${after.fromLabel})` : 'EMPTY';
    const flag = saved && after.loadNum !== saved ? '  <-- differs from saved' : '';
    console.log(`  ${String(d.internal_load_id).padEnd(6)} ${(d.broker ?? '').slice(0, 20).padEnd(21)} saved=${(saved || '—').padEnd(14)} got=${(after.loadNum || '—').padEnd(14)} ${how}${flag}`);
  }

  const n = modelFilled + guardRecovered + stillEmpty;
  console.log(`\n── Load # on ${n} rate cons ──`);
  console.log(`  model filled it:     ${modelFilled}`);
  console.log(`  guard recovered it:  ${guardRecovered}`);
  console.log(`  still empty:         ${stillEmpty}`);
  if (scored) console.log(`  matches the number on the saved load: ${matchesSaved}/${scored}`);
}

main().catch(e => { console.error(e); process.exit(1); });
