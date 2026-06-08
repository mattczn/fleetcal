/**
 * /admin/health — cron + operational health dashboard.
 *
 * Server component runs the super-admin auth gate; the client
 * component does the live data fetch + render.
 */

import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { isSuperAdmin } from '@/lib/superAdmin';
import HealthDashboard from './HealthDashboard';

export const dynamic = 'force-dynamic';

export default async function AdminHealthPage() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    notFound();
  }
  return <HealthDashboard />;
}
