import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { Calendar, Percent, Plus, CornerDownRight, Check, ArrowLeft } from 'lucide-react';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';
import PayrollHeroCard from '@/components/marketing/payroll/PayrollHeroCard';
import ModifyPayCard from '@/components/marketing/payroll/ModifyPayCard';
import DeferCard from '@/components/marketing/payroll/DeferCard';

/**
 * Payroll & Insights marketing feature page at `/product/payroll`.
 *
 * Public (same 3-state CTA rules as the landing page `/`), linked from the
 * home page's payroll feature button + footer. Sibling of `app/page.tsx` —
 * deliberately built in the same visual language (Figtree/Hanken/mono,
 * --gc-* / --shadow-* tokens, MarketingNav + Reveal). The authed payroll APP
 * lives separately at `/payroll`; this is the sales page for that module.
 *
 * Built from design_handoff_payroll_page. Light mode only.
 */
export default async function PayrollMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div
      data-marketing-scroll
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{ scrollBehavior: 'smooth' }}
    >
      <MarketingNav cta={cta} showSignIn={state === 'out'} />
      <Hero cta={cta} />
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

// 1280px content cap + 28px gutter — matches the design handoff (narrower
// than the landing page's 1600px so the editorial feature rows read tight).
const WRAP = 'mx-auto w-full max-w-[1280px] px-7';

// ── Shared primitives ───────────────────────────────────────────────────

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500, color: '#3c4043', background: '#f8f9fa', border: '1px solid #e8eaed', padding: '7px 14px', borderRadius: 999 }}>
      {children}
    </span>
  );
}

function FeatureCopy({
  Icon, iconBg, accent, kicker, title, body, chips,
}: {
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  iconBg: string;
  accent: string;
  kicker: string;
  title: React.ReactNode;
  body: string;
  chips: ReadonlyArray<string>;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 46, height: 46, borderRadius: 13, background: iconBg, display: 'grid', placeItems: 'center', flex: 'none' }}>
          <Icon size={22} style={{ color: accent }} strokeWidth={2} />
        </span>
        <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: accent, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{kicker}</span>
      </div>
      <h3 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(26px, 2.6vw, 33px)', lineHeight: 1.12, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124', maxWidth: 440 }}>{title}</h3>
      <p style={{ fontSize: 17.5, lineHeight: 1.65, color: '#5f6368', margin: '14px 0 0', maxWidth: 470 }}>{body}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 22 }}>
        {chips.map(c => <Chip key={c}>{c}</Chip>)}
      </div>
    </div>
  );
}

// ── Hero ────────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(176,230,196,0.75) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #ecfaf1 0%, #f5fbf7 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 96, minHeight: 'calc(100vh - 68px)' }}>
      <div className={`${WRAP} grid items-center gap-12 lg:gap-[60px] grid-cols-1 lg:grid-cols-[1fr_1.18fr]`}>
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#1e8e3e', background: '#e6f4ea', padding: '7px 16px 7px 13px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1e8e3e', boxShadow: '0 0 0 3px rgba(30,142,62,0.18)' }} />
              Payroll &amp; Insights
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(40px, 4.8vw, 60px)', lineHeight: 1.04, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              Payroll that<br />manages <span style={{ color: '#1e8e3e' }}>itself.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 480, margin: '20px 0 0' }}>
              Every load event flows straight onto the weekly payroll page, with no line items to add by hand. Set a default driver-pay percentage, adjust any load, defer across the week, and finalize in minutes.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, marginTop: 32 }}>
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
          <PayrollHeroCard />
        </Reveal>
      </div>
    </section>
  );
}

// ── Features ────────────────────────────────────────────────────────────

/** Framed product screenshot with the inward hover-zoom (origin toward the
 *  page center so the scaled frame isn't clipped). */
