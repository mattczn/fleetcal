import Link from 'next/link';
import { Fragment } from 'react';
import { Calendar, Smartphone, FileCheck, CreditCard, Wallet, BarChart3, ArrowRight, ArrowLeft, CalendarCheck } from 'lucide-react';

/**
 * ProductFlowFooter — the "where this fits" nav shared by every /product page.
 * A clickable stepper of the whole FleetCal flow (current page highlighted, so
 * users can jump to any step) plus prominent Previous / Next step cards for the
 * natural forward/back motion. Pass the current page's `key` (matches FLOW).
 *
 * Flow order: dispatch calendar → driver app → paperwork → billing → payroll → insights.
 */
const WRAP = 'mx-auto w-full max-w-[1600px] px-5 sm:px-6 md:px-8 lg:px-12';

type Step = {
  key: string; label: string; short: string; href: string;
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number; style?: React.CSSProperties }>;
  color: string; light: string; blurb: string;
};

export const FLOW: ReadonlyArray<Step> = [
  { key: 'calendar',   label: 'Dispatch calendar',      short: 'Calendar',   href: '/product/calendar',   Icon: Calendar,   color: '#1a73e8', light: '#e8f0fe', blurb: 'See every truck on a live calendar and drag loads to drivers.' },
  { key: 'driver-app', label: 'Driver app',             short: 'Driver app', href: '/product/driver-app', Icon: Smartphone, color: '#7c3aed', light: '#f1ebfe', blurb: 'Every assigned load in the driver’s pocket, synced to the board.' },
  { key: 'paperwork',  label: 'Paperwork verification', short: 'Paperwork',  href: '/product/paperwork',  Icon: FileCheck,  color: '#ea580c', light: '#fcebe2', blurb: 'Verify the POD against the rate con, then release clean loads.' },
  { key: 'billing',    label: 'Billing',                short: 'Billing',    href: '/product/billing',    Icon: CreditCard, color: '#1e8e3e', light: '#e6f4ea', blurb: 'Batch a week’s invoices and send them in a single sweep.' },
  { key: 'payroll',    label: 'Payroll',                short: 'Payroll',    href: '/product/payroll',    Icon: Wallet,     color: '#0d9488', light: '#e0f2f0', blurb: 'Driver events roll into weekly payroll, ready to finalize.' },
  { key: 'dashboard',  label: 'Insights',               short: 'Insights',   href: '/product/dashboard',  Icon: BarChart3,  color: '#e11d48', light: '#fce8ec', blurb: 'Revenue by truck, customer, and lane at a glance.' },
];

// After the last product in the flow (Insights), the "next" card invites a demo.
const DEMO: Step = { key: 'demo', label: 'Book a demo', short: 'Demo', href: '/contact-sales', Icon: CalendarCheck, color: '#1a73e8', light: '#e8f0fe', blurb: 'See FleetCal on your own fleet, from dispatch to invoice.' };

export default function ProductFlowFooter({ current }: { current: string }) {
  const idx = FLOW.findIndex((s) => s.key === current);
  const prev = idx > 0 ? FLOW[idx - 1] : null;
  const next = idx >= 0 && idx < FLOW.length - 1 ? FLOW[idx + 1] : (idx === FLOW.length - 1 ? DEMO : null);
  const cur = idx >= 0 ? FLOW[idx] : FLOW[0];

  return (
    <section style={{ background: '#f8f9fa', borderTop: '1px solid #e8eaed', padding: '64px 0' }}>
      <div className={WRAP}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase', color: cur.color }}>Keep exploring</span>
          <h2 className="font-display" style={{ fontWeight: 800, fontSize: 'clamp(24px, 2.6vw, 32px)', lineHeight: 1.1, letterSpacing: '-0.022em', margin: '12px 0 0', color: '#202124' }}>Every step, one system.</h2>
        </div>

        {/* clickable stepper — jump to any page */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 34 }}>
          {FLOW.map((s, i) => (
            <Fragment key={s.key}>
              <Link
                href={s.href}
                aria-current={s.key === current ? 'page' : undefined}
                className="font-display"
                style={{
                  fontSize: 13.5,
                  fontWeight: s.key === current ? 700 : 500,
                  color: s.key === current ? s.color : '#5f6368',
                  background: s.key === current ? s.light : 'transparent',
                  border: `1px solid ${s.key === current ? s.color : 'transparent'}`,
                  borderRadius: 999,
                  padding: '7px 15px',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  boxShadow: s.key === current ? '0 1px 2px rgba(60,64,67,.08)' : 'none',
                }}>
                {s.short}
              </Link>
              {i < FLOW.length - 1 && <ArrowRight size={13} style={{ color: '#c4c7c9', flex: 'none' }} />}
            </Fragment>
          ))}
        </div>

        {/* previous / next cards */}
        <div className={`grid grid-cols-1 gap-5 ${prev && next ? 'md:grid-cols-2' : ''}`}>
          {prev && <FlowCard step={prev} dir="prev" />}
          {next && <FlowCard step={next} dir={next.key === 'demo' ? 'demo' : 'next'} />}
        </div>
      </div>
    </section>
  );
}

function FlowCard({ step, dir }: { step: Step; dir: 'prev' | 'next' | 'demo' }) {
  const Icon = step.Icon;
  return (
    <Link
      href={step.href}
      style={{ display: 'flex', alignItems: 'center', gap: 16, background: '#fff', border: '1px solid #e8eaed', borderRadius: 16, padding: '20px 22px', textDecoration: 'none', boxShadow: '0 1px 2px rgba(60,64,67,.08)' }}>
      <span style={{ width: 48, height: 48, flex: 'none', borderRadius: 13, background: step.light, display: 'grid', placeItems: 'center' }}>
        <Icon size={23} strokeWidth={2} style={{ color: step.color }} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="font-mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: step.color }}>{dir === 'prev' ? 'Previous step' : dir === 'demo' ? 'Get started' : 'Next step'}</div>
        <div className="font-display" style={{ fontWeight: 700, fontSize: 18, color: '#202124', marginTop: 3 }}>{step.label}</div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: '#5f6368', marginTop: 2 }}>{step.blurb}</div>
      </div>
      <span className="font-display hidden sm:inline-flex" style={{ alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 15, color: step.color, whiteSpace: 'nowrap', flex: 'none' }}>
        {dir === 'prev' ? <><ArrowLeft size={16} strokeWidth={2.4} /> Back</> : dir === 'demo' ? <>Get in touch <ArrowRight size={16} strokeWidth={2.4} /></> : <>Explore <ArrowRight size={16} strokeWidth={2.4} /></>}
      </span>
    </Link>
  );
}
