import { Fragment } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { Calendar, Receipt, Send, Wallet, Check, Play, Sparkles, ArrowRight, FileText } from 'lucide-react';
import PricingCards from '@/components/marketing/PricingCards';
import MarketingNav from '@/components/marketing/MarketingNav';
import FaqAccordion from '@/components/marketing/FaqAccordion';
import Reveal from '@/components/marketing/Reveal';
import HeroVideo from '@/components/marketing/HeroVideo';

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

// Page-wide container. 1600px cap is wider than the Google Workspace
// 1160 default the handoff specced; the founder asked for a less
// boxed-in feel on big screens. px-8 → px-12 gutter at lg keeps a
// comfortable rhythm without the page hugging the viewport edge.
const WRAP = 'mx-auto w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12';

/** Mac-style browser frame around a product placeholder. Real
 *  screenshots drop into the `<children>` slot once shipped. */
function Frame({ url = 'app.fleetcal.com/calendar', children, className, style }: { url?: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={className}
      style={{
        background:   '#fff',
        borderRadius: 16,
        boxShadow:    'var(--shadow-soft)',
        overflow:     'hidden',
        border:       '1px solid #e8eaed',
        ...style,
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
      // Fills the viewport below the 68px nav on standard laptop /
      // desktop screens so the hero acts as a true "above the fold"
      // panel and the scroll-down indicator the screenshot/video
      // shows actually has something below it. `min-height` (not
      // height) so taller content on small viewports still expands
      // gracefully instead of clipping. Flex column centers the
      // grid vertically when the viewport is taller than the
      // content needs.
      className="flex flex-col justify-center"
      style={{
        background:    'radial-gradient(ellipse 70% 90% at 88% 0%, #e8f0fe 0%, #fff 60%)',
        paddingTop:    72,
        paddingBottom: 84,
        minHeight:     'calc(100vh - 68px)',
      }}
    >
      <div
        className={`${WRAP} grid items-center gap-10 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.4fr]`}
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
              Built by a carrier, for carriers
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
              Your entire<br className="hidden lg:inline" />{' '}
              dispatch desk on<br className="hidden lg:inline" />{' '}
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
              Pay the driver. Every step where it should be. All in one platform.
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
        </div>

        <Reveal delay={140}>
          <div style={{ position: 'relative' }}>
            <Frame
              url="fleetcal.app/calendar"
              className="feat-frame-shadow"
              // Hero visual sits on the right half of the lg grid
              // (`grid-cols-[1fr_1.4fr]`), so anchor the hover scale
              // to the right edge — the frame grows leftward into
              // the safe area instead of pushing its right edge off
              // the viewport.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              style={{ ['--feat-origin' as any]: 'right center' }}
            >
              {/* Hero screencast — dispatcher dragging a rate-con PDF
                  onto the calendar and FleetCal's AI extracts the
                  customer, rate, stops, and times. HeroVideo (client
                  component) handles the imperative .play() call after
                  mount to dodge the React `autoPlay` + `muted`
                  attribute-order race that leaves the video paused on
                  first frame. See its docstring for details. */}
              <HeroVideo
                src="/rateconai.mp4"
                width={1844}
                height={1080}
                ariaLabel="AI parsing a rate confirmation PDF into a load"
              />
            </Frame>
            {/* Floating "Delivered" chip — top-right. Hidden below
                sm: the negative offsets overflow the viewport on
                phones and clip behind the screenshot. */}
            <div
              className="hidden sm:flex"
              style={{
                position:     'absolute',
                top:          -24,
                right:        -14,
                background:   '#fff',
                borderRadius: 16,
                boxShadow:    'var(--shadow-3)',
                padding:      '14px 16px',
                border:       '1px solid #e8eaed',
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
            {/* Floating "Invoice sent" chip — bottom-left. Same
                mobile-hide treatment as the Delivered chip. */}
            <div
              className="hidden sm:flex"
              style={{
                position:     'absolute',
                bottom:       -22,
                left:         -18,
                background:   '#fff',
                borderRadius: 16,
                boxShadow:    'var(--shadow-3)',
                padding:      '14px 16px',
                border:       '1px solid #e8eaed',
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
    ['60 sec',    'rate-con to dispatch'],
    ['3 clicks',  'POD to sent invoice'],
    ['$0',        'per-driver fees, ever'],
    ['All-in-1',  'dispatch, payroll, billing'],
  ];
  return (
    <section style={{ borderTop: '1px solid #e8eaed', borderBottom: '1px solid #e8eaed', background: '#f8f9fa' }}>
      <div
        className={`${WRAP} grid gap-6 grid-cols-2 md:grid-cols-4 py-7 sm:py-9`}
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

// ── Features — three consolidated "groups" replacing the prior 6+1
// icon-card grid. Each group has a kicker, title, body, chips, one
// or two learn-more pill links, a primary product screenshot/video,
// and (group-specific) overlay mockups (AI badge, status chip,
// invoice bar, finalize-pay button). Editorial-heroes layout —
// copy/visual rows alternate sides at >880px and stack at narrow.
interface FeatureGroup {
  key:       string;
  n:         string;
  kicker:    string;
  Icon:      React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
  color:     string;
  light:     string;
  title:     string;
  body:      string;
  chips:     ReadonlyArray<string>;
  links:     ReadonlyArray<readonly [string, string]>;
  /** Bare-frame primary media (rounded card, no browser chrome). */
  primary:   { kind: 'video' | 'image'; src: string; alt?: string };
  /** Optional top-of-frame badge. `chip` is the green check + title +
   *  sub variant (group 02 "Ready to release"); `ai` is the purple
   *  sparkle + progress-bar variant with the sparkle on the trailing
   *  edge (group 01 "Extracting Load Details"). */
  topBadge?:
    | { kind: 'chip'; title: string; sub: string }
    | { kind: 'ai'; text: string };
  /** Optional secondary overlay — AI badge, invoice bar, a smaller
   *  bare-frame image with its own overlay button, or a video frame
   *  overlapping the primary (group 01). */
  secondary?:
    | { kind: 'badge'; text: string }
    | { kind: 'invoicebar' }
    | { kind: 'image'; src: string; alt?: string; widthPct: number; bottomOffset: number; overlay?: { kind: 'finalizepay'; label: string; amount: string } }
    | { kind: 'video'; src: string; alt?: string; widthPct: number; bottomOffset: number };
}

const FEATURE_GROUPS: ReadonlyArray<FeatureGroup> = [
  {
    key:    'dispatch',
    n:      '01',
    kicker: 'Dispatch calendar',
    Icon:   Calendar,
    color:  '#1a73e8',
    light:  '#e8f0fe',
    title:  'Find the gaps. Fill the trucks.',
    body:   "See every truck's schedule in its own column on a live calendar. Empty space means it's time to start booking loads. Drop a rate-con PDF and AI fills in the load details and maps the stops. Drag and drop to assign loads to drivers and trucks.",
    chips:  ['Color per truck', 'Unassigned load queue', 'AI rate-con parser', 'Drag-to-assign'],
    links:  [['Dispatch calendar', '#']],
    // Static calendar screenshot is the hero; the rate-con drag-drop
    // video plays underneath as a smaller overlapping frame (~45%
    // width). The AI extraction badge floats over the TOP of the
    // calendar screenshot with the sparkle on the right edge — reads
    // as a status indicator on the live screen rather than a load
    // detail tooltip.
    primary:   { kind: 'image', src: '/calendar-view.png', alt: 'FleetCal dispatch calendar with one column per truck' },
    topBadge:  { kind: 'ai', text: 'Extracting Load Details' },
    secondary: { kind: 'video', src: '/calendar-dragdrop.mp4', alt: 'Dispatcher dragging a rate-con PDF onto the calendar', widthPct: 45, bottomOffset: -16 },
  },
  {
    key:    'paperwork',
    n:      '02',
    kicker: 'Paperwork & billing',
    Icon:   Receipt,
    color:  '#f97316',
    light:  '#fef0e6',
    title:  'Verify the paperwork. Send the invoice.',
    body:   'POD on one side, rate con on the other — release the load the moment it checks out. Then invoice one load or a whole batch; AI reads customer-specific billing rules so nothing bounces back.',
    chips:  ['Side-by-side review', 'Release for invoicing', 'One-click or bulk', 'Customer billing rules'],
    links:  [['Paperwork verification', '#'], ['Billing', '#']],
    primary:   { kind: 'image', src: '/paperwork-verification.png', alt: 'Side-by-side POD and rate-con review for closeout' },
    topBadge:  { kind: 'chip', title: 'Ready to release', sub: '42 loads · $28,496' },
    secondary: { kind: 'invoicebar' },
  },
  {
    key:    'payroll',
    n:      '03',
    kicker: 'Payroll & insight',
    Icon:   Wallet,
    color:  '#1e8e3e',
    light:  '#e6f4ea',
    title:  'Close out payroll Friday. Know your numbers.',
    body:   'Driver events roll straight into the weekly payroll page — adjust and finalize in minutes. Then see performance by truck, driver, and lane, so you know exactly what is making money.',
    chips:  ['Auto-filled payroll', 'Finalize Friday', 'Asset & driver reports', 'Revenue over time'],
    links:  [['Payroll', '#'], ['Dashboard & reports', '#']],
    primary:   { kind: 'image', src: '/weekly-dashboard.png', alt: 'Revenue by truck, customer, and over time' },
    secondary: {
      kind:         'image',
      src:          '/payroll-week.png',
      alt:          'Weekly driver pay table',
      widthPct:     72,
      bottomOffset: -16,
      overlay:      { kind: 'finalizepay', label: 'Finalize weekly pay', amount: '$1,825' },
    },
  },
];

/** BareFrame — rounded image/video card with no browser chrome.
 *  Hero uses Frame (with traffic-light dots + URL bar); the Features
 *  section uses bare frames so the product screenshots feel like
 *  in-context evidence rather than miniature browser windows.
 *  Adds .feat-frame-shadow so the hover-zoom rule in globals.css
 *  applies — children scale to 1.4× on hover and lift z to come
 *  forward of neighboring overlays. */
function BareFrame({ children, origin = 'center' }: { children: React.ReactNode; origin?: 'left' | 'right' | 'center' }) {
  // Translate the high-level side into a CSS transform-origin pair
  // and feed it through the --feat-origin custom property the hover
  // rule in globals.css reads. Keeps the scale anchored to whichever
  // edge is closer to the viewport edge so the opposite edge grows
  // inward instead of being clipped off-screen.
  const cssOrigin =
    origin === 'left'  ? 'left center'  :
    origin === 'right' ? 'right center' :
                         'center';
  return (
    <div
      className="feat-frame-shadow"
      style={{
        background:   '#fff',
        borderRadius: 16,
        overflow:     'hidden',
        border:       '1px solid #e8eaed',
        display:      'block',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ['--feat-origin' as any]: cssOrigin,
      }}>
      {children}
    </div>
  );
}

/** Static "AI is working" overlay badge for group 01. Purple sparkle
 *  + non-animated 62% progress bar. The on-page motion in the
 *  prototype was a hand-waved indeterminate; in production we
 *  keep it deliberately still so it doesn't compete with the
 *  autoplaying calendar video behind it.
 *
 *  iconPosition flips the sparkle to the trailing edge. Used for
 *  the top-of-frame variant in group 01 where the badge sits over
 *  the calendar screenshot's header bar — the right-edge sparkle
 *  reads as "AI status indicator" rather than a leading bullet. */
function AiBadge({ text, iconPosition = 'left' }: { text: string; iconPosition?: 'left' | 'right' }) {
  const icon = (
    <span style={{
      position:     'relative',
      width:        36, height: 36,
      borderRadius: 999,
      background:   '#f3e8fd',
      display:      'grid',
      placeItems:   'center',
      flex:         'none',
    }}>
      <span style={{
        position:     'absolute',
        inset:        3,
        borderRadius: 999,
        border:       '2.5px solid rgba(124,58,237,.35)',
      }} />
      <Sparkles size={14} style={{ color: '#7c3aed', position: 'relative' }} strokeWidth={2.4} />
    </span>
  );
  const content = (
    <div style={{ minWidth: 0 }}>
      <div className="font-display" style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.32, color: '#202124' }}>{text}</div>
      <div style={{ marginTop: 8, height: 5, width: 132, maxWidth: '100%', borderRadius: 999, background: '#f3e8fd', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: '62%', borderRadius: 999, background: '#7c3aed' }} />
      </div>
    </div>
  );
  return (
    <div
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          12,
        background:   '#fff',
        border:       '1px solid #e8eaed',
        borderRadius: 14,
        boxShadow:    'var(--shadow-3)',
        padding:      '12px 15px',
        maxWidth:     320,
      }}>
      {iconPosition === 'left' ? (<>{icon}{content}</>) : (<>{content}{icon}</>)}
    </div>
  );
}

/** Top-corner "Ready to release · N loads · $X" status chip for
 *  group 02. White card, green check, two text lines. */
function StatusChip({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          11,
      background:   '#fff',
      border:       '1px solid #e8eaed',
      borderRadius: 14,
      boxShadow:    'var(--shadow-3)',
      padding:      '12px 15px',
    }}>
      <span style={{
        width: 30, height: 30,
        borderRadius: 999,
        background: '#1e8e3e',
        display: 'grid', placeItems: 'center',
        flex: 'none',
      }}>
        <Check size={16} strokeWidth={3} style={{ color: '#fff' }} />
      </span>
      <div>
        <div className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#202124', whiteSpace: 'nowrap' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: '#5f6368', whiteSpace: 'nowrap' }}>{sub}</div>
      </div>
    </div>
  );
}

/** Bulk invoice action bar mockup — selection count + total +
 *  Generate / Send buttons. Floats over the closeout screenshot
 *  in group 02, sized to ~86% width (max 460px) and centered. */
function InvoiceBar() {
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          14,
      background:   '#fff',
      border:       '1px solid #e8eaed',
      borderRadius: 14,
      boxShadow:    'var(--shadow-3)',
      padding:      '12px 14px',
    }}>
      <span style={{
        width: 30, height: 30,
        borderRadius: 999,
        background: '#1e8e3e',
        display: 'grid', placeItems: 'center',
        flex: 'none',
      }}>
        <Check size={16} strokeWidth={3} style={{ color: '#fff' }} />
      </span>
      <div style={{ lineHeight: 1.16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#5f6368', whiteSpace: 'nowrap' }}>4 loads selected</div>
        <div className="font-display" style={{ fontWeight: 800, fontSize: 17, color: '#202124', letterSpacing: '-.02em' }}>$3,423.00</div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button type="button" className="font-display" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          fontWeight: 600, fontSize: 13.5, lineHeight: 1,
          borderRadius: 999, padding: '11px 16px',
          background: '#fff', color: '#3c4043',
          border: '1px solid #dadce0',
          whiteSpace: 'nowrap', cursor: 'default',
        }}>
          Generate invoice
        </button>
        <button type="button" className="font-display" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          fontWeight: 600, fontSize: 13.5, lineHeight: 1,
          borderRadius: 999, padding: '11px 16px',
          background: '#1e8e3e', color: '#fff',
          border: '1px solid transparent',
          whiteSpace: 'nowrap', cursor: 'default',
        }}>
          <Send size={13} style={{ color: '#fff' }} />
          Send invoices
        </button>
      </div>
    </div>
  );
}

