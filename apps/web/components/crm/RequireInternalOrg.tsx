'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useOrganization, useUser } from '@clerk/nextjs';
import { isCrmUser, isInternalOrg } from '@/lib/internalOrg';

/**
 * Internal-org gate for the CRM pages — the third gate on top of
 * RequireCap's capability + module checks. The CRM is FleetCal-internal
 * sales tooling (see packages/types/crm.ts): even if a customer org
 * somehow had the `crm` module flag + capability, this bounces them.
 *
 * Mirrors RequireCap's behavior: render null while Clerk hydrates,
 * redirect to /calendar once we know the org isn't on the allowlist.
 */
export default function RequireInternalOrg({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { organization, isLoaded } = useOrganization();
  const { user, isLoaded: userLoaded } = useUser();
  const loaded = isLoaded && userLoaded;
  // Org allowlist AND (when configured) the per-user CRM allowlist —
  // founder-only mode excludes other admins of the same internal org.
  const allowed = isInternalOrg(organization?.id) && isCrmUser(user?.id);

  useEffect(() => {
    if (loaded && !allowed) {
      router.replace('/calendar');
    }
  }, [loaded, allowed, router]);

  if (!loaded || !allowed) return null;
  return <>{children}</>;
}
