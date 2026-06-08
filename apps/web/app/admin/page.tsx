/**
 * /admin — super-admin landing page.
 *
 * Server component runs the super-admin auth gate so non-admins
 * see a generic 404 (don't leak the route's existence). On pass,
 * hands off to AdminIndex (client) — same pattern as /admin/
 * ai-usage, /admin/health, /admin/orgs, because AppShell is a
 * client component and rendering it inside a server component
 * caused a render-boundary error in production.
 */

import { auth } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';
import { isSuperAdmin } from '@/lib/superAdmin';
import AdminIndex from './AdminIndex';

export const dynamic = 'force-dynamic';

export default async function AdminIndexPage() {
  const { userId } = await auth();
  if (!isSuperAdmin(userId)) {
    notFound();
  }
  return <AdminIndex />;
}
