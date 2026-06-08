'use client';

/**
 * UpgradePlanDialog — fully custom in-app billing modal.
 *
 * Two reasons we don't use Clerk's <PricingTable for="organization" />:
 *
 *   1. PricingTable always renders every public plan, including ones
 *      that would be DOWNGRADES for the current org. A Growth-plan
 *      customer staring at a $79 Owner Op card looks like a foot-gun;
 *      we want them to only see upward moves. PricingTable has no
 *      `plans={...}` filter prop, so we render our own cards using
 *      Clerk's billing data hooks.
 *
 *   2. PricingTable's "Switch to this plan" button opens Clerk's
 *      checkout drawer in a separate portal at document.body. That
 *      drawer kept landing UNDER our calendar/dialog z-index stack,
 *      and globally bumping every `.cl-*` selector to 9999 is a
 *      can of worms (it would float subscription details, plan
 *      details, and any future Clerk portal above everything).
 *      Instead we embed Clerk's `CheckoutProvider` + Stripe
 *      `PaymentElement` directly INSIDE this dialog, so the entire
 *      flow (select → pay → success) happens in one surface.
 *
 * Plan-rank gating mirrors useOrgTier so the UX matches the cap:
 *   owner_op_tier → 1, growth_tier → 2, fleet_tier → 3
 *
 * This dialog is mounted from the truck-cap path (AssetsModal +
 * AddAssetDialog), so we only show plans that genuinely INCREASE
 * truck capacity (rank > currentRank). We deliberately do NOT
 * show a "Switch to annual" card for the user's current tier even
 * though it's a valid upsell — annual switching is a billing
 * concern, not a capacity concern, and it muddies the message
 * ("you hit your truck cap → here are plans that fix that").
 * Same-tier annual upsells belong in a future generic /billing
 * surface.
 *
 * Flow:
 *   - Step 'select': monthly/annual toggle + filtered upgrade cards.
 *   - Step 'checkout': inline CheckoutProvider drives a Stripe form
 *     for the chosen (planId, planPeriod). Header gets a back arrow.
 *     If the org has a saved default card, we show "Pay with
 *     •••• 4242" as the primary action and hide the Stripe form
 *     behind a "Use a different card" toggle — one click upgrade.
 *     Cost breakdown shows subtotal + proration credit + tax so
 *     mid-cycle upgraders can see exactly how their existing
 *     subscription gets reconciled.
 *   - Step 'done': brief confirmation, then onClose().
 *
 * Both surfaces (AssetsModal + AddAssetDialog) mount this the same
 * way and the active org's tier picks up the new cap on next render
 * (useOrgTier listens to Clerk's session feature flags).
 */

import { useState, useMemo, useEffect } from 'react';
import { X, ArrowLeft, Check, Loader2 } from 'lucide-react';
import {
  // Hooks: list plans available to the active org.
  usePlans,
  // Checkout primitives — these are the embedded equivalents of
  // CheckoutButton's drawer.
  CheckoutProvider,
  useCheckout,
  PaymentElementProvider,
  PaymentElement,
  usePaymentElement,
} from '@clerk/nextjs/experimental';
import { useOrgTier } from '@/lib/useOrgTier';

type Period = 'month' | 'annual';

/** Tier feature → upgrade-ranking. Higher = more permissive plan. */
const TIER_RANK: Record<string, number> = {
  owner_op_tier: 1,
  growth_tier:   2,
  fleet_tier:    3,
};

/** Truck-count copy per tier. Pulled from useOrgTier's mapping;
 *  duplicated here as display-only labels so we don't need to call
 *  the hook just to render a "9 trucks" line. */
const TIER_TRUCK_COUNT: Record<string, number> = {
  owner_op_tier: 4,
  growth_tier:   9,
  fleet_tier:    14,
};

/** Resolve a plan to its tier rank by inspecting its features.
 *  Plans without a tier feature (e.g. a free trial plan or a
 *  hand-rolled internal plan) return 0 — they're excluded from
 *  the upsell list. */
function getPlanTierRank(plan: any): number {
  for (const f of plan?.features ?? []) {
    if (TIER_RANK[f.slug] != null) return TIER_RANK[f.slug];
  }
  return 0;
}

