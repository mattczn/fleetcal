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
  const { orgId, has } = await auth()

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
  if (orgId && !isInternalOrg(orgId) && !isTierFreeRoute(request)) {
    const hasTier =
      has({ feature: 'fleet_tier' }) ||
      has({ feature: 'growth_tier' }) ||
      has({ feature: 'owner_op_tier' })
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
