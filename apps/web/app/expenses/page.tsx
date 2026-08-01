'use client';

/**
 * /expenses — the expense workspace.
 *
 * Three zones:
 *   RAIL    (left)   chart of accounts — the bucket tree with live
 *                    period totals; click filters the ledger. All +
 *                    Uncategorized are pinned pseudo-entries.
 *   LEDGER  (center) one OpsTable of every expense event in the window,
 *                    across all sources (card, fuel, payroll, manual,
 *                    recurring postings). Inline bucket assignment.
 *   PANEL   (modal)  ExpenseDetailPanel — full detail + edit for any
 *                    row, and the "+ Expense" create flow.
 *
 * Data: /v1/expenses/summary powers the rail totals; /v1/expenses/ledger
 * powers the table. Both share the Sat–Fri period selector.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Plus, Settings2, ArrowUpRight, ArrowDownRight, ArrowRight,
  ChevronDown, CornerDownRight, RefreshCw, FolderTree, Wand2, Repeat,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import {
  currentWeekStartISO, getPeriodRange, type Period,
} from '@/lib/periodRange';
import { OpsTable, OpsDate, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import { CostBar } from '@/components/ui/CostBar';
import { PieChart } from '@/components/ui/PieChart';
import { railway } from '@/lib/railway';
import BucketSelect, { invalidateBucketCache } from './BucketSelect';
import ExpenseDetailPanel, { type PanelMode } from './ExpenseDetailPanel';
import type {
  ExpenseBucketSummary, LedgerRow, LedgerSource, LoadSummary,
} from '@fleetcal/types';
import { UNCATEGORIZED_BUCKET_ID } from '@fleetcal/types';
import type { Asset } from '@/lib/types';

interface Trailer { id: number; name: string; trailerNumber?: string }

const fmtMoney0 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);

const fmtMoney2 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

// Segment colors for the revenue bar, assigned to top-level buckets in
// rail order (fixed per entity — a bucket keeps its color as others
// come and go). Validated for lightness/chroma/CVD separation against
// the light surface; margin green + deficit red are reserved by
// CostBar and deliberately absent here. Buckets past the 8th fold
// into a neutral "Other".
const BUCKET_BAR_PALETTE = [
  '#1a73e8', '#e8710a', '#8e24aa', '#00897b',
  '#c2185b', '#3949ab', '#9e6a03', '#00acc1',
] as const;
const OTHER_SEGMENT_COLOR = '#5f6368';

const SOURCE_META: Record<LedgerSource, { label: string; color: string }> = {
  ramp:      { label: 'Card',      color: '#059669' },
  mudflap:   { label: 'Fuel',      color: '#0891b2' },
  payroll:   { label: 'Payroll',   color: '#7c3aed' },
  entry:     { label: 'Manual',    color: '#6b7280' },
  recurring: { label: 'Recurring', color: '#4f46e5' },
};

function SourcePill({ source }: { source: LedgerSource }) {
  const m = SOURCE_META[source];
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider whitespace-nowrap"
          style={{ background: `${m.color}1a`, color: m.color }}>
      {m.label}
    </span>
  );
}

function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return <span style={{ color: 'var(--gc-text-3)' }} className="text-xs">no prior data</span>;
  }
  if (previous === 0) {
    return (
      <span className="text-xs inline-flex items-center gap-0.5 font-semibold" style={{ color: '#166534' }}>
        <ArrowUpRight size={12} strokeWidth={2.4} />new
      </span>
    );
  }
  const rounded = Math.round(((current - previous) / previous) * 100);
  const up = rounded > 0;
  const flat = rounded === 0;
  const color = flat ? 'var(--gc-text-3)' : up ? '#b91c1c' : '#166534';
  const Icon  = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="text-xs inline-flex items-center gap-0.5 font-semibold tabular-nums" style={{ color }}>
      <Icon size={12} strokeWidth={2.4} />{Math.abs(rounded)}% vs prev period
    </span>
  );
}

// ── rail ────────────────────────────────────────────────────────────────

type RailSelection = 'all' | 'uncategorized' | string;

function RailRow({
  label, total, selected, onClick, indent = false, amber = false, count,
}: {
  label: string; total: number; selected: boolean; onClick: () => void;
  indent?: boolean; amber?: boolean; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-3 py-[7px] text-left transition-colors"
      style={{
        background: selected ? (amber ? '#fef3c7' : 'var(--gc-hover, rgba(26,115,232,0.08))') : 'transparent',
        borderLeft: selected ? `3px solid ${amber ? '#f59e0b' : '#1a73e8'}` : '3px solid transparent',
        paddingLeft: indent ? 26 : 12,
      }}
    >
      {indent && <CornerDownRight size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />}
      <span className="flex-1 min-w-0 truncate"
            style={{
              fontSize: 13,
              fontWeight: selected ? 700 : indent ? 400 : 600,
              color: amber ? '#b45309' : selected ? 'var(--gc-text-1)' : 'var(--gc-text-2)',
            }}>
        {label}
        {count != null && count > 0 && (
          <span className="ml-1.5 px-1.5 rounded-full text-[10px] font-bold"
                style={{ background: '#f59e0b', color: '#fff' }}>{count}</span>
        )}
      </span>
      <span className="tabular-nums shrink-0"
            style={{ fontSize: 12, color: amber ? '#b45309' : 'var(--gc-text-3)' }}>
        {fmtMoney0(total)}
      </span>
    </button>
  );
}

// ── page ────────────────────────────────────────────────────────────────

function ExpensesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Period (Sat–Fri week default, shared with rail + ledger)
  const [period, setPeriod]           = useState<Period>('week');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd]     = useState('');
  const [weekStart, setWeekStart]     = useState<string | undefined>(undefined);
  const range = useMemo(() =>
    getPeriodRange(period, {
      startISO: customStart, endISO: customEnd,
      weekStartISO: weekStart ?? currentWeekStartISO(),
    }),
  [period, customStart, customEnd, weekStart]);
  const fromIso = useMemo(() => range.start.toISOString().slice(0, 10), [range]);
  const toIso   = useMemo(() => range.end.toISOString().slice(0, 10),   [range]);

  // Data
  const [buckets, setBuckets] = useState<ExpenseBucketSummary[]>([]);
  const [rows, setRows]       = useState<LedgerRow[]>([]);
  // Non-null when the server truncated the window (value = true row count).
  const [truncatedTotal, setTruncatedTotal] = useState<number | null>(null);
  const [assets, setAssets]   = useState<Asset[]>([]);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);

  // Rail selection (deep links: ?bucketId=<uuid> or legacy ?category=uncategorized)
  const [selected, setSelected] = useState<RailSelection>(() => {
    const b = searchParams?.get('bucketId');
    const c = searchParams?.get('category');
    if (b === 'uncategorized' || c === 'uncategorized') return 'uncategorized';
    return b || 'all';
  });

  // Panel + Manage menu
  const [panel, setPanel]         = useState<PanelMode | null>(null);
  const [menuOpen, setMenuOpen]   = useState(false);
  const [syncMsg, setSyncMsg]     = useState<string | null>(null);
  const [syncBusy, setSyncBusy]   = useState(false);

  const reload = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    setErr(null);
    try {
      invalidateBucketCache();
      const [summary, ledger] = await Promise.all([
        railway.getExpensesSummary({ from: fromIso, to: toIso }),
        railway.getExpensesLedger({ from: fromIso, to: toIso, limit: 20000 }),
      ]);
      setBuckets(summary.buckets);
      setRows(ledger.rows);
      setTruncatedTotal(ledger.total > ledger.rows.length ? ledger.total : null);
    } catch (e) {
      console.error('[expenses] load failed:', e);
      setErr('Failed to load expenses.');
    } finally {
      setLoading(false);
    }
  }, [fromIso, toIso]);
  useEffect(() => { void reload(); }, [reload]);

  // Period revenue — same endpoint + same reduction the dashboard uses
  // (total_billable per load, relay-deduped), EXCEPT owner-op loads are
  // kept in (includeExcluded below): this meter is whole-business, the
  // dashboard is operations. The two intentionally differ by exactly
  // the excluded drivers'/trucks' revenue. Null while loading / on
  // error → the bar hides rather than showing a wrong zero.
  const [revenue, setRevenue] = useState<number | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setRevenue(null);
    setRevenueLoading(true);
    (async () => {
      try {
        // includeExcluded: this meter is a whole-business snapshot, so
        // owner-op loads (excluded from operations reports) count here —
        // their vendor cost sits in the expense buckets, so their revenue
        // must sit in this number. The dashboard stays exclusions-on.
        const { loads } = await railway.listLoadSummaries({
          pickupFrom:      `${fromIso}T00:00`,
          pickupTo:        `${toIso}T23:59`,
          limit:           '10000',
          includeExcluded: '1',
        });
        if (cancelled) return;
        const total = (loads as LoadSummary[]).reduce((s, l) => {
          if (l.totalBillable != null) return s + l.totalBillable;
          const accessorials = (l.accessorials ?? [])
            .reduce((acc, a) => acc + (a.billable ? (a.amount ?? 0) : 0), 0);
          return s + (l.loadPrice ?? 0) + accessorials;
        }, 0);
        setRevenue(total);
      } catch (e) {
        console.error('[expenses] revenue fetch failed:', e);
        if (!cancelled) setRevenue(null);
      } finally {
        if (!cancelled) setRevenueLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fromIso, toIso]);

  // Equipment fixtures for the detail panel's asset dropdown — once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, t] = await Promise.all([railway.listAssets(), railway.listTrailers()]);
        if (cancelled) return;
        setAssets(a.assets as Asset[]);
        setTrailers(t.trailers as unknown as Trailer[]);
      } catch (e) {
        console.error('[expenses] fixtures fetch failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── rail derived data ─────────────────────────────────────────────
  const realBuckets = useMemo(
    () => buckets.filter(b => b.bucketId !== UNCATEGORIZED_BUCKET_ID),
    [buckets]);
  const uncat = useMemo(
    () => buckets.find(b => b.bucketId === UNCATEGORIZED_BUCKET_ID) ?? null,
    [buckets]);
  const grandTotal     = realBuckets.reduce((s, b) => s + b.total, 0);
  const grandPrevTotal = realBuckets.reduce((s, b) => s + b.prevTotal, 0);

  /** bucketId → set of ids the rail selection covers (self + children). */
  const coveredIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const top of realBuckets) {
      const ids = new Set<string>([top.bucketId as string]);
      for (const c of top.children ?? []) ids.add(c.bucketId as string);
      m.set(top.bucketId as string, ids);
      for (const c of top.children ?? []) m.set(c.bucketId as string, new Set([c.bucketId as string]));
    }
    return m;
  }, [realBuckets]);

  // One color per top-level bucket, fixed by rail position so a bucket
  // keeps its color as others come and go. A user-set bucket.color
  // always wins; buckets past the palette get the neutral fold color.
  const bucketColorById = useMemo(() => {
    const m = new Map<string, string>();
    realBuckets.forEach((b, i) => {
      m.set(b.bucketId as string, b.color || BUCKET_BAR_PALETTE[i] || OTHER_SEGMENT_COLOR);
    });
    return m;
  }, [realBuckets]);

  // Bar segments — one per top-level bucket; zero-amount buckets drop
  // out after color assignment so a quiet week doesn't repaint the
  // survivors. Buckets past the palette fold into "Other".
  const barSegments = useMemo(() => {
    const colored = realBuckets.map((b, i) => ({
      label:  b.name,
      amount: b.total,
      color:  bucketColorById.get(b.bucketId as string) ?? OTHER_SEGMENT_COLOR,
      overflow: i >= BUCKET_BAR_PALETTE.length && !b.color,
    }));
    const kept  = colored.filter(s => !s.overflow && s.amount > 0);
    const other = colored.filter(s => s.overflow && s.amount > 0);
    if (other.length) {
      kept.push({
        label:  'Other',
        amount: other.reduce((s, x) => s + x.amount, 0),
        color:  OTHER_SEGMENT_COLOR,
        overflow: false,
      });
    }
    return kept.map(({ label, amount, color }) => ({ label, amount, color }));
  }, [realBuckets, bucketColorById]);

  // Pie slices — same entities + colors as the bar, ranked descending
  // so the donut reads largest-first from 12 o'clock.
  const pieSlices = useMemo(() =>
    realBuckets
      .filter(b => b.total > 0)
      .map(b => ({
        bucketId: b.bucketId as string,
        label:    b.name,
        value:    b.total,
        color:    bucketColorById.get(b.bucketId as string) ?? OTHER_SEGMENT_COLOR,
      }))
      .sort((a, b) => b.value - a.value),
  [realBuckets, bucketColorById]);

  // Top expense categories — leaf-level spend so nothing double-counts:
  // every sub-bucket is a category, and a parent's spend NOT in any
  // sub-bucket appears once under the parent's own name. Colored by the
  // parent bucket so identity matches the bar/pie/rail.
  const topCategories = useMemo(() => {
    const rows: Array<{ bucketId: string; label: string; title: string; amount: number; color: string }> = [];
    for (const top of realBuckets) {
      const color = bucketColorById.get(top.bucketId as string) ?? OTHER_SEGMENT_COLOR;
      const kids = top.children ?? [];
      const kidsTotal = kids.reduce((s, k) => s + k.total, 0);
      const self = top.total - kidsTotal;
      if (self > 0) {
        rows.push({
          bucketId: top.bucketId as string,
          label: top.name, title: top.name,
          amount: self, color,
        });
      }
      for (const k of kids) {
        if (k.total <= 0) continue;
        rows.push({
          bucketId: k.bucketId as string,
          label: k.name, title: `${top.name} → ${k.name}`,
          amount: k.total, color,
        });
      }
    }
    return rows.sort((a, b) => b.amount - a.amount).slice(0, 10);
  }, [realBuckets, bucketColorById]);

  const selectedSummary = useMemo(() => {
    if (selected === 'all' || selected === 'uncategorized') return null;
    for (const top of realBuckets) {
      if (top.bucketId === selected) return top;
      const child = (top.children ?? []).find(c => c.bucketId === selected);
      if (child) return child;
    }
    return null;
  }, [selected, realBuckets]);

  // ── ledger filtering ──────────────────────────────────────────────
  const visibleRows = useMemo(() => {
    if (selected === 'all') return rows;
    if (selected === 'uncategorized') return rows.filter(r => !r.bucketId);
    const covered = coveredIds.get(selected);
    if (!covered) return rows;
    return rows.filter(r => r.bucketId && covered.has(r.bucketId));
  }, [rows, selected, coveredIds]);

  const stripTotal = selected === 'all' ? grandTotal
    : selected === 'uncategorized' ? (uncat?.total ?? 0)
    : (selectedSummary?.total ?? 0);
  const stripPrev  = selected === 'all' ? grandPrevTotal
    : selected === 'uncategorized' ? 0
    : (selectedSummary?.prevTotal ?? 0);
  const stripLabel = selected === 'all' ? 'Total spend'
    : selected === 'uncategorized' ? 'Uncategorized card spend'
    : selectedSummary?.name ?? 'Bucket';

  // ── inline bucket change from the ledger ──────────────────────────
  // Patches the row in place and refreshes only the rail summary —
  // replacing the whole rows array would bounce OpsTable's pagination
  // and scroll position on every re-bucket.
  const bucketNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const top of buckets) {
      m.set(top.bucketId as string, top.name);
      for (const c of top.children ?? []) m.set(c.bucketId as string, c.name);
    }
    return m;
  }, [buckets]);

  const changeRowBucket = useCallback(async (row: LedgerRow, bucketId: string) => {
    try {
      if (row.source === 'ramp') {
        await railway.setRampTransactionBucket(row.refId, bucketId || null);
      } else if (row.source === 'entry') {
        if (!bucketId) return; // entries must have a bucket
        await railway.updateExpenseEntry(row.refId, { bucketId });
      }
      setRows(prev => prev.map(x => x.rowKey === row.rowKey
        ? { ...x, bucketId: bucketId || null, bucketName: bucketNameById.get(bucketId) ?? null }
        : x));
      const summary = await railway.getExpensesSummary({ from: fromIso, to: toIso });
      setBuckets(summary.buckets);
    } catch {
      alert('Failed to update bucket.');
    }
  }, [bucketNameById, fromIso, toIso]);

  const runSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const r = await railway.runRampSync();
      if (r.skipped)       setSyncMsg(`Skipped (${r.reason ?? 'no credentials'})`);
      else if (r.result)   setSyncMsg(`Synced ${r.result.fetched} · ${r.result.inserted} new`);
      else                 setSyncMsg('Sync complete');
      await reload({ silent: true });
    } catch {
      setSyncMsg('Sync failed');
    } finally {
      setSyncBusy(false);
    }
  }, [reload]);

  // Unit labels for the tag chip — trucks by assets.name, trailers by
  // #trailerNumber. Comes from the memo matcher's asset link.
  const assetLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of assets) m.set(a.id, a.name);
    return m;
  }, [assets]);
  const trailerLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of trailers) m.set(t.id, t.trailerNumber ? `#${t.trailerNumber}` : t.name);
    return m;
  }, [trailers]);

  const unitTag = useCallback((r: LedgerRow): string | null => {
    if (r.assetId != null)   return assetLabelById.get(r.assetId)     ?? `Truck ${r.assetId}`;
    if (r.trailerId != null) return trailerLabelById.get(r.trailerId) ?? `Trailer ${r.trailerId}`;
    return null;
  }, [assetLabelById, trailerLabelById]);

  // ── ledger columns ────────────────────────────────────────────────
  const columns: OpsColumn<LedgerRow>[] = useMemo(() => [
    {
      key: 'date', header: 'Date', width: 104,
      sortable: true, sortValue: r => r.date,
      render: r => <OpsDate iso={`${r.date}T12:00:00Z`} />,
    },
    {
      key: 'description', header: 'Description',
      sortable: true, sortValue: r => r.description,
      render: r => {
        const tag = unitTag(r);
        return (
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate" style={{ color: 'var(--gc-text-1)' }}>{r.description}</span>
            {tag && (
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums whitespace-nowrap"
                    style={{
                      background: r.trailerId != null ? '#ede9fe' : '#e0f2fe',
                      color:      r.trailerId != null ? '#6d28d9' : '#0369a1',
                    }}
                    title={r.trailerId != null ? 'Trailer (from memo match)' : 'Truck (from memo match)'}>
                {tag}
              </span>
            )}
          </span>
        );
      },
      subRender: r => r.sub
        ? <span style={{ color: 'var(--gc-text-3)' }}>{r.sub}</span>
        : null,
    },
    {
      key: 'source', header: 'Source', width: 104,
      sortable: true, sortValue: r => r.source,
      render: r => <SourcePill source={r.source} />,
    },
    {
      key: 'bucket', header: 'Bucket', width: 210,
      sortable: true, sortValue: r => r.bucketName ?? '',
      render: r => r.bucketEditable ? (
        <div onClick={e => e.stopPropagation()}>
          <BucketSelect
            value={r.bucketId ?? ''}
            onChange={id => void changeRowBucket(r, id)}
            includeUncategorized={r.source === 'ramp'}
            style={{ minWidth: 180, fontSize: 12 }}
          />
        </div>
      ) : (
        <span className="text-xs" style={{ color: 'var(--gc-text-2)' }}>
          {r.bucketName ?? <span style={{ color: '#b45309' }}>no bucket — set a system role</span>}
        </span>
      ),
    },
    {
      key: 'amount', header: 'Amount', width: 110, align: 'right',
      sortable: true, sortValue: r => r.amount,
      render: r => (
        <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          {fmtMoney2(r.amount)}
        </span>
      ),
    },
  ], [changeRowBucket, unitTag]);

  const filters: OpsFilter<LedgerRow>[] = useMemo(() => [
    {
      kind: 'search',
      placeholder: 'Search description, memo, driver…',
      width: 260,
      match: (r, q) => {
        const t = q.toLowerCase();
        return r.description.toLowerCase().includes(t)
          || (r.sub?.toLowerCase().includes(t) ?? false)
          || (r.bucketName?.toLowerCase().includes(t) ?? false);
      },
    },
    {
      kind: 'select',
      key: 'source',
      label: 'Source',
      options: [
        { value: 'all', label: 'All sources' },
        ...(Object.keys(SOURCE_META) as LedgerSource[]).map(s => ({
          value: s, label: SOURCE_META[s].label,
        })),
      ],
      defaultValue: 'all',
      predicate: (r, v) => v === 'all' ? true : r.source === v,
    },
  ], []);

  // ── render ────────────────────────────────────────────────────────
  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-4 flex items-start justify-between gap-4"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div>
            <h1 className="text-[22px] font-semibold leading-tight" style={{ color: 'var(--gc-text-1)' }}>
              Expenses
            </h1>
            <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {new Date(range.start).toLocaleDateString([], { month: 'long', day: 'numeric' })}
              {' – '}
              {new Date(range.end).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPanel({ kind: 'create' })}
              className="text-xs font-semibold px-3 py-1.5 rounded inline-flex items-center gap-1.5"
              style={{ background: '#1a73e8', color: '#fff' }}>
              <Plus size={14} /> Expense
            </button>
            <div className="relative">
              <button
                onClick={() => setMenuOpen(o => !o)}
                className="text-xs font-semibold px-3 py-1.5 rounded border inline-flex items-center gap-1.5"
                style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}>
                <Settings2 size={14} /> Manage <ChevronDown size={12} />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0" style={{ zIndex: 40 }} onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 rounded-lg border overflow-hidden"
                       style={{
                         zIndex: 41, minWidth: 220,
                         borderColor: 'var(--gc-border)', background: 'var(--gc-surface)',
                         boxShadow: 'var(--shadow-2, 0 8px 24px rgba(0,0,0,0.15))',
                       }}>
                    <MenuItem icon={<FolderTree size={14} />} label="Manage buckets"
                              onClick={() => { setMenuOpen(false); router.push('/expenses/buckets'); }} />
                    <MenuItem icon={<Repeat size={14} />} label="Recurring rules"
                              onClick={() => { setMenuOpen(false); router.push('/expenses/recurring'); }} />
                    <MenuItem icon={<Wand2 size={14} />} label="Card auto-file rules"
                              onClick={() => { setMenuOpen(false); router.push('/expenses/rules'); }} />
                    <MenuItem icon={<RefreshCw size={14} />}
                              label={syncBusy ? 'Syncing Ramp…' : 'Sync Ramp now'}
                              onClick={() => { if (!syncBusy) void runSync(); }} />
                    {syncMsg && (
                      <div className="px-3 py-2 text-xs" style={{ color: 'var(--gc-text-3)' }}>{syncMsg}</div>
                    )}
                  </div>
                </>
              )}
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
        </div>

        {/* Rail + ledger */}
        <div className="flex-1 min-h-0 flex">
          <aside className="shrink-0 overflow-y-auto py-3 flex flex-col"
                 style={{ width: 236, borderRight: '1px solid var(--gc-border)' }}>
            <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider"
                 style={{ color: 'var(--gc-text-3)' }}>
              Buckets
            </div>
            <div className="flex-1">
              <RailRow label="All expenses" total={grandTotal}
                       selected={selected === 'all'} onClick={() => setSelected('all')} />
              {realBuckets.map(top => (
                <div key={top.bucketId}>
                  <RailRow
                    label={top.name}
                    total={top.total}
                    selected={selected === top.bucketId}
                    onClick={() => setSelected(top.bucketId as string)}
                  />
                  {(top.children ?? []).map(child => (
                    <RailRow
                      key={child.bucketId}
                      label={child.name}
                      total={child.total}
                      indent
                      selected={selected === child.bucketId}
                      onClick={() => setSelected(child.bucketId as string)}
                    />
                  ))}
                </div>
              ))}
              {uncat && uncat.count > 0 && (
                <div className="mt-2 pt-2" style={{ borderTop: '1px dashed var(--gc-border)' }}>
                  <RailRow
                    label="Uncategorized"
                    total={uncat.total}
                    count={uncat.count}
                    amber
                    selected={selected === 'uncategorized'}
                    onClick={() => setSelected('uncategorized')}
                  />
                </div>
              )}
            </div>
            <button
              onClick={() => router.push('/expenses/buckets')}
              className="mx-3 mt-3 text-xs font-semibold px-2 py-1.5 rounded border text-center"
              style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-3)' }}>
              Edit buckets
            </button>
          </aside>

          <main className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
            <div className="mb-4 flex items-baseline gap-3">
              <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                {stripLabel}
              </span>
              <span className="text-[28px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                {fmtMoney0(stripTotal)}
              </span>
              <DeltaChip current={stripTotal} previous={stripPrev} />
              <span className="text-xs ml-auto" style={{ color: 'var(--gc-text-3)' }}>
                {visibleRows.length} row{visibleRows.length === 1 ? '' : 's'} in period
              </span>
            </div>

            {err && (
              <div className="rounded-lg border p-4 mb-4 text-sm"
                   style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
                {err}
              </div>
            )}

            {truncatedTotal != null && (
              <div className="rounded-lg border p-3 mb-4 text-sm"
                   style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}>
                This period has {truncatedTotal.toLocaleString()} expenses — showing the most
                recent {rows.length.toLocaleString()}. Older rows are hidden; narrow the period
                to see everything. (Bucket totals above are NOT affected — they always cover
                the full period.)
              </div>
            )}

            {revenueLoading || (loading && buckets.length === 0) ? (
              <MeterSkeleton />
            ) : revenue != null && revenue > 0 && barSegments.length > 0 ? (
              <div className="rounded-lg border px-4 pt-3 pb-4 mb-5"
                   style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
                <div className="text-[11px] font-bold uppercase tracking-wider mb-3"
                     style={{ color: 'var(--gc-text-3)' }}>
                  Revenue vs expenses — this period
                </div>
                <CostBar revenue={revenue} segments={barSegments} />
              </div>
            ) : null}

            {loading && buckets.length === 0 ? (
              <ChartsSkeleton />
            ) : pieSlices.length > 0 && (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
                {/* Expenses by bucket — donut + ranked list, same idiom
                    (and same component) as the dashboard's Revenue by
                    Customer card. Rows click through to the rail filter. */}
                <div className="rounded-lg border p-5"
                     style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
                  <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--gc-text-1)' }}>
                    Expenses by Bucket
                  </h2>
                  <div className="flex gap-6 items-center">
                    <div className="shrink-0" style={{ overflow: 'visible' }}>
                      <PieChart
                        size={190}
                        slices={pieSlices.map(s => ({ value: s.value, color: s.color, label: s.label }))}
                      />
                    </div>
                    <div className="space-y-2 flex-1 min-w-0">
                      {pieSlices.map((s, i) => (
                        <div key={s.bucketId}
                          className="flex items-center gap-2 rounded-lg px-1.5 py-0.5 -mx-1.5 transition-colors cursor-pointer"
                          title={`Filter ledger to ${s.label}`}
                          onClick={() => setSelected(s.bucketId)}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover, rgba(0,0,0,0.04))'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                          <span className="text-[11px] font-medium shrink-0 w-4 text-right" style={{ color: 'var(--gc-text-3)' }}>
                            {i + 1}
                          </span>
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                          <span className="text-[13px] truncate flex-1 min-w-0" style={{ color: 'var(--gc-text-2)' }}>
                            {s.label}
                          </span>
                          <span className="text-[13px] font-semibold shrink-0 tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                            {fmtMoney0(s.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Top expense categories — ranked label|bar|value rows,
                    same idiom as the dashboard's Revenue by Truck card.
                    Leaf-level amounts (sub-buckets + each parent's own
                    unbucketed spend) so nothing double-counts. */}
                <div className="rounded-lg border p-5"
                     style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
                  <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--gc-text-1)' }}>
                    Top Expense Categories
                  </h2>
                  {topCategories.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-sm" style={{ color: 'var(--gc-text-3)' }}>
                      No expenses in this period
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {topCategories.map(cat => {
                        const max = topCategories[0].amount;
                        const pct = max > 0 ? (cat.amount / max) * 100 : 0;
                        return (
                          <div key={cat.bucketId}
                            className="flex items-center gap-3 cursor-pointer"
                            title={`${cat.title} — filter ledger`}
                            onClick={() => setSelected(cat.bucketId)}>
                            <div className="w-[130px] shrink-0 text-[13px] truncate font-medium"
                                 style={{ color: 'var(--gc-text-1)' }}>
                              {cat.label}
                            </div>
                            <div className="flex-1 h-5 relative flex items-center">
                              <div style={{
                                width: `${Math.max(pct, 1)}%`,
                                height: 7,
                                background: cat.color,
                                borderRadius: 3,
                              }} />
                            </div>
                            <div className="w-[80px] shrink-0 text-right text-[13px] font-semibold tabular-nums"
                                 style={{ color: 'var(--gc-text-1)' }}>
                              {fmtMoney0(cat.amount)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            <OpsTable<LedgerRow>
              columns={columns}
              data={visibleRows}
              filters={filters}
              loading={loading}
              rowKey={r => r.rowKey}
              onRowClick={r => setPanel({ kind: 'row', row: r })}
              emptyLabel={selected === 'uncategorized'
                ? 'Nothing to categorize in this period. Nice.'
                : 'No expenses in this period for this bucket.'}
              defaultSort={{ key: 'date', dir: 'desc' }}
              density="compact"
              countLabel="expense"
              pageSize={50}
            />
          </main>
        </div>
      </div>

      {panel && (
        <ExpenseDetailPanel
          mode={panel}
          assets={assets}
          trailers={trailers}
          onClose={() => setPanel(null)}
          onMutated={() => void reload({ silent: true })}
        />
      )}
    </AppShell>
  );
}

// ── loading skeletons ───────────────────────────────────────────────────
//
// Shape-matched placeholders so the analytics band doesn't pop in late
// and shove the ledger down — especially the revenue meter, whose data
// (the loads report) is the slowest fetch on the page.

const skeletonBlock = { background: 'var(--gc-surface-2, #f3f4f6)' } as const;

function MeterSkeleton() {
  return (
    <div className="rounded-lg border px-4 pt-3 pb-4 mb-5 animate-pulse"
         style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
      <div className="h-3 w-56 rounded mb-3" style={skeletonBlock} />
      <div className="h-12 rounded-md" style={skeletonBlock} />
      <div className="mt-3 flex items-center gap-5">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="h-3 rounded" style={{ ...skeletonBlock, width: 90 }} />
        ))}
      </div>
    </div>
  );
}

function ChartsSkeleton() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5 animate-pulse">
      <div className="rounded-lg border p-5"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="h-3 w-40 rounded mb-4" style={skeletonBlock} />
        <div className="flex gap-6 items-center">
          <div className="shrink-0 rounded-full" style={{ ...skeletonBlock, width: 190, height: 190 }} />
          <div className="flex-1 space-y-2.5">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-3.5 rounded" style={skeletonBlock} />
            ))}
          </div>
        </div>
      </div>
      <div className="rounded-lg border p-5"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="h-3 w-44 rounded mb-4" style={skeletonBlock} />
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-3.5 rounded shrink-0" style={{ ...skeletonBlock, width: 130 }} />
              <div className="h-2 rounded flex-1" style={skeletonBlock} />
              <div className="h-3.5 rounded shrink-0" style={{ ...skeletonBlock, width: 60 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-left hover:bg-black/5"
      style={{ color: 'var(--gc-text-1)' }}>
      {icon} {label}
    </button>
  );
}

export default function ExpensesPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <ExpensesPageInner />
    </RequireCap>
  );
}
