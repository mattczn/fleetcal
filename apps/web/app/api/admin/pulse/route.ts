/**
 * GET /api/admin/pulse
 *
 * One-shot payload for the admin pulse card. Super-admin gated;
 * non-admins get a 404 (don't leak the route's existence).
 *
 * Cache strategy: Next.js's fetch cache already memoizes the
 * Sentry calls for 5 minutes (revalidate: 300 in lib/sentryApi.ts).
 * The Supabase reads are sub-second, so this endpoint stays cheap
 * on repeated polling. We don't add an extra HTTP cache header
 * because the data needs to be fresh enough that a refresh after
 * a deploy shows the new release.
 */

import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/superAdmin';
import { getPulseMetrics } from '@/lib/adminMetrics';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const metrics = await getPulseMetrics();
  return NextResponse.json(metrics);
}
