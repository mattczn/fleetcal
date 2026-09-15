/**
 * usePermissions — single hook every gated UI element in FleetCal Go reads.
 *
 * Mobile port of apps/web/lib/usePermissions.ts. Same contract, same
 * shared matrix from @fleetcal/types, so a capability the web hides is
 * hidden here too without a second place to configure it. The Role
 * Permissions matrix in web Settings stays the ONLY control surface.
 *
 *   const { can } = usePermissions();
 *   if (!can("loads.view_driver_pay")) return null;
 *
 * As on web, this is a UX nicety only — the API's requireCapability()
 * is what actually enforces anything. Never treat a `can()` here as a
 * security boundary.
 *
 * ── Why this reads overrides and not just can() ───────────────────────
 *
 * The hardcoded defaults in @fleetcal/types are NOT the live policy.
 * Curzon, for example, revokes expenses.access and fuel.* from the
 * maintenance role via org_settings.role_overrides — the defaults grant
 * all three. A client that called the bare `can()` would hand a
 * maintenance user every one of them back. So we resolve through
 * `effectiveCan(role, cap, overrides)`, exactly like web does.
 *
 * ── Why the overrides are cached to AsyncStorage ──────────────────────
 *
 * effectiveCan falls back to the DEFAULTS whenever the override map is
 * missing, and for the maintenance role every default is strictly MORE
 * permissive than Curzon's configured reality. So an unresolved fetch
 * doesn't fail closed, it fails OPEN. On web that window is a few ms on
 * a wired connection; on a phone in a shop with bad signal it can be
 * the whole session.
 *
 * Mirroring the last known map into AsyncStorage (same pattern as
 * useDriverPayPct in ./settings) means a cold start in a dead zone
 * re-applies the org's real policy instead of silently widening it.
 * `isLoading` stays true until we've resolved from cache or network so
 * callers can hold a gated surface back rather than flashing it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@clerk/clerk-expo";
import {
  effectiveCan,
  parseClerkRole,
  type Capability,
  type OrgRole,
  type RoleOverrides,
} from "@fleetcal/types";
import { railway } from "./railway";

const KEY_ROLE_OVERRIDES = "settings:roleOverrides";

/** Stable identity for "no overrides". A fresh `{}` on every render
 *  would bust the useMemo below, handing every consumer a new `can`
 *  each time and re-rendering gated subtrees for nothing. */
const NO_OVERRIDES: RoleOverrides = {};

export interface PermissionsApi {
  /** Resolved typed role for the active org, or undefined while Clerk
   *  is still hydrating (or if the Clerk slug is one we don't map). */
  role: OrgRole | undefined;
  /** True iff the role has the capability, per the per-org override
   *  map first and the hardcoded default second. */
  can: (cap: Capability) => boolean;
  /** Raw Clerk role slug, for profile chips and debugging. */
  clerkRole: string | undefined;
  /** True until BOTH Clerk membership and the override map have
   *  resolved (from cache or network). Gate first paint of any
   *  permission-dependent surface on this. */
  isLoading: boolean;
}

export function usePermissions(): PermissionsApi {
  const { organization, membership } = useOrganization();
  const orgId = organization?.id;

  // `undefined` = not yet read from disk; `null` = read, nothing cached.
  const [cached, setCached] = useState<RoleOverrides | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(KEY_ROLE_OVERRIDES)
      .then((raw) => {
        if (cancelled) return;
        if (raw == null) { setCached(null); return; }
        try {
          setCached(JSON.parse(raw) as RoleOverrides);
        } catch {
          // Corrupt cache entry — treat as absent rather than throwing.
          setCached(null);
        }
      })
      .catch(() => { if (!cancelled) setCached(null); });
    return () => { cancelled = true; };
  }, []);

  const q = useQuery({
    queryKey: ["org-settings", "roleOverrides", orgId],
    queryFn: async () => {
      const { settings } = await railway.getOrgSettings();
      return (settings?.roleOverrides ?? NO_OVERRIDES) as RoleOverrides;
    },
    enabled: !!orgId,
    // Overrides change when an admin edits the Role Permissions matrix,
    // which is rare — but not once-in-a-lifetime like driverPayPct, and
    // a stale grant is the kind of staleness we care about. 5 min.
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!q.isSuccess) return;
    void AsyncStorage.setItem(KEY_ROLE_OVERRIDES, JSON.stringify(q.data));
  }, [q.isSuccess, q.data]);

  // Server answer wins; last known map covers the offline cold start;
  // an empty map (defaults apply) is the final fallback.
  const overrides: RoleOverrides = q.isSuccess ? q.data : (cached ?? NO_OVERRIDES);

  // Clerk's membership can be null for a beat after `organization`
  // resolves, so key the loading flag off the membership itself.
  const overridesResolved = q.isSuccess || q.isError || cached !== undefined;
  const isLoading = membership === undefined || !overridesResolved;

  const clerkRole = membership?.role ?? undefined;

  return useMemo(() => {
    const role = parseClerkRole(clerkRole);
    return {
      role,
      clerkRole,
      isLoading,
      can: (cap: Capability) => effectiveCan(role, cap, overrides),
    };
  }, [clerkRole, isLoading, overrides]);
}
