import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// /privacy and /terms must be publicly fetchable — they're linked from
// the Twilio A2P 10DLC registration as the required Privacy Policy and
// Terms URLs. Twilio's reviewer must be able to load them without auth.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)', '/privacy', '/terms'])
const isOrgFreeRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)', '/settings(.*)', '/privacy', '/terms'])

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect()
    const { orgId } = await auth()
    if (!orgId && !isOrgFreeRoute(request)) {
      const createOrgUrl = new URL('/create-organization', request.url)
      return Response.redirect(createOrgUrl)
    }
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|m?js(?!on)|jinja2|txt|xml|png|jpg|jpeg|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|pdf)).*)',
    '/(api|trpc)(.*)',
  ],
}
