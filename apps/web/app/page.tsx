import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { Truck, FileText, MapPin, Receipt, Send, Wallet, BarChart3, Check, Play } from 'lucide-react';
import PricingCards from '@/components/marketing/PricingCards';
import MarketingNav from '@/components/marketing/MarketingNav';
import FaqAccordion from '@/components/marketing/FaqAccordion';
import Reveal from '@/components/marketing/Reveal';

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
 * Design language is the Google-Workspace look:
 *   - Figtree headlines (font-display) + Hanken Grotesk body (font-sys)
 *   - Pill buttons, rounded-3xl cards, soft Material elevation
 *   - Material palette: blue primary + multicolor feature accents
 *   - Section rhythm: white → grey band → white, hairline separators
 *
 * Light mode only — marketing pages should not respect the dashboard's
 * dark-mode preference. The visual identity is light-by-design.
 *
 * Interactivity is broken into client islands under
 * `components/marketing/*` (Reveal, MarketingNav, FaqAccordion,
 * PricingCards), so this file can stay an async server component
 * with `auth()` access for the 3-state CTA logic below.
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
  const cta = ctaFor(state);

  return (
    <div
      data-marketing-scroll
      className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary"
      style={{ scrollBehavior: 'smooth' }}
    >
      <MarketingNav cta={cta} showSignIn={state === 'out'} />
      <Hero cta={cta} />
      <TrustBand />
      <Features />
      <HowItWorks />
      <Pricing />
      <Story />
      <Faq />
      <FinalCta cta={cta} />
      <Footer />
    </div>
  );
}

type AuthCta = 'out' | 'mid-signup' | 'in';

/** Resolves the marketing CTA href + label for the given auth state. */
function ctaFor(state: AuthCta): { href: string; label: string } {
  if (state === 'in')         return { href: '/calendar', label: 'Open FleetCal →' };
  if (state === 'mid-signup') return { href: '/sign-up',  label: 'Continue setup →' };
  return                              { href: '/sign-up',  label: 'Start free trial' };
}

// ── Building blocks ─────────────────────────────────────────────────────

const WRAP = 'mx-auto max-w-[1160px] px-8';

/** Mac-style browser frame around a product placeholder. Real
 *  screenshots drop into the `<children>` slot once shipped. */
function Frame({ url = 'app.fleetcal.com/calendar', children }: { url?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background:   '#fff',
        borderRadius: 16,
        boxShadow:    'var(--shadow-soft)',
        overflow:     'hidden',
        border:       '1px solid #e8eaed',
      }}
    >
      <div
        style={{
          height:         42,
          background:     '#fff',
          borderBottom:   '1px solid #e8eaed',
          display:        'flex',
          alignItems:     'center',
          gap:            7,
          padding:        '0 16px',
        }}
      >
        <span style={{ width: 11, height: 11, borderRadius: 999, background: '#ff5f57' }} />
        <span style={{ width: 11, height: 11, borderRadius: 999, background: '#febc2e' }} />
        <span style={{ width: 11, height: 11, borderRadius: 999, background: '#28c840' }} />
        <span
          className="font-mono"
          style={{
            marginLeft:    12,
            height:        24,
            flex:          1,
            maxWidth:      340,
            background:    '#f8f9fa',
            borderRadius:  999,
            display:       'flex',
            alignItems:    'center',
            padding:       '0 14px',
            fontSize:      11,
            color:         '#5f6368',
          }}
        >
          {url}
        </span>
      </div>
      {children}
    </div>
  );
}

function Placeholder({ label, height }: { label: string; height: number }) {
  return (
    <div
      style={{
        position:  'relative',
        height,
        background: 'repeating-linear-gradient(135deg, rgba(26,115,232,0.045) 0 14px, rgba(26,115,232,0) 14px 28px), #f8f9fa',
        display:   'grid',
        placeItems: 'center',
      }}
    >
      <span
        className="font-mono"
        style={{
          fontSize:       12,
          fontWeight:     600,
          color:          '#5f6368',
          textTransform:  'uppercase',
          letterSpacing:  '0.08em',
          background:     '#fff',
          border:         '1px dashed #dadce0',
          padding:        '9px 15px',
          borderRadius:   8,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="font-mono"
      style={{
        fontSize:       12,
        fontWeight:     600,
        letterSpacing:  '0.14em',
        textTransform:  'uppercase',
        color:          '#1967d2',
      }}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="font-display"
      style={{
        fontWeight:    800,
        fontSize:      'clamp(30px, 4vw, 46px)',
        lineHeight:    1.06,
        margin:        '14px 0 0',
        letterSpacing: '-0.022em',
        color:         '#202124',
      }}
    >
      {children}
    </h2>
  );
}

function SectionSub({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize:   18,
        lineHeight: 1.6,
        color:      '#5f6368',
        margin:     '16px 0 0',
      }}
    >
      {children}
    </p>
  );
}

