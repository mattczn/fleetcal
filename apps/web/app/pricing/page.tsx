/**
 * /pricing — Clerk billing PricingTable for the 3 FleetCal tiers.
 *
 * Clerk renders the table dynamically based on the Production-instance
 * billing plans (Owner Op $99, Growth $149, Fleet $199). Plan changes in
 * Clerk's dashboard reflect here automatically — no redeploy needed.
 *
 * Auth state:
 *   - Signed-in admins see "Subscribe" / "Switch plan" buttons that go
 *     through Clerk's Stripe checkout flow.
 *   - Signed-in dispatchers see the table but the action button is
 *     hidden because Clerk's billing UI gates org-admin-only actions.
 *   - Anonymous visitors see the table; the action button routes them to
 *     sign-up first.
 *
 * Route protection: PUBLIC — pricing must be visible without auth so
 * prospective customers can compare tiers before signing up. The
 * middleware in middleware.ts should NOT add this path to the
 * protected matcher.
 */
import { PricingTable } from '@clerk/nextjs';

export default function PricingPage() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--gc-bg)' }}>
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-extrabold tracking-tight" style={{ color: 'var(--gc-text-1)' }}>
            Pick a plan
          </h1>
          <p className="mt-3 text-lg" style={{ color: 'var(--gc-text-2)' }}>
            Every plan starts with a 14-day free trial. No credit card to start.
          </p>
        </div>

        {/* for="organization": required for B2B plans. Without it the
            table defaults to user-scoped (B2C) plans and finds nothing,
            since you created org plans in the Clerk dashboard. */}
        <PricingTable for="organization" />

        <div className="mt-16 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
          Running a fleet larger than 14 trucks?{' '}
          <a
            href="mailto:sales@fleetcal.app?subject=Enterprise%20inquiry"
            className="font-semibold underline"
            style={{ color: 'var(--gc-blue)' }}
          >
            Contact sales →
          </a>
        </div>
      </div>
    </div>
  );
}
