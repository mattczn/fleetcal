'use client';

/**
 * /accounting — invoices AR list.
 *
 * Tabs: All / Draft / Sent / Paid / Void. The Sent tab is the working
 * AR queue — those are the loads brokers owe money on. Rows show the
 * broker, invoice #, issued/due dates, total, and click-through to the
 * per-invoice page where the user can send / mark paid / void.
 *
 * Layout mirrors /closeout (tabs + table) for muscle memory. Phase-4
 * will add the broker-batch send flow on top of this.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Receipt, Loader2, AlertTriangle, Search, X } from 'lucide-react';
import ManagementHeader from '@/components/nav/ManagementHeader';
import DataLoader from '@/components/DataLoader';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Invoice, InvoiceStatus, Customer } from '@fleetcal/types';

type Tab = 'all' | 'draft' | 'sent' | 'paid' | 'void';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all',   label: 'All'   },
  { value: 'draft', label: 'Draft' },
  { value: 'sent',  label: 'Sent'  },
  { value: 'paid',  label: 'Paid'  },
  { value: 'void',  label: 'Void'  },
];

export default function AccountingPage() {
  const [tab, setTab] = useState<Tab>('sent');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState('');
  const [brokerFilter, setBrokerFilter] = useState<string | null>(null);

  const customers = useCalendarStore(s => s.customers);
  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.listInvoices({
      status:   tab === 'all' ? undefined : tab,
      brokerId: brokerFilter ?? undefined,
    })
      .then((res) => { if (!cancelled) setInvoices(res.invoices); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoices'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, brokerFilter]);

  // Text search filters client-side — small list sizes (Phase-4 may
  // promote this to a server query if AR grows beyond a few hundred).
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((inv) => {
      const broker = (inv.snapshot.brokerName ?? '').toLowerCase();
      return (
        inv.invoiceNumber.toLowerCase().includes(q) ||
        broker.includes(q) ||
        (inv.snapshot.loadNumber ?? '').toLowerCase().includes(q)
      );
    });
  }, [invoices, search]);

  // Aggregate totals for the active set.
  const totals = useMemo(() => {
    let count = 0, sum = 0;
    for (const inv of filtered) { count++; sum += inv.total; }
    return { count, sum };
  }, [filtered]);

  function fmtDate(iso?: string) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtMoney(n: number) {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DataLoader />
      <ManagementHeader title="Accounting" icon={Receipt} />

      <div className="flex-1 overflow-auto" style={{ background: 'var(--gc-bg)' }}>
        <div className="px-6 py-5">

          {/* Header row: tabs + search + totals */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-1.5">
              {TABS.map(({ value, label }) => {
                const active = tab === value;
                return (
                  <button key={value}
                    onClick={() => setTab(value)}
                    className="text-[13px] font-medium px-3 py-1.5 rounded-lg transition-colors"
                    style={{
                      background: active ? '#1a73e8' : 'transparent',
                      color:      active ? '#fff'    : 'var(--gc-text-2)',
                      border: `1px solid ${active ? '#1a73e8' : 'var(--gc-border)'}`,
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1" />

            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
              <input
                type="text"
                placeholder="Search invoice #, broker, load #…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{ width: 280, background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>

            {brokerFilter && (
              <button onClick={() => setBrokerFilter(null)}
                className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Broker: {customerById.get(brokerFilter)?.name ?? '—'} <X size={11} className="inline ml-1" />
              </button>
            )}
          </div>

          {/* Totals strip */}
          <div className="flex items-center gap-6 mb-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            <span>{totals.count} invoice{totals.count === 1 ? '' : 's'}</span>
            <span>Total: <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(totals.sum)}</span></span>
          </div>

          {/* Table */}
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-16 text-sm" style={{ color: 'var(--gc-text-2)' }}>
                <AlertTriangle size={16} style={{ display: 'inline', marginRight: 6, color: '#dc2626' }} />
                {error}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-sm" style={{ color: 'var(--gc-text-3)' }}>
                <Receipt size={28} style={{ color: 'var(--gc-text-3)' }} />
                <div>No invoices in this view.</div>
                {tab === 'sent' && (
                  <div className="text-[12px]">
                    Generate one from the <Link href="/closeout" className="underline">Closeout</Link> page's <em>Verified</em> tab.
                  </div>
                )}
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <Th>Invoice #</Th>
                    <Th>Broker</Th>
                    <Th>Load</Th>
                    <Th>Issued</Th>
                    <Th>Due</Th>
                    <Th align="right">Total</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => {
                    const customer = inv.customerId ? customerById.get(inv.customerId) : undefined;
                    const brokerName = customer?.name ?? inv.snapshot.brokerName ?? '';
                    const brokerLabel = displayBrokerName(brokerName, customers) || '—';
                    return (
                      <tr key={inv.id}
                        className="cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
                        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        <Td>
                          <Link href={`/accounting/invoices/${inv.id}`}
                            className="font-semibold tabular-nums"
                            style={{ color: '#1a73e8' }}>
                            #{inv.invoiceNumber}
                          </Link>
                        </Td>
                        <Td>
                          <Link href={`/accounting/invoices/${inv.id}`}
                            className="block w-full"
                            style={{ color: 'var(--gc-text-1)' }}>
                            {brokerLabel}
                          </Link>
                        </Td>
                        <Td>
                          <Link href={`/accounting/invoices/${inv.id}`}
                            className="tabular-nums"
                            style={{ color: 'var(--gc-text-2)' }}>
                            {inv.snapshot.loadNumber}
                          </Link>
                        </Td>
                        <Td>
                          <Link href={`/accounting/invoices/${inv.id}`} className="block w-full">
                            {fmtDate(inv.issuedAt)}
                          </Link>
                        </Td>
                        <Td>
                          <Link href={`/accounting/invoices/${inv.id}`} className="block w-full">
                            {fmtDate(inv.dueAt)}
                          </Link>
                        </Td>
                        <Td align="right">
                          <Link href={`/accounting/invoices/${inv.id}`}
                            className="font-semibold tabular-nums block">
                            {fmtMoney(inv.total)}
                          </Link>
                        </Td>
                        <Td>
                          <StatusPill status={inv.status} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--gc-text-3)', textAlign: align ?? 'left' }}>
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <td className="px-4 py-2.5" style={{ textAlign: align ?? 'left' }}>{children}</td>
  );
}

function StatusPill({ status }: { status: InvoiceStatus }) {
  const palette: Record<InvoiceStatus, { bg: string; fg: string; border: string }> = {
    draft: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' },
    sent:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
    paid:  { bg: '#dcfce7', fg: '#166534', border: '#86efac' },
    void:  { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
  };
  const p = palette[status];
  return (
    <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full inline-block"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
      {status}
    </span>
  );
}
