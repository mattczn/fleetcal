'use client';

/**
 * MarketingNav — sticky top navigation for /, /pricing.
 *
 * Two visual states driven by scroll position:
 *   - top (scrolled === false):    transparent, no shadow
 *   - scrolled (scrollY > 8):      hairline bottom border + soft shadow
 *
 * The marketing page lives inside the global `.h-full overflow-hidden`
 * body wrapper used by the dashboard, but on `/` we deliberately let
 * the page scroll on `window` (no inner scroller) so SEO crawlers see
 * a normal document and so the design handoff's scroll math just
 * works. So we listen on window — confirmed against the prototype's
 * onScroll handler that uses `window.scrollY`.
 *
 * Hamburger collapse on narrow viewports — below ~860px we hide the
 * inline links and rely on the CTA-only header. (Full hamburger menu
 * is a follow-up; the handoff explicitly punts the responsive pass
 * to the implementer.)
 */
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import SmoothScrollLink from './SmoothScrollLink';

interface Cta { href: string; label: string }

export default function MarketingNav({ cta, showSignIn }: { cta: Cta; showSignIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className="sticky top-0 z-50 backdrop-blur"
      style={{
        background:        'rgba(255,255,255,0.82)',
        WebkitBackdropFilter: 'saturate(180%) blur(12px)',
        backdropFilter:    'saturate(180%) blur(12px)',
        borderBottom:      `1px solid ${scrolled ? '#e8eaed' : 'transparent'}`,
        boxShadow:         scrolled ? '0 1px 0 rgba(60,64,67,0.04)' : 'none',
        transition:        'border-color .25s, box-shadow .25s',
      }}
    >
      <div className="mx-auto flex items-center justify-between max-w-[1160px] px-8" style={{ height: 68 }}>
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

        <div className="hidden md:flex items-center gap-8 font-display">
          <SmoothScrollLink to="features" className="text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">Features</SmoothScrollLink>
          <SmoothScrollLink to="how"      className="text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">How it works</SmoothScrollLink>
          <SmoothScrollLink to="pricing"  className="text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">Pricing</SmoothScrollLink>
          <SmoothScrollLink to="story"    className="text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">Why FleetCal</SmoothScrollLink>
        </div>

        <div className="flex items-center gap-4 font-display">
          {showSignIn && (
            <Link href="/sign-in" className="hidden md:inline text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">Sign in</Link>
          )}
          <Link
            href={cta.href}
            className="inline-flex items-center justify-center text-white font-semibold text-[14px] rounded-full transition-all hover:bg-sys-blue-hover"
            style={{
              background:  'var(--gc-blue)',
              padding:     '10px 20px',
              boxShadow:   'var(--shadow-1)',
              whiteSpace:  'nowrap',
            }}
          >
            {cta.label.replace(' →', '')}
          </Link>
        </div>
      </div>
    </nav>
  );
}