function Screenshot({ src, alt, origin }: { src: string; alt: string; origin: 'left' | 'right' }) {
  return (
    <div
      className={`overflow-hidden transition-transform duration-[450ms] ease-[cubic-bezier(.2,.7,.3,1)] hover:scale-[1.06] ${origin === 'right' ? 'origin-right' : 'origin-left'}`}
      style={{ border: '1px solid #e8eaed', borderRadius: 16, boxShadow: 'var(--shadow-soft)' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} style={{ display: 'block', width: '100%', height: 'auto', background: '#f8f9fa' }} />
    </div>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: '88px 0 96px', borderTop: '1px solid #eef1f4', background: '#fff' }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 680, marginBottom: 60 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1e8e3e' }}>Every load, every week</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(30px, 4vw, 44px)', lineHeight: 1.06, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Four steps to payday.</h2>
        </Reveal>
        <div className="grid gap-[104px]">

        {/* 01 — Auto-fill (real Carlos report) */}
        <Reveal>
          <div className="grid items-center gap-12 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.32fr]">
            <FeatureCopy
              Icon={Calendar} iconBg="#e6f4ea" accent="#1e8e3e" kicker="Auto-filled"
              title="Every load is already on the payroll."
              body="As soon as a load is delivered on the calendar, it lands on that driver's week: date, lane, load number, miles, load value, and pay. No re-keying, no spreadsheet, no missed runs. Carlos drove 13 loads this week; all 13 are right here."
              chips={['Pulled from the calendar', 'Categorized by relay leg', 'Per-driver pay stub PDF']}
            />
            <div style={{ position: 'relative' }}>
              <Screenshot src="/payroll-carlos-report.png" alt="Carlos Ramirez weekly payroll report, 13 loads auto-filled" origin="right" />
              <div className="hidden sm:flex" style={{ position: 'absolute', top: -16, left: -14, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: 'var(--shadow-3)', padding: '11px 15px', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 30, height: 30, borderRadius: 999, background: '#1e8e3e', display: 'grid', placeItems: 'center' }}>
                  <Check size={15} strokeWidth={3} style={{ color: '#fff' }} />
                </span>
                <div>
                  <div className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>13 loads auto-filled</div>
                  <div style={{ fontSize: 11, color: '#5f6368' }}>Nothing added by hand</div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* 02 — Default pay settings (interactive Modify % card) — visual left */}
        <Reveal>
          <div className="grid items-center gap-12 lg:gap-16 grid-cols-1 lg:grid-cols-[1.32fr_1fr]">
            <div className="order-2 lg:order-1">
              <ModifyPayCard />
            </div>
            <div className="order-1 lg:order-2">
              <FeatureCopy
                Icon={Percent} iconBg="#e8f0fe" accent="#1967d2" kicker="Default pay settings"
                title="Set the percent once. Override anywhere."
                body="Pick a default driver-pay percentage and FleetCal applies it to every load. Need to bump a tough run or a relay leg? Change it right in the load details on the calendar, or adjust the whole week from the payroll page. The dollar amount recalculates instantly."
                chips={['Org-wide default', 'Per-load override', 'Flat $ or %']}
              />
            </div>
          </div>
        </Reveal>

        {/* 03 — Adjustments (real load-financials screenshot + adjustments card) */}
        <Reveal>
          <div className="grid items-center gap-12 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.32fr]">
            <FeatureCopy
              Icon={Plus} iconBg="#e6f4ea" accent="#1e8e3e" kicker="Adjustments"
              title="Accessorials, bonuses, and deductions, where they belong."
              body={'Whenever you request an accessorial like detention from a broker, just click "pay driver" and the amount is automatically added to the week’s pay stub. Add a safety bonus, fuel advance, or deduction in a couple of clicks.'}
              chips={['Detention & lumper', 'Bonus & deduction', 'Auto-matched by name']}
            />
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'relative', zIndex: 1, border: '1px solid #e8eaed', borderRadius: 14, overflow: 'hidden', boxShadow: 'var(--shadow-card)' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/payroll-load-financials.png" alt="Financial section inside the load modal, accessorial marked pay-to-driver" style={{ display: 'block', width: '100%', height: 'auto', background: '#f8f9fa' }} />
              </div>
              {/* Overlap the driver-adjustments card up onto the screenshot's
                  bottom edge — layered on top via z-index + its own shadow. */}
              <div style={{ position: 'relative', zIndex: 2, marginTop: -24 }}>
                <AdjustmentsCard />
              </div>
            </div>
          </div>
        </Reveal>

        {/* 04 — Defer (interactive Defer card) — visual left */}
        <Reveal>
          <div className="grid items-center gap-12 lg:gap-16 grid-cols-1 lg:grid-cols-[1.32fr_1fr]">
            <div className="order-2 lg:order-1">
              <DeferCard />
            </div>
            <div className="order-1 lg:order-2">
              <FeatureCopy
                Icon={CornerDownRight} iconBg="#f3e8fd" accent="#6941c6" kicker="Defer pay"
                title="Crossing the Saturday cutoff? Defer it."
                body="Over-the-road runs don't care about your Sat–Fri week. Push a load's pay into a future week and FleetCal writes a matched pair of adjustments, negative here and positive there, so both weeks reconcile cleanly. FleetCal even flags loads whose delivery spills into next week."
                chips={['Matched +/− pair', 'Spanning-load alerts', 'One-click undo']}
              />
            </div>
          </div>
        </Reveal>

        </div>
      </div>
    </section>
  );
}

