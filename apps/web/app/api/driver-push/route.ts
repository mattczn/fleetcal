import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { sendPushToDriver } from '@/lib/push';

interface SendBody {
  driverId: number;
  title:    string;
  body:     string;
  data?:    Record<string, unknown>;
}

export async function POST(req: Request) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const payload = (await req.json().catch(() => null)) as SendBody | null;
  if (!payload || typeof payload.driverId !== 'number' || !payload.title || !payload.body) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Verify the driver belongs to the requesting org
  const db = getSupabase();
  const { data: driver, error } = await db
    .from('drivers')
    .select('id')
    .eq('id', payload.driverId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error)  return NextResponse.json({ error: error.message },        { status: 500 });
  if (!driver) return NextResponse.json({ error: 'Driver not found' },  { status: 404 });

  await sendPushToDriver(orgId, payload.driverId, {
    title: payload.title,
    body:  payload.body,
    data:  payload.data,
  });
  return NextResponse.json({ ok: true });
}
