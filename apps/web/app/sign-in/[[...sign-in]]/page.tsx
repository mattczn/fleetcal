/**
 * /sign-in — auth state aware.
 *
 * Signed-in users get bounced to wherever Clerk's afterSignInUrl points
 * (typically /calendar) instead of re-rendering a sign-in form they
 * don't need. Eliminates the "I'm already signed in but this page is
 * showing me a sign-in form" weird state.
 *
 * Signed-out users see the form.
 */
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignIn } from '@clerk/nextjs';

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) redirect('/calendar');

  return (
    <div className="flex h-full items-center justify-center">
      <SignIn />
    </div>
  );
}
