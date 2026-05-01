'use client';

import { useMemo, useState, useEffect } from 'react';
import Link from 'next/link';
import {
  TrendingUp, Truck, CheckCircle2, DollarSign,
  BarChart2, AlertCircle, Loader2, FileDown, Sheet,
} from 'lucide-react';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore } from '@/store/useCalendarStore';
import DataLoader from '@/components/DataLoader';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import ManagementHeader from '@/components/nav/ManagementHeader';
import CopyChip from '@/components/ui/CopyChip';
import type { CalendarEvent } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────────────

type Period = 'week' | 'month' | '30d' | '90d' | 'ytd';
type WeekSortField = 'pickupDate' | 'loadNum' | 'broker' | 'title' | 'driver' | 'loadPrice' | 'driverPay' | 'accessorials';

interface PeriodRange { start: Date; end: Date }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPeriodRange(period: Period): PeriodRange {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (period) {
    case 'week': {
      // Week runs Saturday → Friday
      const dow = today.getDay(); // 0=Sun … 6=Sat
      const sat = new Date(today);
      sat.setDate(today.getDate() - ((dow + 1) % 7)); // back to most-recent Saturday
      const fri = new Date(sat);
      fri.setDate(sat.getDate() + 6);
      return { start: sat, end: fri };
    }
    case 'month':
      return {
        start: new Date(today.getFullYear(), today.getMonth(), 1),
        end: new Date(today.getFullYear(), today.getMonth() + 1, 0),
      };
    case '30d': {
      const s = new Date(today); s.setDate(today.getDate() - 29);
      return { start: s, end: today };
    }
    case '90d': {
      const s = new Date(today); s.setDate(today.getDate() - 89);
      return { start: s, end: today };
    }
    case 'ytd':
      return { start: new Date(today.getFullYear(), 0, 1), end: today };
  }
}

