import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import PricingCards from '@/components/marketing/PricingCards';
import SmoothScrollLink from '@/components/marketing/SmoothScrollLink';

/**
 * Marketing landing page at `/`.
 *
 * Viewable by EVERYONE — signed-out, signed-in-no-org, signed-in-with-org.
 * Previously force-redirected signed-in users to /calendar which made
 * every "back to home" link in the funnel useless; users felt trapped
 * once they started onboarding. Now signed-in users see the same
 * landing with their CTAs adapted to "Open FleetCal →" instead of
 * "Try for free".
 *
 * Design language mirrors systematica-site:
 *   - DM Serif Display headlines, DM Sans body, IBM Plex Mono labels
 *   - Zero border-radius rectangles everywhere
 *   - Section-as-color-block rhythm (white → blue → white → blue → white)
 *   - 1px hairlines between sections, no shadows or gradients
 *   - Numbered eyebrows ("01 · Features"), colored top-banner cards
 *
 * Light mode only — marketing pages should not respect the dashboard's
 * dark-mode preference (the visual identity is light-by-design).
 */
export default async function HomePage() {
  const { userId, orgId } = await auth();
  // Three states the CTAs need to handle:
  //   - signed-out → "Try for free" → /sign-up
  //   - signed-in-no-org → "Continue setup" → /sign-up (Clerk resumes
  //     at the choose-organization step). This is the "I bailed mid-
  //     signup" state — without the special CTA, "Open FleetCal" would
  //     bounce off the orgless-protected-route middleware right back
  //     to /create-organization, re-trapping the user.
  //   - signed-in-with-org → "Open FleetCal" → /calendar
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';

  return (
    <div
      className="h-full overflow-y-auto font-sys text-sys-primary bg-sys-bg"
      style={{ scrollBehavior: 'smooth' }}
    >
      <Nav state={state} />
      <Hero state={state} />
      <Features />
      <Pricing />
      <BuiltBy />
      <FinalCta state={state} />
      <Footer />
    </div>
  );
}

type AuthCta = 'out' | 'mid-signup' | 'in';

/** Resolves the marketing CTA href + label for the given auth state. */
function ctaFor(state: AuthCta): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Try for free →' };
}

// ── Sub-sections ────────────────────────────────────────────────────────

