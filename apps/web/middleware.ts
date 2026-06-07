import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

// `/` is public so the marketing landing renders for signed-out
// visitors. Signed-in users with an org get bounced to /calendar by
// the page component itself (see app/page.tsx).
const isPublicRoute = createRouteMatcher(['/', '/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)', '/pricing(.*)'])
const isOrgFreeRoute = createRouteMatcher(['/', '/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)', '/pricing(.*)', '/settings(.*)'])

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
