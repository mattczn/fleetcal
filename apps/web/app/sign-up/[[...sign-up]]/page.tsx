/**
 * /sign-up — 2-column conversion page (Google Workspace look).
 *
 * Left rail: marketing copy in Figtree + Hanken (eyebrow, accent-blue
 * headline, check-bullet feature list, founder trust line, footer
 * "built by carriers" block). Right rail: Clerk's <SignUp /> form
 * restyled via `clerkAppearanceMarketing` (Hanken inputs, pill primary
 * CTA, soft elevation card).
 *
 * When the user arrives via a pricing-card CTA (e.g. /sign-up?plan=growth),
 * a chip above the headline confirms their plan choice. Plan selection
 * itself happens server-side after sign-up (separate post-signup hook
 * to be wired later) — for now the chip is purely visual reassurance
 * that their click landed.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignUp, SignOutButton } from '@clerk/nextjs';
import { Check } from 'lucide-react';
import AuthNav from '@/components/marketing/AuthNav';
import { clerkAppearanceMarketing } from '@/lib/clerkAppearanceMarketing';

type PlanKey = 'owner_op' | 'growth' | 'fleet';
const PLAN_META: Record<PlanKey, { name: string; price: number; trucks: string }> = {
  owner_op: { name: 'Owner Op', price: 99,  trucks: '1–4 trucks'   },
  growth:   { name: 'Growth',   price: 149, trucks: '5–9 trucks'   },
  fleet:    { name: 'Fleet',    price: 199, trucks: '10–14 trucks' },
};

const BULLETS = [
  'AI rate-con parser — drop a PDF, get a load.',
  'Dispatch calendar, payroll, and invoicing in one app.',
  '14-day free trial. Cancel any time before billing.',
];

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; period?: string }>;
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
  // Thread both ?plan= and ?period= through to the next step so the
  // pricing-card choice survives the funnel. Period accepts 'monthly'
  // or 'annual'; anything else is ignored.
  const afterSignUpUrl = (() => {
    const next = new URLSearchParams();
    if (params.plan)                                next.set('plan', params.plan);
    if (params.period === 'annual' || params.period === 'monthly') next.set('period', params.period);
    const query = next.toString();
    return query ? `/onboarding/pick-plan?${query}` : '/onboarding/pick-plan';
  })();

  return (
    <div
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{
        background: 'radial-gradient(ellipse 60% 70% at 85% 0%, #e8f0fe 0%, #fff 55%)',
      }}
    >
      <AuthNav
        escape={
          partiallySignedIn ? (
            <SignOutButton redirectUrl="/">
              <button
                type="button"
                className="font-display text-[14px] font-medium text-[#5f6368] hover:text-[#1967d2] transition-colors"
              >
                Sign out
              </button>
            </SignOutButton>
          ) : (
            <Link
              href="/sign-in"
              className="text-[14px] font-medium text-[#5f6368] hover:text-[#1967d2] transition-colors"
            >
              Already have an account?{' '}
              <span style={{ color: '#1967d2', fontWeight: 600 }}>Sign in</span>
            </Link>
          )
        }
      />

      <main className="mx-auto max-w-[1160px] px-8 pt-14 pb-24">
        <div
          className="grid gap-12 md:gap-20 items-start"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 480px)' }}
        >
          {/* LEFT — marketing copy */}
          <div>
            {plan && (
              <div
                className="inline-flex items-center gap-3 mb-7 font-display"
                style={{
                  padding:      '7px 14px',
                  borderRadius: 999,
                  background:   '#e8f0fe',
                  border:       '1px solid #c2dafa',
                }}
              >
                <span
                  className="font-mono"
                  style={{
                    fontSize:      11,
                    fontWeight:    700,
                    color:         '#1967d2',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                  }}
                >
                  {plan.name} plan
                </span>
                <span style={{ fontSize: 13, color: '#202124' }}>
                  ${plan.price}/mo · {plan.trucks}
                </span>
              </div>
            )}

            <div
              className="font-mono"
              style={{
                fontSize:      12,
                fontWeight:    600,
                color:         '#1967d2',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                marginBottom:  14,
              }}
            >
              Start your free trial
            </div>

            <h1
              className="font-display"
              style={{
                fontWeight:    800,
                fontSize:      'clamp(36px, 4.6vw, 54px)',
                lineHeight:    1.05,
                letterSpacing: '-0.022em',
                color:         '#202124',
                margin:        0,
              }}
            >
              Run dispatch like a{' '}
              <span style={{ color: 'var(--gc-blue)' }}>real software company.</span>
            </h1>

            <p
              style={{
                fontSize:   17.5,
                lineHeight: 1.6,
                color:      '#5f6368',
                maxWidth:   480,
                margin:     '20px 0 0',
              }}
            >
              FleetCal turns rate-cons into invoices in one screen. Built by a carrier,
              for carriers.
            </p>

            <ul style={{ marginTop: 28, marginBottom: 32, padding: 0, listStyle: 'none', display: 'grid', gap: 14 }}>
              {BULLETS.map(b => (
                <li
                  key={b}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 12, fontSize: 15, lineHeight: 1.55, color: '#202124' }}
                >
                  <span
                    style={{
                      flex:         'none',
                      width:        22,
                      height:       22,
                      borderRadius: 999,
                      background:   '#e6f4ea',
                      display:      'grid',
                      placeItems:   'center',
                      marginTop:    1,
                    }}
                  >
                    <Check size={13} strokeWidth={3} style={{ color: '#1e8e3e' }} />
                  </span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <div style={{ paddingTop: 28, borderTop: '1px solid #e8eaed' }}>
              <div
                className="font-mono"
                style={{
                  fontSize:      11,
                  fontWeight:    600,
                  color:         '#5f6368',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  marginBottom:  8,
                }}
              >
                Built by carriers
              </div>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: '#5f6368' }}>
                FleetCal is built by a carrier, for carriers. No ELD lock-in.
                No per-driver fees.
              </p>
            </div>
          </div>

          {/* RIGHT — Clerk's SignUp form, restyled via marketing appearance. */}
          <div>
            <SignUp
              appearance={clerkAppearanceMarketing}
              forceRedirectUrl={afterSignUpUrl}
              fallbackRedirectUrl={afterSignUpUrl}
            />
            {/* Legal consent line — carriers reviewing 10DLC registrations
                want to see Terms + Privacy referenced at the point of
                account creation, even though Clerk's own UI hides this
                inside its flow. */}
            <p style={{
              fontSize:   12,
              lineHeight: 1.6,
              color:      '#5f6368',
              textAlign:  'center',
              marginTop:  16,
              maxWidth:   380,
              marginLeft: 'auto',
              marginRight:'auto',
            }}>
              By creating an account, you agree to FleetCal&rsquo;s{' '}
              <a href="/terms" style={{ color: '#1558d6', textDecoration: 'underline' }}>Terms of Service</a>{' '}
              and{' '}
              <a href="/privacy" style={{ color: '#1558d6', textDecoration: 'underline' }}>Privacy Policy</a>,
              including consent to receive transactional SMS related to your account and dispatch operations.
              Message and data rates may apply. Reply STOP to opt out.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function isPlanKey(v: unknown): v is PlanKey {
  return v === 'owner_op' || v === 'growth' || v === 'fleet';
}