/** Floating Finalize-weekly-pay pill for group 03. Green CTA over
 *  the bottom-left of the smaller payroll-week screenshot. */
function FinalizePay({ label, amount }: { label: string; amount: string }) {
  return (
    <button type="button" className="font-display" style={{
      display: 'inline-flex', alignItems: 'center', gap: 10,
      background: '#1e8e3e', color: '#fff',
      border: 'none', borderRadius: 999,
      padding: '12px 18px',
      boxShadow: 'var(--shadow-3)',
      cursor: 'default',
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: 22, height: 22, borderRadius: 999,
        background: 'rgba(255,255,255,.22)',
        display: 'grid', placeItems: 'center',
        flex: 'none',
      }}>
        <Check size={14} strokeWidth={3} style={{ color: '#fff' }} />
      </span>
      <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
      <span style={{
        fontWeight: 800, fontSize: 14,
        paddingLeft: 10,
        borderLeft: '1px solid rgba(255,255,255,.32)',
      }}>{amount}</span>
    </button>
  );
}

/** Learn-more pill links. First link in each group is filled with
 *  the group's accent (white text); subsequent links are outline
 *  (white bg, accent text). The arrow slides +3px on hover via the
 *  `.learn-link .learn-arrow` rule in globals.css. Placeholder
 *  hrefs (#) for now — wire to detail routes when those land. */
