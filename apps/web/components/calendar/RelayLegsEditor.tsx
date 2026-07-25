'use client';

/**
 * RelayLegsEditor — the N-leg relay editor inside EventModal.
 *
 * Replaces the fixed pickup/delivery relay block: renders one card per
 * leg (driver, truck, per-leg driver pay with % chip + FinalizedPayBanner,
 * computed leg miles + revenue share) with a handoff divider between
 * consecutive legs showing the relay point, drop/pickup times, handoff
 * photos, and a per-handoff "Remove split" (undo) affordance.
 *
 * The component is presentational: EventModal owns all state and passes
 * view models down. The leg card for the leg currently open in the modal
 * (`isViewed`) binds straight to the main form's driver/asset state via
 * onChangeLeg; other legs' edits accumulate in EventModal's legEdits /
 * draftLegs buffers until Save.
 */

import { Fragment, useState } from 'react';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { legLabel } from '@fleetcal/types';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { AssetSelect } from './AssetSelect';
import { HandoffPhotosButton } from '@/components/calendar/RelayHandoffPhotos';
import FinalizedPayBanner from '@/components/payroll/FinalizedPayBanner';
import { useLoadPayFinalized } from '@/lib/useLoadPayFinalized';
import { isActiveOn } from '@/lib/lifecycle';
import type { Asset, Driver, Stop } from '@/lib/types';

const RELAY_COLOR = '#7c3aed';

/** One leg as the editor sees it. `key` is the event id for persisted
 *  legs, a draft uuid for not-yet-saved legs, 'leg0' for the first leg
 *  of a load being created. */
export interface RelayLegView {
  key: string;
  /** Set only for persisted legs — enables the "Open leg" jump link. */
  eventId?: string;
  legIndex: number;
  assetId: number;
  driverName: string;
  pay: number | '';
  /** Leg start (naive ISO or YYYY-MM-DD) — anchors the finalized-pay
   *  week lookup for the pay lock + banner. */
  startIso?: string;
  /** Computed leg miles (routed for persisted legs, haversine estimate
   *  for drafts). null = not enough geocoded stops yet. */
  miles: number | null;
  /** True when this card is the leg open in the modal — its driver /
   *  truck bind to the main form fields. */
  isViewed: boolean;
  /** True for legs that don't exist server-side yet (pending handoff
   *  or create-mode split). */
  isDraft?: boolean;
}

/** Handoff marker i sits between legs[i] and legs[i+1]. */
export interface RelayHandoffView {
  stop: Stop;
  /** Marker not yet persisted (cancelling it is a local-only undo). */
  isDraft?: boolean;
  /** Legs around the marker — used by EventModal's unsplit call. */
  keepEventId?: string;
  mergeEventId?: string;
}

export interface RelayHandoffPhoto {
  id: string;
  uploadedAt: string;
  /** Relay marker ordinal the photo belongs to; null/undefined = legacy
   *  photo, shown on every handoff. */
  handoffIndex?: number | null;
}

interface Props {
  legs: RelayLegView[];
  handoffs: RelayHandoffView[];
  loadPrice: number | null;
  assets: Asset[];
  drivers: Driver[];
  /** Form's start date (YYYY-MM-DD) — drives active-window filtering on
   *  the driver / truck dropdowns, same rule as the main form row. */
  startDate: string;
  canViewDriverPay: boolean;
  disabled?: boolean;
  /** Parent load id — enables handoff photo upload/view. */
  loadId?: string;
  handoffPhotos: RelayHandoffPhoto[];
  onSelectPhoto?: (docId: string) => void;
  onPhotosUploaded?: () => void | Promise<void>;
  canonicalDriverName: (d: Driver) => string;
  onChangeLeg: (key: string, patch: { assetId?: number; driverName?: string; pay?: number | '' }) => void;
  onOpenLeg?: (eventId: string) => void;
  /** Header "+ Add handoff" (create mode: appends after the last leg).
   *  Absent = hidden (batch mode, or edit mode where the per-leg
   *  affordance below takes over). */
  onAddHandoff?: () => void;
  /** Per-leg split: an insert row under EACH persisted leg card starts
   *  a pending handoff targeting THAT leg (the new marker lands inside
   *  its stop window). Absent = hidden (create mode, read-only, or a
   *  pending unsaved handoff already exists — one split per save). */
  onAddHandoffForLeg?: (legKey: string) => void;
  onRemoveHandoff: (handoffIdx: number) => void;
  /** Leg-builder mode: the legs come from the CURRENT stop list's
   *  handoff boundaries (not from persisted events), so ANY leg can be
   *  split again before saving — that's how one leg becomes three in a
   *  single pass. Saving reconciles them all at once via
   *  PUT /v1/loads/:id/legs. False = the incremental split flow. */
  builderMode?: boolean;
}

