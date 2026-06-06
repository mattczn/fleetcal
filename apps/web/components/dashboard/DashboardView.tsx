'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import {
  TrendingUp, Truck, CheckCircle2, DollarSign,
  BarChart2, AlertCircle, Loader2,
  Wallet, Fuel, Route, Gauge,
} from 'lucide-react';
import { fetchWithRetry } from '@/lib/fetchWithRetry';
import { parseNaiveIsoInTz } from '@/lib/time-utils';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import DataLoader from '@/components/DataLoader';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import AppShell from '@/components/nav/AppShell';
import { relayLegShare } from '@/lib/legMiles';
import { isActiveInRange, dateKeyOf } from '@/lib/lifecycle';
import { type Period, PERIODS, getPeriodRange, currentWeekStartISO } from '@/lib/periodRange';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import LoadsReport from '@/components/dashboard/LoadsReport';
import type { CalendarEvent } from '@/lib/types';
import type { LoadSummary } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';

// ─── Types ───────────────────────────────────────────────────────────────────

type WeekSortField = 'pickupDate' | 'loadNum' | 'broker' | 'title' | 'driver' | 'loadPrice' | 'driverPay' | 'accessorials';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function billableAcc(e: CalendarEvent): number {
  return (e.accessorials ?? []).filter(a => a.billable).reduce((s, a) => s + a.amount, 0);
}

// Revenue accessor: prefer server-computed total_billable (linehaul +
// billable accessorials, maintained by the loads_compute_total_billable
// trigger). Falls back to loadPrice for legacy rows. Used everywhere the
// dashboard sums revenue so Gross Revenue, broker breakouts, weekly bars,
// and KPI tiles all include accessorials consistently.
function eventRevenue(e: CalendarEvent): number {
  return e.totalBillable ?? e.loadPrice ?? 0;
}

// Round up to a clean chart ceiling (1, 2, 4, 5, or 10 × 10^n)
function niceRound(v: number): number {
  if (v <= 0) return 1000;
  const exp  = Math.floor(Math.log10(v));
  const mag  = Math.pow(10, exp);
  const norm = v / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 4 ? 4 : norm <= 5 ? 5 : 10) * mag;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtFull(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

/** "12,345 mi" — period mileage formatter. Whole miles; locale-grouped
 *  thousands so the value is glanceable on the KPI tile. */
function fmtMiles(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} mi`;
}

function parseEventDate(start: string): Date {
  const [y, m, d] = start.split('T')[0].split('-').map(Number);
  return new Date(y, m - 1, d);
}

const STATUS_CFG = {
  scheduled: { label: 'Scheduled', color: '#9aa0a6' },
  en_route:  { label: 'En Route',  color: '#1a73e8' },
  picked_up: { label: 'Picked Up', color: '#f9ab00' },
  delivered: { label: 'Delivered', color: '#1e8e3e' },
  cancelled: { label: 'Cancelled', color: '#ea4335' },
} as const;

const BROKER_COLORS = [
  '#1a73e8', '#34a853', '#ea4335', '#fbbc04', '#9334e6',
  '#00acc1', '#e67c00', '#e52592', '#137333', '#80868b',
];

// ─── SVG Pie / Donut chart ────────────────────────────────────────────────────

interface PieSlice { value: number; color: string; label: string }

function PieChart({ slices, size = 160, showLabels = false }: { slices: PieSlice[]; size?: number; showLabels?: boolean }) {
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  if (total === 0) return null;

  const [hovered, setHovered] = useState<number | null>(null);

  const cx = size / 2, cy = size / 2;
  const R  = size * 0.42;
  const ri = size * 0.24;
  const labelR = R + size * 0.13;
  const GAP = slices.length > 1 ? 0.018 : 0;

  let cursor = -Math.PI / 2;
  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const hoveredSlice = hovered !== null ? slices[hovered] : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block', overflow: 'visible' }}>
      {slices.length === 1 ? (
        <>
          <circle cx={cx} cy={cy} r={R} fill={slices[0].color} />
          <circle cx={cx} cy={cy} r={ri} fill="var(--gc-surface)" />
        </>
      ) : (
        slices.map((slice, i) => {
          const fraction = slice.value / total;
          const sweep    = fraction * 2 * Math.PI - GAP;
          const start    = cursor + GAP / 2;
          const end      = start + sweep;
          const mid      = start + sweep / 2;
          cursor        += fraction * 2 * Math.PI;

          const x1 = cx + R  * Math.cos(start), y1 = cy + R  * Math.sin(start);
          const x2 = cx + R  * Math.cos(end),   y2 = cy + R  * Math.sin(end);
          const x3 = cx + ri * Math.cos(end),   y3 = cy + ri * Math.sin(end);
          const x4 = cx + ri * Math.cos(start), y4 = cy + ri * Math.sin(start);
          const large = sweep > Math.PI ? 1 : 0;
          const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${ri} ${ri} 0 ${large} 0 ${x4} ${y4} Z`;

          const lx  = cx + labelR * Math.cos(mid);
          const ly  = cy + labelR * Math.sin(mid);
          const fraction100 = Math.round(fraction * 100);
          const isHovered = hovered === i;

          return (
            <g key={i}>
              <path d={d} fill={slice.color}
                style={{ transition: 'opacity 120ms', opacity: hovered !== null && !isHovered ? 0.45 : 1, cursor: 'pointer' }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
              {showLabels && fraction100 >= 10 && (
                <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                  fontSize={size * 0.065} fontWeight="700" fill={slice.color}
                  style={{ pointerEvents: 'none' }}>
                  {slice.label.length > 12 ? slice.label.slice(0, 11) + '…' : slice.label}
                </text>
              )}
            </g>
          );
        })
      )}

      {/* Center hole label — shows on hover */}
      {hoveredSlice ? (
        <>
          <text x={cx} y={cy - size * 0.055} textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.072} fontWeight="700" style={{ pointerEvents: 'none' }}
            fill={hoveredSlice.color}>
            {hoveredSlice.label.length > 14 ? hoveredSlice.label.slice(0, 13) + '…' : hoveredSlice.label}
          </text>
          <text x={cx} y={cy + size * 0.1} textAnchor="middle" dominantBaseline="central"
            fontSize={size * 0.062} fontWeight="600" style={{ pointerEvents: 'none' }}
            fill="var(--gc-text-2)">
            {moneyFmt.format(hoveredSlice.value)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--gc-surface)',
        borderRadius: 12,
        border: '1px solid var(--gc-border)',
        padding: 20,
      }}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--gc-text-1)' }}>
      {children}
    </h2>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-sm" style={{ color: 'var(--gc-text-3)' }}>
      {label}
    </div>
  );
}

/**
 * Cost-breakdown bar — horizontal stacked bar where the FULL width
 * represents period revenue and each segment shows a major cost
 * bucket eating into it. Whatever's left at the right side is
 * margin. Hover a segment to see the dollar / % detail.
 *
 * If costs exceed revenue (negative margin), segments are scaled to
 * sum to 100% width — the bar still fills — but the margin segment
 * collapses to 0px and its legend row turns red with the deficit.
 */
