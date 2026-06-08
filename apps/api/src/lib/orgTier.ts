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

import { env } from "./env.js";

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
 * The rule for "does this truck consume a paid seat":
 *
 *   active_to IS NULL  OR  active_to >= today
 *
 * i.e. "currently in service." A truck is currently in service
 * if it has no retire date set, OR if its scheduled retire date
 * is still in the future. The earlier version of this filter
 * was `active_to IS NULL` only — and that turned out to be a
 * loophole: setting active_to to '2099-01-01' would silently
 * exclude the truck from the cap while it kept showing on the
 * calendar (since the lifecycle predicate just needs active_to
 * to be >= today, not null).
 *
 * `active_from` is still deliberately ignored. A back-dated
 * truck for reporting purposes (e.g. activeFrom='2026-01-01'
 * on Curzon's fleet) doesn't trigger a phantom overlap with
 * retired trucks under this rule, because the cap is about
 * RIGHT-NOW operational capacity, not historical reconstruction.
 *
 * tz note: server uses UTC for "today", client uses local. They
 * can disagree by a day at the midnight boundary. Direction of
 * the disagreement under THIS rule is safe:
 *   - server's today is one day AHEAD of client's
 *   - a truck retired with active_to = client-today is < server-
 *     today on the server, so server excludes it
 *   - net effect: server is slightly more permissive than client
 * That's a UX glitch (truck create succeeds even though client
 * shows the cap as already hit) but it can't undercount, so it's
 * not a billing leak. The previous bug was the opposite direction
 * (server stricter than client) which DID block legitimate adds.
 *
 * Apply via Supabase query builders:
 *
 *   const q = supabase.from("assets").select(...).eq("org_id", orgId);
 *   applyActiveCapFilter(q);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyActiveCapFilter(q: any): any {
  const today = new Date().toISOString().slice(0, 10);
  return q.or(`active_to.is.null,active_to.gte.${today}`);
}

/** @deprecated kept for any caller still importing the old name.
 *  Forwards to the new rule (ignores todayKey). Delete once no
 *  callers remain. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function applyActiveTodayFilter(q: any, _todayKey: string): any {
  return applyActiveCapFilter(q);
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
 * Calls Clerk's billing HTTP endpoint directly. We used to go
 * through `clerk().billing.getOrganizationBillingSubscription`
 * but that method DOES NOT EXIST on @clerk/backend 1.x — only
 * `users`, `organizations`, etc. are wrapped. The call silently
 * threw `TypeError: cannot read .billing of undefined`, hit the
 * catch, and every org collapsed to "none" / maxTrucks: 0 →
 * every create returned 402 with the generic "contact support"
 * message. The user only noticed when the cap enforcement landed.
 *
 * Raw fetch to `/v1/organizations/{org_id}/billing/subscription`
 * works against the live Clerk REST API and returns snake_case
 * JSON. We parse the plan features looking for our tier slugs.
 *
 * Internal orgs short-circuit to `unrestricted` so a billing
 * outage can't lock Curzon's calendar.
 */
export async function getOrgTier(orgId: string): Promise<OrgTierInfo> {
  if (INTERNAL_ORG_IDS.has(orgId)) {
    return { tier: "unrestricted", maxTrucks: Number.POSITIVE_INFINITY };
  }

  try {
    const res = await fetch(
      `https://api.clerk.com/v1/organizations/${encodeURIComponent(orgId)}/billing/subscription`,
      { headers: { Authorization: `Bearer ${env.clerkSecretKey}` } },
    );
    if (!res.ok) {
      // Surface the real reason in logs. The previous version swallowed
      // everything into a generic "failed to resolve tier" warning
      // which made the SDK-undefined bug invisible for hours. Capture
      // the status + body so the next time something breaks, the cause
      // is in the first log line.
      const body = await res.text().catch(() => "");
      console.warn(`[orgTier] Clerk ${res.status} for ${orgId}: ${body.slice(0, 200)}; failing closed`);
      return { tier: "none", maxTrucks: 0 };
    }

    // Clerk's HTTP API returns snake_case — be explicit about that
    // here so the field names don't drift if someone copies this
    // block expecting camelCase.
    const sub = (await res.json()) as {
      subscription_items?: Array<{ plan?: { features?: Array<{ slug?: string }> } }>;
    };

    let bestTier: "fleet" | "growth" | "owner_op" | null = null;
    for (const item of sub.subscription_items ?? []) {
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

