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
  type Capability,
  type OrgRole,
  type RoleOverrides,
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