function fmtRelayTime(iso: string): string {
  const m = iso.match(/T(\d{2}):(\d{2})$/);
  if (!m) return iso;
  const h = parseInt(m[1]), min = m[2];
  return `${h % 12 || 12}:${min} ${h >= 12 ? 'PM' : 'AM'}`;
}

function Field({ label, labelSuffix, children }: { label: string; labelSuffix?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {label}
        </label>
        {labelSuffix}
      </div>
      {children}
    </div>
  );
}

/** Number input prefixed with $. Empty string = unset (omitted on save). */
function PayInput({ value, onChange, disabled, disabledTitle }: {
  value: number | '';
  onChange: (v: number | '') => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--gc-text-3)', fontSize: 13, pointerEvents: 'none' }}>$</span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={value}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={e => {
          const raw = e.target.value;
          if (raw === '') onChange('');
          else {
            const n = parseFloat(raw);
            onChange(Number.isFinite(n) ? n : '');
          }
        }}
        placeholder="0.00"
        className="w-full rounded-lg outline-none text-sm"
        style={{
          border: '1px solid var(--gc-border)',
          padding: '8px 10px 8px 22px',
          color: disabled ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
          background: disabled ? '#f1f5f9' : 'var(--gc-surface)',
          cursor: disabled ? 'not-allowed' : 'text',
        }}
        onFocus={e => { if (!disabled) e.currentTarget.style.borderColor = RELAY_COLOR; }}
        onBlur={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
      />
    </div>
  );
}

const FINALIZED_HINT = 'Locked — driver pay has been finalized for this week. Reopen the payroll record on the Payroll page to edit.';

