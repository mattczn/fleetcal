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

  await auth.protect()

  // Resolve auth state — wrap in try/catch so a weird session (e.g. a
  // user mid-account-switch with overlapping cookies) doesn't crash
  // the entire middleware and 500 every request. If anything goes
  // wrong here we let the request through; Clerk's per-route checks
  // and our app-level guards will catch it on the next hop.
  let orgId: string | null | undefined
  let authObj: Awaited<ReturnType<typeof auth>> | null = null
  try {
    authObj = await auth()
    orgId = authObj.orgId
  } catch (err) {
    console.error('[middleware] auth() failed:', err)
    return
  }

  // No org → bounce to org creation (unless already on an org-free route).
  if (!orgId && !isOrgFreeRoute(request)) {
    return Response.redirect(new URL('/create-organization', request.url))
  }

  // Tier gate — non-internal orgs (i.e. paying customers) need a paid
  // tier feature on their session to use the app. If their trial ended
  // without conversion or they somehow bypassed the pick-plan funnel,
  // Clerk's "Free" fallback gives them no tier feature, and we redirect
  // them back to /onboarding/pick-plan to subscribe.
  //
  // Curzon (internal org) bypasses this entirely — it has no plan but
  // is grandfathered in for our own dogfooding.
  //
  // NOTE: call `authObj.has(...)` directly rather than destructuring it
  // — Clerk's `has` is a method bound to the auth object, and pulling
  // it out via destructuring loses the `this` binding in some session
  // shapes, causing a runtime crash + Vercel 500 / MIDDLEWARE_INVOCATION_FAILED.
  if (orgId && !isInternalOrg(orgId) && !isTierFreeRoute(request) && authObj) {
    let hasTier = false
    try {
      hasTier =
        authObj.has({ feature: 'fleet_tier' }) ||
        authObj.has({ feature: 'growth_tier' }) ||
        authObj.has({ feature: 'owner_op_tier' })
    } catch (err) {
      // Feature lookup failed (rare — partial session, expired token,
      // etc.). Treat as "unknown" and let the request through; the
      // client-side useOrgTier hook will surface the upgrade banner
      // on its next render if the user really has no tier.
      console.error('[middleware] has(feature) failed:', err)
      hasTier = true
    }
    if (!hasTier) {
      return Response.redirect(new URL('/onboarding/pick-plan', request.url))
    }
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|m?js(?!on)|jinja2|txt|xml|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf)).*)',
    '/(api|trpc)(.*)',
  ],
}
