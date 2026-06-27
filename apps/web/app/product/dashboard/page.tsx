import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import MarketingNav from '@/components/marketing/MarketingNav';
import HeroFeatureNav from '@/components/marketing/HeroFeatureNav';
import ProductFlowFooter from '@/components/marketing/ProductFlowFooter';
import Reveal from '@/components/marketing/Reveal';
import DashboardHeroCard from '@/components/marketing/dashboard/DashboardHeroCard';
import ReportBuilderCard from '@/components/marketing/dashboard/ReportBuilderCard';

/**
 * Dashboard & Reports marketing feature page at `/product/dashboard`.
 *
 * Public (same 3-state CTA rules as `/` and `/product/payroll`), linked from
 * the home page's "Dashboard & reports" button + footer. Sibling of the
 * landing + payroll marketing pages — same visual language, blue accent. The
 * authed dashboard APP lives separately at `/dashboard`. Light mode only.
 */
export default async function DashboardMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div data-marketing-scroll className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary" style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} frostless />
      <Hero cta={cta} />
      <RevenueSources />
      <ReportsAndTrends />
      <ProductFlowFooter current="dashboard" />
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
  { id: 'revenue', label: 'Revenue' },
  { id: 'reports', label: 'Reports & trends' },
];

// ── Hero (full-bleed panel, like /product/payroll) ──────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <>
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(168,206,250,0.7) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #eef4fe 0%, #f6f9fe 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 48, minHeight: 'calc(100vh - 168px)' }}>
      <div className={`${WRAP} grid items-center gap-12 lg:gap-14 grid-cols-1 lg:grid-cols-[1fr_1.24fr]`}>
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#1967d2', background: '#e8f0fe', padding: '7px 16px 7px 13px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1a73e8', boxShadow: '0 0 0 3px rgba(26,115,232,0.18)' }} />
              Dashboard &amp; Reports
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(38px, 4.6vw, 58px)', lineHeight: 1.05, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              Know exactly what&rsquo;s <span style={{ color: '#1a73e8' }}>making money.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 480, margin: '20px 0 0' }}>
              Track revenue, driver pay, and margin across any timeframe. See which trucks, customers, and lanes pull their weight, then build the exact load report you need.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, marginTop: 30 }}>
              <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--gc-blue)', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
                {cta.label.replace(' →', '')}
              </Link>
              <Link href="/contact-sales" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#1967d2', border: '1px solid #dadce0', fontWeight: 600, fontSize: 17, padding: '15px 28px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                Book a demo
              </Link>
            </div>
          </Reveal>
        </div>

        <Reveal delay={140}>
          <DashboardHeroCard />
        </Reveal>
      </div>
    </section>
    <HeroFeatureNav items={HERO_TABS} sticky />
    </>
  );
}

// ── Revenue sources ─────────────────────────────────────────────────────

const TRUCKS: ReadonlyArray<{ id: string; name: string; color: string; barW: string; value: string; loads: string }> = [
  { id: '#1241', name: 'Puma',   color: '#6941c6', barW: '100%', value: '$7.7K', loads: '3 loads' },
  { id: '#4124', name: 'Snake',  color: '#12b5cb', barW: '99%',  value: '$7.6K', loads: '3.5 loads' },
  { id: '#1043', name: 'Eagle',  color: '#1a73e8', barW: '86%',  value: '$6.6K', loads: '15 loads' },
  { id: '#5205', name: 'Bison',  color: '#1e8e3e', barW: '84%',  value: '$6.5K', loads: '6.5 loads' },
  { id: '#3054', name: 'Badger', color: '#f97316', barW: '75%',  value: '$5.8K', loads: '4.5 loads' },
  { id: '#4124', name: 'Bobcat', color: '#7c8af0', barW: '70%',  value: '$5.4K', loads: '8.5 loads' },
  { id: '#4052', name: 'Tiger',  color: '#ea4335', barW: '69%',  value: '$5.3K', loads: '11 loads' },
];

