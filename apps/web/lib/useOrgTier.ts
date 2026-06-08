/**
 * useOrgTier — single hook every billing-gated surface reads.
 *
 * Reads the org's current Clerk billing plan via its feature flag, then
 * resolves it to a typed tier + the per-tier truck cap. The fleet sidebar
 * "+ Add Truck" button and the asset-creation dialog use this to soft-block
 * when the cap is reached and show an upgrade CTA.
 *
 * Plan ↔ feature ↔ truck cap mapping:
 *
 *   Owner Op  → feature `owner_op_tier` → 4 trucks ($99/mo)
 *   Growth    → feature `growth_tier`   → 9 trucks ($149/mo)
 *   Fleet     → feature `fleet_tier`    → 14 trucks ($199/mo)
 *
 * Orgs with NO tier feature are treated as `unrestricted` (Infinity cap).
 * That covers two cases:
 *   1. Grandfathered orgs from before billing shipped (e.g. Curzon).
 *      They keep working until manually moved to a plan.
 *   2. New signups mid-flight (between account creation and plan
 *      selection). Better to allow than to lock them out of the
 *      onboarding flow.
 *
 * Trial behavior: when an org is on the 14-day trial of a tier, Clerk
 * still exposes that tier's feature, so this hook returns the right cap.
 * Once the trial ends without conversion, the feature drops and the cap
 * disappears too (back to `unrestricted` unless we add a post-trial gate).
 *
 * Server-side defense: every endpoint that creates a truck must also call
 * a server-side equivalent of this check via Clerk's `has()` in the
 * middleware. UI gating is a UX nicety only.
 */

"use client";

import { useMemo } from "react";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { useCalendarStore } from "@/store/useCalendarStore";
import { isInternalOrg } from "@/lib/internalOrg";

export type OrgTier = "owner_op" | "growth" | "fleet" | "unrestricted" | "none";

/** Truck cap per tier. Bump these here if you renegotiate pricing — every
 *  consumer (UI banners, "+ Add" dialog) reads from the hook's return so
 *  no other file references the numbers. */
const TIER_TRUCK_CAP: Record<"owner_op" | "growth" | "fleet", number> = {
  owner_op: 4,
  growth:   9,
  fleet:    14,
};

/** Display labels used in upgrade banners + the tier chip. */
const TIER_LABEL: Record<OrgTier, string> = {
  owner_op:     "Owner Op",
  growth:       "Growth",
  fleet:        "Fleet",
  unrestricted: "Unrestricted",
  none:         "No active plan",
};

/** The Clerk feature key for each tier — matches what was created in the
 *  Clerk dashboard. Resolution order is highest → lowest tier so that an
 *  org which somehow has multiple features lands on the most permissive. */
const TIER_FEATURE_KEY: Record<"fleet" | "growth" | "owner_op", string> = {
  fleet:    "fleet_tier",
  growth:   "growth_tier",
  owner_op: "owner_op_tier",
};

export interface OrgTierApi {
  tier:          OrgTier;
  tierLabel:     string;
  /** Maximum trucks allowed. `Infinity` when `tier === "unrestricted"`. */
  maxTrucks:     number;
  /** Active (not retired) truck count. */
  currentTrucks: number;
  /** `currentTrucks >= maxTrucks`. UI should show an upgrade nag. */
  atLimit:       boolean;
  /** `currentTrucks > maxTrucks`. Happens after a downgrade — UI should
   *  show a "remove or upgrade" prompt and disable adding more. */
  overLimit:     boolean;
  /** True while Clerk is hydrating membership / billing features. */
  isLoading:     boolean;
}

