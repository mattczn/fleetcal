'use client';

/**
 * The Trips tab on /lanes: each driver's run from a home base and back,
 * priced as a whole — a cheap load out is judged with the loads it set up
 * (SLC → Vegas → Denver → SLC). Trips with the same regions in the same
 * order group together; name one as a trip type to set its standard driver
 * pay and to pull other variants under it. See apps/api/src/lib/laneTrips.ts.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Map as MapIcon, RefreshCw, X } from 'lucide-react';
import type { LaneCircuit, LaneCircuitNode, LaneTrip, LaneTripTotals, LaneTripsResponse, TripType } from '@fleetcal/types';
import { railway } from '@/lib/railway';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
const day = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const LEG_COLORS = ['#1a73e8', '#d97706', '#16a34a', '#9333ea', '#dc2626', '#0891b2'];
const MAX_COMPARE = 4;
// The last result, so switching tabs shows it at once while it refreshes.
let lastTrips: LaneTripsResponse | null = null;

const chain = (nodes: LaneCircuitNode[], open = false) => (
  <span>
    {nodes.map((n, i) => (
      <Fragment key={i}>
        {i ? <span style={{ color: n.emptyIn ? 'var(--gc-text-3)' : 'var(--gc-text-2)' }} title={n.emptyIn ? 'Empty' : 'Loaded'}>{n.emptyIn ? ' ⇢ ' : ' → '}</span> : null}
        {n.label}
      </Fragment>
    ))}
    {open ? <span style={{ color: 'var(--gc-text-3)' }}> → …</span> : null}
  </span>
);
/** The loaded steps of a circuit, which a trip type's leg pay lines up with. */
const loadedSteps = (nodes: LaneCircuitNode[]) =>
  nodes.slice(1).map((n, i) => ({ from: nodes[i].label, to: n.label, empty: n.emptyIn })).filter((s) => !s.empty);
const standardPay = (t: TripType) => t.legPay.reduce((s, x) => s + x, 0) + t.layover;

function average(ts: LaneTrip[]): LaneTripTotals {
  const mean = (f: (t: LaneTripTotals) => number) => ts.reduce((s, t) => s + f(t.totals), 0) / Math.max(1, ts.length);
  const days = mean((t) => t.days);
  const revenue = mean((t) => t.revenue);
  const cost = mean((t) => t.cost);
  return {
    revenue, driverPay: mean((t) => t.driverPay), layover: mean((t) => t.layover), relayLegs: mean((t) => t.relayLegs),
    fuel: mean((t) => t.fuel), maintenance: mean((t) => t.maintenance), overhead: mean((t) => t.overhead), hotels: mean((t) => t.hotels),
    other: mean((t) => t.other), cost, profit: revenue - cost, profitPerDay: days > 0 ? (revenue - cost) / days : 0,
    targetRevenue: mean((t) => t.targetRevenue), vsTarget: mean((t) => t.vsTarget),
    loadedMiles: mean((t) => t.loadedMiles), emptyMiles: mean((t) => t.emptyMiles), days,
  };
}

interface Row { id: string; type: TripType | null; circuits: LaneCircuit[]; trips: LaneTrip[]; totals: LaneTripTotals }
interface CompareItem { id: string; title: React.ReactNode; sub: string; totals: LaneTripTotals; standard: number | null }

