/**
 * Capability gates for Hono routes.
 *
 * Use as a per-route middleware AFTER clerkAuth so the role is set:
 *
 *   trailers.delete("/:id",
 *     requireCapability("trailers.delete"),
 *     async (c) => { ... },
 *   );
 *
 * 403s on denial. The shape matches the rest of the API's error
 * responses so the web client can render a useful message.
 *
 * Capability resolution goes:
 *   1. Per-org role override (org_settings.role_overrides)
 *   2. Hardcoded default in @fleetcal/types/permissions
 *
 * Overrides are cached per-org for ROLE_OVERRIDES_TTL_MS so we don't
 * pay a DB round-trip on every single request — a tweak from an
 * admin takes effect within the TTL.
 */

import type { MiddlewareHandler } from "hono";
import {
  effectiveCan,
  isModuleEnabled,
  type Capability,
  type OrgRole,
  type RoleOverrides,
  type OrgModule,
  type OrgModuleFlags,
} from "@fleetcal/types";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "./clerk.js";

// ── Per-org role-override cache ─────────────────────────────────────────

interface CacheEntry { overrides: RoleOverrides; fetchedAt: number }
const overrideCache = new Map<string, CacheEntry>();
const ROLE_OVERRIDES_TTL_MS = 60_000; // 1 minute — short enough that an admin's tweak takes effect quickly

async function loadOverrides(orgId: string): Promise<RoleOverrides> {
  const now = Date.now();
  const cached = overrideCache.get(orgId);
  if (cached && now - cached.fetchedAt < ROLE_OVERRIDES_TTL_MS) {
    return cached.overrides;
  }
  const { data, error } = await supabase
    .from("org_settings")
    .select("role_overrides")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    console.warn("[requireCapability] failed to load role_overrides for", orgId, error);
    overrideCache.set(orgId, { overrides: {}, fetchedAt: now });
    return {};
  }
  const overrides = (data as { role_overrides?: RoleOverrides } | null)?.role_overrides ?? {};
  overrideCache.set(orgId, { overrides, fetchedAt: now });
  return overrides;
}

/** Public hook so the org-settings PATCH handler can flush the cache
 *  immediately after a write — admins don't have to wait the TTL for
 *  their change to apply across the API. */
export function invalidateRoleOverrides(orgId: string): void {
  overrideCache.delete(orgId);
}

// ── Per-org module-flags cache ──────────────────────────────────────────
//
// Same shape as the role-overrides cache, separate so a PATCH that
// only touches one of the two doesn't blow away the other. Module
// flags change much less frequently than role overrides (usually only
// when an admin/Stripe webhook flips a plan), but we still cap the
// TTL so a billing event takes effect within the minute.

interface ModuleCacheEntry { flags: OrgModuleFlags; fetchedAt: number }
const moduleCache = new Map<string, ModuleCacheEntry>();
const ORG_MODULES_TTL_MS = 60_000;

async function loadOrgModules(orgId: string): Promise<OrgModuleFlags> {
  const now = Date.now();
  const cached = moduleCache.get(orgId);
  if (cached && now - cached.fetchedAt < ORG_MODULES_TTL_MS) {
    return cached.flags;
  }
  const { data, error } = await supabase
    .from("org_settings")
    .select("modules")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    // Fail OPEN — if we can't determine which modules are enabled, the
    // safer default is to let the request through and let downstream
    // capability checks handle authz. Locking everyone out on a transient
    // DB blip would be worse than letting one through.
    console.warn("[requireModule] failed to load modules for", orgId, error);
    moduleCache.set(orgId, { flags: {}, fetchedAt: now });
    return {};
  }
  const flags = (data as { modules?: OrgModuleFlags } | null)?.modules ?? {};
  moduleCache.set(orgId, { flags, fetchedAt: now });
  return flags;
}

/** Same idea as invalidateRoleOverrides — call from the org-settings
 *  PATCH handler when modules change so the next request sees fresh
 *  flags. Also called by the future Stripe webhook receiver. */
export function invalidateOrgModules(orgId: string): void {
  moduleCache.delete(orgId);
}

/** Inline capability check for handlers that need to choose between
 *  caps based on request body content (e.g. POST /v1/events branching
 *  on event_kind to decide between loads.create vs
 *  nonRevenueEvents.create). Async because it goes through the same
 *  override loader as requireCapability, so the check stays consistent
 *  with middleware-level enforcement. */
export async function effectiveCanForOrg(
  role: OrgRole | undefined,
  cap: Capability,
  orgId: string | undefined,
): Promise<boolean> {
  if (!orgId) return false;
  const overrides = await loadOverrides(orgId);
  return effectiveCan(role, cap, overrides);
}

// ── Middlewares ─────────────────────────────────────────────────────────

export function requireCapability(
  cap: Capability,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const role  = c.get("orgRole");
    const orgId = c.get("orgId");
    const overrides = orgId ? await loadOverrides(orgId) : {};
    if (!effectiveCan(role, cap, overrides)) {
      return c.json(
        {
          error: "forbidden",
          reason: "missing_capability",
          capability: cap,
          role: role ?? null,
        },
        403,
      );
    }
    await next();
  };
}

/**
 * Org-level module gate. Returns 403 if the module is OFF for the
 * org. Mount this BEFORE requireCapability on every route in a
 * module's group:
 *
 *   payroll.use("*", requireModule("payroll"), requireCapability("payroll.access"));
 *
 * Module checks happen first so a disabled-module org gets a clean
 * "module_disabled" response instead of a "missing_capability" one
 * (the latter would suggest "ask your admin for the cap" when the
 * real answer is "your plan doesn't include this feature").
 */
export function requireModule(
  module: OrgModule,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const orgId = c.get("orgId");
    const flags = orgId ? await loadOrgModules(orgId) : {};
    if (!isModuleEnabled(module, flags)) {
      return c.json(
        {
          error: "forbidden",
          reason: "module_disabled",
          module,
        },
        403,
      );
    }
    await next();
  };
}

/**
 * Convenience for "this whole route group requires at least admin" —
 * skipping the per-cap matrix. Useful for endpoints that don't have a
 * natural capability name yet (one-off admin tools). Not affected by
 * role overrides — role identity itself is hardcoded.
 */
export function requireRole(
  ...allowed: OrgRole[]
): MiddlewareHandler<{ Variables: AuthVariables }> {
  const set = new Set(allowed);
  return async (c, next) => {
    const role = c.get("orgRole");
    if (!role || !set.has(role)) {
      return c.json(
        {
          error: "forbidden",
          reason: "role_required",
          allowed,
          role: role ?? null,
        },
        403,
      );
    }
    await next();
  };
}
