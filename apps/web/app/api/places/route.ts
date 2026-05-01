import { NextRequest, NextResponse } from 'next/server';

const KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

export async function GET(req: NextRequest) {
  if (!KEY) return NextResponse.json({ error: 'No Google API key' }, { status: 500 });

  const input    = req.nextUrl.searchParams.get('input');
  const place_id = req.nextUrl.searchParams.get('place_id');

  // Return place details (lat/lng + timezone) for a selected suggestion
  if (place_id) {
    const res  = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=geometry,formatted_address&key=${KEY}`,
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

    // Google Time Zone API — returns IANA timezone id (e.g. "America/Denver")
    let timezone: string | undefined;
    try {
      const tzRes  = await fetch(
        `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${Math.floor(Date.now() / 1000)}&key=${KEY}`,
        { cache: 'no-store' },
      );
      const tzData = await tzRes.json() as { status?: string; timeZoneId?: string };
      if (tzData.status === 'OK') timezone = tzData.timeZoneId;
    } catch { /* best-effort */ }

    return NextResponse.json({ result: { lat, lng, timezone, address: data.result.formatted_address } });
  }

  // Return autocomplete suggestions
  if (!input?.trim()) return NextResponse.json({ suggestions: [] });
  const res  = await fetch(
    `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&components=country:us|country:ca|country:mx&key=${KEY}`,
    { cache: 'no-store' },
  );
  const data = await res.json() as {
    predictions?: { place_id: string; description: string }[];
  };
  const suggestions = (data.predictions ?? []).map(p => ({ place_id: p.place_id, description: p.description }));
  return NextResponse.json({ suggestions });
}
