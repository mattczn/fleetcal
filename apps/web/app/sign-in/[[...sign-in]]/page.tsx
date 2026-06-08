/**
 * /sign-in — auth state aware.
 *
 * Signed-in users get bounced to wherever Clerk's afterSignInUrl points
 * (typically /calendar) instead of re-rendering a sign-in form they
 * don't need. Eliminates the "I'm already signed in but this page is
 * showing me a sign-in form" weird state.
 *
 * Visual: Marketing-style nav + soft blue radial background, Clerk
 * form centered in a max-width container. Clerk's appearance comes
 * from `clerkAppearanceMarketing` so the form picks up Figtree /
 * Hanken / pill buttons matching the rest of the marketing surface.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignIn } from '@clerk/nextjs';
import AuthNav from '@/components/marketing/AuthNav';
import { clerkAppearanceMarketing } from '@/lib/clerkAppearanceMarketing';

export default async function SignInPage() {
  const { userId } = await auth();
  if (userId) redirect('/calendar');

  return (
    <div
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{
        background: 'radial-gradient(ellipse 70% 80% at 50% 0%, #e8f0fe 0%, #fff 50%)',
      }}
    >
      <AuthNav
        escape={
          <Link
            href="/sign-up"
            className="text-[14px] font-medium text-[#5f6368] hover:text-[#1967d2] transition-colors"
          >
            New here? <span style={{ color: '#1967d2', fontWeight: 600 }}>Start free trial</span>
          </Link>
        }
      />
      <main className="mx-auto max-w-[440px] px-8 pt-16 pb-24">
        <SignIn appearance={clerkAppearanceMarketing} />
      </main>
    </div>
  );
}
