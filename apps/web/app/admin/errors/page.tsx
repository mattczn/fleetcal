/**
 * /admin/errors — API error log dashboard.
 *
 * Server component runs the super-admin auth gate; the client
 * component does the live data fetch + filter UI + render.
 */

import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { isSuperAdmin } from '@/lib/superAdmin';
import ErrorsDashboard from './ErrorsDashboard';

export const dynamic = 'force-dynamic';

export default async function AdminErrorsPage() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    notFound();
  }
  return <ErrorsDashboard />;
}