function billableAcc(e: CalendarEvent): number {
  return (e.accessorials ?? []).filter(a => a.billable).reduce((s, a) => s + a.amount, 0);
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

const PERIODS: { value: Period; label: string }[] = [
  { value: 'week',  label: 'This Week' },
  { value: 'month', label: 'This Month' },
  { value: '30d',   label: '30 Days' },
  { value: '90d',   label: '90 Days' },
  { value: 'ytd',   label: 'YTD' },
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

function KpiCard({
  label, value, sub, icon, accent,
}: {
  label: string; value: string; sub: string;
  icon: React.ReactNode; accent: string;
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
      <div className="text-[26px] font-semibold leading-none mb-1.5" style={{ color: 'var(--gc-text-1)' }}>
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{sub}</div>
    </Card>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DashboardView() {
  const { events, assets, loadedStart, loadedEnd, dbReady, extendLoadedRange, unassignedAssetId, customers, openEditModal } = useCalendarStore();
  const { organization } = useOrganization();
  const [period, setPeriod] = useState<Period>('month');
  const [fetching, setFetching] = useState(false);
  const [weekSort, setWeekSort] = useState<{ field: WeekSortField; dir: 'asc' | 'desc' }>({ field: 'pickupDate', dir: 'asc' });
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);

  const { start: pStart, end: pEnd } = useMemo(() => getPeriodRange(period), [period]);

  // Extend the loaded window whenever the selected period reaches beyond what's cached
  useEffect(() => {
    if (!dbReady) return;
    const startIso = pStart.toISOString();
    const endIso   = pEnd.toISOString();
    if (loadedStart && loadedEnd && startIso >= loadedStart && endIso <= loadedEnd) return;
    setFetching(true);
    extendLoadedRange(startIso, endIso).finally(() => setFetching(false));
  }, [period, dbReady, pStart, pEnd, loadedStart, loadedEnd, extendLoadedRange]);

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

  // ── KPI summary (uses deduped — each relay load counted once) ──
  const kpis = useMemo(() => {
    const revenue = deduped.reduce((s, e) => s + (e.loadPrice ?? 0), 0);
    const loads   = deduped.length;
    const delivered  = deduped.filter(e => e.status === 'delivered').length;
    const nonCancel  = deduped.filter(e => e.status !== 'cancelled').length;
    const delivRate  = nonCancel > 0 ? (delivered / nonCancel) * 100 : 0;
    const avgRevPerLoad  = loads > 0 ? revenue / loads : 0;
    const activeAssets   = new Set(deduped.map(e => e.assetId)).size; // unassigned already excluded from deduped via filtered
    const avgRevPerAsset = activeAssets > 0 ? revenue / activeAssets : 0;
    const miles      = 0; // auto-calculated from stops per load, not stored
    const driverPay  = filtered.reduce((s, e) => s + (e.driverPay ?? 0), 0);
    return { revenue, loads, delivered, delivRate, avgRevPerLoad, avgRevPerAsset, activeAssets, miles, driverPay };
  }, [deduped, filtered]);

  // ── Revenue by asset (deduped — relay attributed to whichever leg is kept) ──
  const revenueByAsset = useMemo(() => assets
    .filter(asset => asset.id !== unassignedAssetId && asset.type !== 'Unassigned' && asset.name !== 'Unassigned')
    .map(asset => {
      const ae = deduped.filter(e => e.assetId === asset.id);
      return {
        asset,
        revenue: ae.reduce((s, e) => s + (e.loadPrice ?? 0), 0),
        loads:   ae.length,
        miles:   0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue),
    [assets, deduped, unassignedAssetId],
  );


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
      scheduled: 'Scheduled', dispatched: 'Dispatched', en_route: 'En Route',
      picked_up: 'Picked Up', delivered: 'Delivered', cancelled: 'Cancelled',
      tonu: 'TONU', problem: 'Problem',
    };
    const headers = ['Pickup Date', 'Load #', 'Broker', 'Title', 'Driver(s)', 'Asset', 'Status', 'Load Value', 'Driver Pay', 'Accessorials'];

    const rows = weekLoads.map(load => {
      const partner = load.relayGroupId && load.relayRole
        ? relayPartnerMap.get(`${load.relayGroupId}-${load.relayRole === 'pickup' ? 'delivery' : 'pickup'}`)
        : undefined;
      const date = parseEventDate(load.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const asset = assets.find(a => a.id === load.assetId);
      const status = load.status ? (STATUS_LABELS[load.status] ?? load.status) : 'Scheduled';
      const drivers = [load.driverName, partner?.driverName].filter(Boolean).join(' / ');
      const totalDriverPay = (load.driverPay ?? 0) + (partner?.driverPay ?? 0);
      return [
        date,
        load.loadNum   ?? '',
        load.broker    ?? '',
        load.title     ?? '',
        drivers,
        asset?.name    ?? '',
        status,
        load.loadPrice ?? 0,
        totalDriverPay || '',
        billableAcc(load) || '',
      ] as (string | number)[];
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
      map.set(key, { revenue: cur.revenue + (e.loadPrice ?? 0), loads: cur.loads + 1 });
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

    if (useDailyBuckets) {
      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const cur = new Date(pStart);
      while (cur <= pEnd) {
        const next = new Date(cur); next.setDate(cur.getDate() + 1);
        const dayEvents = deduped.filter(e => {
          const d = parseEventDate(e.start);
          return d >= cur && d < next;
        });
        buckets.push({
          label:   DAY_NAMES[cur.getDay()],
          revenue: dayEvents.reduce((s, e) => s + (e.loadPrice ?? 0), 0),
          loads:   dayEvents.length,
        });
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      // Weekly buckets — align start to Saturday (week runs Sat → Fri)
      const cur = new Date(pStart);
      const dow = cur.getDay();
      cur.setDate(cur.getDate() - ((dow + 1) % 7));
      while (cur <= pEnd && cur <= today) {
        const wEnd = new Date(cur); wEnd.setDate(cur.getDate() + 6);
        const wEvents = deduped.filter(e => {
          const d = parseEventDate(e.start);
          return d >= cur && d <= wEnd;
        });
        buckets.push({
          label:   cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          revenue: wEvents.reduce((s, e) => s + (e.loadPrice ?? 0), 0),
          loads:   wEvents.length,
        });
        cur.setDate(cur.getDate() + 7);
      }
    }
    return buckets;
  }, [deduped, pStart, pEnd, period]);

  const maxBucketRev = Math.max(...timeBuckets.map(b => b.revenue), 1);

  // ── Top loads (deduped — relay shows once, attributed to pickup leg) ──
  const topLoads = useMemo(
    () => [...deduped]
      .filter(e => (e.loadPrice ?? 0) > 0)
      .sort((a, b) => (b.loadPrice ?? 0) - (a.loadPrice ?? 0))
      .slice(0, 10),
    [deduped],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ background: 'var(--gc-bg)' }}>
      <DataLoader />

      {brokerProfileId && (
        <BrokerProfileModal
          initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)}
        />
      )}

      {/* ── Toolbar ── */}
      <ManagementHeader title="Dashboard" icon={BarChart2} />

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6 relative">
        {fetching && (
          <div className="absolute inset-0 z-10 flex items-start justify-end p-4 pointer-events-none">
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-full text-xs font-medium"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', boxShadow: 'var(--shadow-1)', color: 'var(--gc-text-2)' }}
            >
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
              Loading data…
            </div>
          </div>
        )}
        <div className="max-w-[1600px] mx-auto space-y-5">

          {/* Page title + period selector */}
          <div className="flex items-start justify-between">
            <h2 className="text-[32px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.5px' }}>
              {organization?.name ? <>{organization.name}&rsquo;s Dashboard</> : 'Dashboard'}
            </h2>
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div
                className="flex items-center rounded-full"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-hover)', padding: 2 }}
              >
                {PERIODS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => setPeriod(p.value)}
                    className="px-3 py-1 rounded-full text-[13px] font-medium transition-all"
                    style={{
                      background: period === p.value ? 'var(--gc-surface)' : 'transparent',
                      color:      period === p.value ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                      boxShadow:  period === p.value ? 'var(--shadow-1)' : 'none',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {/* Date range label */}
              <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>
                {pStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {' – '}
                {pEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          </div>

          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard
              label="Total Revenue"
              value={fmt(kpis.revenue)}
              sub={`${kpis.loads} load${kpis.loads !== 1 ? 's' : ''} in period`}
              icon={<DollarSign size={17} />}
              accent="#1a73e8"
            />
            <KpiCard
              label="Total Loads"
              value={String(kpis.loads)}
              sub="loads dispatched this period"
              icon={<Truck size={17} />}
              accent="#1e8e3e"
            />
            <KpiCard
              label="Avg Revenue / Asset"
              value={kpis.activeAssets > 0 ? fmt(kpis.avgRevPerAsset) : '—'}
              sub={`across ${kpis.activeAssets} active asset${kpis.activeAssets !== 1 ? 's' : ''}`}
              icon={<CheckCircle2 size={17} />}
              accent="#f9ab00"
            />
            <KpiCard
              label="Avg Revenue / Load"
              value={kpis.loads > 0 ? fmt(kpis.avgRevPerLoad) : '—'}
              sub={kpis.loads > 0 ? `across ${kpis.loads} load${kpis.loads !== 1 ? 's' : ''}` : 'No loads this period'}
              icon={<TrendingUp size={17} />}
              accent="#a142f4"
            />
          </div>

          {/* Revenue by Asset + Revenue by Broker */}
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardTitle>Revenue by Asset</CardTitle>
              {revenueByAsset.length === 0 ? (
                <Empty label="No load data for this period" />
              ) : (
                <div className="space-y-3">
                  {revenueByAsset.map(({ asset, revenue, loads }) => {
                    const pct = (revenue / maxAssetRev) * 100;
                    const assetLabel = asset.unit
                      ? `#${asset.unit} · ${asset.name}`
                      : asset.name;
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
                          <div
                            className="absolute rounded"
                            style={{
                              width: `${pct}%`, height: 7,
                              background: asset.color,
                              top: '50%', transform: 'translateY(-50%)',
                              minWidth: revenue > 0 ? 4 : 0,
                            }}
                          />
                        </div>
                        <div className="text-[13px] font-semibold shrink-0 text-right" style={{ color: 'var(--gc-text-1)', minWidth: 64 }}>
                          {fmt(revenue)}
                        </div>
                        <div className="text-xs shrink-0 text-right" style={{ color: 'var(--gc-text-3)', minWidth: 52 }}>
                          {loads} load{loads !== 1 ? 's' : ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card className="flex flex-col">
              <CardTitle>Revenue by Broker</CardTitle>
              {revenueByBroker.length === 0 ? (
                <Empty label="No broker data for this period" />
              ) : (
                <div className="flex-1 flex gap-6 items-center justify-center">
                  {/* Donut chart */}
                  <div className="shrink-0" style={{ overflow: 'visible' }}>
                    <PieChart
                      size={240}
                      slices={revenueByBroker.map(b => ({ value: b.revenue, color: b.color, label: b.name }))}
                    />
                  </div>
                  {/* Ranked list — name and price as a tight pair */}
                  <div className="space-y-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--gc-text-3)' }}>
                      Top 10 Brokers by Revenue
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
                          <span className="text-[13px] truncate max-w-[130px]" style={{ color: 'var(--gc-text-2)' }}>
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

          {/* Weekly loads table (period === 'week') or Top Loads table (other periods) */}
          {period === 'week' ? (
            weekLoads.length > 0 && (
              <div style={{ background: 'var(--gc-surface)', borderRadius: 12, border: '1px solid var(--gc-border)', overflow: 'hidden' }}>
                <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                    This Week&rsquo;s Loads
                    <span className="ml-2 text-xs font-normal" style={{ color: 'var(--gc-text-3)' }}>
                      {weekLoads.length} load{weekLoads.length !== 1 ? 's' : ''}
                    </span>
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => exportWeekLoads('csv')}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
                      title="Download CSV"
                    >
                      <FileDown size={13} /> CSV
                    </button>
                    <button
                      onClick={() => exportWeekLoads('xls')}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                      style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
                      title="Download Excel"
                    >
                      <Sheet size={13} /> Excel
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        {(
                          [
                            { field: 'pickupDate'   as WeekSortField, label: 'Pickup Date' },
                            { field: 'loadNum'      as WeekSortField, label: 'Load #' },
                            { field: 'broker'       as WeekSortField, label: 'Broker' },
                            { field: 'title'        as WeekSortField, label: 'Title' },
                            { field: 'driver'       as WeekSortField, label: 'Driver(s)' },
                            { field: 'loadPrice'    as WeekSortField, label: 'Load Value' },
                            { field: 'driverPay'    as WeekSortField, label: 'Driver Pay' },
                            { field: 'accessorials' as WeekSortField, label: 'Accessorials' },
                          ] as { field: WeekSortField; label: string }[]
                        ).map(({ field, label }) => {
                          const active = weekSort.field === field;
                          return (
                            <th
                              key={field}
                              className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide cursor-pointer select-none"
                              style={{ color: active ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}
                              onClick={() => setWeekSort(prev =>
                                prev.field === field
                                  ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                                  : { field, dir: 'asc' },
                              )}
                            >
                              {label}
                              {active && <span className="ml-1">{weekSort.dir === 'asc' ? '↑' : '↓'}</span>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {weekLoads.map(load => {
                        const partner = load.relayGroupId && load.relayRole
                          ? relayPartnerMap.get(`${load.relayGroupId}-${load.relayRole === 'pickup' ? 'delivery' : 'pickup'}`)
                          : undefined;
                        const accTotal    = billableAcc(load);
                        const pickupDate  = parseEventDate(load.start);
                        const totalDriverPay = (load.driverPay ?? 0) + (partner?.driverPay ?? 0);
                        const drivers = [load.driverName, partner?.driverName].filter(Boolean) as string[];
                        const customer = load.broker
                          ? customers.find(cu =>
                              cu.name.toLowerCase() === load.broker!.toLowerCase() ||
                              cu.aliases.some(a => a.toLowerCase() === load.broker!.toLowerCase())
                            )
                          : null;
                        return (
                          <tr
                            key={load.id}
                            style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            {/* Pickup Date */}
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                              {pickupDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                            </td>
                            {/* Load # — copyable */}
                            <td className="px-4 py-3">
                              {load.loadNum
                                ? <CopyChip value={load.loadNum} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-2)' }} />
                                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                            </td>
                            {/* Broker — link to customer profile */}
                            <td className="px-4 py-3">
                              {load.broker
                                ? <button
                                    onClick={() => customer && setBrokerProfileId(customer.id)}
                                    className={customer ? 'hover:underline text-left' : 'text-left cursor-default'}
                                    style={{ color: customer ? 'var(--gc-blue)' : 'var(--gc-text-2)' }}>
                                    {load.broker}
                                  </button>
                                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                            </td>
                            {/* Title — link to load modal */}
                            <td className="px-4 py-3 max-w-[220px]">
                              <button
                                onClick={() => openEditModal(load.id)}
                                className="text-left truncate w-full hover:underline font-medium"
                                style={{ color: 'var(--gc-blue)' }}
                                title={load.title ?? undefined}
                              >
                                {load.title ?? <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </button>
                            </td>
                            {/* Driver(s) */}
                            <td className="px-4 py-3">
                              {drivers.length > 0
                                ? <div className="flex flex-col gap-0.5">
                                    {drivers.map((name, i) => (
                                      <span key={i} className="text-xs whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>{name}</span>
                                    ))}
                                  </div>
                                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                            </td>
                            {/* Load Value */}
                            <td className="px-4 py-3 font-semibold whitespace-nowrap" style={{ color: 'var(--gc-text-1)' }}>
                              {fmtFull(load.loadPrice ?? 0)}
                            </td>
                            {/* Driver Pay — summed for relay */}
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                              {totalDriverPay > 0
                                ? <span>{fmtFull(totalDriverPay)}{partner && <span className="ml-1 text-[10px]" style={{ color: 'var(--gc-text-3)' }}>combined</span>}</span>
                                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                            </td>
                            {/* Accessorials */}
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: accTotal > 0 ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                              {accTotal > 0 ? fmtFull(accTotal) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : (
            topLoads.length > 0 && (
              <div
                style={{
                  background: 'var(--gc-surface)',
                  borderRadius: 12,
                  border: '1px solid var(--gc-border)',
                  overflow: 'hidden',
                }}
              >
                <div
                  className="px-5 py-4"
                  style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                >
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                    Top Loads by Revenue
                  </h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        {['Asset', 'Load #', 'Broker', 'Route', 'Driver', 'Revenue'].map(h => (
                          <th
                            key={h}
                            className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide"
                            style={{ color: 'var(--gc-text-3)' }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {topLoads.map(load => {
                        const asset = assets.find(a => a.id === load.assetId);
                        const firstStop = load.stops?.find(s => s.type === 'pickup');
                        const lastStop  = load.stops?.filter(s => s.type === 'delivery').at(-1);
                        const cityOf = (addr?: string) => {
                          if (!addr) return undefined;
                          const parts = addr.split(',').map(p => p.trim());
                          // Find the part just before the state+zip segment (e.g. "UT 84104" or "UT")
                          const stateIdx = parts.findIndex(p => /^[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/.test(p));
                          if (stateIdx > 0) return parts[stateIdx - 1];
                          return parts[1] ?? parts[0];
                        };
                        const route = firstStop?.address && lastStop?.address
                          ? `${cityOf(firstStop.address)} → ${cityOf(lastStop.address)}`
                          : firstStop?.facilityName ?? lastStop?.facilityName ?? '—';
                        return (
                          <tr
                            key={load.id}
                            style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: asset?.color ?? '#9aa0a6' }} />
                                <span style={{ color: 'var(--gc-text-2)' }}>{asset?.name ?? '—'}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3 font-medium">
                              {load.loadNum
                                ? <button onClick={() => openEditModal(load.id)}
                                    className="font-medium hover:underline text-left"
                                    style={{ color: 'var(--gc-blue)' }}>
                                    {load.loadNum}
                                  </button>
                                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                            </td>
                            <td className="px-4 py-3">
                              {(() => {
                                const c = load.broker ? customers.find(cu =>
                                  cu.name.toLowerCase() === load.broker!.toLowerCase() ||
                                  cu.aliases.some(a => a.toLowerCase() === load.broker!.toLowerCase())
                                ) : null;
                                return load.broker
                                  ? <button onClick={() => c && setBrokerProfileId(c.id)}
                                      className={c ? 'hover:underline text-left' : 'text-left cursor-default'}
                                      style={{ color: c ? 'var(--gc-blue)' : 'var(--gc-text-2)' }}>
                                      {load.broker}
                                    </button>
                                  : <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
                              })()}
                            </td>
                            <td
                              className="px-4 py-3 max-w-[180px] truncate"
                              style={{ color: 'var(--gc-text-2)' }}
                            >
                              {route}
                            </td>
                            <td className="px-4 py-3" style={{ color: 'var(--gc-text-2)' }}>
                              {load.driverName ?? '—'}
                            </td>
                            <td className="px-4 py-3 font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                              {fmtFull(load.loadPrice ?? 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}

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
                className="mt-5 px-5 py-2 rounded-full text-sm font-medium"
                style={{ background: 'var(--gc-blue)', color: 'white' }}
              >
                Go to Calendar
              </Link>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
