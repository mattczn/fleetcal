import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { Zap, Truck, NotebookPen, Sparkles, Copy, Circle, Package, MapPin, FileText, Container } from 'lucide-react';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';
import HeroVideo from '@/components/marketing/HeroVideo';
import HeroFeatureNav from '@/components/marketing/HeroFeatureNav';
import ProductFlowFooter from '@/components/marketing/ProductFlowFooter';
import BeforeAfterSection, { BA_PRESETS } from '@/components/marketing/BeforeAfterSection';
import LiveTruckCard from '@/components/marketing/calendar/LiveTruckCard';
import LoadDocsViewer from '@/components/marketing/calendar/LoadDocsViewer';
import CapabilitySelector from '@/components/marketing/calendar/CapabilitySelector';

/**
 * Dispatch Calendar marketing feature page at `/product/calendar` — the core
 * module. Public (same 3-state CTA rules as `/`). Blue accent, full-bleed
 * hero. Authed app lives at `/calendar`. Light mode only.
 */
export const metadata: Metadata = {
  title: 'Dispatch Calendar Software for Trucking Fleets | FleetCal',
  description: 'Drop a rate con, drag it to a truck, dispatch in seconds. One column per truck on a live dispatch calendar.',
};

export default async function CalendarMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div data-marketing-scroll className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary" style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} frostless />
      <Hero cta={cta} />
      <BuildLoads />
      <TruckView />
      <LoadDetails />
      <MoreThanCalendar />
      <BeforeAfterSection rows={BA_PRESETS.calendar} />
      <ProductFlowFooter current="calendar" />
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
  { id: 'build', label: 'Build loads' },
  { id: 'truck', label: 'Truck view' },
  { id: 'load-details', label: 'Load details' },
  { id: 'more', label: 'Capabilities' },
];

