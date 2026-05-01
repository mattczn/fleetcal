import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { MotiveVehicle } from '../vehicles/route';

export interface MatchSuggestion {
  motiveId: string;
  assetId: number;
  confidence: 'high' | 'medium' | 'low';
}

interface CalendarAssetInput {
  id: number;
  name: string;
  unit?: string;
  truck?: string;
  type?: string;
}

export async function POST(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

  const { motiveVehicles, calendarAssets } = await req.json() as {
    motiveVehicles: MotiveVehicle[];
    calendarAssets: CalendarAssetInput[];
  };

  if (!motiveVehicles?.length || !calendarAssets?.length) {
    return NextResponse.json({ suggestions: [] });
  }

  const motiveList = motiveVehicles.map(v =>
    `- Motive ID ${v.id}: Unit #${v.number}${v.year ? `, ${v.year}` : ''}${v.make ? ` ${v.make}` : ''}${v.model ? ` ${v.model}` : ''}`
  ).join('\n');

  const assetList = calendarAssets.map(a =>
    `- Asset ID ${a.id}: "${a.name}"${a.unit ? `, Unit #${a.unit}` : ''}${a.truck ? `, Truck: ${a.truck}` : ''}${a.type ? `, Type: ${a.type}` : ''}`
  ).join('\n');

  const prompt = `You are matching fleet vehicles from a Motive (KeepTruckin) account to assets in a dispatch calendar.

Motive vehicles:
${motiveList}

Calendar assets:
${assetList}

Match each Motive vehicle to the most likely calendar asset based on unit numbers, truck descriptions, and names. Unit number matches (#42 ↔ Unit #42) are high confidence. Name/description similarity is medium. Guesses are low.

Only include matches you are reasonably sure about. If a Motive vehicle has no clear match, omit it.

Respond with ONLY a JSON array, no explanation:
[{"motiveId":"<string>","assetId":<number>,"confidence":"high"|"medium"|"low"}, ...]`;

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text ?? '[]';
  let suggestions: MatchSuggestion[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    suggestions = match ? JSON.parse(match[0]) : [];
  } catch {
    suggestions = [];
  }

  return NextResponse.json({ suggestions });
}
