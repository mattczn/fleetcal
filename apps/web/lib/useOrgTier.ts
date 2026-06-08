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
import { isActiveOn, dateKeyOf } from "@/lib/lifecycle";

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

    // Count trucks ACTIVE AS OF TODAY — uses the same isActiveOn
    // predicate the calendar grid does, so this number matches what
    // the dispatcher actually sees on the schedule. A truck retired
    // with activeTo = today is ACTIVE today (last day of service)
    // and DOES count; one retired yesterday doesn't. Same for
    // activeFrom — a future-start truck (e.g. scheduled to onboard
    // next week) doesn't consume a seat until it goes live.
    //
    // The Unassigned row is a virtual asset the calendar adds to
    // surface unrouted events as their own column — it's a UI
    // affordance, not a truck. EXCLUDE it from the cap so a
    // dispatcher's Unassigned column doesn't burn a paid seat.
    //
    // Customers can keep ANY number of retired/future-scheduled
    // trucks as history without consuming paid capacity — only the
    // instantaneous active count matters.
    const today = dateKeyOf(new Date());
    const currentTrucks = assets.filter(a =>
      a.type !== 'Unassigned' &&
      a.name !== 'Unassigned' &&
      isActiveOn(a, today)
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
