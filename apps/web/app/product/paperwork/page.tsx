import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { ArrowLeft, Play, Check, ChevronDown, DollarSign, CreditCard, Flag, FileText } from 'lucide-react';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';
import HeroVideo from '@/components/marketing/HeroVideo';
import ReviewQueueCard from '@/components/marketing/paperwork/ReviewQueueCard';
import FlagModal from '@/components/marketing/paperwork/FlagModal';

/**
 * Paperwork (POD verification & release) marketing feature page at
 * `/product/paperwork`. Public (same 3-state CTA rules as `/` and the other
 * /product pages). Green accent, full-bleed hero. The authed app for this is
 * `/closeout`. Forward-links to `/product/billing` (not built yet) per the
 * handoff. Light mode only.
 */
export default async function PaperworkMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div data-marketing-scroll className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary" style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} />
      <Hero cta={cta} />
      <VerifyAndRelease />
      <ReviewQueue />
      <FinalCta cta={cta} />
      <Footer />
    </div>
  );
}

type AuthCta = 'out' | 'mid-signup' | 'in';
function ctaFor(state: AuthCta): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Start free trial' };
}

const WRAP = 'mx-auto w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12';

function BillingLink({ children }: { children: React.ReactNode }) {
  return <Link href="/product/billing" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none', borderBottom: '1.5px solid rgba(26,115,232,.32)' }}>{children}</Link>;
}

// ── Hero ────────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(176,230,196,0.75) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #ecfaf1 0%, #f5fbf7 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 88, minHeight: 'calc(100vh - 68px)' }}>
      <div className={`${WRAP} grid items-center gap-10 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.4fr]`}>
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#1e8e3e', background: '#e6f4ea', padding: '7px 15px 7px 12px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1e8e3e', boxShadow: '0 0 0 3px rgba(30,142,62,0.18)' }} />
              Paperwork verification
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(38px, 4.6vw, 58px)', lineHeight: 1.04, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              Delivered. Verified.<br /><span style={{ color: '#1e8e3e' }}>Ready to bill.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 480, margin: '20px 0 0' }}>
              When a load delivers, FleetCal checks the paperwork against the rate con and every stop, confirms your required docs and accessorials, and tells you the moment it&rsquo;s ready. Clear the queue with two keystrokes and send clean loads straight to <BillingLink>Billing</BillingLink>.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, marginTop: 30 }}>
              <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--gc-blue)', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
                {cta.label.replace(' →', '')}
              </Link>
              <Link href="/" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, color: '#1967d2', fontWeight: 600, fontSize: 17, padding: '16px 22px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                <span style={{ width: 26, height: 26, borderRadius: 999, background: '#e8f0fe', display: 'grid', placeItems: 'center' }}>
                  <ArrowLeft size={14} style={{ color: '#1967d2' }} strokeWidth={2.4} />
                </span>
                Back to home
              </Link>
            </div>
          </Reveal>
        </div>

        <Reveal delay={140}>
          <div style={{ position: 'relative' }}>
            <div className="overflow-hidden transition-transform duration-[450ms] ease-[cubic-bezier(.2,.7,.3,1)] origin-right hover:scale-[1.12]" style={{ border: '1px solid #e8eaed', borderRadius: 18, background: '#0b1220', boxShadow: 'var(--shadow-soft)' }}>
              <HeroVideo src="/paperwork-demo.mp4" poster="/paperwork-demo-poster.png" width={1677} height={928} ariaLabel="Load closeout review: rate con and POD side by side, ready to release" />
            </div>
            <div className="hidden sm:flex" style={{ position: 'absolute', top: -15, right: -12, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 999, boxShadow: 'var(--shadow-3)', padding: '8px 14px', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: '#d93025' }} />
              <span className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>Live demo</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Section A · Verify & release (board + accessorial overlays) ──────────

