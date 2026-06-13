'use client';

import { useCallback } from 'react';
import { isModuleEnabled, type OrgModule } from '@fleetcal/types';
import { useCalendarStore } from '@/store/useCalendarStore';

/**
 * Hook for checking whether an org-level module is enabled.
 *
 * Modules are the SaaS-billing axis — separate from role capabilities.
 * Capability says "can THIS USER perform this action?"; module says
 * "does this ORG have this feature at all?" Both must be true.
 *
 * Usage:
 *   const { enabled } = useModules();
 *   if (!enabled('payroll')) return null;
 *
 *   // Or pass the function to filters:
 *   const visible = NAV_LINKS.filter(l => !l.module || enabled(l.module));
 *
 * Flags are hydrated by DataLoader on app boot from /v1/org-settings.
 * An empty/unset map means everything is ON (the migration default).
 */
export function useModules() {
  const flags = useCalendarStore((s) => s.orgModules);
  const hydrated = useCalendarStore((s) => s.modulesHydrated);
  const enabled = useCallback(
    (module: OrgModule) => isModuleEnabled(module, flags),
    [flags],
  );
  return { enabled, flags, hydrated };
}