function getPlanTruckCount(plan: any): number | null {
  for (const f of plan?.features ?? []) {
    if (TIER_TRUCK_COUNT[f.slug] != null) return TIER_TRUCK_COUNT[f.slug];
  }
  return null;
}

export default function UpgradePlanDialog({ onClose }: { onClose: () => void }) {
  // Step machine for the dialog body. 'select' is the plan grid,
  // 'checkout' is the embedded Stripe form, 'done' is the success
  // confirmation we hold for ~1.5s before auto-closing.
  const [step, setStep] = useState<'select' | 'checkout' | 'done'>('select');
  const [chosen, setChosen] = useState<{ planId: string; planPeriod: Period; planName: string } | null>(null);

  // Default to annual — that's the price most carriers prefer + it's
  // what we want to nudge anyway. Affects the toggle inside the
  // plan-select step.
  const [period, setPeriod] = useState<Period>('annual');

  const orgTier = useOrgTier();
  const plans = usePlans({ for: 'organization' });

  // Determine current tier rank from useOrgTier (single source of
  // truth) rather than re-reading Clerk features ourselves.
  const currentRank = useMemo(() => {
    if (orgTier.tier === 'owner_op') return 1;
    if (orgTier.tier === 'growth')   return 2;
    if (orgTier.tier === 'fleet')    return 3;
    return 0;
  }, [orgTier.tier]);

  // Filter plans to upgrades only. The user opened this dialog
  // because they hit a truck cap, so the only thing that's
  // contextually relevant is plans that raise the cap. Same-tier
  // "switch to annual" upsells are deliberately omitted — see
  // file-level docblock.
  const visiblePlans = useMemo(() => {
    const all = plans.data ?? [];
    return all
      .filter((p: any) => {
        if (!p.publiclyVisible) return false;
        const rank = getPlanTierRank(p);
        return rank > currentRank;
      })
      .sort((a: any, b: any) => getPlanTierRank(a) - getPlanTierRank(b));
  }, [plans.data, currentRank]);

  const isLoading = plans.isLoading || orgTier.isLoading;

  function pickPlan(plan: any) {
    setChosen({ planId: plan.id, planPeriod: period, planName: plan.name });
    setStep('checkout');
  }

  // Auto-close after the success state has been visible briefly.
  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => onClose(), 1600);
    return () => clearTimeout(t);
  }, [step, onClose]);

  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-[860px] flex flex-col"
        style={{
          background:    'var(--gc-surface)',
          borderRadius:  20,
          boxShadow:     'var(--shadow-3)',
          marginTop:     32,
          marginBottom:  32,
          overflow:      'hidden',
        }}
      >
        {/* Header — back arrow appears once we're in checkout step. */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}
        >
          <div className="flex items-center gap-2">
            {step === 'checkout' && (
              <button
                onClick={() => { setStep('select'); setChosen(null); }}
                className="p-1.5 rounded-full -ml-1.5"
                style={{ color: 'var(--gc-text-2)' }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                aria-label="Back to plan selection"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <div>
              <div className="text-[16px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                {step === 'select'   && 'Upgrade your plan'}
                {step === 'checkout' && `Confirm — ${chosen?.planName ?? 'Subscription'}`}
                {step === 'done'     && 'Plan updated'}
              </div>
              <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                {step === 'select'   && 'Pick a tier with more active-truck capacity.'}
                {step === 'checkout' && 'Enter payment details to activate the new plan.'}
                {step === 'done'     && 'Your subscription is active.'}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
            aria-label="Close upgrade dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {step === 'select' && (
            <PlanSelectStep
              isLoading={isLoading}
              plans={visiblePlans}
              period={period}
              setPeriod={setPeriod}
              onPick={pickPlan}
            />
          )}
          {step === 'checkout' && chosen && (
            <CheckoutProvider for="organization" planId={chosen.planId} planPeriod={chosen.planPeriod}>
              <EmbeddedCheckoutStep onSuccess={() => setStep('done')} />
            </CheckoutProvider>
          )}
          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center"
                style={{ background: 'var(--gc-green-soft, #d1fae5)', color: 'var(--gc-green, #059669)' }}
              >
                <Check size={24} />
              </div>
              <div className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                You're upgraded to {chosen?.planName}.
              </div>
              <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                Closing this dialog…
              </div>
            </div>
          )}
        </div>

        {/* Footer — sales escape hatch, plus a note that pricing data
            is live from Clerk so no client-side hardcoding drifts. */}
        {step === 'select' && (
          <div
            className="px-6 py-3 text-[12px]"
            style={{
              color:       'var(--gc-text-3)',
              background:  'var(--gc-bg)',
              borderTop:   '1px solid var(--gc-border-light)',
            }}
          >
            Need more than 14 trucks or a custom arrangement?{' '}
            <a
              href="mailto:matt@curzontrucking.com?subject=FleetCal%20custom%20plan"
              className="font-semibold underline"
              style={{ color: 'var(--gc-blue)' }}
            >
              Contact sales
            </a>.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Plan-select step ───────────────────────────────────────────── */

function PlanSelectStep({
  isLoading, plans, period, setPeriod, onPick,
}: {
  isLoading: boolean;
  plans: any[];
  period: Period;
  setPeriod: (p: Period) => void;
  onPick: (plan: any) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={16} className="animate-spin" />
        Loading plans…
      </div>
    );
  }

  if (!plans.length) {
    // Edge case: user is on top tier (Fleet) and has nothing to
    // upgrade to from within the app — point them at sales.
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
        <div className="text-[14px] font-medium" style={{ color: 'var(--gc-text-1)' }}>
          You're already on our highest tier.
        </div>
        <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
          For custom capacity, please contact sales.
        </div>
      </div>
    );
  }

  // Pick a grid that NATURALLY centers a single card and tiles
  // multiple cards. We previously used `grid-cols-2` even for a
  // single plan, which dumped the lone card into the left column —
  // looked broken at narrow widths. The conditional layout fixes
  // that without needing flex-wrap hacks.
  const gridClass =
    plans.length === 1 ? 'grid grid-cols-1 max-w-[420px] mx-auto'
    : plans.length === 2 ? 'grid grid-cols-1 sm:grid-cols-2'
    : 'grid grid-cols-1 sm:grid-cols-3';

  // Highlight the top tier when multiple are visible — it's the
  // "Most capacity" pick. With a single card the highlight is
  // distracting (there's nothing to compare against), so we skip
  // the badge in that case.
  const topRank = Math.max(...plans.map(getPlanTierRank));

  return (
    <>
      {/* Section heading + period toggle.
          The toggle gets more weight than before — bigger touch
          targets, "Save ~17%" hint on the Annual side so the
          incentive is legible. */}
      <div className="flex flex-col items-center mb-7">
        <div
          className="inline-flex rounded-full p-1"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
        >
          {(['month', 'annual'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-5 py-2 text-[13px] font-semibold rounded-full transition-colors flex items-center gap-1.5"
              style={{
                background: period === p ? 'var(--gc-surface)' : 'transparent',
                color:      period === p ? 'var(--gc-text-1)'  : 'var(--gc-text-3)',
                boxShadow:  period === p ? 'var(--shadow-1)'   : 'none',
              }}
            >
              {p === 'month' ? 'Monthly' : 'Annual'}
              {p === 'annual' && (
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{
                    background: period === 'annual' ? 'var(--gc-blue-soft, #dbeafe)' : 'transparent',
                    color:      period === 'annual' ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                  }}
                >
                  SAVE 17%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className={`${gridClass} gap-5`}>
        {plans.map((plan: any) => {
          const trucks = getPlanTruckCount(plan);
          // Pick the right BillingMoneyAmount based on the toggle.
          // annualMonthlyFee shows the effective monthly cost when
          // billed annually — way more readable than the raw 12-mo
          // total ("$129/mo billed annually" beats "$1,548/yr").
          const amt = period === 'annual'
            ? (plan.annualMonthlyFee ?? plan.fee)
            : plan.fee;
          const isTop = plans.length > 1 && getPlanTierRank(plan) === topRank;

          return (
            <div
              key={plan.id}
              className="relative flex flex-col rounded-2xl overflow-hidden transition-all"
              style={{
                background: 'var(--gc-surface)',
                border:     isTop ? '1.5px solid var(--gc-blue)' : '1px solid var(--gc-border-light)',
                boxShadow:  isTop ? '0 8px 24px rgba(37, 99, 235, 0.12)' : 'var(--shadow-1)',
              }}
            >
              {/* Top-tier ribbon — only when comparing multiple. */}
              {isTop && (
                <div
                  className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full"
                  style={{ background: 'var(--gc-blue)', color: '#fff' }}
                >
                  Most capacity
                </div>
              )}

              <div className="p-7 flex flex-col gap-5 flex-1">
                {/* Plan name */}
                <div>
                  <div className="text-[20px] font-bold tracking-tight" style={{ color: 'var(--gc-text-1)' }}>
                    {plan.name}
                  </div>
                  <div className="text-[12px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    For growing fleets
                  </div>
                </div>

                {/* Hero capacity number — this is the actual
                    differentiator between tiers, so it gets the
                    biggest typographic moment on the card. */}
                {trucks != null && (
                  <div className="flex items-baseline gap-2">
                    <div className="text-[44px] font-bold leading-none tracking-tight" style={{ color: 'var(--gc-text-1)' }}>
                      {trucks}
                    </div>
                    <div className="text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                      active trucks
                    </div>
                  </div>
                )}

                {/* Feature list */}
                <ul className="flex flex-col gap-2.5 text-[13px]" style={{ color: 'var(--gc-text-2)' }}>
                  <li className="flex items-start gap-2.5">
                    <Check size={16} style={{ color: 'var(--gc-blue)', flexShrink: 0, marginTop: 2 }} />
                    <span>Unlimited drivers, loads &amp; stops</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check size={16} style={{ color: 'var(--gc-blue)', flexShrink: 0, marginTop: 2 }} />
                    <span>AI rate-con parsing + driver mobile app</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check size={16} style={{ color: 'var(--gc-blue)', flexShrink: 0, marginTop: 2 }} />
                    <span>Motive ELD sync, accounting &amp; invoicing</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check size={16} style={{ color: 'var(--gc-blue)', flexShrink: 0, marginTop: 2 }} />
                    <span>Asset timeline + AI cost analysis</span>
                  </li>
                </ul>

                {/* Price block sits near the CTA so the dollar
                    amount reads as the "cost of this button". */}
                <div className="mt-auto flex flex-col gap-3 pt-2">
                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-[16px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                        {amt?.currencySymbol}
                      </span>
                      <span className="text-[32px] font-bold leading-none" style={{ color: 'var(--gc-text-1)' }}>
                        {amt?.amountFormatted ?? '—'}
                      </span>
                      <span className="text-[13px] ml-1" style={{ color: 'var(--gc-text-3)' }}>
                        /month
                      </span>
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                      {period === 'annual' ? 'Billed annually' : 'Billed monthly'}
                    </div>
                  </div>

                  <button
                    onClick={() => onPick(plan)}
                    className="w-full py-3 rounded-xl text-[14px] font-semibold transition-all"
                    style={{
                      background: 'var(--gc-blue)',
                      color:      '#fff',
                      boxShadow:  '0 4px 12px rgba(37, 99, 235, 0.25)',
                    }}
                    onMouseOver={e => {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = '0 8px 20px rgba(37, 99, 235, 0.35)';
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.25)';
                    }}
                  >
                    Upgrade to {plan.name}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── Embedded checkout step ─────────────────────────────────────── */

function EmbeddedCheckoutStep({ onSuccess }: { onSuccess: () => void }) {
  // useCheckout reads the active CheckoutProvider context. The
  // checkout starts in 'needs_initialization' status — we kick it
  // off in an effect so the Stripe session is created before we
  // ask Clerk to render the PaymentElement.
  const { checkout, fetchStatus, errors } = useCheckout();
  const [startErr, setStartErr] = useState<string | null>(null);

  useEffect(() => {
    if (checkout.status === 'needs_initialization') {
      checkout.start().then(({ error }) => {
        if (error) setStartErr(error.message ?? 'Failed to start checkout.');
      });
    }
  }, [checkout]);

  if (startErr) {
    return (
      <div className="rounded-lg p-4 text-[13px]"
        style={{ background: 'var(--gc-red-soft, #fee2e2)', color: 'var(--gc-red, #b91c1c)' }}>
        {startErr}
      </div>
    );
  }

  if (checkout.status === 'needs_initialization' || fetchStatus === 'fetching') {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={16} className="animate-spin" />
        Preparing checkout…
      </div>
    );
  }

  if (errors.global && errors.global.length > 0) {
    return (
      <div className="rounded-lg p-4 text-[13px]"
        style={{ background: 'var(--gc-red-soft, #fee2e2)', color: 'var(--gc-red, #b91c1c)' }}>
        {errors.global[0]?.message ?? 'Checkout error'}
      </div>
    );
  }

  // From here on the checkout is initialized and the totals are
  // populated — render the summary + Stripe form + pay button.
  return (
    <PaymentElementProvider for="organization" checkout={checkout}>
      <CheckoutForm onSuccess={onSuccess} />
    </PaymentElementProvider>
  );
}

function CheckoutForm({ onSuccess }: { onSuccess: () => void }) {
  const { checkout } = useCheckout();
  const payment = usePaymentElement();
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Defensive — the form is only rendered after status flips to
  // 'needs_confirmation' but TypeScript doesn't narrow that here.
  const totals      = checkout.status !== 'needs_initialization' ? checkout.totals      : null;
  const planObj     = checkout.status !== 'needs_initialization' ? checkout.plan        : null;
  const planPeriod  = checkout.status !== 'needs_initialization' ? checkout.planPeriod  : null;
  // Clerk pre-populates `checkout.paymentMethod` with the org's
  // default card if one is on file. When that's present, the
  // user should be able to one-click confirm — no Stripe form
  // needed. We only mount PaymentElement when the user explicitly
  // chooses to enter a new card.
  const savedCard   = checkout.status !== 'needs_initialization' ? checkout.paymentMethod : null;

  // If there's a saved card, default to using it. The toggle
  // exposes "use a different card" → swap to the Stripe form.
  const [useNewCard, setUseNewCard] = useState<boolean>(!savedCard);
  useEffect(() => {
    // Re-sync the default when the checkout resolves (savedCard
    // is null on first render, then populated after start()).
    setUseNewCard(!savedCard);
  }, [savedCard]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrMsg(null);
    setSubmitting(true);
    try {
      let confirmRes;
      if (!useNewCard && savedCard) {
        // Fast path: re-use the saved card. No Stripe form
        // submission needed; Clerk charges the existing
        // payment method directly.
        confirmRes = await checkout.confirm({ paymentMethodId: savedCard.id });
      } else {
        // New card path: tokenize via Stripe, then confirm.
        if (!payment.isFormReady) {
          setSubmitting(false);
          return;
        }
        const { data, error } = await payment.submit();
        if (error || !data) {
          setErrMsg(error?.error.message ?? 'Could not submit payment.');
          setSubmitting(false);
          return;
        }
        confirmRes = await checkout.confirm({
          paymentToken: data.paymentToken,
          gateway: 'stripe',
        });
      }
      if (confirmRes.error) {
        setErrMsg(confirmRes.error.message ?? 'Payment confirmation failed.');
        setSubmitting(false);
        return;
      }
      // Finalize — this is what flips the org's subscription
      // to active in Clerk's session so useSubscription /
      // useOrgTier observe the change.
      const finalRes = await checkout.finalize();
      if (finalRes.error) {
        setErrMsg(finalRes.error.message ?? 'Could not finalize subscription.');
        setSubmitting(false);
        return;
      }
      onSuccess();
    } catch (err: any) {
      setErrMsg(err?.message ?? 'Unexpected error during checkout.');
      setSubmitting(false);
    }
  }

  // Pull the proration credit out separately so we can show it
  // as its own line item. Clerk has already netted it into
  // totalDueNow — we just want to be explicit about WHY the
  // upgrade is cheaper than the plan's sticker price.
  const prorationCredit = totals?.credits?.proration?.amount ?? null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Cost breakdown. Surfacing the math is important for
          mid-cycle upgraders so they don't see "$169 plan, $84
          due today" and assume we lost their money. */}
      {planObj && totals && (
        <div
          className="rounded-xl p-4 flex flex-col gap-2"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
        >
          <div className="flex items-baseline justify-between">
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              {planObj.name}
              <span className="font-normal" style={{ color: 'var(--gc-text-3)' }}>
                {' '}· {planPeriod === 'annual' ? 'Billed annually' : 'Billed monthly'}
              </span>
            </div>
            <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>
              {totals.subtotal.currencySymbol}{totals.subtotal.amountFormatted}
            </div>
          </div>

          {prorationCredit && prorationCredit.amount > 0 && (
            <div className="flex items-baseline justify-between">
              <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                Unused time on current plan
              </div>
              <div className="text-[12px]" style={{ color: 'var(--gc-green, #059669)' }}>
                −{prorationCredit.currencySymbol}{prorationCredit.amountFormatted}
              </div>
            </div>
          )}

          {totals.taxTotal.amount > 0 && (
            <div className="flex items-baseline justify-between">
              <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Tax</div>
              <div className="text-[12px]" style={{ color: 'var(--gc-text-1)' }}>
                {totals.taxTotal.currencySymbol}{totals.taxTotal.amountFormatted}
              </div>
            </div>
          )}

          <div
            className="flex items-baseline justify-between pt-2"
            style={{ borderTop: '1px solid var(--gc-border-light)' }}
          >
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Due today
            </div>
            <div className="text-[18px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
              {totals.totalDueNow.currencySymbol}{totals.totalDueNow.amountFormatted}
            </div>
          </div>
          {prorationCredit && prorationCredit.amount > 0 && (
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              We credited the unused portion of your current plan toward this upgrade.
              The new plan starts today.
            </div>
          )}
        </div>
      )}

      {/* Payment method */}
      {savedCard && !useNewCard ? (
        <div
          className="rounded-xl p-3 flex items-center justify-between"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide"
              style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)' }}
            >
              {savedCard.cardType ?? 'Card'}
            </div>
            <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>
              •••• {savedCard.last4 ?? '••••'}
              {savedCard.expiryMonth && savedCard.expiryYear && (
                <span className="ml-2" style={{ color: 'var(--gc-text-3)' }}>
                  exp {String(savedCard.expiryMonth).padStart(2, '0')}/{String(savedCard.expiryYear).slice(-2)}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setUseNewCard(true)}
            className="text-[12px] font-semibold underline"
            style={{ color: 'var(--gc-blue)' }}
          >
            Use different card
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
              Payment details
            </div>
            {savedCard && (
              <button
                type="button"
                onClick={() => setUseNewCard(false)}
                className="text-[12px] font-semibold underline"
                style={{ color: 'var(--gc-blue)' }}
              >
                Use saved card
              </button>
            )}
          </div>
          <div
            className="rounded-xl p-3"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}
          >
            <PaymentElement
              fallback={
                <div className="flex items-center justify-center py-6 gap-2 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={14} className="animate-spin" />
                  Loading secure payment form…
                </div>
              }
            />
          </div>
        </div>
      )}

      {errMsg && (
        <div className="rounded-lg p-3 text-[13px]"
          style={{ background: 'var(--gc-red-soft, #fee2e2)', color: 'var(--gc-red, #b91c1c)' }}>
          {errMsg}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || (useNewCard && !payment.isFormReady)}
        className="w-full py-2.5 rounded-lg text-[14px] font-semibold transition-opacity"
        style={{
          background: 'var(--gc-blue)',
          color:      '#fff',
          opacity:    (submitting || (useNewCard && !payment.isFormReady)) ? 0.6 : 1,
          cursor:     (submitting || (useNewCard && !payment.isFormReady)) ? 'not-allowed' : 'pointer',
        }}
      >
        {submitting
          ? 'Processing…'
          : totals
            ? `Pay ${totals.totalDueNow.currencySymbol}${totals.totalDueNow.amountFormatted}`
            : 'Confirm'}
      </button>
    </form>
  );
}
