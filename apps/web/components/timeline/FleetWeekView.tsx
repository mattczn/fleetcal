/**
 * FleetWeekView — fleet-wide weekly revenue comparison.
 *
 * Renders a sortable table with one row per visible truck for the
 * selected week (Sat → Fri). Reuses the per-asset week-summary
 * endpoint (one parallel call per truck) so the math matches what
 * the per-truck /timeline page shows — no risk of fleet-vs-truck
 * discrepancies.
 *
 * Bulk Re-link button at the top mirrors the /performance flow:
 * for each truck × each day of the week, fire the per-day auto-link
 * AI endpoint with capped concurrency, then refetch the table.
 *
 * Click a truck name → jump to /timeline?assetId=X for the per-day
 * deep-dive.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Truck, Loader2, ArrowUpDown } from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { parseNaiveIsoInTz } from '@/lib/time-utils';

interface WeekRow {
  assetId:      number;
  assetName:    string;
  assetUnit:    string | null;
  assetColor:   string;
  loadCount:    number;
  totalRevenue: number;
  totalDriverPay: number;
  totalMiles:   number;
  loadedMiles:  number;
  rpm:          number | null;       // revenue / total miles
  rpmLoaded:    number | null;       // revenue / loaded miles
  deadheadPct:  number | null;
  driverPayPct: number | null;       // driver pay / revenue
}

type SortKey = 'name' | 'totalRevenue' | 'loadCount' | 'totalMiles' | 'totalDriverPay' | 'rpm' | 'driverPayPct' | 'fuelEst' | 'net' | 'marginPct';

// Saturday-anchored weekStart for the date string in the org's tz.
// Matches the server's week boundary (timeline.ts shiftDayKey).
function weekStartFor(dayKey: string): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  // getUTCDay: Sun=0..Sat=6 → distance back to Saturday.
  const dow = d.getUTCDay();
  const back = (dow + 1) % 7; // Sat=6 → 0; Sun=0 → 1; … Fri=5 → 6.
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function shiftDayKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function enumerateDayKeys(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDayKey(weekStart, i));
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtMiles(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n).toLocaleString()}`;
}

function fmtRpm(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

/** Localstorage key for the user-tunable fuel rate. Persisted per-
 *  browser, not per-org — the input is a sensitivity dial, not
 *  authoritative cost data (we don't have per-truck fuel economy
 *  data, and the user reasonably wants different "what-if" rates
 *  without saving each one). */
const FUEL_RATE_KEY = 'fleetWeek.fuelPerMile';
const DEFAULT_FUEL_RATE = 0.65; // $/mi — sensible mid-range default