function LearnLinks({ group }: { group: FeatureGroup }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 26 }}>
      {group.links.map(([label, href], i) => {
        const primary = i === 0;
        return (
          <a
            key={label}
            href={href}
            className="learn-link font-display"
            style={{
              display:      'inline-flex',
              alignItems:   'center',
              gap:          8,
              fontWeight:   600,
              fontSize:     14,
              padding:      '11px 18px',
              borderRadius: 999,
              border:       '1px solid',
              background:   primary ? group.color : '#fff',
              color:        primary ? '#fff' : group.color,
              borderColor:  primary ? 'transparent' : '#dadce0',
              textDecoration: 'none',
              whiteSpace:   'nowrap',
            }}>
            {label}
            <span className="learn-arrow">
              <ArrowRight size={15} style={{ color: primary ? '#fff' : group.color }} strokeWidth={2.4} />
            </span>
          </a>
        );
      })}
    </div>
  );
}

/** Copy column for a feature group — icon tile + kicker, title,
 *  body, chips, learn-more links. The "big" flag bumps the heading
 *  size for the editorial layout (vs the not-shipped panels variant
 *  in the prototype). */
function GroupCopy({ group }: { group: FeatureGroup }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{
          width: 46, height: 46,
          borderRadius: 13,
          display: 'grid', placeItems: 'center',
          background: group.light,
          flex: 'none',
        }}>
          <group.Icon size={22} style={{ color: group.color }} strokeWidth={2} />
        </span>
        <span
          className="font-mono"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: group.color,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}>
          {group.kicker}
        </span>
      </div>
      <h3
        className="font-display"
        style={{
          fontWeight: 800,
          fontSize: 'clamp(26px, 2.5vw, 33px)',
          lineHeight: 1.12,
          margin: '22px 0 0',
          maxWidth: 460,
          letterSpacing: '-0.022em',
          color: '#202124',
        }}>
        {group.title}
      </h3>
      <p style={{ fontSize: 17.5, lineHeight: 1.65, color: '#5f6368', margin: '14px 0 0', maxWidth: 480 }}>
        {group.body}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 22 }}>
        {group.chips.map(c => (
          <span
            key={c}
            style={{
              whiteSpace: 'nowrap',
              fontSize: 13,
              fontWeight: 500,
              color: '#3c4043',
              background: '#f8f9fa',
              border: '1px solid #e8eaed',
              padding: '7px 14px',
              borderRadius: 999,
            }}>
            {c}
          </span>
        ))}
      </div>
      <LearnLinks group={group} />
    </div>
  );
}

