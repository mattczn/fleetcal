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
