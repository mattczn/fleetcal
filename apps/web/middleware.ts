import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { isInternalOrg } from '@/lib/internalOrg'

// Public routes — visible without auth.
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
])

// Routes that signed-in users without an org may still reach. Without
// this, a fresh signup without an org_id would be in a permanent
// redirect loop trying to access protected content.
const isOrgFreeRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
  '/settings(.*)',
])

// Routes a customer org without a paid tier can still reach — needed
// so they can REACH the pick-plan / billing surface to subscribe.
// Everything else (calendar, drivers, loads, etc.) is blocked until
// a tier feature lands on their session.
const isTierFreeRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/create-organization(.*)',
  '/pricing(.*)',
  '/onboarding(.*)',
])

export default clerkMiddleware(async (auth, request) => {
  if (isPublicRoute(request)) return

  // The ENTIRE protected-route flow is wrapped in one try/catch. The
  // priority of this middleware is "never 500" — a thrown error here
  // shows the user a Vercel error page with NO recovery path, which is
  // strictly worse than letting them through to client-side checks
  // (useOrgTier, usePermissions, etc.) which surface the right CTA.
  //
  // The previous incarnation called `auth.protect()` outside the
  // try/catch and crashed on certain session shapes (overlapping
  // cookies during a Google account-switch). All Clerk-side calls now
  // live inside the try block.
  try {
    const authObj = await auth()
    const userId = authObj.userId
    const orgId  = authObj.orgId

    // Not signed in → send to sign-in page (replaces auth.protect()).
    if (!userId) {
      const url = new URL('/sign-in', request.url)
      return Response.redirect(url)
    }

    // Signed in but no org → push them to org creation (unless they're
    // already on a route that handles the no-org case).
    if (!orgId && !isOrgFreeRoute(request)) {
      return Response.redirect(new URL('/create-organization', request.url))
    }

    // Tier gate — non-internal customer orgs must have a paid tier
    // feature on their session. The has() call is bound to authObj
    // (not destructured) to keep its `this` intact.
    if (orgId && !isInternalOrg(orgId) && !isTierFreeRoute(request)) {
      let hasTier = false
      try {
        hasTier =
          authObj.has({ feature: 'fleet_tier' }) ||
          authObj.has({ feature: 'growth_tier' }) ||
          authObj.has({ feature: 'owner_op_tier' })
      } catch (err) {
        // Inner catch so a flaky tier lookup falls through to "let
        // them in" rather than killing the request. Client-side
        // useOrgTier hook will surface the upgrade banner on next
        // render if they truly have no tier.
        console.error('[middleware] has(feature) failed:', err)
        hasTier = true
      }
      if (!hasTier) {
        return Response.redirect(new URL('/onboarding/pick-plan', request.url))
      }
    }
  } catch (err) {
    // Last-resort net. Any unhandled Clerk-side error (account-switch
    // race, expired token, network blip to Clerk's verification API,
    // etc.) lets the request fall through to the page, which will
    // re-attempt auth on the client. We log so Vercel function logs
    // capture the cause.
    console.error('[middleware] failed, allowing request through:', err)
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|m?js(?!on)|jinja2|txt|xml|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf)).*)',
    '/(api|trpc)(.*)',
  ],
}
