'use client';

/**
 * /expenses — cross-source expenses dashboard.
 *
 * Tiles are dynamic: one per top-level expense_buckets row. Icons come
 * from bucket.icon (lucide-react component name); we resolve them via
 * a lookup below. When a name doesn't resolve, we fall back to a
 * generic icon.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Icons from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import {
  currentWeekStartISO, getPeriodRange, type Period,
} from '@/lib/periodRange';
import { railway } from '@/lib/railway';
import type { ExpenseBucketSummary, ExpenseEvent } from '@fleetcal/types';
import { UNCATEGORIZED_BUCKET_ID } from '@fleetcal/types';

const fmtMoney0 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);

const fmtMoney2 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);

// Resolve a lucide icon name (string) to its component. Anything that
// doesn't resolve falls back to CreditCard.
function resolveIcon(name?: string | null): React.ComponentType<{ size?: number; strokeWidth?: number }> {
  if (!name) return Icons.CreditCard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconMap = Icons as unknown as Record<string, any>;
  const c = iconMap[name];
  return (typeof c === 'function' || (c && typeof c === 'object')) ? c : Icons.CreditCard;
}

function DeltaChip({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) {
    return <span style={{ color: 'var(--gc-text-3)' }} className="text-xs">no data</span>;
  }
  if (previous === 0) {
    return (
      <span className="text-xs inline-flex items-center gap-0.5 font-semibold" style={{ color: '#166534' }}>
        <Icons.ArrowUpRight size={12} strokeWidth={2.4} />new
      </span>
    );
  }
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct);
  const up = rounded > 0;
  const flat = rounded === 0;
  const color = flat ? 'var(--gc-text-3)' : up ? '#b91c1c' : '#166534';
  const Icon  = flat ? Icons.ArrowRight : up ? Icons.ArrowUpRight : Icons.ArrowDownRight;
  return (
    <span className="text-xs inline-flex items-center gap-0.5 font-semibold tabular-nums" style={{ color }}>
      <Icon size={12} strokeWidth={2.4} />{Math.abs(rounded)}% vs prev
    </span>
  );
}

function bucketHref(b: ExpenseBucketSummary): string {
  if (b.bucketId === UNCATEGORIZED_BUCKET_ID) {
    return '/expenses/cards?category=uncategorized';
  }
  if (b.systemRole === 'driver_pay')  return '/payroll';
  if (b.systemRole === 'mudflap_fuel') return '/equipment?tab=fuel';
  // Generic drill-in: /expenses/cards filtered to this bucket lets you
  // see every categorized txn / entry that landed here.
  return `/expenses/cards?bucketId=${b.bucketId}`;
}

function BucketTile({ bucket, onClick }: { bucket: ExpenseBucketSummary; onClick: () => void }) {
  const Icon = resolveIcon(bucket.icon);
  const isUncat = bucket.bucketId === UNCATEGORIZED_BUCKET_ID;
  return (
    <button
      onClick={onClick}
      className="text-left flex flex-col gap-2 p-5 rounded-xl border transition-colors hover:shadow-sm"
      style={{
        borderColor: isUncat ? '#f59e0b' : (bucket.color || 'var(--gc-border)'),
        background:  isUncat ? '#fffbeb' : 'var(--gc-surface)',
        cursor:      'pointer',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"
             style={{ color: isUncat ? '#b45309' : 'var(--gc-text-2)' }}>
          <Icon size={16} strokeWidth={2.2} />
          <span className="text-[11px] font-bold uppercase tracking-wider">{bucket.name}</span>
        </div>
        <span style={{ color: isUncat ? '#f59e0b' : 'var(--gc-text-3)' }}>
          <Icons.ArrowRight size={14} />
        </span>
      </div>
      <div className="text-[24px] font-semibold tabular-nums leading-none"
           style={{ color: isUncat ? '#b45309' : 'var(--gc-text-1)' }}>
        {fmtMoney0(bucket.total)}
      </div>
      <div className="flex items-center gap-3">
        {!isUncat && <DeltaChip current={bucket.total} previous={bucket.prevTotal} />}
        <span className="text-xs" style={{ color: isUncat ? '#b45309' : 'var(--gc-text-3)' }}>
          {isUncat
            ? `${bucket.count} to categorize`
            : `${bucket.count} ${bucket.count === 1 ? 'item' : 'items'}`}
        </span>
      </div>
      {bucket.children && bucket.children.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]"
             style={{ color: 'var(--gc-text-3)' }}>
          {bucket.children.filter(c => c.total > 0).slice(0, 4).map(c => (
            <span key={c.bucketId} className="tabular-nums">
              {c.name} <span style={{ color: 'var(--gc-text-2)' }}>{fmtMoney0(c.total)}</span>
            </span>
          ))}
        </div>
      )}
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
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: `${sourceColor(e.source)}22`, color: sourceColor(e.source) }}>
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

  const [buckets, setBuckets]   = useState<ExpenseBucketSummary[]>([]);
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

  const primaryBuckets = buckets.filter(b => b.bucketId !== UNCATEGORIZED_BUCKET_ID);
  const total     = primaryBuckets.reduce((acc, b) => acc + b.total, 0);
  const prevTotal = primaryBuckets.reduce((acc, b) => acc + b.prevTotal, 0);

  const gridCols = buckets.length <= 4 ? 'lg:grid-cols-4'
                 : buckets.length <= 6 ? 'lg:grid-cols-3'
                 : 'lg:grid-cols-4';

  return (
    <AppShell>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-6" style={{ maxWidth: 1400 }}>
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
                onClick={() => router.push('/expenses/buckets')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)', background:  'var(--gc-surface)',
                  color: 'var(--gc-text-2)',
                }}
                title="Add / edit / reorder the bucket tree"
              >
                Buckets
              </button>
              <button
                onClick={() => router.push('/expenses/one-time')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)', background:  'var(--gc-surface)',
                  color: 'var(--gc-text-2)',
                }}
              >
                One-time
              </button>
              <button
                onClick={() => router.push('/expenses/recurring')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)', background:  'var(--gc-surface)',
                  color: 'var(--gc-text-2)',
                }}
              >
                Recurring
              </button>
              <button
                onClick={() => router.push('/expenses/rules')}
                className="text-xs font-semibold px-3 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)', background:  'var(--gc-surface)',
                  color: 'var(--gc-text-2)',
                }}
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

          <div className="mb-4 flex items-baseline gap-3">
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
              Total spend
            </span>
            <span className="text-[32px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
              {fmtMoney0(total)}
            </span>
            <DeltaChip current={total} previous={prevTotal} />
          </div>

          <div className={`grid grid-cols-1 sm:grid-cols-2 ${gridCols} gap-3 mb-8`}>
            {loading && buckets.length === 0
              ? Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="h-[128px] rounded-xl border animate-pulse"
                       style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)' }} />
                ))
              : buckets.map(b => (
                  <BucketTile
                    key={b.bucketId}
                    bucket={b}
                    onClick={() => router.push(bucketHref(b))}
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

          {!loading && buckets.length === 0 && !err && (
            <div className="rounded-lg border p-8 text-center mb-6"
                 style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#92400e' }}>
              No buckets configured yet. <a href="/expenses/buckets" style={{ textDecoration: 'underline' }}>Create your first bucket</a> to start tracking expenses.
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
