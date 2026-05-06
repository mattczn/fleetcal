import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, DocumentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { NextRequest, NextResponse } from 'next/server';
import { buildRateConPrompt, DEFAULT_PROMPT_VARIABLES, PromptVariables, BrokerRule } from '@/lib/prompt';
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

  try {
    ({
      data,
      enabledFields = [],
      customInstructions = '',
      promptVariables = DEFAULT_PROMPT_VARIABLES,
      brokerRules = [],
    } = await req.json());
    if (!data) throw new Error('missing data');
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const prompt = buildRateConPrompt(enabledFields, customInstructions, promptVariables, brokerRules);
  const client = new Anthropic({ apiKey: key });

  let parsed: Record<string, unknown>;

  try {
    const docBlock: DocumentBlockParam = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
    };
    const textBlock: TextBlockParam = { type: 'text', text: prompt };
    const content: ContentBlockParam[] = [docBlock, textBlock];

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
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
  });
}
