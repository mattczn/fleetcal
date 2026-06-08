'use client';

import { useState, useEffect } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { PRESET_COLORS } from '@/lib/asset-colors';
import { useOrgTier, nextTierUp } from '@/lib/useOrgTier';
import UpgradePlanDialog from './UpgradePlanDialog';

const INPUT = 'w-full px-3 py-2 rounded-lg text-sm outline-none transition-all';
const INPUT_STYLE = { border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' };

export default function AddAssetDialog({ onClose }: { onClose: () => void }) {
  const { addAsset, assetCategories } = useCalendarStore();
  const { tier, tierLabel, maxTrucks, currentTrucks, atLimit } = useOrgTier();
  const [name,  setName]  = useState('');
  const [unit,  setUnit]  = useState('');
  const [truck, setTruck] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [type,  setType]  = useState(() => assetCategories[0] ?? '');

  // Tier cap: soft-block adding a truck when the org is at the limit.
  // The pricing page (/pricing) handles upgrades; we just route there.
  // Unrestricted tier (legacy / grandfathered orgs) bypasses the gate.
  const upsellTier = nextTierUp(tier);
  const blocked = atLimit && tier !== 'unrestricted';

  // Server-side 402 (tier_cap_exceeded) surfaces as an inline message
  // in case the client-side useOrgTier check was wrong (e.g. Clerk
  // billing feature didn't propagate yet for a fresh signup). Belt-
  // and-suspenders with the `blocked` gate above.
  const [serverError, setServerError] = useState<string | null>(null);
  // In-app Clerk PricingTable modal. Opens when the user clicks the
  // "Upgrade plan" CTA on the cap banner instead of routing them to
  // /pricing and losing the truck-add form state.
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // serverError is sticky — set once on 402, never cleared as the
  // user's state changes. If they leave this dialog open, retire
  // a truck elsewhere (or buy an upgrade), `blocked` flips false
  // but the error banner stays. Clear it as soon as they're no
  // longer blocked so the form re-enables cleanly.
  useEffect(() => {
    if (!blocked && serverError) setServerError(null);
  }, [blocked, serverError]);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || blocked) return;
    setServerError(null);
    try {
      await addAsset({ name: name.trim(), color, type, unit: unit.trim() || undefined, truck: truck.trim() || undefined, hidden: false, sortOrder: 0 });
      onClose();
    } catch (err) {
      const tierCap = (err as Error & { code?: string }).code === 'tier_cap_exceeded';
      if (tierCap) {
        setServerError((err as Error).message);
      } else {
        // Unknown error — keep the dialog open and log; user can
        // retry. The store already rolled back the optimistic insert.
        console.error('AddAssetDialog handleSubmit failed:', err);
        setServerError('Failed to add truck. Please try again.');
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-full flex flex-col"
        style={{ background: 'var(--gc-surface)', maxWidth: 576, borderRadius: 12, boxShadow: 'var(--shadow-3)', overflow: 'hidden' }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-7 py-5"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}
        >
          <span className="text-base font-medium" style={{ color: 'var(--gc-text-1)' }}>
            Add truck
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-7 py-5 space-y-4">
          {blocked && (
            <div
              className="rounded-xl"
              style={{
                background:  '#fffbeb',
                border:      '1px solid #fde68a',
                padding:     '14px 16px',
                boxShadow:   'var(--shadow-1)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <AlertTriangle size={18} style={{ color: '#d97706', flex: 'none' }} />
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: '#92400e' }}>
                    Plan limit reached
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5" style={{ color: '#7c2d12' }}>
                    <span className="tabular-nums" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                      {currentTrucks}/{maxTrucks}
                    </span>
                    <span className="text-[12px]" style={{ color: '#92400e', fontWeight: 600 }}>
                      {tier === 'none' ? 'active trucks' : `${tierLabel} plan`}
                    </span>
                  </div>
                </div>
              </div>
              {/* Primary CTA — opens UpgradePlanDialog in-app rather
                  than routing away. Three variants per the
                  (none / upsellable / top-tier) state machine. */}
              <button
                type="button"
                onClick={() => {
                  if (tier === 'none') {
                    window.location.href = 'mailto:matt@curzontrucking.com?subject=FleetCal%20subscription%20help';
                  } else if (upsellTier) {
                    setUpgradeOpen(true);
                  } else {
                    window.location.href = 'mailto:matt@curzontrucking.com?subject=FleetCal%20fleet%20expansion';
                  }
                }}
                className="w-full mt-3 text-[13px] font-bold rounded-lg transition-colors"
                style={{
                  background: '#d97706',
                  color:      '#fff',
                  height:     38,
                  border:     'none',
                  cursor:     'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#b45309')}
                onMouseLeave={e => (e.currentTarget.style.background = '#d97706')}>
                {tier === 'none' ? 'Contact support'
                  : upsellTier ? 'Upgrade plan'
                  : 'Contact sales'}
              </button>
              <div className="mt-2 text-[11.5px] text-center" style={{ color: '#92400e' }}>
                or close this dialog and retire an existing truck to free a slot
              </div>
            </div>
          )}
          {serverError && !blocked && (
            <div
              className="rounded-lg px-4 py-3 flex items-start gap-3"
              style={{ background: '#fef3c7', border: '1px solid #f59e0b', color: '#7c2d12' }}>
              <AlertTriangle size={18} style={{ flex: '0 0 18px', marginTop: 1 }} />
              <div className="flex-1 text-[13px] leading-snug">{serverError}</div>
            </div>
          )}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
              Name *
            </label>
            <input autoFocus type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Truck 107 or John D." className={INPUT} style={INPUT_STYLE} required
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
                Unit #
              </label>
              <input type="text" value={unit} onChange={e => setUnit(e.target.value)}
                placeholder="e.g. 2028" className={INPUT} style={INPUT_STYLE}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')} />
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
                Type
              </label>
              <select value={type} onChange={e => setType(e.target.value)}
                className={INPUT} style={INPUT_STYLE}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}>
                {assetCategories.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
              Color
            </label>
            <div className="grid grid-cols-10 gap-2">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="w-7 h-7 rounded-full transition-all"
                  style={{
                    background: c,
                    outline: color === c ? `3px solid ${c}` : '3px solid transparent',
                    outlineOffset: 2,
                    transform: color === c ? 'scale(1.1)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-5 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ color: 'var(--gc-blue)' }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
              onMouseOut={e => (e.currentTarget.style.background = 'transparent')}>
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || blocked}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-colors"
              style={{ background: 'var(--gc-blue)' }}
              onMouseOver={e => { if (name.trim() && !blocked) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
              onMouseOut={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
              Add
            </button>
          </div>
        </form>
      </div>
      {upgradeOpen && <UpgradePlanDialog onClose={() => setUpgradeOpen(false)} />}
    </div>
  );
}
