'use client';

/**
 * Weekly target — where the dashboard's selected period sits against
 * break-even and a target margin as loads get booked, plus the OTR rate
 * per loaded mile needed at the current diesel price, and a one-load
 * checker for saying no to freight that doesn't pay.
 *
 * All numbers come from GET /v1/weekly-target (lib/weeklyTarget.ts),
 * fetched by DashboardView for its period and shared with the Target RPM
 * and Cost / Loaded Mile tiles. Every model input is computed from the
 * org's own data and can be overridden here (saved to
 * org_settings.weekly_target_settings).
 */

import { useCallback, useState } from 'react';
import { RotateCcw, Settings2, Target, X } from 'lucide-react';
import type { BucketBasis, CostBehavior, WeeklyTargetParam, WeeklyTargetResponse, WeeklyTargetSettings } from '@fleetcal/types';
import InfoDot from '@/components/ui/InfoDot';

const money = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(1)}K` : Math.abs(n).toFixed(0)}`;
const perMile = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function periodLabel(from: string, to: string): string {
  const f = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(from)} – ${f(to)}`;
}

export type WeeklyTargetPatch = { [K in keyof WeeklyTargetSettings]?: WeeklyTargetSettings[K] | null };

export type ParamKey = 'fuelPrice' | 'marginTarget' | 'mpg' | 'emptyFactor' | 'otrLoadedShare' | 'otrMilesPerDay' | 'fixedWeekly';
const PARAM_META: Record<ParamKey, { label: string; asPct?: boolean; prefix?: string; step: number; hint: string }> = {
  fuelPrice:      { label: 'Diesel $/gal',      prefix: '$', step: 0.01, hint: 'Default: average all-in price over the last 7 days of fuel transactions.' },
  marginTarget:   { label: 'Target margin',     asPct: true, step: 0.5,  hint: 'Default: your actual operating margin over the cost-basis months (truck purchases excluded).' },
  mpg:            { label: 'MPG',               step: 0.01, hint: 'Odometer miles ÷ gallons over the last 8 complete weeks.' },
  emptyFactor:    { label: 'Empty-mile factor', step: 0.01, hint: 'Total odometer miles ÷ booked loaded miles over the last 8 complete weeks. Projects this week’s miles from loads already booked.' },
  otrLoadedShare: { label: 'OTR loaded share',  asPct: true, step: 1, hint: 'Loaded ÷ total miles on an OTR trip. Lower it if trips often come back empty.' },
  otrMilesPerDay: { label: 'OTR miles / day',   step: 10,   hint: 'Miles an OTR truck covers per day — spreads the truck’s daily fixed cost over its miles.' },
  fixedWeekly:    { label: 'Fixed costs / week', prefix: '$', step: 100, hint: 'Default: fixed-behavior buckets over the last 3 closed months ÷ weeks. Override when a cost just changed.' },
};

const BEHAVIOR_LABEL: Record<CostBehavior, string> = {
  fixed: 'Fixed / week', per_mile: 'Per mile', revenue_pct: '% of revenue', exclude: 'Excluded',
};

export function ParamInput({ k, p, disabled, onSave }: {
  k: ParamKey; p: WeeklyTargetParam; disabled: boolean;
  onSave: (key: ParamKey, value: number | null) => void;
}) {
  const meta = PARAM_META[k];
  const scale = meta.asPct ? 100 : 1;
  const shown = (v: number) => (meta.asPct ? (v * 100).toFixed(1) : k === 'fixedWeekly' ? v.toFixed(0) : v.toFixed(k === 'otrMilesPerDay' ? 0 : 2));
  // Callers key this component on the saved value, so a fresh value
  // (after save or a reload) remounts it with a fresh draft.
  const [draft, setDraft] = useState(shown(p.value));

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) { setDraft(shown(p.value)); return; }
    const v = n / scale;
    if (Math.abs(v - p.value) < 1e-9) return;
    onSave(k, v);
  };
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1" style={{ color: 'var(--gc-text-3)' }}>
        {meta.label}
        <InfoDot content={<>{meta.hint}{p.computed != null && <> Calculated: <strong>{meta.prefix ?? ''}{shown(p.computed)}{meta.asPct ? '%' : ''}</strong>.</>}</>} size={11} />
      </span>
      <div className="flex items-center gap-1">
        {meta.prefix && <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>{meta.prefix}</span>}
        <input
          type="number"
          step={meta.step}
          value={draft}
          disabled={disabled}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-full rounded-md px-2 py-1 text-sm tabular-nums"
          style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
        />
        {meta.asPct && <span className="text-sm" style={{ color: 'var(--gc-text-3)' }}>%</span>}
        {p.overridden && (
          <button
            type="button"
            title="Reset to calculated value"
            disabled={disabled}
            onClick={() => onSave(k, null)}
            className="p-1 rounded"
            style={{ color: 'var(--gc-text-3)' }}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    </label>
  );
}

function Row({ label, value, strong, tone }: { label: React.ReactNode; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm py-0.5">
      <span style={{ color: 'var(--gc-text-2)' }}>{label}</span>
      <span className={`tabular-nums ${strong ? 'font-semibold' : ''}`} style={{ color: tone ?? 'var(--gc-text-1)' }}>{value}</span>
    </div>
  );
}

export default function WeeklyTargetCard({ data, error: err, saving, onSave: save }: {
  /** null while the selected period is loading. */
  data: WeeklyTargetResponse | null;
  error: string | null;
  saving: boolean;
  onSave: (patch: WeeklyTargetPatch) => void;
}) {
  const [showInputs, setShowInputs] = useState(false);
  const [chk, setChk] = useState({ revenue: '', loaded: '', empty: '' });
  const saveParam = useCallback((k: ParamKey, v: number | null) => save({ [k]: v }), [save]);

  const card = (children: React.ReactNode) => (
    <div style={{ background: 'var(--gc-surface)', borderRadius: 12, border: '1px solid var(--gc-border)', padding: 20 }}>
      {children}
    </div>
  );

  if (err && !data) return card(<div className="text-sm" style={{ color: '#d93025' }}>Weekly target: {err}</div>);
  if (!data) return card(<div className="h-40 rounded-lg animate-pulse" style={{ background: 'var(--gc-hover)' }} />);

  const { params: p, booked: b, projection: x, otr } = data;
  const isWeek = data.period.days === 7;
  const locked = data.settingsUnavailable || saving;
  const scaleMax = Math.max(x.targetRevenue, b.revenue, x.breakEvenRevenue) * 1.08 || 1;
  const pos = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`;
  const profitTone = x.profit >= 0 ? '#1e8e3e' : '#d93025';
  const stillNeeded = Math.max(0, x.targetRevenue - b.revenue);
  const perMileCost = p.fuelPrice.value / p.mpg.value + p.maintPerMile;

  // ── One-load checker (OTR) ──
  const rev = Number(chk.revenue); const loaded = Number(chk.loaded);
  const emptyIn = chk.empty.trim() === '' ? null : Number(chk.empty);
  const check = rev > 0 && loaded > 0 ? (() => {
    const total = emptyIn != null && Number.isFinite(emptyIn) ? loaded + emptyIn : loaded / p.otrLoadedShare.value;
    const fixedShare = (total / p.otrMilesPerDay.value) * p.fixedPerTruckDay;
    const keep = 1 - p.payPct.otr - p.revenuePctOther;
    const net = rev * keep - total * perMileCost - fixedShare;
    const breakEven = (total * perMileCost + fixedShare) / keep;
    const target = (total * perMileCost + fixedShare) / Math.max(0.05, keep - p.marginTarget.value);
    return { total, net, margin: net / rev, breakEven, target, rplm: rev / loaded };
  })() : null;

  return card(
    <>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--gc-text-1)' }}>
          <Target size={15} /> {isWeek ? 'Weekly target' : 'Period target'}
          <InfoDot size={12} content={<>
            Follows the period selected at the top of the dashboard; fixed costs scale with its length.
            Profit = revenue − driver pay (the Total Payroll figure) − other % of revenue − miles × (diesel ÷ MPG + maintenance/mi) − fixed costs.
            Break-even and target use the driver pay % of revenue instead, since they price revenue you haven&rsquo;t booked yet.
            Miles are projected from booked loaded miles × the empty-mile factor. Owner-operator loads are excluded.
            Expect about ±10% on any single week.
          </>} />
        </h2>
        <span className="text-sm font-medium tabular-nums" style={{ color: 'var(--gc-text-2)' }}>
          {periodLabel(data.period.from, data.period.to)}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <ParamInput key={`fuelPrice:${p.fuelPrice.value}`} k="fuelPrice" p={p.fuelPrice} disabled={locked} onSave={saveParam} />
        <ParamInput key={`marginTarget:${p.marginTarget.value}`} k="marginTarget" p={p.marginTarget} disabled={locked} onSave={saveParam} />
      </div>

      {/* Booked vs break-even vs target */}
      <div className="mb-1 relative h-3 rounded-full" style={{ background: 'var(--gc-hover)' }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pos(b.revenue), background: b.revenue >= x.breakEvenRevenue ? '#1e8e3e' : '#f9ab00' }} />
        <div className="absolute -inset-y-1 w-0.5" style={{ left: pos(x.breakEvenRevenue), background: 'var(--gc-text-1)' }} title="Break-even" />
        <div className="absolute -inset-y-1 w-0.5" style={{ left: pos(x.targetRevenue), background: '#1a73e8' }} title="Target" />
      </div>
      <div className="flex justify-between text-[11px] mb-4" style={{ color: 'var(--gc-text-3)' }}>
        <span>Booked {money(b.revenue)} · {b.loads} loads</span>
        <span>Break-even {money(x.breakEvenRevenue)} · <span style={{ color: '#1a73e8' }}>Target {money(x.targetRevenue)}</span></span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>{isWeek ? 'The week' : 'The period'}</div>
          <Row label="Projected profit" value={`${money(x.profit)} (${b.revenue > 0 ? pct(x.profit / b.revenue) : '—'})`} strong tone={profitTone} />
          <Row label="Still needed for target" value={stillNeeded > 0 ? money(stillNeeded) : 'Met'} />
          <Row label={<>Driver pay <span className="text-[11px]">({x.driverPaySource === 'payroll' ? 'finalized payroll' : x.driverPaySource === 'partial' ? 'partly finalized' : 'payroll pending'})</span></>} value={money(x.driverPay)} />
          <Row label={`Fuel (${Math.round(x.totalMiles).toLocaleString()} mi projected)`} value={money(x.fuel)} />
          <Row label="Maintenance" value={money(x.maintenance)} />
          <Row label="Fixed costs" value={money(x.fixed)} />
          {x.other > 0 && <Row label="Hotels / load expenses" value={money(x.other)} />}
          {x.actualMiles != null && (
            <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
              Odometer so far: {Math.round(x.actualMiles).toLocaleString()} mi
            </div>
          )}
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>Revenue per loaded mile</div>
          <Row label={isWeek ? 'Booked this week' : 'Booked this period'} value={perMile(x.revenuePerLoadedMile)} strong />
          <Row label="Break-even" value={perMile(x.breakEvenPerLoadedMile)} />
          <Row label="Target" value={perMile(x.targetPerLoadedMile)} tone="#1a73e8" />
          <div className="text-[11px] font-semibold uppercase tracking-wider mt-3 mb-1" style={{ color: 'var(--gc-text-3)' }}>
            OTR loads · per loaded mile
          </div>
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr style={{ color: 'var(--gc-text-3)' }} className="text-[11px]">
                <th className="text-left font-medium">Diesel</th><th className="text-right font-medium">Break-even</th><th className="text-right font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {otr.sensitivity.map(s => (
                <tr key={s.fuelPrice} style={{ fontWeight: Math.abs(s.fuelPrice - p.fuelPrice.value) < 0.005 ? 600 : 400, color: 'var(--gc-text-1)' }}>
                  <td>${s.fuelPrice.toFixed(2)}</td><td className="text-right">{perMile(s.breakEvenRplm)}</td><td className="text-right" style={{ color: '#1a73e8' }}>{perMile(s.targetRplm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>Check an OTR load</div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {(['revenue', 'loaded', 'empty'] as const).map(f => (
              <input
                key={f}
                type="number"
                placeholder={f === 'revenue' ? 'Rate $' : f === 'loaded' ? 'Loaded mi' : 'Empty mi'}
                value={chk[f]}
                onChange={e => setChk(c => ({ ...c, [f]: e.target.value }))}
                className="rounded-md px-2 py-1 text-sm tabular-nums min-w-0"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
              />
            ))}
          </div>
          {check ? (
            <>
              <div className="text-sm font-semibold mb-1" style={{ color: check.net < 0 ? '#d93025' : check.margin < p.marginTarget.value ? '#e37400' : '#1e8e3e' }}>
                {check.net < 0 ? 'Loses money' : check.margin < p.marginTarget.value ? 'Below target margin' : 'Meets target'} · {pct(check.margin)} margin
              </div>
              <Row label="Rate per loaded mile" value={perMile(check.rplm)} />
              <Row label="Break-even rate" value={money(check.breakEven)} />
              <Row label="Target rate" value={money(check.target)} tone="#1a73e8" />
              <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                {Math.round(check.total).toLocaleString()} total mi{emptyIn == null ? ` (assumes ${pct(p.otrLoadedShare.value)} loaded — enter empty miles for a one-way)` : ''}
              </div>
            </>
          ) : (
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              Enter a rate and loaded miles. Leave empty miles blank for a normal round trip; enter them when the truck comes back empty.
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setShowInputs(s => !s)}
        className="mt-4 text-xs flex items-center gap-1"
        style={{ color: 'var(--gc-text-3)' }}
      >
        <Settings2 size={13} /> {showInputs ? 'Hide' : 'Show'} model inputs
      </button>

      {showInputs && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--gc-border)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>Model inputs</span>
            <button
              type="button"
              onClick={() => setShowInputs(false)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-md"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
            >
              <X size={13} /> Close
            </button>
          </div>
          {data.settingsUnavailable && (
            <div className="text-xs mb-3" style={{ color: '#e37400' }}>
              Overrides can’t be saved until the weekly-target migration has been run. Everything shown is calculated.
            </div>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
            <ParamInput key={`mpg:${p.mpg.value}`} k="mpg" p={p.mpg} disabled={locked} onSave={saveParam} />
            <ParamInput key={`emptyFactor:${p.emptyFactor.value}`} k="emptyFactor" p={p.emptyFactor} disabled={locked} onSave={saveParam} />
            <ParamInput key={`otrLoadedShare:${p.otrLoadedShare.value}`} k="otrLoadedShare" p={p.otrLoadedShare} disabled={locked} onSave={saveParam} />
            <ParamInput key={`otrMilesPerDay:${p.otrMilesPerDay.value}`} k="otrMilesPerDay" p={p.otrMilesPerDay} disabled={locked} onSave={saveParam} />
            <ParamInput key={`fixedWeekly:${p.fixedWeekly.value}`} k="fixedWeekly" p={p.fixedWeekly} disabled={locked} onSave={saveParam} />
          </div>
          <div className="text-xs mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Driver pay: {pct(p.payPct.local)} of local revenue, {pct(p.payPct.otr)} of OTR (incl. adjustments) ·
            maintenance {perMile(p.maintPerMile)}/mi · {p.trucks} trucks · fixed {money(p.fixedPerTruckDay)}/truck-day ·
            pay & MPG from {data.calibration.from} → {data.calibration.to} · costs from {data.costBasis.months.join(', ') || '—'}
          </div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            How each expense bucket behaves
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
            {data.buckets
              .filter(bk => bk.parentId == null)
              .flatMap(top => [top, ...data.buckets.filter(c => c.parentId === top.id)])
              .map(bk => (
                <div key={bk.id} className="flex items-center justify-between gap-2 text-sm py-0.5" style={{ paddingLeft: bk.parentId ? 14 : 0 }}>
                  <span className="truncate" style={{ color: 'var(--gc-text-2)' }}>
                    {bk.name}{' '}
                    <span className="text-[11px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                      {money(bk.basisTotal)}{data.costBasis.lastMonth && <> · last mo {money(bk.lastMonthTotal)}</>}
                    </span>
                  </span>
                  {bk.behavior === 'modeled' ? (
                    <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>from loads / fuel</span>
                  ) : (
                    <span className="flex items-center gap-1 shrink-0">
                    {bk.behavior !== 'exclude' && data.costBasis.lastMonth && (
                      <select
                        value={bk.basis}
                        disabled={locked}
                        title="Which closed months this bucket's baseline comes from"
                        onChange={e => void save({ bucketBasis: { [bk.id]: e.target.value as BucketBasis } })}
                        className="text-xs rounded px-1 py-0.5"
                        style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
                      >
                        <option value="avg">3-mo avg</option>
                        <option value="last_month">Last month</option>
                      </select>
                    )}
                    <select
                      value={bk.behavior}
                      disabled={locked}
                      onChange={e => void save({ bucketBehaviors: { [bk.id]: e.target.value as CostBehavior } })}
                      className="text-xs rounded px-1 py-0.5"
                      style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
                    >
                      {(Object.keys(BEHAVIOR_LABEL) as CostBehavior[]).map(v => <option key={v} value={v}>{BEHAVIOR_LABEL[v]}</option>)}
                    </select>
                    </span>
                  )}
                </div>
              ))}
          </div>
          <button
            type="button"
            onClick={() => setShowInputs(false)}
            className="mt-3 text-xs flex items-center gap-1"
            style={{ color: 'var(--gc-text-3)' }}
          >
            <X size={13} /> Hide model inputs
          </button>
        </div>
      )}
    </>,
  );
}
