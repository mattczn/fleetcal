/**
 * Clerk backend client — lazily-instantiated so module load doesn't
 * cost anything when no Clerk API call is needed. Only used for org /
 * user lookups (org imageUrl on invoice generation, etc.); JWT
 * verification still uses the lighter-weight verifyToken path in the
 * auth middleware.
 */

import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { env } from "./env.js";

let _client: ClerkClient | null = null;

export function clerk(): ClerkClient {
  if (_client) return _client;
  _client = createClerkClient({ secretKey: env.clerkSecretKey });
  return _client;
}

/**
 * Fetch the Clerk organization's display name + imageUrl. Returns
 * null on failure (404 / network) so callers can degrade gracefully
 * instead of failing the whole request — an invoice without a logo
 * is fine, but a 500 because we couldn't reach Clerk is not.
 */
export async function getOrgIdentity(orgId: string): Promise<{
  name?: string;
  imageUrl?: string;
} | null> {
  try {
    const org = await clerk().organizations.getOrganization({ organizationId: orgId });
    return {
      name:     org.name      ?? undefined,
      imageUrl: org.imageUrl  ?? undefined,
    };
  } catch (err) {
    console.warn("[clerk] getOrgIdentity failed:", err);
    return null;
  }
}

// ── User display name cache ────────────────────────────────────────────
// Small in-memory LRU so a bulk paste of N loads triggers exactly one
// Clerk API call instead of N. Cache TTL is 15 minutes — long enough
// to coalesce a paste burst, short enough that a name change in Clerk
// propagates without a redeploy.
const USER_NAME_TTL_MS = 15 * 60 * 1000;
const userNameCache = new Map<string, { name: string; expiresAt: number }>();

/**
 * Best-effort display name for a Clerk user id. Order of preference:
 *
 *   1. firstName + lastName (e.g. "Matt Curzon")
 *   2. firstName alone
 *   3. primary email address
 *   4. username
 *   5. raw userId (so we at least have something traceable)
 *
 * Used to backfill `created_by_name` on rows where the client didn't
 * pass it — programmatic flows (rate-con parser, bulk paste, future
 * batch import scripts) often forget to populate the field, leaving
 * "—" in the dispatcher UI's audit panel. Falling back to Clerk here
 * means every load has a name regardless of which path created it.
 *
 * Returns null on hard failure (network out, Clerk down) so the
 * caller can decide whether to insert with null or block the create.
 */
export async function getUserDisplayName(userId: string): Promise<string | null> {
  if (!userId) return null;
  const cached = userNameCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.name;
  }
  try {
    const user = await clerk().users.getUser(userId);
    const first = user.firstName?.trim();
    const last  = user.lastName?.trim();
    const email =
      user.emailAddresses.find(e => e.id === user.primaryEmailAddressId)?.emailAddress
      ?? user.emailAddresses[0]?.emailAddress
      ?? undefined;
    const username = user.username?.trim() ?? undefined;
    const name =
      (first && last) ? `${first} ${last}` :
      first ?? email ?? username ?? userId;
    userNameCache.set(userId, { name, expiresAt: Date.now() + USER_NAME_TTL_MS });
    return name;
  } catch (err) {
    console.warn("[clerk] getUserDisplayName failed:", userId, err);
    return null;
  }
}
