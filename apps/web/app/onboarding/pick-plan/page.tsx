/**
 * /onboarding/pick-plan — post-org-creation plan selection.
 *
 * Insertion point: sign-up → create-organization → THIS PAGE → /calendar
 *
 * Without this step Clerk drops new users straight into the app with no
 * plan attached and no card on file, so they silently get the
 * "unrestricted" tier (the legacy/grandfathered code path in
 * useOrgTier). That's not what anyone signs up for — they came in via
 * a pricing CTA expecting to pay.
 *
 * This page:
 *   1. Reads the ?plan= param the marketing CTAs carry through the funnel
 *   2. Renders Clerk's <PricingTable for="organization" />, which now
 *      works (signed-in admin with an org) and surfaces real subscribe
 *      buttons that launch the Stripe checkout
 *
 * After Clerk completes the checkout the user returns here with their
 * plan active; the bottom CTA then routes them to /calendar.
 *
 * There is deliberately NO "skip / try without a card" path any more.
 * Every org picks a plan to start — the plan IS the truck cap, and the
 * 14-day trial runs per-plan (Clerk keeps exposing the plan's feature
 * during the trial, so useOrgTier resolves the right cap throughout).
 * An org with no plan resolves to tier 'none' → maxTrucks 0, which
 * makes POST /v1/assets reject the customer's very first truck. Only
 * "Sign out" leaves this page.
 *
 * Route protection: this route is PUBLIC in middleware, and middleware
 * does not enforce the chain — it has no org or tier check (both were
 * removed after they caused a crash; see middleware.ts). So a
 * determined user can navigate straight to /calendar without a plan.
 * EmptyFleetState catches that case and routes them back here rather
 * than letting them hit an unexplained 402.
 */
import Link from 'next/link';
import { PricingTable, SignOutButton } from '@clerk/nextjs';

const PLAN_LABELS: Record<string, string> = {
  owner_op: 'Owner Op',
  growth:   'Growth',
  fleet:    'Fleet',
};

export default async function PickPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; period?: string }>;
}) {
  const params = await searchParams;
  const chosenLabel = params.plan ? PLAN_LABELS[params.plan] : null;
  // Period reaches us as the customer's marketing-page choice. Clerk's
  // PricingTable doesn't accept a default-period prop today, so we
  // surface it as an explicit reminder above the table — the customer
  // sees their pick echoed back and just needs to confirm the matching
  // toggle on the Clerk PricingTable below.
  const annual = params.period === 'annual';

  return (
    <div className="h-full overflow-y-auto font-sys text-sys-primary bg-sys-bg">
      <nav className="h-16 bg-sys-bg border-b border-sys-line">
        <div className="h-full max-w-6xl mx-auto px-8 md:px-12 flex items-center justify-between">
          <Link href="/" className="font-mono font-bold text-[15px] uppercase" style={{ letterSpacing: '0.2em' }}>
            <span className="text-sys-blue">FLEET</span>
            <span className="text-sys-orange">CAL</span>
          </Link>
          <div className="flex items-center gap-6">
            <div className="hidden md:block font-mono text-[11px] uppercase text-sys-muted" style={{ letterSpacing: '0.12em' }}>
              Step 3 of 3 · Pick a plan
            </div>
            {/* Escape hatch — user is mid-funnel but not trapped. They can
                sign out and bounce back to the marketing landing any time. */}
            <SignOutButton redirectUrl="/">
              <button
                type="button"
                className="font-sys font-medium text-[13px] text-sys-muted hover:text-sys-primary transition-colors"
              >
                Sign out
              </button>
            </SignOutButton>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-8 md:px-12 py-16 md:py-24">
        <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-6" style={{ letterSpacing: '0.12em' }}>
          One last step
        </div>

        <h1 className="font-display text-[44px] md:text-[56px] leading-[1.05] tracking-tight mb-6 max-w-3xl">
          {chosenLabel ? (
            <>
              Confirm your{' '}
              <span className="text-sys-blue">{chosenLabel}</span> plan.
            </>
          ) : (
            <>Pick the plan that fits <span className="text-sys-blue">your fleet.</span></>
          )}
        </h1>

        <p className="font-sys text-[16px] md:text-[17px] leading-[1.6] text-sys-muted mb-8 max-w-2xl">
          14-day free trial on every plan. You won&apos;t be charged until day 15
          and you can cancel any time before then. We require a card up front
          to ensure uninterrupted service when your trial ends.
        </p>

        {params.period && (
          <div className="mb-10 inline-flex items-center gap-3 px-4 py-2.5 bg-sys-blue-light border border-sys-blue rounded-lg">
            <span className="font-mono font-bold text-[11px] uppercase text-sys-blue" style={{ letterSpacing: '0.12em' }}>
              You picked
            </span>
            <span className="font-sys text-[14px] font-semibold text-sys-primary">
              {annual ? 'Annual billing · save up to 20%' : 'Monthly billing'}
            </span>
            <span className="font-sys text-[13px] text-sys-muted">
              · pick the matching toggle below ↓
            </span>
          </div>
        )}

        {/* Clerk's PricingTable handles the actual checkout. Now that the
            user is signed in + has an org, the Subscribe buttons surface
            and route to Stripe. Appearance comes from global
            clerkAppearance config via <ClerkProvider>. The period choice
            from the marketing surface is shown above as a reminder —
            Clerk's PricingTable doesn't accept a default-period prop, so
            the customer needs to manually pick the matching toggle. */}
        <PricingTable for="organization" />
      </main>
    </div>
  );
}
