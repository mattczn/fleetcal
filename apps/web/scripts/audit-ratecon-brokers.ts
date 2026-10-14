/**
 * Read-only audit: re-read the broker name off every stored rate con and
 * flag the loads where it disagrees with the customer the load is linked to.
 *
 * Why this exists
 * ---------------
 * Until 2026-09-04 the rate-con parser ran cleanBrokerName() on the
 * extracted broker BEFORE matchCustomer() saw it, so "Worldwide Logistics
 * Group" arrived at the matcher as "Worldwide" and scored 1.00 against
 * "Worldwide Express". The auto-link branch then overwrote the load's
 * broker TEXT with the matched customer's name — so the text and the FK
 * agree and a text-vs-link diff finds nothing. The only way to see these
 * is to go back to the source document.
 *
 * This script WRITES NOTHING to the database. It produces a CSV for
 * manual review.
 *
 * Matching deliberately imports the app's real matchCustomer() rather
 * than reimplementing it, so the audit can never drift from what the
 * app actually does.
 *
 * Rate cons mostly do NOT print the broker's MC number (measured: 12 of
 * 56 sampled, and some of those are the carrier's), so this matches on
 * the company name as printed.
 *
 * Run
 * ---
 *   cd apps/web
 *   npx tsx scripts/audit-ratecon-brokers.ts --limit 50     # pilot
 *   npx tsx scripts/audit-ratecon-brokers.ts                # full run
 *   npx tsx scripts/audit-ratecon-brokers.ts --since 2026-06-01
 *   npx tsx scripts/audit-ratecon-brokers.ts --only-flagged # CSV of problems only
 *
 * Only the EXTRACTION (what the document says) is cached, in
 * audit-ratecon-extractions.jsonl. Classification runs fresh on every
 * invocation, so the verdict rules below can be re-tuned and the CSV
 * regenerated for free — a re-run costs money only for loads never
 * read before. Delete the .jsonl to force a full re-read.
 *
 * Env: read from apps/web/.env.local — NEXT_PUBLIC_SUPABASE_URL (or
 * SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY.
 */
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankCustomers } from '../lib/customerMatch';
import type { Customer } from '@fleetcal/types';

const execFileAsync = promisify(execFile);

// This script lives in apps/web (not apps/api) on purpose: apps/api is
// ESM and apps/web is CJS, so an apps/api script cannot import
// lib/customerMatch by a named export at runtime. Keeping it next to
// the matcher is what lets the audit share the app's real scoring code
// instead of a copy that would silently drift.
dotenv.config({ path: ['.env.local', '.env'] });

// ── Config ──────────────────────────────────────────────────────────
const CURZON_ORG = 'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN';
const MODEL      = 'claude-haiku-4-5-20251001';
// Rate card for MODEL, USD per 1M tokens. Mirrors apps/web/lib/aiPricing.ts.
const RATE_IN    = 1.0;
const RATE_OUT   = 5.0;

/**
 * Brokers Matt has confirmed are clean and that dominate the load count
 * — reviewing them is wasted effort. Compared case-insensitively
 * against BOTH the load's broker text and its linked customer name, so
 * a variant spelling still gets skipped.
 */
const IGNORED_BROKERS = [
  'ITS National LLC',
  'Triple T Transport',
  'Uber Freight LLC',
].map(s => s.toLowerCase());

/** Below this many characters of extracted text we assume the PDF is a
 *  scan and send the document itself (image tokens) instead. */
const MIN_TEXT_CHARS = 250;
/** Rate cons run long with T&C pages; the broker is always named up
 *  front and this keeps the token bill down. */
const MAX_TEXT_CHARS = 6000;
const CONCURRENCY    = 6;

const OUT_DIR   = process.cwd();
const JSONL     = path.join(OUT_DIR, 'audit-ratecon-extractions.jsonl');
const CSV       = path.join(OUT_DIR, 'audit-ratecon-brokers.csv');

