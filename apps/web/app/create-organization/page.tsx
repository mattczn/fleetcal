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
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { CreateOrganization, SignOutButton } from '@clerk/nextjs';

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
    <div className="h-full overflow-y-auto font-sys text-sys-primary bg-sys-bg">
      {/* Same nav pattern as /sign-up and /onboarding/pick-plan so the
          user has a consistent escape hatch — logo back to landing,
          sign-out button to bail entirely. Without this, this page was
          a centered modal with zero navigation, and any user who
          landed here via the middleware fallback was effectively
          trapped. */}
      <nav className="sticky top-0 z-50 h-16 bg-sys-bg border-b border-sys-line">
        <div className="h-full max-w-6xl mx-auto px-8 md:px-12 flex items-center justify-between">
          <Link href="/" className="font-mono font-bold text-[15px] uppercase" style={{ letterSpacing: '0.2em' }}>
            <span className="text-sys-blue">FLEET</span>
            <span className="text-sys-orange">CAL</span>
          </Link>
          <SignOutButton redirectUrl="/">
            <button
              type="button"
              className="font-sys font-medium text-[13px] text-sys-muted hover:text-sys-primary transition-colors"
            >
              Cancel &amp; sign out
            </button>
          </SignOutButton>
        </div>
      </nav>

      <main className="flex items-center justify-center py-16 md:py-24">
        <CreateOrganization afterCreateOrganizationUrl={afterCreateOrganizationUrl} />
      </main>
    </div>
  );
}