/** Static driver-adjustments card under the load-financials screenshot. */
function AdjustmentsCard() {
  return (
    <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: 'var(--shadow-soft)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e8eaed', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span className="font-display" style={{ width: 34, height: 34, borderRadius: 999, background: '#1a73e81a', color: '#1a73e8', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 15 }}>C</span>
          <div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#1967d2' }}>Carlos Ramirez</div>
            <div style={{ fontSize: 12, color: '#5f6368' }}>13 loads · Jun 6 – Jun 12</div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>Driver pay</div>
          <div className="font-display" style={{ fontWeight: 800, fontSize: 18, color: '#1e8e3e' }}>$1,893.00</div>
        </div>
      </div>
      <div style={{ padding: '8px 20px 4px' }}>
        <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368', padding: '10px 0 8px' }}>Accessorials</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid #f1f3f4' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#1a73e8', background: '#1a73e81a', padding: '3px 9px', borderRadius: 999 }}>Detention</span>
          <span style={{ flex: 1, fontSize: 14, color: '#3c4043' }}>3 hours detention, shipper</span>
          <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#1e8e3e' }}>+$90.00</span>
        </div>
      </div>
      <div style={{ padding: '4px 20px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 8px' }}>
          <span className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>Adjustments</span>
          <span style={{ display: 'inline-flex', gap: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#1a73e8' }}><Plus size={13} strokeWidth={2.6} /> Add</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#5f6368' }}><CornerDownRight size={13} strokeWidth={2.4} /> Defer</span>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid #f1f3f4' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#1e8e3e', background: '#1e8e3e1a', padding: '3px 9px', borderRadius: 999 }}>Bonus</span>
          <span style={{ flex: 1, fontSize: 14, color: '#3c4043' }}>Safety Bonus</span>
          <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#1e8e3e' }}>+$150.00</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid #f1f3f4' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#d93025', background: '#d9302514', padding: '3px 9px', borderRadius: 999 }}>Deduction</span>
          <span style={{ flex: 1, fontSize: 14, color: '#3c4043' }}>Fuel advance to repay</span>
          <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#d93025' }}>−$120.00</span>
        </div>
      </div>
    </div>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────

function FinalCta({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section style={{ background: 'var(--gc-blue)', color: '#fff' }}>
      <div className={`${WRAP} text-center`} style={{ paddingTop: 96, paddingBottom: 96 }}>
        <Reveal>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)' }}>Get started</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(32px, 4.5vw, 54px)', lineHeight: 1.06, letterSpacing: '-0.022em', margin: '16px auto 0', maxWidth: 720 }}>
            Close the week in minutes, <span style={{ color: '#202124' }}>not hours.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. Your loads, already on the payroll.
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

// ── Footer (mirrors the landing footer; Product column carries Payroll) ──

function Footer() {
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
    ['Product', [
      ['Features',  '/#features'],
      ['Payroll',   '/product/payroll'],
      ['Dashboard', '/product/dashboard'],
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
