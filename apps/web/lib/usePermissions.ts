/**
 * usePermissions — single hook every gated UI element reads.
 *
 * Wraps Clerk's `useOrganization()` membership and resolves it through
 * our shared role→capability matrix. Returns a stable `can(...)`
 * function plus the typed role so call sites don't have to repeat the
 * Clerk plumbing.
 *
 * Usage:
 *   const { role, can } = usePermissions();
 *   if (!can('payroll.finalize')) return null;
 *
 * The API is the source of truth — UI gating is a UX nicety only.
 * Never trust this for security; always pair with a server-side
 * `requireCapability(...)` on the matching endpoint.
 */

"use client";

import { useMemo } from "react";
import { useOrganization } from "@clerk/nextjs";
import {
  can,
  parseClerkRole,
  type Capability,
  type OrgRole,
} from "@fleetcal/types";

export interface PermissionsApi {
  /** Resolved typed role for the active org, or undefined while
   *  Clerk is still hydrating. */
  role: OrgRole | undefined;
  /** True iff the current role has the capability. */
  can: (cap: Capability) => boolean;
  /** Convenience for code that wants the raw Clerk role slug
   *  (e.g. to display in a profile chip). */
  clerkRole: string | undefined;
  /** True while Clerk is still resolving the active membership.
   *  Useful for showing skeletons instead of locked-out states. */
  isLoading: boolean;
}

export function usePermissions(): PermissionsApi {
  const { membership, isLoaded } = useOrganization();

  return useMemo(() => {
    const clerkRole = membership?.role ?? undefined;
    const role = parseClerkRole(clerkRole);
    return {
      role,
      clerkRole,
      isLoading: !isLoaded,
      can: (cap: Capability) => can(role, cap),
    };
  }, [membership?.role, isLoaded]);
}
