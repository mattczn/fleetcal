'use client';

/**
 * UpgradePlanDialog — in-app billing modal.
 *
 * Wraps Clerk's <PricingTable forOrganizations /> in a centered
 * dialog so dispatchers can upgrade WITHOUT leaving the calendar.
 * Clerk handles the checkout flow end-to-end (Stripe redirect →
 * webhook → org's plan updates → useOrgTier picks up the new
 * cap on the next render). The dialog auto-closes when the user
 * dismisses; the existing cap banner will re-render against the
 * new tier automatically (no manual refresh needed).
 *
 * Used by AssetsModal's truck directory + AddAssetDialog when
 * the user hits the cap. Both surfaces call:
 *
 *   <UpgradePlanDialog open={open} onClose={() => setOpen(false)} />
 *
 * Why a wrapper instead of just routing to /pricing:
 *   - The user is mid-task (adding a truck). Routing away costs
 *     them the form state and the mental thread.
 *   - One click → see plans → checkout → back to the truck dialog.
 *     Total time-to-paid is ~30 seconds.
 *   - Clerk's PricingTable already knows the org's current plan and
 *     marks it, so the user sees exactly what they'd be upgrading
 *     from.
 */

import { PricingTable } from '@clerk/nextjs';
import { X } from 'lucide-react';

export default function UpgradePlanDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full max-w-[920px] flex flex-col"
        style={{
          background:    'var(--gc-surface)',
          borderRadius:  16,
          boxShadow:     'var(--shadow-3)',
          marginTop:     32,
          marginBottom:  32,
          overflow:      'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}
        >
          <div>
            <div className="text-[16px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              Upgrade your plan
            </div>
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Pick a tier with more active-truck capacity. Checkout takes about a minute.
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

        {/* Clerk PricingTable — handles the entire org billing UI.
            `for="organization"` scopes the available plans + checkout
            session to the currently-active org. Inline-styled to
            match the dialog's surface. */}
        <div className="p-4 sm:p-6">
          <PricingTable for="organization" />
        </div>

        {/* Footer hint — alternative path for orgs whose needs exceed
            the standard tiers. Cheap to render and saves an inbound
            "do you have something above 14 trucks?" support ticket. */}
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
      </div>
    </div>
  );
}
