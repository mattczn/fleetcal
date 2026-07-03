import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { find as tzFind } from 'geo-tz';

const KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

// Per-IP rate limit. This route proxies the paid Google Places/Timezone
// APIs; before this it was unauthenticated AND unthrottled, so anyone
// could loop it to burn quota (real $). Sign-in is now required, plus a
// burst cap as defense against a single hijacked session.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = 60; // 60 lookups/min/IP — generous for live typeahead
const recentByIp = new Map<string, number[]>();
function checkRate(ip: string): boolean {
  const now = Date.now();
  const fresh = (recentByIp.get(ip) ?? []).filter(ts => ts > now - RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) { recentByIp.set(ip, fresh); return false; }
  fresh.push(now);
  recentByIp.set(ip, fresh);
  return true;
}

export async function GET(req: NextRequest) {
  if (!KEY) return NextResponse.json({ error: 'No Google API key' }, { status: 500 });

  // Authenticated users only — geocoding is a logged-in editing flow.
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (!checkRate(ip)) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const input    = req.nextUrl.searchParams.get('input');
  const place_id = req.nextUrl.searchParams.get('place_id');
  const token    = req.nextUrl.searchParams.get('sessiontoken');
  const tokenParam = token ? `&sessiontoken=${encodeURIComponent(token)}` : '';

  // Return place details (lat/lng + timezone) for a selected suggestion
  if (place_id) {
    const res  = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=geometry,formatted_address&key=${KEY}${tokenParam}`,
      { cache: 'no-store' },
    );
    const data = await res.json() as {
      status?: string;
      result?: { geometry: { location: { lat: number; lng: number } }; formatted_address: string };
    };
    if (data.status !== 'OK' || !data.result) {
      console.error('Places Details API error:', data.status, place_id);
      return NextResponse.json({ result: null });
    }
    const { lat, lng } = data.result.geometry.location;

    // Derive the IANA timezone id (e.g. "America/Denver") locally from the
    // lat/lng — same geo-tz approach as lib/geocode.ts — instead of paying
    // for a separate Google Time Zone API call.
    const timezone = tzFind(lat, lng)[0] ?? undefined;

    return NextResponse.json({ result: { lat, lng, timezone, address: data.result.formatted_address } });
  }

  // Return autocomplete suggestions
  if (!input?.trim()) return NextResponse.json({ suggestions: [] });
  const res  = await fetch(
    `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&components=country:us|country:ca|country:mx&key=${KEY}${tokenParam}`,
    { cache: 'no-store' },
  );
  const data = await res.json() as {
    predictions?: { place_id: string; description: string }[];
  };
  const suggestions = (data.predictions ?? []).map(p => ({ place_id: p.place_id, description: p.description }));
  return NextResponse.json({ suggestions });
}
