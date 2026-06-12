import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { geocodeAddress, reverseGeocode } from '@/lib/geocode';

// Per-IP rate limit — this proxies the paid Google/Mapbox geocoding APIs.
// Was unauthenticated + unthrottled (quota-burn vector). Sign-in required
// now, plus a burst cap against a single hijacked session.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 60; // 60 lookups/min/IP
const recentByIp = new Map<string, number[]>();
function checkRate(ip: string): boolean {
  const now = Date.now();
  const fresh = (recentByIp.get(ip) ?? []).filter(ts => ts > now - RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) { recentByIp.set(ip, fresh); return false; }
  fresh.push(now);
  recentByIp.set(ip, fresh);
  return true;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!checkRate(ip)) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

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
