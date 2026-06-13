'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Capability, OrgModule } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';

/**
 * Page-level capability + module gate. Two orthogonal axes:
 *
 *   - `cap`     — the user's role must have this capability
 *   - `module`  — the org's plan must include this module (optional)
 *
 * If either check fails, the user is bounced to `fallback` (defaults
 * to /calendar). Wrap the contents of an app/{section}/page.tsx
 * default export so direct-URL / bookmark / back-button hits don't
 * render the module shell or fire API calls that the server would 403.
 *
 * Pattern:
 *   export default function FuelPage() {
 *     return (
 *       <RequireCap cap="fuel.access" module="fuel">
 *         <FuelPageInner />
 *       </RequireCap>
 *     );
 *   }
 *
 * Returns null while permissions resolve and during the redirect, so
 * the wrapped children mount only when access is fully confirmed.
 */
export default function RequireCap({
  cap,
  module,
  fallback = '/calendar',
  children,
}: {
  cap: Capability;
  /** Optional org-level module flag. If the module is disabled for the
   *  org, the page redirects to fallback regardless of the cap check. */
  module?: OrgModule;
  /** Where to send users without access. Defaults to /calendar. */
  fallback?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { can, isLoading } = usePermissions();
  const { enabled, hydrated: modulesHydrated } = useModules();
  const capAllowed     = can(cap);
  const moduleAllowed  = module ? enabled(module) : true;
  const allowed        = capAllowed && moduleAllowed;

  // Wait for BOTH Clerk membership AND org_settings.modules to finish
  // loading before deciding to redirect. Without the modules check, an
  // org whose flags differ from MVP_LAUNCH_DEFAULTS (e.g. Curzon
  // explicitly enabled `performance`) would briefly see the seed-time
  // default (`performance: false`) on first paint, fail the gate, and
  // get bounced to /calendar before DataLoader's hydrate lands.
  // Module check is skipped when the page didn't pass a `module`
  // prop — those pages don't care about module state.
  const stillLoading = isLoading || (module ? !modulesHydrated : false);

  useEffect(() => {
    if (!stillLoading && !allowed) {
      router.replace(fallback);
    }
  }, [stillLoading, allowed, router, fallback]);

  if (stillLoading || !allowed) return null;
  return <>{children}</>;
}
