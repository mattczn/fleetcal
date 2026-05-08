import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, DocumentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { NextRequest, NextResponse } from 'next/server';
import { buildRateConPrompt, buildBrokerHarvestPrompt, DEFAULT_PROMPT_VARIABLES, PromptVariables, BrokerRule, BrokerProfile } from '@/lib/prompt';
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

const MODEL = 'claude-haiku-4-5-20251001';

function extractJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

/** Generous output budget for pass 2. Long multi-stop rate cons can
 *  easily exceed 2k tokens of JSON; 8k covers every realistic case
 *  (15+ stops, full schema, broker rules, etc.) without affecting
 *  cost — Anthropic only charges for tokens actually generated. */
const PASS_2_MAX_TOKENS = 8192;

/** Match a broker name (post-cleanBrokerName) against the org's customer
 *  list. Exact name + alias match only — the more sophisticated fuzzy
 *  matcher lives client-side; we just need to pick which broker's hints
 *  go into pass 2, and the AI's pass-1 broker name is usually pristine. */
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
  let brokerRules: BrokerRule[] = [];
  let customers: IncomingCustomer[] = [];

  try {
    ({
      data,
      enabledFields = [],
      customInstructions = '',
      promptVariables = DEFAULT_PROMPT_VARIABLES,
      // Two ways to pass broker context:
      //   • brokerRules — legacy: caller pre-filtered to rules-bearing customers
      //   • customers   — preferred: full roster, server picks the matched rule
      // Sending `customers` enables the broker-harvest pass + new-customer
      // prefill in the response.
      brokerRules = [],
      customers = [],
    } = await req.json());
    if (!data) throw new Error('missing data');
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey: key });

  // The PDF block is identical across both calls; cache_control marks it
  // as a cacheable prefix so pass 2 reads the PDF from cache instead of
  // re-uploading. Cuts pass-2 input cost by ~90%.
  const docBlock: DocumentBlockParam = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
    cache_control: { type: 'ephemeral' },
  };

  // ── Pass 1: harvest broker profile ───────────────────────────────────────
  // Runs every time so the client always has fields to pre-fill the
  // "Save as customer" review modal with, even when the broker isn't
  // yet in the customer list. The customer-rule injection that piggy-
  // backs on this is just an extra benefit when customers DO exist.
  let brokerProfile: BrokerProfile | undefined;
  let matchedCustomer: IncomingCustomer | undefined;

  try {
    const pass1Text: TextBlockParam = { type: 'text', text: buildBrokerHarvestPrompt(promptVariables.timezone) };
    const pass1Content: ContentBlockParam[] = [docBlock, pass1Text];
    const pass1Response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: pass1Content }],
    });
    const pass1Text2 = pass1Response.content[0].type === 'text' ? pass1Response.content[0].text : '';
    const pass1Json = extractJson(pass1Text2) as { broker?: BrokerProfile; docType?: string };
    brokerProfile = pass1Json.broker
      ? { ...pass1Json.broker, docType: pass1Json.docType }
      : undefined;
    if (brokerProfile?.name && customers.length > 0) {
      const cleaned = cleanBrokerName(brokerProfile.name);
      matchedCustomer = matchBroker(cleaned, customers) ?? matchBroker(brokerProfile.name, customers);
    }
  } catch (err) {
    // Non-fatal — fall through to pass 2 with whatever rules the caller
    // pre-filtered. Logged so we can see if it's failing systemically.
    console.error('[parse-ratecon] pass-1 broker harvest failed:', err);
  }

  // Build the broker rules to inject into pass 2:
  //   • If pass 1 matched a customer with parseHints → use just that rule
  //   • Else fall back to whatever the caller sent (legacy behavior)
  const effectiveRules: BrokerRule[] = matchedCustomer && matchedCustomer.parseHints?.trim()
    ? [{
        name:    matchedCustomer.name,
        aliases: matchedCustomer.aliases ?? [],
        hints:   matchedCustomer.parseHints.trim(),
      }]
    : brokerRules;

  // ── Pass 2: full extraction with the matched broker's hints ──────────────
  const prompt = buildRateConPrompt(enabledFields, customInstructions, promptVariables, effectiveRules);

  let parsed: Record<string, unknown>;
  try {
    const textBlock: TextBlockParam = { type: 'text', text: prompt };
    const content: ContentBlockParam[] = [docBlock, textBlock];
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: PASS_2_MAX_TOKENS,
      messages: [{ role: 'user', content }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      parsed = extractJson(text);
    } catch (parseErr) {
      console.error('[parse-ratecon] pass-2 JSON parse failed:', {
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
        // Prefer Google's structured address_components (locality /
        // administrative_area_level_1) over whatever the AI guessed —
        // those are the canonical city / state for the geocoded address.
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

  // Title is built client-side by generateLoadTitle() so it can use
  // customer.shortName + the org's customer roster. We just return the
  // AI's summary (formatted per `titleFormat`) as a fallback for the rare
  // case where the client can't synthesize one.

  return NextResponse.json({
    ...parsed,
    stops: enrichedStops,
    // Pass-1 broker profile harvest. Client uses this to pre-fill a new
    // customer record when the broker isn't matched. `undefined` if pass 1
    // didn't run (no customers sent) or failed.
    brokerProfile,
  });
}
