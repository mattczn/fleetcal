/**
 * /admin/ai-usage — cross-org AI usage dashboard.
 *
 * Server component: runs the super-admin auth gate so non-admins
 * see a generic 404 instead of "Forbidden" (don't leak the route's
 * existence). On pass, hands off to the client component which
 * owns the interactive state (month picker, table sorts, refresh).
 */

import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { isSuperAdmin } from '@/lib/superAdmin';
import AiUsageDashboard from './AiUsageDashboard';

export const dynamic = 'force-dynamic';

export default async function AiUsagePage() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    notFound();
  }

  return <AiUsageDashboard />;
}
