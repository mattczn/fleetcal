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
 * 2026-06-15 incident note:
 *   Vercel's edge-on-lambda runtime rollout triggers Clerk's bundled
 *   middleware to crash with `TypeError: immutable` on Headers.append.
 *   Cookie-presence-only middleware was tried as an escape, but every
 *   Next.js API route uses `auth()` from `@clerk/nextjs/server` which
 *   requires clerkMiddleware to have run — removing it broke API
 *   routes worse than the partial page crashes. Restored.
 *
 * 2026-06-22 update:
 *   Bumped @clerk/nextjs 7.3.0 → 7.5.7 (latest stable). Outer wrap
 *   below now returns a JSON 503 for /api/* paths if Clerk still
 *   crashes, rather than redirecting to /sign-in — the dispatcher
 *   web's fetch() to /api/driver-push was getting Status 0 / no body
 *   because the redirect made no sense for an API consumer.
 *
 * Notes:
 *   - No tier check (was the source of the crash).
 *   - No org check (relied on the same code path).
 *   - Client-side guards in AppShell / page components still enforce
 *     useOrgTier limits at the UI level.
 */
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import type { NextRequest, NextFetchEvent } from 'next/server'

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
  '/product/payroll(.*)',
  '/product/dashboard(.*)',
  '/product/paperwork(.*)',
  '/product/billing(.*)',
  '/product/calendar(.*)',
  '/product/driver-app(.*)',
  '/contact-sales(.*)',
  '/support(.*)',
  '/onboarding(.*)',
  '/privacy(.*)',
  '/terms(.*)',
  '/sms-consent(.*)',
  '/api/sms/opt-in',
  // CRM outreach unsubscribe — token IS auth, no Clerk session.
  // Recipient landing here from a cold email must NOT bounce through
  // /sign-in; they'd never sign in and would leave the address on the
  // sending list. Route handler at apps/web/app/unsubscribe/[token]
  // proxies to the Railway API's crm-public endpoint.
  '/unsubscribe(.*)',
  // Paystub view links texted to drivers. Token in URL = auth
  // (drivers don't have Clerk accounts). Page fetches
  // /v1/public/paystubs/<token> on the Railway API.
  '/paystub(.*)',
])

const protectedMiddleware = clerkMiddleware(async (auth, request) => {
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

/**
 * Outer wrap so we catch crashes happening INSIDE clerkMiddleware's
 * own setup — the `TypeError: immutable` Headers.append bug noted
 * above throws before our callback runs, so the inner try/catch can't
 * see it and Vercel serves its default 500 MIDDLEWARE_INVOCATION_FAILED
 * page (which the team has hit recurrently — see 2026-06-22 fix).
 *
 * Instead of letting Vercel show that page, we redirect to /sign-in
 * with the original URL as redirect_url so Clerk drops them back where
 * they were after re-authenticating. If we're already heading to a
 * public route we just fall through — those pages don't need Clerk to
 * render, and we want to avoid an infinite redirect loop on a fully
 * broken SDK.
 *
 * This is a safety net, NOT a fix for the underlying SDK crash. The
 * real fix is bumping @clerk/nextjs 7.3.0 → 7.5.2+ per the comment
 * above; this wrap just stops blank-staring at a Vercel error.
 */
export default async function middleware(request: NextRequest, event: NextFetchEvent) {
  try {
    return await protectedMiddleware(request, event)
  } catch (err) {
    console.error('[middleware] Clerk middleware crashed:', err)
    if (isPublicRoute(request)) return

    // API routes can't follow a 307 redirect to /sign-in — the
    // dispatcher web's fetch() POSTs would get Status 0 / empty body
    // (and that's exactly what was happening on /api/driver-push when
    // Clerk middleware hit its TypeError: immutable bug). Return a
    // JSON 503 so the client sees a clear error to surface or retry.
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ error: 'auth_unavailable', detail: 'Clerk middleware temporarily unavailable; retry shortly.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const url = new URL('/sign-in', request.url)
    url.searchParams.set('redirect_url', request.nextUrl.pathname + request.nextUrl.search)
    return Response.redirect(url)
  }
}

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