/** Visual column — primary frame plus the group's overlay mockups
 *  (status chip top, AI badge / invoice bar / secondary image
 *  bottom). When the row is flipped (group 02), the overlay anchors
 *  swap sides so they stay near the visual's outer edge instead of
 *  colliding with the copy column. Reflow rules in globals.css
 *  drop the overlays in-flow at <880px. */
function GroupVisual({ group, flip }: { group: FeatureGroup; flip: boolean }) {
  const off = -10;
  const sec = group.secondary;
  // Reserve extra padding below the primary so the floating overlay
  // doesn't get clipped by the parent grid row.
  const pad = !sec ? 0 : sec.kind === 'badge' ? 34 : sec.kind === 'invoicebar' ? 30 : 44;
  // Anchor the hover scale toward whichever side of the screen the
  // visual column sits on. flip=true → visual on the LEFT half, grow
  // rightward (origin: left). flip=false → visual on the RIGHT half,
  // grow leftward (origin: right). Without this the larger side of
  // the scaled frame would clip off the viewport edge.
  const frameOrigin: 'left' | 'right' = flip ? 'left' : 'right';
  return (
    <div style={{ position: 'relative', paddingBottom: pad }}>
      <BareFrame origin={frameOrigin}>
        {group.primary.kind === 'video' ? (
          <HeroVideo
            src={group.primary.src}
            width={1968}
            height={1080}
            ariaLabel={group.primary.alt ?? ''}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={group.primary.src}
            alt={group.primary.alt ?? ''}
            style={{ display: 'block', width: '100%', height: 'auto', background: '#f8f9fa' }}
          />
        )}
      </BareFrame>

      {group.topBadge && (
        <div
          className="group-topbadge"
          style={{
            position: 'absolute',
            top: -16,
            zIndex: 4,
            right: flip ? -14 : 'auto',
            left:  flip ? 'auto' : -14,
          }}>
          {group.topBadge.kind === 'chip' ? (
            <StatusChip title={group.topBadge.title} sub={group.topBadge.sub} />
          ) : (
            <AiBadge text={group.topBadge.text} iconPosition="right" />
          )}
        </div>
      )}

      {sec && sec.kind === 'badge' && (
        <div
          className="group-secondary"
          style={{
            position: 'absolute',
            bottom: 22,
            zIndex: 3,
            right: flip ? 'auto' : -14,
            left:  flip ? -14    : 'auto',
          }}>
          <AiBadge text={sec.text} />
        </div>
      )}

      {sec && sec.kind === 'invoicebar' && (
        <div
          className="group-secondary"
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            width: '86%',
            maxWidth: 460,
            zIndex: 3,
          }}>
          <InvoiceBar />
        </div>
      )}

      {sec && sec.kind === 'image' && (
        <div
          className="group-secondary"
          style={{
            position: 'absolute',
            width: `${sec.widthPct}%`,
            bottom: sec.bottomOffset,
            zIndex: 2,
            right: flip ? 'auto' : off,
            left:  flip ? off    : 'auto',
          }}>
          <BareFrame origin={frameOrigin}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sec.src}
              alt={sec.alt ?? ''}
              style={{ display: 'block', width: '100%', height: 'auto', background: '#f8f9fa' }}
            />
          </BareFrame>
          {sec.overlay?.kind === 'finalizepay' && (
            <div style={{ position: 'absolute', bottom: -16, left: -12, zIndex: 4 }}>
              <FinalizePay label={sec.overlay.label} amount={sec.overlay.amount} />
            </div>
          )}
        </div>
      )}

      {sec && sec.kind === 'video' && (
        <div
          className="group-secondary"
          style={{
            position: 'absolute',
            width: `${sec.widthPct}%`,
            bottom: sec.bottomOffset,
            zIndex: 2,
            right: flip ? 'auto' : off,
            left:  flip ? off    : 'auto',
          }}>
          <BareFrame origin={frameOrigin}>
            <HeroVideo
              src={sec.src}
              width={1968}
              height={1080}
              ariaLabel={sec.alt ?? ''}
            />
          </BareFrame>
        </div>
      )}
    </div>
  );
}

