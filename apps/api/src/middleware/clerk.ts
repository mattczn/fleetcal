/**
 * Clerk JWT verification middleware.
 *
 * Verifies the Bearer token, extracts the active org + user + role, and
 * attaches them to the Hono context. Routes that need auth pull
 * `c.get('orgId')` / `c.get('userId')` / `c.get('orgRole')`.
 *
 * Returns:
 *   401 if no Authorization header or token is invalid/expired
 *   403 if the token is valid but has no active organization (we're org-scoped)
 */

import type { MiddlewareHandler } from "hono";
import { verifyToken } from "@clerk/backend";
import { parseClerkRole, type OrgRole } from "@fleetcal/types";
import { env } from "../lib/env.js";

export type AuthVariables = {
  userId: string;
  orgId: string;
  /** Resolved role for this user in the active org, derived from the
   *  Clerk role slug on the JWT (`org_role` or `o.rol`). Undefined
   *  when the token was minted before we added the claim — callers
   *  that gate on this MUST treat undefined as least-privileged. */
  orgRole: OrgRole | undefined;
};

export const clerkAuth: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized", reason: "missing_bearer" }, 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      return c.json({ error: "unauthorized", reason: "empty_token" }, 401);
    }

    try {
      const claims = await verifyToken(token, {
        secretKey: env.clerkSecretKey,
      });

      const userId = claims.sub;
      // Clerk session tokens carry the active org as `org_id` (or `o.id` in
      // newer templates). Accept either.
      const claimsRec = claims as Record<string, unknown>;
      const orgClaim = claimsRec.o as { id?: string; rol?: string } | undefined;
      const orgId = (claimsRec.org_id as string | undefined) ?? orgClaim?.id;
      // Role slug — Clerk passes `org:owner` / `org:admin` / etc. We
      // accept either the long-form `org_role` claim (custom template)
      // or the short `o.rol` from Clerk's default session shape.
      const roleSlug =
        (claimsRec.org_role as string | undefined) ??
        orgClaim?.rol ??
        undefined;

      if (!userId) {
        return c.json({ error: "unauthorized", reason: "no_subject" }, 401);
      }
      if (typeof orgId !== "string" || !orgId) {
        return c.json(
          { error: "forbidden", reason: "no_active_organization" },
          403,
        );
      }

      c.set("userId",  userId);
      c.set("orgId",   orgId);
      c.set("orgRole", parseClerkRole(roleSlug));
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "verification_failed";
      return c.json({ error: "unauthorized", reason: message }, 401);
    }
  };
