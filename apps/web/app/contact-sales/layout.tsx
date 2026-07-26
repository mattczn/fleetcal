/**
 * Metadata wrapper for /contact-sales. The page itself is a client
 * component (`'use client'` — it runs the qualification wizard), and
 * client components can't export `metadata`. This server-component layout
 * supplies the SEO tags; it renders children untouched, no extra markup.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Talk to Sales or Book a Demo | FleetCal',
  description:
    'Talk to the FleetCal team about dispatch for your fleet. Answer a few quick questions or book a call directly. Custom plans for fleets over 14 trucks.',
  alternates: { canonical: 'https://fleetcal.app/contact-sales' },
  openGraph: {
    title: 'Talk to Sales or Book a Demo | FleetCal',
    description: 'Talk to the FleetCal team about dispatch for your fleet, or book a call directly.',
    url: 'https://fleetcal.app/contact-sales',
    siteName: 'FleetCal',
    images: [{ url: 'https://fleetcal.app/og-image.png', width: 1200, height: 630, alt: 'Talk to FleetCal sales' }],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Talk to Sales or Book a Demo | FleetCal',
    description: 'Talk to the FleetCal team about dispatch for your fleet, or book a call directly.',
    images: ['https://fleetcal.app/og-image.png'],
  },
};

export default function ContactSalesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
