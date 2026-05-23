/**
 * POST /api/motive/match-trailers
 *
 * AI-assisted matching between Motive trailers/assets and the org's
 * calendar trailers. Mirrors /api/motive/match for trucks — same
 * prompt structure, same return shape adapted to trailer IDs.
 *
 * Body:  { motiveTrailers: MotiveTrailer[], calendarTrailers: CalendarTrailerInput[] }
 * Returns: { suggestions: TrailerMatchSuggestion[] }
 *
 * The matcher errs on the side of omitting low-confidence matches —
 * better to ask the user to pick than to seed a wrong assignment.
 */
import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { MotiveTrailer } from '../trailers/route';

export interface TrailerMatchSuggestion {
  motiveId:   string;
  trailerId:  number;
  confidence: 'high' | 'medium' | 'low';
}

interface CalendarTrailerInput {
  id:            number;
  name:          string;
  trailerNumber?: string;
  category?:     string;     // Swing / Roll Up / Reefer / Flat Bed / Other
  notes?:        string;
}

export async function POST(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

  const { motiveTrailers, calendarTrailers } = await req.json() as {
    motiveTrailers:    MotiveTrailer[];
    calendarTrailers:  CalendarTrailerInput[];
  };

  if (!motiveTrailers?.length || !calendarTrailers?.length) {
    return NextResponse.json({ suggestions: [] });
  }

  const motiveList = motiveTrailers.map(t =>
    `- Motive ID ${t.id}: Unit #${t.number}${t.year ? `, ${t.year}` : ''}${t.make ? ` ${t.make}` : ''}${t.model ? ` ${t.model}` : ''}${t.type ? ` (${t.type})` : ''}`
  ).join('\n');

  const trailerList = calendarTrailers.map(t =>
    `- Trailer ID ${t.id}: "${t.name}"${t.trailerNumber ? `, Unit #${t.trailerNumber}` : ''}${t.category ? `, Category: ${t.category}` : ''}${t.notes ? `, Notes: ${t.notes.slice(0, 60)}` : ''}`
  ).join('\n');

  const prompt = `You are matching trailers from a Motive (KeepTruckin) account to trailers in a dispatch calendar.

Motive trailers:
${motiveList}

Calendar trailers:
${trailerList}

Match each Motive trailer to the most likely calendar trailer based on unit numbers, names, and any descriptive fields. Unit number matches (Unit #142 ↔ Unit #142) are HIGH confidence. Name similarity is MEDIUM. Reefer ↔ Reefer category, Flat Bed ↔ Flat Bed etc. is MEDIUM hint, not a match on its own. Guesses are LOW.

Only include matches you are reasonably sure about. If a Motive trailer has no clear match, omit it.

Respond with ONLY a JSON array, no explanation:
[{"motiveId":"<string>","trailerId":<number>,"confidence":"high"|"medium"|"low"}, ...]`;

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text ?? '[]';
  let suggestions: TrailerMatchSuggestion[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    suggestions = match ? JSON.parse(match[0]) : [];
  } catch {
    suggestions = [];
  }

  return NextResponse.json({ suggestions });
}
