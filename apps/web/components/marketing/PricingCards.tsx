'use client';

/**
 * PricingCards — Google Workspace–style 3-tier pricing grid.
 *
 * Rewritten from the prior Systematica zero-radius look:
 *   - rounded-3xl cards w/ soft elevation
 *   - segmented Monthly / Annual (save up to 20%) toggle above the grid
 *   - "Growth" is the popular tier — 2px blue ring + lifted, plus
 *     "Most popular" pill in the top-right corner
 *   - Tonal CTA (blue-light) on non-popular, primary pill on popular
 *   - Green-light check circles in front of every feature row
 *
 * Prices mirror the values configured in Clerk Billing (Production
 * instance, Configure → Billing → Plans). If those change, update
 * the TIERS constant below so the displayed numbers stay in sync
 * with what the user is actually charged at checkout:
 *
 *   Owner Op  monthly $99    · annual $948/yr   ($79/mo  · save $240/yr / 20%)
 *   Growth    monthly $149   · annual $1,548/yr ($129/mo · save $240/yr / 13%)
 *   Fleet     monthly $199   · annual $2,028/yr ($169/mo · save $360/yr / 15%)
 *
 * The post-signup flow routes to Clerk's hosted checkout via
 * `/sign-up?plan=${key}&period=${monthly|annual}`. The period param
 * is threaded through /sign-up → /create-organization → /onboarding/
 * pick-plan so the customer's monthly/annual choice on this card
 * survives the funnel and pre-selects the right billing option at
 * Clerk's PricingTable checkout step.
 */
import Link from 'next/link';
import { useState } from 'react';
import { Check } from 'lucide-react';

interface PricingTier {
  key:           'owner_op' | 'growth' | 'fleet';
  name:          string;
  /** Monthly billing rate. Matches Clerk's "Monthly base fee". */
  monthlyPrice:  number;
  /** Effective per-month rate when billed annually. Display only —
   *  the actual charge is `annualTotal` once a year. */
  annualMonthly: number;
  /** Annual total Clerk charges once for the year. Matches Clerk's
   *  "Annual base fee". Shown in the "billed annually · $X /yr"
   *  sub-line so customers know exactly what hits their card. */
  annualTotal:   number;
  trucks:        string;
  blurb:         string;
  /** CSS color string — tier eyebrow uses this. */
  accent:        string;
  popular?:      boolean;
}

const SHARED_FEATURES = [
  'AI rate-con parser',
  'Truck dispatch calendar',
  'Driver payroll',
  'Custom reports',
  'Paperwork verification',
  'Billing & invoicing',
  '… and more',
] as const;

const TIERS: readonly PricingTier[] = [
  {
    key:           'owner_op',
    name:          'Owner Op',
    monthlyPrice:  99,
    annualMonthly: 79,
    annualTotal:   948,
    trucks:        '1–4 trucks',
    blurb:         'For the owner-op who is also the dispatcher.',
    accent:        '#f97316',
  },
  {
    key:           'growth',
    name:          'Growth',
    monthlyPrice:  149,
    annualMonthly: 129,
    annualTotal:   1548,
    trucks:        '5–9 trucks',
    blurb:         'When you have hired your first dispatcher.',
    accent:        '#1e8e3e',
    popular:       true,
  },
  {
    key:           'fleet',
    name:          'Fleet',
    monthlyPrice:  199,
    annualMonthly: 169,
    annualTotal:   2028,
    trucks:        '10–14 trucks',
    blurb:         'When dispatch is its own department.',
    accent:        '#0891b2',
  },
];

