'use client';

/**
 * Asset performance comparison — table of per-truck metrics over the
 * chosen window. Click any column header to sort. Click an asset row
 * to deep-link into its /timeline?assetId=… page.
 *
 * A bar-chart strip above the table re-renders against whatever metric
 * the table is currently sorted by — gives a quick visual ranking.
 *
 * Data: GET /v1/fleet/performance. Reuses the timeline page's
 * inbound-attribution pipeline (each load attributed to its start day,
 * every movement bucketed into either its load's attribution or the
 * yard / unattributed pile).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Truck, ChevronDown, ChevronUp, ArrowUpDown, Users } from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import {
  type Period,
  getPeriodRange,
  currentWeekStartISO,
  defaultCustomRangeISO,
} from '@/lib/periodRange';
import { railway, type FleetAssetPerformance } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';

// ── Column definitions ──────────────────────────────────────────────

interface ColumnDef {
  key:          ColumnKey;
  label:        string;
  /** Tooltip explaining what the metric measures. */
  help:         string;
  /** Right-aligned numeric vs left-aligned text. */
  align:        'left' | 'right';
  /** How to render a cell value. */
  fmt:          (a: FleetAssetPerformance) => string;
  /** Raw number used for sorting + bar chart. null → no data. */
  num:          (a: FleetAssetPerformance) => number | null;
  /** "Higher is better" for the bar chart color. */
  higherBetter: boolean;
}

