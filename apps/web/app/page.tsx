import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { ArrowRight, Calendar, FileText, Receipt, Users } from 'lucide-react';

/**
 * Marketing landing page at `/`.
 *
 * Signed-in users with an org get bounced straight to /calendar — the
 * landing exists purely for prospects and for the first paint after a
 * sign-out. Signed-in-but-no-org users go to /create-organization so
 * they can finish onboarding (mirrors what middleware does for all
 * other private routes).
 *
 * Server component. Reads `auth()` synchronously on the server so we
 * never flash the landing to a returning customer.
 */
export default async function HomePage() {
  const { userId, orgId } = await auth();
  if (userId && orgId)  redirect('/calendar');
  if (userId && !orgId) redirect('/create-organization');

  return (
    <div
      className="h-full overflow-y-auto"
      style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-1)' }}
    >
      <main className="max-w-5xl mx-auto px-6 pt-16 pb-24 sm:pt-24">

        {/* Header — wordmark + auth links */}
        <header className="flex items-center justify-between mb-20 sm:mb-28">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold"
              style={{ background: 'var(--gc-blue)' }}
            >
              F
            </div>
            <span className="text-[20px] font-semibold tracking-tight">FleetCal</span>
          </div>
          <Link
            href="/sign-in"
            className="text-[14px] font-medium hover:underline"
            style={{ color: 'var(--gc-text-2)' }}
          >
            Sign in
          </Link>
        </header>

        {/* Hero */}
        <section className="mb-20 sm:mb-28">
          <h1 className="text-[40px] sm:text-[56px] font-bold tracking-tight leading-[1.05] mb-5 sm:mb-7 max-w-3xl">
            The TMS built by a 13-truck fleet owner, for fleets like yours.
          </h1>
          <p
            className="text-[17px] sm:text-[19px] leading-[1.55] max-w-2xl mb-9 sm:mb-11"
            style={{ color: 'var(--gc-text-2)' }}
          >
            Rate-con to invoice in one tool. No ELD lock-in. No per-driver fees.
            Built and used daily at Curzon Trucking in Salt Lake City.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <Link
              href="/sign-up"
              className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-[15px] font-semibold transition-colors"
              style={{ background: 'var(--gc-blue)', color: '#fff' }}
            >
              Start your free trial
              <ArrowRight size={16} />
            </Link>
            <Link
              href="/sign-in"
              className="text-[15px] font-medium hover:underline"
              style={{ color: 'var(--gc-text-2)' }}
            >
              Already have an account?
            </Link>
          </div>
        </section>

        {/* Features — 2x2 grid */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-9 mb-20 sm:mb-24">
          <FeatureBlock
            icon={FileText}
            title="AI rate-con parser"
            body="Drop a rate confirmation PDF onto the calendar. Customer, rate, stops, and appointment times extracted automatically. Edit what's wrong, save what's right."
          />
          <FeatureBlock
            icon={Calendar}
            title="Real dispatch calendar"
            body="One screen for every truck on every day. Drag to reschedule. Day or week view. Built for the way dispatchers actually think — not for what looked good in a demo."
          />
          <FeatureBlock
            icon={Receipt}
            title="Paperwork to invoice in 3 clicks"
            body="POD verification queue. Release to billing. Generate the invoice. Send to the customer. Mark paid. Every step where it should be, no leaving the app."
          />
          <FeatureBlock
            icon={Users}
            title="Driver payroll built in"
            body="Per-driver weekly totals computed from the loads you actually ran. Detention and layover adjustments. Export when payroll Friday rolls around."
          />
        </section>

        {/* Pricing teaser */}
        <section
          className="rounded-2xl p-6 sm:p-8 mb-20"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}
        >
          <h2 className="text-[22px] sm:text-[26px] font-bold mb-3 tracking-tight">
            Three tiers. One product. Priced by fleet size.
          </h2>
          <p className="mb-7 text-[15px] max-w-2xl" style={{ color: 'var(--gc-text-2)' }}>
            Identical feature set at every tier. Pick the one that fits your
            truck count. Founding Carrier pricing — 50% off for life — for the
            first 20 sign-ups.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-7">
            <TierCard name="Starter" trucks="1–4 trucks" price="$149" />
            <TierCard name="Growth"  trucks="5–9 trucks" price="$299" />
            <TierCard name="Fleet"   trucks="10–14 trucks" price="$499" />
          </div>
          <Link
            href="/sign-up"
            className="inline-flex items-center gap-2 text-[15px] font-semibold hover:underline"
            style={{ color: 'var(--gc-blue)' }}
          >
            Get started — 14-day free trial
            <ArrowRight size={15} />
          </Link>
        </section>

        {/* Footer */}
        <footer
          className="flex flex-wrap items-center justify-between gap-3 pt-8 text-[13px]"
          style={{
            borderTop: '1px solid var(--gc-border-light)',
            color: 'var(--gc-text-3)',
          }}
        >
          <span>© {new Date().getFullYear()} FleetCal · Built in Salt Lake City</span>
          <div className="flex gap-5">
            <Link href="/sign-in" className="hover:underline">Sign in</Link>
            <Link href="/sign-up" className="hover:underline">Sign up</Link>
          </div>
        </footer>
      </main>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

type IconComponent = React.ComponentType<{ size?: number; style?: React.CSSProperties; strokeWidth?: number }>;

function FeatureBlock({ icon: Icon, title, body }: {
  icon: IconComponent;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center mb-4"
        style={{ background: 'var(--gc-blue-light)', color: 'var(--gc-blue)' }}
      >
        <Icon size={20} strokeWidth={2} />
      </div>
      <h3 className="text-[17px] font-semibold mb-2 tracking-tight">{title}</h3>
      <p className="text-[14.5px] leading-[1.55]" style={{ color: 'var(--gc-text-2)' }}>
        {body}
      </p>
    </div>
  );
}

function TierCard({ name, trucks, price }: {
  name: string;
  trucks: string;
  price: string;
}) {
  return (
    <div
      className="rounded-xl p-5"
      style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
    >
      <div className="text-[13px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
        {name}
      </div>
      <div className="text-[14px] mb-3" style={{ color: 'var(--gc-text-2)' }}>{trucks}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-[28px] font-bold tracking-tight">{price}</span>
        <span className="text-[13px]" style={{ color: 'var(--gc-text-3)' }}>/mo</span>
      </div>
    </div>
  );
}
