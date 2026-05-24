import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function DELETE() {
  const { orgId, orgRole } = await auth();
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Owner-only — this endpoint nukes every asset, driver, and event
  // in the org. Admins and dispatchers can't trigger it even by
  // hitting the route directly. The UI hides the button for non-
  // owners but a 403 here is the actual security boundary.
  // Clerk roles ship with the "org:" prefix in the JWT claim.
  if (orgRole !== 'org:owner') {
    return NextResponse.json(
      { error: 'Forbidden', reason: 'owner_required', role: orgRole ?? null },
      { status: 403 },
    );
  }

  const db = getSupabase();

  // Delete in FK-safe order: events and prefs first, then drivers and assets
  const [eventsRes, prefsRes] = await Promise.all([
    db.from('events').delete().eq('org_id', orgId),
    db.from('driver_asset_prefs').delete().eq('org_id', orgId),
  ]);

  if (eventsRes.error) return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });
  if (prefsRes.error)  return NextResponse.json({ error: prefsRes.error.message  }, { status: 500 });

  const [driversRes, assetsRes] = await Promise.all([
    db.from('drivers').delete().eq('org_id', orgId),
    db.from('assets').delete().eq('org_id', orgId),
  ]);

  if (driversRes.error) return NextResponse.json({ error: driversRes.error.message }, { status: 500 });
  if (assetsRes.error)  return NextResponse.json({ error: assetsRes.error.message  }, { status: 500 });

  return NextResponse.json({ ok: true });
}
