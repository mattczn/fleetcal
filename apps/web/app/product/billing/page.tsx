import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { ArrowLeft, Sparkles, FileText, Wallet, Send, X } from 'lucide-react';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';
import HeroVideo from '@/components/marketing/HeroVideo';
import HeroFeatureNav from '@/components/marketing/HeroFeatureNav';
import RoutingCard from '@/components/marketing/billing/RoutingCard';
import InvoiceDocsCard from '@/components/marketing/billing/InvoiceDocsCard';
import LifecycleCard from '@/components/marketing/billing/LifecycleCard';

/**
 * Billing (invoice & get paid) marketing feature page at `/product/billing`.
 * Public (same 3-state CTA rules as `/` and the other /product pages). Blue
 * accent, full-bleed hero. The step after Paperwork — links back to it. The
 * authed app for this is `/billing`. Light mode only.
 */
export default async function BillingMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div data-marketing-scroll className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary" style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} frostless />
      <Hero cta={cta} />
      <Pipeline />
      <Features />
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

const HERO_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'features', label: 'Billing pipeline' },
  { id: 'routing', label: 'AI routing' },
  { id: 'documents', label: 'Documents' },
  { id: 'track', label: 'Track to paid' },
];

function PaperworkLink({ children }: { children: React.ReactNode }) {
  return <Link href="/product/paperwork" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none', borderBottom: '1.5px solid rgba(26,115,232,.32)' }}>{children}</Link>;
}

// ── Hero ────────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <>
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(168,206,250,0.7) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #eef4fe 0%, #f6f9fe 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 48, minHeight: 'calc(100vh - 168px)' }}>
      <div className={`${WRAP} grid items-center gap-10 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.4fr]`}>
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#1967d2', background: '#e8f0fe', padding: '7px 16px 7px 13px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1a73e8', boxShadow: '0 0 0 3px rgba(26,115,232,0.18)' }} />
              Invoice &amp; get paid
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(38px, 4.6vw, 58px)', lineHeight: 1.04, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              Invoice a week&rsquo;s loads<br />in <span style={{ color: '#1a73e8' }}>one batch.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 480, margin: '20px 0 0' }}>
              Verified loads arrive from <PaperworkLink>Paperwork</PaperworkLink> already billing-ready. Select them, generate clean invoices, and send by email or customer portal in a single sweep. Track every dollar from released to paid.
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
              <HeroVideo src="/billing-demo.mp4" poster="/billing-demo-poster.png" width={1908} height={1080} ariaLabel="Batch invoicing: select released loads, generate and send invoices" />
            </div>
            <div className="hidden sm:flex" style={{ position: 'absolute', top: -15, right: -12, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 999, boxShadow: 'var(--shadow-3)', padding: '8px 14px', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: '#d93025' }} />
              <span className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>Live demo</span>
            </div>
          </div>
        </Reveal>
      </div>

    </section>
    <HeroFeatureNav items={HERO_TABS} sticky />
    </>
  );
}

// ── Section A · The billing pipeline (board + selection bar) ─────────────