// ── Hero ────────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <>
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(168,206,250,0.7) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #eef4fe 0%, #f6f9fe 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 48 }}>
      <div className={`${WRAP} grid items-center gap-10 lg:gap-16 grid-cols-1 lg:grid-cols-[1fr_1.4fr]`}>
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#1967d2', background: '#e8f0fe', padding: '7px 16px 7px 13px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#1a73e8', boxShadow: '0 0 0 3px rgba(26,115,232,0.18)' }} />
              Dispatch Calendar
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(38px, 4.6vw, 57px)', lineHeight: 1.04, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              See every truck.<br /><span style={{ color: '#1a73e8' }}>Fill every gap.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 482, margin: '20px 0 0' }}>
              Visualize your capacity in real time with one column per truck on a live calendar. A solid bar means it&rsquo;s rolling; white space means it&rsquo;s sitting and ready for the next load. Drop a rate con, drag it onto a truck, and dispatch the driver without leaving the calendar.
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
          <div style={{ position: 'relative' }}>
            <div className="feat-frame-shadow feat-right" style={{ border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', background: '#fff' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/calendar-view.png" alt="FleetCal dispatch calendar, one color-coded column per truck" style={{ display: 'block', width: '100%', height: 'auto' }} />
            </div>

            {/* AI build chip (top-right) */}
            <div className="hidden lg:flex" style={{ position: 'absolute', top: -16, right: -12, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: 'var(--shadow-3)', padding: '11px 15px', alignItems: 'center', gap: 11 }}>
              <span style={{ position: 'relative', width: 32, height: 32, borderRadius: 999, background: '#f3e8fd', display: 'grid', placeItems: 'center' }}>
                <span style={{ position: 'absolute', inset: 3, borderRadius: 999, border: '2.5px solid rgba(124,58,237,.35)' }} />
                <Sparkles size={14} style={{ color: '#7c3aed', position: 'relative' }} strokeWidth={2.2} />
              </span>
              <div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Build a New Load with AI</div>
                <div style={{ fontSize: 11.5, color: '#5f6368' }}>Drop a rate con, AI fills it in</div>
              </div>
            </div>

            {/* iPhone push notification (bottom-left) */}
            <div className="hidden lg:block" style={{ position: 'absolute', bottom: -26, left: -30, zIndex: 3, width: 330, background: 'rgba(250,250,252,0.86)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', backdropFilter: 'saturate(180%) blur(20px)', border: '0.5px solid rgba(0,0,0,0.06)', borderRadius: 20, boxShadow: '0 18px 40px -12px rgba(26,35,50,.35),0 4px 12px rgba(26,35,50,.12)', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="font-display" style={{ width: 22, height: 22, flex: 'none', borderRadius: 6, background: '#1a73e8', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 10, letterSpacing: '-0.02em' }}>FC</span>
                <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#6b6f76' }}>FleetCal</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0a6' }}>now</span>
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#1c1c1e', marginTop: 6, letterSpacing: '-0.01em' }}>New load assigned</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.4, color: '#3a3a3c', marginTop: 2 }}>GTZ: Arlington, TX → Garland, TX, picking up at 3:00pm. Tap to confirm you&rsquo;re good for OTP.</div>
            </div>
          </div>
        </Reveal>
      </div>

    </section>
    <HeroFeatureNav items={HERO_TABS} sticky accent="#1a73e8" />
    </>
  );
}

// ── Feature 01 · Build loads ─────────────────────────────────────────────

function BuildLoads() {
  return (
    <section id="build" style={{ padding: '92px 0 86px', scrollMarginTop: 150 }}>
      <div className={`${WRAP} grid items-center gap-12 lg:gap-[60px] grid-cols-1 lg:grid-cols-[1.18fr_1fr]`}>
        <Reveal className="order-1 lg:order-1">
          <div style={{ position: 'relative' }}>
            <div className="feat-frame-shadow feat-wide" style={{ position: 'relative', border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', background: '#f8f9fa' }}>
              <HeroVideo src="/rateconai.mp4" width={1952} height={1080} ariaLabel="AI extracting load details from a dropped rate confirmation" />
            </div>

            {/* Duplicate / +1 Week modal buttons (bottom-right) */}
            <div className="hidden lg:flex" style={{ position: 'absolute', right: -12, bottom: -16, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 12, boxShadow: 'var(--shadow-3)', padding: 7, alignItems: 'center', gap: 6 }}>
              <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13, color: '#3c4043', background: '#f1f3f4', borderRadius: 8, padding: '8px 13px' }}><Copy size={14} strokeWidth={2.2} /> Duplicate</span>
              <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13, color: '#1967d2', background: '#e8f0fe', borderRadius: 8, padding: '8px 13px' }}>+1 Week</span>
            </div>

            {/* Processing rate con card (bottom-left, partly outside) */}
            <div className="hidden lg:block" style={{ position: 'absolute', left: -18, bottom: -22, zIndex: 4, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: '0 14px 34px -10px rgba(0,0,0,.4)', padding: '16px 18px', textAlign: 'center', width: 248 }}>
              <style>{`@keyframes cal-spin{to{transform:rotate(360deg)}}`}</style>
              <div style={{ width: 26, height: 26, margin: '0 auto', border: '3px solid #e8f0fe', borderTopColor: '#1a73e8', borderRadius: 999, animation: 'cal-spin 1.1s linear infinite' }} />
              <div className="font-display" style={{ fontWeight: 700, fontSize: 14.5, color: '#202124', marginTop: 12, whiteSpace: 'nowrap' }}>Processing rate con 3 of 5</div>
              <div style={{ fontSize: 12, color: '#5f6368', marginTop: 3 }}>AI is extracting load details…</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 11 }}>
                {['#1e8e3e', '#1e8e3e', '#1a73e8', '#dadce0', '#dadce0'].map((bg, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: 999, background: bg }} />
                ))}
              </div>
              <button type="button" className="font-display" style={{ marginTop: 14, fontWeight: 600, fontSize: 12.5, color: '#202124', background: '#fff', border: '1px solid #dadce0', borderRadius: 9, padding: '8px 18px', cursor: 'pointer' }}>Keep Working</button>
              <div style={{ marginTop: 8 }}><span className="font-display" style={{ fontWeight: 600, fontSize: 12.5, color: '#d93025', cursor: 'pointer' }}>Cancel</span></div>
            </div>
          </div>
        </Reveal>

        <Reveal className="order-2 lg:order-2">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 13, background: '#e8f0fe', color: '#1967d2', display: 'grid', placeItems: 'center' }}><Zap size={20} strokeWidth={2.2} /></span>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#1967d2', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Build loads</span>
          </div>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(27px, 2.9vw, 36px)', lineHeight: 1.1, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124', maxWidth: 460 }}>Dispatch a load in the time it takes to read the rate con.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.65, color: '#5f6368', margin: '14px 0 0', maxWidth: 480 }}>Drop up to 10 rate cons into the calendar at once and AI pulls the customer, rate, reference numbers, stops, and appointment windows, right inside each load. Schedule dedicated loads with <strong style={{ color: '#202124' }}>Duplicate</strong> to copy event details, or click <strong style={{ color: '#202124' }}>+1 Week</strong> to push it ahead.</p>
        </Reveal>
      </div>
    </section>
  );
}

