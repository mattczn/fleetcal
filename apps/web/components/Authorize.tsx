/**
 * <Authorize> — declarative permission gate for chunks of JSX.
 *
 * Show children only when the active user has a capability (or role
 * threshold). Anything else renders the optional `fallback` (or nothing).
 *
 *   // Gate a button on a single capability:
 *   <Authorize cap="payroll.finalize">
 *     <button onClick={...}>Finalize</button>
 *   </Authorize>
 *
 *   // Gate a whole settings section on a minimum role:
 *   <Authorize role="admin" fallback={<NotAllowed />}>
 *     <OrgSettingsPanel />
 *   </Authorize>
 *
 *   // Or both — must satisfy ALL conditions provided:
 *   <Authorize cap="customers.delete" role="admin">...</Authorize>
 *
 * Don't use this for security boundaries — only for UX. The matching
 * API endpoint must enforce the same capability or the gate is just a
 * visual.
 */

"use client";

import type { ReactNode } from "react";
import { roleAtLeast, type Capability, type OrgRole, type OrgModule } from "@fleetcal/types";
import { usePermissions } from "@/lib/usePermissions";
import { useModules } from "@/lib/useModules";

interface Props {
  /** Capability the user must hold. */
  cap?: Capability;
  /** Minimum role (inclusive). e.g. role="admin" matches admin + owner. */
  role?: OrgRole;
  /** Org-level module that must be ON for the org. Independent of
   *  role — a maintenance org without the Fuel module hides fuel UI
   *  even from the owner. */
  module?: OrgModule;
  /** What to render when the gate denies. Defaults to nothing. */
  fallback?: ReactNode;
  /** What to render while Clerk is still loading the membership.
   *  Defaults to the same as `fallback` (i.e. assume denied — safer). */
  loading?: ReactNode;
  children: ReactNode;
}

export function Authorize({
  cap,
  role: minRole,
  module,
  fallback = null,
  loading,
  children,
}: Props) {
  const { role, can, isLoading } = usePermissions();
  const { enabled: moduleEnabled } = useModules();

  if (isLoading) return <>{loading ?? fallback}</>;

  if (cap && !can(cap)) return <>{fallback}</>;
  if (minRole && !roleAtLeast(role, minRole)) return <>{fallback}</>;
  if (module && !moduleEnabled(module)) return <>{fallback}</>;

  return <>{children}</>;
}