const CUSTOMERS: ReadonlyArray<{ n: number; name: string; color: string; val: string }> = [
  { n: 1,  name: 'Arrive Logistics',        color: '#1a73e8', val: '$9.1K' },
  { n: 2,  name: 'Total Quality Logistics', color: '#1e8e3e', val: '$8.7K' },
  { n: 3,  name: 'GlobalTranz',             color: '#ea4335', val: '$5.1K' },
  { n: 4,  name: 'ITS Logistics',           color: '#f9ab00', val: '$4.6K' },
  { n: 5,  name: 'TCI Global Logistics',    color: '#a142f4', val: '$4.1K' },
  { n: 6,  name: 'Freight Tec',             color: '#12b5cb', val: '$3.8K' },
  { n: 7,  name: 'Redbone Logistics LLC',   color: '#f97316', val: '$3.4K' },
  { n: 8,  name: 'Cheema Logistics LLC',    color: '#e91e8c', val: '$2.4K' },
  { n: 9,  name: 'Ship Ardent',             color: '#0d652d', val: '$2.4K' },
  { n: 10, name: 'Redbone',                 color: '#9aa0a6', val: '$1.2K' },
];

const DONUT = 'conic-gradient(#1a73e8 0 20.3%, #1e8e3e 0 39.7%, #ea4335 0 51.1%, #f9ab00 0 61.4%, #a142f4 0 70.6%, #12b5cb 0 79.1%, #f97316 0 86.7%, #e91e8c 0 92.1%, #0d652d 0 97.5%, #9aa0a6 0 100%)';

