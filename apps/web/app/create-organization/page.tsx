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
import { CreateOrganization } from '@clerk/nextjs';

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
    <div className="flex h-full items-center justify-center">
      <CreateOrganization afterCreateOrganizationUrl={afterCreateOrganizationUrl} />
    </div>
  );
}
