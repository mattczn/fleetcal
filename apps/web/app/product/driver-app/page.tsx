import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { auth } from '@clerk/nextjs/server';
import { ClipboardList, ScanLine, Calendar, Check, Copy, Truck, Clock, FileText } from 'lucide-react';
import MarketingNav from '@/components/marketing/MarketingNav';
import Reveal from '@/components/marketing/Reveal';
import HeroFeatureNav from '@/components/marketing/HeroFeatureNav';
import ProductFlowFooter from '@/components/marketing/ProductFlowFooter';
import BeforeAfterSection, { BA_PRESETS } from '@/components/marketing/BeforeAfterSection';
import DispatchNotify from '@/components/marketing/driver/DispatchNotify';

/**
 * Driver App marketing feature page at `/product/driver-app`. Public (same
 * 3-state CTA rules as `/` and the other /product pages). Sells the iOS/Android
 * driver companion: every assigned load in the driver's pocket, and every tap
 * back on the dispatcher's calendar in real time. Built in the same visual
 * language as the Calendar/Payroll/Dashboard/Paperwork/Billing pages.
 */
export const metadata: Metadata = {
  title: 'Trucking Driver App | FleetCal Dispatch Calendar',
  description: "Loads, navigation, and POD scanning in the driver's pocket. Syncs live to the dispatch calendar. iOS and Android.",
};

