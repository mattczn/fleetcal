import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

interface OrgSettingsRow {
  org_id: string;
  show_driver_pay: boolean;
}

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getSupabase();
  const { data, error } = await db
    .from('org_settings')
    .select('org_id, show_driver_pay')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Default row when none exists yet (false everywhere)
  const row = (data as OrgSettingsRow | null) ?? { org_id: orgId, show_driver_pay: false };
  return NextResponse.json({ showDriverPay: row.show_driver_pay });
}

interface PatchBody {
  showDriverPay?: boolean;
}

export async function PATCH(req: Request) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body || typeof body.showDriverPay !== 'boolean') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const db = getSupabase();
  const { error } = await db
    .from('org_settings')
    .upsert(
      { org_id: orgId, show_driver_pay: body.showDriverPay },
      { onConflict: 'org_id' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, showDriverPay: body.showDriverPay });
}
