import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase-server';

// GET — returns whether a key is configured (never returns the actual key)
export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getSupabaseServer();
  const { data } = await db
    .from('org_settings')
    .select('motive_api_key')
    .eq('org_id', orgId)
    .single();

  const configured = !!(data as { motive_api_key: string | null } | null)?.motive_api_key;
  return NextResponse.json({ configured });
}

// POST — save or clear the Motive API key
export async function POST(req: NextRequest) {
  const { orgId } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { key } = await req.json() as { key: string };

  const db = getSupabaseServer();
  const { error } = await db
    .from('org_settings')
    .upsert({ org_id: orgId, motive_api_key: key || null }, { onConflict: 'org_id' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
