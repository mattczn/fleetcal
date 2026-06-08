/**
 * /sign-up — Zapier-style 2-column conversion page.
 *
 * Left rail: Systematica-style marketing copy (eyebrow, serif headline,
 * checkmark feature list, founder trust line). Right rail: Clerk's
 * <SignUp /> form, restyled via the appearance API to match the
 * zero-radius / DM Sans aesthetic.
 *
 * When the user arrives via a pricing-card CTA (e.g. /sign-up?plan=growth),
 * we surface a chip above the headline confirming their plan choice.
 * Plan selection itself happens server-side after sign-up (separate
 * post-signup hook to be wired later) — for now the chip is purely
 * visual reassurance that their click landed.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignUp, SignOutButton } from '@clerk/nextjs';
import { Check } from 'lucide-react';

type PlanKey = 'owner_op' | 'growth' | 'fleet';
const PLAN_META: Record<PlanKey, { name: string; price: number; trucks: string }> = {
  owner_op: { name: 'Owner Op', price: 99,  trucks: '1–4 trucks'   },
  growth:   { name: 'Growth',   price: 149, trucks: '5–9 trucks'   },
  fleet:    { name: 'Fleet',    price: 199, trucks: '10–14 trucks' },
};

const BULLETS = [
  'AI rate-con parser — drop a PDF, get a load.',
  'Dispatch calendar, payroll, and invoicing in one app.',
  '14-day free trial. No credit card.',
];

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const params = await searchParams;

  // Already signed in + has an org → they're past the sign-up funnel,
  // send them straight to the dashboard. Avoids dead-state pages.
  const { userId, orgId } = await auth();
  if (userId && orgId) redirect('/calendar');
  // Signed in but no org → SignUp's internal create-org step will fire;
  // that's the expected branch. We show the Sign-out escape in the nav
  // (instead of "Already have an account?") so they can back out cleanly
  // mid-flow without being trapped on /sign-up/tasks/choose-organization.
  const partiallySignedIn = !!userId;

  const plan = isPlanKey(params.plan) ? PLAN_META[params.plan] : null;
  // Funnel chain: sign-up → /onboarding/pick-plan?plan=…
  //
  // We intentionally SKIP /create-organization on the SignUp happy path
  // because Clerk's <SignUp /> component already includes an internal
  // "Set up your organization" step after email/password capture (it
  // renders inside this same /sign-up page so it picks up our marketing
  // wrapper). By the time the user reaches afterSignUpUrl they already
  // have an org. Routing through /create-organization would render a
  // SECOND, identical-looking org-creation form on top of the first.
  //
  // The /create-organization route still exists as a fallback for the
  // middleware-redirect case (signed-in user with no org somehow), but
  // the SignUp funnel never touches it.
  const afterSignUpUrl = params.plan
    ? `/onboarding/pick-plan?plan=${encodeURIComponent(params.plan)}`
    : '/onboarding/pick-plan';

  return (
    <div className="h-full overflow-y-auto font-sys text-sys-primary bg-sys-bg">
      {/* Sticky nav — wordmark + auth-aware escape. The Sign out
          button below appears once the user is partially signed in
          (e.g. after Google OAuth but before they finish the in-SignUp
          org-creation step) so they can bail without being trapped on
          /sign-up/tasks/choose-organization. */}
      <nav className="sticky top-0 z-50 h-16 bg-sys-bg border-b border-sys-line">
        <div className="h-full max-w-6xl mx-auto px-8 md:px-12 flex items-center justify-between">
          <Link href="/" className="font-mono font-bold text-[15px] uppercase" style={{ letterSpacing: '0.2em' }}>
            <span className="text-sys-blue">FLEET</span>
            <span className="text-sys-orange">CAL</span>
          </Link>
          {/* Primary escape — single, obvious "back to home" link. The
              partially-signed-in user wants OUT of the flow; whether
              they keep their Clerk session is irrelevant to that
              decision. If they want to resume later they just visit
              /sign-up again. */}
          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="font-sys font-medium text-[13px] text-sys-muted hover:text-sys-primary transition-colors"
            >
              ← Back to home
            </Link>
            {partiallySignedIn ? (
              <SignOutButton redirectUrl="/">
                <button
                  type="button"
                  className="font-sys text-[12px] text-sys-muted hover:text-sys-primary transition-colors"
                >
                  Sign out
                </button>
              </SignOutButton>
            ) : (
              <Link
                href="/sign-in"
                className="hidden md:inline font-sys text-[12px] text-sys-muted hover:text-sys-primary transition-colors"
              >
                Already have an account? <span className="text-sys-blue font-semibold">Sign in</span>
              </Link>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-8 md:px-12 py-16 md:py-24">
        <div className="grid md:grid-cols-2 gap-12 md:gap-20 items-start">

          {/* LEFT — marketing copy */}
          <div>
            {plan && (
              <div className="inline-flex items-center gap-3 mb-8 px-4 py-2 bg-sys-blue-light border border-sys-blue" style={{ borderRadius: 0 }}>
                <span className="font-mono font-bold text-[11px] uppercase text-sys-blue" style={{ letterSpacing: '0.12em' }}>
                  {plan.name} plan
                </span>
                <span className="font-sys text-[13px] text-sys-primary">
                  ${plan.price}/mo · {plan.trucks}
                </span>
              </div>
            )}

            <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-6" style={{ letterSpacing: '0.12em' }}>
              Start your free trial
            </div>

            <h1 className="font-display text-[44px] md:text-[56px] leading-[1.05] tracking-tight mb-8">
              Run dispatch like a{' '}
              <span className="text-sys-blue">real software company.</span>
            </h1>

            <p className="font-sys text-[16px] md:text-[17px] leading-[1.6] text-sys-muted mb-10 max-w-lg">
              FleetCal turns rate-cons into invoices in one screen. Built and
              used daily at <strong className="text-sys-primary font-semibold">Curzon Trucking</strong>,
              a 13-truck reefer carrier.
            </p>

            <ul className="space-y-4 mb-10">
              {BULLETS.map((b) => (
                <li key={b} className="flex items-start gap-3 font-sys text-[15px] leading-[1.5]">
                  <span
                    className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 mt-0.5 bg-sys-orange text-white"
                    style={{ borderRadius: 0 }}
                  >
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <div className="pt-8 border-t border-sys-line">
              <div className="font-mono text-[11px] uppercase text-sys-muted mb-2" style={{ letterSpacing: '0.12em' }}>
                Built by carriers
              </div>
              <p className="font-sys text-[13px] text-sys-muted leading-relaxed">
                FleetCal is built by a 13-truck fleet owner, for fleets like yours.
                No ELD lock-in. No per-driver fees.
              </p>
            </div>
          </div>

          {/* RIGHT — Clerk's SignUp form, restyled */}
          <div>
            {/* Appearance comes from the global clerkAppearance via
                <ClerkProvider> in layout.tsx — applies FleetCal/Google-
                style tokens to every Clerk component including this one. */}
            <SignUp
              forceRedirectUrl={afterSignUpUrl}
              fallbackRedirectUrl={afterSignUpUrl}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

function isPlanKey(v: unknown): v is PlanKey {
  return v === 'owner_op' || v === 'growth' || v === 'fleet';
}
