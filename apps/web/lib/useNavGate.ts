'use client';

/**
 * Single visibility predicate for every nav surface.
 *
 * Three surfaces render the same gated links — AppSidebar (main rail),
 * AssetSidebar (calendar rail, which reuses AppSidebar's PRIMARY_NAV)
 * and ManagementHeader — and each had grown its own copy of
 * `can(cap) && (!module || moduleEnabled(module))`. All three copies
 * shared the same bug, which is what a duplicated predicate buys you.
 *
 * The bug: both inputs hydrate asynchronously, and both fail OPEN
 * while they do.
 *
 *   - `usePermissions().isLoading` is true until Clerk resolves the
 *     membership, and every surface rendered its links UNFILTERED
 *     during that window.
 *   - `useModules()` reads `orgModules`, which starts as `{}`. Since
 *     `isModuleEnabled` treats an absent key as ENABLED (so a module
 *     added in code before its DB default ships doesn't lock anyone
 *     out), an empty map means *everything is on*.
 *
 * So on every cold load the nav painted the full link set, then
 * removed whatever the org doesn't have — a visible flash of Fuel,
 * Equipment, Command Center et al. for orgs that don't own them.
 * Beyond looking broken, it advertises the existence of modules the
 * customer hasn't bought.
 *
 * Fix: hide gated items until BOTH inputs have resolved. `ready` is
 * false during hydration and `visible()` returns false for anything
 * carrying a cap or module, so a link appears only once we can prove
 * the org actually has it. Callers render a skeleton off `ready` to
 * keep the space reserved instead of popping the layout.
 *
 * This mirrors the treatment `internalOnly` (CRM) already got for the
 * same reason — see the comment in AppSidebar. Nothing gated should
 * render optimistically; there is no safe optimistic guess.
 */

import { useCallback, useEffect } from 'react';
import type { Capability, OrgModule } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { useCalendarStore } from '@/store/useCalendarStore';

/** The gate-bearing shape shared by NavLeaf, NavGroup and the
 *  ManagementHeader link list. Structural so each surface can keep
 *  its own richer type. */
export interface NavGated {
  cap?:    Capability;
  module?: OrgModule;
}

export interface NavGateApi {
  /** True once permissions AND module flags have both resolved.
   *  Render skeletons while false. */
  ready: boolean;
  /** Whether a gated item should render. Always false before `ready`
   *  for anything carrying a cap or module. */
  visible: (item: NavGated) => boolean;
}

export function useNavGate(): NavGateApi {
  const { can, isLoading: permsLoading } = usePermissions();
  const { enabled, hydrated } = useModules();
  const ensureOrgModules = useCalendarStore((s) => s.ensureOrgModules);

  // The nav can't wait on DataLoader for its flags: DataLoader is
  // mounted per-page and several pages that DO render the nav don't
  // mount it (/expenses, /admin/*). Gating on modulesHydrated without
  // this left the sidebar stuck on its skeleton forever on exactly
  // those routes. ensureOrgModules is idempotent and no-ops once
  // hydrated, so this is a cheap safety net on pages DataLoader
  // covers and the only hydration path on pages it doesn't.
  useEffect(() => { ensureOrgModules(); }, [ensureOrgModules]);

  const ready = !permsLoading && hydrated;

  const visible = useCallback(
    (item: NavGated) => {
      // Ungated items (no cap, no module) are safe to paint
      // immediately — there's nothing to leak and nothing to learn by
      // waiting.
      if (!item.cap && !item.module) return true;
      if (!ready) return false;
      if (item.cap && !can(item.cap)) return false;
      if (item.module && !enabled(item.module)) return false;
      return true;
    },
    [ready, can, enabled],
  );

  return { ready, visible };
}
