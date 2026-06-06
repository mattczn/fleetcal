import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, DocumentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { NextRequest, NextResponse } from 'next/server';
import { buildRateConPrompt, DEFAULT_PROMPT_VARIABLES, PromptVariables } from '@/lib/prompt';
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

interface IncomingCustomer {
  name:        string;
  aliases?:    string[];
  parseHints?: string;
}

// Single-pass extraction with Sonnet at temperature 0. The two-pass
// design (Haiku broker harvest → Sonnet full extraction with
// parseHints injection) was dropped because:
//   • parseHints was barely used (a few customers had hints)
//   • Pass 1 added a second source of prompt drift between orgs
//   • Customer matching is a fine post-process — no model needed
const MODEL = 'claude-sonnet-4-5-20250929';

function extractJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

/** Generous output budget. Long multi-stop rate cons can easily
 *  exceed 2k tokens of JSON; 8k covers every realistic case (15+
 *  stops, full schema) without affecting cost — Anthropic only
 *  charges for tokens actually generated. */
const MAX_TOKENS = 8192;

/** Match the extracted broker name against the org's customer roster
 *  for post-parse customer linking. Exact normalized-name + alias
 *  match only — fuzzier matching lives client-side. */
function matchBroker(brokerName: string, customers: IncomingCustomer[]): IncomingCustomer | undefined {
  if (!brokerName) return undefined;
  const lower = brokerName.toLowerCase().trim();
  return customers.find(c =>
    c.name.toLowerCase() === lower ||
    (c.aliases ?? []).some(a => a.toLowerCase() === lower),
  );
}

export async function POST(req: NextRequest) {
  console.log('[parse-ratecon] ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY, 'keys:', Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC')));
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });
  }

  let data: string;
  let enabledFields: string[] = [];
  let customInstructions = '';
  let promptVariables: PromptVariables = DEFAULT_PROMPT_VARIABLES;
  let customers: IncomingCustomer[] = [];

  try {
    ({
      data,
      enabledFields = [],
      customInstructions = '',
      promptVariables = DEFAULT_PROMPT_VARIABLES,
      // Customer roster for post-parse name matching. NOT injected
      // into the prompt anymore — that was the two-pass design that
      // produced inconsistent results across orgs.
      customers = [],
    } = await req.json());
    if (!data) throw new Error('missing data');
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey: key });

  const docBlock: DocumentBlockParam = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
  };

  // Build the single prompt. brokerRules is always empty now — the
  // per-broker parseHints feature was dropped along with pass 1.
  const prompt = buildRateConPrompt(enabledFields, customInstructions, promptVariables, []);

  // Debug short-circuit: ?debug=1 returns the exact inputs without
  // calling the model. Useful for diffing prompt drift between orgs.
  const url = new URL(req.url);
  if (url.searchParams.get('debug') === '1') {
    return NextResponse.json({
      debug: true,
      model: MODEL,
      enabledFields,
      customInstructions,
      promptVariables,
      fullPrompt: prompt,
      pdfBytesLength: data.length,
      customerCount: customers.length,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    const textBlock: TextBlockParam = { type: 'text', text: prompt };
    const content: ContentBlockParam[] = [docBlock, textBlock];
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      parsed = extractJson(text);
    } catch (parseErr) {
      console.error('[parse-ratecon] JSON parse failed:', {
        stopReason: response.stop_reason,
        textLength: text.length,
        tail: text.slice(-200),
      });
      throw parseErr;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Strip legal/industry suffixes from the broker name AI returned so
  // the title doesn't read "Direct Connect Logistics Inc: …".
  if (typeof parsed.broker === 'string') {
    parsed.broker = cleanBrokerName(parsed.broker);
  }

  // Post-parse customer matching. Replaces what pass 1 used to do —
  // matches the extracted broker name against the org's roster and
  // returns the canonical customer name if found. Pure post-process,
  // no model involvement.
  let matchedCustomerName: string | undefined;
  if (typeof parsed.broker === 'string' && customers.length > 0) {
    const matched = matchBroker(parsed.broker, customers)
                 ?? matchBroker(cleanBrokerName(parsed.broker), customers);
    if (matched) matchedCustomerName = matched.name;
  }

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
        // Prefer Google's structured address_components over the AI's
        // guess — those are the canonical city / state for the
        // geocoded address.
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
    matchedCustomerName,
  });
}