// ── Feature 02 · Truck view ──────────────────────────────────────────────

function NudgeRow({ Icon, label, done }: { Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>; label: string; done?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 7px' }}>
      <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 7, background: '#f1f3f4', color: '#5f6368', display: 'grid', placeItems: 'center' }}><Icon size={12} strokeWidth={2.2} /></span>
      <span className="font-display" style={{ flex: 1, fontWeight: 600, fontSize: 12.5, color: '#202124' }}>{label}</span>
      {done && <span style={{ fontSize: 11, fontWeight: 600, color: '#1e8e3e' }}>done</span>}
    </div>
  );
}

function TruckView() {
  return (
    <section id="truck" style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '92px 0', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 880, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <span style={{ width: 46, height: 46, borderRadius: 13, background: '#defafa', color: '#0e8a8a', display: 'grid', placeItems: 'center' }}><Truck size={20} strokeWidth={2.2} /></span>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#0e8a8a', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Truck view</span>
          </div>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.2vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '18px 0 0', color: '#202124' }}>Assign in a drag. Dispatch and track in real time.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px auto 0', maxWidth: 640 }}>Drag a load onto a truck to assign the driver and equipment in one motion. The driver gets an automatic notification in the FleetCal app to confirm, and you can fire off manual dispatch notifications from the calendar any time. Once they&rsquo;re rolling, the live ELD location shows exactly where each truck is and when it&rsquo;ll arrive.</p>
        </Reveal>

        <Reveal>
          <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-6" style={{ marginTop: 30 }}>
            {/* drag & drop demo */}
            <div className="feat-frame-shadow feat-wide" style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, overflow: 'hidden', position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', borderBottom: '1px solid #e8eaed' }}>
                <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#202124' }}>Drag &amp; drop to assign</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#5f6368' }}><span style={{ width: 7, height: 7, borderRadius: 999, background: '#d93025' }} />Live demo</span>
              </div>
              <HeroVideo src="/calendar-dragdrop.mp4" width={1968} height={1080} ariaLabel="Dragging a load onto a truck column to assign the driver" />
              {/* Notify driver panel (static) */}
              <div className="hidden lg:block" style={{ position: 'absolute', right: 14, bottom: 14, width: 238, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: '0 16px 36px -10px rgba(0,0,0,.42)', overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: '1px solid #eef1f4' }}>
                  <span className="font-display" style={{ fontWeight: 700, fontSize: 13, color: '#202124' }}>Notify driver</span>
                  <span style={{ fontSize: 14, color: '#9aa0a6', lineHeight: 1 }}>×</span>
                </div>
                <div style={{ padding: '5px 7px' }}>
                  <NudgeRow Icon={Circle} label="Confirm load" done />
                  <NudgeRow Icon={Package} label="Mark picked up" done />
                  <NudgeRow Icon={MapPin} label="Mark delivered" done />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 8px', background: '#e8f0fe', borderRadius: 9 }}>
                    <span style={{ width: 24, height: 24, flex: 'none', borderRadius: 7, background: '#d2e3fc', color: '#1967d2', display: 'grid', placeItems: 'center' }}><FileText size={12} strokeWidth={2.2} /></span>
                    <span className="font-display" style={{ flex: 1, fontWeight: 700, fontSize: 12.5, color: '#1967d2' }}>Upload POD</span>
                    <span className="font-display" style={{ fontSize: 11, fontWeight: 600, color: '#fff', background: '#1a73e8', borderRadius: 999, padding: '4px 10px' }}>Send</span>
                  </div>
                  <NudgeRow Icon={Container} label="Report trailer" done />
                </div>
              </div>
            </div>

            {/* live ELD location */}
            <LiveTruckCard />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Feature 03 · Load details ────────────────────────────────────────────