function CostBar({
  revenue, segments,
}: {
  revenue: number;
  segments: Array<{ label: string; amount: number; color: string }>;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const totalCost = segments.reduce((s, x) => s + x.amount, 0);
  const margin    = revenue - totalCost;
  const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
  const negative  = margin < 0;

  // Scale: when costs exceed revenue we'd overflow 100%. Clamp so the
  // bar still renders cleanly inside the card. Honest figures live in
  // the legend below.
  const totalForScale = Math.max(revenue, totalCost);
  const widthOf = (amount: number) => (totalForScale > 0 ? (amount / totalForScale) * 100 : 0);

  const marginSeg = {
    label: negative ? 'Deficit' : 'Margin',
    amount: margin,
    color:  negative ? '#c5221f' : '#1e8e3e',
  };
  const allSegs = [...segments, marginSeg];

  return (
    <div>
      <div
        className="relative h-12 flex rounded-md overflow-hidden"
        style={{ border: '1px solid var(--gc-border)' }}
      >
        {allSegs.map((s, i) => {
          const w = widthOf(Math.max(0, s.amount));
          if (w <= 0) return null;
          const pct = revenue > 0 ? (s.amount / revenue) * 100 : 0;
          return (
            <div
              key={s.label}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{
                width: `${w}%`,
                backgroundColor: s.color,
                opacity: hovered != null && hovered !== i ? 0.55 : 1,
                transition: 'opacity 150ms',
                cursor: 'pointer',
              }}
              className="flex items-center justify-center text-white text-[11px] font-semibold tracking-wide"
              title={`${s.label}: ${fmtFull(s.amount)} (${pct.toFixed(1)}% of revenue)`}
            >
              {w >= 10 ? (
                <span className="px-2 truncate">
                  {s.label} · {pct.toFixed(0)}%
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Legend / detail row — switches between summary and the
          currently-hovered segment's detail. */}
      {hovered != null && allSegs[hovered] ? (
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <span
            className="inline-block rounded-sm"
            style={{ width: 12, height: 12, backgroundColor: allSegs[hovered].color }}
          />
          <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            {allSegs[hovered].label}
          </span>
          <span style={{ color: 'var(--gc-text-1)' }}>
            {fmtFull(allSegs[hovered].amount)}
          </span>
          <span style={{ color: 'var(--gc-text-3)' }}>
            ({revenue > 0 ? ((allSegs[hovered].amount / revenue) * 100).toFixed(1) : '0.0'}% of revenue)
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-[12px]">
          {allSegs.map((s) => {
            const pct = revenue > 0 ? (s.amount / revenue) * 100 : 0;
            const isMarginRow = s.label === 'Margin' || s.label === 'Deficit';
            return (
              <div key={s.label} className="flex items-center gap-1.5">
                <span
                  className="inline-block rounded-sm"
                  style={{ width: 10, height: 10, backgroundColor: s.color }}
                />
                <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                  {s.label}
                </span>
                <span style={{ color: isMarginRow && negative ? '#c5221f' : 'var(--gc-text-2)' }}>
                  {fmtFull(s.amount)} ({pct.toFixed(1)}%)
                </span>
              </div>
            );
          })}
          {revenue > 0 ? (
            <div className="ml-auto text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Total revenue: <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtFull(revenue)}</span>
              {' · '}
              <span style={{ color: negative ? '#c5221f' : '#1e8e3e' }}>
                {negative ? '−' : ''}{Math.abs(marginPct).toFixed(1)}% margin
              </span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function KpiCard({
  label, value, sub, icon, accent, badge, loading,
}: {
  label: string; value: string; sub: string;
  icon: React.ReactNode; accent: string;
  /** Optional status pill rendered next to the value — used by the
   *  payroll tile to signal whether the period's weeks are finalized,
   *  partial, or still pending. */
  badge?: { text: string; color: string };
  /** When true, replaces the value + sub line with shimmer placeholders
   *  so the user sees the tile is still gathering data rather than
   *  reading a stale "—" or partial value. Each tile decides its own
   *  loading state based on whichever async fetch backs it (most use
   *  loadSummaries, a few have their own sources). */
  loading?: boolean;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between mb-3">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--gc-text-3)' }}
        >
          {label}
        </span>
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
          style={{ background: accent + '1a', color: accent }}
        >
          {icon}
        </div>
      </div>
      {loading ? (
        <>
          <div
            className="mb-2 rounded"
            style={{
              height: 26, width: '60%',
              background: 'linear-gradient(90deg, var(--gc-hover) 0%, var(--gc-border-light) 50%, var(--gc-hover) 100%)',
              backgroundSize: '200% 100%',
              animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
            }}
          />
          <div
            className="rounded"
            style={{
              height: 12, width: '80%',
              background: 'linear-gradient(90deg, var(--gc-hover) 0%, var(--gc-border-light) 50%, var(--gc-hover) 100%)',
              backgroundSize: '200% 100%',
              animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
              animationDelay: '0.2s',
            }}
          />
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="text-[26px] font-semibold leading-none" style={{ color: 'var(--gc-text-1)' }}>
              {value}
            </span>
            {badge ? (
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: badge.color + '22', color: badge.color }}
              >
                {badge.text}
              </span>
            ) : null}
          </div>
          <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{sub}</div>
        </>
      )}
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DashboardView() {
  const { events, assets, loadedStart, loadedEnd, dbReady, extendLoadedRange, unassignedAssetId, customers, openEditModal, calendarTimezone } = useCalendarStore();
  const { organization } = useOrganization();
  // Driver-pay visibility — gates the export's Driver Pay column.
  // Dispatcher and Maintenance never see what we paid drivers.
  const { can } = usePermissions();
  const canViewDriverPay = can('loads.view_driver_pay');
  // Module gates for KPI tiles + overlays. MVP orgs end up with
  // exactly four KPIs (revenue, avg/truck, payroll, avg/load); the
  // volume + fuel tiles fall away with their respective modules.
  const { enabled: moduleEnabled } = useModules();
  const showPayrollKpi = moduleEnabled('payroll');
  const showFuelKpi    = moduleEnabled('fuel');
  const showVolumeKpis = moduleEnabled('performance');
  const showEldMiles   = moduleEnabled('motive_integration');
  // Top-level view toggle: "Performance" (existing revenue/loads KPIs)
  // vs "Fuel" (new spend/gallons/MPG KPIs). Both share the period
  // picker + date range so flipping views feels like changing lenses
  // on the same window of activity, not a separate page.
  // 'performance' is now the only view — the fuel sub-dashboard
  // moved to /equipment > Fuel where it sits above the unified fuel
  // table. Keep the literal in place so the deeper dashboard JSX
  // (currently gated on view === 'performance') stays valid without
  // a sweeping refactor.
  const view = 'performance' as const;
  // Default to the current payroll week (Sat → Fri) — same window the
  // Payroll page and the Revenue Breakdown bar use for "right now" so
  // the first thing a dispatcher sees on /dashboard agrees with what
  // they'd see on /payroll without changing the period.
  const [period, setPeriod] = useState<Period>('week');
  const [fetching, setFetching] = useState(false);
  const [weekSort, setWeekSort] = useState<{ field: WeekSortField; dir: 'asc' | 'desc' }>({ field: 'pickupDate', dir: 'asc' });
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);

  // Custom range — stored as YYYY-MM-DD strings to play nice with native
  // date inputs and avoid the UTC parsing trap. Default to "this month".
  const initialMonthRange = useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const fmtIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmtIso(start), end: fmtIso(end) };
  }, []);
  const [customStart, setCustomStart] = useState<string>(initialMonthRange.start);
  const [customEnd,   setCustomEnd]   = useState<string>(initialMonthRange.end);
  // weekStart drives the started-weeks dropdown when period === 'week'.
  // Seeded with the current week's Saturday so the dashboard lands on
  // "This week" by default.
  const [weekStart,   setWeekStart]   = useState<string>(() => currentWeekStartISO());

  const { start: pStart, end: pEnd } = useMemo(
    () => getPeriodRange(period, { startISO: customStart, endISO: customEnd, weekStartISO: weekStart }),
    [period, customStart, customEnd, weekStart],
  );

  // Period boundaries in every flavor the various API endpoints need.
  //
  // - reports.ts (loadSummaries) string-compares pickupFrom/To
  //   against pickupAt, which is stored as a **naive** org-local
  //   string ("2026-05-30T01:00:00", no offset). To make the
  //   lexicographic comparison meaningful, we send naive strings
  //   too — anchored to the same wall-clock as the stored value.
  //   Sending a Z-suffixed UTC ISO was the wrong shape (a UTC
  //   string and a naive string have different lexical ordering
  //   for the same wall-clock moment).
  //
  // - fuel-transactions / payroll-records take date-only filters
  //   ("YYYY-MM-DD"). Same date keys; no TZ math involved.
  //
  // - movements.odometer-summary compares `captured_at` (a real
  //   timestamptz column) so it needs a UTC ISO anchored to the
  //   org's wall-clock at the boundary moment.
  const periodIso = useMemo(() => {
    const fromKey = dateKeyOf(pStart);
    const toKey   = dateKeyOf(pEnd);
    return {
      // Naive org-local ISO ("YYYY-MM-DDTHH:mm:ss.SSS", no offset)
      // for naive string-compare endpoints.
      fromNaive: `${fromKey}T00:00:00.000`,
      toNaive:   `${toKey}T23:59:59.999`,
      // UTC ISO anchored to the org's wall-clock — for endpoints
      // that compare real timestamps.
      fromUtc:   new Date(parseNaiveIsoInTz(`${fromKey}T00:00:00`,   calendarTimezone)).toISOString(),
      toUtc:     new Date(parseNaiveIsoInTz(`${toKey}T23:59:59.999`, calendarTimezone)).toISOString(),
      // Date-only for endpoints with `date` columns.
      fromDate:  fromKey,
      toDate:    toKey,
    };
  }, [pStart, pEnd, calendarTimezone]);

  // Extend the loaded window whenever the selected period reaches beyond what's cached
  useEffect(() => {
    if (!dbReady) return;
    const startIso = pStart.toISOString();
    const endIso   = pEnd.toISOString();
    if (loadedStart && loadedEnd && startIso >= loadedStart && endIso <= loadedEnd) return;
    setFetching(true);
    extendLoadedRange(startIso, endIso).finally(() => setFetching(false));
  }, [period, dbReady, pStart, pEnd, loadedStart, loadedEnd, extendLoadedRange]);

  // Load-shaped data sourced from /v1/reports/loads. One row per load
  // (relays collapsed server-side), filtered by pickup date in the
  // user's local timezone. This is the source of truth for every KPI
  // card — matches LoadsReport exactly, no client-side dedupe needed.
  // The events-store-driven `deduped` array below still powers charts;
  // both arrive at the same numbers because both are load-deduped.
  const [loadSummaries, setLoadSummaries] = useState<LoadSummary[] | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // pickupAt on the server is a NAIVE org-local string and the
        // filter is a lexicographic compare — send naive strings.
        const { loads } = await railway.listLoadSummaries({
          pickupFrom: periodIso.fromNaive,
          pickupTo:   periodIso.toNaive,
          // Explicit large limit so we always get the full set even
          // against an older API build that still defaults to 1000.
          // The server now returns everything when limit is omitted,
          // but this is belt-and-suspenders during the rolling deploy.
          limit:      '10000',
        });
        if (!cancelled) setLoadSummaries(loads);
      } catch (err) {
        console.error('[DashboardView] listLoadSummaries failed:', err);
        if (!cancelled) setLoadSummaries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, periodIso]);

  // ── Fuel spend (period total) ─────────────────────────────────────────
  //
  // Sourced from /v1/fuel-transactions, filtered by transaction_date in
  // the period. Mirrors the equipment-fuel-tab fetch pattern: dates as
  // YYYY-MM-DD (no time portion — Mudflap receipts are date-only) and
  // a generous limit since this is a sum, not a paged display.
  const [fuelSpend, setFuelSpend] = useState<number | null>(null);
  // Per-asset fuel totals — feeds the Revenue by Asset cost overlay.
  // Built from the same transaction fetch so we don't double-call the API.
  const [fuelByAsset, setFuelByAsset] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // Date-only filter for the API; use the org-anchored dates so
        // a 1am Sat CT load doesn't bleed into Friday's period.
        const { fuelTransactions } = await fetchWithRetry(
          () => railway.listFuelTransactions({ from: periodIso.fromDate, to: periodIso.toDate, limit: 5000 }),
        );
        if (cancelled) return;
        const sum = fuelTransactions.reduce((s, t) => s + (t.totalCharged ?? 0), 0);
        const byAsset = new Map<number, number>();
        for (const t of fuelTransactions) {
          if (t.assetId == null) continue;
          byAsset.set(t.assetId, (byAsset.get(t.assetId) ?? 0) + (t.totalCharged ?? 0));
        }
        setFuelSpend(sum);
        setFuelByAsset(byAsset);
      } catch (err) {
        console.error('[DashboardView] listFuelTransactions failed:', err);
        if (!cancelled) { setFuelSpend(0); setFuelByAsset(new Map()); }
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, periodIso]);

  // ── Payroll (finalized records, with fallback to per-load pay) ────────
  //
  // Each payroll period is Saturday→Friday. A week W counts toward
  // the dashboard total iff its Friday (weekStart + 6 days) falls
  // within [pStart, pEnd].
  //
  // For each such week:
  //   • If any PayrollRecord exists for W on the server, use the sum
  //     of those records — finalized totals include adjustments
  //     (bonuses / deferrals).
  //   • Otherwise fall back to the per-load driver pay sum from
  //     loadSummaries — every leg whose pickup date falls inside W
  //     contributes its totalDriverPay. This lets the tile show a
  //     reasonable in-progress estimate before the dispatcher
  //     finalizes payroll for the week.
  //
  // The badge below the value reflects coverage:
  //   • Green "Finalized"  → every week's records exist.
  //   • Amber "Partial"    → some weeks finalized, others computed.
  //   • Gray  "Pending"    → no records exist; everything is from
  //                          load-summary fallback.
  const [payrollData, setPayrollData] = useState<{
    total:           number;
    finalizedWeeks:  number;
    totalWeeks:      number;
  } | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // dateKey form of the period bounds — used for Friday-in-range
        // detection. We pull them off periodIso so the week enumeration
        // stays aligned with the same anchored window every other
        // fetch uses.
        const periodStartKey = periodIso.fromDate;
        const periodEndKey   = periodIso.toDate;
        const shiftKey = (dateKey: string, days: number): string => {
          const d = new Date(`${dateKey}T12:00:00`); // noon = TZ-safe
          d.setDate(d.getDate() + days);
          return d.toISOString().slice(0, 10);
        };

        // Enumerate every Saturday whose Friday (Sat + 6 days) falls
        // within [pStart, pEnd]. For a single-week period there's
        // exactly one; for a quarter there are ~13.
        const weekStarts: string[] = [];
        const searchStart = shiftKey(periodStartKey, -6);
        const searchEnd   = shiftKey(periodEndKey,   -6);
        let cursor = searchStart;
        while (cursor <= searchEnd) {
          const d = new Date(`${cursor}T12:00:00`);
          if (d.getDay() === 6 /* Saturday */) weekStarts.push(cursor);
          cursor = shiftKey(cursor, 1);
        }

        if (weekStarts.length === 0) {
          if (!cancelled) setPayrollData({ total: 0, finalizedWeeks: 0, totalWeeks: 0 });
          return;
        }

        // Server-side range filter on weekStart. Belt-and-suspenders
        // Friday check happens later when we enumerate.
        const { records } = await fetchWithRetry(
          () => railway.listPayrollRecords({
            weekStartFrom: weekStarts[0],
            weekStartTo:   weekStarts[weekStarts.length - 1],
          }),
        );
        if (cancelled) return;

        // Sum finalized records by weekStart so we can resolve each
        // week independently.
        const finalizedByWeek = new Map<string, number>();
        for (const r of records) {
          finalizedByWeek.set(
            r.weekStart,
            (finalizedByWeek.get(r.weekStart) ?? 0) + (r.totalPay ?? 0),
          );
        }

        // Per-week resolution. If a week has any finalized records,
        // use that sum; otherwise fall back to load-summary driver
        // pay for loads whose pickup falls in [weekStart, weekStart+6].
        let total = 0;
        let finalizedCount = 0;
        for (const ws of weekStarts) {
          const finalizedSum = finalizedByWeek.get(ws);
          if (finalizedSum != null && finalizedSum > 0) {
            total += finalizedSum;
            finalizedCount++;
            continue;
          }
          const weekEnd = shiftKey(ws, 6);
          if (loadSummaries) {
            const weekSum = loadSummaries.reduce((s, l) => {
              const key = l.pickupAt?.slice(0, 10);
              if (!key) return s;
              if (key < ws || key > weekEnd) return s;
              return s + (l.totalDriverPay ?? 0);
            }, 0);
            total += weekSum;
          }
        }

        setPayrollData({
          total,
          finalizedWeeks: finalizedCount,
          totalWeeks:     weekStarts.length,
        });
      } catch (err) {
        console.error('[DashboardView] payroll fetch failed:', err);
        if (!cancelled) setPayrollData({ total: 0, finalizedWeeks: 0, totalWeeks: 0 });
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, periodIso, loadSummaries]);
  // Convenience selectors for the tile + cost-bar consumers.
  const payrollTotal = payrollData?.total ?? null;
  const payrollBadge: { text: string; color: string } | undefined = (() => {
    if (!payrollData || payrollData.totalWeeks === 0) return undefined;
    const { finalizedWeeks, totalWeeks } = payrollData;
    if (finalizedWeeks === 0)         return { text: 'Pending',   color: '#9aa0a6' };
    if (finalizedWeeks === totalWeeks) return { text: 'Finalized', color: '#1e8e3e' };
    return { text: `${finalizedWeeks}/${totalWeeks} finalized`, color: '#f9ab00' };
  })();
  const payrollSub = !payrollData
    ? 'loading…'
    : payrollData.totalWeeks === 0
      ? 'no payroll weeks in period'
      : payrollData.finalizedWeeks === payrollData.totalWeeks
        ? `${payrollData.totalWeeks} week${payrollData.totalWeeks !== 1 ? 's' : ''} finalized`
        : payrollData.finalizedWeeks === 0
          ? `${payrollData.totalWeeks} week${payrollData.totalWeeks !== 1 ? 's' : ''} pending — estimate`
          : `${payrollData.finalizedWeeks} of ${payrollData.totalWeeks} weeks finalized`;

  // ── ELD miles (period total) ──────────────────────────────────────────
  //
  // Sourced from `/v1/movements/odometer-summary` — server-side
  // aggregate over motive_odometer_readings (daily snapshots),
  // computing `max - min` per asset that has motive_vehicle_id set.
  //
  // The previous version summed raw MovementCard.miles from
  // listMovements, which is the WRONG table for a fleet mileage
  // total — Motive fragments long trips into many sub-mile
  // driving_periods (one per traffic light / duty status change),
  // many with miles=null, which is why the tile under-counted
  // badly (e.g. 156 mi for a whole week of operation).
  const [eldMiles, setEldMiles] = useState<number | null>(null);
  useEffect(() => {
    if (!dbReady) return;
    let cancelled = false;
    (async () => {
      try {
        // captured_at is timestamptz — needs real UTC ISO.
        const { totalMiles } = await fetchWithRetry(
          () => railway.odometerSummary(periodIso.fromUtc, periodIso.toUtc),
        );
        if (cancelled) return;
        setEldMiles(totalMiles);
      } catch (err) {
        console.error('[DashboardView] odometerSummary failed:', err);
        if (!cancelled) setEldMiles(0);
      }
    })();
    return () => { cancelled = true; };
  }, [dbReady, periodIso]);

  // Filter to period — based on each event's start date; exclude placeholder unassigned asset
  const filtered = useMemo(
    () => events.filter(e => {
      if (unassignedAssetId !== null && e.assetId === unassignedAssetId) return false;
      const d = parseEventDate(e.start);
      return d >= pStart && d <= pEnd;
    }),
    [events, pStart, pEnd, unassignedAssetId],
  );

  // Deduplicate relay (split) loads so they are counted as ONE load.
  //
  // Both legs of a relay share the same loadPrice. Without this step, a relay
  // whose pickup AND delivery both fall in the period would be double-counted.
  //
  // Rule: keep the pickup leg when it is present in the filtered set; otherwise
  // keep the delivery leg (i.e. pickup was in a prior period, delivery is now).
  // Non-relay events pass through unchanged.
  const deduped = useMemo(() => {
    const pickupGroupIds = new Set(
      filtered
        .filter(e => e.relayGroupId && e.relayRole === 'pickup')
        .map(e => e.relayGroupId as string),
    );
    return filtered.filter(e => {
      if (!e.relayGroupId) return true;                          // normal load
      if (e.relayRole === 'pickup') return true;                  // keep pickup leg
      if (e.relayRole === 'delivery') return !pickupGroupIds.has(e.relayGroupId); // keep delivery only if pickup absent
      return true;                                               // relay without role — keep
    });
  }, [filtered]);

  // ── KPI summary (sourced from /v1/reports/loads — one row per load) ──
  //
  // While the report is still in flight, fall back to the events-store
  // `deduped` array so the cards show *something* during the initial
  // load instead of zeros. Once the report response arrives, KPIs lock
  // to the load-shaped data — the same source LoadsReport uses, so
  // numbers always agree.
  const kpis = useMemo(() => {
    if (loadSummaries) {
      // Revenue = total_billable (linehaul + billable accessorials).
      // Maintained server-side by the loads_compute_total_billable
      // trigger, so this matches the invoice snapshot and every
      // other revenue surface (closeout, accounting, performance).
      // Fall back to the inline math for any legacy row that lacks
      // total_billable.
      const revenue = loadSummaries.reduce((s, l) => {
        if (l.totalBillable != null) return s + l.totalBillable;
        const accessorials = (l.accessorials ?? [])
          .reduce((acc, a) => acc + (a.billable ? (a.amount ?? 0) : 0), 0);
        return s + (l.loadPrice ?? 0) + accessorials;
      }, 0);
      const loads   = loadSummaries.length;
      // Delivery side reflects the load's final state — the leg whose
      // status is "delivered" is the one that physically delivered.
      const delivered = loadSummaries.filter(l => l.deliveryStatus === 'delivered').length;
      // For relays, a load only counts as cancelled if BOTH legs are
      // cancelled; otherwise we treat the pickup status as the
      // active-side gate. Simplifying to pickup-side keeps behavior
      // identical to the legacy events-deduped path.
      const nonCancel    = loadSummaries.filter(l => l.pickupStatus !== 'cancelled').length;
      const delivRate    = nonCancel > 0 ? (delivered / nonCancel) * 100 : 0;
      const avgRevPerLoad = loads > 0 ? revenue / loads : 0;
      // Assets — union of pickup + delivery so a relay surfaces both
      // assets, not just the pickup leg's.
      const assetIds = new Set<number>();
      for (const l of loadSummaries) {
        assetIds.add(l.pickupAssetId);
        if (l.deliveryAssetId !== l.pickupAssetId) assetIds.add(l.deliveryAssetId);
      }
      const activeAssets   = assetIds.size;
      const avgRevPerAsset = activeAssets > 0 ? revenue / activeAssets : 0;
      // Total driver pay across every leg — each driver gets paid for
      // their leg, so summing legs is the correct "what did we pay
      // drivers this period" answer.
      const driverPay = loadSummaries.reduce((s, l) => s + (l.totalDriverPay ?? 0), 0);
      const miles     = loadSummaries.reduce((s, l) => s + (l.totalLoadedMiles ?? 0), 0);
      return { revenue, loads, delivered, delivRate, avgRevPerLoad, avgRevPerAsset, activeAssets, miles, driverPay };
    }
    // ─ Fallback while the load-shaped report is still in flight ─
    const revenue = deduped.reduce((s, e) => s + eventRevenue(e), 0);
    const loads   = deduped.length;
    const delivered  = deduped.filter(e => e.status === 'delivered').length;
    const nonCancel  = deduped.filter(e => e.status !== 'cancelled').length;
    const delivRate  = nonCancel > 0 ? (delivered / nonCancel) * 100 : 0;
    const avgRevPerLoad  = loads > 0 ? revenue / loads : 0;
    const activeAssets   = new Set(deduped.map(e => e.assetId)).size;
    const avgRevPerAsset = activeAssets > 0 ? revenue / activeAssets : 0;
    const miles      = 0;
    const driverPay  = filtered.reduce((s, e) => s + (e.driverPay ?? 0), 0);
    return { revenue, loads, delivered, delivRate, avgRevPerLoad, avgRevPerAsset, activeAssets, miles, driverPay };
  }, [loadSummaries, deduped, filtered]);

  // ── Revenue by asset ──────────────────────────────────────────────────
  // Relay (split) loads are prorated by haversine leg miles so each
  // asset gets credit for the work it actually did. Non-relay loads
  // attribute the full price to the single asset that ran them.
  // Falls back to a 50/50 split when one of the legs has no usable
  // geocoded stops.
  // Per-asset driver pay totals — sourced from loadSummaries (one entry
  // per load), splitting by leg. pickup_driver_pay goes to pickupAssetId,
  // delivery_driver_pay goes to deliveryAssetId. For non-relay loads
  // both fields point at the same asset so the totals work out the
  // same. Mirrors how the payroll backfill computed weekly totals.
  const payrollByAsset = useMemo(() => {
    const m = new Map<number, number>();
    if (!loadSummaries) return m;
    for (const l of loadSummaries) {
      if (l.pickupAssetId != null && l.pickupDriverPay != null) {
        m.set(l.pickupAssetId, (m.get(l.pickupAssetId) ?? 0) + l.pickupDriverPay);
      }
      if (l.deliveryAssetId != null && l.deliveryDriverPay != null && l.deliveryAssetId !== l.pickupAssetId) {
        m.set(l.deliveryAssetId, (m.get(l.deliveryAssetId) ?? 0) + l.deliveryDriverPay);
      }
    }
    return m;
  }, [loadSummaries]);

  // Cost-overlay visibility on the Revenue by Asset chart. Persisted in
  // localStorage so the dispatcher's preference survives reloads. Both
  // off by default so first-time users see the clean bar layout.
  const [showFuelOverlay, setShowFuelOverlay]       = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('dashboard.assetChart.showFuel') === '1';
  });
  const [showPayrollOverlay, setShowPayrollOverlay] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('dashboard.assetChart.showPayroll') === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('dashboard.assetChart.showFuel', showFuelOverlay ? '1' : '0');
  }, [showFuelOverlay]);
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('dashboard.assetChart.showPayroll', showPayrollOverlay ? '1' : '0');
  }, [showPayrollOverlay]);

  const revenueByAsset = useMemo(() => {
    // Index relay legs by group so we can find the partner cheaply.
    const partnerByGroup = new Map<string, CalendarEvent>();
    for (const e of filtered) {
      if (e.relayGroupId && e.relayRole) {
        partnerByGroup.set(`${e.relayGroupId}-${e.relayRole}`, e);
      }
    }

    // Only count assets that were active for AT LEAST ONE DAY during
    // the report period. Without this filter, retired trucks (sold,
    // scrapped, transferred) keep appearing in the per-asset list with
    // $0 — dragging down "average revenue per asset" math and making
    // the asset count meaningless for periods after retirement. Mirror
    // logic: an asset added partway through the period is included
    // from its activeFrom date forward, not as a zero-revenue
    // placeholder for the whole period.
    const periodStartKey = dateKeyOf(pStart);
    const periodEndKey   = dateKeyOf(pEnd);
    return assets
      .filter(asset =>
        asset.id !== unassignedAssetId &&
        asset.type !== 'Unassigned' &&
        asset.name !== 'Unassigned' &&
        isActiveInRange(asset, periodStartKey, periodEndKey),
      )
      .map(asset => {
        const ae = filtered.filter(e => e.assetId === asset.id);
        let revenue = 0;
        let loads   = 0;
        for (const e of ae) {
          if (!e.relayGroupId || !e.relayRole) {
            revenue += eventRevenue(e);
            loads += 1;
            continue;
          }
          const partner = partnerByGroup.get(
            `${e.relayGroupId}-${e.relayRole === 'pickup' ? 'delivery' : 'pickup'}`,
          );
          // Partner not in the filtered window — credit the leg's
          // straight-line proportion but use 0.5 if its miles also failed.
          const share = partner
            ? relayLegShare(e, partner)
            : 0.5;
          revenue += eventRevenue(e) * share;
          // Count relay legs as 0.5 of a load each so totals stay sane;
          // the dashboard "loads" KPI uses the dedup'd list separately.
          loads += 0.5;
        }
        const fuel    = fuelByAsset.get(asset.id) ?? 0;
        const payroll = payrollByAsset.get(asset.id) ?? 0;
        return {
          asset,
          revenue,
          loads,
          miles: 0,
          fuel,
          payroll,
          net: revenue - fuel - payroll,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }, [assets, filtered, unassignedAssetId, pStart, pEnd, fuelByAsset, payrollByAsset]);


  // ── Sortable weekly loads list ──
  const weekLoads = useMemo(() => {
    const rows = [...deduped];
    const { field, dir } = weekSort;
    const partnerOf = (e: CalendarEvent) => e.relayGroupId && e.relayRole
      ? relayPartnerMap.get(`${e.relayGroupId}-${e.relayRole === 'pickup' ? 'delivery' : 'pickup'}`)
      : undefined;
    rows.sort((a, b) => {
      let va: string | number, vb: string | number;
      switch (field) {
        case 'pickupDate': va = a.start;          vb = b.start;          break;
        case 'loadNum':    va = a.loadNum ?? '';  vb = b.loadNum ?? '';  break;
        case 'broker':     va = a.broker ?? '';   vb = b.broker ?? '';   break;
        case 'title':      va = a.title ?? '';    vb = b.title ?? '';    break;
        case 'driver':     va = a.driverName ?? ''; vb = b.driverName ?? ''; break;
        case 'loadPrice':  va = a.loadPrice ?? 0; vb = b.loadPrice ?? 0; break;
        case 'driverPay': {
          const pa = partnerOf(a); const pb = partnerOf(b);
          va = (a.driverPay ?? 0) + (pa?.driverPay ?? 0);
          vb = (b.driverPay ?? 0) + (pb?.driverPay ?? 0);
          break;
        }
        case 'accessorials': va = billableAcc(a); vb = billableAcc(b); break;
        default: va = ''; vb = '';
      }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [deduped, weekSort]);
  // Map relayGroupId → partner event (used to get the other leg's driver + pay in the table)
  const relayPartnerMap = useMemo(() => {
    const map = new Map<string, CalendarEvent>(); // "{groupId}-{role}" → event
    for (const e of events) {
      if (e.relayGroupId && e.relayRole) map.set(`${e.relayGroupId}-${e.relayRole}`, e);
    }
    return map;
  }, [events]);

  const maxAssetRev = Math.max(...revenueByAsset.map(a => a.revenue), 1);

  // ── Export helpers ──────────────────────────────────────────────────────────
  function exportWeekLoads(format: 'csv' | 'xls') {
    const STATUS_LABELS: Record<string, string> = {
      scheduled: 'Scheduled', assigned: 'Assigned', dispatched: 'Dispatched', en_route: 'En Route',
      picked_up: 'Picked Up', delivered: 'Delivered', cancelled: 'Cancelled',
      tonu: 'TONU', problem: 'Problem',
    };
    // Driver Pay column is excluded from the export when the caller
    // lacks loads.view_driver_pay — same gating that hides the field
    // in the load modal applies here so the export doesn't smuggle
    // the data back out for a Dispatcher/Maintenance user.
    const headers = canViewDriverPay
      ? ['Pickup Date', 'Load #', 'Customer', 'Title', 'Driver(s)', 'Truck', 'Status', 'Load Value', 'Driver Pay', 'Accessorials']
      : ['Pickup Date', 'Load #', 'Customer', 'Title', 'Driver(s)', 'Truck', 'Status', 'Linehaul', 'Accessorials'];

    const rows = weekLoads.map(load => {
      const partner = load.relayGroupId && load.relayRole
        ? relayPartnerMap.get(`${load.relayGroupId}-${load.relayRole === 'pickup' ? 'delivery' : 'pickup'}`)
        : undefined;
      const date = parseEventDate(load.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const asset = assets.find(a => a.id === load.assetId);
      const status = load.status ? (STATUS_LABELS[load.status] ?? load.status) : 'Scheduled';
      const drivers = [load.driverName, partner?.driverName].filter(Boolean).join(' / ');
      const totalDriverPay = (load.driverPay ?? 0) + (partner?.driverPay ?? 0);
      const base: (string | number)[] = [
        date,
        load.loadNum   ?? '',
        load.broker    ?? '',
        load.title     ?? '',
        drivers,
        asset?.name    ?? '',
        status,
        load.loadPrice ?? 0,
      ];
      if (canViewDriverPay) base.push(totalDriverPay || '');
      base.push(billableAcc(load) || '');
      return base;
    });

    const weekStr = [
      pStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      pEnd.toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' }),
    ].join(' – ');
    const safeWeek = weekStr.replace(/[^a-zA-Z0-9]/g, '-');

    if (format === 'csv') {
      const esc = (v: string | number) => {
        const s = String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const content = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
      trigger(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' }), `loads-${safeWeek}.csv`);
    } else {
      import('xlsx').then(XLSX => {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
        // Bold + tinted header row
        const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
          if (cell) cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'EEF2F6' }, patternType: 'solid' } };
        }
        // Freeze header row
        ws['!freeze'] = { xSplit: 0, ySplit: 1 };
        // Auto column widths (cap at 40 chars)
        ws['!cols'] = headers.map((h, ci) => {
          const maxLen = Math.max(h.length, ...rows.map(r => String(r[ci] ?? '').length));
          return { wch: Math.min(maxLen + 2, 42) };
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "This Week's Loads");
        XLSX.writeFile(wb, `loads-${safeWeek}.xlsx`);
      });
    }
  }

  function trigger(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Revenue by broker ──
  const revenueByBroker = useMemo(() => {
    const map = new Map<string, { revenue: number; loads: number }>();
    for (const e of deduped) {
      const key = e.broker?.trim() || 'Unknown';
      const cur = map.get(key) ?? { revenue: 0, loads: 0 };
      map.set(key, { revenue: cur.revenue + eventRevenue(e), loads: cur.loads + 1 });
    }
    return [...map.entries()]
      .map(([name, data]) => ({ name, ...data }))
      .filter(b => b.loads > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map((b, i) => ({ ...b, color: BROKER_COLORS[i % BROKER_COLORS.length] }));
  }, [deduped]);

  // ── Revenue over time (weekly buckets) ──
  const timeBuckets = useMemo(() => {
    const useDailyBuckets = period === 'week';
    const buckets: { label: string; revenue: number; loads: number }[] = [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Prefer the load-shaped report (one row per load, same source as the
    // Total Revenue KPI tile). Bucket math now matches the tile exactly
    // and includes loads on the Unassigned asset — important for the
    // 758 historical Alvys imports we couldn't bridge to a real truck,
    // which would otherwise be invisibly dropped here.
    //
    // Fall back to the events-store `deduped` array while the report
    // is still loading, so the chart shows something instead of zeros
    // during the initial paint.
    const useLoadSummaries = loadSummaries !== null;
    const loadRevenue = (l: LoadSummary): number => {
      if (l.totalBillable != null) return l.totalBillable;
      const accessorials = (l.accessorials ?? [])
        .reduce((acc, a) => acc + (a.billable ? (a.amount ?? 0) : 0), 0);
      return (l.loadPrice ?? 0) + accessorials;
    };
    // pickupAt on a LoadSummary is a NAIVE org-local string like
    // "2026-03-15T08:00". Parsing with `new Date(...)` treats it as
    // browser-local, which is the same tz the bucket boundaries are
    // computed in below — so bucketing stays consistent.

    if (useDailyBuckets) {
      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const cur = new Date(pStart);
      while (cur <= pEnd) {
        const next = new Date(cur); next.setDate(cur.getDate() + 1);
        let revenue = 0;
        let count   = 0;
        if (useLoadSummaries) {
          for (const l of loadSummaries!) {
            const d = parseEventDate(l.pickupAt);
            if (d >= cur && d < next) { revenue += loadRevenue(l); count++; }
          }
        } else {
          for (const e of deduped) {
            const d = parseEventDate(e.start);
            if (d >= cur && d < next) { revenue += eventRevenue(e); count++; }
          }
        }
        buckets.push({ label: DAY_NAMES[cur.getDay()], revenue, loads: count });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      // Weekly buckets — align start to Saturday (week runs Sat → Fri)
      const cur = new Date(pStart);
      const dow = cur.getDay();
      cur.setDate(cur.getDate() - ((dow + 1) % 7));
      while (cur <= pEnd && cur <= today) {
        const wEnd = new Date(cur); wEnd.setDate(cur.getDate() + 6);
        let revenue = 0;
        let count   = 0;
        if (useLoadSummaries) {
          for (const l of loadSummaries!) {
            const d = parseEventDate(l.pickupAt);
            if (d >= cur && d <= wEnd) { revenue += loadRevenue(l); count++; }
          }
        } else {
          for (const e of deduped) {
            const d = parseEventDate(e.start);
            if (d >= cur && d <= wEnd) { revenue += eventRevenue(e); count++; }
          }
        }
        buckets.push({
          label: cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          revenue,
          loads: count,
        });
        cur.setDate(cur.getDate() + 7);
      }
    }
    return buckets;
  }, [loadSummaries, deduped, pStart, pEnd, period]);

  const maxBucketRev = Math.max(...timeBuckets.map(b => b.revenue), 1);

  // ── Top loads (deduped — relay shows once, attributed to pickup leg) ──
  // Ranks by total billable (linehaul + accessorials) so a load with a
  // big detention surcharge climbs the leaderboard correctly.
  const topLoads = useMemo(
    () => [...deduped]
      .filter(e => eventRevenue(e) > 0)
      .sort((a, b) => eventRevenue(b) - eventRevenue(a))
      .slice(0, 10),
    [deduped],
  );

  return (
    <AppShell title="Dashboard" icon={BarChart2}>
      <DataLoader />

      {brokerProfileId && (
        <BrokerProfileModal
          initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)}
        />
      )}

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6 relative">
        {fetching && (
          <div className="absolute inset-0 z-10 flex items-start justify-end p-4 pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: 'var(--shadow-1)', color: 'var(--gc-text-2)' }}
            >
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              Loading data…
            </div>
          </div>
        )}
        <div className="w-full space-y-5">

          {/* Page title + period selector. Fuel KPIs moved to
              /equipment > Fuel so this dashboard is purely the
              revenue/performance view now — no Performance/Fuel
              tab strip needed here. */}
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-3">
              <h2 className="text-[32px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.5px' }}>
                {organization?.name ? <>{organization.name}&rsquo;s Dashboard</> : 'Dashboard'}
              </h2>
            </div>
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

          {/* Performance view — existing revenue/loads dashboard. */}
          {view === 'performance' && <>
          {/* KPI grid — 8 cards in two rows of four. Row 1 covers the
              top-line financials (revenue + costs); row 2 covers the
              operational volume (miles + loads). The grid wraps to 2×4
              on lg, 4×2 on smaller screens.

              Each tile shows a shimmer placeholder while its source
              fetch is in flight, so the user sees the tile is still
              gathering data instead of reading "0" / "—" as if the
              answer were really zero.

              The fetches are independent — loadSummaries powers most
              tiles (revenue, loads, miles, avgs), payrollData powers
              Total Payroll, fuelSpend powers Total Fuel Spend, and
              eldMiles powers Total Miles. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Row 1 ─ financials */}
            <KpiCard
              label="Total Revenue"
              value={fmt(kpis.revenue)}
              sub={`${kpis.loads} load${kpis.loads !== 1 ? 's' : ''} in period`}
              icon={<DollarSign size={17} />}
              accent="#1a73e8"
              loading={loadSummaries === null}
            />
            <KpiCard
              label="Avg Revenue / Truck"
              value={kpis.activeAssets > 0 ? fmt(kpis.avgRevPerAsset) : '—'}
              sub={`across ${kpis.activeAssets} active truck${kpis.activeAssets !== 1 ? 's' : ''}`}
              icon={<CheckCircle2 size={17} />}
              accent="#f9ab00"
              loading={loadSummaries === null}
            />
            {showPayrollKpi && (
              <KpiCard
                label="Total Payroll"
                value={payrollTotal == null ? '—' : fmt(payrollTotal)}
                sub={payrollSub}
                badge={payrollBadge}
                icon={<Wallet size={17} />}
                accent="#5e35b1"
                loading={payrollData === null}
              />
            )}
            {showFuelKpi && (
              <KpiCard
                label="Total Fuel Spend"
                value={fuelSpend == null ? '—' : fmt(fuelSpend)}
                sub="across all fuel transactions"
                icon={<Fuel size={17} />}
                accent="#ea4335"
                loading={fuelSpend === null}
              />
            )}
            {/* Row 2 ─ volume — gated on the performance module. MVP
                orgs without it see a single-row 4-KPI dashboard
                focused on the money. */}
            {showVolumeKpis && (
              <KpiCard
                label="Total Loaded Miles"
                value={fmtMiles(kpis.miles)}
                sub="sum of leg loaded miles"
                icon={<Route size={17} />}
                accent="#00838f"
                loading={loadSummaries === null}
              />
            )}
            {showEldMiles && (
              <KpiCard
                label="Total Miles"
                value={eldMiles == null ? '—' : fmtMiles(eldMiles)}
                sub="ELD-equipped trucks only"
                icon={<Gauge size={17} />}
                accent="#0288d1"
                loading={eldMiles === null}
              />
            )}
            {showVolumeKpis && (
              <KpiCard
                label="Total Loads"
                value={String(kpis.loads)}
                sub="loads dispatched this period"
                icon={<Truck size={17} />}
                accent="#1e8e3e"
                loading={loadSummaries === null}
              />
            )}
            <KpiCard
              label="Avg Revenue / Load"
              value={kpis.loads > 0 ? fmt(kpis.avgRevPerLoad) : '—'}
              sub={kpis.loads > 0 ? `across ${kpis.loads} load${kpis.loads !== 1 ? 's' : ''}` : 'No loads this period'}
              icon={<TrendingUp size={17} />}
              accent="#a142f4"
              loading={loadSummaries === null}
            />
          </div>

          {/* Revenue → cost breakdown bar. Full bar width represents
              period revenue; chunks consume the chunk's share. What's
              left at the right is margin. Maintenance can slot in as a
              4th chunk later once WO actualCost is consistently set. */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <CardTitle>Revenue Breakdown</CardTitle>
            </div>
            {kpis.revenue > 0 ? (
              <CostBar
                revenue={kpis.revenue}
                segments={[
                  ...(showPayrollKpi ? [{ label: 'Payroll', amount: payrollTotal ?? 0, color: '#5e35b1' }] : []),
                  ...(showFuelKpi    ? [{ label: 'Fuel',    amount: fuelSpend   ?? 0, color: '#ea4335' }] : []),
                ]}
              />
            ) : (
              <Empty label="No revenue in this period" />
            )}
          </Card>

          {/* Revenue by Asset + Revenue by Broker */}
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <div className="flex items-center justify-between mb-3">
                <CardTitle>Revenue by Truck</CardTitle>
                {/* Cost overlay toggles — show fuel and payroll as
                    secondary bars beneath the revenue bar so a
                    dispatcher can eyeball margin per truck. */}
                <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--gc-text-2)' }}>
                  {showPayrollKpi && (
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showPayrollOverlay}
                        onChange={(e) => setShowPayrollOverlay(e.target.checked)}
                        style={{ accentColor: '#5e35b1' }}
                      />
                      <span style={{ color: '#5e35b1', fontWeight: 600 }}>Payroll</span>
                    </label>
                  )}
                  {showFuelKpi && (
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showFuelOverlay}
                        onChange={(e) => setShowFuelOverlay(e.target.checked)}
                        style={{ accentColor: '#ea4335' }}
                      />
                      <span style={{ color: '#ea4335', fontWeight: 600 }}>Fuel</span>
                    </label>
                  )}
                </div>
              </div>
              {revenueByAsset.length === 0 ? (
                <Empty label="No load data for this period" />
              ) : (
                <>
                  <div className="space-y-3">
                    {revenueByAsset.map(({ asset, revenue, loads, fuel, payroll, net }) => {
                      const showOverlays = showPayrollOverlay || showFuelOverlay;
                      // Inside the bar: margin (asset color) | payroll (purple) | fuel (red).
                      // Each segment is its share of maxAssetRev so widths are
                      // comparable across rows. When costs exceed revenue,
                      // margin = 0 and the cost segments visibly extend
                      // past where revenue ended (no clamping — honest).
                      const visiblePayroll = showPayrollOverlay ? payroll : 0;
                      const visibleFuel    = showFuelOverlay    ? fuel    : 0;
                      const visibleCosts   = visiblePayroll + visibleFuel;
                      const margin         = Math.max(0, revenue - visibleCosts);
                      const pctMargin  = (margin       / maxAssetRev) * 100;
                      const pctPayroll = (visiblePayroll / maxAssetRev) * 100;
                      const pctFuel    = (visibleFuel    / maxAssetRev) * 100;
                      // When neither overlay is on, render the whole bar as
                      // revenue in the asset color (the original behavior).
                      const pctRev     = (revenue / maxAssetRev) * 100;
                      const assetLabel = asset.unit
                        ? `#${asset.unit} · ${asset.name}`
                        : asset.name;
                      const loadsLabel = loads % 1 === 0
                        ? `${loads} load${loads !== 1 ? 's' : ''}`
                        : `${loads.toFixed(1)} loads`;
                      return (
                        <div key={asset.id} className="flex items-center gap-3">
                          <div
                            className="w-[120px] shrink-0 text-[13px] truncate font-medium"
                            style={{ color: 'var(--gc-text-1)' }}
                            title={assetLabel}
                          >
                            {assetLabel}
                          </div>
                          <div className="flex-1 h-5 relative flex items-center">
                            {showOverlays ? (
                              // Segmented bar reads cost → margin left-to-right:
                              //   [payroll (purple)] [fuel (red)] [margin (asset color)]
                              //
                              // Hovering any segment shows the same multi-line
                              // breakdown so the dispatcher gets full context
                              // without having to land on a specific segment.
                              // Native title attribute renders \n as newlines
                              // in most browsers' default tooltip.
                              (() => {
                                const breakdown = [
                                  `Revenue:  ${fmt(revenue)}`,
                                  showPayrollOverlay ? `Payroll: −${fmt(payroll)}` : null,
                                  showFuelOverlay    ? `Fuel:    −${fmt(fuel)}`    : null,
                                  `Margin:   ${net >= 0 ? fmt(net) : `−${fmt(-net)}`}`,
                                ].filter(Boolean).join('\n');
                                return (
                                  <div
                                    className="absolute inset-x-0 flex"
                                    style={{ height: 7, top: '50%', transform: 'translateY(-50%)' }}
                                    title={breakdown}
                                  >
                                    {showPayrollOverlay && visiblePayroll > 0 ? (
                                      <div
                                        style={{
                                          width: `${pctPayroll}%`,
                                          background: '#5e35b1',
                                          borderTopLeftRadius: 3, borderBottomLeftRadius: 3,
                                          borderTopRightRadius: (showFuelOverlay && visibleFuel > 0) || pctMargin > 0 ? 0 : 3,
                                          borderBottomRightRadius: (showFuelOverlay && visibleFuel > 0) || pctMargin > 0 ? 0 : 3,
                                        }}
                                        title={breakdown}
                                      />
                                    ) : null}
                                    {showFuelOverlay && visibleFuel > 0 ? (
                                      <div
                                        style={{
                                          width: `${pctFuel}%`,
                                          background: '#ea4335',
                                          borderTopLeftRadius: visiblePayroll === 0 ? 3 : 0,
                                          borderBottomLeftRadius: visiblePayroll === 0 ? 3 : 0,
                                          borderTopRightRadius: pctMargin > 0 ? 0 : 3,
                                          borderBottomRightRadius: pctMargin > 0 ? 0 : 3,
                                        }}
                                        title={breakdown}
                                      />
                                    ) : null}
                                    {pctMargin > 0 ? (
                                      <div
                                        style={{
                                          width: `${pctMargin}%`,
                                          background: asset.color,
                                          borderTopLeftRadius: visibleCosts === 0 ? 3 : 0,
                                          borderBottomLeftRadius: visibleCosts === 0 ? 3 : 0,
                                          borderTopRightRadius: 3, borderBottomRightRadius: 3,
                                        }}
                                        title={breakdown}
                                      />
                                    ) : null}
                                  </div>
                                );
                              })()
                            ) : (
                              // No overlays — show single asset-color bar at revenue width.
                              <div
                                className="absolute rounded"
                                style={{
                                  width: `${pctRev}%`, height: 7,
                                  background: asset.color,
                                  top: '50%', transform: 'translateY(-50%)',
                                  minWidth: revenue > 0 ? 4 : 0,
                                }}
                              />
                            )}
                          </div>
                          <div className="shrink-0 text-right" style={{ minWidth: 80 }}>
                            <div className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                              {fmt(revenue)}
                            </div>
                            {showOverlays ? (
                              <div
                                className="text-[11px] tabular-nums font-medium"
                                style={{ color: net >= 0 ? '#1e8e3e' : '#d93025' }}
                                title={`Margin = ${fmt(revenue)}${showPayrollOverlay ? ` − ${fmt(payroll)} payroll` : ''}${showFuelOverlay ? ` − ${fmt(fuel)} fuel` : ''}`}
                              >
                                {net >= 0 ? fmt(net) : `−${fmt(-net)}`} margin
                              </div>
                            ) : null}
                          </div>
                          <div className="text-xs shrink-0 text-right" style={{ color: 'var(--gc-text-3)', minWidth: 60 }}>
                            {loadsLabel}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 pt-3 text-[11px] leading-relaxed" style={{ color: 'var(--gc-text-3)', borderTop: '1px solid var(--gc-border-light)' }}>
                    Relay loads are split between the two assets in proportion
                    to each leg&apos;s loaded miles (routed when the load has
                    been opened in the modal, otherwise straight-line as a
                    fallback). Each leg counts as half a load. When one leg
                    has no geocoded stops, the split falls back to 50/50.
                  </div>
                </>
              )}
            </Card>

            <Card className="flex flex-col">
              <CardTitle>Revenue by Customer</CardTitle>
              {revenueByBroker.length === 0 ? (
                <Empty label="No customer data for this period" />
              ) : (
                <div className="flex-1 flex gap-8 items-center">
                  {/* Donut chart — fixed on the left, the ranked list
                      stretches into the remaining width so the card
                      doesn't waste its right half. */}
                  <div className="shrink-0" style={{ overflow: 'visible' }}>
                    <PieChart
                      size={240}
                      slices={revenueByBroker.map(b => ({ value: b.revenue, color: b.color, label: b.name }))}
                    />
                  </div>
                  {/* Ranked list — fills the rest of the card. */}
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--gc-text-3)' }}>
                      Top 10 Customers by Revenue
                    </div>
                    {revenueByBroker.map(({ name, revenue, color }, i) => {
                      const customer = customers.find(c =>
                        c.name.toLowerCase() === name.toLowerCase() ||
                        c.aliases.some(a => a.toLowerCase() === name.toLowerCase())
                      );
                      return (
                        <div key={name}
                          className="flex items-center gap-2 rounded-lg px-1.5 py-1 -mx-1.5 transition-colors"
                          style={{ cursor: customer ? 'pointer' : 'default' }}
                          title={customer ? `View ${name} profile` : name}
                          onClick={() => customer && setBrokerProfileId(customer.id)}
                          onMouseEnter={e => { if (customer) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <span className="text-[11px] font-medium shrink-0 w-4 text-right" style={{ color: 'var(--gc-text-3)' }}>
                            {i + 1}
                          </span>
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                          <span className="text-[13px] truncate flex-1 min-w-0" style={{ color: 'var(--gc-text-2)' }}>
                            {name}
                          </span>
                          <span className="text-[13px] font-semibold shrink-0" style={{ color: 'var(--gc-text-1)' }}>
                            {fmt(revenue)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* Revenue Over Time */}
          <Card>
            <CardTitle>Revenue Over Time</CardTitle>
            {timeBuckets.every(b => b.revenue === 0) ? (
              <Empty label="No revenue data for this period" />
            ) : (() => {
              const CHART_H  = 160;
              const YAXIS_W  = 44;
              const yMax     = niceRound(maxBucketRev);
              const yTicks   = [yMax, yMax * 0.75, yMax * 0.5, yMax * 0.25];

              return (
                <div>
                  {/* Chart row: Y-axis + bars */}
                  <div className="flex gap-1" style={{ paddingTop: 20 }}>
                    {/* Y-axis labels */}
                    <div className="relative shrink-0" style={{ width: YAXIS_W, height: CHART_H }}>
                      {yTicks.map(tick => (
                        <div
                          key={tick}
                          className="absolute right-1 text-[11px] font-medium leading-none"
                          style={{
                            top: `${(1 - tick / yMax) * CHART_H}px`,
                            transform: 'translateY(-50%)',
                            color: 'var(--gc-text-3)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {fmt(tick)}
                        </div>
                      ))}
                      {/* $0 label at bottom */}
                      <div className="absolute right-1 text-[11px] font-medium leading-none"
                        style={{ bottom: 0, transform: 'translateY(50%)', color: 'var(--gc-text-3)' }}>
                        $0
                      </div>
                    </div>

                    {/* Bars + gridlines */}
                    <div className="flex-1 relative" style={{ height: CHART_H, overflow: 'visible' }}>
                      {/* Horizontal gridlines */}
                      {[...yTicks, 0].map(tick => (
                        <div
                          key={tick}
                          className="absolute left-0 right-0 pointer-events-none"
                          style={{
                            top: `${(1 - tick / yMax) * CHART_H}px`,
                            borderTop: `1px ${tick === 0 ? 'solid' : 'dashed'} var(--gc-border${tick === 0 ? '' : '-light'})`,
                          }}
                        />
                      ))}

                      {/* Bars */}
                      <div className="flex items-end h-full gap-0.5">
                        {timeBuckets.map((b, i) => {
                          const barH = yMax > 0
                            ? Math.max((b.revenue / yMax) * CHART_H, b.revenue > 0 ? 3 : 0)
                            : 0;
                          return (
                            <div
                              key={i}
                              className="flex-1 group relative flex flex-col justify-end"
                              style={{ height: CHART_H, overflow: 'visible' }}
                            >
                              {/* Value label above bar — always visible */}
                              {b.revenue > 0 && (
                                <div
                                  className="absolute left-1/2 -translate-x-1/2 text-[11px] font-semibold whitespace-nowrap pointer-events-none"
                                  style={{
                                    bottom: barH + 4,
                                    color: 'var(--gc-text-2)',
                                    lineHeight: 1,
                                  }}
                                >
                                  {fmt(b.revenue)}
                                </div>
                              )}
                              <div
                                className="w-full rounded-sm"
                                style={{
                                  height: barH,
                                  background: 'var(--gc-blue)',
                                  opacity: b.revenue > 0 ? 0.85 : 0.1,
                                  minHeight: b.revenue > 0 ? 3 : 1,
                                }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* X-axis labels — offset to align with bars, not y-axis */}
                  {timeBuckets.length <= 20 && (
                    <div className="flex gap-0.5 mt-1" style={{ paddingLeft: YAXIS_W + 4 }}>
                      {timeBuckets.map((b, i) => (
                        <div
                          key={i}
                          className="flex-1 text-[11px] text-center truncate"
                          style={{ color: 'var(--gc-text-3)' }}
                        >
                          {b.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </Card>

          {/* Custom loads report — auto-runs against the dashboard's period */}
          <LoadsReport
            defaultFrom={pStart.toISOString().slice(0, 10)}
            defaultTo={pEnd.toISOString().slice(0, 10)}
          />


          {/* Empty state */}
          {deduped.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <AlertCircle size={44} style={{ color: 'var(--gc-border)', marginBottom: 16 }} />
              <p className="text-base font-medium" style={{ color: 'var(--gc-text-2)' }}>
                No loads in this period
              </p>
              <p className="text-sm mt-1" style={{ color: 'var(--gc-text-3)' }}>
                Try a different date range, or add loads in the calendar.
              </p>
              <Link
                href="/calendar"
                className="mt-5 px-5 py-2 rounded-lg text-sm font-medium"
                style={{ background: 'var(--gc-blue)', color: 'white' }}
              >
                Go to Calendar
              </Link>
            </div>
          )}
          </>}

        </div>
      </div>
    </AppShell>
  );
}

