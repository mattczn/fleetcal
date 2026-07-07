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
import { Fuel as FuelIcon, Wallet, CreditCard, ArrowUpRight, ArrowDownRight, ArrowRight } from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import {
  currentWeekStartISO, getPeriodRange, type Period,
} from '@/lib/periodRange';
import { railway } from '@/lib/railway';
import type { ExpenseBucket, ExpenseEvent } from '@fleetcal/types';

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

function BucketTile({
  bucket, icon: Icon, href, onClick, subtitle,
}: {
  bucket: ExpenseBucket;
  icon:   React.ComponentType<{ size?: number; strokeWidth?: number }>;
  href:   string;
  onClick: () => void;
  subtitle?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left flex flex-col gap-2 p-5 rounded-xl border transition-colors hover:shadow-sm"
      style={{
        borderColor: 'var(--gc-border)',
        background:  'var(--gc-surface)',
        cursor:      'pointer',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2" style={{ color: 'var(--gc-text-2)' }}>
          <Icon size={16} strokeWidth={2.2} />
          <span className="text-[11px] font-bold uppercase tracking-wider">{bucket.label}</span>
        </div>
        <span style={{ color: 'var(--gc-text-3)' }}>
          <ArrowRight size={14} />
        </span>
      </div>
      <div className="text-[24px] font-semibold tabular-nums leading-none" style={{ color: 'var(--gc-text-1)' }}>
        {fmtMoney0(bucket.total)}
      </div>
      <div className="flex items-center gap-3">
        <DeltaChip current={bucket.total} previous={bucket.prevTotal} />
        <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
          {bucket.count}{' '}
          {bucket.key === 'payroll' ? (bucket.count === 1 ? 'driver' : 'drivers') :
           bucket.key === 'fuel'    ? (bucket.count === 1 ? 'fill-up' : 'fill-ups') :
                                     (bucket.count === 1 ? 'txn' : 'txns')}
        </span>
      </div>
      {subtitle && (
        <div className="text-xs mt-1" style={{ color: '#c026d3' }}>{subtitle}</div>
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

  const bucketByKey = new Map(buckets.map(b => [b.key, b]));
  const fuel    = bucketByKey.get('fuel');
  const payroll = bucketByKey.get('payroll');
  const cards   = bucketByKey.get('cards');

  const total = buckets.reduce((acc, b) => acc + b.total, 0);
  const prevTotal = buckets.reduce((acc, b) => acc + b.prevTotal, 0);

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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
            {loading && buckets.length === 0
              ? [0, 1, 2].map(i => (
                  <div key={i} className="h-[128px] rounded-xl border animate-pulse"
                       style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface-2)' }} />
                ))
              : (
                <>
                  {fuel && (
                    <BucketTile
                      bucket={fuel}
                      icon={FuelIcon}
                      href="/equipment?tab=fuel"
                      onClick={() => router.push('/equipment?tab=fuel')}
                    />
                  )}
                  {payroll && (
                    <BucketTile
                      bucket={payroll}
                      icon={Wallet}
                      href="/payroll"
                      onClick={() => router.push('/payroll')}
                    />
                  )}
                  {cards && (
                    <BucketTile
                      bucket={cards}
                      icon={CreditCard}
                      href="/expenses/cards"
                      onClick={() => router.push('/expenses/cards')}
                      subtitle={
                        cards.meta && typeof cards.meta.unmatched === 'number' && cards.meta.unmatched > 0
                          ? `${cards.meta.unmatched} unreviewed`
                          : undefined
                      }
                    />
                  )}
                </>
              )
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
