/**
 * Org API key auth middleware.
 *
 * Authenticates server-to-server callers (Google Apps Script, Zapier,
 * etc.) that can't carry a Clerk session. Looks up the key in the
 * `org_api_keys` table by sha256(plaintext), verifies it's not revoked
 * and carries the required scope, then sets orgId on the request
 * context the same shape clerkAuth would — so downstream route
 * handlers don't need to know which auth path ran.
 *
 * Key shape: `fck_<32 hex chars>` (see migration 20260529_org_api_keys.sql).
 * Header: `X-Api-Key`.
 *
 * On every successful auth we fire-and-forget update last_used_at so
 * dispatch can see which keys are stale without slowing the request.
 */

import type { MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { supabase } from "../lib/supabase.js";
import type { AuthVariables } from "./clerk.js";

// The org_api_keys table isn't in the generated Database types until
// the migrations are applied + the generator is re-run. Cast through
// any so this file compiles in CI before that lands. Once the types
// are regenerated, the as-any casts below can come out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supa = supabase as any;

/** sha256 hex of the plaintext key. Stable, no-salt — we don't need
 *  brute-force resistance because the keys are 128 bits of entropy. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Factory: returns a middleware that requires the caller to present an
 * API key with the given scope. Use one instance per route:
 *
 *   fuel.post("/inbound-email", requireApiKey("fuel.ingest"), handler);
 *
 * The scope check is "key.scopes includes scope". Keys are scope-
 * gated so a leak of one key can't reach unrelated surfaces.
 */
export function requireApiKey(scope: string): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const key = c.req.header("x-api-key");
    if (!key) {
      return c.json({ error: "unauthorized", reason: "missing_api_key" }, 401);
    }
    if (!key.startsWith("fck_") || key.length < 16) {
      // Cheap pre-check — saves a DB hit on obviously-malformed values.
      return c.json({ error: "unauthorized", reason: "invalid_api_key_format" }, 401);
    }

    const keyHash = hashApiKey(key);
    const { data, error } = await supa
      .from("org_api_keys")
      .select("id, org_id, scopes, revoked_at")
      .eq("key_hash", keyHash)
      .maybeSingle();
    if (error) {
      console.error("[apiKeyAuth] lookup failed:", error);
      return c.json({ error: "internal_error", reason: "auth_lookup_failed" }, 500);
    }
    if (!data) {
      return c.json({ error: "unauthorized", reason: "invalid_api_key" }, 401);
    }
    const row = data as { id: string; org_id: string; scopes: string[] | null; revoked_at: string | null };
    if (row.revoked_at) {
      return c.json({ error: "unauthorized", reason: "api_key_revoked" }, 401);
    }
    const scopes = Array.isArray(row.scopes) ? row.scopes : [];
    if (!scopes.includes(scope)) {
      return c.json(
        { error: "forbidden", reason: "missing_scope", required: scope } satisfies Record<string, unknown>,
        403,
      );
    }

    c.set("userId", `apikey:${row.id}`);
    c.set("orgId", row.org_id);

    // Fire-and-forget last_used_at update. We don't await — a stale
    // timestamp is cheaper than blocking every request on a write.
    void supa
      .from("org_api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id);

    await next();
  };
}
