/**
 * Internal-org allowlist.
 *
 * Surfaces that should ONLY appear for our own dogfooding orgs (i.e.
 * Curzon Trucking — the founder's carrier) check against this list.
 * The Modules toggle in Settings is the canonical example: it lets us
 * flip product surfaces on/off per-tier, but no customer needs to see
 * those toggles since their plan locks the module set automatically.
 *
 * Hardcoded over an env var because (a) the list rarely changes,
 * (b) it must be deterministic at SSR time without any env lookup, and
 * (c) leaking the list into a client bundle is fine — the gate is a
 * "should we show this widget" UX choice, not a security boundary.
 *
 * If you ever need to add a second internal org (e.g. an investor demo
 * org), append its prod org_id here and ship.
 */

const INTERNAL_ORG_IDS: ReadonlySet<string> = new Set([
  // Curzon Trucking (production org_id, post 2026-06-07 Clerk cutover).
  'org_3Ck09w6LuEjiX4WgxJEPyiyjuXN',
]);

export function isInternalOrg(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  return INTERNAL_ORG_IDS.has(orgId);
}

/**
 * Optional per-USER tightening for the CRM surfaces. When
 * NEXT_PUBLIC_CRM_USER_IDS (comma-separated Clerk user ids, inlined at
 * build time) is set, the CRM nav/pages render only for those users —
 * not every admin of an internal org. Unset = fall back to the org
 * gate alone. UX-only like the org gate; the API enforces the same
 * allowlist server-side via CRM_INTERNAL_USER_IDS (404s).
 */
const CRM_USER_IDS: ReadonlySet<string> = new Set(
  (process.env.NEXT_PUBLIC_CRM_USER_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean),
);

export function isCrmUser(userId: string | null | undefined): boolean {
  if (CRM_USER_IDS.size === 0) return true;
  return !!userId && CRM_USER_IDS.has(userId);
}
