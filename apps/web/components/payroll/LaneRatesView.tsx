'use client';

/**
 * The Rates tab on /lanes: what to quote between two areas. Market is what
 * the last 120 days of loads billed; cost and target use the dashboard's
 * fuel, maintenance, overhead, hotel and margin numbers; driver pay is your
 * full-load lane pay, else what was paid. See apps/api/src/lib/laneRates.ts.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { LaneDirection, LaneRatePair, LaneRatesResponse } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { DIRECTION } from './PayMapView';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const shortDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const PAY_BASIS: Record<LaneRatePair['cost']['driverPayBasis'], string> = {
  standard: 'your full-load lane pay',
  paid: 'median paid',
  percent: 'dashboard pay %',
};
// The last result, so switching tabs shows it at once while it refreshes.
let lastRates: LaneRatesResponse | null = null;

/** What a quote should aim for: yours, else the round trip's share, else the lane's own. */
const quoteTarget = (p: LaneRatePair) => p.yourTarget ?? p.balancedTarget ?? p.target;

export default function LaneRatesView({ canEdit }: { canEdit: boolean }) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{ data?: LaneRatesResponse; error?: string } | null>(() => (lastRates ? { data: lastRates } : null));
  useEffect(() => {
    let cancelled = false;
    railway.getLaneRates()
      .then((data) => { lastRates = data; if (!cancelled) setResult({ data }); })
      .catch((e) => { if (!cancelled) setResult({ error: e instanceof Error ? e.message : 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const data = result?.data ?? null;

  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<LaneDirection | ''>('');
  const [minLoads, setMinLoads] = useState(3);
  const [open, setOpen] = useState<string | null>(null);

  const areaName = useMemo(() => new Map((data?.areas ?? []).map((a) => [a.id, a.name])), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const rank = new Map(data.corridorOrder.map((k, i) => [k, i]));
    const q = search.trim().toLowerCase();
    return data.pairs
      .filter((p) => (p.loads >= minLoads || p.yourTarget != null)
        && (!direction || p.direction === direction)
        && (!q || [areaName.get(p.fromAreaId) ?? '', areaName.get(p.toAreaId) ?? ''].some((t) => t.toLowerCase().includes(q))))
      .sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9) || b.loads - a.loads);
  }, [data, search, direction, minLoads, areaName]);

  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;
  if (result?.error) return <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: '#c5221f' }}>{result.error}</div>;
  if (!data) {
    return <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}><Loader2 size={14} className="animate-spin" /> Loading lane rates…</div>;
  }
  if (!data.available || !data.areas.length) {
    return <div className="p-4 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>Draw areas on the Map tab first — rates are by region pair.</div>;
  }
  const p = data.params;
  const priced = data.pairs.reduce((s, x) => s + x.loads, 0);

  return (
    <div>
      <div className="mb-3 text-[12px] space-y-1" style={{ color: 'var(--gc-text-3)' }}>
        <div>
          {priced.toLocaleString()} loads from {shortDate(data.since)} to {shortDate(data.until)}, by first stop&apos;s area → last stop&apos;s area
          {data.loadsOutsideAreas ? <> ({data.loadsOutsideAreas.toLocaleString()} more start or end outside every area)</> : null}.
          Cost is driver pay + fuel ${p.fuelPerMile.toFixed(2)}/mi and maintenance ${p.maintPerMile.toFixed(2)}/mi on driven miles
          (loaded × {p.drivenPer.local.toFixed(2)} local, × {p.drivenPer.otr.toFixed(2)} OTR) + truck time {money(p.overheadPerTruckDay / 4)} per
          6-hour block + hotels {money(p.hotelsPerBlock)} per OTR block. Target adds your {Math.round(p.margin * 100)}% margin; both cover
          the {(p.otherPct * 100).toFixed(1)}% of revenue that goes to other costs.
        </div>
        <div>
          <b style={{ color: 'var(--gc-text-2)' }}>Round trip</b> — an OTR lane leaving a home base and the one coming back share one target,
          split by what each direction&apos;s market pays: the trip out can go under its own target when the trip back makes it up.
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search an area"
          className="rounded px-2 py-1 text-[12px]" style={{ ...field, width: 200 }} />
        <select value={direction} onChange={(e) => setDirection(e.target.value as LaneDirection | '')} className="rounded px-2 py-1 text-[12px]" style={field}>
          <option value="">Every direction</option>
          {(Object.keys(DIRECTION) as LaneDirection[]).map((d) => <option key={d} value={d}>{DIRECTION[d].label}</option>)}
        </select>
        <select value={minLoads} onChange={(e) => setMinLoads(Number(e.target.value))} className="rounded px-2 py-1 text-[12px]" style={field}>
          <option value={3}>3+ loads</option>
          <option value={10}>10+ loads</option>
          <option value={1}>Any load</option>
        </select>
      </div>

      <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <table className="w-full text-[13px]" style={{ minWidth: 1080 }}>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
              <th className="px-3 py-2 font-semibold w-6" />
              <th className="px-3 py-2 font-semibold">Lane</th>
              <th className="px-3 py-2 font-semibold text-right">Market</th>
              <th className="px-3 py-2 font-semibold text-right">Driver pay</th>
              <th className="px-3 py-2 font-semibold text-right">Cost</th>
              <th className="px-3 py-2 font-semibold text-right">Break-even</th>
              <th className="px-3 py-2 font-semibold text-right">Target</th>
              <th className="px-3 py-2 font-semibold text-right" title="The round trip's target, split by market rate">Round trip</th>
              <th className="px-3 py-2 font-semibold">Your target</th>
              <th className="px-3 py-2 font-semibold text-right" title="Market minus the target you'd quote">Market vs target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const dir = DIRECTION[x.direction];
              const cost = x.cost.driverPay + x.cost.fuel + x.cost.maintenance + x.cost.overhead + x.cost.hotels;
              const gap = x.market.rate - quoteTarget(x);
              return (
                <Fragment key={x.key}>
                  <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
                    <td className="px-3 py-2 align-top">
                      <button type="button" onClick={() => setOpen(open === x.key ? null : x.key)} style={{ color: 'var(--gc-text-3)' }}>
                        {open === x.key ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                        {areaName.get(x.fromAreaId)}{x.fromAreaId === x.toAreaId ? '' : <> → {areaName.get(x.toAreaId)}</>}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5" style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                        <span className="px-1.5 rounded font-semibold" style={{ background: dir.bg, color: dir.fg }} title={dir.tip}>{dir.label}</span>
                        <span>{x.cls === 'otr' ? 'OTR' : 'Local'} · {x.loads} loads · {x.market.miles} loaded mi</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <div style={{ color: 'var(--gc-text-1)' }}>{money(x.market.rate)}</div>
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                        {x.market.low === x.market.high ? '' : `${money(x.market.low)}–${money(x.market.high)} · `}${x.market.perMile.toFixed(2)}/mi
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <div style={{ color: 'var(--gc-text-1)' }}>{money(x.cost.driverPay)}</div>
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                        {PAY_BASIS[x.cost.driverPayBasis]}
                        {x.relayPay != null ? <div title="Pickup + linehaul + delivery lane pay">relay {money(x.relayPay)}</div> : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-2)' }}>{money(cost)}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-2)' }}>{money(x.breakEven)}</td>
                    <td className="px-3 py-2 align-top text-right font-semibold" style={{ color: 'var(--gc-text-1)' }}>{money(x.target)}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-1)' }}>{x.balancedTarget != null ? money(x.balancedTarget) : '—'}</td>
                    <td className="px-3 py-2 align-top">
                      <TargetEditor pair={x} canEdit={canEdit} onSaved={reload} />
                    </td>
                    <td className="px-3 py-2 align-top text-right font-semibold" style={{ color: gap >= 0 ? '#1e8e3e' : '#c5221f' }}>
                      {gap >= 0 ? '+' : '−'}{money(Math.abs(gap))}
                    </td>
                  </tr>
                  {open === x.key ? (
                    <tr style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface-2)' }}>
                      <td />
                      <td colSpan={9} className="px-3 py-2 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          <span>Driver pay <b>{money(x.cost.driverPay)}</b> ({PAY_BASIS[x.cost.driverPayBasis]})</span>
                          <span>Fuel <b>{money(x.cost.fuel)}</b> + maintenance <b>{money(x.cost.maintenance)}</b> on {x.cost.drivenMiles} driven mi</span>
                          <span>Truck time <b>{money(x.cost.overhead)}</b> ({x.cost.blocks} block{x.cost.blocks === 1 ? '' : 's'} · median {x.cost.hours}h)</span>
                          {x.cost.hotels ? <span>Hotels <b>{money(x.cost.hotels)}</b></span> : null}
                          {x.fullPay != null && x.relayPay != null ? (
                            <span>One driver {money(x.fullPay)} vs relay {money(x.relayPay)} ({x.relayPay >= x.fullPay ? '+' : '−'}{money(Math.abs(x.relayPay - x.fullPay))})</span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!rows.length ? (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>No lanes match.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TargetEditor({ pair, canEdit, onSaved }: { pair: LaneRatePair; canEdit: boolean; onSaved: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = value ?? (pair.yourTarget != null ? String(pair.yourTarget) : '');
  const save = async (amount: number | null) => {
    setSaving(true);
    setError(null);
    try {
      await railway.setLaneTarget(pair.key, amount);
      setValue(null);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  if (!canEdit) return <span style={{ color: 'var(--gc-text-1)' }}>{pair.yourTarget != null ? money(pair.yourTarget) : '—'}</span>;
  const n = Number(shown);
  const dirty = value != null && value !== (pair.yourTarget != null ? String(pair.yourTarget) : '');
  return (
    <div>
      <div className="flex items-center gap-1">
        <span style={{ color: 'var(--gc-text-3)' }}>$</span>
        <input value={shown} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={String(pair.balancedTarget ?? pair.target)}
          className="rounded px-1.5 py-0.5 text-[12px] w-20" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty && shown && Number.isFinite(n)) void save(n); }} />
        {dirty && shown && Number.isFinite(n) ? (
          <button type="button" disabled={saving} onClick={() => void save(n)} className="text-[11px] font-semibold" style={{ color: 'var(--gc-blue)' }}>
            {saving ? '…' : 'Save'}
          </button>
        ) : pair.yourTarget != null && !value ? (
          <button type="button" disabled={saving} onClick={() => void save(null)} className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Clear</button>
        ) : null}
      </div>
      {error ? <div className="text-[11px]" style={{ color: '#c5221f' }}>{error}</div> : null}
    </div>
  );
}
