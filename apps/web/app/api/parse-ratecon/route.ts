import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, DocumentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  buildRateConPrompt,
  buildRateConCorrectivePrompt,
  DEFAULT_PROMPT_VARIABLES,
  PromptVariables,
} from '@/lib/prompt';
import { makeUsageTracker } from '@/lib/aiUsage';
import { geocodeAll } from '@/lib/geocode';
import { cleanBrokerName } from '@/lib/brokerName';
import type { StopType, GeocodeStatus } from '@/lib/types';

interface RawStop {
  sequence?: number;
  type?: string;
  facilityName?: string;
  address?: string;
  city?: string;
  scheduleType?: string;
  apptStart?: string;
  apptEnd?: string;
  instructions?: string;
}

// Two-model design with conditional escalation:
//   • Pass 1 (Haiku): cheap full extraction. Schema includes a
//     dateJustifications block citing where on the PDF each date came
//     from — this both improves Haiku's own extraction (citation
//     pressure makes the model look harder) and gives pass 2 context
//     if it fires.
//   • Pass 2 (Sonnet): runs ONLY when pass-1's output fails the
//     date cross-check. Receives the failed JSON + discrepancies +
//     pass-1's citations, returns corrected dates only. Merged back
//     into the pass-1 object so we keep the fields pass-1 got right.
//
// Most parses end at pass 1 → ~5× cheaper than always-Sonnet. The
// minority that escalate are the ones where we'd have produced
// inconsistent appointments before, so the average accuracy goes up.
const PASS_1_MODEL = 'claude-haiku-4-5-20251001';
const PASS_2_MODEL = 'claude-sonnet-4-5-20250929';

function extractJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

const PASS_1_MAX_TOKENS = 8192;
// Bumped from 2048 so multi-stop loads with 5+ corrections can fit
// without truncation. Cost is only on output tokens actually produced,
// so the ceiling is free.
const PASS_2_MAX_TOKENS = 4096;

/** Wrap an Anthropic messages.create call with exponential-backoff
 *  retry on transient errors (429, 503, 529 overloaded). Up to 3
 *  attempts with jittered backoff. Re-throws on non-retryable errors
 *  or after exhausting retries — matches the pattern used in the
 *  timeline auto-link route. */