function Pipeline() {
  return (
    <section id="features" style={{ padding: '90px 0 86px', scrollMarginTop: 150 }}>
      <style>{`@media (max-width: 879px){.bl-hide-sm{display:none!important}}`}</style>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 680 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>The billing pipeline</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>From released to paid, in one flow.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0' }}>Loads land in <strong style={{ color: '#202124' }}>Released</strong> the moment <PaperworkLink>Paperwork</PaperworkLink> marks them verified. Generate the invoice, send it, and watch it move to paid. Every bucket carries its own count and dollar total.</p>
        </Reveal>

        <Reveal>
          <div style={{ position: 'relative', marginTop: 34, border: '1px solid #e8eaed', borderRadius: 16, boxShadow: 'var(--shadow-soft)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/billing-board.png" alt="Billing board with released loads ready to invoice" style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 16 }} />

            <div className="bl-hide-sm" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: '5%', display: 'flex', alignItems: 'center', gap: 18, background: '#202124', color: '#fff', borderRadius: 14, padding: '12px 14px 12px 20px', boxShadow: '0 22px 50px -14px rgba(0,0,0,.5)', whiteSpace: 'nowrap' }}>
              <span className="font-display" style={{ fontWeight: 600, fontSize: 15 }}>4 selected <span style={{ color: '#9aa0a6', margin: '0 4px' }}>·</span> $3,345.00</span>
              <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff', color: '#1967d2', fontWeight: 600, fontSize: 14, padding: '10px 16px', borderRadius: 9 }}><FileText size={15} strokeWidth={2.2} /> Generate Invoice</span>
              <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#1a73e8', color: '#fff', fontWeight: 600, fontSize: 14, padding: '10px 16px', borderRadius: 9 }}><Send size={14} strokeWidth={2.2} /> Create &amp; Send</span>
              <span style={{ color: '#9aa0a6', display: 'grid', placeItems: 'center', padding: '0 4px' }}><X size={18} /></span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Section B · Features (three alternating rows) ───────────────────────

function FeatureRow({ id, Icon, iconBg, iconColor, kicker, title, body, card, flip }: {
  id: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  iconBg: string; iconColor: string; kicker: string; title: string; body: React.ReactNode;
  chips: ReadonlyArray<string>; card: React.ReactNode; flip?: boolean;
}) {
  return (
    <Reveal>
      <div id={id} style={{ scrollMarginTop: 150 }} className={`grid items-center gap-12 lg:gap-[60px] grid-cols-1 ${flip ? 'lg:grid-cols-[1.12fr_1fr]' : 'lg:grid-cols-[1fr_1.12fr]'}`}>
        <div className={flip ? 'order-1 lg:order-2' : 'order-1'}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 13, background: iconBg, color: iconColor, display: 'grid', placeItems: 'center' }}><Icon size={20} strokeWidth={2.2} /></span>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: iconColor, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{kicker}</span>
          </div>
          <h3 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(26px, 2.6vw, 33px)', lineHeight: 1.12, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124', maxWidth: 440 }}>{title}</h3>
          <p style={{ fontSize: 17.5, lineHeight: 1.65, color: '#5f6368', margin: '14px 0 0', maxWidth: 470 }}>{body}</p>
        </div>
        <div className={flip ? 'order-2 lg:order-1' : 'order-2'}>{card}</div>
      </div>
    </Reveal>
  );
}

function Features() {
  return (
    <section style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '92px 0' }}>
      <div className={`${WRAP} grid gap-24`}>
        <FeatureRow
          id="routing" Icon={Sparkles} iconBg="#f3e8fd" iconColor="#6941c6" kicker="AI invoice routing"
          title="No more digging through rate cons to follow billing instructions."
          body="FleetCal scans each customer's rate con for billing instructions and sets the right method automatically, whether that's email to their AP or a link into their online portal. Confirm or override, and it's saved for every future invoice."
          chips={['Email or portal', 'Reads the rate con', 'Saved per customer']}
          card={<RoutingCard />}
        />
        <FeatureRow
          id="documents" Icon={FileText} iconBg="#e8f0fe" iconColor="#1967d2" kicker="Invoice documents"
          title="Choose exactly which docs go on the invoice."
          body="Your org sets defaults for what's included on every invoice, so the right documents are attached automatically. Review the rate con, POD, and accessorial receipts right on the page and adjust the selection for any customer. What you select is what they receive."
          chips={['Review in page', 'Per-invoice selection']}
          card={<InvoiceDocsCard />}
          flip
        />
        <FeatureRow
          id="track" Icon={Wallet} iconBg="#e6f4ea" iconColor="#1e8e3e" kicker="Track to paid"
          title="Generate, send, regenerate, mark paid."
          body="Filter by accessorial, pickup date, or customer to find the right loads. Leave a note for later, regenerate and resend an invoice when something changes, and mark it paid the moment the money lands."
          chips={['Filter & note', 'Regenerate & resend', 'Mark paid']}
          card={<LifecycleCard />}
        />
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
            Invoice on delivery day. <span style={{ color: '#202124' }}>Get paid sooner.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. The whole dispatch-to-invoice loop in one place.
          </p>
          <div style={{ display: 'flex', gap: 13, justifyContent: 'center', marginTop: 32, flexWrap: 'wrap' }}>
            <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#1967d2', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
              {cta.label.replace(' →', '')}
            </Link>
            <Link href="/" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.14)', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Back to home
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
      ['Calendar',  '/product/calendar'],
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
