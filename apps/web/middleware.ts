import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)'])
const isOrgFreeRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)', '/create-organization(.*)', '/settings(.*)'])

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
