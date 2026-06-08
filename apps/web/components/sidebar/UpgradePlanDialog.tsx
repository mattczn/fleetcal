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
 * Show a plan when (rank > currentRank) OR (rank === currentRank
 * AND user is on monthly AND has toggled to annual) — the second
 * branch is the "switch to annual" path.
 *
 * Flow:
 *   - Step 'select': monthly/annual toggle + filtered plan cards.
 *   - Step 'checkout': inline CheckoutProvider drives a Stripe form
 *     for the chosen (planId, planPeriod). Header gets a back arrow.
 *   - Step 'done': brief confirmation, then onClose().
 *
 * Both surfaces (AssetsModal + AddAssetDialog) mount this the same
 * way and the active org's tier picks up the new cap on next render
 * (useOrgTier listens to Clerk's session feature flags).
 */

import { useState, useMemo, useEffect } from 'react';
import { X, ArrowLeft, Check, Loader2 } from 'lucide-react';
import {
  // Hooks: list plans + read current org subscription.
  usePlans,
  useSubscription,
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
  const subscription = useSubscription({ for: 'organization' });

  // Determine current tier rank from useOrgTier (single source of
  // truth) rather than re-reading Clerk features ourselves.
  const currentRank = useMemo(() => {
    if (orgTier.tier === 'owner_op') return 1;
    if (orgTier.tier === 'growth')   return 2;
    if (orgTier.tier === 'fleet')    return 3;
    return 0;
  }, [orgTier.tier]);

  // Find the user's current subscription item so we can detect
  // "currently monthly". Filter out the implicit free/default plan
  // that Clerk attaches to every org (status==='active' but no
  // billed period).
  const currentPlanPeriod: Period | null = useMemo(() => {
    const items = subscription.data?.subscriptionItems ?? [];
    for (const it of items) {
      const rank = getPlanTierRank(it.plan);
      if (rank > 0 && it.planPeriod) return it.planPeriod as Period;
    }
    return null;
  }, [subscription.data]);

  // Filter plans to upgrades + (optionally) annual switch of current
  // tier. Sort ascending so the cheapest upgrade comes first.
  const visiblePlans = useMemo(() => {
    const all = plans.data ?? [];
    return all
      .filter((p: any) => {
        if (!p.publiclyVisible) return false;
        const rank = getPlanTierRank(p);
        if (rank === 0) return false;
        if (rank > currentRank) return true;
        // Same-tier upsell to annual: show only when user is on
        // monthly AND they've toggled to annual.
        if (rank === currentRank && period === 'annual' && currentPlanPeriod === 'month') return true;
        return false;
      })
      .sort((a: any, b: any) => getPlanTierRank(a) - getPlanTierRank(b));
  }, [plans.data, currentRank, period, currentPlanPeriod]);

  const isLoading = plans.isLoading || subscription.isLoading || orgTier.isLoading;

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
        className="w-full max-w-[720px] flex flex-col"
        style={{
          background:    'var(--gc-surface)',
          borderRadius:  16,
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
              currentRank={currentRank}
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
  isLoading, plans, period, setPeriod, currentRank, onPick,
}: {
  isLoading: boolean;
  plans: any[];
  period: Period;
  setPeriod: (p: Period) => void;
  currentRank: number;
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

  return (
    <>
      {/* Monthly / Annual toggle. Annual is the default + recommended
          path (cheaper effective rate + matches what carriers prefer
          for tax reasons). */}
      <div className="flex justify-center mb-5">
        <div
          className="inline-flex rounded-full p-1"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
        >
          {(['month', 'annual'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-4 py-1.5 text-[12px] font-semibold rounded-full transition-colors"
              style={{
                background: period === p ? 'var(--gc-surface)' : 'transparent',
                color:      period === p ? 'var(--gc-text-1)'  : 'var(--gc-text-3)',
                boxShadow:  period === p ? 'var(--shadow-1)'   : 'none',
              }}
            >
              {p === 'month' ? 'Monthly' : 'Annual'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {plans.map((plan: any) => {
          const planRank   = getPlanTierRank(plan);
          const trucks     = getPlanTruckCount(plan);
          const isAnnualSwitch = planRank === currentRank;
          // Pick the right BillingMoneyAmount based on the toggle.
          // annualMonthlyFee shows the effective monthly cost when
          // billed annually — way more readable than the raw 12-mo
          // total ("$129/mo billed annually" beats "$1,548/yr").
          const amt = period === 'annual'
            ? (plan.annualMonthlyFee ?? plan.fee)
            : plan.fee;

          return (
            <button
              key={plan.id}
              onClick={() => onPick(plan)}
              className="flex flex-col items-start text-left rounded-xl p-4 transition-colors"
              style={{
                background: 'var(--gc-surface)',
                border:     '1px solid var(--gc-border-light)',
                boxShadow:  'var(--shadow-1)',
              }}
              onMouseOver={e => {
                e.currentTarget.style.borderColor = 'var(--gc-blue)';
                e.currentTarget.style.boxShadow   = 'var(--shadow-2)';
              }}
              onMouseOut={e => {
                e.currentTarget.style.borderColor = 'var(--gc-border-light)';
                e.currentTarget.style.boxShadow   = 'var(--shadow-1)';
              }}
            >
              <div className="flex items-center justify-between w-full mb-1">
                <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {plan.name}
                </div>
                {isAnnualSwitch && (
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--gc-blue-soft, #dbeafe)', color: 'var(--gc-blue)' }}
                  >
                    Switch to annual
                  </span>
                )}
              </div>

              {trucks != null && (
                <div className="text-[12px] mb-2" style={{ color: 'var(--gc-text-3)' }}>
                  Up to {trucks} active trucks
                </div>
              )}

              <div className="flex items-baseline gap-1 mb-3">
                <div className="text-[22px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  {amt ? `${amt.currencySymbol}${amt.amountFormatted}` : '—'}
                </div>
                <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                  {amt ? '/month' : ''}
                </div>
              </div>

              {period === 'annual' && (
                <div className="text-[11px] mb-3" style={{ color: 'var(--gc-text-3)' }}>
                  Billed annually
                </div>
              )}

              <div
                className="w-full text-center text-[13px] font-semibold py-2 rounded-lg"
                style={{ background: 'var(--gc-blue)', color: '#fff' }}
              >
                {isAnnualSwitch ? 'Switch to annual' : 'Switch to this plan'}
              </div>
            </button>
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
  const totals  = checkout.status !== 'needs_initialization' ? checkout.totals  : null;
  const planObj = checkout.status !== 'needs_initialization' ? checkout.plan    : null;
  const planPeriod = checkout.status !== 'needs_initialization' ? checkout.planPeriod : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrMsg(null);
    if (!payment.isFormReady) return;
    setSubmitting(true);
    try {
      // 1. Tokenize the card via Stripe.
      const { data, error } = await payment.submit();
      if (error || !data) {
        setErrMsg(error?.error.message ?? 'Could not submit payment.');
        setSubmitting(false);
        return;
      }
      // 2. Confirm the checkout with the new token.
      const confirmRes = await checkout.confirm({
        paymentToken: data.paymentToken,
        gateway: 'stripe',
      });
      if (confirmRes.error) {
        setErrMsg(confirmRes.error.message ?? 'Payment confirmation failed.');
        setSubmitting(false);
        return;
      }
      // 3. Finalize — this is what flips the org's subscription
      //    to active in Clerk's session so useSubscription /
      //    useOrgTier observe the change.
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Summary */}
      {planObj && totals && (
        <div
          className="rounded-xl p-4 flex items-start justify-between"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}
        >
          <div>
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              {planObj.name}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              {planPeriod === 'annual' ? 'Billed annually' : 'Billed monthly'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[18px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
              {totals.totalDueNow.currencySymbol}{totals.totalDueNow.amountFormatted}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              due today
            </div>
          </div>
        </div>
      )}

      {/* Stripe Payment Element. Renders inline; no portal. */}
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

      {errMsg && (
        <div className="rounded-lg p-3 text-[13px]"
          style={{ background: 'var(--gc-red-soft, #fee2e2)', color: 'var(--gc-red, #b91c1c)' }}>
          {errMsg}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !payment.isFormReady}
        className="w-full py-2.5 rounded-lg text-[14px] font-semibold transition-opacity"
        style={{
          background: 'var(--gc-blue)',
          color:      '#fff',
          opacity:    (submitting || !payment.isFormReady) ? 0.6 : 1,
          cursor:     (submitting || !payment.isFormReady) ? 'not-allowed' : 'pointer',
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