export default function PricingCards() {
  const [annual, setAnnual] = useState(false);

  return (
    <div>
      {/* Monthly / Annual segmented toggle */}
      <div className="flex justify-center" style={{ marginTop: 12 }}>
        <div
          className="inline-flex font-display"
          style={{
            background:   'var(--gc-bg)',
            borderRadius: 999,
            padding:      5,
            gap:          4,
            border:       '1px solid #e8eaed',
          }}
        >
          {[
            { label: 'Monthly',                  value: false },
            { label: 'Annual · save up to 20%',  value: true  },
          ].map(opt => {
            const isActive = annual === opt.value;
            return (
              <button
                type="button"
                key={String(opt.value)}
                onClick={() => setAnnual(opt.value)}
                style={{
                  border:     'none',
                  cursor:     'pointer',
                  borderRadius: 999,
                  padding:    '9px 20px',
                  fontSize:   14,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  background: isActive ? '#fff' : 'transparent',
                  color:      isActive ? '#1967d2' : '#5f6368',
                  boxShadow:  isActive ? 'var(--shadow-1)' : 'none',
                  transition: 'all .2s',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Cards grid. Stacks on mobile, side-by-side from md up. */}
      <div className="mt-11 grid gap-6 items-start grid-cols-1 md:grid-cols-3">
        {TIERS.map(tier => {
          const shown = annual ? tier.annualMonthly : tier.monthlyPrice;
          const billedLine = annual
            ? `billed $${tier.annualTotal.toLocaleString('en-US')} / yr`
            : 'billed monthly';
          return (
            <div
              key={tier.key}
              // `md:translate-y-[-8px]` lifts the popular card only at
              // md+ where the cards sit side-by-side. On mobile they
              // stack, so the lift would just look like an awkward
              // gap between the popular card and the one above it.
              className={tier.popular ? 'md:-translate-y-2' : ''}
              style={{
                position:      'relative',
                background:    '#fff',
                borderRadius:  24,
                border:        tier.popular ? '2px solid var(--gc-blue)' : '1px solid #e8eaed',
                boxShadow:     tier.popular ? 'var(--shadow-soft)' : 'none',
                overflow:      'hidden',
                height:        '100%',
                display:       'flex',
                flexDirection: 'column',
              }}
            >
              {tier.popular && (
                <div
                  className="font-display"
                  style={{
                    position:       'absolute',
                    top:            18,
                    right:          18,
                    whiteSpace:     'nowrap',
                    fontSize:       11,
                    fontWeight:     700,
                    letterSpacing:  '0.08em',
                    textTransform:  'uppercase',
                    color:          '#fff',
                    background:     'var(--gc-blue)',
                    padding:        '5px 12px',
                    borderRadius:   999,
                  }}
                >
                  Most popular
                </div>
              )}

              <div style={{ padding: '36px 34px 0' }}>
                <span
                  className="font-mono"
                  style={{
                    fontSize:       12,
                    fontWeight:     600,
                    letterSpacing:  '0.1em',
                    textTransform:  'uppercase',
                    color:          tier.accent,
                  }}
                >
                  {tier.name}
                </span>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 16 }}>
                  <span className="font-display" style={{ fontWeight: 800, fontSize: 56, lineHeight: 1, color: '#202124' }}>
                    ${shown}
                  </span>
                  <span style={{ fontSize: 15, color: '#5f6368' }}>/ mo</span>
                </div>
                <div style={{ fontSize: 13, color: '#5f6368', height: 18, marginTop: 4 }}>
                  {billedLine}
                </div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 15, marginTop: 14, color: '#202124' }}>
                  {tier.trucks}
                </div>
                <p style={{ fontSize: 14.5, lineHeight: 1.55, color: '#5f6368', margin: '8px 0 24px' }}>
                  {tier.blurb}
                </p>
                <Link
                  href={`/sign-up?plan=${tier.key}&period=${annual ? 'annual' : 'monthly'}`}
                  className="font-display"
                  style={{
                    display:        'flex',
                    alignItems:     'center',
                    justifyContent: 'center',
                    width:          '100%',
                    padding:        '14px 22px',
                    borderRadius:   999,
                    fontSize:       15,
                    fontWeight:     600,
                    textDecoration: 'none',
                    background:     tier.popular ? 'var(--gc-blue)' : 'var(--gc-blue-light)',
                    color:          tier.popular ? '#fff' : '#1967d2',
                    boxShadow:      tier.popular ? 'var(--shadow-1)' : 'none',
                    transition:     'background .2s, box-shadow .2s',
                  }}
                >
                  Start free trial
                </Link>
              </div>

              <div style={{ padding: '28px 34px 36px', marginTop: 4 }}>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 13 }}>
                  {SHARED_FEATURES.map(f => (
                    <li
                      key={f}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14.5, color: '#3c4043' }}
                    >
                      <span
                        style={{
                          width:        20,
                          height:       20,
                          borderRadius: 999,
                          background:   '#e6f4ea',
                          display:      'grid',
                          placeItems:   'center',
                          flex:         'none',
                        }}
                      >
                        <Check size={12} strokeWidth={3} style={{ color: '#1e8e3e' }} />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-center" style={{ marginTop: 44 }}>
        <p style={{ fontSize: 15, color: '#5f6368' }}>
          Running a fleet larger than 14 trucks?{' '}
          <Link href="mailto:hello@fleetcal.app" style={{ color: '#1967d2', fontWeight: 600, textDecoration: 'none' }}>
            Contact sales →
          </Link>
        </p>
      </div>
    </div>
  );
}