export default async function DriverMarketingPage() {
  const { userId, orgId } = await auth();
  const state: AuthCta = !userId ? 'out' : !orgId ? 'mid-signup' : 'in';
  const cta = ctaFor(state);

  return (
    <div data-marketing-scroll className="h-full overflow-y-auto font-sys bg-sys-bg text-sys-primary" style={{ scrollBehavior: 'smooth' }}>
      <MarketingNav cta={cta} showSignIn={state === 'out'} frostless />
      <Hero cta={cta} />
      <LoadDetails />
      <PaperworkAndScheduling />
      <DispatchSection />
      <BeforeAfterSection rows={BA_PRESETS.driverApp} />
      <ProductFlowFooter current="driver-app" />
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
  { id: 'load-details', label: 'Load details' },
  { id: 'paperwork',    label: 'Paperwork' },
  { id: 'scheduling',   label: 'Scheduling' },
  { id: 'notify',       label: 'Notify driver' },
];

// ── Hero ──────────────────────────────────────────────────────────────────

function Hero({ cta }: { cta: { href: string; label: string } }) {
  return (
    <>
    <section className="flex flex-col justify-center" style={{ background: 'radial-gradient(120% 90% at 92% -8%, rgba(214,197,250,0.7) 0%, rgba(255,255,255,0) 56%), linear-gradient(180deg, #f3effe 0%, #f9f7fe 42%, #ffffff 92%)', paddingTop: 56, paddingBottom: 48 }}>
      <div className={`${WRAP} grid items-center gap-10 lg:gap-14 grid-cols-1 lg:grid-cols-[1fr_1.05fr]`}>
        {/* copy */}
        <div>
          <Reveal>
            <span className="inline-flex items-center gap-2 font-display" style={{ fontSize: 13, fontWeight: 600, color: '#7c3aed', background: '#f1ebfe', padding: '7px 16px 7px 13px', borderRadius: 999 }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: '#7c3aed', boxShadow: '0 0 0 3px rgba(124,58,237,0.18)' }} />
              Driver App
            </span>
          </Reveal>
          <Reveal delay={60}>
            <h1 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(37px, 4.6vw, 57px)', lineHeight: 1.04, letterSpacing: '-0.022em', margin: '22px 0 0', color: '#202124' }}>
              Built for drivers<br /><span style={{ color: '#7c3aed' }}>on the go.</span>
            </h1>
          </Reveal>
          <Reveal delay={120}>
            <p style={{ fontSize: 18.5, lineHeight: 1.6, color: '#5f6368', maxWidth: 486, margin: '20px 0 0' }}>
              Drivers get every assigned load on their phone, along with live tracking, easy navigation, a built-in POD scanner and more. Every movement and upload is shared to the dispatcher&rsquo;s calendar in real time.
            </p>
          </Reveal>
          <Reveal delay={180}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 13, marginTop: 30 }}>
              <Link href={cta.href} className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#7c3aed', color: '#fff', fontWeight: 600, fontSize: 17, padding: '16px 32px', borderRadius: 999, textDecoration: 'none', boxShadow: 'var(--shadow-1)', whiteSpace: 'nowrap' }}>
                {cta.label.replace(' →', '')}
              </Link>
              <Link href="/contact-sales" className="font-display" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: '#7c3aed', border: '1px solid #dadce0', fontWeight: 600, fontSize: 17, padding: '15px 28px', borderRadius: 999, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                Book a demo
              </Link>
            </div>
          </Reveal>
        </div>

        {/* phone + side cards */}
        <Reveal delay={140}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
            <div style={{ position: 'relative', width: 216, maxWidth: '100%' }}>
              <div style={{ background: '#0b0b0c', borderRadius: 46, padding: 9, boxShadow: '0 34px 70px -26px rgba(26,35,50,.5),0 10px 28px -14px rgba(26,35,50,.3)' }}>
                <div style={{ borderRadius: 38, overflow: 'hidden', background: '#fff' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/driver-active-loads.png" alt="FleetCal driver app, active loads" style={{ display: 'block', width: '100%', height: 'auto' }} />
                </div>
              </div>
              {/* push notification, floating off the phone's right */}
              <div className="hidden sm:block" style={{ position: 'absolute', top: 56, right: -76, zIndex: 3, width: 224 }}>
                <PushCard title="New load assigned" body="Ardent: Lancaster, TX → Dallas, TX. Tap to confirm." style={{ borderRadius: 18, background: 'rgba(250,250,252,0.96)', boxShadow: '0 18px 40px -14px rgba(26,35,50,.32),0 4px 12px rgba(26,35,50,.08)' }} />
              </div>
              {/* the dispatch-calendar card it lands on, floating bottom-right */}
              <div className="hidden sm:block" style={{ position: 'absolute', bottom: 24, right: -46, zIndex: 3 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/dispatch-card-hero.png" alt="Load on the dispatcher's calendar" style={{ display: 'block', width: 166, height: 'auto', filter: 'drop-shadow(0 16px 28px rgba(26,35,50,.24))' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              <AppStoreBadge kind="apple" href="https://apps.apple.com/us/app/fleetcal-driver/id6781803786" />
              <AppStoreBadge kind="google" href="#" />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
    <HeroFeatureNav items={HERO_TABS} sticky accent="#7c3aed" />
    </>
  );
}

// ── Feature 01 · Load details ───────────────────────────────────────────────

function LoadDetails() {
  const checks: ReadonlyArray<[string, string]> = [
    ['Directions to every stop', 'Open the route in Google or Apple Maps.'],
    ['Stop instructions & gate codes', 'Extracted with AI from the rate con.'],
    ['Reference, load & pickup numbers', 'Easy to copy and paste.'],
    ['Truck & trailer assignment', 'Shown right on the load.'],
    ['Check in on arrival', 'Location shared with dispatch.'],
    ['Appointment times & windows', 'See the appointment or window for each stop.'],
  ];
  return (
    <section id="load-details" style={{ padding: '92px 0 86px', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <Reveal style={{ maxWidth: 760, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <span style={{ width: 46, height: 46, borderRadius: 13, background: '#e8f0fe', display: 'grid', placeItems: 'center' }}><ClipboardList size={22} strokeWidth={2} style={{ color: '#1967d2' }} /></span>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#1967d2', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Load details</span>
          </div>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.2vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '18px auto 0', color: '#202124' }}>Everything drivers need from pickup to delivery.</h2>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px auto 0', maxWidth: 640 }}>Tap a load to see its <strong style={{ color: '#202124' }}>Stops</strong>, <strong style={{ color: '#202124' }}>Details</strong>, and <strong style={{ color: '#202124' }}>Documents</strong>, directions to each stop, the instructions and gate codes for every facility, all the reference and load numbers, and exactly which truck and trailer the driver is pulling.</p>
        </Reveal>

        <Reveal>
          <div className="flex flex-wrap justify-center items-center" style={{ gap: 0, marginTop: 50 }}>
            {/* phone + floating Details card */}
            <div style={{ position: 'relative', width: 276, maxWidth: '100%', background: '#0b0b0c', borderRadius: 44, padding: 9, boxShadow: '0 28px 64px -24px rgba(26,35,50,.42),0 8px 24px -12px rgba(26,35,50,.24)' }}>
              <div style={{ borderRadius: 36, overflow: 'hidden', background: '#fff' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/driver-stops-detail.png" alt="Load detail, stops, route map, status" style={{ display: 'block', width: '100%', height: 'auto' }} />
              </div>
              <div className="hidden lg:block" style={{ position: 'absolute', top: 40, left: -118, zIndex: 5, width: 208, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: '0 16px 34px -14px rgba(26,35,50,.32)', padding: '13px 15px' }}>
                <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#1967d2' }}>Details</div>
                <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {([['Load #', '4124121'], ['Pickup #', '3907780'], ['Internal ID', '10255']] as ReadonlyArray<[string, string]>).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 12, color: '#5f6368' }}>{k}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <span className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>{v}</span>
                        <Copy size={13} strokeWidth={2} style={{ color: '#9aa0a6' }} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* assigned-truck card tucked under the phone */}
            <div className="hidden lg:flex" style={{ flexDirection: 'column', gap: 14, width: 232, maxWidth: '100%', marginLeft: -26, marginBottom: 42, alignSelf: 'flex-end', position: 'relative', zIndex: 2 }}>
              <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, boxShadow: '0 16px 34px -16px rgba(26,35,50,.3)', padding: '15px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 42, height: 42, flex: 'none', borderRadius: 11, background: '#e8f0fe', display: 'grid', placeItems: 'center' }}><Truck size={22} strokeWidth={2} style={{ color: '#1967d2' }} /></span>
                <div>
                  <div className="font-mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9aa0a6' }}>Assigned truck</div>
                  <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124', marginTop: 2 }}>Eagle #1043</div>
                  <div style={{ fontSize: 12, color: '#5f6368' }}>Dry Van · Trailer #509</div>
                </div>
              </div>
            </div>

            {/* green-check list */}
            <div className="lg:ml-[38px] mt-8 lg:mt-0" style={{ display: 'flex', flexDirection: 'column', gap: 18, width: 250, maxWidth: '100%' }}>
              {checks.map(([title, sub]) => (
                <div key={title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{ width: 22, height: 22, flex: 'none', borderRadius: 999, background: '#e6f4ea', display: 'grid', placeItems: 'center', marginTop: 1 }}><Check size={13} strokeWidth={2.6} style={{ color: '#1e8e3e' }} /></span>
                  <div>
                    <div className="font-display" style={{ fontWeight: 700, fontSize: 15, color: '#202124' }}>{title}</div>
                    <div style={{ fontSize: 13.5, lineHeight: 1.5, color: '#5f6368', marginTop: 2 }}>{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── Feature 02 · Paperwork + Feature 03 · Scheduling (shared gray band) ──────

function PaperworkAndScheduling() {
  return (
    <section style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '88px 0' }}>
      {/* Feature 02 — Paperwork */}
      <Reveal>
        <div id="paperwork" className={`${WRAP} grid items-center gap-12 lg:gap-12 grid-cols-1 lg:grid-cols-[0.85fr_1.15fr]`} style={{ scrollMarginTop: 150 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 46, height: 46, borderRadius: 13, background: '#fef0e6', display: 'grid', placeItems: 'center' }}><ScanLine size={22} strokeWidth={2} style={{ color: '#c5631e' }} /></span>
              <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#c5631e', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Paperwork submission</span>
            </div>
            <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.2vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '18px 0 0', color: '#202124', maxWidth: 440 }}>No more chasing down paperwork from drivers.</h2>
            <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0', maxWidth: 460 }}>Dispatch can request paperwork right from the calendar, and the driver gets a push to upload. The built-in scanner auto-crops each page into a clean, multi-page PDF, named for you from the load number, and the moment it uploads, dispatch sees it on the load.</p>
            <div style={{ marginTop: 22 }}>
              <PushCard title="Remember to upload POD" body="Ardent: Lancaster, TX → Dallas, TX, Upload POD for each stop." style={{ maxWidth: 362 }} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-stretch">
            {/* Scan → PDF */}
            <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 10px 30px -16px rgba(26,35,50,.2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="Scan → PDF" right={<span style={{ fontSize: 12, color: '#5f6368' }}>Auto-crop · multi-page</span>} />
              <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-end', padding: '24px 18px 0', background: 'linear-gradient(180deg,#fff,#f4f6f8)' }}>
                <HalfPhone src="/driver-add-document.png" alt="Add document, scan to PDF" />
              </div>
            </div>
            {/* POD uploaded */}
            <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 10px 30px -16px rgba(26,35,50,.2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="POD uploaded" right={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: '#1e7a3d' }}><span style={{ width: 7, height: 7, borderRadius: 999, background: '#1e8e3e' }} />Synced</span>} />
              <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: '#fff', border: '1px solid #e8eaed', borderRadius: 14, padding: '14px 16px' }}>
                  <span style={{ width: 46, height: 46, flex: 'none', borderRadius: 11, background: '#eef1f4', display: 'grid', placeItems: 'center' }}><FileText size={22} strokeWidth={1.9} style={{ color: '#5f6368' }} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="font-mono" style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: '#1e7a3d', background: '#e6f4ea', borderRadius: 5, padding: '2px 7px' }}>POD</span>
                    <div className="font-display" style={{ fontWeight: 700, fontSize: 14.5, color: '#202124', marginTop: 6 }}>4124121_POD.pdf</div>
                    <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 1 }}>Jun 26 at 12:53 PM · 436 KB</div>
                  </div>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/dispatch-card-hero.png" alt="Load on the dispatcher's calendar with a POD icon" style={{ display: 'block', width: 190, maxWidth: '100%', height: 'auto', margin: '0 auto', filter: 'drop-shadow(0 14px 26px rgba(26,35,50,.2))' }} />
                <div style={{ fontSize: 12.5, color: '#5f6368', textAlign: 'center', maxWidth: 240, margin: '0 auto' }}>A POD icon hits the event in the calendar the moment it&rsquo;s uploaded.</div>
              </div>
            </div>
          </div>
        </div>
      </Reveal>

      {/* Feature 03 — Scheduling (copy on the right) */}
      <Reveal>
        <div id="scheduling" className={`${WRAP} grid items-center gap-12 lg:gap-12 grid-cols-1 lg:grid-cols-[1.15fr_0.85fr]`} style={{ marginTop: 64, scrollMarginTop: 150 }}>
          <div className="order-1 lg:order-2">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 46, height: 46, borderRadius: 13, background: '#e6f4ea', display: 'grid', placeItems: 'center' }}><Calendar size={22} strokeWidth={2} style={{ color: '#1e8e3e' }} /></span>
              <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: '#1e8e3e', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Driver scheduling</span>
            </div>
            <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(28px, 3.2vw, 40px)', lineHeight: 1.08, letterSpacing: '-0.022em', margin: '18px 0 0', color: '#202124' }}>Know the week before it starts.</h2>
            <p style={{ fontSize: 17.5, lineHeight: 1.6, color: '#5f6368', margin: '14px 0 0', maxWidth: 460 }}>The Schedule tab lays out every load for the week with its truck assignment and start and end times. Flip between a clean <strong style={{ color: '#202124' }}>list</strong> and an hour-by-hour <strong style={{ color: '#202124' }}>timeline</strong>, and tap any load to open its full detail.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-stretch order-2 lg:order-1">
            {/* list view */}
            <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 10px 30px -16px rgba(26,35,50,.2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="List view" />
              <div style={{ flex: 1, position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'flex-end', padding: '24px 18px 0', background: 'linear-gradient(180deg,#fff,#eef1f4)' }}>
                <HalfPhone src="/driver-schedule-list.png" alt="Schedule, list view" />
                <div className="hidden lg:flex" style={{ position: 'absolute', left: 18, bottom: 30, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 11, boxShadow: '0 10px 24px -12px rgba(26,35,50,.3)', padding: '8px 12px', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 26, height: 26, flex: 'none', borderRadius: 7, background: '#e8f0fe', display: 'grid', placeItems: 'center' }}><Truck size={15} strokeWidth={2} style={{ color: '#1967d2' }} /></span>
                  <div><div className="font-mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9aa0a6' }}>Truck</div><div className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>Eagle #1043</div></div>
                </div>
              </div>
            </div>
            {/* hourly view */}
            <div style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 18, boxShadow: '0 10px 30px -16px rgba(26,35,50,.2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CardHeader title="Hourly view" />
              <div style={{ flex: 1, position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'flex-end', padding: '24px 18px 0', background: 'linear-gradient(180deg,#fff,#eef1f4)' }}>
                <HalfPhone src="/driver-schedule-hourly.png" alt="Schedule, hourly timeline" />
                <div className="hidden lg:flex" style={{ position: 'absolute', right: 18, top: 74, zIndex: 3, background: '#fff', border: '1px solid #e8eaed', borderRadius: 11, boxShadow: '0 10px 24px -12px rgba(26,35,50,.3)', padding: '8px 12px', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 26, height: 26, flex: 'none', borderRadius: 7, background: '#e6f4ea', display: 'grid', placeItems: 'center' }}><Clock size={15} strokeWidth={2} style={{ color: '#1e8e3e' }} /></span>
                  <div><div className="font-mono" style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9aa0a6' }}>Window</div><div className="font-display" style={{ fontWeight: 700, fontSize: 12.5, color: '#202124' }}>11:30a-2p</div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Dispatch → driver (interactive) ─────────────────────────────────────────

function DispatchSection() {
  return (
    <section id="notify" style={{ background: '#f8f9fa', padding: '88px 0', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <Reveal>
          <DispatchNotify />
        </Reveal>
      </div>
    </section>
  );
}

// ── Final CTA ───────────────────────────────────────────────────────────────

function FinalCta({ cta }: { cta: { href: string; label: string } }) {
  return (
    <section style={{ background: 'var(--gc-blue)', color: '#fff' }}>
      <div className={`${WRAP} text-center`} style={{ paddingTop: 92, paddingBottom: 92 }}>
        <Reveal>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.72)' }}>Get started</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(32px, 4.5vw, 52px)', lineHeight: 1.06, letterSpacing: '-0.022em', margin: '16px auto 0', maxWidth: 780 }}>
            Dispatching just got <span style={{ color: '#202124' }}>easier.</span>
          </h2>
          <p style={{ fontSize: 18.5, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)', maxWidth: 520, margin: '20px auto 0' }}>
            14 days free. No sales call. The driver app comes free with every FleetCal seat, iOS and Android.
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

// ── Footer ──────────────────────────────────────────────────────────────────

function Footer() {
  const cols: ReadonlyArray<[string, ReadonlyArray<[string, string, boolean]>]> = [
    ['Product', [
      ['Calendar',   '/product/calendar', false],
      ['Payroll',    '/product/payroll', false],
      ['Dashboard',  '/product/dashboard', false],
      ['Paperwork',  '/product/paperwork', false],
      ['Billing',    '/product/billing', false],
      ['Driver App', '/product/driver-app', true],
    ]],
    ['Company', [
      ['Why FleetCal',  '/#story', false],
      ['Contact sales', '/contact-sales', false],
      ['Support',       '/support', false],
    ]],
    ['Account', [
      ['Sign in', '/sign-in', false],
      ['Sign up', '/sign-up', false],
      ['Home',    '/', false],
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
            {links.map(([label, href, active]) => (
              <Link key={label} href={href} style={{ display: 'block', fontSize: 15, color: active ? '#202124' : '#5f6368', fontWeight: active ? 600 : 400, textDecoration: 'none', padding: '6px 0' }}>{label}</Link>
            ))}
          </div>
        ))}
      </div>
      <div className={`${WRAP}`} style={{ borderTop: '1px solid #e8eaed', paddingTop: 20, paddingBottom: 20 }}>
        <span className="font-mono" style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5f6368' }}>© 2026 FleetCal</span>
      </div>
    </footer>
  );
}

// ── Small shared bits ───────────────────────────────────────────────────────

function CardHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 18px', borderBottom: '1px solid #e8eaed' }}>
      <span className="font-display" style={{ fontWeight: 700, fontSize: 14, color: '#202124' }}>{title}</span>
      {right}
    </div>
  );
}

/** Top-rounded "half phone" bezel that sits on a card floor (features 02/03).
 *  Shows only the TOP of the tall (1206×2622) screenshot, cropped to the bezel
 *  floor, so it reads as a phone peeking up rather than a full skinny sliver. */
function HalfPhone({ src, alt }: { src: string; alt: string }) {
  return (
    <div style={{ width: 236, maxWidth: '100%', background: '#0b0b0c', borderRadius: '38px 38px 0 0', padding: '8px 8px 0', boxShadow: '0 20px 44px -22px rgba(26,35,50,.4)' }}>
      <div style={{ borderRadius: '31px 31px 0 0', overflow: 'hidden', background: '#fff' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} style={{ display: 'block', width: '100%', height: 340, objectFit: 'cover', objectPosition: 'top' }} />
      </div>
    </div>
  );
}

/** iOS push-notification card (hero + paperwork copy). */
function PushCard({ title, body, style }: { title: string; body: string; style?: React.CSSProperties }) {
  return (
    <div style={{ background: 'rgba(250,250,252,0.95)', border: '0.5px solid rgba(0,0,0,0.06)', borderRadius: 18, boxShadow: '0 14px 32px -14px rgba(26,35,50,.26)', padding: '13px 15px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="font-display" style={{ width: 22, height: 22, flex: 'none', borderRadius: 6, background: '#1a73e8', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 800, fontSize: 10, letterSpacing: '-0.02em' }}>FC</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#6b6f76' }}>FleetCal</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9aa0a6' }}>now</span>
      </div>
      <div style={{ fontWeight: 600, fontSize: 14, color: '#1c1c1e', marginTop: 6, letterSpacing: '-0.01em' }}>{title}</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.4, color: '#3a3a3c', marginTop: 2 }}>{body}</div>
    </div>
  );
}

/** Black app-store badge pill (placeholder SVG glyphs per the handoff). */
function AppStoreBadge({ kind, href, placeholder = false }: { kind: 'apple' | 'google'; href?: string; placeholder?: boolean }) {
  const icon = kind === 'apple' ? (
    <svg viewBox="0 0 384 512" width="22" height="22" fill="#fff" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" /></svg>
  ) : (
    <svg viewBox="0 0 24 26" width="21" height="23" aria-hidden="true">
      <polygon points="2.5,2 9,13 2.5,24" fill="#00C3FF" />
      <polygon points="2.5,2 9,13 20,11.5" fill="#00E676" />
      <polygon points="9,13 20,11.5 20,14.5" fill="#FFCE00" />
      <polygon points="2.5,24 9,13 20,14.5" fill="#FF3D47" />
    </svg>
  );
  const label = kind === 'apple' ? 'App Store' : 'Google Play';
  const top = placeholder ? 'Coming soon to' : kind === 'apple' ? 'Download on the' : 'Get it on';
  const body = (
    <>
      {icon}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: kind === 'apple' ? '0.02em' : '0.06em', textTransform: kind === 'apple' ? 'none' : 'uppercase', color: '#fff' }}>{top}</span>
        <span className="font-display" style={{ fontWeight: 700, fontSize: 18, color: '#fff', marginTop: 3 }}>{label}</span>
      </span>
    </>
  );
  if (placeholder) {
    return (
      <div aria-label={`${label}, coming soon`} style={{ display: 'inline-flex', alignItems: 'center', gap: 11, background: '#000', borderRadius: 12, padding: '10px 18px', opacity: 0.5, cursor: 'default' }}>
        {body}
      </div>
    );
  }
  return (
    <Link href={href ?? '#'} target="_blank" rel="noopener noreferrer" aria-label={kind === 'apple' ? 'Download on the App Store' : 'Get it on Google Play'} style={{ display: 'inline-flex', alignItems: 'center', gap: 11, background: '#000', borderRadius: 12, padding: '10px 18px', textDecoration: 'none' }}>
      {body}
    </Link>
  );
}
