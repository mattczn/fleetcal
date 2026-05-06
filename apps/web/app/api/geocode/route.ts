import { NextRequest, NextResponse } from 'next/server';
import { geocodeAddress, reverseGeocode } from '@/lib/geocode';

export async function POST(req: NextRequest) {
  const body = await req.json() as { address?: string; lat?: number; lng?: number };

  // Reverse lookup — coords in, address_components out (city + state + tz).
  if (body.lat != null && body.lng != null) {
    const result = await reverseGeocode(body.lat, body.lng);
    return NextResponse.json({ result });
  }

  if (!body.address?.trim()) return NextResponse.json({ result: null });
  const result = await geocodeAddress(body.address);
  return NextResponse.json({ result });
}
