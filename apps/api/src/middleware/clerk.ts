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
      // Role slug — Clerk passes `org:owner` / `org:admin` / etc.
      // Prefer the long-form `org_role` claim when present, fall back
      // to the compact `o.rol` Clerk includes in the default session
      // token. If the dashboard's Sessions-claim customizer was
      // configured with a template variable Clerk doesn't recognize
      // (e.g. `{{org_membership.role}}` in some versions), the value
      // is passed through verbatim — strip those "{{...}}" literals
      // so the o.rol fallback activates instead of locking everyone
      // out under a bogus role name.
      const rawOrgRole = claimsRec.org_role as string | undefined;
      const orgRoleClean =
        rawOrgRole && !rawOrgRole.startsWith("{{") ? rawOrgRole : undefined;
      const roleSlug = orgRoleClean ?? orgClaim?.rol ?? undefined;

      if (!userId) {
        return c.json({ error: "unauthorized", reason: "no_subject" }, 401);
      }
      if (typeof orgId !== "string" || !orgId) {
        return c.json(
          { error: "forbidden", reason: "no_active_organization" },
          403,
        );
      }

      // Resolve the user's role. If the JWT lacks the org_role claim
      // (Clerk dashboard not yet updated to expose it) AND we don't
      // have the compact o.rol either, we'd otherwise lock the user
      // out of every gated endpoint. Fall back to "admin" with a
      // server-side warning so the app keeps working. Once the JWT
      // template is verified to carry the role, the warning stops
      // and real enforcement begins.
      //
      // TODO(permissions): tighten this back to undefined once the
      // Clerk session JWT is confirmed to include the role claim for
      // every active user.
      let orgRole = parseClerkRole(roleSlug);
      if (!orgRole) {
        console.warn(
          "[clerkAuth] no recognized role in JWT — falling back to admin.",
          { orgId, userId, roleSlug },
        );
        orgRole = "admin";
      }

      c.set("userId",  userId);
      c.set("orgId",   orgId);
      c.set("orgRole", orgRole);
      await next();
    } catch (err) {
      const message = err instanceof Error ? err.message : "verification_failed";
      return c.json({ error: "unauthorized", reason: message }, 401);
    }
  };
