/**
 * /pricing — standalone pricing page.
 *
 * Same Google Workspace look as the embedded pricing section on `/`.
 * Public route. Useful for direct linking from marketing emails /
 * outbound. Header uses the same MarketingNav as the landing for
 * consistent brand presence and anchor-link navigation back into the
 * features / how / story / FAQ sections (the SmoothScrollLinks fall
 * through to a normal anchor on a different page).
 */
import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import PricingCards from '@/components/marketing/PricingCards';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';

export default async function PricingPage() {
  const { userId, orgId } = await auth();
  const state: 'out' | 'mid-signup' | 'in' = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div
      data-marketing-scroll
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{ scrollBehavior: 'smooth' }}
    >
      <MarketingNav cta={cta} showSignIn={state === 'out'} />

      <section style={{ paddingTop: 88, paddingBottom: 24 }}>
        <div className="mx-auto max-w-[1160px] px-5 sm:px-6 md:px-8" style={{ textAlign: 'center', maxWidth: 720, marginInline: 'auto' }}>
          <Reveal>
            <span
              className="font-mono"
              style={{
                fontSize:      12,
                fontWeight:    600,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color:         '#1967d2',
              }}
            >
              Pricing
            </span>
            <h1
              className="font-display"
              style={{
                fontWeight:    800,
                fontSize:      'clamp(36px, 5vw, 60px)',
                lineHeight:    1.05,
                letterSpacing: '-0.022em',
                color:         '#202124',
                margin:        '16px 0 0',
              }}
            >
              Priced by fleet size.{' '}
              <span style={{ color: 'var(--gc-blue)' }}>Same product at every tier.</span>
            </h1>
            <p
              style={{
                fontSize:   18,
                lineHeight: 1.6,
                color:      '#5f6368',
                margin:     '20px auto 0',
                maxWidth:   620,
              }}
            >
              14-day free trial on every plan. Cancel any time. No
              annual lock-in, no per-driver surcharges.
            </p>
          </Reveal>
        </div>
      </section>

      <section style={{ paddingBottom: 100 }}>
        <div className="mx-auto max-w-[1160px] px-5 sm:px-6 md:px-8">
          <Reveal delay={60}>
            <PricingCards />
          </Reveal>
        </div>
      </section>

      <footer style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed' }}>
        <div
          className="mx-auto max-w-[1160px] px-5 sm:px-6 md:px-8 py-7 flex flex-wrap justify-between items-center gap-4"
        >
          <Link href="/" aria-label="FleetCal home" className="flex items-center">
            <Image
              src="/logo-horizontal.png"
              alt="FleetCal"
              width={120}
              height={28}
              style={{ height: 28, width: 'auto', objectFit: 'contain', display: 'block' }}
            />
          </Link>
          <div
            className="font-mono"
            style={{
              fontSize:      12,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color:         '#5f6368',
            }}
          >
            © {new Date().getFullYear()}
          </div>
          <div className="flex gap-6 font-display" style={{ fontSize: 14, color: '#5f6368' }}>
            <Link href="/sign-in" className="hover:text-[#1967d2] transition-colors">Sign in</Link>
            <Link href="/sign-up" className="hover:text-[#1967d2] transition-colors">Sign up</Link>
            <Link href="mailto:hello@fleetcal.app" className="hover:text-[#1967d2] transition-colors">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ctaFor(state: 'out' | 'mid-signup' | 'in'): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Start free trial' };
}