function RevenueSources() {
  return (
    <section id="revenue" style={{ background: '#f8f9fa', borderBottom: '1px solid #e8eaed', padding: '88px 0', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 640 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1e8e3e' }}>Where the money comes from</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Revenue by Truck and by Customer</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0' }}>Know which assets earn and which idle, and which customers actually move the needle.</p>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-[22px]" style={{ marginTop: 38 }}>
          {/* Revenue by Truck */}
          <Reveal>
            <div className="feat-frame-shadow feat-left" style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, padding: '22px 24px', height: '100%' }}>
              <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124', marginBottom: 18 }}>Revenue by Truck</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {TRUCKS.map((t, i) => (
                  <div key={`${t.id}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ width: 96, flex: 'none', fontSize: 13, color: '#3c4043', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span style={{ color: '#9aa0a6' }}>{t.id}</span> · {t.name}</span>
                    <div style={{ flex: 1, height: 9, background: '#f1f3f4', borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: t.barW, background: t.color, borderRadius: 999 }} />
                    </div>
                    <span className="font-display" style={{ width: 48, flex: 'none', textAlign: 'right', fontWeight: 700, fontSize: 13, color: '#202124' }}>{t.value}</span>
                    <span style={{ width: 84, flex: 'none', textAlign: 'right', fontSize: 12, color: '#5f6368' }}>{t.loads}</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          {/* Revenue by Customer */}
          <Reveal delay={80}>
            <div className="feat-frame-shadow feat-right" style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, padding: '22px 24px', height: '100%' }}>
              <span className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124' }}>Revenue by Customer</span>
              <div className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-5 items-center" style={{ marginTop: 16 }}>
                <div style={{ display: 'grid', placeItems: 'center' }}>
                  <div style={{ width: 160, height: 160, borderRadius: 999, background: DONUT, display: 'grid', placeItems: 'center' }}>
                    <div style={{ width: 84, height: 84, borderRadius: 999, background: '#fff' }} />
                  </div>
                </div>
                <div>
                  <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#5f6368', marginBottom: 6 }}>Top customers by revenue</div>
                  {CUSTOMERS.map((c) => (
                    <div key={c.n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0' }}>
                      <span style={{ width: 14, flex: 'none', textAlign: 'right', fontSize: 11, color: '#9aa0a6' }}>{c.n}</span>
                      <span style={{ width: 8, height: 8, flex: 'none', borderRadius: 999, background: c.color }} />
                      <span style={{ flex: 1, fontSize: 13, color: '#3c4043', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                      <span className="font-display" style={{ flex: 'none', fontWeight: 700, fontSize: 13, color: '#202124' }}>{c.val}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ── Reports & trends (overlapping chart + report builder) ────────────────

const DAYS: ReadonlyArray<{ d: string; v: string; h: number }> = [
  { d: 'Sat', v: '$2.5K',  h: 26 },
  { d: 'Sun', v: '$1.6K',  h: 16 },
  { d: 'Mon', v: '$12.1K', h: 125 },
  { d: 'Tue', v: '$5.7K',  h: 59 },
  { d: 'Wed', v: '$10.8K', h: 111 },
  { d: 'Thu', v: '$4.2K',  h: 43 },
  { d: 'Fri', v: '$8.3K',  h: 85 },
];
const GRID = ['$20.0K', '$15.0K', '$10.0K', '$5.0K', '$0'];

function ReportsAndTrends() {
  return (
    <section id="reports" style={{ padding: '92px 0', scrollMarginTop: 150 }}>
      {/* Overlap: chart (76%) left, report builder (62%) pulled up over its
          bottom-right corner. Collapses to a stack below 880px. */}
      <style>{`.db-overlap > :first-child { width: 100%; } .db-overlap > :last-child { width: 100%; margin-top: 18px; } @media (min-width: 880px) { .db-overlap > :first-child { width: 76%; max-width: 920px; } .db-overlap > :last-child { width: 62%; margin-left: auto; margin-top: -68px; position: relative; z-index: 2; } }`}</style>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 680 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>Reports &amp; trends</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>Track the trend, then build the report.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0' }}>Watch revenue move across any timeframe, then slice the underlying loads into the exact report you need and export it to CSV or Excel.</p>
        </Reveal>

        <Reveal>
          <div className="db-overlap" style={{ marginTop: 42 }}>
            <div style={{ position: 'relative' }}>
              <div className="feat-frame-shadow feat-wide" style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, padding: '22px 24px' }}>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124', marginBottom: 18 }}>Revenue Over Time</div>
                <div style={{ position: 'relative', height: 230, paddingLeft: 46 }}>
                  {/* gridlines + y-axis */}
                  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 24, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    {GRID.map((lbl, i) => (
                      <div key={lbl} style={{ position: 'relative', borderTop: i === GRID.length - 1 ? '1px solid #e8eaed' : '1px dashed #e8eaed' }}>
                        <span style={{ position: 'absolute', left: 0, top: -7, fontSize: 10, color: '#9aa0a6' }}>{lbl}</span>
                      </div>
                    ))}
                  </div>
                  {/* bars */}
                  <div style={{ position: 'absolute', left: 46, right: 0, top: 0, bottom: 24, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                    {DAYS.map((day) => (
                      <div key={day.d} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                        <div className="font-display" style={{ fontWeight: 700, fontSize: 11, color: '#3c4043', marginBottom: 4 }}>{day.v}</div>
                        <div style={{ width: '100%', maxWidth: 78, height: day.h, background: '#1a73e8', borderRadius: '5px 5px 0 0' }} />
                      </div>
                    ))}
                  </div>
                  {/* day labels */}
                  <div style={{ position: 'absolute', left: 46, right: 0, bottom: 0, height: 18, display: 'flex', gap: 8 }}>
                    {DAYS.map((day) => (
                      <div key={day.d} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#5f6368' }}>{day.d}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <ReportBuilderCard />
          </div>
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
            Run your fleet on the <span style={{ color: '#202124' }}>numbers.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. See your whole business the moment you sign in.
          </p>
          <div style={{ display: 'flex', gap: 13, justifyContent: 'center', marginTop: 32, flexWrap: 'wrap' }}>
            <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#1967d2', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
              {cta.label.replace(' →', '')}
            </Link>
            <Link href="/contact-sales" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.14)', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
              Book a demo
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
      ['Features',  '/#features'],
      ['Calendar',  '/product/calendar'],
      ['Payroll',   '/product/payroll'],
      ['Dashboard', '/product/dashboard'],
      ['Paperwork', '/product/paperwork'],
      ['Billing',   '/product/billing'],
      ['Driver app', '/product/driver-app'],
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