async function callWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Anthropic SDK errors expose .status; bare fetch errors don't.
      const status = (err as { status?: number })?.status;
      const retryable = status === 429 || status === 503 || status === 529;
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      const base = 500 * Math.pow(2, attempt - 1);   // 500, 1000, 2000
      const jitter = Math.random() * 500;
      const delay = base + jitter;
      console.warn(`[parse-ratecon] ${label} attempt ${attempt} failed (${status}); retrying in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Parse a naive ISO datetime into epoch millis. Returns NaN if
 *  unparseable. Treats date-only strings as midnight on that day. */
function parseNaive(iso: unknown): number {
  if (typeof iso !== 'string' || !iso) return NaN;
  // Tolerate space separator and missing seconds.
  return Date.parse(iso.replace(' ', 'T'));
}

/** Compare two datetime strings, allowing a 1-minute slack to absorb
 *  rounding (HH:mm vs HH:mm:ss). Returns true if both parse and the
 *  difference is under the tolerance. */
function datesEqual(a: unknown, b: unknown): boolean {
  const ax = parseNaive(a);
  const bx = parseNaive(b);
  if (!isFinite(ax) || !isFinite(bx)) return false;
  return Math.abs(ax - bx) < 60_000;
}

/** Build a list of cross-check violations between the load's
 *  start/end and the stops array. Empty list = consistent. */
function findDateDiscrepancies(parsed: Record<string, unknown>): string[] {
  const out: string[] = [];
  const start = parsed.start;
  const end   = parsed.end;
  const stops = Array.isArray(parsed.stops) ? (parsed.stops as RawStop[]) : [];

  if (typeof start !== 'string' || !start) out.push('Missing or invalid "start" datetime.');
  if (typeof end   !== 'string' || !end)   out.push('Missing or invalid "end" datetime.');
  if (stops.length === 0) out.push('No stops were extracted — every rate con must have at least one stop.');

  if (out.length > 0) return out;

  const startMs = parseNaive(start);
  const endMs   = parseNaive(end);

  const first = stops[0];
  const last  = stops[stops.length - 1];

  if (!datesEqual(first.apptStart, start)) {
    out.push(`stops[0].apptStart="${first.apptStart}" but load.start="${start}" — the first stop's appointment time MUST equal the load's start time.`);
  }
  if (!datesEqual(last.apptStart, end)) {
    out.push(`stops[${stops.length - 1}].apptStart="${last.apptStart}" but load.end="${end}" — the last stop's appointment time MUST equal the load's end time.`);
  }

  // Middle stops should fall within [start, end], inclusive.
  for (let i = 1; i < stops.length - 1; i++) {
    const apptMs = parseNaive(stops[i].apptStart);
    if (!isFinite(apptMs)) {
      out.push(`stops[${i}].apptStart="${stops[i].apptStart}" is missing or unparseable.`);
      continue;
    }
    if (apptMs < startMs || apptMs > endMs) {
      out.push(`stops[${i}].apptStart="${stops[i].apptStart}" falls outside the load window [${start}, ${end}].`);
    }
  }

  return out;
}

/** Apply a pass-2 corrective response back onto the pass-1 object.
 *  Pass 2 returns only the date fields; we keep everything else from
 *  pass 1 (broker, ref nums, stops addresses/facilities, etc.). */
function applyCorrection(pass1: Record<string, unknown>, correction: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...pass1 };
  if (typeof correction.start === 'string') merged.start = correction.start;
  if (typeof correction.end   === 'string') merged.end   = correction.end;

  if (Array.isArray(correction.stops) && Array.isArray(pass1.stops)) {
    const correctedBySeq = new Map<number, { apptStart?: string; apptEnd?: string }>();
    for (const s of correction.stops as Array<{ sequence?: number; apptStart?: string; apptEnd?: string }>) {
      if (typeof s.sequence === 'number') correctedBySeq.set(s.sequence, { apptStart: s.apptStart, apptEnd: s.apptEnd });
    }
    merged.stops = (pass1.stops as Array<Record<string, unknown>>).map(stop => {
      const seq = typeof stop.sequence === 'number' ? stop.sequence : undefined;
      const fix = seq !== undefined ? correctedBySeq.get(seq) : undefined;
      if (!fix) return stop;
      return {
        ...stop,
        apptStart: fix.apptStart ?? stop.apptStart,
        apptEnd:   fix.apptEnd   ?? stop.apptEnd,
      };
    });
  }

  return merged;
}

export async function POST(req: NextRequest) {
  console.log('[parse-ratecon] ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY, 'keys:', Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC')));
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  // Clerk auth — orgId is required to attribute the call in
  // ai_usage_logs (PR 1 of the AI usage tracker). Missing org →
  // 401 because the rate-con parser is dispatcher-only; there's no
  // legitimate anonymous use case. The auth() call also drives the
  // userId column so the admin dashboard can spot "one dispatcher
  // in a reparse loop" vs an org-wide spike.
  const { orgId, userId } = await auth();
  if (!orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: string;
  let enabledFields: string[] = [];
  let customInstructions = '';
  let promptVariables: PromptVariables = DEFAULT_PROMPT_VARIABLES;

  try {
    ({
      data,
      enabledFields = [],
      customInstructions = '',
      promptVariables = DEFAULT_PROMPT_VARIABLES,
    } = await req.json());
    if (!data) throw new Error('missing data');
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Per-call usage tracker. Pass 1 + (conditional) pass 2 both
  // report through this — one row per Anthropic call lands in
  // ai_usage_logs, and the DB trigger maintains ai_usage_monthly.
  // Writes are fire-and-forget; a failed insert never blocks the
  // user's parse response. `requestBytes` is the inbound PDF byte
  // length (base64-decoded ≈ data.length * 0.75; rough is fine for
  // dashboard scale).
  const usageTracker = makeUsageTracker({
    orgId,
    userId:       userId ?? null,
    endpoint:     'parse-ratecon',
    requestBytes: data.length,
  });

  const client = new Anthropic({ apiKey: key });

  // The PDF block is cached so pass 2 (if it fires) doesn't re-upload
  // the bytes — Anthropic charges ~10% of normal input rate on cache
  // hits, so the conditional retry is nearly free in token cost.
  const docBlock: DocumentBlockParam = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
    cache_control: { type: 'ephemeral' },
  };

  const prompt = buildRateConPrompt(enabledFields, customInstructions, promptVariables);

  // Debug short-circuit: ?debug=1 returns the exact inputs without
  // calling the model. Useful for diffing prompt drift between orgs.
  const url = new URL(req.url);
  if (url.searchParams.get('debug') === '1') {
    return NextResponse.json({
      debug: true,
      pass1Model: PASS_1_MODEL,
      pass2Model: PASS_2_MODEL,
      enabledFields,
      customInstructions,
      promptVariables,
      fullPrompt: prompt,
      pdfBytesLength: data.length,
    });
  }

  // Trace buffer for debugging. Surfaced in the response so the user
  // can open DevTools → Network and see exactly what each pass
  // returned without redeploying.
  const trace: {
    pass1RawText?: string;
    pass1Parsed?:  Record<string, unknown>;
    discrepancies?: string[];
    correctivePrompt?: string;
    pass2RawText?: string;
    pass2Parsed?:  Record<string, unknown>;
    crossCheckAfterPass2?: string[];
  } = {};

  // ── Pass 1 (Haiku) ───────────────────────────────────────────────
  // Usage-tracking semantics: ONE row per Anthropic call.
  //   - Successful call → recordSuccess (success=true, tokens set).
  //   - Failed Anthropic call → recordFailure (success=false, no tokens).
  //   - Successful Anthropic call + downstream JSON-parse failure →
  //     recordSuccess for the actual call (it billed) + a SEPARATE
  //     recordFailure to surface the parse failure in error_code
  //     stats. Two rows total: one with tokens, one with a
  //     'json_parse_fail' error_code marker.
  // `recordedAnthropic` guards against the catch block double-recording
  // an already-recorded success path.
  let parsed: Record<string, unknown>;
  {
    const startedAt = Date.now();
    let recordedAnthropic = false;
    try {
      const textBlock: TextBlockParam = { type: 'text', text: prompt };
      const content: ContentBlockParam[] = [docBlock, textBlock];
      const response = await callWithRetry(() => client.messages.create({
        model: PASS_1_MODEL,
        max_tokens: PASS_1_MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content }],
      }), 'pass-1');
      usageTracker.recordSuccess({
        model:     PASS_1_MODEL,
        pass:      1,
        response,
        latencyMs: Date.now() - startedAt,
      });
      recordedAnthropic = true;
      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      trace.pass1RawText = text;
      try {
        parsed = extractJson(text);
        trace.pass1Parsed = parsed;
      } catch (parseErr) {
        console.error('[parse-ratecon] pass-1 JSON parse failed:', {
          stopReason: response.stop_reason,
          textLength: text.length,
          tail: text.slice(-200),
        });
        // Tokens were billed (recordSuccess above). Add a second
        // row marked json_parse_fail so the error-rate breakdown
        // surfaces this distinct downstream failure.
        usageTracker.recordFailure({
          model:     PASS_1_MODEL,
          pass:      1,
          errorCode: 'json_parse_fail',
          latencyMs: 0,
        });
        throw parseErr;
      }
    } catch (err) {
      // Only record if the Anthropic call itself failed before we
      // got to recordSuccess. The JSON-parse branch above handles
      // its own attribution.
      if (!recordedAnthropic) {
        const errStatus = (err as { status?: number })?.status;
        const code =
          errStatus === 429 ? 'anthropic_429' :
          errStatus && errStatus >= 500 ? 'anthropic_5xx' :
          'anthropic_other';
        usageTracker.recordFailure({
          model:     PASS_1_MODEL,
          pass:      1,
          errorCode: code,
          latencyMs: Date.now() - startedAt,
        });
      }
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: msg, trace }, { status: 500 });
    }
  }

  // Verbose dump of pass-1 dates → Vercel logs. Mirror what the
  // cross-check is about to read so failures in production are
  // diagnosable without re-running locally.
  console.log('[parse-ratecon] pass-1 dates:', JSON.stringify({
    start: parsed.start,
    end:   parsed.end,
    stops: Array.isArray(parsed.stops)
      ? (parsed.stops as Array<Record<string, unknown>>).map(s => ({
          sequence:  s.sequence,
          apptStart: s.apptStart,
          apptEnd:   s.apptEnd,
        }))
      : [],
    dateJustifications: parsed.dateJustifications,
  }, null, 2));

  // ── Cross-check + conditional pass-2 escalation ──────────────────
  const discrepancies = findDateDiscrepancies(parsed);
  trace.discrepancies = discrepancies;
  let escalatedToSonnet = false;
  if (discrepancies.length > 0) {
    escalatedToSonnet = true;
    console.warn('[parse-ratecon] pass-1 date check failed, escalating to Sonnet:', discrepancies);

    // Same one-row-per-call semantics as pass 1. The pass-2 PDF
    // block is the same cache-controlled doc, so this call reads
    // input tokens at ~10% rate (cache_read_input_tokens, costed
    // separately in aiPricing.ts).
    const pass2StartedAt = Date.now();
    let pass2RecordedAnthropic = false;
    try {
      const correctivePrompt = buildRateConCorrectivePrompt(parsed, discrepancies, promptVariables);
      trace.correctivePrompt = correctivePrompt;
      const textBlock: TextBlockParam = { type: 'text', text: correctivePrompt };
      const content: ContentBlockParam[] = [docBlock, textBlock];
      const response = await callWithRetry(() => client.messages.create({
        model: PASS_2_MODEL,
        max_tokens: PASS_2_MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content }],
      }), 'pass-2');
      usageTracker.recordSuccess({
        model:     PASS_2_MODEL,
        pass:      2,
        response,
        latencyMs: Date.now() - pass2StartedAt,
      });
      pass2RecordedAnthropic = true;
      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      trace.pass2RawText = text;
      const correction = extractJson(text);
      trace.pass2Parsed = correction;
      console.log('[parse-ratecon] pass-2 corrected dates:', JSON.stringify(correction, null, 2));
      parsed = applyCorrection(parsed, correction);

      // Re-check. We accept whatever Sonnet returns even if still
      // inconsistent — at that point the PDF is genuinely ambiguous
      // and we'd rather surface what the better model thinks than
      // loop indefinitely. Log for visibility.
      const stillBad = findDateDiscrepancies(parsed);
      trace.crossCheckAfterPass2 = stillBad;
      if (stillBad.length > 0) {
        console.warn('[parse-ratecon] pass-2 (Sonnet) also failed cross-check; accepting anyway:', stillBad);
      }
    } catch (err) {
      // Non-fatal — fall through with pass-1 output. Better to return
      // a slightly inconsistent parse than fail the whole request.
      console.error('[parse-ratecon] pass-2 corrective call failed, returning pass-1:', err);
      if (!pass2RecordedAnthropic) {
        const errStatus = (err as { status?: number })?.status;
        const code =
          errStatus === 429 ? 'anthropic_429' :
          errStatus && errStatus >= 500 ? 'anthropic_5xx' :
          'anthropic_other';
        usageTracker.recordFailure({
          model:     PASS_2_MODEL,
          pass:      2,
          errorCode: code,
          latencyMs: Date.now() - pass2StartedAt,
        });
      } else {
        // Anthropic call succeeded but JSON parse / cross-check
        // bookkeeping threw downstream. Record as a parse failure.
        usageTracker.recordFailure({
          model:     PASS_2_MODEL,
          pass:      2,
          errorCode: 'json_parse_fail',
          latencyMs: 0,
        });
      }
    }
  }

  // Strip dateJustifications from the response — internal scratchpad,
  // the client doesn't need to see citations.
  delete (parsed as Record<string, unknown>).dateJustifications;

  // Strip legal/industry suffixes from the broker name AI returned so
  // the title doesn't read "Direct Connect Logistics Inc: …".
  if (typeof parsed.broker === 'string') {
    parsed.broker = cleanBrokerName(parsed.broker);
  }

  // Customer matching lives client-side in generateLoadTitle() and
  // matchCustomer() — they already have the org's full roster in
  // state, so passing it through the server was pure waste.

  // ── Enrich stops with geocoding ─────────────────────────────────────────────
  const rawStops: RawStop[] = Array.isArray(parsed.stops) ? (parsed.stops as RawStop[]) : [];

  let enrichedStops: { city?: string; [k: string]: unknown }[] = [];

  if (rawStops.length > 0) {
    const sorted = [...rawStops].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const addresses = sorted.map(s => s.address || undefined);
    const geoResults = await geocodeAll(addresses);

    enrichedStops = sorted.map((stop, i) => {
      const geo = geoResults[i];
      const geocodeStatus: GeocodeStatus = geo ? 'success' : (stop.address ? 'failed' : 'pending');
      const validSchedule = stop.scheduleType === 'appointment' || stop.scheduleType === 'window' || stop.scheduleType === 'fcfs';
      return {
        sequence:      i + 1,
        type:          (stop.type ?? 'stop') as StopType,
        facilityName:  stop.facilityName || undefined,
        address:       stop.address       || undefined,
        city:          geo?.city          ?? stop.city ?? undefined,
        state:         geo?.state         ?? undefined,
        lat:           geo?.lat           ?? undefined,
        lng:           geo?.lng           ?? undefined,
        timezone:      geo?.timezone      ?? undefined,
        scheduleType:  validSchedule ? stop.scheduleType : undefined,
        apptStart:     stop.apptStart     || undefined,
        apptEnd:       stop.apptEnd       || undefined,
        instructions:  stop.instructions  || undefined,
        geocodeStatus,
      };
    });
  }

  return NextResponse.json({
    ...parsed,
    stops: enrichedStops,
    // Surface whether Sonnet was needed. Useful for the UI to show a
    // "AI rechecked these dates" badge and for you to see how often
    // pass 1 fails in practice.
    parseMeta: {
      escalatedToSonnet,
      pass1Model: PASS_1_MODEL,
      pass2Model: escalatedToSonnet ? PASS_2_MODEL : null,
      // Full debug trace — raw text + parsed JSON from each pass +
      // the discrepancies that triggered escalation + the corrective
      // prompt sent to Sonnet. Inspect via DevTools → Network. None
      // of this is read by the UI; it's pure diagnostics.
      trace,
    },
  });
}