type ColumnKey =
  | 'name' | 'totalRevenue' | 'loadCount' | 'loadedMiles' | 'inboundDhMiles'
  | 'totalMiles' | 'dayRpm' | 'dayRpmTotal' | 'deadheadPctOfDay'
  | 'avgRevPerLoad' | 'avgLoadedMilesPerLoad' | 'driverPayPct'
  | 'utilization' | 'activeDays' | 'totalDriverPay' | 'netToTruck' | 'netPerMile';

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
function fmtRpm(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}/mi`;
}
function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(0)}%`;
}
function fmtMi(n: number): string {
  return `${n.toFixed(0)}mi`;
}
function fmtMiFixed(n: number, dp = 1): string {
  return `${n.toFixed(dp)}mi`;
}
function fmtNum(n: number | null, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

const COLUMNS: ColumnDef[] = [
  { key: 'name',           label: 'Truck',         help: 'Asset name + unit',
    align: 'left',  fmt: (a) => a.unit ? `${a.name} · #${a.unit}` : a.name,
    num: () => null, higherBetter: true },
  { key: 'totalRevenue',   label: 'Revenue',       help: 'Sum of load prices for loads PICKED UP in this window',
    align: 'right', fmt: (a) => fmtMoney(a.totalRevenue),
    num: (a) => a.totalRevenue, higherBetter: true },
  { key: 'loadCount',      label: 'Loads',         help: 'Count of loads picked up in the window',
    align: 'right', fmt: (a) => String(a.loadCount),
    num: (a) => a.loadCount, higherBetter: true },
  { key: 'loadedMiles',    label: 'Loaded mi',     help: 'Sum of movement miles attributed to loaded driving',
    align: 'right', fmt: (a) => fmtMi(a.loadedMiles),
    num: (a) => a.loadedMiles, higherBetter: true },
  { key: 'inboundDhMiles', label: 'Inbound DH',    help: 'Empty miles repositioning TO a load',
    align: 'right', fmt: (a) => fmtMi(a.inboundDhMiles),
    num: (a) => a.inboundDhMiles, higherBetter: false },
  { key: 'totalMiles',     label: 'Total mi',      help: 'All miles driven by this truck in the window',
    align: 'right', fmt: (a) => fmtMi(a.totalMiles),
    num: (a) => a.totalMiles, higherBetter: true },
  { key: 'dayRpm',         label: 'RPM (attr)',    help: 'Revenue per ATTRIBUTED mile (loaded + inbound DH only)',
    align: 'right', fmt: (a) => fmtRpm(a.dayRpm),
    num: (a) => a.dayRpm, higherBetter: true },
  { key: 'dayRpmTotal',    label: 'RPM (total)',   help: 'Revenue per TOTAL mile — the honest number that punishes yard noise',
    align: 'right', fmt: (a) => fmtRpm(a.dayRpmTotal),
    num: (a) => a.dayRpmTotal, higherBetter: true },
  { key: 'deadheadPctOfDay', label: 'DH %',        help: '(Inbound DH + yard return) / total miles',
    align: 'right', fmt: (a) => fmtPct(a.deadheadPctOfDay),
    num: (a) => a.deadheadPctOfDay, higherBetter: false },
  { key: 'avgRevPerLoad',  label: 'Avg $/load',    help: 'Average revenue per load (broker mix quality)',
    align: 'right', fmt: (a) => a.avgRevPerLoad != null ? fmtMoney(a.avgRevPerLoad) : '—',
    num: (a) => a.avgRevPerLoad, higherBetter: true },
  { key: 'avgLoadedMilesPerLoad', label: 'Avg mi/load', help: 'Average loaded miles per load — long-haul vs local mix',
    align: 'right', fmt: (a) => a.avgLoadedMilesPerLoad != null ? fmtMiFixed(a.avgLoadedMilesPerLoad, 0) : '—',
    num: (a) => a.avgLoadedMilesPerLoad, higherBetter: true },
  { key: 'utilization',    label: 'Util %',        help: 'Attributed miles / total miles — inverse of "wasted miles"',
    align: 'right', fmt: (a) => fmtPct(a.utilization),
    num: (a) => a.utilization, higherBetter: true },
  { key: 'activeDays',     label: 'Active days',   help: 'Distinct days the truck moved at all (org TZ)',
    align: 'right', fmt: (a) => String(a.activeDays),
    num: (a) => a.activeDays, higherBetter: true },
  { key: 'totalDriverPay', label: 'Driver pay',    help: 'Sum of event.driver_pay for loads in the window',
    align: 'right', fmt: (a) => fmtMoney(a.totalDriverPay),
    num: (a) => a.totalDriverPay, higherBetter: false },
  { key: 'driverPayPct',   label: 'Pay %',         help: 'Driver pay / revenue',
    align: 'right', fmt: (a) => fmtPct(a.driverPayPct),
    num: (a) => a.driverPayPct, higherBetter: false },
  { key: 'netToTruck',     label: 'Net to truck',  help: 'Revenue − driver pay (before fuel + maintenance)',
    align: 'right', fmt: (a) => fmtMoney(a.netToTruck),
    num: (a) => a.netToTruck, higherBetter: true },
  { key: 'netPerMile',     label: 'Net/mi',        help: 'Net to truck / total miles',
    align: 'right', fmt: (a) => fmtRpm(a.netPerMile),
    num: (a) => a.netPerMile, higherBetter: true },
];

// ── Component ──────────────────────────────────────────────────────

export default function AssetPerformanceView() {
  const router = useRouter();
  const { calendarTimezone } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';

  // Period state — same pattern as the dashboard.
  const [period, setPeriod] = useState<Period>('week');
  const initialCustom = useMemo(() => defaultCustomRangeISO(), []);
  const [customStart, setCustomStart] = useState<string>(initialCustom.start);
  const [customEnd, setCustomEnd]     = useState<string>(initialCustom.end);
  const [weekStart, setWeekStart]     = useState<string>(() => currentWeekStartISO());

  const range = useMemo(
    () => getPeriodRange(period, { startISO: customStart, endISO: customEnd, weekStartISO: weekStart }),
    [period, customStart, customEnd, weekStart],
  );
  const fromISO = useMemo(() => isoLocal(range.start), [range.start]);
  const toISO   = useMemo(() => isoLocal(range.end),   [range.end]);

  const [rows, setRows]     = useState<FleetAssetPerformance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.getFleetPerformance(fromISO, toISO, tz)
      .then((res) => { if (!cancelled) { setRows(res.assets); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [fromISO, toISO, tz]);

  // Sort state.
  const [sortKey, setSortKey] = useState<ColumnKey>('totalRevenue');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const onSort = useCallback((key: ColumnKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      // Default direction: higher-better metrics sort desc first (top
      // performer floats up), lower-better sort asc first (best = lowest).
      const col = COLUMNS.find((c) => c.key === key);
      setSortDir(col?.higherBetter === false ? 'asc' : 'desc');
      return key;
    });
  }, []);

  const sortedRows = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (!col) return rows;
    const copy = [...rows];
    if (sortKey === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      copy.sort((a, b) => {
        const av = col.num(a);
        const bv = col.num(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
    }
    if (sortDir === 'desc') copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir]);

  const activeCol = COLUMNS.find((c) => c.key === sortKey) ?? COLUMNS[1];

  return (
    <AppShell title="Performance" icon={Truck}>
      <div className="max-w-[1800px] mx-auto px-6 py-4">
        {/* Header row */}
        <div className="flex items-start justify-between mb-4 gap-4">
          <div>
            <h1 className="text-[24px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>
              Asset performance
            </h1>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              Compare trucks on revenue, RPM, deadhead %, and more · inbound attribution
              · click a row to open the truck&rsquo;s timeline
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/drivers"
              className="text-[12px] font-semibold flex items-center gap-1.5 px-3 py-1.5 rounded"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}
            >
              <Users size={14} /> Drivers view
            </Link>
            <PeriodSelector
              period={period}
              onPeriodChange={setPeriod}
              customStart={customStart}
              customEnd={customEnd}
              onCustomStartChange={setCustomStart}
              onCustomEndChange={setCustomEnd}
              weekStart={weekStart}
              onWeekStartChange={setWeekStart}
            />
          </div>
        </div>

        {loading ? (
          <div className="py-20 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            Loading…
          </div>
        ) : error ? (
          <div className="py-20 text-center text-sm" style={{ color: 'var(--gc-red)' }}>
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-20 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            No trucks to compare.
          </div>
        ) : (
          <>
            <RankingStrip rows={sortedRows} column={activeCol} sortDir={sortDir} />

            {/* Sortable table */}
            <div
              className="rounded-lg overflow-x-auto"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}
            >
              <table className="w-full text-[12px]" style={{ tableLayout: 'auto' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
                    {COLUMNS.map((c) => {
                      const active = c.key === sortKey;
                      return (
                        <th
                          key={c.key}
                          onClick={() => onSort(c.key)}
                          className="px-2.5 py-2 cursor-pointer select-none uppercase tracking-wider font-semibold"
                          style={{
                            textAlign: c.align === 'right' ? 'right' : 'left',
                            color: active ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                            fontSize: 10,
                            whiteSpace: 'nowrap',
                          }}
                          title={c.help}
                        >
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {active
                              ? (sortDir === 'desc' ? <ChevronDown size={11} /> : <ChevronUp size={11} />)
                              : <ArrowUpDown size={10} style={{ opacity: 0.3 }} />}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((a) => (
                    <tr
                      key={a.assetId}
                      onClick={() => router.push(`/timeline?assetId=${a.assetId}`)}
                      className="cursor-pointer transition-colors hover:bg-black/[0.02]"
                      style={{ borderTop: '1px solid var(--gc-border)' }}
                    >
                      {COLUMNS.map((c) => {
                        const isName = c.key === 'name';
                        return (
                          <td
                            key={c.key}
                            className="px-2.5 py-2 tabular-nums"
                            style={{
                              textAlign: c.align === 'right' ? 'right' : 'left',
                              color: 'var(--gc-text-1)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {isName ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ background: a.color }} />
                                <span className="font-semibold">{c.fmt(a)}</span>
                              </span>
                            ) : (
                              c.fmt(a)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

// ── Bar-chart strip ────────────────────────────────────────────────

function RankingStrip({
  rows, column, sortDir,
}: {
  rows:    FleetAssetPerformance[];
  column:  ColumnDef;
  sortDir: 'asc' | 'desc';
}) {
  // No meaningful chart for the Truck name column.
  if (column.key === 'name') return null;

  const values = rows.map((r) => ({ row: r, v: column.num(r) ?? 0 }));
  const max = Math.max(0, ...values.map((x) => x.v));
  const min = Math.min(0, ...values.map((x) => x.v));
  // Normalize to [0, 1] for bar width. If all values <= 0, show empty bars.
  const range = max - min;

  return (
    <div className="mb-4 rounded-lg p-3"
      style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold uppercase tracking-wider text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
          Ranked by {column.label}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
          · {sortDir === 'desc' ? 'best first' : 'worst first'}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {values.map(({ row, v }, idx) => {
          const widthPct = range > 0 ? Math.max(2, ((v - min) / range) * 100) : 2;
          // Use the asset color for bars; muted when the metric is
          // "lower is better" so a long bar reads negative.
          const positive = column.higherBetter ? idx < rows.length / 2 : idx >= rows.length / 2;
          const barColor = positive ? row.color : `${row.color}66`;
          return (
            <div key={row.assetId} className="flex items-center gap-2">
              <span className="w-[140px] flex-shrink-0 text-[11px] font-semibold truncate"
                style={{ color: 'var(--gc-text-2)' }}>
                {row.name}{row.unit ? ` · #${row.unit}` : ''}
              </span>
              <div className="flex-1 relative" style={{ height: 16 }}>
                <div
                  className="absolute left-0 top-0 bottom-0 rounded"
                  style={{ width: `${widthPct}%`, background: barColor }}
                />
              </div>
              <span className="w-[100px] flex-shrink-0 text-right text-[11px] tabular-nums font-semibold"
                style={{ color: 'var(--gc-text-1)' }}>
                {column.fmt(row)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