// ── Sections ────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section
      id="top"
      style={{
        background:    'radial-gradient(ellipse 70% 90% at 88% 0%, #e8f0fe 0%, #fff 60%)',
        paddingTop:    72,
        paddingBottom: 84,
      }}
    >
      <div
        className={WRAP}
        style={{
          display:             'grid',
          gridTemplateColumns: '1fr 1.06fr',
          gap:                 64,
          alignItems:          'center',
        }}
      >
        <div>
          <Reveal>
            <span
              className="inline-flex items-center gap-2 font-display"
              style={{
                fontSize:     13,
                fontWeight:   600,
                color:        '#1967d2',
                background:   '#e8f0fe',
                padding:      '7px 16px 7px 13px',
                borderRadius: 999,
              }}
            >
              <span
                style={{
                  width:        7,
                  height:       7,
                  borderRadius: 999,
                  background:   '#1e8e3e',
                  boxShadow:    '0 0 0 3px rgba(30,142,62,0.18)',
                }}
              />
              Built &amp; used daily at a 13-truck carrier
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1
              className="font-display"
              style={{
                fontWeight:    800,
                fontSize:      'clamp(36px, 5vw, 60px)',
                lineHeight:    1.05,
                margin:        '22px 0 0',
                letterSpacing: '-0.022em',
              }}
            >
              Your whole dispatch desk on{' '}
              <span style={{ color: 'var(--gc-blue)' }}>one calendar.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p
              style={{
                fontSize:   18.5,
                lineHeight: 1.6,
                color:      '#5f6368',
                maxWidth:   480,
                margin:     '20px 0 0',
              }}
            >
              Drop a rate-con PDF. Dispatch the load. Verify the POD. Send the invoice.
              Pay the driver. Every step where it should be — no leaving the app.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 32 }}>
              <Link
                href={cta.href}
                className="font-display"
                style={{
                  display:        'inline-flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  gap:            8,
                  background:     'var(--gc-blue)',
                  color:          '#fff',
                  fontWeight:     600,
                  fontSize:       17,
                  padding:        '17px 34px',
                  borderRadius:   999,
                  textDecoration: 'none',
                  boxShadow:      'var(--shadow-1)',
                  transition:     'background .2s, box-shadow .2s',
                  whiteSpace:     'nowrap',
                }}
              >
                {cta.label.replace(' →', '')}
              </Link>
              <Link
                href="#how"
                className="font-display"
                style={{
                  display:        'inline-flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  gap:            10,
                  background:     'transparent',
                  color:          '#1967d2',
                  fontWeight:     600,
                  fontSize:       17,
                  padding:        '17px 28px 17px 8px',
                  borderRadius:   999,
                  textDecoration: 'none',
                  transition:     'background .2s, padding .2s',
                  whiteSpace:     'nowrap',
                }}
              >
                <span
                  style={{
                    width:        26,
                    height:       26,
                    borderRadius: 999,
                    background:   '#e8f0fe',
                    display:      'grid',
                    placeItems:   'center',
                  }}
                >
                  <Play size={11} fill="#1a73e8" style={{ color: '#1a73e8' }} />
                </span>
                See how it works
              </Link>
            </div>
          </Reveal>
          <Reveal delay={240}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginTop: 38 }}>
              <div style={{ display: 'flex' }}>
                {[['#ea4335', 'JC'], ['#1e8e3e', 'MR'], ['#f9ab00', 'TK'], ['#1a73e8', 'SD']].map(([bg, t]) => (
                  <span
                    key={t}
                    className="font-display"
                    style={{
                      width:        34,
                      height:       34,
                      borderRadius: 999,
                      border:       '2px solid #fff',
                      marginLeft:   -9,
                      display:      'grid',
                      placeItems:   'center',
                      background:   bg,
                      color:        '#fff',
                      fontWeight:   700,
                      fontSize:     12,
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
              <span style={{ fontSize: 14.5, color: '#5f6368', fontWeight: 500 }}>
                Run by dispatchers at real carriers
              </span>
            </div>
          </Reveal>
        </div>

        <Reveal delay={140}>
          <div style={{ position: 'relative' }}>
            <Frame url="app.fleetcal.com/calendar">
              <Placeholder label="Dispatch calendar — screenshot" height={400} />
            </Frame>
            {/* Floating "Delivered" chip — top-right */}
            <div
              style={{
                position:     'absolute',
                top:          -24,
                right:        -14,
                background:   '#fff',
                borderRadius: 16,
                boxShadow:    'var(--shadow-3)',
                padding:      '14px 16px',
                border:       '1px solid #e8eaed',
                display:      'flex',
                alignItems:   'center',
                gap:          11,
              }}
            >
              <span
                style={{
                  width:        32,
                  height:       32,
                  borderRadius: 999,
                  background:   '#e6f4ea',
                  display:      'grid',
                  placeItems:   'center',
                }}
              >
                <Check size={16} strokeWidth={3} style={{ color: '#1e8e3e' }} />
              </span>
              <div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#202124' }}>Delivered</div>
                <div style={{ fontSize: 11.5, color: '#5f6368' }}>Load #4471 · POD verified</div>
              </div>
            </div>
            {/* Floating "Invoice sent" chip — bottom-left */}
            <div
              style={{
                position:     'absolute',
                bottom:       -22,
                left:         -18,
                background:   '#fff',
                borderRadius: 16,
                boxShadow:    'var(--shadow-3)',
                padding:      '14px 16px',
                border:       '1px solid #e8eaed',
                display:      'flex',
                alignItems:   'center',
                gap:          11,
              }}
            >
              <span
                style={{
                  width:        32,
                  height:       32,
                  borderRadius: 999,
                  background:   '#e8f0fe',
                  display:      'grid',
                  placeItems:   'center',
                }}
              >
                <Send size={14} style={{ color: '#1a73e8' }} />
              </span>
              <div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#202124' }}>Invoice sent</div>
                <div style={{ fontSize: 11.5, color: '#5f6368' }}>$3,250 · just now</div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function TrustBand() {
  const stats: ReadonlyArray<[string, string]> = [
    ['13',       'trucks run on it daily'],
    ['3 clicks', 'POD to sent invoice'],
    ['$0',       'per-driver fees, ever'],
    ['14 days',  'free, no card needed'],
  ];
  return (
    <section style={{ borderTop: '1px solid #e8eaed', borderBottom: '1px solid #e8eaed', background: '#f8f9fa' }}>
      <div
        className={WRAP}
        style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap:                 24,
          padding:             '34px 32px',
        }}
      >
        {stats.map(([n, l], i) => (
          <Reveal key={l} delay={i * 70} style={{ textAlign: 'center' }}>
            <div
              className="font-display"
              style={{
                fontWeight: 800,
                fontSize:   30,
                color:      '#202124',
                letterSpacing: '-0.022em',
              }}
            >
              {n}
            </div>
            <div style={{ fontSize: 14, color: '#5f6368', marginTop: 4 }}>{l}</div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

interface Feature {
  n:      string;
  Icon:   React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  color:  string;
  light:  string;
  title:  string;
  body:   string;
  ai?:    boolean;
}

const FEATURES: ReadonlyArray<Feature> = [
  { n: '01', Icon: Truck,    color: '#1a73e8', light: '#e8f0fe', title: 'Your whole fleet, one screen', body: 'Every truck gets its own column and color. See availability at a glance, then drag-and-drop to reassign loads when plans change.' },
  { n: '02', Icon: FileText, color: '#7c3aed', light: '#f3e8fd', title: 'Drop the rate con, go dispatch', body: 'Upload a rate con and AI extracts pickup, delivery, pay, and instructions automatically. Review, confirm, dispatch.', ai: true },
  { n: '03', Icon: MapPin,   color: '#1e8e3e', light: '#e6f4ea', title: 'Everything for the load, in one place', body: 'Geocoded P&D locations, mapped route, rate con viewer, and POD upload — all in the load detail. No tab switching.' },
  { n: '04', Icon: Receipt,  color: '#f97316', light: '#fef0e6', title: 'Close out loads fast', body: 'POD on one side, rate con on the other. Review the paperwork side-by-side and submit for billing in seconds.' },
  { n: '05', Icon: Send,     color: '#7c3aed', light: '#f3e8fd', title: 'Get paid faster', body: 'Send invoices one at a time or in bulk. AI reads customer-specific billing instructions from the rate con so nothing gets rejected.', ai: true },
  { n: '06', Icon: Wallet,   color: '#1e8e3e', light: '#e6f4ea', title: 'Payroll without the headache', body: 'Driver events auto-populate the weekly payroll page. Set default rates, make adjustments, close it out every Friday.' },
];

function AiPill() {
  return (
    <span
      className="font-display"
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          7,
        alignSelf:    'flex-start',
        whiteSpace:   'nowrap',
        marginTop:    22,
        fontSize:     12.5,
        fontWeight:   600,
        color:        '#7c3aed',
        background:   '#f3e8fd',
        padding:      '6px 13px',
        borderRadius: 999,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: '#7c3aed' }} />
      AI powered
    </span>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <div
      style={{
        background:    '#fff',
        border:        '1px solid #e8eaed',
        borderRadius:  24,
        padding:       '34px 32px',
        height:        '100%',
        display:       'flex',
        flexDirection: 'column',
        transition:    'box-shadow .25s, transform .25s',
      }}
    >
      <span
        style={{
          width:        52,
          height:       52,
          borderRadius: 15,
          display:      'grid',
          placeItems:   'center',
          background:   feature.light,
          flex:         'none',
        }}
      >
        <feature.Icon size={22} style={{ color: feature.color }} strokeWidth={2} />
      </span>
      <span
        className="font-mono"
        style={{
          display:        'block',
          fontSize:       12,
          fontWeight:     600,
          color:          '#5f6368',
          letterSpacing:  '0.1em',
          marginTop:      24,
        }}
      >
        {feature.n}
      </span>
      <h3
        className="font-display"
        style={{
          fontWeight:    700,
          fontSize:      21,
          lineHeight:    1.2,
          margin:        '8px 0 0',
          letterSpacing: '-0.022em',
          color:         '#202124',
        }}
      >
        {feature.title}
      </h3>
      <p style={{ fontSize: 15.5, lineHeight: 1.65, color: '#5f6368', margin: '12px 0 0' }}>
        {feature.body}
      </p>
      {feature.ai && <AiPill />}
    </div>
  );
}

function Features() {
  return (
    <section id="features" style={{ padding: '110px 0 100px', scrollMarginTop: 68 }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 720 }}>
          <SectionLabel>FleetCal MVP features</SectionLabel>
          <SectionTitle>
            Built by a carrier, <span style={{ color: 'var(--gc-blue)' }}>for carriers.</span>
          </SectionTitle>
          <SectionSub>
            Everything a small fleet needs to dispatch, verify, invoice, and pay — in one
            focused tool. No bloat, no enterprise pricing.
          </SectionSub>
        </Reveal>

        <div
          style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap:                 24,
            marginTop:           56,
          }}
        >
          {FEATURES.map((f, i) => (
            <Reveal key={f.n} delay={(i % 3) * 80}>
              <FeatureCard feature={f} />
            </Reveal>
          ))}

          {/* Wide 7th — Know your numbers */}
          <Reveal style={{ gridColumn: '1 / -1' }}>
            <div
              style={{
                background:   '#fff',
                border:       '1px solid #e8eaed',
                borderRadius: 28,
                padding:      '38px 40px',
                transition:   'box-shadow .25s, transform .25s',
              }}
            >
              <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
                <span
                  style={{
                    width:        52,
                    height:       52,
                    borderRadius: 15,
                    display:      'grid',
                    placeItems:   'center',
                    background:   '#fce8e6',
                    flex:         'none',
                  }}
                >
                  <BarChart3 size={22} style={{ color: '#ea4335' }} strokeWidth={2} />
                </span>
                <div>
                  <span
                    className="font-mono"
                    style={{
                      display:        'block',
                      fontSize:       12,
                      fontWeight:     600,
                      color:          '#5f6368',
                      letterSpacing:  '0.1em',
                    }}
                  >
                    07
                  </span>
                  <h3
                    className="font-display"
                    style={{
                      fontWeight:    700,
                      fontSize:      24,
                      margin:        '6px 0 0',
                      letterSpacing: '-0.022em',
                      color:         '#202124',
                    }}
                  >
                    Know your numbers
                  </h3>
                  <p
                    style={{
                      fontSize:   16,
                      lineHeight: 1.65,
                      color:      '#5f6368',
                      margin:     '10px 0 0',
                      maxWidth:   720,
                    }}
                  >
                    Weekly performance by truck and driver, expense tracking, and custom
                    load reports. See which lanes, customers, and assets are actually
                    making you money.
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24, paddingLeft: 76 }}>
                {['Asset performance', 'Driver performance', 'Expense tracking', 'Custom load reports'].map(c => (
                  <span
                    key={c}
                    style={{
                      whiteSpace:   'nowrap',
                      fontSize:     13.5,
                      fontWeight:   500,
                      color:        '#3c4043',
                      background:   '#f8f9fa',
                      border:       '1px solid #e8eaed',
                      padding:      '9px 16px',
                      borderRadius: 999,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps: ReadonlyArray<[string, string, string]> = [
    ['01', 'Drop the rate-con',  'Upload the PDF. FleetCal reads the customer, rate, stops and times.'],
    ['02', 'Dispatch the load',  'Assign a truck and driver on the calendar. Status flips automatically.'],
    ['03', 'Verify the POD',     'Driver uploads paperwork from the app. Review it in the closeout queue.'],
    ['04', 'Invoice & pay',      'Send the invoice, mark it paid, and payroll totals are already waiting.'],
  ];
  return (
    <section
      id="how"
      style={{
        padding:       '100px 0',
        background:    '#f8f9fa',
        borderTop:     '1px solid #e8eaed',
        borderBottom:  '1px solid #e8eaed',
        scrollMarginTop: 68,
      }}
    >
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 640 }}>
          <SectionLabel>How it works</SectionLabel>
          <SectionTitle>One flow, start to finish.</SectionTitle>
          <SectionSub>The same path every load takes — without a single spreadsheet or re-keyed number.</SectionSub>
        </Reveal>
        <div
          style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap:                 20,
            marginTop:           52,
          }}
        >
          {steps.map(([n, t, b], i) => (
            <Reveal key={n} delay={i * 90}>
              <div>
                <div
                  className="font-display"
                  style={{
                    fontWeight:   800,
                    fontSize:     18,
                    color:        '#fff',
                    width:        44,
                    height:       44,
                    borderRadius: 999,
                    background:   'var(--gc-blue)',
                    display:      'grid',
                    placeItems:   'center',
                    boxShadow:    'var(--shadow-1)',
                  }}
                >
                  {n}
                </div>
                <h3
                  className="font-display"
                  style={{
                    fontWeight:    700,
                    fontSize:      19,
                    margin:        '20px 0 0',
                    letterSpacing: '-0.022em',
                    color:         '#202124',
                  }}
                >
                  {t}
                </h3>
                <p style={{ fontSize: 15, lineHeight: 1.6, color: '#5f6368', margin: '10px 0 0' }}>{b}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" style={{ padding: '110px 0 100px', scrollMarginTop: 68 }}>
      <div className={WRAP}>
        <Reveal style={{ textAlign: 'center', maxWidth: 680, margin: '0 auto' }}>
          <SectionLabel>Pricing</SectionLabel>
          <SectionTitle>
            Priced by fleet size.
            <br />
            <span style={{ color: '#5f6368' }}>Same product at every tier.</span>
          </SectionTitle>
          <SectionSub>
            14-day free trial on every plan. No credit card to start, no per-driver
            surcharges, no annual lock-in.
          </SectionSub>
        </Reveal>
        <Reveal delay={60}>
          <PricingCards />
        </Reveal>
      </div>
    </section>
  );
}

function Story() {
  return (
    <section
      id="story"
      style={{
        padding:       '100px 0',
        background:    '#f8f9fa',
        borderTop:     '1px solid #e8eaed',
        borderBottom:  '1px solid #e8eaed',
        scrollMarginTop: 68,
      }}
    >
      <div
        className={WRAP}
        style={{
          display:             'grid',
          gridTemplateColumns: '1fr 1.1fr',
          gap:                 72,
          alignItems:          'center',
        }}
      >
        <Reveal>
          <SectionLabel>Built by carriers</SectionLabel>
          <SectionTitle>
            Made by people who&apos;ve actually{' '}
            <span style={{ color: 'var(--gc-blue)' }}>run a dispatch desk.</span>
          </SectionTitle>
          <div
            style={{
              marginTop:    32,
              background:   '#fff',
              border:       '1px solid #e8eaed',
              borderRadius: 24,
              padding:      '26px 28px',
              display:      'flex',
              gap:          18,
              alignItems:   'center',
              boxShadow:    'var(--shadow-card)',
            }}
          >
            <div
              className="font-display"
              style={{
                width:        56,
                height:       56,
                borderRadius: 999,
                flex:         'none',
                background:   '#e8f0fe',
                display:      'grid',
                placeItems:   'center',
                color:        '#1967d2',
                fontWeight:   800,
                fontSize:     18,
              }}
            >
              CT
            </div>
            <div>
              <div className="font-display" style={{ fontWeight: 700, fontSize: 16, color: '#202124' }}>
                Curzon Trucking
              </div>
              <div style={{ fontSize: 14, color: '#5f6368' }}>
                13-truck reefer carrier · Salt Lake City
              </div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div
            style={{
              fontSize:   17.5,
              lineHeight: 1.85,
              color:      '#3c4043',
              display:    'grid',
              gap:        20,
            }}
          >
            <p>
              FleetCal was built at{' '}
              <strong style={{ color: '#202124' }}>Curzon Trucking</strong>, a 13-truck
              reefer carrier. The first version replaced a dispatch whiteboard. Then came
              a POD queue. Then invoicing. Then payroll.
            </p>
            <p>
              Every feature exists because someone yelled across the dispatch office for
              it. No design committee, no UX consultancy, no &ldquo;competitive feature
              parity&rdquo; spreadsheet driving the roadmap — just the actual work of
              running freight.
            </p>
            <p
              className="font-display"
              style={{
                fontSize:    20,
                fontWeight:  600,
                color:       '#202124',
                borderLeft:  '3px solid var(--gc-blue)',
                paddingLeft: 20,
              }}
            >
              &ldquo;If you&apos;ve ever paid for a TMS clearly built by someone
              who&apos;s never sat next to a dispatcher at 6am, you&apos;ll feel the
              difference.&rdquo;
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const FAQS = [
  { q: 'Do I have to switch ELD providers?',           a: "No. FleetCal has no ELD lock-in — keep whatever ELD and telematics you already run. We integrate where it helps and stay out of the way where it doesn't." },
  { q: 'Is there a per-driver or per-seat fee?',       a: 'Never. You pay one flat monthly price based on your truck count. Add as many dispatchers, drivers, and office staff as you need at no extra cost.' },
  { q: 'How does the free trial work?',                a: "14 days free on every plan, no credit card required to start. Set up your fleet, run real loads, and decide once you've seen it on your own freight." },
  { q: 'Can I bring my existing loads and customers over?', a: "Yes. You can import your current loads, customers, drivers, and equipment so you're not starting from an empty calendar on day one." },
  { q: 'Who is FleetCal built for?',                   a: 'Small to mid-size carriers running roughly 1–14 trucks — owner-operators acting as their own dispatcher up through fleets where dispatch is its own department.' },
  { q: 'What if I grow past 14 trucks?',               a: "Reach out to sales and we'll set you up with a plan sized to your fleet. The product is the same — only the truck cap changes." },
] as const;

function Faq() {
  return (
    <section style={{ padding: '110px 0' }}>
      <div
        className={WRAP}
        style={{
          display:             'grid',
          gridTemplateColumns: '0.8fr 1.4fr',
          gap:                 64,
          alignItems:          'start',
        }}
      >
        <Reveal>
          <SectionLabel>FAQ</SectionLabel>
          <SectionTitle>Questions, answered.</SectionTitle>
          <SectionSub>
            Still not sure?{' '}
            <Link
              href="mailto:matt@curzontrucking.com"
              style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}
            >
              Talk to a human →
            </Link>
          </SectionSub>
        </Reveal>
        <Reveal delay={80}>
          <FaqAccordion items={FAQS as unknown as { q: string; a: string }[]} />
        </Reveal>
      </div>
    </section>
  );
}

function FinalCta({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section style={{ background: 'var(--gc-blue)', color: '#fff' }}>
      <div className={WRAP} style={{ padding: '100px 32px', textAlign: 'center' }}>
        <Reveal>
          <span
            className="font-mono"
            style={{
              fontSize:       12,
              fontWeight:     600,
              letterSpacing:  '0.14em',
              textTransform:  'uppercase',
              color:          'rgba(255,255,255,0.72)',
            }}
          >
            Get started
          </span>
          <h2
            className="font-display"
            style={{
              fontWeight:    800,
              fontSize:      'clamp(32px, 4.5vw, 56px)',
              lineHeight:    1.06,
              margin:        '16px auto 0',
              maxWidth:      760,
              letterSpacing: '-0.022em',
            }}
          >
            See your loads on a calendar that{' '}
            <span style={{ color: 'rgba(255,255,255,0.7)' }}>
              actually fits how you dispatch.
            </span>
          </h2>
          <p
            style={{
              fontSize:   18.5,
              lineHeight: 1.6,
              color:      'rgba(255,255,255,0.85)',
              maxWidth:   540,
              margin:     '22px auto 0',
            }}
          >
            14 days free. No sales call. Sign up and you&apos;re in.
          </p>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 34, flexWrap: 'wrap' }}>
            <Link
              href={cta.href}
              className="font-display"
              style={{
                display:        'inline-flex',
                alignItems:     'center',
                justifyContent: 'center',
                background:     '#fff',
                color:          '#1967d2',
                fontWeight:     600,
                fontSize:       17,
                padding:        '17px 34px',
                borderRadius:   999,
                textDecoration: 'none',
                boxShadow:      'var(--shadow-1)',
                transition:     'box-shadow .2s',
                whiteSpace:     'nowrap',
              }}
            >
              {cta.label.replace(' →', '')}
            </Link>
            <Link
              href="#pricing"
              className="font-display"
              style={{
                display:        'inline-flex',
                alignItems:     'center',
                justifyContent: 'center',
                background:     'rgba(255,255,255,0.14)',
                color:          '#fff',
                fontWeight:     600,
                fontSize:       17,
                padding:        '17px 34px',
                borderRadius:   999,
                textDecoration: 'none',
                transition:     'background .2s',
                whiteSpace:     'nowrap',
              }}
            >
              See pricing
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
    ['Product', [['Features', '#features'], ['How it works', '#how'], ['Pricing', '#pricing'], ['Mobile app', '#features']]],
    ['Company', [['Why FleetCal', '#story'], ['Built by carriers', '#story'], ['Contact sales', 'mailto:matt@curzontrucking.com'], ['Careers', '#story']]],
    ['Support', [['Help center', 'mailto:matt@curzontrucking.com'], ['Sign in', '/sign-in'], ['System status', '#'], ['Contact us', 'mailto:matt@curzontrucking.com']]],
  ];
  return (
    <footer style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed' }}>
      <div
        className={WRAP}
        style={{
          padding:             '64px 32px 36px',
          display:             'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
          gap:                 40,
        }}
      >
        <div>
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={140}
            height={32}
            style={{ height: 32, width: 'auto', objectFit: 'contain', display: 'block' }}
          />
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: '#5f6368', marginTop: 18, maxWidth: 260 }}>
            The dispatch-to-invoice TMS built by a 13-truck carrier, for fleets like yours.
          </p>
        </div>
        {cols.map(([title, links]) => (
          <div key={title}>
            <div
              className="font-display"
              style={{
                fontWeight:    700,
                fontSize:      13,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color:         '#3c4043',
                marginBottom:  16,
              }}
            >
              {title}
            </div>
            {links.map(([l, href]) => (
              <Link
                key={l}
                href={href}
                style={{
                  display:        'block',
                  fontSize:       15,
                  color:          '#5f6368',
                  textDecoration: 'none',
                  padding:        '6px 0',
                  transition:     'color .15s',
                }}
              >
                {l}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div
        className={WRAP}
        style={{
          padding:        '22px 32px',
          borderTop:      '1px solid #e8eaed',
          display:        'flex',
          flexWrap:       'wrap',
          justifyContent: 'space-between',
          gap:            12,
        }}
      >
        <span
          className="font-mono"
          style={{
            fontSize:       12,
            letterSpacing:  '0.08em',
            textTransform:  'uppercase',
            color:          '#5f6368',
          }}
        >
          © {new Date().getFullYear()} FleetCal · Built in Salt Lake City
        </span>
        <div style={{ display: 'flex', gap: 24 }}>
          <Link href="#" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Privacy</Link>
          <Link href="#" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Terms</Link>
        </div>
      </div>
    </footer>
  );
}
