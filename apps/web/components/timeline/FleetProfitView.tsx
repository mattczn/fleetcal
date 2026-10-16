'use client';

/**
 * /timeline (no truck picked) — what each truck made this week.
 *
 * One row per truck, one column per day (Sat → Fri). Each day is four
 * time-of-day blocks (12a–6a, 6a–12p, 12p–6p, 6p–12a) colored by what the
 * truck was doing, with the day's profit under them. Profit uses the
 * dashboard's numbers; truck overhead is charged per block, priced by the
 * revenue the fleet earns in that block (lib/truckProfit.ts on the API).
 * Click a day to open that truck's timeline; the loads table below ranks
 * every load by profit.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, DollarSign, Loader2 } from 'lucide-react';
import type { TruckProfitBlock, TruckProfitLeg, TruckProfitPay, TruckProfitResponse } from '@fleetcal/types';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

const PAY_MODE_KEY = 'timeline.truckProfit.payMode';
const BLOCK_LABEL = ['12a–6a', '6a–12p', '12p–6p', '6p–12a'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GREEN = '#1e8e3e';
const RED = '#c5221f';
const AMBER = '#b06000';
const STATE_COLOR: Record<TruckProfitBlock['state'], string> = {
  loaded: '#16a34a',
  non_revenue: '#64748b',
  idle: 'var(--gc-surface-2)',
};

function weekStartFor(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7)); // back to Saturday
  return d.toISOString().slice(0, 10);
}
function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const tone = (n: number) => (n >= 0 ? GREEN : RED);

type Sort = 'worst' | 'best' | 'time';

export default function FleetProfitView() {
  const { calendarTimezone, assets } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const [weekStart, setWeekStart] = useState(() => weekStartFor(today));
  const weekEnd = shiftDay(weekStart, 6);
  const [pay, setPay] = useState<TruckProfitPay>(() => {
    try { return typeof window !== 'undefined' && localStorage.getItem(PAY_MODE_KEY) === 'avg' ? 'avg' : 'current'; }
    catch { return 'current'; }
  });
  const choosePay = (m: TruckProfitPay) => {
    setPay(m);
    try { localStorage.setItem(PAY_MODE_KEY, m); } catch { /* storage blocked — still works this visit */ }
  };
  const [sort, setSort] = useState<Sort>('worst');

  // Each answer is tagged with what it answers, so "loading" is just
  // "the latest answer is for something else".
  const queryKey = `${weekStart}|${pay}`;
  const [result, setResult] = useState<{ key: string; data?: TruckProfitResponse; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    railway.getTruckProfit({ from: weekStart, to: shiftDay(weekStart, 6), pay })
      .then((data) => { if (!cancelled) setResult({ key: queryKey, data }); })
      .catch((e) => { if (!cancelled) setResult({ key: queryKey, error: e instanceof Error ? e.message : 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [queryKey, weekStart, pay]);
  const loading = result?.key !== queryKey;
  const data = result?.data ?? null;
  const error = !loading ? result?.error ?? null : null;

  const colorOf = useMemo(() => new Map(assets.map((a) => [a.id, a.color])), [assets]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i)), [weekStart]);
  const legs = useMemo(() => {
    const ls = [...(data?.legs ?? [])];
    if (sort === 'worst') ls.sort((a, b) => a.profit - b.profit);
    else if (sort === 'best') ls.sort((a, b) => b.profit - a.profit);
    return ls;
  }, [data, sort]);

  const p = data?.params;
  const t = data?.totals;
  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;
  const weekLabel = `${new Date(`${weekStart}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${new Date(`${weekEnd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;

  return (
    <AppShell>
      <div className="max-w-[1500px] mx-auto px-6 py-4">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <DollarSign size={20} style={{ color: 'var(--gc-text-1)' }} />
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>Truck Profit</h1>
          <div className="flex items-center gap-1 ml-2">
            <button type="button" onClick={() => setWeekStart(shiftDay(weekStart, -7))} className="p-1 rounded" style={field} title="Previous week"><ChevronLeft size={14} /></button>
            <span className="text-[13px] font-semibold px-2 tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{weekLabel}</span>
            <button type="button" onClick={() => setWeekStart(shiftDay(weekStart, 7))} className="p-1 rounded" style={field} title="Next week"><ChevronRight size={14} /></button>
            {weekStart !== weekStartFor(today) ? (
              <button type="button" onClick={() => setWeekStart(weekStartFor(today))} className="ml-1 px-2 py-0.5 rounded text-[12px]" style={field}>This week</button>
            ) : null}
          </div>
          <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
            Driver pay
            <span className="inline-flex rounded-md overflow-hidden text-[11px]" style={{ border: '1px solid var(--gc-border)' }}>
              {(['current', 'avg'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={pay === m} onClick={() => choosePay(m)} className="px-1.5 py-px"
                  style={{ background: pay === m ? 'var(--gc-hover)' : 'transparent', color: pay === m ? 'var(--gc-text-1)' : 'var(--gc-text-3)', fontWeight: pay === m ? 600 : 400 }}>
                  {m === 'current' ? 'Current' : `Avg${p ? ` ${pct(p.payPct.local)} / ${pct(p.payPct.otr)}` : ' %'}`}
                </button>
              ))}
            </span>
          </span>
          {loading && data ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} /> : null}
          <div className="ml-auto flex items-center gap-3 text-[12px]">
            <Link href="/timeline/review" style={{ color: 'var(--gc-blue)' }}>GPS Review →</Link>
            <Link href="/timeline/fleet" style={{ color: 'var(--gc-blue)' }}>Revenue table →</Link>
          </div>
        </div>

        {error ? (
          <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: RED }}>{error}</div>
        ) : !data ? (
          <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {/* Week summary */}
            <div className="flex flex-wrap gap-2 mb-3">
              {([
                ['Revenue', t!.revenue],
                ['Driver pay', -t!.driverPay],
                ['Fuel', -t!.fuel],
                ['Maintenance', -t!.maintenance],
                ['Overhead', -t!.overhead],
                ['Other', -t!.other],
              ] as const).map(([label, v]) => (
                <div key={label} className="px-3 py-2 rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
                  <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
                  <div className="text-[15px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{money(v)}</div>
                </div>
              ))}
              <div className="px-3 py-2 rounded-lg" style={{ background: 'var(--gc-surface)', border: `1px solid ${tone(t!.profit)}` }}>
                <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Profit</div>
                <div className="text-[15px] font-semibold tabular-nums" style={{ color: tone(t!.profit) }}>
                  {money(t!.profit)}
                  {t!.revenue > 0 ? <span className="text-[12px] font-normal ml-1">{pct(t!.profit / t!.revenue)}</span> : null}
                </div>
              </div>
              <div className="px-3 py-2 rounded-lg" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
                <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Unused truck time</div>
                <div className="text-[15px] font-semibold tabular-nums" style={{ color: AMBER }}>{money(t!.unused)}</div>
              </div>
            </div>
            <div className="mb-2 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              {t!.drivenMiles.toLocaleString()} mi driven (all GPS drives — fuel and maintenance are charged on these)
              {' · '}{t!.linkedMiles.toLocaleString()} mi on loads
              {t!.drivenMiles > t!.linkedMiles ? ` · ${(t!.drivenMiles - t!.linkedMiles).toLocaleString()} mi not on any load` : ''}
              {data.payroll
                ? ` · Driver pay is the finalized payroll ${money(data.payroll.total)} (load pay ${money(data.payroll.loadPay)}${data.payroll.total !== data.payroll.loadPay ? ` ${data.payroll.total > data.payroll.loadPay ? '+' : '−'} ${money(Math.abs(data.payroll.total - data.payroll.loadPay))} adjustments` : ''}, spread where the load pay is)`
                : ''}
            </div>
            <BlockPrices data={data} />

            {/* Fleet grid */}
            <div className="rounded-lg overflow-x-auto mb-6" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
              <table className="w-full text-[12px]" style={{ minWidth: 980 }}>
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                    <th className="px-3 py-2 font-semibold">Truck</th>
                    {days.map((d) => (
                      <th key={d} className="px-1.5 py-2 font-semibold text-center" style={{ color: d === today ? 'var(--gc-blue)' : undefined }}>
                        {DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]} {Number(d.slice(8))}
                      </th>
                    ))}
                    <th className="px-3 py-2 font-semibold text-right">Week</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trucks.map((truck) => (
                    <tr key={truck.assetId} style={{ borderBottom: '1px solid var(--gc-border)' }}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={`/timeline?assetId=${truck.assetId}&date=${weekStart}`} className="inline-flex items-center gap-1.5 font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf.get(truck.assetId) ?? 'var(--gc-text-3)' }} />
                          {truck.name}
                        </Link>
                      </td>
                      {truck.days.map((day) => (
                        <td key={day.date} className="px-1.5 py-1.5">
                          <Link href={`/timeline?assetId=${truck.assetId}&date=${day.date}`} className="block rounded px-1 py-1"
                            style={{ background: day.date > today ? 'transparent' : undefined, opacity: day.date > today ? 0.55 : 1 }}
                            title={`${day.date}${day.cls ? ` · ${day.cls === 'otr' ? 'OTR' : 'Local'}` : ' · no work'}\nRevenue ${money(day.revenue)} · Profit ${money(day.profit)}${day.unused ? `\nUnused ${money(day.unused)}` : ''}`}>
                            <div className="flex gap-[2px] mb-1">
                              {day.blocks.map((b, i) => (
                                <span key={i}
                                  title={`${BLOCK_LABEL[i]} · ${b.state === 'idle' ? 'unused' : b.state === 'loaded' ? 'on a load' : 'non-revenue'} · ${b.cls === 'otr' ? 'OTR' : 'local'} price ${money(b.price)} · ${money(b.profit)}`}
                                  style={{
                                    flex: 1, height: 14, borderRadius: 3,
                                    background: STATE_COLOR[b.state],
                                    opacity: b.state === 'loaded' && b.profit < 0 ? 0.55 : 1,
                                    boxShadow: b.state === 'loaded' && b.profit < 0 ? `inset 0 -3px 0 ${RED}` : undefined,
                                  }} />
                              ))}
                            </div>
                            <div className="text-center tabular-nums font-semibold" style={{ color: tone(day.profit) }}>{money(day.profit)}</div>
                          </Link>
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                        <div className="font-semibold" style={{ color: tone(truck.totals.profit) }}>{money(truck.totals.profit)}</div>
                        <div style={{ color: 'var(--gc-text-3)', fontSize: 11 }}>
                          {money(truck.totals.revenue)} rev{truck.totals.revenue > 0 ? ` · ${pct(truck.totals.profit / truck.totals.revenue)}` : ''}
                        </div>
                        {truck.totals.unused > 0 ? <div style={{ color: AMBER, fontSize: 11 }}>{money(truck.totals.unused)} unused</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center gap-4 px-3 py-2 text-[11px] flex-wrap" style={{ color: 'var(--gc-text-3)' }}>
                {(['loaded', 'non_revenue', 'idle'] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <span style={{ width: 14, height: 8, borderRadius: 2, background: STATE_COLOR[s], border: s === 'idle' ? '1px solid var(--gc-border)' : undefined }} />
                    {s === 'loaded' ? 'On a load' : s === 'non_revenue' ? 'Non-revenue' : 'Unused'}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <span style={{ width: 14, height: 8, borderRadius: 2, background: STATE_COLOR.loaded, opacity: 0.55, boxShadow: `inset 0 -3px 0 ${RED}` }} />
                  Losing money
                </span>
                <span>Each day: 12a–6a · 6a–12p · 12p–6p · 6p–12a</span>
              </div>
            </div>

            {/* Loads */}
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>Loads</h2>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded px-2 py-1 text-[12px]" style={field}>
                <option value="worst">Least profitable first</option>
                <option value="best">Most profitable first</option>
                <option value="time">By time</option>
              </select>
              <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                $/mi is colored against the dashboard&apos;s break-even and target for local or OTR. Relay loads are split across their legs by truck time (revenue and pay).
              </span>
            </div>
            <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
              <table className="w-full text-[12px]" style={{ minWidth: 1100 }}>
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                    <th className="px-3 py-2 font-semibold">Load</th>
                    <th className="px-3 py-2 font-semibold">Truck · driver</th>
                    <th className="px-3 py-2 font-semibold">On the truck</th>
                    <th className="px-3 py-2 font-semibold text-right">Revenue</th>
                    <th className="px-3 py-2 font-semibold text-right">Pay</th>
                    <th className="px-3 py-2 font-semibold text-right">Fuel</th>
                    <th className="px-3 py-2 font-semibold text-right">Maint</th>
                    <th className="px-3 py-2 font-semibold text-right">Overhead</th>
                    <th className="px-3 py-2 font-semibold text-right">Profit</th>
                    <th className="px-3 py-2 font-semibold text-right">$/mi</th>
                    <th className="px-3 py-2 font-semibold text-right">Miles</th>
                  </tr>
                </thead>
                <tbody>
                  {legs.map((l) => <LegRow key={l.eventId} l={l} />)}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

const DOW_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Sat → Fri, like the grid

function BlockPrices({ data }: { data: TruckProfitResponse }) {
  const p = data.params;
  const perDay = p.overheadPerTruckDay.local;
  const split = (cls: 'local' | 'otr') => p.blockShares[cls].map((s) => `${Math.round(s * 100)}%`).join(' / ');
  return (
    <div className="mb-3 text-[11px] space-y-0.5" style={{ color: 'var(--gc-text-3)' }}>
      <div>
        <b style={{ color: 'var(--gc-text-2)' }}>Truck overhead by day</b> (avg {money(perDay)}/truck-day, priced by when the fleet earns):{' '}
        {DOW_ORDER.map((d) => `${DOW[d]} ${money(perDay * 7 * p.dayShares[d])}`).join(' · ')}
      </div>
      <div>
        Split across 12a / 6a / 12p / 6p — local day {split('local')} · OTR day {split('otr')}
        {p.hotelsPerOtrDay > 0 ? ` · hotels +${money(p.hotelsPerOtrDay)} per day on an OTR load` : ''}
        {' · '}fuel ${p.fuelPrice.toFixed(2)} ÷ {p.mpg} mpg · maint ${p.maintPerMile.toFixed(3)}/mi
      </div>
    </div>
  );
}

function LegRow({ l }: { l: TruckProfitLeg }) {
  const when = (s: string) => new Date(`${s}:00Z`).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const rpmColor = l.perLoadedMile == null ? 'var(--gc-text-3)' : l.perLoadedMile < l.breakEven ? RED : l.perLoadedMile < l.target ? AMBER : GREEN;
  const cell = 'px-3 py-1.5 align-top';
  const num = `${cell} text-right tabular-nums`;
  return (
    <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
      <td className={cell}>
        <Link href={`/timeline?assetId=${l.assetId}&date=${l.start.slice(0, 10)}&event=${l.eventId}`} className="font-semibold" style={{ color: 'var(--gc-blue)' }}>
          #{l.loadNum ?? '—'}
        </Link>
        <span className="ml-1.5 text-[10px] px-1 rounded" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}>
          {l.revenueLeg ? (l.cls === 'otr' ? 'OTR' : 'Local') : 'Non-rev'}
        </span>
      </td>
      <td className={cell} style={{ color: 'var(--gc-text-2)' }}>{l.truck}{l.driverName ? ` · ${l.driverName}` : ''}</td>
      <td className={`${cell} whitespace-nowrap`} style={{ color: 'var(--gc-text-2)' }}
        title={l.timesFromGps ? 'From the linked GPS' : 'Calendar times (no GPS linked)'}>
        {when(l.start)} → {when(l.end)}{l.timesFromGps ? '' : ' *'}
      </td>
      <td className={num} style={{ color: 'var(--gc-text-1)' }}>{money(l.revenue)}</td>
      <td className={num} style={{ color: 'var(--gc-text-2)' }}
        title={l.driverPaySource === 'actual' ? 'Recorded pay for this leg' : l.driverPaySource === 'split' ? "The load's recorded pay, split across its legs by truck time" : 'Average pay %'}>
        {money(l.driverPay)}{l.driverPaySource === 'avg' && l.revenueLeg ? ' ~' : l.driverPaySource === 'split' ? ' ÷' : ''}
      </td>
      <td className={num} style={{ color: 'var(--gc-text-2)' }}>{money(l.fuel)}</td>
      <td className={num} style={{ color: 'var(--gc-text-2)' }}>{money(l.maintenance)}</td>
      <td className={num} style={{ color: 'var(--gc-text-2)' }}>{money(l.overhead)}</td>
      <td className={`${num} font-semibold`} style={{ color: tone(l.profit) }}>{money(l.profit)}</td>
      <td className={num} style={{ color: rpmColor }} title={`Break-even $${l.breakEven.toFixed(2)} · target $${l.target.toFixed(2)} per loaded mile`}>
        {l.perLoadedMile != null ? `$${l.perLoadedMile.toFixed(2)}` : '—'}
      </td>
      <td className={num} style={{ color: 'var(--gc-text-3)' }} title={l.milesSource === 'gps' ? 'Driven miles from GPS' : 'Estimated from route miles'}>
        {l.routeMiles ?? '—'} / {l.drivenMiles}{l.milesSource === 'estimate' ? ' ~' : ''}
      </td>
    </tr>
  );
}
