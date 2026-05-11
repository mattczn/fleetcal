'use client';

/**
 * /accounting — invoices AR list.
 *
 * Tabs: All / Draft / Sent / Paid / Void. The Sent tab is the working
 * AR queue. The Draft tab adds a multi-select column + "Send selected"
 * action that groups by broker and fires one email per unique
 * customer with all selected drafts attached as packets.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Receipt, Loader2, AlertTriangle, Search, X, Send, Check, AlertCircle } from 'lucide-react';
import ManagementHeader from '@/components/nav/ManagementHeader';
import DataLoader from '@/components/DataLoader';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Invoice, InvoiceStatus, Customer, BatchSendInvoicesResponse } from '@fleetcal/types';

type Tab = 'all' | 'draft' | 'sent' | 'paid' | 'void';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all',   label: 'All'   },
  { value: 'draft', label: 'Draft' },
  { value: 'sent',  label: 'Sent'  },
  { value: 'paid',  label: 'Paid'  },
  { value: 'void',  label: 'Void'  },
];

export default function AccountingPage() {
  const [tab, setTab] = useState<Tab>('draft');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [search,   setSearch]   = useState('');
  const [brokerFilter, setBrokerFilter] = useState<string | null>(null);
  // Multi-select state — only meaningful on the draft tab. Stored as
  // a Set so toggle is O(1); cleared whenever the tab/filter changes
  // so a stale id can't get sent by accident.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);

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
    setSelected(new Set());
    railway.listInvoices({
      status:   tab === 'all' ? undefined : tab,
      brokerId: brokerFilter ?? undefined,
    })
      .then((res) => { if (!cancelled) setInvoices(res.invoices); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load invoices'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, brokerFilter]);

  // Text search filters client-side — small list sizes (Phase-5 may
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

  // Show the multi-select column + send-bar on the draft tab.
  const isDraftTab = tab === 'draft';
  const selectableIds = useMemo(
    () => isDraftTab ? filtered.filter(i => i.status === 'draft').map(i => i.id) : [],
    [isDraftTab, filtered],
  );
  const allSelected = isDraftTab && selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
  const someSelected = selected.size > 0;

  function toggleId(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(prev => {
      if (allSelected) return new Set();
      return new Set(selectableIds);
    });
  }

  function fmtDate(iso?: string) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtMoney(n: number) {
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  // For the batch-send confirmation dialog: which invoices got selected
  // (resolved to full objects, not just ids).
  const selectedInvoices = useMemo(
    () => filtered.filter(i => selected.has(i.id)),
    [filtered, selected],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DataLoader />
      <ManagementHeader title="Accounting" icon={Receipt} />

      <div className="flex-1 overflow-auto" style={{ background: 'var(--gc-bg)' }}>
        <div className="px-6 py-5">

          {/* Header row: tabs + search */}
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

          {/* Totals strip + send-selected action */}
          <div className="flex items-center gap-4 mb-3">
            <div className="flex items-center gap-6 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              <span>{totals.count} invoice{totals.count === 1 ? '' : 's'}</span>
              <span>Total: <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{fmtMoney(totals.sum)}</span></span>
              {isDraftTab && someSelected && (
                <span>· {selected.size} selected</span>
              )}
            </div>
            <div className="flex-1" />
            {isDraftTab && someSelected && (
              <button onClick={() => setBatchOpen(true)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: '#1a73e8', color: '#fff' }}>
                <Send size={12} className="inline mr-1.5" /> Send {selected.size} draft{selected.size === 1 ? '' : 's'}
              </button>
            )}
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
                {(tab === 'draft' || tab === 'sent') && (
                  <div className="text-[12px]">
                    Generate one from the <Link href="/closeout" className="underline">Closeout</Link> page's <em>Verified</em> tab.
                  </div>
                )}
              </div>
            ) : (
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    {isDraftTab && (
                      <Th>
                        <input type="checkbox"
                          checked={allSelected}
                          onChange={toggleAll}
                          title={allSelected ? 'Clear selection' : 'Select all drafts on this page'} />
                      </Th>
                    )}
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
                    const isSelectable = isDraftTab && inv.status === 'draft';
                    const isChecked = selected.has(inv.id);
                    return (
                      <tr key={inv.id}
                        className="cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
                        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        {isDraftTab && (
                          <Td>
                            {isSelectable && (
                              <input type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleId(inv.id)}
                                onClick={e => e.stopPropagation()} />
                            )}
                          </Td>
                        )}
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

      {batchOpen && (
        <BatchSendDialog
          invoices={selectedInvoices}
          customerById={customerById}
          onClose={() => setBatchOpen(false)}
          onComplete={() => {
            // Refetch so the table reflects the new status.
            setBatchOpen(false);
            setSelected(new Set());
            void railway.listInvoices({
              status:   tab === 'all' ? undefined : tab,
              brokerId: brokerFilter ?? undefined,
            }).then(res => setInvoices(res.invoices));
          }}
        />
      )}
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

// ─── Batch send dialog ──────────────────────────────────────────────────

interface BatchSendDialogProps {
  invoices:     Invoice[];
  customerById: Map<string, Customer>;
  onClose:      () => void;
  onComplete:   () => void;
}

function BatchSendDialog({ invoices, customerById, onClose, onComplete }: BatchSendDialogProps) {
  const [bccSelf, setBccSelf]       = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy]             = useState(false);
  const [result, setResult]         = useState<BatchSendInvoicesResponse | null>(null);

  // Group selected invoices by broker for preview.
  const groups = useMemo(() => {
    const byBroker = new Map<string, { broker: Customer | null; rows: Invoice[] }>();
    for (const inv of invoices) {
      const key = inv.customerId ?? '__missing__';
      const cur = byBroker.get(key);
      if (cur) {
        cur.rows.push(inv);
      } else {
        const broker = inv.customerId ? customerById.get(inv.customerId) ?? null : null;
        byBroker.set(key, { broker, rows: [inv] });
      }
    }
    return Array.from(byBroker.values());
  }, [invoices, customerById]);

  const missingBroker = groups.some(g => !g.broker);
  const missingEmail  = groups.some(g => g.broker && !g.broker.invoiceEmail);

  async function handleSend() {
    setBusy(true);
    try {
      const res = await railway.batchSendInvoices({
        invoiceIds:     invoices.map(i => i.id),
        bccSelf,
        attachLoadDocs,
      });
      setResult(res);
    } catch (err) {
      console.error('[batchSend] failed:', err);
      window.alert('Batch send failed. Check console for details.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onClick={busy ? undefined : onClose}>
      <div className="rounded-2xl overflow-hidden"
        style={{ width: 620, maxWidth: '94vw', maxHeight: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Send size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            {result ? 'Batch send results' : `Send ${invoices.length} draft${invoices.length === 1 ? '' : 's'} — ${groups.length} broker${groups.length === 1 ? '' : 's'}`}
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)] disabled:opacity-50">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm overflow-y-auto flex-1">
          {!result && (
            <>
              {missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some selected invoices have no broker (customer) set. Those rows can't be batch-sent — open them individually to set the broker first.
                </div>
              )}
              {missingEmail && !missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some brokers have no saved AP email. Their invoices will be skipped — add an invoice_email in the broker profile to include them.
                </div>
              )}

              <div className="space-y-2">
                {groups.map((g, i) => (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ border: '1px solid var(--gc-border-light)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-[13px] truncate" style={{ color: 'var(--gc-text-1)' }}>
                          {g.broker?.name ?? <span style={{ color: '#dc2626' }}>(no broker set)</span>}
                        </div>
                        <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                          {g.broker?.invoiceEmail ?? <span style={{ color: '#9a3412' }}>(no AP email)</span>}
                        </div>
                      </div>
                      <div className="text-[12px] text-right shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                        {g.rows.length} invoice{g.rows.length === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={attachLoadDocs} onChange={e => setAttach(e.target.checked)} disabled={busy} />
                  Attach POD / BOL / lumper / scale docs to each packet
                </label>
                <label className="flex items-center gap-2 text-[12.5px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={bccSelf} onChange={e => setBccSelf(e.target.checked)} disabled={busy} />
                  Bcc me a copy of every email
                </label>
              </div>
            </>
          )}

          {result && (
            <div className="space-y-2">
              {result.groups.map((g, i) => {
                const tone =
                  g.status === 'sent'              ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Sent', icon: <Check size={12} /> } :
                  g.status === 'skipped_no_email'  ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email', icon: <AlertCircle size={12} /> } :
                                                     { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed', icon: <AlertCircle size={12} /> };
                return (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-2">
                        {tone.icon}
                        <div className="min-w-0">
                          <div className="font-semibold text-[13px] truncate">{g.brokerName}</div>
                          <div className="text-[11.5px] opacity-80 truncate">{g.to ?? '—'}</div>
                          {g.error && <div className="text-[11.5px] opacity-90 mt-0.5">{g.error}</div>}
                        </div>
                      </div>
                      <div className="text-[12px] text-right shrink-0 font-semibold uppercase tracking-wide">
                        {tone.label}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 flex items-center justify-end gap-2 shrink-0" style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {!result ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Cancel
              </button>
              <button onClick={() => void handleSend()}
                disabled={busy || missingBroker}
                className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: '#1a73e8', color: '#fff' }}>
                {busy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
                Send {invoices.length} draft{invoices.length === 1 ? '' : 's'}
              </button>
            </>
          ) : (
            <button onClick={onComplete}
              className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
