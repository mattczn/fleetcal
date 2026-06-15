/**
 * Minimal cookie-presence middleware (Clerk-bundle-free).
 *
 * History: previously used `clerkMiddleware()`. On 2026-06-15 Vercel
 * migrated this project's middleware to the `edge-on-lambda` runtime,
 * where response Headers are immutable. Clerk's bundled middleware
 * does `targetHeaders.append(...)` on a frozen Headers object inside
 * a `Headers.forEach(...)` loop → `TypeError: immutable` → every
 * authenticated request 500'd with MIDDLEWARE_INVOCATION_FAILED. The
 * outage was random per-request because Vercel was still mid-rollout.
 *
 * Stack:
 *   at Headers.append (.../undici.js)
 *   at Headers.<computed> as append (/opt/edge-on-lambda/handler.js)
 *   at Vp (user-source.js — Clerk's bundled middleware)
 *   at handler (user-source.js)
 *
 * Fix: do the only thing the old middleware actually did — gate
 * non-public routes on cookie presence and redirect to /sign-in if
 * the user has no Clerk session cookie. We never touch Clerk's
 * server SDK here, so the immutable-Headers path can't be hit.
 *
 * Cookie names: Clerk's frontend SDK sets `__session` (the JWT) and
 * `__client_uat` (session UAT) on the production domain. Either being
 * present means the user has a session; we let them through and let
 * `<ClerkProvider>` validate it on the page. If the cookie is stale or
 * invalid, the page-level check will redirect properly — this gate
 * only catches "no session at all, don't waste a page render."
 *
 * Real auth enforcement still lives in:
 *   - `<ClerkProvider>` (root layout)
 *   - server actions / API routes via `auth()` from `@clerk/nextjs/server`
 *   - AppShell-level tier/role checks
 *
 * This middleware is a redirect optimization, NOT a security boundary.
 */
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_ROUTES: RegExp[] = [
  /^\/$/,
  /^\/sign-in(\/.*)?$/,
  /^\/sign-up(\/.*)?$/,
  /^\/create-organization(\/.*)?$/,
  /^\/pricing(\/.*)?$/,
  /^\/contact-sales(\/.*)?$/,
  /^\/onboarding(\/.*)?$/,
  /^\/privacy(\/.*)?$/,
  /^\/terms(\/.*)?$/,
  /^\/sms-consent(\/.*)?$/,
  /^\/api\/sms\/opt-in$/,
]

export default function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  if (PUBLIC_ROUTES.some((rx) => rx.test(path))) return NextResponse.next()

  const hasSession =
    request.cookies.has('__session') || request.cookies.has('__client_uat')
  if (!hasSession) {
    return NextResponse.redirect(new URL('/sign-in', request.url))
  }
  return NextResponse.next()
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
