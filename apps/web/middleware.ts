/**
 * Minimal middleware — protect non-public routes only.
 *
 * REGRESSED from the tier-check version because that was 500'ing for
 * every user including team members. Priority: get the site back up.
 * Tier enforcement will be re-added in a follow-up after verifying the
 * Clerk-side calls work without crashing in production.
 *
 * Current behavior:
 *   - Public routes (/, /sign-in, /sign-up, /create-organization,
 *     /pricing, /onboarding) → no auth required, pass through.
 *   - Everything else → require userId; redirect to /sign-in if absent.
 *   - All Clerk-side calls wrapped in try/catch and fall through on
 *     error — middleware NEVER 500s.
 *
 * Notes:
 *   - No tier check (was the source of the crash).
 *   - No org check (relied on the same code path).
 *   - Client-side guards in AppShell / page components still enforce
 *     useOrgTier limits at the UI level.
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
  '/onboarding(.*)',
  '/privacy(.*)',
  '/terms(.*)',
])

export default clerkMiddleware(async (auth, request) => {
  if (isPublicRoute(request)) return

  try {
    const { userId } = await auth()
    if (!userId) {
      return Response.redirect(new URL('/sign-in', request.url))
    }
  } catch (err) {
    // Last-resort net. Anything thrown by Clerk's auth() falls through
    // to the page, which will re-attempt auth on the client. We log so
    // Vercel function logs surface the cause.
    console.error('[middleware] auth check failed, allowing through:', err)
  }
})

// Matcher excludes static assets so Vercel's CDN serves them directly
// without our middleware running. Media extensions (mp4, webm, mp3,
// etc.) MUST be in this list — otherwise a <video src="/foo.mp4">
// request hits the middleware, fails Clerk's auth check, and returns
// 500 to the browser. The video plays fine when fetched directly via
// URL (different cache path) but breaks when the page embeds it.
export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|m?js(?!on)|jinja2|txt|xml|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf|mp4|m4v|webm|ogg|ogv|mp3|m4a|wav)).*)',
    '/(api|trpc)(.*)',
  ],
}
