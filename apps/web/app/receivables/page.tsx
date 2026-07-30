'use client';

/**
 * /receivables — who owes us, how much, and how we know when they pay.
 *
 * Three zones, mirroring /expenses:
 *   RAIL   (left)   customers with an open balance; click to filter.
 *   TABLE  (center) one row per invoice with balance, age, and whether
 *                   the payment is backed by evidence.
 *   PANEL  (drawer) RecordPaymentPanel — record money, attach proof.
 *
 * The tiles and the rail are computed over the whole scope, not the
 * current selection, so clicking a customer or an aging tile narrows the
 * table without rewriting the numbers you were reading. Everything comes
 * from one call to /v1/payments/receivables, which owns the aging math
 * so the tiles, the rail, and the Age column can't disagree.
 *
 * Relationship to /accounting: that page runs the invoice pipeline
 * (draft → send → paid) and its Mark Paid still works. Both write the
 * same allocation ledger, so a payment recorded there shows up here with
 * its proof slot empty, waiting for the remittance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, AlertTriangle, Search, RefreshCw } from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { OpsTable, type OpsColumn } from '@/components/ui/OpsTable';
import { railway } from '@/lib/railway';
import RecordPaymentPanel from './RecordPaymentPanel';
import type {
  ReceivableInvoice, ReceivableCustomerSummary, ReceivablesTotals, AgingBucket,
} from '@fleetcal/types';
import { AGING_BUCKETS, AGING_BUCKET_LABEL } from '@fleetcal/types';

const fmtMoney0 = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);

const fmtMoney2 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

/** Rail key for invoices with no customer — mirrors the server's
 *  sentinel so the filter round-trips. */
const NO_CUSTOMER = '__none__';

type Scope = 'open' | 'paid' | 'all';

const EMPTY_TOTALS: ReceivablesTotals = {
  openCount: 0, openBalance: 0, overdueCount: 0, overdueBalance: 0,
  collected30d: 0, unbackedPaidCount: 0,
  byBucket: {
    current:  { count: 0, balance: 0 },
    d1_30:    { count: 0, balance: 0 },
    d31_60:   { count: 0, balance: 0 },
    d61_plus: { count: 0, balance: 0 },
  },
};

/** Age colouring. Amber once past due, red past 30 — the same two-step
 *  the accounting board uses so a row that reads urgent there reads
 *  urgent here. */
function ageColor(days: number | null): string {
  if (days === null || days <= 0) return 'var(--gc-text-3)';
  if (days <= 30) return '#b45309';
  return '#c5221f';
}

function ageLabel(days: number | null): string {
  if (days === null) return '—';
  if (days <= 0) return `${Math.abs(days)}d left`;
  return `${days}d over`;
}