function Features() {
  return (
    <section
      id="features"
      style={{
        padding:         '110px 0 100px',
        scrollMarginTop: 68,
        // Pale-brand-blue canvas + matching borders. Establishes a
        // distinct third tone alongside the white hero and the gray
        // TrustBand / HowItWorks / Story, so the "Built by a carrier"
        // section reads as its own block instead of flowing visually
        // out of the hero.
        background:    '#e8f0fe',
        borderTop:     '1px solid #d2e3fc',
        borderBottom:  '1px solid #d2e3fc',
      }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 760 }}>
          <SectionTitle>
            Built by a carrier, <span style={{ color: 'var(--gc-blue)' }}>for carriers.</span>
          </SectionTitle>
          <SectionSub>
            The whole back office of a small carrier, without the bloat or the enterprise price tag.
          </SectionSub>
        </Reveal>

        {/* Editorial heroes — vertical stack of three groups,
            alternating sides at >880px and stacking to single-column
            at narrow. Visual column is always the wider one (1.45fr
            vs 0.9fr) so the product screenshot/video carries the
            section's weight; the copy stays disciplined to ~480px. */}
        <div style={{ display: 'grid', gap: 100, marginTop: 76 }}>
          {FEATURE_GROUPS.map((group, i) => {
            const flip = i % 2 === 1;
            return (
              <Reveal key={group.key}>
                <div
                  className="feat-row"
                  style={{
                    display:             'grid',
                    gridTemplateColumns: flip ? '1.45fr 0.9fr' : '0.9fr 1.45fr',
                    gap:                 56,
                    alignItems:          'center',
                  }}>
                  <div style={{ order: flip ? 2 : 1 }}>
                    <GroupCopy group={group} />
                  </div>
                  <div style={{ order: flip ? 1 : 2 }}>
                    <GroupVisual group={group} flip={flip} />
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  // 5-step connected flow. Order is intentional: Pay (04) before
  // Invoice (05) — reverses the hero's "Send the invoice. Pay the
  // driver." line per the founder's framing of the actual close-out
  // sequence ("payroll runs Friday; invoice goes when the broker is
  // ready"). Each step gets its own accent color so the flow reads
  // as a journey across modules rather than four identical chunks.
  const steps: ReadonlyArray<{
    n:     string;
    title: string;
    body:  string;
    Icon:  React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;
    color: string;
    light: string;
  }> = [
    { n: '01', title: 'Drop the rate-con', body: 'Upload the PDF. FleetCal reads the customer, rate, stops and times.', Icon: FileText, color: '#1a73e8', light: '#e8f0fe' },
    { n: '02', title: 'Dispatch the load', body: 'Assign a truck and driver on the calendar. Status flips automatically.', Icon: Calendar, color: '#7c3aed', light: '#f3e8fd' },
    { n: '03', title: 'Verify the POD',    body: 'Driver uploads paperwork from the app. Review it in the closeout queue.', Icon: Check,    color: '#1e8e3e', light: '#e6f4ea' },
    { n: '04', title: 'Pay the driver',    body: 'Driver events auto-populate the weekly payroll page. Adjust and finalize every Friday.', Icon: Wallet, color: '#f97316', light: '#fef0e6' },
    { n: '05', title: 'Invoice',           body: 'Send the invoice one at a time or in bulk, mark it paid, and the load is closed.', Icon: Send,   color: '#0891b2', light: '#e0f7fa' },
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
          <SectionTitle>
            One flow,{' '}
            <span style={{ color: 'var(--gc-blue)' }}>start to finish.</span>
          </SectionTitle>
          <SectionSub>The same path every load takes — without a single spreadsheet or re-keyed number.</SectionSub>
        </Reveal>
        <div className="how-flow">
          {steps.map((s, i) => (
            <Fragment key={s.n}>
              <Reveal delay={i * 90} className="how-cell">
                <div className="how-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{
                      width:        48,
                      height:       48,
                      borderRadius: 14,
                      display:      'grid',
                      placeItems:   'center',
                      background:   s.light,
                      flex:         'none',
                    }}>
                      <s.Icon size={22} style={{ color: s.color }} strokeWidth={2} />
                    </span>
                    <span
                      className="font-mono"
                      style={{
                        fontSize:       13,
                        fontWeight:     600,
                        color:          '#5f6368',
                        letterSpacing:  '0.12em',
                      }}>
                      {s.n}
                    </span>
                  </div>
                  <h3
                    className="font-display"
                    style={{
                      fontWeight:    700,
                      fontSize:      19,
                      margin:        '20px 0 0',
                      letterSpacing: '-0.022em',
                      color:         '#202124',
                    }}>
                    {s.title}
                  </h3>
                  <p style={{ fontSize: 15, lineHeight: 1.6, color: '#5f6368', margin: '10px 0 0' }}>{s.body}</p>
                </div>
              </Reveal>
              {i < steps.length - 1 && (
                <div className="how-conn" aria-hidden="true">
                  <ArrowRight size={20} style={{ color: '#5f6368' }} strokeWidth={2} />
                </div>
              )}
            </Fragment>
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
            <span style={{ color: 'var(--gc-blue)' }}>Same product at every tier.</span>
          </SectionTitle>
          <SectionSub>
            14-day free trial on every plan. No per-driver surcharges,
            no annual lock-in.
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
      {/* Editorial two-column. Founder card sits in the narrower
          left column under the title; paragraphs + decorative big-
          blue opening quote sit in the wider right. Old layout had
          the signature inline at the bottom of the paragraph block;
          relocating it into a card on the left elevates the
          attribution from a footer note to part of the section's
          opening composition. */}
      <div className={`${WRAP} story-grid`}>
        <Reveal>
          <SectionLabel>Built by carriers</SectionLabel>
          <SectionTitle>
            Made by people who&apos;ve actually{' '}
            <span style={{ color: 'var(--gc-blue)' }}>run a dispatch desk.</span>
          </SectionTitle>
          <div
            style={{
              marginTop:    30,
              padding:      '24px 26px',
              background:   '#fff',
              border:       '1px solid #e8eaed',
              borderRadius: 24,
              boxShadow:    'var(--shadow-card)',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
              <div
                className="font-display"
                style={{
                  width:        56,
                  height:       56,
                  borderRadius: 999,
                  flex:         'none',
                  background:   'var(--gc-blue)',
                  color:        '#fff',
                  display:      'grid',
                  placeItems:   'center',
                  fontWeight:   800,
                  fontSize:     19,
                  letterSpacing: '0.02em',
                  boxShadow:    'var(--shadow-1)',
                }}>
                MC
              </div>
              <div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 17, color: '#202124' }}>
                  Matt Curzon
                </div>
                <div style={{ fontSize: 14.5, color: '#5f6368', marginTop: 2 }}>
                  Founder &amp; Operator, Curzon Trucking LLC
                </div>
                <div style={{ fontSize: 14.5, color: '#5f6368' }}>
                  Salt Lake City, UT
                </div>
              </div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div style={{ position: 'relative' }}>
            {/* Decorative opening quote mark — purely visual, sits
                behind the lead paragraph in pale brand blue. Marked
                aria-hidden so screen readers skip it. */}
            <span
              className="font-display story-quote"
              aria-hidden="true">
              &ldquo;
            </span>
            <div style={{ position: 'relative', fontSize: 17.5, lineHeight: 1.85, color: '#3c4043', display: 'grid', gap: 20 }}>
              <p style={{ fontSize: 20, lineHeight: 1.7, color: '#202124' }}>
                FleetCal is built on years of industry experience and a deep understanding
                of the workflows dispatchers run every day. We tried enterprise TMS products
                like Alvys and RoseRocket, but they&apos;re weighed down by bloat that pulls
                dispatchers away from what actually matters. They treat loads like another
                row in a spreadsheet. We treat loads as the core unit of dispatch, organized
                in a calendar so you can see at a glance which trucks are moving and which
                need attention.
              </p>
              <p>
                As we grew our fleet from 3 to 15 trucks, we couldn&apos;t find tools that
                gave us real visibility into our bottom line. We wanted certainty that
                invoices were getting paid. We wanted certainty that every asset was
                earning every day.
              </p>
              <p>
                FleetCal&apos;s philosophy is practical software for the people who actually
                run the business: owners, dispatchers, and owner-operators. Simple workflows.
                Powerful fundamentals. Everything in one ecosystem, from rate con to invoice.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

const FAQS = [
  { q: 'Is there a per-driver or per-seat fee?',       a: 'Never. You pay one flat monthly price based on your truck count. Add as many dispatchers, drivers, and office staff as you need at no extra cost.' },
  { q: 'How does the free trial work?',                a: "Every plan starts with a 14-day free trial. Pick a plan, add your card, and you're set up. You won't be charged until day 15, and you can cancel any time before then in the app." },
  { q: 'Can I bring my existing loads and customers over?', a: "Yes. You can import your current loads, customers, drivers, and equipment so you're not starting from an empty calendar on day one." },
  { q: 'Who is FleetCal built for?',                   a: 'Small to mid-size carriers running roughly 1–14 trucks. From owner-operators acting as their own dispatcher up through fleets where dispatch is its own department.' },
  { q: 'What if I grow past 14 trucks?',               a: "Reach out to sales and we'll set you up with a plan sized to your fleet. The product is the same. Only the truck cap changes." },
] as const;

function Faq() {
  return (
    <section style={{ padding: '110px 0' }}>
      <div
        className={`${WRAP} grid items-start gap-10 lg:gap-16 grid-cols-1 lg:grid-cols-[0.8fr_1.4fr]`}
      >
        <Reveal>
          <SectionLabel>FAQ</SectionLabel>
          <SectionTitle>Questions, answered.</SectionTitle>
          <SectionSub>
            Still not sure?{' '}
            <Link
              href="/contact-sales"
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
      <div className={`${WRAP} text-center py-20 sm:py-[100px]`}>
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
            <span style={{ color: '#202124' }}>
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
  // Each link below must resolve to a real destination — either an
  // existing route (verified against app/), a real on-page anchor,
  // or a working mailto. Pre-cleanup the footer carried four
  // dead/duplicate links (Built by carriers→#story duplicated Why
  // FleetCal, Careers→#story had no careers page, Help center was
  // just a relabelled mailto, System status went to #). Those are
  // removed rather than left as decoration.
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
    ['Product', [
      ['Features',     '#features'],
      ['How it works', '#how'],
      ['Pricing',      '#pricing'],
    ]],
    ['Company', [
      ['Why FleetCal',  '#story'],
      ['Contact sales', '/contact-sales'],
    ]],
    ['Account', [
      ['Sign in', '/sign-in'],
      ['Sign up', '/sign-up'],
    ]],
  ];
  return (
    <footer style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed' }}>
      <div
        className={`${WRAP} grid gap-10 pt-12 pb-9 grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1fr]`}
      >
        <div className="col-span-2 md:col-span-1">
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={140}
            height={32}
            style={{ height: 32, width: 'auto', objectFit: 'contain', display: 'block' }}
          />
          <p style={{ fontSize: 14.5, lineHeight: 1.6, color: '#5f6368', marginTop: 18, maxWidth: 260 }}>
            The dispatch-to-invoice TMS built by a carrier, for fleets like yours.
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
        className={`${WRAP} flex flex-wrap justify-between gap-3 py-[22px]`}
        style={{
          borderTop:      '1px solid #e8eaed',
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
          <Link href="/privacy" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Privacy</Link>
          <Link href="/terms" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Terms</Link>
        </div>
      </div>
    </footer>
  );
}
