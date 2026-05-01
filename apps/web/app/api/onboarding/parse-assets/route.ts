import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export interface ParsedAsset {
  name: string;
  unit?: string;
  truck?: string;
  type?: string;
  notes?: string;
}

export async function POST(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 });

  const { csvContent } = await req.json() as { csvContent: string };
  if (!csvContent?.trim()) return NextResponse.json({ assets: [] });

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are parsing a CSV export from a trucking company's fleet or driver management system.
Extract each truck or driver as a separate asset. Return ONLY valid JSON — no markdown, no explanation.

CSV content:
${csvContent.slice(0, 40000)}

Return this exact format:
{"assets":[{"name":"required — driver name or truck identifier","unit":"unit number if present","truck":"Year Make Model if present","type":"OTR or Local or Dedicated or Regional — infer or default to OTR","notes":"any other relevant info"}]}

Rules:
- Each row that represents a vehicle or driver becomes one asset
- "name" must be non-empty — prefer driver name, then truck number, then unit number
- Omit any field that has no data (do not include empty strings)
- Deduplicate rows that appear to be the same asset
- Maximum 50 assets`,
    }],
  });

  const raw = message.content.find(b => b.type === 'text')?.text ?? '{"assets":[]}';
  let assets: ParsedAsset[] = [];
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    assets = match ? (JSON.parse(match[0]) as { assets: ParsedAsset[] }).assets : [];
  } catch {
    assets = [];
  }

  return NextResponse.json({ assets });
}
