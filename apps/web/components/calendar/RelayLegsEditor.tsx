'use client';

/**
 * RelayLegsEditor — the N-leg relay editor inside EventModal.
 *
 * Replaces the fixed pickup/delivery relay block: renders one card per
 * leg (driver, truck, per-leg driver pay with % chip + FinalizedPayBanner,
 * computed leg miles + revenue share) with a handoff divider between
 * consecutive legs showing the relay point, drop/pickup times, handoff
 * photos, and a per-handoff "Remove leg" (undo) affordance.
 *
 * The component is presentational: EventModal owns all state and passes
 * view models down. The leg card for the leg currently open in the modal
 * (`isViewed`) binds straight to the main form's driver/asset state via
 * onChangeLeg; other legs' edits accumulate in EventModal's legEdits /
 * draftLegs buffers until Save.
 */

import { Fragment, useState } from 'react';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { legLabel, handoffTimesOf } from '@fleetcal/types';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { ApptInput } from './StopsSection';
import { StopAddressFields } from './StopAddressFields';
import { naiveHomeToView, naiveViewToHome } from '@/lib/time-utils';
import { useCalendarStore } from '@/store/useCalendarStore';
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
  /** True for a leg the client hasn't loaded yet (the load's legs are
   *  still being fetched). Renders as a skeleton — NOT as an editable
   *  blank card, which reads as "unassigned" when the truth is "not
   *  known yet" and invites typing into a slot about to be re-seeded. */
  isLoading?: boolean;
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
  /** Edit a handoff's drop / pickup time. The parent writes
   *  handoffDropAt/handoffPickupAt for a handoff on a real stop, or
   *  apptStart/apptEnd for a bare relay point. Absent = read-only. */
  onChangeHandoffTimes?: (handoffIdx: number, patch: { drop?: string; pickup?: string }) => void;
  /** Edit the handoff stop itself (facility, address, geocode result).
   *  Absent = the location renders read-only. */
  onChangeHandoffStop?: (handoffIdx: number, patch: Partial<Stop>) => void;
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

  // Not loaded yet — show a skeleton, not a blank editable card. The
  // dispatcher must not read "we haven't fetched this leg" as "this leg
  // has no driver", nor type into a slot that's about to be re-seeded.
  if (leg.isLoading) {
    const bar = (w: string) => (
      <div style={{
        height: 34, width: w, borderRadius: 8,
        background: 'linear-gradient(90deg, #ede9fe 25%, #f5f3ff 50%, #ede9fe 75%)',
        backgroundSize: '200% 100%', animation: 'relayLegShimmer 1.2s linear infinite',
      }} />
    );
    return (
      <div className="rounded-lg p-4 space-y-3" aria-busy="true"
        style={{ background: 'var(--gc-surface)', border: '1px dashed #ddd6fe', opacity: 0.85 }}>
        <style>{'@keyframes relayLegShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}'}</style>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg"
            style={{ background: '#ede9fe', color: RELAY_COLOR, border: '1px solid #ddd6fe', letterSpacing: '0.02em' }}>
            {label}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            Loading leg…
          </span>
        </div>
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {bar('100%')}{bar('100%')}{canViewDriverPay ? bar('100%') : null}
        </div>
      </div>
    );
  }

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
      {/* Driver | Truck | Driver pay on ONE row. Falls back to two
          columns at narrow modal widths so the pay input never squashes
          (auto-fit with a 150px floor does that without a media query). */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
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
        {canViewDriverPay && (
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
        )}
      </div>
    </div>
  );
}

export default function RelayLegsEditor({
  legs, handoffs, loadPrice, assets, drivers, startDate,
  canViewDriverPay, disabled, loadId, handoffPhotos, onSelectPhoto, onPhotosUploaded,
  canonicalDriverName, onChangeLeg, onOpenLeg, onAddHandoff, onAddHandoffForLeg, onRemoveHandoff,
  builderMode, onChangeHandoffTimes, onChangeHandoffStop,
}: Props) {
  const [confirmIdx, setConfirmIdx] = useState<number | null>(null);
  // Handoff times are stored in HOME_TZ but entered/displayed in the
  // user's view timezone — identical treatment to the stop rows, so a
  // value edited here and read there formats the same.
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const toView = (v: string | undefined): string => v ? naiveHomeToView(v, calendarTimezone) : '';
  const toHome = (v: string): string => v ? naiveViewToHome(v, calendarTimezone) : '';

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
              // ── HANDOFF BOX ──────────────────────────────────────
              // Deliberately unlike a leg card: darker purple surface,
              // solid relay border, its own label. This is the
              // exchange between two legs, not a leg.
              <div className="rounded-xl p-4 space-y-3"
                style={{ background: '#ede9fe', border: `1.5px solid ${RELAY_COLOR}` }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <ArrowLeftRight size={14} style={{ color: RELAY_COLOR, flexShrink: 0 }} />
                    <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: RELAY_COLOR }}>
                      {handoffLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
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
                          : (handoff.isDraft ? 'Cancel leg' : 'Remove leg')}
                      </button>
                    )}
                  </div>
                </div>

                {/* Where the exchange happens. Same shared inputs as the
                    Locations list — Places autocomplete, saved-location
                    and org-history matches, geocoding, status pill —
                    so lat/lng/timezone land on the stop exactly as they
                    would there (leg miles + the driver app need them). */}
                {onChangeHandoffStop && !disabled ? (
                  <div className="space-y-1.5">
                    <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6d28d9' }}>
                      Handoff location
                    </div>
                    <StopAddressFields
                      stop={handoff.stop}
                      onChange={patch => onChangeHandoffStop(handoffIdx, patch)}
                      headerColor={RELAY_COLOR}
                      showFacility
                      facilityPlaceholder="Facility / yard name"
                      addressPlaceholder="Handoff address"
                    />
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: '#5b21b6' }}>
                    {handoff.stop.facilityName || handoff.stop.address || 'No handoff location set'}
                  </div>
                )}

                {/* Handoff times — the ONE place these are set. Writes
                    handoffDropAt/handoffPickupAt on a real stop or
                    apptStart/apptEnd on a bare relay point; the parent
                    mirrors handoffTimesOf's branching. The Locations
                    rows show the same values read-only. */}
                {onChangeHandoffTimes && !disabled && (() => {
                  const t = handoffTimesOf(handoff.stop);
                  const labelStyle: React.CSSProperties = {
                    fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: '#6d28d9', marginBottom: 3,
                  };
                  return (
                    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
                      <div>
                        <div style={labelStyle}>{fromName ? `${fromName} drops` : 'Driver 1 drop'}</div>
                        <ApptInput
                          value={toView(t.drop)}
                          onChange={v => onChangeHandoffTimes(handoffIdx, { drop: toHome(v) })}
                          placeholder="Drop time"
                          headerColor={RELAY_COLOR}
                        />
                      </div>
                      <div>
                        <div style={labelStyle}>{toName ? `${toName} picks up` : 'Driver 2 pickup'}</div>
                        <ApptInput
                          value={toView(t.pickup)}
                          onChange={v => onChangeHandoffTimes(handoffIdx, { pickup: toHome(v) })}
                          placeholder="Pickup time"
                          headerColor={RELAY_COLOR}
                        />
                      </div>
                      {t.drop && t.pickup && t.pickup < t.drop && (
                        <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#b91c1c', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 6, padding: '5px 8px' }}>
                          Pickup is before the drop — check these times.
                        </div>
                      )}
                    </div>
                  );
                })()}
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
