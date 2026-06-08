/**
 * /create-organization — fallback for the org-less signed-in edge case.
 *
 * The happy-path onboarding funnel SKIPS this page entirely because
 * Clerk's <SignUp /> component already includes an internal "Set up
 * your organization" step (which renders inside our /sign-up page
 * layout). Going through /create-organization on top of that would
 * show the user a SECOND, identical-looking org-creation form.
 *
 * This page still exists for the case where middleware redirects a
 * signed-in user with no orgId — e.g. they deleted their org or
 * signed in via a partial-state session. In that case they need an
 * org before they can hit any private route.
 *
 * Happy-path funnel: /sign-up?plan=growth (with internal org-create step)
 *                    → /onboarding/pick-plan?plan=growth
 *                    → /calendar
 *
 * Fallback funnel:   /create-organization?plan=growth     ← THIS PAGE
 *                    → /onboarding/pick-plan?plan=growth
 *                    → /calendar
 */
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { CreateOrganization, SignOutButton } from '@clerk/nextjs';
import AuthNav from '@/components/marketing/AuthNav';
import { clerkAppearanceMarketing } from '@/lib/clerkAppearanceMarketing';

export default async function CreateOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  // Already in an org → no point showing a create-org form. Bounce.
  const { orgId } = await auth();
  if (orgId) redirect('/calendar');

  const params = await searchParams;
  const afterCreateOrganizationUrl = params.plan
    ? `/onboarding/pick-plan?plan=${encodeURIComponent(params.plan)}`
    : '/onboarding/pick-plan';

  return (
    <div
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{
        background: 'radial-gradient(ellipse 70% 80% at 50% 0%, #e8f0fe 0%, #fff 50%)',
      }}
    >
      <AuthNav
        escape={
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="font-display text-[14px] font-medium text-[#5f6368] hover:text-[#1967d2] transition-colors"
            >
              Sign out
            </button>
          </SignOutButton>
        }
      />
      <main className="mx-auto max-w-[520px] px-8 pt-14 pb-24">
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div
            className="font-mono"
            style={{
              fontSize:      12,
              fontWeight:    600,
              color:         '#1967d2',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              marginBottom:  12,
            }}
          >
            One last step
          </div>
          <h1
            className="font-display"
            style={{
              fontWeight:    800,
              fontSize:      'clamp(28px, 3.4vw, 38px)',
              lineHeight:    1.05,
              letterSpacing: '-0.022em',
              color:         '#202124',
              margin:        0,
            }}
          >
            Set up your fleet.
          </h1>
          <p
            style={{
              fontSize:   16,
              lineHeight: 1.55,
              color:      '#5f6368',
              maxWidth:   420,
              margin:     '12px auto 0',
            }}
          >
            Name your organization so dispatch knows whose calendar it is.
            You can rename it later.
          </p>
        </div>
        <CreateOrganization
          appearance={clerkAppearanceMarketing}
          afterCreateOrganizationUrl={afterCreateOrganizationUrl}
        />
      </main>
    </div>
  );
}