// ── Args ────────────────────────────────────────────────────────────
const argv        = process.argv.slice(2);
const argOf       = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SINCE       = argOf('--since', '2026-06-01');
const LIMIT       = Number(argOf('--limit', '0')) || 0;
const ORG         = argOf('--org', CURZON_ORG);
const ONLY_FLAGGED = argv.includes('--only-flagged');

// ── Clients ─────────────────────────────────────────────────────────
// .env.local names it NEXT_PUBLIC_SUPABASE_URL; Railway names it SUPABASE_URL.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY required');
if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required');

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Types ───────────────────────────────────────────────────────────
type LoadRow = {
  id: string;
  internal_load_id: number | null;
  load_num: string | null;
  broker: string | null;
  customer_id: string | null;
  rate_con_pdf: string | null;
  created_at: string;
};

/**
 * The question every verdict answers is "does the document support the
 * link this load already has?" — NOT "who would the matcher pick?".
 * An earlier cut reported the matcher's own status and every single
 * flag was a false positive: rate cons print the full legal name
 * ("Summit Creek Logistics, LLC") while the roster holds the short one
 * ("Summit Creek"), which lands in the confirm band even though the
 * link is perfectly correct.
 */
type Verdict =
  | 'MISLINK'         // document points at a DIFFERENT customer, clearly better than the linked one
  | 'WEAK_SUPPORT'    // linked customer is plausible but not the document's best match
  | 'NO_ROSTER_MATCH' // name on the document matches nothing — usually a missing alias
  | 'NOT_LINKED'      // load has no customer linked at all
  | 'UNREADABLE'      // couldn't read a broker name off the document
  | 'OK';             // document's best match IS the linked customer

/** The expensive half: what the document actually says. Cached. */
type Extraction = {
  load_id: string;
  broker: string;
  carrier: string;
  confidence: string;
  source: 'text' | 'pdf' | 'none';
  error: string;
};

/** The free half: recomputed every run. */
type Result = Extraction & {
  load_num: string | null;
  internal_load_id: number | null;
  verdict: Verdict;
  stored_broker: string | null;
  linked_customer: string | null;
  best_match: string | null;
  best_score: number | null;
  linked_score: number | null;
  suggested_alias: string;
  note: string;
};

// ── Rate-con blob resolution ────────────────────────────────────────
/** `loads.rate_con_pdf` holds either a storage object path or, on
 *  legacy rows, an inline `data:application/pdf;base64,…` URI. */
async function fetchPdf(ref: string): Promise<Buffer | null> {
  if (ref.startsWith('data:')) {
    const comma = ref.indexOf(',');
    if (comma < 0) return null;
    try { return Buffer.from(ref.slice(comma + 1), 'base64'); } catch { return null; }
  }
  // rate_con is dispatcher-confidential and lives in its own bucket, but
  // legacy rows predate the split (see lib/docBuckets.ts).
  for (const bucket of ['rate-cons', 'load-documents']) {
    const { data, error } = await sb.storage.from(bucket).download(ref);
    if (!error && data) return Buffer.from(await data.arrayBuffer());
  }
  return null;
}

let pdftotextAvailable = true;
/** Text extraction is ~5x cheaper than sending page images. Scanned
 *  rate cons yield nothing here and fall back to the document path. */
