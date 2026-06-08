/**
 * GET /api/admin/me
 *
 * Returns `{ isAdmin: boolean }` for the current Clerk user.
 * Used by the client (settings page, future admin UI bits) to
 * conditionally render super-admin-only entry points without
 * leaking the SUPER_ADMIN_USER_IDS env var into the bundle.
 *
 * The actual security gate remains on each /api/admin/* route +
 * /admin/* page; this endpoint is purely for UI visibility.
 * Failure cases ALWAYS return `{ isAdmin: false }` (never throw,
 * never 404) so a transient outage just hides the admin button
 * instead of breaking the settings page.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/superAdmin';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { userId } = await auth();
    return NextResponse.json({ isAdmin: isSuperAdmin(userId) });
  } catch (err) {
    console.warn('[admin/me] auth() threw, returning isAdmin=false:', err);
    return NextResponse.json({ isAdmin: false });
  }
}