function AccCard({ Icon, iconBg, iconColor, title, desc }: {
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  iconBg: string; iconColor: string; title: string; desc: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, padding: '16px 18px', boxShadow: '0 18px 44px -16px rgba(26,35,50,.40)' }}>
      <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 9, background: iconBg, color: iconColor, display: 'grid', placeItems: 'center' }}>
        <Icon size={16} style={{ color: iconColor }} strokeWidth={2.4} />
      </span>
      <div>
        <div className="font-display" style={{ fontWeight: 700, fontSize: 14.5, color: '#202124' }}>{title}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5f6368', marginTop: 3 }}>{desc}</div>
      </div>
    </div>
  );
}

function VerifyAndRelease() {
  return (
    <section id="features" style={{ padding: '90px 0 86px' }}>
      {/* The accessorial cards overlap the screenshot's lower whitespace on
          desktop; below 880px they stack below it and the decorative
          overlays (badge / filter chip / popover) hide. */}
      <style>{`.pw-acc{position:absolute;left:24px;right:24px;bottom:5.5%;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;z-index:2}@media (max-width:879px){.pw-acc{position:static;left:auto;right:auto;bottom:auto;grid-template-columns:1fr;margin-top:16px}.pw-hide-sm{display:none!important}}`}</style>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 680 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>Verify &amp; release</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Every delivered load lands here, ready to verify.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0' }}>One board for paperwork verification. See what&rsquo;s ready, what&rsquo;s flagged, and what&rsquo;s released, and filter by accessorial so a pending detention or lumper never slips into an under-billed invoice. Everything you release flows straight into <BillingLink>Billing</BillingLink>.</p>
        </Reveal>

        <Reveal>
          <div style={{ position: 'relative', marginTop: 34 }}>
            <div style={{ border: '1px solid #e8eaed', borderRadius: 16, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/paperwork-board.png" alt="Paperwork board filtered to loads with accessorials" style={{ display: 'block', width: '100%', height: 'auto' }} />
            </div>

            {/* Review Queue badge */}
            <div className="pw-hide-sm" style={{ position: 'absolute', bottom: '22.6%', left: 24, display: 'inline-flex', alignItems: 'center', gap: 9, background: '#1e8e3e', color: '#fff', fontWeight: 600, fontSize: 14, padding: '11px 17px', borderRadius: 10, boxShadow: '0 6px 16px -4px rgba(30,142,62,.5),0 1px 3px rgba(60,64,67,.3)' }}>
              <Play size={12} fill="#fff" strokeWidth={0} /> <span className="font-display">Review Queue</span>
              <span className="font-mono" style={{ fontWeight: 600, fontSize: 12, background: 'rgba(255,255,255,.24)', borderRadius: 6, padding: '2px 7px' }}>15</span>
            </div>

            {/* Accessorial filter chip */}
            <div className="pw-hide-sm font-display" style={{ position: 'absolute', bottom: '36.7%', right: 24, display: 'inline-flex', alignItems: 'center', gap: 7, border: '1px solid #1a73e8', background: '#fff', color: '#1967d2', borderRadius: 9, padding: '9px 13px', fontWeight: 600, fontSize: 13.5, boxShadow: '0 12px 30px -10px rgba(26,115,232,.5)' }}>
              Accessorial: Detention <ChevronDown size={13} strokeWidth={2.4} />
            </div>

            {/* Detention popover */}
            <div className="pw-hide-sm" style={{ position: 'absolute', bottom: '21.9%', right: 24, width: 'min(38%,300px)', background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: '0 22px 50px -18px rgba(26,35,50,.45)', overflow: 'hidden' }}>
              <div style={{ padding: '13px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#202124' }}>Detention <span style={{ fontSize: 10, fontWeight: 600, color: '#1e8e3e', letterSpacing: '.04em' }}>APPROVED</span></span>
                  <span className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#202124' }}>$90</span>
                </div>
                <div style={{ fontSize: 11.5, color: '#5f6368', marginTop: 3 }}>3 hours detention, shipper</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid #f1f3f4', marginTop: 9, paddingTop: 8 }}>
                  <span style={{ fontSize: 11.5, color: '#5f6368' }}>Total</span>
                  <span className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>$90</span>
                </div>
              </div>
            </div>

            {/* Accessorial highlight cards */}
            <div className="pw-acc">
              <AccCard Icon={FileText} iconBg="#f3e8fd" iconColor="#6941c6" title="Docs at a glance" desc="See which docs are present and which required ones are missing, right on the row." />
              <AccCard Icon={ChevronDown} iconBg="#e8f0fe" iconColor="#1967d2" title="Filter by accessorial" desc="Narrow the board to loads with a detention, lumper, or layover." />
              <AccCard Icon={Check} iconBg="#e6f4ea" iconColor="#1e8e3e" title="See approval status" desc="Hover any load for the breakdown and whether it’s approved." />
              <AccCard Icon={DollarSign} iconBg="#fef0e6" iconColor="#c5631e" title="Nothing under-billed" desc="Confirm every approved accessorial before it goes to Billing." />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Section B · The review queue ─────────────────────────────────────────

function Caption({ Icon, iconBg, iconColor, title, sub }: {
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  iconBg: string; iconColor: string; title: string; sub: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 36, height: 36, flex: 'none', borderRadius: 10, background: iconBg, color: iconColor, display: 'grid', placeItems: 'center' }}>
        <Icon size={17} style={{ color: iconColor }} strokeWidth={2.4} />
      </span>
      <div>
        <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124' }}>{title}</div>
        <div style={{ fontSize: 12.5, color: '#5f6368' }}>{sub}</div>
      </div>
    </div>
  );
}

function ReviewQueue() {
  return (
    <section style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '90px 0' }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 700 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1e8e3e' }}>The review queue</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Verify side by side. Clear the queue. Release to Billing.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0' }}>Open a delivered load and the POD sits next to the rate con and the stops. FleetCal gives each load a verdict, so you press R to release a clean one, F to flag what needs follow-up, or skip and keep moving. Released loads hand off to <BillingLink>Billing</BillingLink> automatically.</p>
        </Reveal>

        <Reveal>
          <div style={{ position: 'relative', marginTop: 34, border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', boxShadow: 'var(--shadow-soft)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/paperwork-sidebyside.png" alt="Load closeout: rate con and POD side by side with the ready-to-release verdict" style={{ display: 'block', width: '100%', height: 'auto' }} />
            <div style={{ position: 'absolute', bottom: 18, left: 20, display: 'inline-flex', alignItems: 'center', gap: 9, background: '#fff', color: '#202124', fontWeight: 600, fontSize: 13.5, padding: '9px 14px', borderRadius: 999, boxShadow: '0 6px 16px -4px rgba(60,64,67,.3)' }} className="font-display">
              <span style={{ width: 8, height: 8, borderRadius: 999, background: '#1e8e3e' }} /> Rate con &amp; POD, side by side
            </div>
          </div>
        </Reveal>

        <Reveal>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center" style={{ marginTop: 24 }}>
            <FlagModal />
            <div style={{ display: 'grid', gap: 22 }}>
              <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 1px 2px rgba(60,64,67,.08)', padding: '22px 24px', display: 'grid', gap: 16 }}>
                <Caption Icon={Play} iconBg="#e6f4ea" iconColor="#1e8e3e" title="Two keys clear the stack" sub="Try it: hover and press R, F, or →" />
                <div style={{ height: 1, background: '#eef1f4' }} />
                <Caption Icon={Flag} iconBg="#fef7e0" iconColor="#b06000" title="Flag anything that isn’t ready" sub="Pick a reason, add a note, set a priority." />
              </div>
              <ReviewQueueCard />
            </div>
          </div>
        </Reveal>

        <Reveal>
          <Link href="/product/billing" style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 24, background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, padding: '20px 24px', textDecoration: 'none', boxShadow: '0 1px 2px rgba(60,64,67,.10)' }}>
            <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 12, background: '#e8f0fe', color: '#1967d2', display: 'grid', placeItems: 'center' }}>
              <CreditCard size={21} strokeWidth={2.2} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#1967d2' }}>Next step</div>
              <div className="font-display" style={{ fontWeight: 700, fontSize: 18, color: '#202124', marginTop: 3 }}>Released loads are ready to invoice in Billing</div>
              <div style={{ fontSize: 14, color: '#5f6368', marginTop: 2 }}>Every load you release here lands in the Billing module, already verified and complete.</div>
            </div>
            <span className="font-display" style={{ fontWeight: 600, fontSize: 15, color: '#1967d2', whiteSpace: 'nowrap' }}>Explore Billing →</span>
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────