async function pdfToText(buf: Buffer): Promise<string> {
  if (!pdftotextAvailable) return '';
  const tmp = path.join(os.tmpdir(), `rc-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    await fs.promises.writeFile(tmp, buf);
    const { stdout } = await execFileAsync('pdftotext', [tmp, '-'], { maxBuffer: 20e6 });
    return stdout;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      pdftotextAvailable = false;
      console.warn('! pdftotext not found — sending PDFs as documents (roughly 4x the token cost).');
    }
    return '';
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// ── Extraction ──────────────────────────────────────────────────────
const PROMPT = `You are reading a freight RATE CONFIRMATION.

Return ONLY this JSON object and nothing else:
{"broker_name":"...","carrier_name":"...","confidence":"high|medium|low"}

- broker_name: the FULL company name of the BROKER or SHIPPER who issued this
  rate confirmation and who PAYS the carrier. Copy it EXACTLY as printed,
  including words like Logistics, Group, Express, Worldwide, Inc, LLC.
  Do NOT shorten, abbreviate, normalise, correct or guess it.
  If the document shows a "DBA" / "d/b/a" name, return the full string as printed.
- carrier_name: the CARRIER being hired (usually Curzon Trucking). This field
  exists so you never confuse the two parties — the carrier is NOT the broker.
- confidence: "low" if the document is unreadable, or if you had to infer the
  broker rather than read it directly.

Use "" for any field not printed on the document.`;

let totalIn = 0, totalOut = 0;

async function extractBroker(buf: Buffer): Promise<{ broker: string; carrier: string; confidence: string; source: 'text' | 'pdf' }> {
  const text = await pdfToText(buf);
  const useText = text.trim().length >= MIN_TEXT_CHARS;

  const first = await askModel(buf, useText ? text : '');
  // A PDF whose text layer is partial (a scan with an OCR'd header, an
  // unusual layout) clears MIN_TEXT_CHARS but carries no readable
  // broker. Falling back to the document itself recovers those for the
  // ~5% that need it, at image-token cost only for those.
  if (useText && (!first.broker || first.confidence === 'low')) {
    const retry = await askModel(buf, '');
    if (retry.broker) return retry;
  }
  return first;
}

async function askModel(buf: Buffer, text: string): Promise<{ broker: string; carrier: string; confidence: string; source: 'text' | 'pdf' }> {
  const useText = text !== '';

  const content = useText
    ? [{ type: 'text' as const, text: `RATE CONFIRMATION TEXT:\n\n${text.slice(0, MAX_TEXT_CHARS)}\n\n${PROMPT}` }]
    : [
        { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: buf.toString('base64') } },
        { type: 'text' as const, text: PROMPT },
      ];

  const res = await withRetry(() => anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content }],
  }));

  totalIn  += res.usage.input_tokens ?? 0;
  totalOut += res.usage.output_tokens ?? 0;

  const raw = res.content.find(b => b.type === 'text');
  const body = raw && raw.type === 'text' ? raw.text : '';
  const json = body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
  try {
    const p = JSON.parse(json) as { broker_name?: string; carrier_name?: string; confidence?: string };
    return {
      broker:     (p.broker_name  ?? '').trim(),
      carrier:    (p.carrier_name ?? '').trim(),
      confidence: (p.confidence   ?? '').trim(),
      source:     useText ? 'text' : 'pdf',
    };
  } catch {
    return { broker: '', carrier: '', confidence: 'low', source: useText ? 'text' : 'pdf' };
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const status = (e as { status?: number })?.status;
      // 429 rate limit / 529 overloaded / 5xx are worth waiting out;
      // a 400 never becomes valid on retry.
      if (status && status < 500 && status !== 429) throw e;
      await new Promise(r => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

// ── Main ────────────────────────────────────────────────────────────
/** How far the best match must beat the linked customer before we call
 *  the link wrong rather than merely imperfect. */
const MISLINK_MARGIN = 0.15;
/** Below this the document tells us nothing about the linked customer. */
const SUPPORT_FLOOR  = 0.35;

async function main() {
  console.log(`Audit scope: org=${ORG} created_at >= ${SINCE}`);

  const { data: customersRaw, error: cErr } = await sb
    .from('customers').select('id,name,aliases,short_name').eq('org_id', ORG).limit(5000);
  if (cErr) throw cErr;
  // rankCustomers wants the web-app Customer shape (camelCase shortName).
  // Only id/name/aliases are read by the scorer; `contacts` is required
  // by the Customer type but never touched here.
  const customers: Customer[] = (customersRaw ?? []).map(c => ({
    id: c.id as string,
    name: c.name as string,
    aliases: (c.aliases ?? []) as string[],
    shortName: (c.short_name ?? undefined) as string | undefined,
    contacts: [],
  }));
  const byId = new Map(customers.map(c => [c.id, c]));
  console.log(`customers: ${customers.length}`);

  // Page explicitly — PostgREST silently caps a plain select at 1000 rows.
  const loads: LoadRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('loads')
      .select('id,internal_load_id,load_num,broker,customer_id,rate_con_pdf,created_at')
      .eq('org_id', ORG)
      .not('broker', 'is', null)
      .not('rate_con_pdf', 'is', null)
      .gte('created_at', SINCE)
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    loads.push(...(data as LoadRow[]));
    if (!data || data.length < 1000) break;
  }

  const inScope = loads.filter(l => !isIgnored(l, byId));
  const ignored = loads.length - inScope.length;

  const cache = new Map<string, Extraction>();
  if (fs.existsSync(JSONL)) {
    for (const line of fs.readFileSync(JSONL, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as Extraction; cache.set(e.load_id, e); } catch { /* partial line */ }
    }
    console.log(`cache: ${cache.size} documents already read`);
  }

  let queue = inScope.filter(l => !cache.has(l.id));
  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`in scope: ${inScope.length}   ignored brokers: ${ignored}   to read now: ${queue.length}`);

  const out = fs.createWriteStream(JSONL, { flags: 'a' });
  let n = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const load = queue.shift();
      if (!load) return;
      const e = await extractOne(load);
      cache.set(load.id, e);
      out.write(JSON.stringify(e) + '\n');
      if (++n % 25 === 0) {
        const cost = (totalIn / 1e6) * RATE_IN + (totalOut / 1e6) * RATE_OUT;
        console.log(`  ${n}/${n + queue.length} read … $${cost.toFixed(2)} so far`);
      }
    }
  }));
  out.end();

  const results = inScope
    .filter(l => cache.has(l.id))
    .map(l => classify(l, cache.get(l.id)!, customers, byId));
  writeCsv(results);
}

function isIgnored(l: LoadRow, byId: Map<string, { name: string }>): boolean {
  const text   = (l.broker ?? '').toLowerCase();
  const linked = (l.customer_id ? byId.get(l.customer_id)?.name ?? '' : '').toLowerCase();
  return IGNORED_BROKERS.some(b => text.includes(b) || (linked !== '' && linked.includes(b)));
}

/** Read one rate con. Never throws — failures come back as an
 *  Extraction with `error` set so they land in the CSV rather than
 *  killing a 2,700-document run. */
async function extractOne(load: LoadRow): Promise<Extraction> {
  const base: Extraction = { load_id: load.id, broker: '', carrier: '', confidence: '', source: 'none', error: '' };

  let buf: Buffer | null = null;
  try { buf = await fetchPdf(load.rate_con_pdf!); }
  catch (e) { return { ...base, error: `download failed: ${String(e).slice(0, 120)}` }; }
  if (!buf || buf.length === 0) return { ...base, error: 'rate con blob missing from storage' };

  try {
    const ex = await extractBroker(buf);
    return { ...base, broker: ex.broker, carrier: ex.carrier, confidence: ex.confidence, source: ex.source };
  } catch (e) {
    return { ...base, error: `extraction failed: ${String(e).slice(0, 120)}` };
  }
}

function classify(
  load: LoadRow,
  ex: Extraction,
  customers: Customer[],
  byId: Map<string, Customer>,
): Result {
  const linked = load.customer_id ? byId.get(load.customer_id) ?? null : null;
  const base: Result = {
    ...ex,
    load_num: load.load_num,
    internal_load_id: load.internal_load_id,
    verdict: 'UNREADABLE',
    stored_broker: load.broker,
    linked_customer: linked?.name ?? null,
    best_match: null,
    best_score: null,
    linked_score: null,
    suggested_alias: '',
    note: ex.error,
  };

  if (!ex.broker) return { ...base, note: ex.error || 'no broker name found on document' };
  if (!linked)    return { ...base, verdict: 'NOT_LINKED', note: 'load has no customer linked' };

  const ranked = rankCustomers(ex.broker, customers);
  const best   = ranked[0] ?? null;
  const linkedScore = ranked.find(r => r.customer.id === linked.id)?.score ?? 0;

  const r: Result = {
    ...base,
    best_match:   best?.customer.name ?? null,
    best_score:   best ? Number(best.score.toFixed(3)) : null,
    linked_score: Number(linkedScore.toFixed(3)),
  };
  // Anything the roster doesn't already hold verbatim is a candidate
  // alias — this column is the seed data for the alias backfill.
  const alias = ex.broker.trim().toLowerCase() === linked.name.trim().toLowerCase()
    || linked.aliases.some(a => a.trim().toLowerCase() === ex.broker.trim().toLowerCase())
    ? '' : ex.broker.trim();

  if (best && best.customer.id === linked.id) {
    return { ...r, verdict: 'OK', suggested_alias: alias, note: '' };
  }
  if (best && best.score >= 0.5 && best.score - linkedScore >= MISLINK_MARGIN) {
    return { ...r, verdict: 'MISLINK', note: `document says "${ex.broker}" → ${best.customer.name}, but load is linked to ${linked.name}` };
  }
  if (linkedScore >= SUPPORT_FLOOR) {
    return { ...r, verdict: 'WEAK_SUPPORT', suggested_alias: alias, note: `document supports ${linked.name} only weakly; best match was ${best?.customer.name ?? 'none'}` };
  }
  return { ...r, verdict: 'NO_ROSTER_MATCH', suggested_alias: alias, note: `"${ex.broker}" matches no customer — likely a missing alias for ${linked.name}` };
}

// ── Report ──────────────────────────────────────────────────────────
const PRIORITY: Verdict[] = ['MISLINK', 'WEAK_SUPPORT', 'NO_ROSTER_MATCH', 'NOT_LINKED', 'UNREADABLE', 'OK'];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(results: Result[]) {
  const rows = ONLY_FLAGGED ? results.filter(r => r.verdict !== 'OK') : results.slice();
  rows.sort((a, b) =>
    PRIORITY.indexOf(a.verdict) - PRIORITY.indexOf(b.verdict) ||
    (a.linked_customer ?? '').localeCompare(b.linked_customer ?? ''));

  const header = [
    'verdict', 'load_num', 'linked_customer', 'ratecon_broker', 'best_match',
    'best_score', 'linked_score', 'suggested_alias', 'ai_confidence',
    'stored_broker', 'ratecon_carrier', 'source', 'note', 'url',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.verdict, r.load_num, r.linked_customer, r.broker, r.best_match,
      r.best_score, r.linked_score, r.suggested_alias, r.confidence,
      r.stored_broker, r.carrier, r.source, r.note,
      r.internal_load_id ? `https://www.fleetcal.app/loads/${r.internal_load_id}` : '',
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(CSV, lines.join('\n') + '\n');

  const tally = new Map<Verdict, number>();
  for (const r of results) tally.set(r.verdict, (tally.get(r.verdict) ?? 0) + 1);
  const cost = (totalIn / 1e6) * RATE_IN + (totalOut / 1e6) * RATE_OUT;

  console.log('\n─── results ───');
  for (const v of PRIORITY) if (tally.get(v)) console.log(`  ${v.padEnd(16)} ${tally.get(v)}`);

  // Distinct alias suggestions are the reusable output here: one
  // confirmed alias fixes every future load from that broker.
  const aliases = new Map<string, string>();
  for (const r of results) if (r.suggested_alias && r.linked_customer) aliases.set(`${r.suggested_alias}||${r.linked_customer}`, '');
  console.log(`\n  ${aliases.size} distinct alias suggestions (see suggested_alias column)`);
  console.log(`\ntokens in=${totalIn} out=${totalOut}   this run cost $${cost.toFixed(2)}`);
  console.log(`CSV:   ${CSV}  (${rows.length} rows)`);
  console.log(`cache: ${JSONL}`);
}

main().catch(e => { console.error(e); process.exit(1); });
