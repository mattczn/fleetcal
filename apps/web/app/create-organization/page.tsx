/**
 * /create-organization — step 2 of the onboarding funnel.
 *
 * Reached after sign-up (and via middleware redirect for signed-in
 * users without an org). Threads the ?plan= param onward to
 * /onboarding/pick-plan so the marketing-CTA plan choice survives the
 * full funnel:
 *
 *   /sign-up?plan=growth
 *     → /create-organization?plan=growth     ← THIS PAGE
 *     → /onboarding/pick-plan?plan=growth
 *     → /calendar
 */
import { CreateOrganization } from '@clerk/nextjs';

export default async function CreateOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
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
