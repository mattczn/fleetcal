/**
 * AuthNav — simplified nav used on /sign-in, /sign-up, /create-org.
 *
 * Mirrors the marketing landing's MarketingNav visual rhythm (68px
 * height, horizontal wordmark left, pill links right) but drops the
 * homepage-only anchor links (Features / How / Pricing / Why FleetCal)
 * — they'd 404 on these pages. Replaced with a single "Back to home"
 * link and an auth-aware escape (Sign in / Sign out) on the right.
 *
 * Server component — no client state, just renders the right shape
 * for each page. The funnel pages each call this with the appropriate
 * `escape` slot rendered inline.
 */
import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';

interface AuthNavProps {
  /** Right-side slot — either a "Sign in" link, a Sign-out button, or
   *  whatever bail-out affordance the calling page wants. */
  escape?: ReactNode;
}

export default function AuthNav({ escape }: AuthNavProps) {
  return (
    <nav
      className="sticky top-0 z-50 backdrop-blur"
      style={{
        background:           'rgba(255,255,255,0.9)',
        WebkitBackdropFilter: 'saturate(180%) blur(12px)',
        backdropFilter:       'saturate(180%) blur(12px)',
        borderBottom:         '1px solid #e8eaed',
      }}
    >
      <div className="mx-auto flex items-center justify-between w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12" style={{ height: 68 }}>
        <Link href="/" aria-label="FleetCal home" className="flex items-center">
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={140}
            height={32}
            priority
            style={{ height: 32, width: 'auto', objectFit: 'contain', display: 'block' }}
          />
        </Link>
        <div className="flex items-center gap-6 font-display">
          <Link
            href="/"
            className="text-[14px] font-medium text-[#5f6368] hover:text-[#1967d2] transition-colors"
          >
            ← Back to home
          </Link>
          {escape}
        </div>
      </div>
    </nav>
  );
}