export default function LaneTripsView({ canEdit }: { canEdit: boolean }) {
  const [fresh, setFresh] = useState(0);
  const [result, setResult] = useState<{ data?: LaneTripsResponse; error?: string } | null>(() => (lastTrips ? { data: lastTrips } : null));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    railway.getLaneTrips(fresh > 0)
      .then((data) => { lastTrips = data; if (!cancelled) { setResult({ data }); setRefreshing(false); } })
      .catch((e) => { if (!cancelled) { setResult({ error: e instanceof Error ? e.message : 'Failed to load' }); setRefreshing(false); } });
    return () => { cancelled = true; };
  }, [fresh]);
  const data = result?.data ?? null;
  const [types, setTypes] = useState<TripType[] | null>(null);
  const tripTypes = useMemo(() => types ?? data?.tripTypes ?? [], [types, data]);
  const saveTypes = async (next: TripType[]) => {
    const { tripTypes: saved } = await railway.setTripTypes(next);
    setTypes(saved);
    if (lastTrips) lastTrips = { ...lastTrips, tripTypes: saved };
  };

  const [search, setSearch] = useState('');
  const [minTrips, setMinTrips] = useState(2);
  const [showOpen, setShowOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [mapTrip, setMapTrip] = useState<string | null>(null);

  const tripsByCircuit = useMemo(() => {
    const m = new Map<string, LaneTrip[]>();
    for (const t of data?.trips ?? []) m.set(t.circuitKey, [...(m.get(t.circuitKey) ?? []), t]);
    return m;
  }, [data]);
  const circuitByKey = useMemo(() => new Map((data?.circuits ?? []).map((c) => [c.key, c])), [data]);

  // A trip type is one row over every circuit it recognizes; other circuits are their own rows.
  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const claimed = new Set<string>();
    const out: Row[] = [];
    for (const t of tripTypes) {
      const circuits = t.circuitKeys.map((k) => circuitByKey.get(k)).filter((c): c is LaneCircuit => !!c);
      circuits.forEach((c) => claimed.add(c.key));
      const trips = circuits.flatMap((c) => tripsByCircuit.get(c.key) ?? []);
      out.push({ id: `type:${t.id}`, type: t, circuits, trips, totals: average(trips) });
    }
    for (const c of data.circuits) {
      if (claimed.has(c.key)) continue;
      const trips = tripsByCircuit.get(c.key) ?? [];
      out.push({ id: `circuit:${c.key}`, type: null, circuits: [c], trips, totals: average(trips) });
    }
    const q = search.trim().toLowerCase();
    return out
      .filter((r) => r.type || ((r.trips.length >= minTrips) && (showOpen || !r.circuits[0].open)))
      .filter((r) => !q || [r.type?.name ?? '', ...r.circuits.flatMap((c) => c.nodes.map((n) => n.label))].some((s) => s.toLowerCase().includes(q)))
      .sort((a, b) => Number(!!b.type) - Number(!!a.type) || b.trips.length - a.trips.length);
  }, [data, tripTypes, circuitByKey, tripsByCircuit, search, minTrips, showOpen]);

  const tripById = useMemo(() => new Map((data?.trips ?? []).map((t) => [t.id, t])), [data]);
  const compareItems = useMemo<CompareItem[]>(() => compare.map((id): CompareItem | null => {
    if (id.startsWith('trip:')) {
      const t = tripById.get(id.slice(5));
      const c = t ? circuitByKey.get(t.circuitKey) : null;
      if (!t || !c) return null;
      return { id, title: chain(c.nodes, c.open), sub: `${t.driver} · ${day(t.start)}–${day(t.end)}`, totals: t.totals, standard: null };
    }
    const r = rows.find((x) => x.id === id);
    if (!r) return null;
    return {
      id, title: r.type ? r.type.name : chain(r.circuits[0].nodes, r.circuits[0].open), sub: `Average of ${r.trips.length} trips`,
      totals: r.totals, standard: r.type ? standardPay(r.type) : null,
    };
  }).filter((x): x is CompareItem => !!x), [compare, rows, tripById, circuitByKey]);
  const toggleCompare = (id: string) => setCompare((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-MAX_COMPARE)));

  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;
  if (result?.error) return <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: '#c5221f' }}>{result.error}</div>;
  if (!data) {
    return <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}><Loader2 size={14} className="animate-spin" /> Finding trips in the last half year of loads…</div>;
  }
  if (!data.available) return <div className="p-4 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>Draw areas and mark your home bases on the Map tab first.</div>;
  const p = data.params;
  const focused = mapTrip ? tripById.get(mapTrip) ?? null : null;

  return (
    <div>
      <div className="mb-3 text-[12px] space-y-1" style={{ color: 'var(--gc-text-3)' }}>
        <div>
          {data.trips.length.toLocaleString()} OTR trips from {day(data.since)} to {day(data.until)}: a driver&apos;s loads from leaving a home base
          until getting back to it (<b style={{ color: 'var(--gc-text-2)' }}>→</b> loaded, <b style={{ color: 'var(--gc-text-2)' }}>⇢</b> empty).
          Cost is driver pay + layover/detention + relay shuttles by other drivers + fuel ${p.fuelPerMile.toFixed(2)}/mi and maintenance
          ${p.maintPerMile.toFixed(2)}/mi on loaded and empty miles + {money(p.overheadPerTruckDay)} per truck-day away + hotels. Target revenue
          adds your {Math.round(p.margin * 100)}% margin.
        </div>
        <div>
          On a relay, the load&apos;s rate is split between the drivers&apos; linehaul legs by what each leg&apos;s lane usually pays on its own
          (Vegas → SLC ≈ $1,600), else by miles; short shuttles (a Vegas pickup to the yard) earn nothing themselves — their pay, miles and
          truck time are charged to the linehaul. Name a trip to set its standard driver pay.
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a trip or area"
          className="rounded px-2 py-1 text-[12px]" style={{ ...field, width: 200 }} />
        <select value={minTrips} onChange={(e) => setMinTrips(Number(e.target.value))} className="rounded px-2 py-1 text-[12px]" style={field}>
          <option value={2}>Run 2+ times</option>
          <option value={5}>Run 5+ times</option>
          <option value={1}>Run once or more</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
          <input type="checkbox" checked={showOpen} onChange={(e) => setShowOpen(e.target.checked)} />
          Trips not back yet ({data.openTrips})
        </label>
        <button type="button" disabled={refreshing} onClick={() => { setRefreshing(true); setFresh((n) => n + 1); }}
          className="flex items-center gap-1 text-[12px] ml-auto" style={{ color: 'var(--gc-text-3)' }}
          title="Rebuild from the latest loads now (otherwise it refreshes itself every 10 minutes)">
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Rebuilding…' : 'Refresh'}
        </button>
      </div>

      {compareItems.length ? <ComparePanel items={compareItems} onRemove={toggleCompare} onClear={() => setCompare([])} /> : null}
      {focused ? <TripMap trip={focused} circuit={circuitByKey.get(focused.circuitKey) ?? null} onClose={() => setMapTrip(null)} /> : null}

      <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <table className="w-full text-[13px]" style={{ minWidth: 1180 }}>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
              <th className="px-2 py-2 w-6" />
              <th className="px-2 py-2 font-semibold w-6" title="Compare side by side">⇆</th>
              <th className="px-3 py-2 font-semibold">Trip</th>
              <th className="px-3 py-2 font-semibold text-right">Trips</th>
              <th className="px-3 py-2 font-semibold text-right">Days</th>
              <th className="px-3 py-2 font-semibold text-right">Revenue</th>
              <th className="px-3 py-2 font-semibold text-right">Driver pay</th>
              <th className="px-3 py-2 font-semibold text-right" title="Other drivers' short relay shuttles">Relay legs</th>
              <th className="px-3 py-2 font-semibold text-right">Fuel + maint</th>
              <th className="px-3 py-2 font-semibold text-right" title="Overhead per truck-day + hotels">Truck time</th>
              <th className="px-3 py-2 font-semibold text-right">Profit</th>
              <th className="px-3 py-2 font-semibold text-right">Per day</th>
              <th className="px-3 py-2 font-semibold text-right" title="Revenue minus the revenue that hits your margin">vs target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const t = r.totals;
              const isOpen = open === r.id;
              return (
                <Fragment key={r.id}>
                  <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
                    <td className="px-2 py-2 align-top">
                      <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} style={{ color: 'var(--gc-text-3)' }}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="px-2 py-2 align-top"><input type="checkbox" checked={compare.includes(r.id)} onChange={() => toggleCompare(r.id)} /></td>
                    <td className="px-3 py-2 align-top">
                      {r.type ? (
                        <>
                          <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{r.type.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                            {r.circuits.length ? r.circuits.map((c, i) => <div key={i}>{chain(c.nodes, c.open)}</div>) : 'No trips match yet'}
                          </div>
                        </>
                      ) : (
                        <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{chain(r.circuits[0].nodes, r.circuits[0].open)}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-right">{r.trips.length}</td>
                    <td className="px-3 py-2 align-top text-right">{t.days.toFixed(1)}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-1)' }}>{money(t.revenue)}</td>
                    <td className="px-3 py-2 align-top text-right">
                      <div>{money(t.driverPay + t.layover)}</div>
                      {r.type ? (
                        <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }} title="Your standard trip pay">std {money(standardPay(r.type))}</div>
                      ) : t.layover >= 1 ? <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>incl. {money(t.layover)} layover</div> : null}
                    </td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-2)' }}>{t.relayLegs >= 1 ? money(t.relayLegs) : '—'}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-2)' }}>
                      <div>{money(t.fuel + t.maintenance)}</div>
                      <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{Math.round(t.loadedMiles)} + {Math.round(t.emptyMiles)} empty mi</div>
                    </td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: 'var(--gc-text-2)' }}>{money(t.overhead + t.hotels)}</td>
                    <td className="px-3 py-2 align-top text-right font-semibold" style={{ color: t.profit >= 0 ? '#1e8e3e' : '#c5221f' }}>{money(t.profit)}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: t.profitPerDay >= 0 ? '#1e8e3e' : '#c5221f' }}>{money(t.profitPerDay)}</td>
                    <td className="px-3 py-2 align-top text-right" style={{ color: t.vsTarget >= 0 ? '#1e8e3e' : '#c5221f' }}>{t.vsTarget >= 0 ? '+' : ''}{money(t.vsTarget)}</td>
                  </tr>
                  {isOpen ? (
                    <tr style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface-2)' }}>
                      <td />
                      <td colSpan={12} className="px-3 py-3">
                        <TripTypeEditor row={r} types={tripTypes} canEdit={canEdit} onSave={saveTypes} />
                        <TripList trips={r.trips} compare={compare} onCompare={toggleCompare} onMap={setMapTrip} circuitByKey={circuitByKey} showChain={r.circuits.length > 1} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!rows.length ? <tr><td colSpan={13} className="px-3 py-6 text-center" style={{ color: 'var(--gc-text-3)' }}>No trips match.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TripList({ trips, compare, onCompare, onMap, circuitByKey, showChain }: {
  trips: LaneTrip[]; compare: string[]; onCompare: (id: string) => void; onMap: (id: string) => void;
  circuitByKey: Map<string, LaneCircuit>; showChain: boolean;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? trips : trips.slice(0, 15);
  return (
    <div className="mt-2">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            <th className="py-1 w-6" />
            <th className="py-1 pr-3">When</th>
            <th className="py-1 pr-3">Driver</th>
            <th className="py-1 pr-3">Loads</th>
            <th className="py-1 pr-3 text-right">Revenue</th>
            <th className="py-1 pr-3 text-right">Pay</th>
            <th className="py-1 pr-3 text-right">Empty mi</th>
            <th className="py-1 pr-3 text-right">Days</th>
            <th className="py-1 pr-3 text-right">Profit</th>
            <th className="py-1 pr-3 text-right">Per day</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => {
            const c = circuitByKey.get(t.circuitKey);
            return (
              <tr key={t.id} style={{ borderTop: '1px solid var(--gc-border)' }}>
                <td className="py-1.5 align-top"><input type="checkbox" checked={compare.includes(`trip:${t.id}`)} onChange={() => onCompare(`trip:${t.id}`)} /></td>
                <td className="py-1.5 pr-3 align-top whitespace-nowrap">{day(t.start)}–{day(t.end)}{t.returned === 'open' ? ' (out)' : ''}</td>
                <td className="py-1.5 pr-3 align-top whitespace-nowrap">{t.driver}</td>
                <td className="py-1.5 pr-3 align-top">
                  {showChain && c ? <div style={{ color: 'var(--gc-text-3)' }}>{chain(c.nodes, c.open)}</div> : null}
                  {t.legs.map((l) => (
                    <div key={l.eventId} style={{ color: l.shuttle ? 'var(--gc-text-3)' : 'var(--gc-text-2)' }}>
                      {l.loadNum ? `#${l.loadNum} ` : ''}{l.from} → {l.to}
                      {l.shuttle ? ' · relay shuttle (its cost rides on the linehaul)'
                        : l.split ? <> · {money(l.rate)} load, this part {money(l.revenue)}
                          <span style={{ color: 'var(--gc-text-3)' }} title={l.shareBasis === 'market' ? "What this leg's lane usually pays on its own" : "This leg's miles at the load's rate per mile"}>
                            {' '}({l.shareBasis === 'market' ? 'lane rate' : 'by miles'})</span></>
                        : <> · {money(l.rate)}</>}
                      {l.emptyMilesBefore ? <span style={{ color: 'var(--gc-text-3)' }}> · {l.emptyMilesBefore} empty mi before</span> : null}
                      {l.split ? (
                        <div className="pl-3" style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                          {l.split.filter((s) => s.eventId !== l.eventId).map((s) => `${s.driver ?? 'No driver'}: ${s.from} → ${s.to}${s.basis === 'shuttle' ? ' (shuttle)' : ` ${money(s.value)}`}`).join(' · ')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </td>
                <td className="py-1.5 pr-3 align-top text-right">{money(t.totals.revenue)}</td>
                <td className="py-1.5 pr-3 align-top text-right" title={t.legs.some((l) => l.payBasis === 'percent') ? 'Some legs have no pay recorded yet — estimated at the dashboard pay %' : undefined}>
                  {money(t.totals.driverPay + t.totals.layover)}{t.legs.some((l) => l.payBasis === 'percent') ? '*' : ''}
                </td>
                <td className="py-1.5 pr-3 align-top text-right">{t.totals.emptyMiles}</td>
                <td className="py-1.5 pr-3 align-top text-right">{t.totals.days.toFixed(1)}</td>
                <td className="py-1.5 pr-3 align-top text-right font-semibold" style={{ color: t.totals.profit >= 0 ? '#1e8e3e' : '#c5221f' }}>{money(t.totals.profit)}</td>
                <td className="py-1.5 pr-3 align-top text-right" style={{ color: t.totals.profitPerDay >= 0 ? '#1e8e3e' : '#c5221f' }}>{money(t.totals.profitPerDay)}</td>
                <td className="py-1.5 align-top">
                  <button type="button" onClick={() => onMap(t.id)} title="Show on map" style={{ color: 'var(--gc-blue)' }}><MapIcon size={14} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {trips.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="mt-1 text-[12px] font-semibold" style={{ color: 'var(--gc-blue)' }}>Show all {trips.length}</button>
      ) : null}
    </div>
  );
}

function TripTypeEditor({ row, types, canEdit, onSave }: { row: Row; types: TripType[]; canEdit: boolean; onSave: (next: TripType[]) => Promise<void> }) {
  const base = row.circuits[0];
  const steps = base ? loadedSteps(base.nodes) : [];
  const [draft, setDraft] = useState<{ name: string; legPay: string[]; layover: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (next: TripType[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  const start = () => setDraft({
    name: row.type?.name ?? '',
    legPay: steps.map((_, i) => (row.type?.legPay[i] != null ? String(row.type.legPay[i]) : '')),
    layover: row.type ? String(row.type.layover) : '',
  });
  const save = () => {
    if (!draft || !draft.name.trim()) return;
    const legPay = draft.legPay.map((x) => Number(x) || 0);
    const layover = Number(draft.layover) || 0;
    if (row.type) void run(types.map((t) => (t.id === row.type!.id ? { ...t, name: draft.name.trim(), legPay, layover } : t)));
    else void run([...types, { id: `t${Date.now().toString(36)}`, name: draft.name.trim(), circuitKeys: [base.key], legPay, layover, note: null }]);
  };
  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;

  if (draft) {
    return (
      <div className="rounded p-2 mb-2 text-[12px]" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Trip name, e.g. SLC ↔ Vegas turn"
            className="rounded px-2 py-1" style={{ ...field, width: 240 }} />
          {steps.map((s, i) => (
            <label key={i} className="flex items-center gap-1" style={{ color: 'var(--gc-text-2)' }}>
              {s.from} → {s.to} $
              <input value={draft.legPay[i] ?? ''} onChange={(e) => setDraft({ ...draft, legPay: draft.legPay.map((x, k) => (k === i ? e.target.value.replace(/[^0-9.]/g, '') : x)) })}
                className="rounded px-1.5 py-0.5 w-16" style={field} />
            </label>
          ))}
          <label className="flex items-center gap-1" style={{ color: 'var(--gc-text-2)' }}>
            Layover $
            <input value={draft.layover} onChange={(e) => setDraft({ ...draft, layover: e.target.value.replace(/[^0-9.]/g, '') })} className="rounded px-1.5 py-0.5 w-14" style={field} />
          </label>
          <button type="button" disabled={saving || !draft.name.trim()} onClick={save} className="px-2 py-1 rounded font-semibold" style={{ background: 'var(--gc-blue)', color: '#fff' }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setDraft(null)} style={{ color: 'var(--gc-text-3)' }}>Cancel</button>
        </div>
        {error ? <div className="mt-1" style={{ color: '#c5221f' }}>{error}</div> : null}
      </div>
    );
  }
  if (!canEdit) {
    return row.type ? (
      <div className="mb-2 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
        Standard trip pay {money(standardPay(row.type))} ({[...row.type.legPay.map((x) => money(x)), `${money(row.type.layover)} layover`].join(' + ')})
      </div>
    ) : null;
  }
  return (
    <div className="flex items-center gap-3 mb-2 text-[12px] flex-wrap" style={{ color: 'var(--gc-text-2)' }}>
      {row.type ? (
        <>
          <span>
            Standard trip pay <b>{money(standardPay(row.type))}</b> ({[...row.type.legPay.map((x) => money(x)), `${money(row.type.layover)} layover`].join(' + ')})
            {row.trips.length ? <> · paid on average {money(row.totals.driverPay + row.totals.layover)}</> : null}
          </span>
          <button type="button" onClick={start} className="font-semibold" style={{ color: 'var(--gc-blue)' }}>Edit</button>
          {row.circuits.length > 1 ? row.circuits.map((c) => (
            <button key={c.key} type="button" disabled={saving} title="Stop counting this variant as this trip"
              onClick={() => void run(types.map((t) => (t.id === row.type!.id ? { ...t, circuitKeys: t.circuitKeys.filter((k) => k !== c.key) } : t)))}
              className="flex items-center gap-0.5" style={{ color: 'var(--gc-text-3)' }}>
              <X size={11} /> {chain(c.nodes, c.open)}
            </button>
          )) : null}
          <button type="button" disabled={saving} onClick={() => void run(types.filter((t) => t.id !== row.type!.id))} style={{ color: '#c5221f' }}>Delete trip type</button>
        </>
      ) : (
        <>
          <button type="button" onClick={start} className="font-semibold" style={{ color: 'var(--gc-blue)' }}>Name this trip + set its pay</button>
          {types.length ? (
            <select value="" disabled={saving} className="rounded px-2 py-0.5" style={field}
              onChange={(e) => { const id = e.target.value; if (id) void run(types.map((t) => (t.id === id ? { ...t, circuitKeys: [...t.circuitKeys, base.key] } : t))); }}>
              <option value="">Count as an existing trip…</option>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          ) : null}
        </>
      )}
      {error ? <span style={{ color: '#c5221f' }}>{error}</span> : null}
    </div>
  );
}

const COMPARE_ROWS: Array<{ label: string; get: (t: LaneTripTotals) => number; days?: boolean; strong?: boolean; signed?: boolean }> = [
  { label: 'Revenue', get: (t) => t.revenue, strong: true },
  { label: 'Driver pay', get: (t) => t.driverPay },
  { label: 'Layover / detention', get: (t) => t.layover },
  { label: 'Relay legs', get: (t) => t.relayLegs },
  { label: 'Fuel + maintenance', get: (t) => t.fuel + t.maintenance },
  { label: 'Truck time', get: (t) => t.overhead },
  { label: 'Hotels', get: (t) => t.hotels },
  { label: 'Other', get: (t) => t.other },
  { label: 'Profit', get: (t) => t.profit, strong: true, signed: true },
  { label: 'Profit per day', get: (t) => t.profitPerDay, strong: true, signed: true },
  { label: 'vs target', get: (t) => t.vsTarget, signed: true },
];

function ComparePanel({ items, onRemove, onClear }: { items: CompareItem[]; onRemove: (id: string) => void; onClear: () => void }) {
  return (
    <div className="rounded-lg mb-3 overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
      <div className="flex items-center px-3 py-2" style={{ borderBottom: '1px solid var(--gc-border)' }}>
        <span className="text-[12px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>Compare</span>
        <button type="button" onClick={onClear} className="ml-auto text-[12px]" style={{ color: 'var(--gc-text-3)' }}>Clear</button>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
            <th className="px-3 py-2 text-left" style={{ width: 150 }} />
            {items.map((x) => (
              <th key={x.id} className="px-3 py-2 text-left align-top font-normal">
                <div className="flex items-start gap-1">
                  <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{x.title}</div>
                  <button type="button" onClick={() => onRemove(x.id)} style={{ color: 'var(--gc-text-3)' }}><X size={12} /></button>
                </div>
                <div style={{ color: 'var(--gc-text-3)' }}>{x.sub}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[
            { label: 'Days', render: (t: LaneTripTotals) => t.days.toFixed(1) },
            { label: 'Miles', render: (t: LaneTripTotals) => `${Math.round(t.loadedMiles)} + ${Math.round(t.emptyMiles)} empty` },
          ].map((r) => (
            <tr key={r.label}>
              <td className="px-3 py-1" style={{ color: 'var(--gc-text-3)' }}>{r.label}</td>
              {items.map((x) => <td key={x.id} className="px-3 py-1">{r.render(x.totals)}</td>)}
            </tr>
          ))}
          {COMPARE_ROWS.map((r) => (
            <tr key={r.label}>
              <td className="px-3 py-1" style={{ color: 'var(--gc-text-3)' }}>{r.label}</td>
              {items.map((x) => {
                const v = r.get(x.totals);
                return (
                  <td key={x.id} className={`px-3 py-1 ${r.strong ? 'font-semibold' : ''}`} style={{ color: r.signed ? (v >= 0 ? '#1e8e3e' : '#c5221f') : 'var(--gc-text-1)' }}>
                    {r.signed && v >= 0 ? '+' : ''}{money(v)}
                  </td>
                );
              })}
            </tr>
          ))}
          {items.some((x) => x.standard != null) ? (
            <tr>
              <td className="px-3 py-1" style={{ color: 'var(--gc-text-3)' }}>Standard trip pay</td>
              {items.map((x) => <td key={x.id} className="px-3 py-1">{x.standard != null ? money(x.standard) : '—'}</td>)}
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function TripMap({ trip, circuit, onClose }: { trip: LaneTrip; circuit: LaneCircuit | null; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps().then((g) => {
      if (cancelled || !box.current) return;
      mapRef.current = new g.maps.Map(box.current, { center: { lat: 39, lng: -112 }, zoom: 5, mapId: MAP_ID, clickableIcons: false, gestureHandling: 'greedy' });
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const made: Array<google.maps.Polyline | google.maps.marker.AdvancedMarkerElement> = [];
    const bounds = new google.maps.LatLngBounds();
    const arrow = { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2.5 };
    const dashed = (path: google.maps.LatLngLiteral[]) => made.push(new google.maps.Polyline({
      map, path, strokeOpacity: 0, zIndex: 1,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeColor: '#6b7280', scale: 2.5 }, offset: '0', repeat: '12px' }],
    }));
    if (trip.emptyOut && trip.legs[0]) dashed([trip.emptyOut.from, trip.legs[0].path[0]]);
    trip.legs.forEach((l, i) => {
      if (i > 0) {
        const prev = trip.legs[i - 1].path;
        dashed([prev[prev.length - 1], l.path[0]]);
      }
      const color = l.shuttle ? '#6b7280' : LEG_COLORS[i % LEG_COLORS.length];
      made.push(new google.maps.Polyline({ map, path: l.path, strokeColor: color, strokeWeight: 4, strokeOpacity: 0.9, zIndex: 2, icons: [{ icon: arrow, offset: '60%' }] }));
      l.path.forEach((pt) => bounds.extend(pt));
      const label = document.createElement('div');
      label.textContent = `${i + 1}`;
      label.style.cssText = `font: 700 11px system-ui; color: #fff; background: ${color}; border-radius: 9px; padding: 1px 6px; box-shadow: 0 1px 2px rgba(0,0,0,.3);`;
      made.push(new google.maps.marker.AdvancedMarkerElement({ map, position: l.path[0], content: label, zIndex: 3 }));
    });
    const last = trip.legs[trip.legs.length - 1]?.path;
    if (trip.emptyBack && last) dashed([last[last.length - 1], trip.emptyBack.to]);
    if (!bounds.isEmpty()) map.fitBounds(bounds, 40);
    return () => made.forEach((o) => ('setMap' in o ? o.setMap(null) : (o.map = null)));
  }, [ready, trip]);

  return (
    <div className="rounded-lg mb-3 overflow-hidden" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
      <div className="flex items-start gap-2 px-3 py-2 text-[12px]" style={{ borderBottom: '1px solid var(--gc-border)' }}>
        <div>
          <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{circuit ? chain(circuit.nodes, circuit.open) : 'Trip'}</div>
          <div style={{ color: 'var(--gc-text-3)' }}>
            {trip.driver} · {day(trip.start)}–{day(trip.end)} · {trip.legs.map((l, i) => (
              <span key={l.eventId} style={{ color: l.shuttle ? undefined : LEG_COLORS[i % LEG_COLORS.length] }}>
                {i ? ' · ' : ''}{i + 1}. {l.loadNum ? `#${l.loadNum} ` : ''}{l.from} → {l.to}
              </span>
            ))}
          </div>
        </div>
        <button type="button" onClick={onClose} className="ml-auto" style={{ color: 'var(--gc-text-3)' }}><X size={14} /></button>
      </div>
      <div ref={box} style={{ height: 340 }} />
    </div>
  );
}