function ReceivablesPageInner() {
  const [rows,      setRows]      = useState<ReceivableInvoice[]>([]);
  const [customers, setCustomers] = useState<ReceivableCustomerSummary[]>([]);
  const [totals,    setTotals]    = useState<ReceivablesTotals>(EMPTY_TOTALS);
  const [loading,   setLoading]   = useState(true);
  const [err,       setErr]       = useState<string | null>(null);

  const [scope,      setScope]      = useState<Scope>('open');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [bucket,     setBucket]     = useState<AgingBucket | null>(null);
  const [search,     setSearch]     = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const [active, setActive] = useState<ReceivableInvoice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await railway.listReceivables({
        scope,
        ...(customerId ? { customerId } : {}),
        ...(bucket     ? { bucket }     : {}),
        ...(searchTerm ? { search: searchTerm } : {}),
      });
      setRows(res.invoices);
      setCustomers(res.customers);
      setTotals(res.totals);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load receivables');
    } finally {
      setLoading(false);
    }
  }, [scope, customerId, bucket, searchTerm]);

  useEffect(() => { void load(); }, [load]);

  // Debounced so typing an invoice number doesn't fire a request per
  // keystroke against a table that can hold thousands of rows.
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // No effect syncing `active` against refetched rows: the panel derives
  // its own applied/balance from the allocations it fetches, and the
  // fields it takes from this row (number, customer, load, total) don't
  // move when a payment is recorded. Holding the row is enough, and it
  // keeps the drawer open when settling an invoice drops it out of the
  // Open scope.

  const railTotalOpen = useMemo(
    () => customers.reduce((s, c) => s + c.openBalance, 0),
    [customers],
  );

  const columns = useMemo<OpsColumn<ReceivableInvoice>[]>(() => [
    {
      key: 'invoiceNumber', header: 'Invoice', width: 120, sortable: true, alwaysVisible: true,
      render: r => (
        <span className="font-semibold" style={{ color: 'var(--gc-blue-text)' }}>
          {r.invoiceNumber}
        </span>
      ),
      subRender: r => r.loadNumber ? `Load ${r.loadNumber}` : null,
    },
    {
      key: 'customerName', header: 'Customer', width: '1fr', sortable: true,
      render: r => r.customerName ?? <span style={{ color: 'var(--gc-text-3)' }}>No customer</span>,
    },
    {
      key: 'issuedAt', header: 'Issued', width: 105, sortable: true,
      render: r => new Date(r.issuedAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }),
    },
    {
      key: 'dueAt', header: 'Due', width: 105, sortable: true,
      sortValue: r => r.dueAt ?? '',
      render: r => r.dueAt
        ? new Date(r.dueAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' })
        : '—',
    },
    {
      key: 'agingDays', header: 'Age', width: 90, align: 'right', sortable: true,
      // Null (no due date) sorts as "least urgent" rather than 0, which
      // would otherwise rank it alongside due-today.
      sortValue: r => r.agingDays ?? -99999,
      render: r => (
        <span className="tabular-nums text-xs font-semibold" style={{ color: ageColor(r.agingDays) }}>
          {ageLabel(r.agingDays)}
        </span>
      ),
    },
    {
      key: 'total', header: 'Total', width: 110, align: 'right', sortable: true,
      render: r => <span className="tabular-nums">{fmtMoney2(r.total)}</span>,
    },
    {
      key: 'paidAmount', header: 'Paid', width: 110, align: 'right', sortable: true,
      render: r => (
        <span className="tabular-nums" style={{ color: r.paidAmount > 0 ? '#188038' : 'var(--gc-text-3)' }}>
          {r.paidAmount > 0 ? fmtMoney2(r.paidAmount) : '—'}
        </span>
      ),
    },
    {
      key: 'balance', header: 'Balance', width: 110, align: 'right', sortable: true,
      render: r => (
        <span className="tabular-nums font-semibold"
              style={{ color: r.balance > 0.005 ? 'var(--gc-text-1)' : '#188038' }}>
          {fmtMoney2(r.balance)}
        </span>
      ),
    },
    {
      key: 'hasProof', header: 'Proof', width: 74, align: 'center', sortable: true,
      headerTooltip: 'Whether any payment on this invoice cites evidence — a remittance, bank line, or check.',
      sortValue: r => (r.paymentCount === 0 ? 0 : r.hasProof ? 2 : 1),
      render: r => {
        if (r.paymentCount === 0) return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        return r.hasProof
          ? <FileText size={13} style={{ color: '#188038' }} aria-label="Backed by evidence" />
          : <AlertTriangle size={13} style={{ color: '#b45309' }} aria-label="Marked paid without proof" />;
      },
    },
  ], []);

  return (
    <AppShell>
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-4 flex items-start justify-between gap-4"
             style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div>
            <h1 className="text-[22px] font-semibold leading-tight" style={{ color: 'var(--gc-text-1)' }}>
              Receivables
            </h1>
            <div className="text-sm mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {totals.openCount} open · {fmtMoney0(totals.openBalance)} outstanding
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--gc-text-3)' }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Invoice #"
                className="text-xs pl-7 pr-2 py-1.5 rounded border"
                style={{
                  borderColor: 'var(--gc-border)', background: 'var(--gc-surface)',
                  color: 'var(--gc-text-1)', outline: 'none', width: 140,
                }} />
            </div>
            <div className="flex rounded border overflow-hidden" style={{ borderColor: 'var(--gc-border)' }}>
              {(['open', 'paid', 'all'] as Scope[]).map(s => (
                <button key={s} onClick={() => { setScope(s); setBucket(null); }}
                        className="text-xs font-semibold px-2.5 py-1.5 capitalize"
                        style={{
                          background: scope === s ? '#1a73e8' : 'transparent',
                          color:      scope === s ? '#fff' : 'var(--gc-text-3)',
                        }}>
                  {s}
                </button>
              ))}
            </div>
            <button onClick={() => void load()} disabled={loading}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded border inline-flex items-center gap-1.5"
                    style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text-2)' }}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {/* Rail + table */}
        <div className="flex-1 min-h-0 flex">
          <aside className="shrink-0 overflow-y-auto py-3 flex flex-col"
                 style={{ width: 236, borderRight: '1px solid var(--gc-border)' }}>
            <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider"
                 style={{ color: 'var(--gc-text-3)' }}>
              Customers
            </div>
            <RailRow label="All customers" total={railTotalOpen}
                     selected={customerId === null} onClick={() => setCustomerId(null)} />
            {customers.map(c => {
              const key = c.customerId ?? NO_CUSTOMER;
              return (
                <RailRow
                  key={key}
                  label={c.customerName}
                  total={c.openBalance}
                  count={c.openCount}
                  amber={c.overdueCount > 0}
                  sub={c.overdueCount > 0 ? `${c.overdueCount} overdue` : undefined}
                  selected={customerId === key}
                  onClick={() => setCustomerId(customerId === key ? null : key)}
                />
              );
            })}
            {!loading && customers.length === 0 && (
              <div className="px-3 py-2 text-xs" style={{ color: 'var(--gc-text-3)' }}>
                Nothing outstanding.
              </div>
            )}
          </aside>

          <main className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
            {/* Tiles */}
            <div className="grid gap-2 mb-3"
                 style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              <Tile label="Outstanding" value={fmtMoney0(totals.openBalance)}
                    sub={`${totals.openCount} invoice${totals.openCount === 1 ? '' : 's'}`}
                    accent="#1a73e8" />
              <Tile label="Overdue" value={fmtMoney0(totals.overdueBalance)}
                    sub={`${totals.overdueCount} past due`}
                    accent={totals.overdueBalance > 0 ? '#c5221f' : 'var(--gc-text-3)'} />
              <Tile label="Collected 30d" value={fmtMoney0(totals.collected30d)}
                    sub="payments recorded" accent="#188038" />
              <Tile label="Paid, no proof" value={String(totals.unbackedPaidCount)}
                    sub="evidence missing"
                    accent={totals.unbackedPaidCount > 0 ? '#b45309' : 'var(--gc-text-3)'} />
            </div>

            {/* Aging buckets — clickable filters */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {AGING_BUCKETS.map(b => {
                const cell = totals.byBucket[b];
                const on   = bucket === b;
                return (
                  <button key={b} onClick={() => setBucket(on ? null : b)}
                          className="text-xs px-2.5 py-1.5 rounded border inline-flex items-center gap-2"
                          style={{
                            borderColor: on ? '#1a73e8' : 'var(--gc-border)',
                            background:  on ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent',
                            color: on ? '#1a73e8' : 'var(--gc-text-2)',
                          }}>
                    <span className="font-semibold">{AGING_BUCKET_LABEL[b]}</span>
                    <span className="tabular-nums">{fmtMoney0(cell.balance)}</span>
                    <span style={{ color: 'var(--gc-text-3)' }}>({cell.count})</span>
                  </button>
                );
              })}
            </div>

            {err && (
              <div className="rounded-lg border p-4 mb-4 text-sm"
                   style={{ borderColor: '#ef4444', background: '#fef2f2', color: '#991b1b' }}>
                {err}
              </div>
            )}

            <OpsTable
              columns={columns}
              data={rows}
              loading={loading}
              rowKey={r => r.id}
              onRowClick={r => setActive(r)}
              activeRowId={active?.id ?? null}
              countLabel="invoice"
              density="compact"
              pageSize={50}
              defaultSort={{ key: 'agingDays', dir: 'desc' }}
              columnPicker
              persistKey="receivables-v1"
              emptyLabel={
                scope === 'open'
                  ? 'Nothing outstanding — every invoice in this view is settled.'
                  : 'No invoices match the current filters.'
              }
            />
          </main>
        </div>
      </div>

      {active && (
        <RecordPaymentPanel
          row={active}
          onSaved={() => void load()}
          onClose={() => setActive(null)}
        />
      )}
    </AppShell>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

function Tile({ label, value, sub, accent }: {
  label: string; value: string; sub: string; accent: string;
}) {
  return (
    <div className="rounded-lg border px-3 py-2"
         style={{ borderColor: 'var(--gc-border)', borderLeft: `3px solid ${accent}` }}>
      <div className="text-[10px] font-bold uppercase tracking-wider"
           style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      <div className="text-[19px] font-semibold tabular-nums leading-tight mt-0.5"
           style={{ color: 'var(--gc-text-1)' }}>
        {value}
      </div>
      <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{sub}</div>
    </div>
  );
}

function RailRow({ label, total, count, sub, amber, selected, onClick }: {
  label: string; total: number; count?: number; sub?: string;
  amber?: boolean; selected?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
            className="w-full text-left px-3 py-1.5 flex items-start justify-between gap-2"
            style={{ background: selected ? 'var(--gc-blue-bg, #e8f0fe)' : 'transparent' }}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium truncate"
              style={{ color: selected ? '#1a73e8' : 'var(--gc-text-2)' }}>
          {label}
        </span>
        {sub && (
          <span className="block text-[10px]" style={{ color: amber ? '#b45309' : 'var(--gc-text-3)' }}>
            {sub}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-xs tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
          {fmtMoney0(total)}
        </span>
        {count != null && (
          <span className="block text-[10px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

export default function ReceivablesPage() {
  return (
    <RequireCap cap="accounting.access" module="accounting">
      <ReceivablesPageInner />
    </RequireCap>
  );
}
