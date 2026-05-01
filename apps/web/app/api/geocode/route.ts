import { NextRequest, NextResponse } from 'next/server';
import { geocodeAddress } from '@/lib/geocode';
import { find as tzFind } from 'geo-tz';

export async function POST(req: NextRequest) {
  const body = await req.json() as { address?: string; lat?: number; lng?: number };

  // Direct coordinate lookup — just need timezone
  if (body.lat != null && body.lng != null) {
    const timezone = tzFind(body.lat, body.lng)[0] ?? undefined;
    return NextResponse.json({ result: { lat: body.lat, lng: body.lng, timezone } });
  }

  if (!body.address?.trim()) return NextResponse.json({ result: null });
  const result = await geocodeAddress(body.address);
  return NextResponse.json({ result });
}
