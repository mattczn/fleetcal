/**
 * clerkMiddleware on the Node.js runtime to avoid Vercel edge-on-lambda.
 *
 * Background — 2026-06-15 outage:
 *   Vercel migrated this project's middleware to the `edge-on-lambda`
 *   runtime, where response Headers are immutable. Clerk's bundled
 *   middleware does `targetHeaders.append(...)` inside `Headers.forEach`
 *   when merging Clerk-handshake response headers onto the outgoing
 *   response → `TypeError: immutable` → every authenticated request
 *   crashed with MIDDLEWARE_INVOCATION_FAILED. Symptoms were "random"
 *   per-user because Vercel was mid-cohort rollout.
 *
 * Fix: pin middleware to the Node.js runtime via `runtime: 'nodejs'`
 * in the config below. On Node.js, undici/Headers from fetch() are
 * mutable, so Clerk's append-during-forEach succeeds — same behavior
 * we had on classic Edge before the Vercel migration. We keep the
 * full clerkMiddleware so token rotation, session sync, and the
 * server-side auth() context work exactly as before.
 *
 * Note: Node.js runtime middleware has slightly higher cold-start than
 * Edge, but it avoids the platform crash and preserves Clerk's
 * complete session machinery — much higher value than a few ms.
 *
 * Public routes pass through unauthenticated. Everything else requires
 * a Clerk session; failing that, we redirect to /sign-in. The
 * try/catch around auth() is a last-resort net so a Clerk-side hiccup
 * never returns 500 from middleware.
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
  '/contact-sales(.*)',
  '/onboarding(.*)',
  '/privacy(.*)',
  '/terms(.*)',
  '/sms-consent(.*)',
  '/api/sms/opt-in',
])

export default clerkMiddleware(async (auth, request) => {
  if (isPublicRoute(request)) return

  try {
    const { userId } = await auth()
    if (!userId) {
      return Response.redirect(new URL('/sign-in', request.url))
    }
  } catch (err) {
    console.error('[middleware] auth check failed, allowing through:', err)
  }
})

// Matcher excludes static assets so Vercel's CDN serves them directly
// without our middleware running. Media extensions (mp4, webm, mp3,
// etc.) MUST be in this list — otherwise a <video src="/foo.mp4">
// request hits the middleware, fails Clerk's auth check, and returns
// 500 to the browser. The video plays fine when fetched directly via
// URL (different cache path) but breaks when the page embeds it.
//
// runtime: 'nodejs' pins this middleware off Vercel's edge-on-lambda
// runtime (where Headers are immutable and Clerk's merge crashes).
// See the file-level comment for the full incident writeup.
export const config = {
  runtime: 'nodejs',
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|m?js(?!on)|jinja2|txt|xml|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf|mp4|m4v|webm|ogg|ogv|mp3|m4a|wav)).*)',
    '/(api|trpc)(.*)',
  ],
}
