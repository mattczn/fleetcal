/**
 * /pricing — standalone pricing page.
 *
 * Same Systematica-style cards as embedded on `/`. Public route. Useful
 * for direct linking from marketing emails / outbound. Header is a
 * simplified version of the landing's nav.
 */
import Link from 'next/link';
import PricingCards from '@/components/marketing/PricingCards';

export default function PricingPage() {
  return (
    <div className="h-full overflow-y-auto font-sys text-sys-primary bg-sys-bg">
      {/* Slim nav — just wordmark + back link, no full landing nav */}
      <nav className="sticky top-0 z-50 h-16 bg-sys-bg border-b border-sys-line">
        <div className="h-full max-w-6xl mx-auto px-8 md:px-12 flex items-center justify-between">
          <Link href="/" className="font-mono font-bold text-[15px] uppercase" style={{ letterSpacing: '0.2em' }}>
            <span className="text-sys-blue">FLEET</span>
            <span className="text-sys-orange">CAL</span>
          </Link>
          <Link
            href="/sign-in"
            className="font-sys font-medium text-[13px] text-sys-muted hover:text-sys-primary transition-colors"
          >
            Sign in
          </Link>
        </div>
      </nav>

      <section className="border-b border-sys-line">
        <div className="max-w-6xl mx-auto px-8 md:px-12 py-24 md:py-32">
          <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-6" style={{ letterSpacing: '0.12em' }}>
            Pricing
          </div>
          <h1 className="font-display text-[44px] md:text-[64px] leading-[1.05] tracking-tight mb-6 max-w-3xl">
            Priced by fleet size.{' '}
            <span className="text-sys-blue">Same product at every tier.</span>
          </h1>
          <p className="font-sys text-[17px] leading-[1.6] text-sys-muted mb-12 max-w-2xl">
            14-day free trial on every plan. No credit card to start.
            Cancel any time — no annual lock-in, no per-driver surcharges.
          </p>

          <PricingCards />

          <div className="mt-16 pt-8 border-t border-sys-line text-center">
            <p className="font-sys text-[14px] text-sys-muted">
              Running a fleet larger than 14 trucks?{' '}
              <a
                href="mailto:sales@fleetcal.app?subject=Enterprise%20inquiry"
                className="font-semibold text-sys-blue hover:underline"
              >
                Contact sales →
              </a>
            </p>
          </div>
        </div>
      </section>

      <footer className="bg-sys-bg">
        <div className="max-w-6xl mx-auto px-8 md:px-12 py-12 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" className="font-mono font-bold text-[14px] uppercase" style={{ letterSpacing: '0.2em' }}>
            <span className="text-sys-blue">FLEET</span>
            <span className="text-sys-orange">CAL</span>
          </Link>
          <div className="font-sys text-[12px] uppercase text-sys-muted" style={{ letterSpacing: '0.12em' }}>
            © {new Date().getFullYear()} · Built in Salt Lake City
          </div>
          <div className="flex gap-6 text-[13px] font-medium text-sys-muted">
            <Link href="/sign-in" className="hover:text-sys-primary transition-colors">Sign in</Link>
            <Link href="/sign-up" className="hover:text-sys-primary transition-colors">Sign up</Link>
            <a href="mailto:sales@fleetcal.app" className="hover:text-sys-primary transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
