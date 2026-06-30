import React from 'react';
import {
  X, Check, ArrowRight,
  FileText, Calendar, Smartphone, Upload, Send, BarChart3,
  Layers, UserCheck, ClipboardCheck, Camera, MapPin, List,
  Bell, Columns2, Archive, Receipt, Sparkles, Clock, CircleCheck,
  Calculator, Banknote, DollarSign, Route, TrendingUp, Truck,
} from 'lucide-react';
import Reveal from '@/components/marketing/Reveal';

const WRAP = 'mx-auto w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12';

export type BeforeAfterRow = {
  key: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  cat: string;
  before: string;
  after: string;
};

const DEFAULT_TITLE = (
  <>The old way, and <span style={{ color: 'var(--gc-blue)' }}>the FleetCal way.</span></>
);

const itemStyle = (i: number): React.CSSProperties => ({
  padding: i === 0 ? '0 0 15px' : '15px 0',
  borderTop: i === 0 ? undefined : '1px solid #e8eaed',
});

/** Center-spine split: the manual workflow (left, muted) vs FleetCal (right,
 *  accent) across a product's pain points, joined by a spine of transform
 *  arrows. One canonical chart shared by the home page and every product page;
 *  copy comes from `rows` (see BA_PRESETS). */
export default function BeforeAfterSection({
  rows,
  eyebrow = 'Before & after',
  title = DEFAULT_TITLE,
  sub = 'Here is what changes the day a fleet moves onto FleetCal.',
}: {
  rows: BeforeAfterRow[];
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <section id="before-after" style={{ padding: '104px 0', background: '#fff', borderTop: '1px solid #e8eaed', scrollMarginTop: 150 }}>
      <div className={WRAP}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <Reveal style={{ maxWidth: 720 }}>
            <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#1967d2' }}>{eyebrow}</span>
            <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(30px, 4vw, 46px)', lineHeight: 1.06, margin: '14px 0 0', letterSpacing: '-0.022em', color: '#202124' }}>{title}</h2>
            <p style={{ fontSize: 18, lineHeight: 1.6, color: '#5f6368', margin: '16px 0 0' }}>{sub}</p>
          </Reveal>
          <Reveal delay={120} style={{ marginTop: 44 }}>
            <div className="grid grid-cols-1 min-[880px]:grid-cols-[1fr_60px_1fr]" style={{ background: '#fff', border: '1px solid #e8eaed', borderRadius: 24, overflow: 'hidden', boxShadow: '0 1px 2px rgba(60,64,67,.10), 0 4px 16px -6px rgba(60,64,67,.16)' }}>
              {/* Left — the manual way */}
              <div style={{ background: '#f8f9fa', padding: '30px 30px 34px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: 22 }}>
                  <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff', color: '#5f6368', border: '1px solid #e8eaed', fontWeight: 700, fontSize: 13, padding: '7px 14px 7px 11px', borderRadius: 999 }}>
                    <X size={15} strokeWidth={2.6} /> The manual way
                  </span>
                </div>
                {rows.map((p, i) => (
                  <div key={p.key} style={itemStyle(i)}>
                    <div className="font-display" style={{ fontWeight: 700, fontSize: 13.5, color: '#3c4043', marginBottom: 6 }}>{p.cat}</div>
                    <p style={{ fontSize: 15.5, lineHeight: 1.55, color: '#5f6368', margin: 0 }}>{p.before}</p>
                  </div>
                ))}
              </div>
              {/* Spine — vertical line + a transform arrow per pain row */}
              <div className="hidden min-[880px]:flex" style={{ flexDirection: 'column', alignItems: 'center', padding: '92px 0 34px', position: 'relative', background: 'linear-gradient(90deg, #f8f9fa 0%, #eef4fe 100%)' }} aria-hidden="true">
                <div style={{ position: 'absolute', top: 92, bottom: 52, width: 2, left: '50%', transform: 'translateX(-50%)', background: 'rgba(26,115,232,0.26)' }} />
                {rows.map((p) => (
                  <span key={p.key} style={{ width: 30, height: 30, flex: 'none', borderRadius: 999, background: 'var(--gc-blue)', display: 'grid', placeItems: 'center', boxShadow: '0 2px 6px rgba(26,115,232,0.4)', margin: 'auto 0', position: 'relative', zIndex: 1 }}>
                    <ArrowRight size={16} strokeWidth={2.6} style={{ color: '#fff' }} />
                  </span>
                ))}
              </div>
              {/* Right — with FleetCal */}
              <div className="border-t min-[880px]:border-t-0" style={{ background: '#eef4fe', padding: '30px 30px 34px', display: 'flex', flexDirection: 'column', borderColor: '#e8eaed' }}>
                <div style={{ marginBottom: 22 }}>
                  <span className="font-display" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--gc-blue)', color: '#fff', fontWeight: 700, fontSize: 13, padding: '7px 14px 7px 11px', borderRadius: 999 }}>
                    <Check size={15} strokeWidth={3} /> With FleetCal
                  </span>
                </div>
                {rows.map((p, i) => (
                  <div key={p.key} style={itemStyle(i)}>
                    <div className="font-display" style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13.5, color: '#1967d2', marginBottom: 6 }}>
                      <p.Icon size={16} strokeWidth={2} />{p.cat}
                    </div>
                    <p style={{ fontSize: 15.5, lineHeight: 1.55, color: '#202124', margin: 0 }}>{p.after}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** Per-page copy. Keys map to the home page and each product page. Row counts
 *  vary by page (3–5) by design — kept tight, not padded. */
export const BA_PRESETS: Record<string, BeforeAfterRow[]> = {
  home: [
    { key: 'load',    Icon: FileText,   cat: 'Booking a load',       before: 'Read the rate con and retype every stop, rate, and reference by hand.',            after: 'Drop the PDF and AI fills the whole load in seconds, almost 99% accuracy.' },
    { key: 'fleet',   Icon: Calendar,   cat: 'Seeing the fleet',     before: 'Guess from texts and memory which trucks are booked and which are sitting.',        after: 'Every truck on one calendar, so you can see what’s moving and what needs a load.' },
    { key: 'comms',   Icon: Smartphone, cat: 'Driver communication', before: 'Copy-paste load details into group chats, constant status update requests.',         after: 'Load details push straight to the driver’s app, with a notification for every change.' },
    { key: 'docs',    Icon: Upload,     cat: 'Driver paperwork',     before: 'PODs and receipts get lost in text threads, then you chase down what’s missing.',     after: 'Drivers upload every doc from the cab, filed to the right load in one place.' },
    { key: 'pay',     Icon: Send,       cat: 'Getting paid',         before: 'Send each invoice by hand, hunting down paperwork load by load.',                   after: 'Batch a whole week of invoices, billing rules read for you.' },
    { key: 'numbers', Icon: BarChart3,  cat: 'Knowing your numbers', before: 'Take the broker’s word on what a lane pays; guess at your real margin.',             after: 'Live RPM and revenue by truck, driver, and lane, updated in real time.' },
  ],
  calendar: [
    { key: 'fleet',   Icon: Calendar,       cat: 'Seeing the whole fleet',            before: 'Dig through loads and notes to work out which trucks are booked and which are sitting open.',                                  after: 'Every truck on one calendar, color-coded, see at a glance what’s booked and what needs work.' },
    { key: 'book',    Icon: FileText,       cat: 'Booking a load',                    before: 'Read the rate con and retype every stop, rate, and reference number by hand.',                                              after: 'Drop the PDF and AI fills the whole load in seconds, almost 99% accuracy.' },
    { key: 'details', Icon: Layers,         cat: 'All the load details in one place', before: 'Search your email for the rate con, plug addresses into Google Maps, and switch tabs to your ELD for the truck’s location.', after: 'Rate con, route map, and live truck location on one load, everything in a single place.' },
    { key: 'assign',  Icon: UserCheck,      cat: 'Assigning a driver',                before: 'Copy-paste load details into driver group chats, then confirm who’s good to run it.',                                       after: 'Drag to assign a driver, truck preferences saved. The load is sent to their app automatically on assignment.' },
    { key: 'status',  Icon: ClipboardCheck, cat: 'Tracking load status',              before: 'Dig through emails, texts, and spreadsheets to keep track of each load’s status and accessorials.',                          after: 'Update status, add accessorials, and set driver pay right on the load, all in one place.' },
  ],
  driverApp: [
    { key: 'details', Icon: Smartphone, cat: 'Getting load details', before: 'Driver writes it down and copies it into Google Maps for routing, then calls when they’re missing a reference number.', after: 'Load details push straight to the driver’s app when assigned, stops, times, reference numbers, all there.' },
    { key: 'docs',    Icon: Camera,     cat: 'Uploading docs',       before: 'Photo to a text thread, hope the dispatcher sees it and files it before it’s buried.',                              after: 'Driver taps Upload in the app. The POD goes straight to the load, visible to dispatch and ready to bill.' },
    { key: 'status',  Icon: MapPin,     cat: 'Updating status',      before: 'Dispatcher texts or calls mid-run for a status update. Driver has to stop and answer, or updates get delayed.',     after: 'One tap, picked up, en route, delivered. Dispatch sees the update in real time without calling.' },
    { key: 'next',    Icon: List,       cat: 'Knowing what’s next',  before: 'Drivers ask dispatch to confirm their schedule day and night.',                                                    after: 'Upcoming loads are in the app. The driver sees what’s assigned and when, no call needed.' },
  ],
  paperwork: [
    { key: 'collect', Icon: Upload,   cat: 'Collecting PODs',       before: 'Drivers text or email photos whenever they remember, buried in threads, often blurry or missing.',           after: 'Drivers are prompted to upload when they mark the load delivered. Every doc lands on the right load.' },
    { key: 'chase',   Icon: Bell,     cat: 'Chasing missing docs',  before: 'Realize a POD is missing when the broker asks, then hunt down the driver days later.',                       after: 'Loads without required docs show a flag. You see what’s missing before billing, not after.' },
    { key: 'review',  Icon: Columns2, cat: 'Reviewing the POD',     before: 'Pull up the rate con and POD together to confirm they match the requirements, or just hope it’s enough.',    after: 'See the POD and rate con side by side for review, then release it for invoicing in seconds.' },
    { key: 'find',    Icon: Archive,  cat: 'Finding old paperwork', before: 'Search your camera roll and email history, hoping the driver sent the right file.',                          after: 'Every doc is filed to its load and searchable. Pull any load’s full packet in seconds.' },
  ],
  billing: [
    { key: 'invoice', Icon: Receipt,     cat: 'Invoicing a load',             before: 'Open a template, retype the rate, stops, and reference numbers from the rate con, attach docs by hand.', after: 'The invoice pulls from the load automatically, rate, stops, reference numbers already there. One click to send.' },
    { key: 'rules',   Icon: Sparkles,    cat: 'Getting billing right',        before: 'Dig through the rate con to find each customer’s billing instructions before you can invoice.',         after: 'AI extracts the billing instructions, so you can send the invoice confident it will reach them.' },
    { key: 'access',  Icon: Clock,       cat: 'Catching accessorials',        before: 'Dispatch notes there was detention on a load, but it never gets followed up on or billed.',             after: 'See when a load has accessorials and make sure they’re approved before it goes out for billing.' },
    { key: 'batch',   Icon: Layers,      cat: 'Batching end-of-week billing', before: 'Work through a pile of rate cons Friday afternoon, invoicing each load one at a time.',                  after: 'Select all delivered loads and generate invoices in bulk. A week’s billing in a few minutes.' },
    { key: 'paid',    Icon: CircleCheck, cat: 'Tracking what’s been paid',    before: 'An email inbox and a spreadsheet, updated by hand, things slip when you’re busy.',                       after: 'Every invoice has a status: sent, pending, paid. Outstanding AR shows on the dashboard without digging.' },
  ],
  payroll: [
    { key: 'calc',   Icon: Calculator, cat: 'Calculating driver pay',             before: 'Pull loads from a spreadsheet, calculate each driver’s percentage by hand, check for mistakes.',                      after: 'Set a percentage pay rule once per driver. FleetCal calculates every load, and you adjust when closing out the week.' },
    { key: 'week',   Icon: Banknote,   cat: 'Running payroll week',               before: 'Reconstruct who drove what from texts and memory. Disputes happen because nobody kept the same record.',               after: 'Every load event is already logged with its driver. Generate the pay summary and export to your payroll tool.' },
    { key: 'extras', Icon: Receipt,    cat: 'Accessorials, deductions & bonuses', before: 'Remember which drivers got advances, accessorials, or bonuses, then add them up by hand and hope the math is right.', after: 'Accessorials, deductions, and bonuses are autofilled or added manually, rolling into the weekly totals automatically.' },
  ],
  dashboard: [
    { key: 'margin',  Icon: DollarSign, cat: 'Knowing your true margin',   before: 'Take the broker’s word on what a lane pays and guess at your real margin after costs.',          after: 'Live RPM and revenue by truck, driver, and customer, so you know exactly what’s making money.' },
    { key: 'pays',    Icon: Route,      cat: 'Finding what pays',          before: 'No clear read on which customers and trucks actually pay, just a gut feel from a busy week.',     after: 'Performance broken out by customer and truck, plus custom reports to dig in and surface more insights.' },
    { key: 'revenue', Icon: TrendingUp, cat: 'Tracking revenue over time', before: 'Add up the month in a spreadsheet weeks later, when it’s too late to change anything.',          after: 'Revenue over time updates as loads close, see the trend by week and month as it happens.' },
    { key: 'idle',    Icon: Truck,      cat: 'Catching idle trucks',       before: 'Guess from memory which trucks haven’t moved in days and are burning fixed cost.',                after: 'Asset reports surface trucks that aren’t earning, so you can get them covered or off the books.' },
  ],
};
