'use client';

/**
 * First-run state for an org with no trucks yet.
 *
 * Replaces the demo-data tour (TourOverlay → ReadyScreen → SetupWizard)
 * that used to fire for asset-less orgs. Onboarding is a scheduled call
 * for now, so seeding fake trucks and then asking the customer to clear
 * them was work in both directions — they saw a fleet that wasn't
 * theirs, then had to dismiss it before doing the one thing that
 * actually matters. An empty calendar with a single obvious action is
 * a better starting point for someone being walked through it live.
 *
 * The onboarding components are still on disk, just unmounted — same
 * convention as the TodaysTray removal noted in calendar/page.tsx.
 *
 * Two states:
 *
 *   - Normal: "Add your first truck" opens the trucks directory, which
 *     already surfaces tier-cap errors properly (AssetsModal catches
 *     `tier_cap_exceeded` and shows a banner).
 *   - No plan: POST /v1/assets rejects at maxTrucks 0 for an org with
 *     no resolvable subscription, so offering "add a truck" would dead-
 *     end. Point at plan selection instead. This shouldn't happen —
 *     every org picks a plan to start, and Clerk exposes the plan's
 *     feature during the 14-day trial so the cap resolves normally —
 *     but a customer who abandons /onboarding/pick-plan and navigates
 *     straight here would otherwise hit a 402 with no explanation.
 *
 * Either way there's a "book a setup call" link, so a self-serve signup
 * who never talked to anyone has a way to reach a human.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarPlus, Headset, Truck } from 'lucide-react';
import DirectoryModal from '@/components/sidebar/DirectoryModal';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useOrgTier } from '@/lib/useOrgTier';

export default function EmptyFleetState() {
  const assets = useCalendarStore(s => s.assets);
  const { tier, isLoading: tierLoading } = useOrgTier();
  const [directoryOpen, setDirectoryOpen] = useState(false);

  // The calendar injects a virtual "Unassigned" column for unrouted
  // events — it isn't a truck, and an org that has only that one still
  // has an empty fleet. Matches the exclusion useOrgTier and the
  // server-side cap count both use.
  const realAssetCount = useMemo(
    () => assets.filter(a => a.type !== 'Unassigned' && a.name !== 'Unassigned').length,
    [assets],
  );

  if (realAssetCount > 0) return null;

  // Don't guess while Clerk is still resolving billing — showing the
  // "pick a plan" variant to a paying customer for one frame would be
  // worse than waiting a beat for the right copy.
  const needsPlan = !tierLoading && tier === 'none';

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-12">
      <div className="flex flex-col items-center text-center" style={{ maxWidth: 460 }}>
        <div
          className="flex items-center justify-center rounded-2xl mb-5"
          style={{ width: 64, height: 64, background: 'var(--gc-blue-light)' }}>
          <Truck size={28} style={{ color: 'var(--gc-blue)' }} />
        </div>

        <h2 className="text-[22px] font-bold mb-2" style={{ color: 'var(--gc-text-1)' }}>
          {needsPlan ? 'Choose a plan to get started' : 'Add your first truck'}
        </h2>

        <p className="text-[14px] leading-relaxed mb-6" style={{ color: 'var(--gc-text-2)' }}>
          {needsPlan
            ? 'Your plan sets how many trucks you can run. Pick one to start your 14-day trial, then add your fleet.'
            : 'Your calendar has a column per truck. Add one to start scheduling loads — you can rename, recolor, and reorder them any time.'}
        </p>

        <div className="flex flex-col gap-2.5 w-full" style={{ maxWidth: 300 }}>
          {needsPlan ? (
            <Link
              href="/onboarding/pick-plan"
              className="w-full py-2.5 rounded-xl text-[14.5px] font-semibold text-white inline-flex items-center justify-center gap-2"
              style={{ background: 'var(--gc-blue)' }}>
              <CalendarPlus size={16} />
              Choose a plan
            </Link>
          ) : (
            <button
              onClick={() => setDirectoryOpen(true)}
              className="w-full py-2.5 rounded-xl text-[14.5px] font-semibold text-white inline-flex items-center justify-center gap-2"
              style={{ background: 'var(--gc-blue)', border: 'none', cursor: 'pointer' }}>
              <CalendarPlus size={16} />
              Add your first truck
            </button>
          )}

          {/* Self-serve signups may never have spoken to anyone. Give
              them a route to a human rather than leaving setup to
              guesswork. */}
          <Link
            href="/support"
            className="w-full py-2.5 rounded-xl text-[13.5px] font-medium inline-flex items-center justify-center gap-2"
            style={{
              border: '1px solid var(--gc-border)',
              color: 'var(--gc-text-2)',
              background: 'transparent',
            }}>
            <Headset size={15} />
            Book a setup call
          </Link>
        </div>

        <p className="text-[12px] mt-4" style={{ color: 'var(--gc-text-3)' }}>
          Prefer a walkthrough? We&apos;ll get you set up in about 30 minutes.
        </p>
      </div>

      {directoryOpen && (
        <DirectoryModal initial="trucks" onClose={() => setDirectoryOpen(false)} />
      )}
    </div>
  );
}
