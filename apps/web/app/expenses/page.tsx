'use client';

/**
 * /expenses — cross-source expenses dashboard.
 *
 * Federated view over fuel_transactions + payroll_records +
 * ramp_transactions. New sources become new API queries + a new tile
 * here; no data pipe. See apps/api/src/routes/expenses.ts for the
 * rollup logic.
 *
 * Deep links from tiles go to each bucket's existing detail surface:
 *   Fuel    → /equipment?tab=fuel
 *   Payroll → /payroll
 *   Cards   → /expenses/cards (this page's sibling)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Users, Truck, Building2, ShieldCheck, Cpu, Wrench, Landmark, HandCoins,
  ArrowUpRight, ArrowDownRight, ArrowRight, CreditCard,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import {
  currentWeekStartISO, getPeriodRange, type Period,
} from '@/lib/periodRange';
import { railway } from '@/lib/railway';
import type { ExpenseBucket, ExpenseEvent, SummaryBucketKey } from '@fleetcal/types';

const fmtMoney0 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);

const fmtMoney2 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return <span style={{ color: 'var(--gc-text-3)' }} className="text-xs">no data</span>;
  }
  if (previous === 0) {
    return (
      <span className="text-xs inline-flex items-center gap-0.5 font-semibold" style={{ color: '#166534' }}>
        <ArrowUpRight size={12} strokeWidth={2.4} />new
      </span>
    );
  }
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct);
  const up = rounded > 0;
  const flat = rounded === 0;
  const color = flat ? 'var(--gc-text-3)' : up ? '#b91c1c' : '#166534';
  const Icon  = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="text-xs inline-flex items-center gap-0.5 font-semibold tabular-nums" style={{ color }}>
      <Icon size={12} strokeWidth={2.4} />{Math.abs(rounded)}% vs prev
    </span>
  );
}

const BUCKET_ICONS: Partial<Record<SummaryBucketKey, React.ComponentType<{ size?: number; strokeWidth?: number }>>> = {
  payroll_people:    Users,
  fleet_ops:         Truck,
  facilities:        Building2,
  insurance_claims:  ShieldCheck,
  software_overhead: Cpu,
  capex:             Wrench,
  taxes:             Landmark,
  owner_draws:       HandCoins,
  uncategorized:     CreditCard,
};

const BUCKET_HREFS: Record<SummaryBucketKey, string> = {
  payroll_people:    '/payroll',
  fleet_ops:         '/equipment?tab=fuel',
  facilities:        '/expenses/recurring',
  insurance_claims:  '/expenses/recurring',
  software_overhead: '/expenses/recurring',
  capex:             '/expenses/one-time',
  taxes:             '/expenses/one-time',
  owner_draws:       '/expenses/one-time',
  uncategorized:     '/expenses/cards?category=uncategorized',
} as const;

function countLabel(bucket: ExpenseBucket): string {
  const n = bucket.count;
  const unit =
    bucket.key === 'payroll_people' ? (n === 1 ? 'event'    : 'events') :
    bucket.key === 'fleet_ops'      ? (n === 1 ? 'txn'      : 'txns') :
    bucket.key === 'facilities'     ? (n === 1 ? 'rule'     : 'rules') :
                                      (n === 1 ? 'entry'    : 'entries');
  return `${n} ${unit}`;
}

function BucketTile({ bucket, onClick }: { bucket: ExpenseBucket; onClick: () => void }) {
  const Icon = BUCKET_ICONS[bucket.key] ?? CreditCard;
  const isUncat = bucket.key === 'uncategorized';
  // Tile breakdowns removed intentionally: the taxonomy under each
  // bucket is now free-text (per-org), so we can't compute clean
  // sub-slices from the summary shape. Users drill into the bucket
  // (via the tile click) to see the actual entries.
  const breakdown: null = null;

  return (
    <button
      onClick={onClick}
      className="text-left flex flex-col gap-2 p-5 rounded-xl border transition-colors hover:shadow-sm"
      style={{
        borderColor: isUncat ? '#f59e0b' : 'var(--gc-border)',
        background:  isUncat ? '#fffbeb' : 'var(--gc-surface)',
        cursor:      'pointer',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"
             style={{ color: isUncat ? '#b45309' : 'var(--gc-text-2)' }}>
          <Icon size={16} strokeWidth={2.2} />
          <span className="text-[11px] font-bold uppercase tracking-wider">{bucket.label}</span>
        </div>
        <span style={{ color: isUncat ? '#f59e0b' : 'var(--gc-text-3)' }}>
          <ArrowRight size={14} />
        </span>
      </div>
      <div className="text-[24px] font-semibold tabular-nums leading-none"
           style={{ color: isUncat ? '#b45309' : 'var(--gc-text-1)' }}>
        {fmtMoney0(bucket.total)}
      </div>
      <div className="flex items-center gap-3">
        {!isUncat && <DeltaChip current={bucket.total} previous={bucket.prevTotal} />}
        <span className="text-xs" style={{ color: isUncat ? '#b45309' : 'var(--gc-text-3)' }}>
          {isUncat ? `${bucket.count} to categorize` : countLabel(bucket)}
        </span>
      </div>
    </button>
  );
}

function sourceLabel(s: ExpenseEvent['source']): string {
  return s === 'fuel' ? 'Fuel' : s === 'payroll' ? 'Payroll' : 'Card';
}
function sourceColor(s: ExpenseEvent['source']): string {
  return s === 'fuel' ? '#0891b2' : s === 'payroll' ? '#7c3aed' : '#059669';
}

function ActivityFeed({ events }: { events: ExpenseEvent[] }) {
  const router = useRouter();
  if (events.length === 0) {
    return (
      <div className="rounded-lg border p-6 text-center text-sm"
           style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}>
        No expense activity in this period.
      </div>
    );
  }
  return (
    <div className="rounded-lg border overflow-hidden"
         style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
      <div className="px-4 py-3 border-b flex items-center justify-between"
           style={{ borderColor: 'var(--gc-border)' }}>
        <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          Latest activity
        </div>
        <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{events.length} events</div>
      </div>
      <div>
        {events.map(e => (
          <button
            key={`${e.source}-${e.id}`}
            onClick={() => e.href && router.push(e.href)}
            className="w-full text-left flex items-center gap-3 px-4 py-2.5 border-b transition-colors hover:bg-black/[0.02]"
            style={{ borderColor: 'var(--gc-border)' }}
          >
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
              style={{ background: `${sourceColor(e.source)}22`, color: sourceColor(e.source) }}
            >
              {sourceLabel(e.source)}
            </span>
            <span className="text-xs tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
              {new Date(e.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
            </span>
            <span className="flex-1 truncate text-sm" style={{ color: 'var(--gc-text-1)' }}>
              {e.description}
              {e.driverName && (
                <span style={{ color: 'var(--gc-text-3)' }}> · {e.driverName}</span>
              )}
            </span>
            <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
              {fmtMoney2(e.amount)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExpensesPageInner() {
  const router = useRouter();
  const [period, setPeriod]           = useState<Period>('week');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd]     = useState('');
  const [weekStart, setWeekStart]     = useState<string | undefined>(undefined);

  const [buckets, setBuckets]   = useState<ExpenseBucket[]>([]);
  const [events, setEvents]     = useState<ExpenseEvent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState<string | null>(null);

  const range = useMemo(() =>
    getPeriodRange(period, {
      startISO: customStart,
      endISO:   customEnd,
      weekStartISO: weekStart ?? currentWeekStartISO(),
    }),
  [period, customStart, customEnd, weekStart]);

  const fromIso = useMemo(() => range.start.toISOString().slice(0, 10), [range]);
  const toIso   = useMemo(() => range.end.toISOString().slice(0, 10),   [range]);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [summary, activity] = await Promise.all([
        railway.getExpensesSummary({ from: fromIso, to: toIso }),
        railway.getExpensesActivity({ from: fromIso, to: toIso, limit: 20 }),
      ]);
      setBuckets(summary.buckets);
      setEvents(activity.events);
    } catch (e) {
      console.error('[expenses] load failed:', e);
      setErr('Failed to load expenses.');
      setBuckets([]);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [fromIso, toIso]);

  useEffect(() => { void reload(); }, [reload]);

  // Total ribbon excludes the "Uncategorized" CTA — that's a queue-
  // depth signal, not a spend line-item that's been decided yet.
  const primaryBuckets = buckets.filter(b => b.key !== 'uncategorized');
  const total     = primaryBuckets.reduce((acc, b) => acc + b.total, 0);
  const prevTotal = primaryBuckets.reduce((acc, b) => acc + b.prevTotal, 0);

  return (
    <AppShell>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-6" style={{ maxWidth: 1400 }}>
          {/* Header row */}
          <div className="flex items-baseline justify-between mb-6">
            <div>
              <h1 className="text-[22px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                Expenses
              </h1>
              <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                {new Date(range.start).toLocaleDateString([], { month: 'long', day: 'numeric' })}
                {' – '}
                {new Date(range.end).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/expenses/one-time')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)',
                  background:  'var(--gc-surface)',
                  color:       'var(--gc-text-2)',
                }}
                title="One-off entries — Sophia/Luis payouts, truck purchases, tax payments, claim payouts, owner draws"
              >
                One-time entries
              </button>
              <button
                onClick={() => router.push('/expenses/recurring')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)',
                  background:  'var(--gc-surface)',
                  color:       'var(--gc-text-2)',
                }}
                title="Manage weekly salaries, monthly rent, insurance, and subscriptions"
              >
                Recurring rules
              </button>
              <button
                onClick={() => router.push('/expenses/rules')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)',
                  background:  'var(--gc-surface)',
                  color:       'var(--gc-text-2)',
                }}
                title="Rules that decide which bucket a Ramp txn lands in on sync"
              >
                Ramp rules
              </button>
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

          {/* Total ribbon */}
          <div className="mb-4 flex items-baseline gap-3">
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
              Total spend
            </span>
            <span className="text-[32px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
              {fmtMoney0(total)}
            </span>
            <DeltaChip current={total} previous={prevTotal} />
          </div>

          {/* Bucket tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
            {loading && buckets.length === 0
              ? [0, 1, 2, 3, 4, 5, 6, 7].map(i => (
                  <div key={i} className="h-[128px] rounded-xl border animate-pulse"
                       style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)' }} />
                ))
              : buckets.map(b => (
                  <BucketTile
                    key={b.key}
                    bucket={b}
                    onClick={() => router.push(BUCKET_HREFS[b.key])}
                  />
                ))
            }
          </div>

          {err && (
            <div className="rounded-lg border p-4 mb-4 text-sm"
                 style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
              {err}
            </div>
          )}

          <ActivityFeed events={events} />
        </div>
      </div>
    </AppShell>
  );
}

export default function ExpensesPage() {
  return (
    <RequireCap cap="expenses.access" module="expenses">
      <ExpensesPageInner />
    </RequireCap>
  );
}