function Nav({ state }: { state: AuthCta }) {
  const cta = ctaFor(state);
  return (
    <nav className="sticky top-0 z-50 h-16 bg-sys-bg border-b border-sys-line">
      <div className="h-full max-w-6xl mx-auto px-8 md:px-12 flex items-center justify-between">
        <Link href="/" className="flex items-center" aria-label="FleetCal home">
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={220}
            height={48}
            priority
            style={{ height: 48, width: 'auto', objectFit: 'contain' }}
          />
        </Link>
        <div className="flex items-center gap-8">
          <SmoothScrollLink to="features" className="hidden md:inline text-[13px] font-medium text-sys-muted hover:text-sys-primary transition-colors">Features</SmoothScrollLink>
          <SmoothScrollLink to="pricing"  className="hidden md:inline text-[13px] font-medium text-sys-muted hover:text-sys-primary transition-colors">Pricing</SmoothScrollLink>
          {state === 'out' && (
            <Link href="/sign-in" className="hidden md:inline text-[13px] font-medium text-sys-muted hover:text-sys-primary transition-colors">Sign in</Link>
          )}
          <Link
            href={cta.href}
            className="bg-sys-blue text-white font-semibold text-[13px] px-5 py-2 hover:bg-sys-blue-hover transition-colors"
            style={{ borderRadius: 0 }}
          >
            {/* Nav button trims the trailing arrow for compactness */}
            {cta.label.replace(' →', '')}
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Hero({ state }: { state: AuthCta }) {
  const cta = ctaFor(state);
  return (
    <section className="border-b border-sys-line">
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-32 md:py-40">
        <div className="max-w-3xl">
          <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-8" style={{ letterSpacing: '0.12em' }}>
            01 · Dispatch + Billing
          </div>
          <h1 className="font-display text-[52px] md:text-[72px] lg:text-[82px] leading-[1.0] tracking-tight mb-10">
            Rate-con to invoice.{' '}
            <span className="text-sys-blue">One tool.</span>
          </h1>
          <p className="font-sys text-[17px] md:text-[18px] leading-[1.6] text-sys-muted mb-10 max-w-2xl">
            The TMS built by a 13-truck fleet owner, for fleets like yours.
            No ELD lock-in. No per-driver fees.{' '}
            <strong className="text-sys-primary font-semibold">Built and used daily at Curzon Trucking</strong>.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-10">
            <Chip color="orange">RATE-CON AI</Chip>
            <Chip color="green">PAYROLL BUILT-IN</Chip>
            <Chip color="teal">14-DAY FREE TRIAL</Chip>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <Link
              href={cta.href}
              className="inline-flex items-center bg-sys-blue text-white font-semibold text-[15px] px-8 py-4 hover:bg-sys-blue-hover transition-colors"
              style={{ borderRadius: 0 }}
            >
              {cta.label}
            </Link>
            <SmoothScrollLink to="pricing" className="font-sys font-semibold text-[15px] text-sys-blue hover:underline">
              See pricing →
            </SmoothScrollLink>
          </div>
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" className="bg-sys-blue text-white border-b border-sys-blue" style={{ scrollMarginTop: 64 }}>
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-32">
        <div className="font-sys font-semibold text-[13px] uppercase text-white/70 mb-6" style={{ letterSpacing: '0.12em' }}>
          02 · Features
        </div>
        <h2 className="font-display text-[40px] md:text-[52px] leading-tight tracking-tight mb-6 max-w-3xl">
          Everything dispatch needs.{' '}
          <span className="text-white/70">Nothing they don&apos;t.</span>
        </h2>
        <p className="font-sys text-[17px] leading-[1.6] text-white/80 mb-16 max-w-2xl">
          Drop a rate-con PDF. Dispatch the load. Verify the POD. Send the invoice.
          Pay the driver. Every step where it should be, no leaving the app.
        </p>
        <div className="grid md:grid-cols-2 gap-px bg-sys-line">
          <FeatureCard
            accent="orange"
            label="AI · Documents"
            title="AI rate-con parser"
            body="Drop a rate confirmation PDF onto the calendar. Customer, rate, stops, and appointment times extracted automatically. Edit what's wrong, save what's right."
            bullets={['PDF or photo upload', 'Stops + appointment times', 'Auto customer match']}
          />
          <FeatureCard
            accent="green"
            label="Live · Dispatch"
            title="Real dispatch calendar"
            body="One screen for every truck on every day. Drag to reschedule. Day or week view. Built for the way dispatchers actually think — not for what looked good in a demo."
            bullets={['Drag-and-drop scheduling', 'Day / week / driver view', 'Status auto-flips on assign']}
          />
          <FeatureCard
            accent="teal"
            label="POD · Billing"
            title="Paperwork to invoice in 3 clicks"
            body="POD verification queue. Release to billing. Generate the invoice. Send to the customer. Mark paid. No re-keying, no spreadsheets."
            bullets={['POD verify + release', 'Auto-numbered invoices', 'Resend / dispute tracking']}
          />
          <FeatureCard
            accent="purple"
            label="Payroll · Drivers"
            title="Driver payroll built in"
            body="Per-driver weekly totals computed from the loads you actually ran. Detention and layover adjustments. Finalize on Friday and you're done."
            bullets={['Per-driver pay × %', 'TONU / layover / deduction', 'Lock-on-finalize']}
          />
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" className="border-b border-sys-line" style={{ scrollMarginTop: 64 }}>
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-32">
        <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-6" style={{ letterSpacing: '0.12em' }}>
          03 · Pricing
        </div>
        <h2 className="font-display text-[40px] md:text-[52px] leading-tight tracking-tight mb-6 max-w-3xl">
          Priced by fleet size.{' '}
          <span className="text-sys-blue">Same product at every tier.</span>
        </h2>
        <p className="font-sys text-[17px] leading-[1.6] text-sys-muted mb-12 max-w-2xl">
          14-day free trial on every plan. No credit card to start.
          Cancel any time — no annual lock-in, no per-driver surcharges.
        </p>

        {/* Custom Systematica-style pricing cards. Clerk's built-in
            <PricingTable /> is sparse for signed-out visitors and clashes
            with the zero-radius aesthetic — see PricingCards docstring. */}
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
  );
}

function BuiltBy() {
  return (
    <section className="bg-sys-surface border-b border-sys-line">
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-32">
        <div className="grid md:grid-cols-2 gap-16 md:gap-24 items-start">
          <div>
            <div className="font-sys font-semibold text-[13px] uppercase text-sys-blue mb-6" style={{ letterSpacing: '0.12em' }}>
              04 · Built by carriers
            </div>
            <h2 className="font-display text-[40px] md:text-[52px] leading-tight tracking-tight mb-8">
              Made by people who&apos;ve actually{' '}
              <span className="text-sys-blue">run a dispatch desk.</span>
            </h2>
          </div>
          <div className="font-sys text-[16px] md:text-[17px] leading-[1.85] text-sys-muted space-y-6">
            <p>
              FleetCal was built at <strong className="text-sys-primary font-semibold">Curzon Trucking</strong>,
              a 13-truck reefer carrier in Salt Lake City. The first version was a
              calendar built to replace a whiteboard. Then a POD queue. Then invoicing.
              Then payroll.
            </p>
            <p>
              Every feature in here exists because someone yelled across the dispatch
              office for it. There&apos;s no design committee, no UX consultancy,
              no &quot;competitive feature parity&quot; spreadsheet driving the roadmap.
              Just the actual work of running freight.
            </p>
            <p>
              If you&apos;ve ever paid for a TMS that was clearly built by someone
              who&apos;s never sat next to a dispatcher at 6am, you&apos;ll feel the difference.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalCta({ state }: { state: AuthCta }) {
  const cta = ctaFor(state);
  const sub =
    state === 'in'         ? 'Pick up where you left off.' :
    state === 'mid-signup' ? 'Finish the setup you started.' :
                             '14 days free. No sales call. Sign up and you’re in.';
  return (
    <section className="bg-sys-blue text-white border-b border-sys-blue">
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-32 text-center">
        <div className="font-sys font-semibold text-[13px] uppercase text-white/70 mb-6" style={{ letterSpacing: '0.12em' }}>
          05 · Get started
        </div>
        <h2 className="font-display text-[40px] md:text-[64px] leading-[1.05] tracking-tight mb-8 max-w-3xl mx-auto">
          See your loads on a calendar that{' '}
          <span className="text-white/70">actually fits how you dispatch.</span>
        </h2>
        <p className="font-sys text-[17px] md:text-[18px] leading-[1.6] text-white/80 mb-10 max-w-xl mx-auto">
          {sub}
        </p>
        <Link
          href={cta.href}
          className="inline-flex items-center bg-white text-sys-blue font-semibold text-[15px] px-10 py-4 hover:bg-sys-blue-light transition-colors"
          style={{ borderRadius: 0 }}
        >
          {cta.label}
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-sys-bg">
      <div className="max-w-6xl mx-auto px-8 md:px-12 py-12 flex flex-wrap items-center justify-between gap-4">
        <Link href="/" className="flex items-center" aria-label="FleetCal home">
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={190}
            height={42}
            style={{ height: 42, width: 'auto', objectFit: 'contain' }}
          />
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
  );
}

// ── Building blocks ────────────────────────────────────────────────────

type ChipColor = 'orange' | 'green' | 'teal' | 'purple';
const CHIP_BG: Record<ChipColor, string> = {
  orange: '#F47316',
  green:  '#16A34A',
  teal:   '#0891B2',
  purple: '#7C3AED',
};

function Chip({ color, children }: { color: ChipColor; children: React.ReactNode }) {
  return (
    <span
      className="font-sys font-medium text-[12px] uppercase text-white px-4 py-2"
      style={{ background: CHIP_BG[color], borderRadius: 0, letterSpacing: '0.08em' }}
    >
      {children}
    </span>
  );
}

function FeatureCard({
  accent, label, title, body, bullets,
}: {
  accent: ChipColor;
  label: string;
  title: string;
  body: string;
  bullets: string[];
}) {
  return (
    <div className="bg-white" style={{ borderRadius: 0 }}>
      <div
        className="font-mono font-bold text-[11px] uppercase text-white px-8 py-3"
        style={{ background: CHIP_BG[accent], letterSpacing: '0.12em' }}
      >
        {label}
      </div>
      <div className="px-8 py-10">
        <h3 className="font-sys text-[20px] font-semibold text-sys-primary mb-3 tracking-tight">{title}</h3>
        <p className="font-sys text-[15px] leading-[1.65] text-sys-muted mb-6">{body}</p>
        <ul className="space-y-2">
          {bullets.map(b => (
            <li key={b} className="flex items-start gap-3 font-sys text-[14px] text-sys-primary">
              <span className="w-1.5 h-1.5 bg-sys-muted mt-2 flex-shrink-0" />
              {b}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
