import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import type { CalendarEvent, Asset, Driver } from '@/lib/types';

const client = new Anthropic();

interface AssistantRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  events: CalendarEvent[];
  assets: Asset[];
  drivers: Driver[];
}

function buildContext(events: CalendarEvent[], assets: Asset[], drivers: Driver[]): string {
  const assetMap = Object.fromEntries(assets.map(a => [a.id, a.name]));

  const loadLines = events.slice(0, 200).map(e => {
    const parts: string[] = [];
    parts.push(`Load ${e.loadNum || e.id}: ${e.title}`);
    if (e.driverName) parts.push(`  Driver: ${e.driverName}`);
    const truck = assetMap[e.assetId];
    if (truck) parts.push(`  Truck: ${truck}`);
    if (e.loadPrice) parts.push(`  Rate: $${e.loadPrice}`);
    if (e.driverPay) parts.push(`  Driver pay: $${e.driverPay}`);
    if (e.status) parts.push(`  Status: ${e.status}`);
    if (e.broker) parts.push(`  Broker: ${e.broker}`);
    return parts.join('\n');
  });

  const driverList = drivers.map(d => `- ${d.name}${d.phone ? ` (${d.phone})` : ''}`).join('\n');
  const truckList = assets.filter(a => !a.hidden).map(a => `- ${a.name}${a.unit ? ` (Unit #${a.unit})` : ''}`).join('\n');

  return `You are a dispatch assistant for a trucking company. Answer questions about loads, drivers, and trucks using the data below. Be concise and direct. Format numbers with $ or commas where appropriate.

TRUCKS:
${truckList || 'None'}

DRIVERS:
${driverList || 'None'}

LOADS (${events.length} total, showing up to 200):
${loadLines.join('\n\n') || 'No loads in current view'}`;
}

export async function POST(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { messages, events, assets, drivers } = await req.json() as AssistantRequest;

  const systemPrompt = buildContext(events ?? [], assets ?? [], drivers ?? []);

  const stream = await client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          controller.enqueue(encoder.encode(chunk.delta.text));
        }
      }
      controller.close();
    },
  });

  return new NextResponse(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
