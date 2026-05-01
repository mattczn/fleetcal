import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

export interface MotiveVehicle {
  id: string;
  number: string;
  year: number | null;
  make: string | null;
  model: string | null;
}

interface MotiveVehicleRow {
  vehicle: {
    id: number;
    number: string | null;
    year: number | null;
    make: string | null;
    model: string | null;
  };
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getSupabaseServer();
  const { data: row } = await db
    .from('org_settings')
    .select('motive_api_key')
    .eq('org_id', orgId)
    .single();

  const apiKey = (row as { motive_api_key: string | null } | null)?.motive_api_key;
  if (!apiKey) return NextResponse.json({ error: 'Motive not configured' }, { status: 400 });

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
  const vehicles: MotiveVehicle[] = (json.vehicles ?? []).map(v => ({
    id:     String(v.vehicle.id),
    number: v.vehicle.number ?? '',
    year:   v.vehicle.year   ?? null,
    make:   v.vehicle.make   ?? null,
    model:  v.vehicle.model  ?? null,
  }));

  return NextResponse.json({ vehicles });
}