const pctChip = (p: number | null) => p === null ? null : (
  <span className="px-1.5 py-0.5 rounded-lg normal-case tracking-normal font-semibold"
    style={{ fontSize: 10, background: '#f1f3f4', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
    {p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%
  </span>
);

function LegCard({
  leg, legCount, loadPrice, shareOfMiles, assets, drivers, startDate,
  canViewDriverPay, disabled, canonicalDriverName, onChangeLeg, onOpenLeg,
}: {
  leg: RelayLegView;
  legCount: number;
  loadPrice: number | null;
  /** 0..1 share of the whole haul's miles, or null when unknown. */
  shareOfMiles: number | null;
  assets: Asset[];
  drivers: Driver[];
  startDate: string;
  canViewDriverPay: boolean;
  disabled?: boolean;
  canonicalDriverName: (d: Driver) => string;
  onChangeLeg: Props['onChangeLeg'];
  onOpenLeg?: (eventId: string) => void;
}) {
  const finalized = useLoadPayFinalized(leg.driverName, leg.startIso ?? '');
  const label = legLabel(leg.legIndex, legCount) || `Leg ${leg.legIndex + 1}`;
  const payNum = typeof leg.pay === 'number' ? leg.pay : null;
  const pct = loadPrice != null && loadPrice > 0 && payNum != null && payNum > 0
    ? Math.round((payNum / loadPrice) * 1000) / 10
    : null;

  const inputStyle: React.CSSProperties = {
    width: '100%', border: '1px solid var(--gc-border)', borderRadius: 8,
    padding: '8px 10px', fontSize: 13, color: 'var(--gc-text-1)',
    background: 'var(--gc-surface)', outline: 'none',
  };

  return (
    <div className="rounded-lg p-4 space-y-3"
      style={{
        background: 'var(--gc-surface)',
        border: leg.isViewed ? `1.5px solid ${RELAY_COLOR}` : '1px solid #ddd6fe',
      }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg"
            style={{ background: '#ede9fe', color: RELAY_COLOR, border: '1px solid #ddd6fe', letterSpacing: '0.02em' }}>
            {label}
          </span>
          {leg.isViewed && (
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: RELAY_COLOR }}>
              This leg
            </span>
          )}
          {leg.isDraft && (
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
              Unsaved
            </span>
          )}
          {!leg.isViewed && leg.eventId && onOpenLeg && (
            <button type="button" onClick={() => onOpenLeg(leg.eventId!)}
              className="text-xs font-medium underline-offset-2"
              style={{ color: RELAY_COLOR, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Open leg →
            </button>
          )}
        </div>
        {leg.miles != null && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-lg"
            style={{ background: '#ede9fe', color: '#5b21b6' }}>
            {leg.isDraft ? '≈' : ''}{Math.round(leg.miles).toLocaleString()} mi
            {shareOfMiles != null ? ` · ${Math.round(shareOfMiles * 100)}% of haul` : ''}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Driver">
          <StyledSelect
            value={leg.driverName}
            disabled={disabled}
            onChange={e => onChangeLeg(leg.key, { driverName: e.target.value })}
            style={{ ...inputStyle, cursor: 'pointer' }}
            onFocus={e => (e.currentTarget.style.borderColor = RELAY_COLOR)}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}>
            <option value="">— No driver —</option>
            {drivers
              .filter(d => isActiveOn(d, startDate) || canonicalDriverName(d) === leg.driverName)
              .map(d => {
                const display = canonicalDriverName(d);
                return <option key={d.id} value={display}>{display}</option>;
              })}
          </StyledSelect>
        </Field>
        <Field label="Truck *">
          <AssetSelect
            value={leg.assetId}
            options={assets.filter(a => isActiveOn(a, startDate) || a.id === leg.assetId)}
            onChange={aid => onChangeLeg(leg.key, { assetId: aid })}
            style={inputStyle}
            focusColor={RELAY_COLOR}
          />
        </Field>
      </div>
      {canViewDriverPay && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Driver Pay" labelSuffix={pctChip(pct)}>
            <PayInput
              value={leg.pay}
              onChange={v => onChangeLeg(leg.key, { pay: v })}
              disabled={disabled || finalized.finalized}
              disabledTitle={FINALIZED_HINT}
            />
            <div className="mt-1.5">
              <FinalizedPayBanner
                driverName={leg.driverName}
                pickupIso={leg.startIso ?? ''}
                driverPay={payNum}
              />
            </div>
          </Field>
          <div />
        </div>
      )}
    </div>
  );
}

export default function RelayLegsEditor({
  legs, handoffs, loadPrice, assets, drivers, startDate,
  canViewDriverPay, disabled, loadId, handoffPhotos, onSelectPhoto, onPhotosUploaded,
  canonicalDriverName, onChangeLeg, onOpenLeg, onAddHandoff, onAddHandoffForLeg, onRemoveHandoff,
  builderMode,
}: Props) {
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);

  const legCount = legs.length;
  const totalPay = legs.reduce((s, l) => s + (typeof l.pay === 'number' ? l.pay : 0), 0);
  const allMilesKnown = legs.length > 0 && legs.every(l => l.miles != null && l.miles > 0);
  const totalMiles = allMilesKnown ? legs.reduce((s, l) => s + (l.miles ?? 0), 0) : null;
  const totalPct = loadPrice != null && loadPrice > 0 && totalPay > 0
    ? Math.round((totalPay / loadPrice) * 1000) / 10
    : null;
  const fmt$ = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="rounded-xl p-6 space-y-4" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight size={15} style={{ color: RELAY_COLOR }} />
          <span className="text-sm font-semibold" style={{ color: RELAY_COLOR }}>
            Relay — {legCount} leg{legCount === 1 ? '' : 's'}
          </span>
        </div>
        {onAddHandoff && !disabled && (
          <button type="button" onClick={() => onAddHandoff()}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-semibold transition-colors"
            style={{ color: RELAY_COLOR, border: '1px solid #ddd6fe', background: 'transparent', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#ede9fe')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <Plus size={11} /> Add handoff
          </button>
        )}
      </div>

      {legs.map((leg, i) => {
        const handoff = i > 0 ? handoffs[i - 1] : null;
        const handoffIdx = i - 1;
        const fromName = legs[i - 1]?.driverName?.trim();
        const toName = leg.driverName?.trim();
        const handoffLabel = fromName && toName
          ? `${fromName} drops → ${toName} picks up`
          : `Handoff ${i}`;
        const markerPhotos = handoffPhotos.filter(p => p.handoffIndex == null || p.handoffIndex === handoffIdx);
        const confirming = confirmIdx === handoffIdx;
        return (
          <Fragment key={leg.key}>
            {handoff && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 px-1">
                  <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-lg"
                    style={{ background: '#ede9fe', color: RELAY_COLOR, border: '1px solid #ddd6fe' }}>
                    {handoffLabel}
                  </span>
                  <div className="flex-1 h-px" style={{ background: '#ddd6fe' }} />
                </div>
                <div style={{ background: '#ede9fe', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: '#5b21b6', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <ArrowLeftRight size={13} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 160 }}>
                    {handoff.stop.address
                      ? <>Relay point: <strong>{handoff.stop.address}</strong>{handoff.stop.apptStart ? ` · Drop ${fmtRelayTime(handoff.stop.apptStart)}` : ''}{handoff.stop.apptEnd ? ` → Pickup ${fmtRelayTime(handoff.stop.apptEnd)}` : ''}</>
                      : <>Set the relay point and drop/pickup times in the <strong>Locations</strong> section below.</>}
                  </span>
                  {loadId && !handoff.isDraft && onSelectPhoto && onPhotosUploaded && (
                    <HandoffPhotosButton
                      loadId={loadId}
                      photos={markerPhotos}
                      onSelectInPanel={onSelectPhoto}
                      onUploaded={onPhotosUploaded}
                    />
                  )}
                  {!disabled && (
                    <button type="button"
                      onClick={() => {
                        if (!confirming) { setConfirmIdx(handoffIdx); return; }
                        setConfirmIdx(null);
                        onRemoveHandoff(handoffIdx);
                      }}
                      onMouseLeave={() => { if (confirming) setConfirmIdx(null); }}
                      className="text-xs px-2.5 py-1 rounded-lg font-medium transition-colors shrink-0"
                      style={confirming ? { background: '#d93025', color: 'white', border: 'none', cursor: 'pointer' } : { color: '#d93025', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                      {confirming
                        ? (handoff.isDraft ? 'Confirm cancel?' : 'Confirm remove?')
                        : (handoff.isDraft ? 'Cancel split' : 'Remove split')}
                    </button>
                  )}
                </div>
              </div>
            )}
            <LegCard
              leg={leg}
              legCount={legCount}
              loadPrice={loadPrice}
              shareOfMiles={totalMiles != null && leg.miles != null ? (leg.miles / totalMiles) : null}
              assets={assets}
              drivers={drivers}
              startDate={startDate}
              canViewDriverPay={canViewDriverPay}
              disabled={disabled}
              canonicalDriverName={canonicalDriverName}
              onChangeLeg={onChangeLeg}
              onOpenLeg={onOpenLeg}
            />
            {/* Per-leg split affordance — inserts a handoff INSIDE this
                leg (new marker within its stop window, new leg right
                after it). Rendered for persisted legs only; hidden
                while a split is already pending. */}
            {/* In builder mode every leg can be split again before the
                save — that's how 1 leg becomes 3 in one pass. The
                incremental flow only splits legs that already exist
                server-side. */}
            {onAddHandoffForLeg && !disabled && (builderMode ? true : (leg.eventId && !leg.isDraft)) && (
              <div className="flex items-center gap-2 px-1" style={{ marginTop: -6 }}>
                <div className="flex-1 h-px" style={{ background: '#e9e5f8' }} />
                <button type="button" onClick={() => onAddHandoffForLeg(leg.key)}
                  className="flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-lg font-semibold transition-colors"
                  style={{ color: RELAY_COLOR, border: '1px dashed #ddd6fe', background: 'transparent', cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#ede9fe')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  title="Split this leg with a new handoff">
                  <Plus size={10} /> Add handoff
                </button>
                <div className="flex-1 h-px" style={{ background: '#e9e5f8' }} />
              </div>
            )}
          </Fragment>
        );
      })}

      {canViewDriverPay && (
        <div className="flex items-center justify-between rounded-lg px-3 py-2"
          style={{ background: '#ede9fe', fontSize: 12, color: '#5b21b6' }}>
          <span className="font-semibold">Driver pay total ({legCount} leg{legCount === 1 ? '' : 's'})</span>
          <span>
            <strong>{totalPay > 0 ? fmt$(totalPay) : '—'}</strong>
            {loadPrice != null && loadPrice > 0 && (
              <> of {fmt$(loadPrice)}{totalPct != null ? ` · ${totalPct % 1 === 0 ? totalPct.toFixed(0) : totalPct.toFixed(1)}%` : ''}</>
            )}
          </span>
        </div>
      )}

    </div>
  );
}
