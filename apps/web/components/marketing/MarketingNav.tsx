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
 * Mobile (<md): the inline link bar collapses behind a hamburger
 * button on the right of the nav. Tapping it slides a panel down
 * from under the nav with Features / How it works / Pricing / Why
 * FleetCal + Sign in. The CTA stays in the bar at all sizes so the
 * "Start free trial" call to action never disappears.
 */
import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState, Fragment } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import { FLOW } from '@/components/marketing/ProductFlowFooter';

interface Cta { href: string; label: string }

export default function MarketingNav({ cta, showSignIn, frostless = false }: { cta: Cta; showSignIn: boolean; frostless?: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the mobile panel on viewport resize across the md breakpoint
  // (768px). Without this, opening it on phone, then rotating to
  // landscape past 768 leaves the panel mounted off-screen, eating
  // taps near the top of the page.
  useEffect(() => {
    const onResize = () => { if (window.innerWidth >= 768) setOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Top-level page links — DRY between desktop bar + mobile panel. Section
  // navigation now lives in the per-page HeroFeatureNav pill, so the top bar
  // carries page links instead.
  const NAV: ReadonlyArray<{ href: string; label: string }> = [
    { href: '/',              label: 'Home'    },
    { href: '/contact-sales', label: 'Contact' },
    { href: '/support',       label: 'Support' },
  ];

  return (
    <nav
      className="sticky top-0 z-50 backdrop-blur"
      style={{
        background:        frostless ? 'transparent' : 'rgba(255,255,255,0.82)',
        WebkitBackdropFilter: frostless ? 'none' : 'saturate(180%) blur(12px)',
        backdropFilter:    frostless ? 'none' : 'saturate(180%) blur(12px)',
        borderBottom:      `1px solid ${scrolled || open ? '#e8eaed' : 'transparent'}`,
        boxShadow:         scrolled ? '0 1px 0 rgba(60,64,67,0.04)' : 'none',
        transition:        'border-color .25s, box-shadow .25s',
      }}
    >
      <div className="mx-auto flex items-center justify-between w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12" style={{ height: 68 }}>
        <div className="flex items-center gap-7 lg:gap-9">
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

          <div className="hidden md:flex items-center gap-7 font-display">
            {NAV.map((n, i) => (
              <Fragment key={n.href}>
                <Link
                  href={n.href}
                  className="text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors"
                >
                  {n.label}
                </Link>
                {i === 0 && <ProductMenu />}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4 font-display">
          {showSignIn && (
            <Link href="/sign-in" className="hidden md:inline text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">Sign in</Link>
          )}
          <Link
            href={cta.href}
            className="inline-flex items-center justify-center text-white font-semibold text-[13px] sm:text-[14px] rounded-full transition-all hover:bg-sys-blue-hover whitespace-nowrap"
            style={{
              background:  'var(--gc-blue)',
              padding:     '9px 16px',
              boxShadow:   'var(--shadow-1)',
            }}
          >
            {cta.label.replace(' →', '')}
          </Link>
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
            className="md:hidden inline-flex items-center justify-center rounded-full"
            style={{
              width:  40,
              height: 40,
              color:  '#3c4043',
              background: open ? '#f1f3f4' : 'transparent',
              transition: 'background .15s',
            }}
          >
            {open ? <X size={20} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile panel — collapses the section links + Sign in when
          the hamburger is open. Pinned under the nav, full-width.
          Closes on link tap via SmoothScrollLink's onClick override. */}
      {open && (
        <div
          className="md:hidden"
          style={{
            background: 'rgba(255,255,255,0.96)',
            borderBottom: '1px solid #e8eaed',
            padding: '8px 20px 18px',
          }}
        >
          <div className="flex flex-col font-display">
            {NAV.map((n, i) => (
              <Fragment key={n.href}>
                <Link
                  href={n.href}
                  onClick={() => setOpen(false)}
                  className="block text-[16px] font-medium text-sys-text-2 hover:text-sys-blue-text py-3 border-b border-[#f1f3f4] last:border-b-0"
                >
                  {n.label}
                </Link>
                {i === 0 && <ProductMobileLinks onNavigate={() => setOpen(false)} />}
              </Fragment>
            ))}
            {showSignIn && (
              <Link
                href="/sign-in"
                onClick={() => setOpen(false)}
                className="block text-[16px] font-medium text-sys-text-2 hover:text-sys-blue-text py-3"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}

/** Desktop "Product" hover dropdown listing every product page. */
function ProductMenu() {
  return (
    <div className="relative group">
      <button type="button" className="inline-flex items-center gap-1 text-[15px] font-medium text-sys-text-2 hover:text-sys-blue-text transition-colors">
        Product
        <ChevronDown size={15} strokeWidth={2.5} className="transition-transform duration-200 group-hover:rotate-180" />
      </button>
      {/* pt-3 is a transparent bridge so the menu stays open while the cursor crosses the gap */}
      <div className="absolute left-1/2 -translate-x-1/2 top-full pt-3 opacity-0 invisible translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:visible group-hover:translate-y-0">
        <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: 'var(--shadow-3)', padding: 7, width: 236 }}>
          {FLOW.map((p) => (
            <Link key={p.key} href={p.href} className="flex items-center gap-3 rounded-[9px] hover:bg-[#f8f9fa] transition-colors" style={{ padding: '9px 10px' }}>
              <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, background: p.light, display: 'grid', placeItems: 'center' }}>
                <p.Icon size={17} strokeWidth={2} style={{ color: p.color }} />
              </span>
              <span className="font-display" style={{ fontWeight: 600, fontSize: 14, color: '#202124' }}>{p.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Mobile panel "Product" section — every product page, expanded inline. */
function ProductMobileLinks({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="py-3 border-b border-[#f1f3f4]">
      <div className="font-display" style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#9aa0a6', marginBottom: 2 }}>Product</div>
      {FLOW.map((p) => (
        <Link key={p.key} href={p.href} onClick={onNavigate} className="flex items-center gap-3" style={{ padding: '10px 0' }}>
          <span style={{ width: 30, height: 30, flex: 'none', borderRadius: 8, background: p.light, display: 'grid', placeItems: 'center' }}>
            <p.Icon size={16} strokeWidth={2} style={{ color: p.color }} />
          </span>
          <span className="font-display" style={{ fontWeight: 500, fontSize: 15.5, color: '#3c4043' }}>{p.label}</span>
        </Link>
      ))}
    </div>
  );
}