function FinalCta({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section style={{ background: 'var(--gc-blue)', color: '#fff' }}>
      <div className={`${WRAP} text-center`} style={{ paddingTop: 92, paddingBottom: 92 }}>
        <Reveal>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)' }}>Get started</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(32px, 4.5vw, 52px)', lineHeight: 1.06, letterSpacing: '-0.022em', margin: '16px auto 0', maxWidth: 720 }}>
            Bill clean loads <span style={{ color: '#202124' }}>the day they deliver.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. Verify, flag, and release without leaving the keyboard, then invoice in Billing.
          </p>
          <div style={{ display: 'flex', gap: 13, justifyContent: 'center', marginTop: 32, flexWrap: 'wrap' }}>
            <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#1967d2', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
              {cta.label.replace(' →', '')}
            </Link>
            <Link href="/product/billing" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center', background: 'rgba(255,255,255,0.14)', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              See the Billing module →
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Footer ──────────────────────────────────────────────────────────────

function Footer() {
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
    ['Product', [
      ['Payroll',   '/product/payroll'],
      ['Dashboard', '/product/dashboard'],
      ['Paperwork', '/product/paperwork'],
      ['Billing',   '/product/billing'],
      ['Pricing',   '/#pricing'],
    ]],
    ['Company', [
      ['Why FleetCal',  '/#story'],
      ['Contact sales', '/contact-sales'],
      ['Support',       '/support'],
    ]],
    ['Account', [
      ['Sign in', '/sign-in'],
      ['Sign up', '/sign-up'],
      ['Home',    '/'],
    ]],
  ];
  return (
    <footer style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed' }}>
      <div className={`${WRAP} grid gap-10 pt-12 pb-9 grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1fr]`}>
        <div className="col-span-2 md:col-span-1">
          <Image src="/logo-horizontal.png" alt="FleetCal" width={140} height={32} style={{ height: 32, width: 'auto', objectFit: 'contain', display: 'block' }} />
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: '#5f6368', marginTop: 18, maxWidth: 260 }}>
            The dispatch-to-invoice TMS built by a carrier, for fleets like yours.
          </p>
        </div>
        {cols.map(([title, links]) => (
          <div key={title}>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#3c4043', marginBottom: 16 }}>{title}</div>
            {links.map(([l, href]) => (
              <Link key={l} href={href} style={{ display: 'block', fontSize: 15, color: '#5f6368', textDecoration: 'none', padding: '6px 0' }}>{l}</Link>
            ))}
          </div>
        ))}
      </div>
      <div className={`${WRAP} flex flex-wrap justify-between gap-3 py-[22px]`} style={{ borderTop: '1px solid #e8eaed' }}>
        <span className="font-mono" style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>
          © {new Date().getFullYear()} FleetCal · Built in Salt Lake City
        </span>
        <div style={{ display: 'flex', gap: 24 }}>
          <Link href="/privacy" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Privacy</Link>
          <Link href="/terms" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Terms</Link>
        </div>
      </div>
    </footer>
  );
}
