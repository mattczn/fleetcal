/**
 * Server-side org tier resolution. Mirrors apps/web/lib/useOrgTier.ts
 * so the truck cap is enforced even when callers bypass the UI
 * (curl, scripts, malicious clients sending forged requests).
 *
 * Why this exists: the client-side `useOrgTier` hook is a UX
 * affordance — it surfaces the upgrade nag in AddAssetDialog. It's
 * not a security gate. A motivated user could open DevTools, copy
 * their session token, and POST directly to /v1/assets past the
 * cap. This file is the actual gate.
 *
 * Resolution order (highest → lowest tier) so an org with
 * overlapping plans / feature grants lands on the most permissive
 * tier. Matches the client's behavior.
 *
 * Failure mode: any error fetching the Clerk subscription returns
 * { tier: 'none', maxTrucks: 0 }, which will BLOCK the create. We
 * fail closed on the server because billing data is the source of
 * truth — letting an unresolvable org through would silently mean
 * "free unlimited trucks for any org Clerk can't tell us about,"
 * which is a worse failure than a temporary block.
 *
 * The one exception: orgs in INTERNAL_ORG_IDS (Curzon today) get
 * `unrestricted`. This matches the web-side carve-out and keeps
 * the founder's dogfood org working through any billing config
 * change.
 */

import { clerk } from "./clerk.js";

/** Internal-org allowlist. Mirrors apps/web/lib/internalOrg.ts.
 *  Keep these in sync — both files have to agree on which orgs
 *  bypass the cap. */
const INTERNAL_ORG_IDS: ReadonlySet<string> = new Set([
  // Curzon Trucking (production org_id, post 2026-06-07 Clerk cutover).
  "org_3Ck09w6LuEjiX4WgxJEPyiyjuXN",
]);

export type OrgTier = "owner_op" | "growth" | "fleet" | "unrestricted" | "none";

export interface OrgTierInfo {
  tier:      OrgTier;
  /** Maximum trucks allowed. Infinity for `unrestricted`. */
  maxTrucks: number;
}

/**
 * The single rule for "is this truck active right now":
 *
 *   activeFrom <= todayKey AND (activeTo IS NULL OR activeTo >= todayKey)
 *
 * Matches apps/web/lib/lifecycle.ts isActiveOn. Both ends are
 * INCLUSIVE — a truck retired with activeTo = today still counts
 * as active today (it's the last day of service). Same for
 * activeFrom = today (first day of service).
 *
 * Apply via Supabase query builders:
 *
 *   const q = supabase.from("assets").select(...).eq("org_id", orgId);
 *   applyActiveTodayFilter(q, todayKey);
 *
 * The two `.lte`/`.or` calls match the isActiveOn logic exactly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyActiveTodayFilter(q: any, todayKey: string): any {
  return q
    .lte("active_from", todayKey)
    .or(`active_to.is.null,active_to.gte.${todayKey}`);
}

/** Cap per tier. Mirrors TIER_TRUCK_CAP in apps/web/lib/useOrgTier.ts —
 *  bump both files together if you renegotiate pricing. */
const TIER_TRUCK_CAP: Record<"owner_op" | "growth" | "fleet", number> = {
  owner_op: 4,
  growth:   9,
  fleet:    14,
};

/** Feature slug per tier — must match what's configured on each
 *  plan in the Clerk dashboard. Same strings the client uses. */
const TIER_FEATURE_PRIORITY: Array<{ feature: string; tier: "fleet" | "growth" | "owner_op" }> = [
  { feature: "fleet_tier",    tier: "fleet"    },
  { feature: "growth_tier",   tier: "growth"   },
  { feature: "owner_op_tier", tier: "owner_op" },
];

function rank(tier: "fleet" | "growth" | "owner_op"): number {
  if (tier === "fleet")    return 3;
  if (tier === "growth")   return 2;
  return 1; // owner_op
}

/**
 * Fetch the org's effective tier + truck cap.
 *
 * Reads via Clerk's billing API — same shape the admin dashboard
 * uses. Internal orgs short-circuit to `unrestricted` so a
 * billing outage can't lock Curzon's calendar.
 */
export async function getOrgTier(orgId: string): Promise<OrgTierInfo> {
  if (INTERNAL_ORG_IDS.has(orgId)) {
    return { tier: "unrestricted", maxTrucks: Number.POSITIVE_INFINITY };
  }

  try {
    // Clerk billing is @experimental — wrap so SDK changes can't
    // 500 the entire create endpoint. We translate any failure
    // into "tier: none" → maxTrucks: 0 → caller returns 402.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub: any = await (clerk() as any).billing.getOrganizationBillingSubscription(orgId);
    let bestTier:  "fleet" | "growth" | "owner_op" | null = null;

    const items = (sub?.subscriptionItems ?? []) as Array<{ plan?: { features?: Array<{ slug?: string }> } }>;
    for (const item of items) {
      const features = item.plan?.features ?? [];
      for (const slot of TIER_FEATURE_PRIORITY) {
        if (features.some(f => f.slug === slot.feature)) {
          if (!bestTier || rank(slot.tier) > rank(bestTier)) bestTier = slot.tier;
          break;
        }
      }
    }

    if (bestTier) {
      return { tier: bestTier, maxTrucks: TIER_TRUCK_CAP[bestTier] };
    }
    return { tier: "none", maxTrucks: 0 };
  } catch (err) {
    console.warn(`[orgTier] failed to resolve tier for ${orgId}; failing closed:`, err);
    return { tier: "none", maxTrucks: 0 };
  }
}