function LoadDetails() {
  return (
    <section id="load-details" style={{ borderTop: '1px solid #e8eaed', padding: '94px 0 88px', scrollMarginTop: 150 }}>
      <div className={`${WRAP} grid items-center gap-12 lg:gap-[50px] grid-cols-1 lg:grid-cols-[0.78fr_1.48fr]`}>
        <Reveal>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 13, background: '#fef0e6', color: '#c5631e', display: 'grid', placeItems: 'center' }}><NotebookPen size={20} strokeWidth={2.2} /></span>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#c5631e', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Load details</span>
          </div>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(24px, 2.6vw, 32px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '18px 0 0', color: '#202124' }}>The entire load, without leaving the calendar.</h2>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: '#5f6368', margin: '13px 0 0' }}>Click on a load event in the calendar to view the route map with geocoded locations, the rate confirmation, and all load documents in just one click. Flip between them and calculate ETAs without having to leave the calendar.</p>
        </Reveal>
        <Reveal>
          <LoadDocsViewer />
        </Reveal>
      </div>
    </section>
  );
}

// ── More than just a calendar ────────────────────────────────────────────

function MoreThanCalendar() {
  return (
    <section id="more" style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '90px 0 84px', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <Reveal style={{ textAlign: 'center', maxWidth: 680, margin: '0 auto 44px' }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>More than just a calendar</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(27px, 3vw, 38px)', lineHeight: 1.1, letterSpacing: '-0.022em', margin: '14px 0 0', color: '#202124' }}>All of the features you need to keep trucks busy.</h2>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: '#5f6368', margin: '14px auto 0', maxWidth: 600 }}>Click a feature to see how it works.</p>
        </Reveal>
        <Reveal>
          <CapabilitySelector />
        </Reveal>
      </div>
    </section>
  );
}

// ── Final CTA ────────────────────────────────────────────────────────────

function FinalCta({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section style={{ background: 'var(--gc-blue)', color: '#fff' }}>
      <div className={`${WRAP} text-center`} style={{ paddingTop: 92, paddingBottom: 92 }}>
        <Reveal>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)' }}>Get started</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(32px, 4.5vw, 52px)', lineHeight: 1.06, letterSpacing: '-0.022em', margin: '16px auto 0', maxWidth: 760 }}>
            Run your whole fleet on <span style={{ color: '#202124' }}>one calendar.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. Dispatch, paperwork, payroll, and billing, all from the board.
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

// ── Footer ───────────────────────────────────────────────────────────────

function Footer() {
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
    ['Product', [
      ['Calendar',  '/product/calendar'],
      ['Payroll',   '/product/payroll'],
      ['Dashboard', '/product/dashboard'],
      ['Paperwork', '/product/paperwork'],
      ['Billing',   '/product/billing'],
      ['Driver App', '/product/driver-app'],
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
            Dispatch to invoice, on one calendar. Built by a carrier, for fleets like yours.
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
          © {new Date().getFullYear()} FleetCal
        </span>
        <div style={{ display: 'flex', gap: 24 }}>
          <Link href="/privacy" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Privacy</Link>
          <Link href="/terms" style={{ fontSize: 15, color: '#5f6368', textDecoration: 'none' }}>Terms</Link>
        </div>
      </div>
    </footer>
  );
}