export function useOrgTier(): OrgTierApi {
  const { has, isLoaded: authLoaded } = useAuth();
  const { organization, isLoaded: orgLoaded } = useOrganization();
  const assets = useCalendarStore((s) => s.assets);

  return useMemo<OrgTierApi>(() => {
    const isLoading = !authLoaded || !orgLoaded;
    const internal = isInternalOrg(organization?.id);

    // Resolve the tier — check fleet → growth → owner_op (highest first
    // so partial / overlapping feature grants degrade to the most
    // permissive).
    let tier: OrgTier = "none";
    let maxTrucks = 0;
    if (has) {
      if (has({ feature: TIER_FEATURE_KEY.fleet })) {
        tier = "fleet";
        maxTrucks = TIER_TRUCK_CAP.fleet;
      } else if (has({ feature: TIER_FEATURE_KEY.growth })) {
        tier = "growth";
        maxTrucks = TIER_TRUCK_CAP.growth;
      } else if (has({ feature: TIER_FEATURE_KEY.owner_op })) {
        tier = "owner_op";
        maxTrucks = TIER_TRUCK_CAP.owner_op;
      }
    }

    // Internal orgs (Curzon) without a paid tier are treated as
    // unrestricted — they're dogfooding orgs and shouldn't be forced
    // through a paywall during development.
    if (tier === "none" && internal) {
      tier = "unrestricted";
      maxTrucks = Infinity;
    }
    // Non-internal orgs with tier === "none" are BLOCKED by middleware
    // (redirected to /onboarding/pick-plan). The UI consumers still
    // need to know about this state to render upgrade banners cleanly.

    // Cap rule: count trucks where `activeTo` is null — i.e. not
    // retired. Deliberately ignoring `activeFrom`. Also excludes
    // optimistic (in-flight) assets — those have a negative
    // tempId from the store's addAsset action and haven't been
    // confirmed by the server yet. Counting them would cause a
    // momentary "capBlocked=true" flicker every time the user
    // adds a truck (8/9 → optimistic 9/9 → server 201 → real
    // 9/9), producing a visible banner flash even on the happy
    // path. We count only assets with a real (positive) id.
    //
    // The previous rule (isActiveOn with both bounds) was
    // over-engineered:
    //
    //  - It introduced a server/client tz disagreement window
    //    every night (server uses UTC `today`, client uses local
    //    `today`). At certain hours, the server would still see a
    //    truck retired earlier in the day as "active today" while
    //    the client showed it as inactive — same DB, two different
    //    counts. The user retires a truck, client says 8/9, server
    //    rejects with 9 of 9.
    //  - It didn't actually enforce the "max N active on the
    //    calendar at any point in time" rule anyway, because a
    //    new truck back-dated to Jan 1 silently creates a
    //    historical overlap window the cap check can't see.
    //  - It made the dispatcher's mental model worse, not better
    //    ("why is a truck I retired three days ago still counting
    //    against my limit if its retire date was last week?").
    //
    // The new rule reads exactly how a dispatcher would describe
    // it: "how many trucks do I currently have in service?" Retire
    // one, free a slot, immediately. No tz games, no calendar-
    // overlap arithmetic. Back-dating a truck for reporting is
    // orthogonal — it doesn't consume an extra seat retroactively
    // because the seat count is RIGHT-NOW only.
    //
    // The Unassigned row is a virtual asset the calendar adds for
    // unrouted events; not a real truck, doesn't burn a seat.
    const currentTrucks = assets.filter(a =>
      a.id > 0 &&                  // exclude optimistic/in-flight (tempId < 0)
      a.type !== 'Unassigned' &&
      a.name !== 'Unassigned' &&
      a.activeTo == null
    ).length;

    return {
      tier,
      tierLabel:     TIER_LABEL[tier],
      maxTrucks,
      currentTrucks,
      atLimit:       currentTrucks >= maxTrucks,
      overLimit:     currentTrucks >  maxTrucks,
      isLoading,
    };
  }, [authLoaded, orgLoaded, has, organization?.id, assets]);
}

/** Exposed for places (e.g. an UpgradeBanner component) that want to
 *  describe the next tier up from the current one. Returns null if the
 *  org is already on the highest tier or is unrestricted. */
export function nextTierUp(tier: OrgTier): OrgTier | null {
  if (tier === "owner_op")    return "growth";
  if (tier === "growth")      return "fleet";
  // unrestricted / fleet → no upsell from inside the app
  return null;
}
