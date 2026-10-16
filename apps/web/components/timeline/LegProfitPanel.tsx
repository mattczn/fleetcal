'use client';

/**
 * The "Profit" section of a load in the truck timeline's detail panel —
 * the same numbers as the Truck Profit grid (lib/truckProfit.ts on the API).
 */

import type { TruckProfitLeg } from '@fleetcal/types';

const GREEN = '#1e8e3e';
const RED = '#c5221f';
const AMBER = '#b06000';
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;

export default function LegProfitPanel({ leg, fs }: { leg: TruckProfitLeg | undefined; fs: (px: number) => number }) {
  if (!leg) return null;
  const rpmColor = leg.perLoadedMile == null ? 'var(--gc-text-3)'
    : leg.perLoadedMile < leg.breakEven ? RED : leg.perLoadedMile < leg.target ? AMBER : GREEN;
  const rows: Array<[string, number, string?]> = [
    ['Revenue', leg.revenue],
    ['Driver pay', -leg.driverPay, leg.driverPaySource === 'avg' && leg.revenueLeg ? 'average %' : undefined],
    ['Fuel', -leg.fuel, `${leg.drivenMiles} mi${leg.milesSource === 'estimate' ? ' (estimated)' : ''}`],
    ['Maintenance', -leg.maintenance],
    ['Truck overhead', -leg.overhead, 'time-of-day blocks'],
    ['Other', -leg.other],
  ];
  return (
    <div className="rounded-lg p-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>Profit</span>
        <span className="px-1.5 rounded" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)', fontSize: fs(10) }}>
          {leg.revenueLeg ? (leg.cls === 'otr' ? 'OTR' : 'Local') : 'Non-revenue'}
        </span>
      </div>
      <div className="space-y-0.5" style={{ fontSize: fs(12) }}>
        {rows.map(([label, v, note]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <span style={{ color: 'var(--gc-text-2)' }}>
              {label}{note ? <span style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}> · {note}</span> : null}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{money(v)}</span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-2 pt-1 mt-1" style={{ borderTop: '1px solid var(--gc-border)' }}>
          <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>Profit</span>
          <span className="tabular-nums font-semibold" style={{ color: leg.profit >= 0 ? GREEN : RED }}>
            {money(leg.profit)}
            {leg.revenue > 0 ? <span className="font-normal" style={{ fontSize: fs(11) }}> · {Math.round((leg.profit / leg.revenue) * 100)}%</span> : null}
          </span>
        </div>
        {leg.perLoadedMile != null ? (
          <div className="flex items-baseline justify-between gap-2" style={{ fontSize: fs(11) }}>
            <span style={{ color: 'var(--gc-text-3)' }}>
              Per loaded mile (break-even ${leg.breakEven.toFixed(2)} · target ${leg.target.toFixed(2)})
            </span>
            <span className="tabular-nums font-semibold" style={{ color: rpmColor }}>${leg.perLoadedMile.toFixed(2)}</span>
          </div>
        ) : null}
        {!leg.timesFromGps ? (
          <div style={{ color: 'var(--gc-text-3)', fontSize: fs(10) }}>No GPS linked — truck time uses the calendar entry.</div>
        ) : null}
      </div>
    </div>
  );
}
