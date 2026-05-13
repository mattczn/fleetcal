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
 */

import type { MiddlewareHandler } from "hono";
import { can, type Capability, type OrgRole } from "@fleetcal/types";
import type { AuthVariables } from "./clerk.js";

export function requireCapability(
  cap: Capability,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const role = c.get("orgRole");
    if (!can(role, cap)) {
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
 * natural capability name yet (one-off admin tools).
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
