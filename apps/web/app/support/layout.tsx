/**
 * Metadata wrapper for /support. The page is a client component
 * (`'use client'` — it runs the contact form), so it can't export
 * `metadata` itself. This server-component layout supplies the SEO tags
 * and renders children untouched. /support is also the App Store / Play
 * Store support URL for the FleetCal Driver and FleetCal Go apps.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Help & Support | FleetCal',
  description:
    'Get help with FleetCal: dispatch calendar, driver app, billing, and payroll. Message the team or reach us at hello@fleetcal.app.',
  alternates: { canonical: 'https://fleetcal.app/support' },
  openGraph: {
    title: 'Help & Support | FleetCal',
    description: 'Get help with FleetCal: dispatch calendar, driver app, billing, and payroll.',
    url: 'https://fleetcal.app/support',
    siteName: 'FleetCal',
    images: [{ url: 'https://fleetcal.app/og-image.png', width: 1200, height: 630, alt: 'FleetCal support' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Help & Support | FleetCal',
    description: 'Get help with FleetCal: dispatch calendar, driver app, billing, and payroll.',
    images: ['https://fleetcal.app/og-image.png'],
  },
};

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
