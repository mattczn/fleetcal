import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/accounting',
        '/admin',
        '/assets',
        '/board',
        '/calendar',
        '/closeout',
        '/create-organization',
        '/dashboard',
        '/drivers',
        '/equipment',
        '/fuel',
        '/loads',
        '/maintenance',
        '/onboarding',
        '/payroll',
        '/performance',
        '/search',
        '/settings',
        '/sign-in',
        '/sign-up',
        '/timeline',
      ],
    },
    sitemap: 'https://fleetcal.app/sitemap.xml',
  };
}
