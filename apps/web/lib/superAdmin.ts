/**
 * Super-admin gate for /admin/* surfaces.
 *
 * Clerk's per-org `orgRole === 'org:owner'` works for owner-only
 * actions WITHIN an org (e.g. reset-to-demo), but the /admin
 * dashboard is cross-org — Curzon's owner needs to see every other
 * org's AI spend. That's a fundamentally different gate: a small,
 * deploy-controlled allowlist of Clerk user ids, not a JWT claim.
 *
 * Allowlist source: `SUPER_ADMIN_USER_IDS` env var, comma-separated.
 * On Vercel: Project → Settings → Environment Variables. Add one
 * entry per super-admin user_id (Clerk user ids look like
 * `user_2nXYZ…`).
 *
 * Failure mode: if the env var is unset OR empty, `isSuperAdmin`
 * returns false for everyone. This is intentional — a misconfigured
 * deploy locks the admin surface rather than opening it. Show a
 * 404 (not 403) so we don't telegraph that /admin even exists.
 */

const ALLOWLIST: string[] = (process.env.SUPER_ADMIN_USER_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * True iff the given Clerk user_id is in the SUPER_ADMIN_USER_IDS
 * allowlist. Returns false for null/undefined input (unauthenticated
 * request) and for any user not explicitly listed.
 */
export function isSuperAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ALLOWLIST.includes(userId);
}

/**
 * Whether the allowlist has anyone in it. Useful as a one-time
 * deploy diagnostic: hitting the admin route on a fresh deploy
 * where the env var was forgotten should give a clear "no admins
 * configured" hint in the logs, not a silent 404.
 */
export function hasAnyAdmin(): boolean {
  return ALLOWLIST.length > 0;
}
