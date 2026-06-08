/**
 * /admin/orgs — cross-org activity table.
 *
 * Server component runs the super-admin auth gate; OrgsDashboard
 * owns the interactive state.
 */

import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { isSuperAdmin } from '@/lib/superAdmin';
import OrgsDashboard from './OrgsDashboard';

export const dynamic = 'force-dynamic';

export default async function AdminOrgsPage() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    notFound();
  }
  return <OrgsDashboard />;
}
