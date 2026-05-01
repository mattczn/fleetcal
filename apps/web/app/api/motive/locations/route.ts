import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { locations: MotiveLocation[]; fetchedAt: number }>();

export interface MotiveLocation {
  vehicleId: string;
  description: string;
  lat: number;
  lon: number;
  locatedAt: string;
}

interface MotiveVehicleRow {
  vehicle: {
    id: number;
    current_location: {
      description: string;
      lat: number;
      lon: number;
      located_at: string;
    } | null;
  };
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL)
    return NextResponse.json({ locations: cached.locations });

  const db = getSupabaseServer();
  const { data: settingsRow, error: settingsErr } = await db
    .from('org_settings')
    .select('motive_api_key')
    .eq('org_id', orgId)
    .single();

  if (settingsErr || !settingsRow) {
    return NextResponse.json({ locations: [] });
  }

  const apiKey = (settingsRow as { motive_api_key: string | null }).motive_api_key;
  if (!apiKey) return NextResponse.json({ locations: [] });

  let res: Response;
  try {
    res = await fetch('https://api.keeptruckin.com/v1/vehicle_locations?per_page=50', {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      next: { revalidate: 0 },
    });
  } catch (err) {
    console.error('Motive fetch error:', err);
    return NextResponse.json({ error: 'Failed to reach Motive API' }, { status: 502 });
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('Motive API error:', res.status, text);
    return NextResponse.json({ error: `Motive API responded ${res.status}` }, { status: 502 });
  }

  const json = await res.json() as { vehicles?: MotiveVehicleRow[] };
  const locations: MotiveLocation[] = (json.vehicles ?? [])
    .filter(v => v.vehicle.current_location)
    .map(v => ({
      vehicleId:   String(v.vehicle.id),
      description: v.vehicle.current_location!.description,
      lat:         v.vehicle.current_location!.lat,
      lon:         v.vehicle.current_location!.lon,
      locatedAt:   v.vehicle.current_location!.located_at,
    }));

  cache.set(orgId, { locations, fetchedAt: Date.now() });
  return NextResponse.json({ locations });
}
