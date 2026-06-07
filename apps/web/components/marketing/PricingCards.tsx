/**
 * PricingCards — Systematica-style 3-tier pricing grid.
 *
 * Rendered on both `/` (embedded in the landing) and `/pricing`
 * (standalone). Each card has:
 *   - Colored top banner with tier name (mono uppercase)
 *   - Big serif price + truck-range subtext
 *   - Square-bullet feature list (cumulative — Growth includes Owner Op,
 *     Fleet includes Growth)
 *   - Solid blue "Start free trial" CTA routing to /sign-up
 *
 * Why we don't use Clerk's <PricingTable />: it has minimal UI for
 * signed-out viewers (no per-plan feature lists, no CTA buttons that
 * make sense before sign-up), and its rounded-corner styling clashes
 * with the Systematica zero-radius aesthetic. Once a user signs up
 * we can switch them to Clerk's hosted checkout via the post-signup
 * flow, but the public-facing pricing surface stays custom.
 */
import Link from 'next/link';

interface PricingTier {
  key: 'owner_op' | 'growth' | 'fleet';
  name: string;
  price: number;
  trucks: string;
  blurb: string;
  accent: 'orange' | 'green' | 'teal';
  popular?: boolean;
  features: string[];
}

// All three tiers ship the same feature set. The only knob that scales
// with price is the truck cap. This list is the canonical feature list
// shown identically on every card — edit here and all three update.
const SHARED_FEATURES = [
  'AI Rate-Con Parser',
  'Truck Dispatch Calendar',
  'Driver Payroll',
  'Custom Reports',
  'Paperwork Verification',
  'Billing and Invoicing',
  '… and more',
] as const;

const TIERS: PricingTier[] = [
  {
    key:    'owner_op',
    name:   'Owner Op',
    price:  99,
    trucks: '1–4 trucks',
    blurb:  'For the owner-op who is also the dispatcher.',
    accent: 'orange',
    features: [...SHARED_FEATURES],
  },
  {
    key:    'growth',
    name:   'Growth',
    price:  149,
    trucks: '5–9 trucks',
    blurb:  'When you have hired your first dispatcher.',
    accent: 'green',
    popular: true,
    features: [...SHARED_FEATURES],
  },
  {
    key:    'fleet',
    name:   'Fleet',
    price:  199,
    trucks: '10–14 trucks',
    blurb:  'When dispatch is its own department.',
    accent: 'teal',
    features: [...SHARED_FEATURES],
  },
];

const ACCENT_BG = {
  orange: '#F47316',
  green:  '#16A34A',
  teal:   '#0891B2',
} as const;

export default function PricingCards() {
  return (
    <div>
      <div className="grid md:grid-cols-3 gap-px bg-sys-line">
        {TIERS.map((tier) => (
          <PricingCard key={tier.key} tier={tier} />
        ))}
      </div>
    </div>
  );
}

function PricingCard({ tier }: { tier: PricingTier }) {
  return (
    <div
      className="bg-white flex flex-col"
      style={{ borderRadius: 0, position: 'relative' }}
    >
      {tier.popular && (
        <div
          className="absolute top-0 right-0 font-mono font-bold text-[10px] uppercase text-white px-3 py-1"
          style={{
            background: '#111827',
            letterSpacing: '0.15em',
            borderRadius: 0,
            transform: 'translateY(-50%)',
          }}
        >
          Most popular
        </div>
      )}

      {/* Colored banner — tier name */}
      <div
        className="font-mono font-bold text-[11px] uppercase text-white px-8 py-3"
        style={{ background: ACCENT_BG[tier.accent], letterSpacing: '0.12em' }}
      >
        {tier.name}
      </div>

      {/* Body */}
      <div className="px-8 py-10 flex-1 flex flex-col">
        {/* Price */}
        <div className="mb-2 flex items-baseline gap-2">
          <span className="font-display text-[56px] leading-none tracking-tight text-sys-primary">
            ${tier.price}
          </span>
          <span className="font-sys text-[15px] text-sys-muted">/ month</span>
        </div>
        <div className="font-sys font-semibold text-[14px] text-sys-primary mb-4">
          {tier.trucks}
        </div>
        <p className="font-sys text-[14px] leading-[1.6] text-sys-muted mb-8">
          {tier.blurb}
        </p>

        {/* CTA — pin near top of body for visual rhythm */}
        <Link
          href={`/sign-up?plan=${tier.key}`}
          className="inline-flex items-center justify-center bg-sys-blue text-white font-semibold text-[14px] px-6 py-3 hover:bg-sys-blue-hover transition-colors mb-10"
          style={{ borderRadius: 0 }}
        >
          Try for free →
        </Link>

        {/* Feature list — fills remaining space */}
        <ul className="space-y-3 mt-auto">
          {tier.features.map((f, i) => (
            <li
              key={i}
              className="flex items-start gap-3 font-sys text-[14px] leading-[1.5] text-sys-primary"
            >
              <span className="w-1.5 h-1.5 bg-sys-muted mt-2 flex-shrink-0" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