export default function FleetWeekView() {
  const router = useRouter();
  const { assets, calendarTimezone } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';

  const visibleAssets = useMemo(
    () => assets.filter((a) => !a.hidden && a.type !== 'Unassigned' && a.name !== 'Unassigned')
      .sort((a, b) => a.sortOrder - b.sortOrder),
    [assets],
  );

  // ── Week selector — 12 weeks back from today, Sat-anchored ─────────────
  const todayKey = new Date().toISOString().slice(0, 10);
  const currentWeekStart = useMemo(() => weekStartFor(todayKey), [todayKey]);
  const [weekStart, setWeekStart] = useState<string>(currentWeekStart);
  const startedWeeks = useMemo(() => {
    const items: { weekStart: string; label: string }[] = [];
    let cur = currentWeekStart;
    for (let i = 0; i < 12; i++) {
      const fri = shiftDayKey(cur, 6);
      const [satY, satM, satD] = cur.split('-').map(Number);
      const [friY, friM, friD] = fri.split('-').map(Number);
      const satDate = new Date(satY, satM - 1, satD);
      const friDate = new Date(friY, friM - 1, friD);
      const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      items.push({
        weekStart: cur,
        label: `${fmt(satDate)} – ${fmt(friDate)}${i === 0 ? ' (current)' : ''}`,
      });
      cur = shiftDayKey(cur, -7);
    }
    return items;
  }, [currentWeekStart]);

  // ── Data: one parallel week-summary fetch per visible asset ────────────
  const [rows, setRows] = useState<WeekRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (visibleAssets.length === 0) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const results = await Promise.all(
          visibleAssets.map(async (a) => {
            try {
              const s = await railway.getWeekSummary(a.id, weekStart, tz);
              const wt = s.weekTotal;
              const totalMiles = wt.totalMiles ?? 0;
              const rpm = totalMiles > 0 ? wt.totalRevenue / totalMiles : null;
              const rpmLoaded = wt.loadedMiles > 0 ? wt.totalRevenue / wt.loadedMiles : null;
              const driverPayPct = wt.totalRevenue > 0 ? wt.totalDriverPay / wt.totalRevenue : null;
              return {
                assetId:        a.id,
                assetName:      a.name,
                assetUnit:      a.unit ?? null,
                assetColor:     a.color ?? '#1a73e8',
                loadCount:      wt.loadCount,
                totalRevenue:   wt.totalRevenue,
                totalDriverPay: wt.totalDriverPay,
                totalMiles,
                loadedMiles:    wt.loadedMiles,
                rpm,
                rpmLoaded,
                deadheadPct:    wt.deadheadPctOfDay,
                driverPayPct,
              } satisfies WeekRow;
            } catch {
              // Per-truck failure shouldn't kill the table — surface
              // an empty row instead.
              return {
                assetId:        a.id,
                assetName:      a.name,
                assetUnit:      a.unit ?? null,
                assetColor:     a.color ?? '#1a73e8',
                loadCount:      0,
                totalRevenue:   0,
                totalDriverPay: 0,
                totalMiles:     0,
                loadedMiles:    0,
                rpm:            null,
                rpmLoaded:      null,
                deadheadPct:    null,
                driverPayPct:   null,
              } satisfies WeekRow;
            }
          }),
        );
        if (!cancelled) { setRows(results); setLoading(false); }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); }
      }
    })();

    return () => { cancelled = true; };
  }, [visibleAssets, weekStart, tz, refreshTick]);

  // ── Fuel rate (user-tunable, persisted) ────────────────────────────────
  // Loaded from localStorage on mount so the dispatcher's last value
  // sticks across visits. Edits flush back immediately.
  const [fuelPerMile, setFuelPerMile] = useState<number>(DEFAULT_FUEL_RATE);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.localStorage.getItem(FUEL_RATE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) setFuelPerMile(parsed);
  }, []);
  const updateFuelRate = (v: number) => {
    setFuelPerMile(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(FUEL_RATE_KEY, String(v));
    }
  };

  // ── Sort ───────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>('totalRevenue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  // Per-row derived values (fuel estimate, net, margin %). Pulled out
  // of the sort closure so the table reads the same numbers it sorts on.
  const derivedRows = useMemo(() => rows.map((r) => {
    const fuelEst = r.totalMiles * fuelPerMile;
    const net = r.totalRevenue - r.totalDriverPay - fuelEst;
    const marginPct = r.totalRevenue > 0 ? net / r.totalRevenue : null;
    return { ...r, fuelEst, net, marginPct };
  }), [rows, fuelPerMile]);

  const sortedRows = useMemo(() => {
    const arr = [...derivedRows];
    arr.sort((a, b) => {
      let va: number | string;
      let vb: number | string;
      switch (sortKey) {
        case 'name':           va = a.assetName.toLowerCase(); vb = b.assetName.toLowerCase(); break;
        case 'totalRevenue':   va = a.totalRevenue; vb = b.totalRevenue; break;
        case 'loadCount':      va = a.loadCount; vb = b.loadCount; break;
        case 'totalMiles':     va = a.totalMiles; vb = b.totalMiles; break;
        case 'totalDriverPay': va = a.totalDriverPay; vb = b.totalDriverPay; break;
        case 'rpm':            va = a.rpm ?? -1; vb = b.rpm ?? -1; break;
        case 'driverPayPct':   va = a.driverPayPct ?? -1; vb = b.driverPayPct ?? -1; break;
        case 'fuelEst':        va = a.fuelEst; vb = b.fuelEst; break;
        case 'net':            va = a.net; vb = b.net; break;
        case 'marginPct':      va = a.marginPct ?? -Infinity; vb = b.marginPct ?? -Infinity; break;
        default:               va = 0; vb = 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [derivedRows, sortKey, sortDir]);

  // ── Fleet totals (footer) ──────────────────────────────────────────────
  const fleetTotals = useMemo(() => {
    let totalRev = 0, totalPay = 0, totalLoads = 0, totalMi = 0, totalLoadedMi = 0;
    for (const r of rows) {
      totalRev += r.totalRevenue;
      totalPay += r.totalDriverPay;
      totalLoads += r.loadCount;
      totalMi += r.totalMiles;
      totalLoadedMi += r.loadedMiles;
    }
    const fuelEst = totalMi * fuelPerMile;
    const net     = totalRev - totalPay - fuelEst;
    return {
      totalRevenue:   totalRev,
      totalDriverPay: totalPay,
      loadCount:      totalLoads,
      totalMiles:     totalMi,
      loadedMiles:    totalLoadedMi,
      rpm:            totalMi > 0 ? totalRev / totalMi : null,
      driverPayPct:   totalRev > 0 ? totalPay / totalRev : null,
      fuelEst,
      net,
      marginPct:      totalRev > 0 ? net / totalRev : null,
    };
  }, [rows, fuelPerMile]);

  // Largest revenue for the inline horizontal bars — visual comparison
  // without needing a separate chart library.
  const maxRevenue = useMemo(() => Math.max(1, ...rows.map((r) => r.totalRevenue)), [rows]);

  // ── Bulk re-link (every truck × every day of the selected week) ────────
  const [relinking, setRelinking]   = useState(false);
  const [progress, setProgress]     = useState<{ done: number; total: number } | null>(null);
  const [relinkResult, setRelinkResult] = useState<{ links: number; failed: number } | null>(null);

  const runFleetRelink = useCallback(async () => {
    if (visibleAssets.length === 0 || relinking) return;
    const dayKeys = enumerateDayKeys(weekStart);
    const padMs = 6 * 60 * 60 * 1000;
    const jobs: Array<{ assetId: number; from: string; to: string }> = [];
    for (const a of visibleAssets) {
      for (const dk of dayKeys) {
        const startEpoch = parseNaiveIsoInTz(`${dk}T00:00:00`, tz);
        const endEpoch   = parseNaiveIsoInTz(`${dk}T23:59:59`, tz);
        jobs.push({
          assetId: a.id,
          from:    new Date(startEpoch - padMs).toISOString(),
          to:      new Date(endEpoch   + padMs).toISOString(),
        });
      }
    }
    setRelinking(true);
    setRelinkResult(null);
    setProgress({ done: 0, total: jobs.length });

    let done = 0, links = 0, failed = 0;
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        const idx = cursor++;
        const job = jobs[idx];
        try {
          const r = await railway.autoLinkAssetTimeline(job.assetId, job.from, job.to);
          links += r.linksWritten;
        } catch { failed++; }
        done++;
        setProgress({ done, total: jobs.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
    setRelinking(false);
    setProgress(null);
    setRelinkResult({ links, failed });
    setRefreshTick((t) => t + 1);
  }, [visibleAssets, weekStart, tz, relinking]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <AppShell>
      <div className="max-w-[1500px] mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <Link href="/timeline"
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
            title="Back to per-truck timeline">
            <ArrowLeft size={16} />
          </Link>
          <Truck size={20} style={{ color: 'var(--gc-text-1)' }} />
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>
            Fleet Week
          </h1>

          {/* Week selector */}
          <select
            value={weekStart}
            onChange={(e) => setWeekStart(e.target.value)}
            className="ml-2 px-2 py-1 rounded text-[14px] font-semibold bg-transparent cursor-pointer"
            style={{ color: 'var(--gc-text-1)', border: '1px solid var(--gc-border)' }}>
            {startedWeeks.map((w) => (
              <option key={w.weekStart} value={w.weekStart}>{w.label}</option>
            ))}
          </select>

          {/* Fuel rate input — sensitivity dial. Drives the Fuel (est)
              column, Net, and Margin. Saved to localStorage so the
              dispatcher's last value sticks across sessions. */}
          <label className="ml-2 flex items-center gap-1.5 px-2 py-1 rounded text-[11px]"
            style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}
            title="Fuel cost per mile — used to estimate fuel spend and compute Net + Margin">
            <span style={{ color: 'var(--gc-text-2)', fontWeight: 600 }}>Fuel</span>
            <span style={{ color: 'var(--gc-text-3)' }}>$</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={fuelPerMile}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) updateFuelRate(v);
              }}
              className="text-[13px] font-semibold bg-transparent outline-none tabular-nums"
              style={{ color: 'var(--gc-text-1)', width: 56, border: 'none' }} />
            <span style={{ color: 'var(--gc-text-3)' }}>/ mi</span>
          </label>

          <div className="ml-auto flex items-center gap-2">
            {relinkResult && (
              <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                Linked {relinkResult.links}{relinkResult.failed > 0 ? ` (${relinkResult.failed} failed)` : ''} · refreshed
              </span>
            )}
            <button type="button" onClick={runFleetRelink} disabled={relinking || visibleAssets.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--gc-blue)', color: 'white', border: 'none' }}
              title="Re-run AI auto-link for every truck × every day of the selected week">
              {relinking
                ? <><Loader2 size={13} className="animate-spin" />Re-linking {progress ? `(${progress.done}/${progress.total})` : '…'}</>
                : <><RefreshCw size={13} />Re-link week</>}
            </button>
          </div>
        </div>

        {/* Fleet KPI strip — revenue / costs / net at a glance */}
        <div className="grid grid-cols-6 gap-3 mb-4">
          <KpiTile label="Revenue"      value={fmtMoney(fleetTotals.totalRevenue)} />
          <KpiTile label="Driver Pay"   value={fmtMoney(fleetTotals.totalDriverPay)} accent="#5e35b1" />
          <KpiTile label="Fuel (est)"   value={fmtMoney(fleetTotals.fuelEst)}        accent="#ea4335"
            sub={`${fleetTotals.totalMiles.toLocaleString()} mi × $${fuelPerMile.toFixed(2)}/mi`} />
          <KpiTile label="Net"          value={fmtMoney(fleetTotals.net)}
            accent={fleetTotals.net >= 0 ? '#1e8e3e' : '#d93025'} />
          <KpiTile label="Margin"       value={fmtPct(fleetTotals.marginPct)}
            accent={(fleetTotals.marginPct ?? 0) >= 0 ? '#1e8e3e' : '#d93025'} />
          <KpiTile label="Fleet RPM"    value={fmtRpm(fleetTotals.rpm)} />
        </div>

        {/* Table */}
        <div className="rounded-xl overflow-hidden" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          {error ? (
            <div className="p-6 text-center text-[13px]" style={{ color: '#d93025' }}>{error}</div>
          ) : loading ? (
            <div className="p-8 flex items-center justify-center gap-2 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={14} className="animate-spin" /> Loading week summary for every truck…
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="p-8 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              No visible trucks in the fleet.
            </div>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface-2)' }}>
                  <Th label="Truck"      sortKey="name"           sort={{ sortKey, sortDir }} onSort={onSort} align="left" />
                  <Th label="Loads"      sortKey="loadCount"      sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Revenue"    sortKey="totalRevenue"   sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Miles"      sortKey="totalMiles"     sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Driver Pay" sortKey="totalDriverPay" sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Fuel (est)" sortKey="fuelEst"        sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Net"        sortKey="net"            sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="Margin"     sortKey="marginPct"      sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                  <Th label="RPM"        sortKey="rpm"            sort={{ sortKey, sortDir }} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const revPctOfMax = (r.totalRevenue / maxRevenue) * 100;
                  return (
                    <tr key={r.assetId}
                      className="cursor-pointer transition-colors"
                      style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                      onClick={() => router.push(`/timeline?assetId=${r.assetId}`)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.assetColor }} />
                          <span className="font-medium" style={{ color: 'var(--gc-text-1)' }}>
                            {r.assetUnit ? `#${r.assetUnit} · ${r.assetName}` : r.assetName}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{r.loadCount}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {/* Inline bar so the eye can compare without the
                            user having to sort. Width is proportional to
                            the fleet's max revenue this week. */}
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1 rounded" style={{ width: 90, background: 'var(--gc-border-light)', position: 'relative', overflow: 'hidden' }}>
                            <div style={{ width: `${revPctOfMax}%`, height: '100%', background: r.assetColor }} />
                          </div>
                          <strong style={{ color: 'var(--gc-text-1)', minWidth: 60, textAlign: 'right' }}>
                            {fmtMoney(r.totalRevenue)}
                          </strong>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{fmtMiles(r.totalMiles)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{fmtMoney(r.totalDriverPay)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{fmtMoney(r.fuelEst)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums"
                        style={{ color: r.net >= 0 ? '#1e8e3e' : '#d93025', fontWeight: 600 }}>{fmtMoney(r.net)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums"
                        style={{ color: (r.marginPct ?? 0) >= 0 ? '#1e8e3e' : '#d93025', fontWeight: 600 }}>{fmtPct(r.marginPct)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{fmtRpm(r.rpm)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--gc-border)', background: 'var(--gc-surface-2)' }}>
                  <td className="px-4 py-2.5 font-bold" style={{ color: 'var(--gc-text-1)' }}>FLEET TOTAL</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fleetTotals.loadCount}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(fleetTotals.totalRevenue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fmtMiles(fleetTotals.totalMiles)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(fleetTotals.totalDriverPay)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(fleetTotals.fuelEst)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold"
                    style={{ color: fleetTotals.net >= 0 ? '#1e8e3e' : '#d93025' }}>{fmtMoney(fleetTotals.net)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold"
                    style={{ color: (fleetTotals.marginPct ?? 0) >= 0 ? '#1e8e3e' : '#d93025' }}>{fmtPct(fleetTotals.marginPct)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold" style={{ color: 'var(--gc-text-1)' }}>{fmtRpm(fleetTotals.rpm)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Footer note — attribution + math explainer */}
        <div className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--gc-text-3)' }}>
          Revenue + driver pay aggregated from loads whose pickup leg falls in this week. Miles include both loaded miles
          (routed when available) and attributed deadhead from ELD movements linked to those loads. Fuel (est) = total
          miles × your $/mi rate (saved to your browser, edit anytime). Net = revenue − driver pay − fuel (est). Margin =
          net ÷ revenue. RPM = revenue ÷ total miles. Click any truck row to see the per-day breakdown on its timeline.
        </div>
      </div>
    </AppShell>
  );
}

function Th({ label, sortKey, sort, onSort, align }: {
  label:   string;
  sortKey: SortKey;
  sort:    { sortKey: SortKey; sortDir: 'asc' | 'desc' };
  onSort:  (k: SortKey) => void;
  align:   'left' | 'right';
}) {
  const isActive = sort.sortKey === sortKey;
  return (
    <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wide cursor-pointer select-none transition-colors"
      style={{ color: isActive ? 'var(--gc-text-1)' : 'var(--gc-text-3)', textAlign: align }}
      onClick={() => onSort(sortKey)}>
      <span className="inline-flex items-center gap-1" style={{ flexDirection: align === 'right' ? 'row-reverse' : 'row' }}>
        {label}
        <ArrowUpDown size={10} style={{ opacity: isActive ? 1 : 0.35 }} />
      </span>
    </th>
  );
}

function KpiTile({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className="rounded-xl px-4 py-3"
      style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-[20px] font-semibold tabular-nums mt-0.5" style={{ color: accent ?? 'var(--gc-text-1)' }}>{value}</div>
      {sub && <div className="text-[10px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{sub}</div>}
    </div>
  );
}
