'use client';

/**
 * /accounting — billing workflow.
 *
 * Modeled on Alvys's bucket layout:
 *   - Released      → loads that closeout marked verified; ready to invoice
 *   - Queued        → invoices that exist as drafts (PDF generated, unsent)
 *   - Invoiced      → invoices that were sent to the broker
 *   - Paid          → invoices that were paid
 *   - All           → everything except voids
 *
 * Each bucket shows count + total $ in a tile up top. Selecting a tile
 * filters the table below. The Released bucket lists LOADS (because no
 * invoice exists yet for them); the rest list invoices.
 *
 * Batch actions are bucket-specific:
 *   - Released: Generate Invoice / Create & Send (Invoice Summary modal)
 *   - Queued:   Submit Invoice  (batch send to broker AP)
 *   - Invoiced: Mark Paid
 *
 * Future buckets: Payment Discrepancies (Phase 5).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Receipt, Loader2, AlertTriangle, AlertCircle, Search, X, Send, Check, FilePlus,
  AlertOctagon, Inbox, CircleCheckBig, CheckCircle2, Layers,
} from 'lucide-react';
import ManagementHeader from '@/components/nav/ManagementHeader';
import DataLoader from '@/components/DataLoader';
import { railway, RailwayError } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import type { Invoice, InvoiceStatus, Customer, Load, BatchGenerateInvoicesResponse, BatchSendInvoicesResponse } from '@fleetcal/types';

type Bucket = 'released' | 'queued' | 'invoiced' | 'paid' | 'all';

const BUCKETS: Array<{ key: Bucket; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; tint: string }> = [
  { key: 'released', label: 'Released',  icon: AlertOctagon,    tint: '#1a73e8' },
  { key: 'queued',   label: 'Queued',    icon: Inbox,           tint: '#9333ea' },
  { key: 'invoiced', label: 'Invoiced',  icon: CircleCheckBig,  tint: '#1d4ed8' },
  { key: 'paid',     label: 'Paid',      icon: CheckCircle2,    tint: '#16a34a' },
  { key: 'all',      label: 'All',       icon: Layers,          tint: '#5f6368' },
];

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtDate  = (iso?: string) => iso
  ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

export default function AccountingPage() {
  const router    = useRouter();
  const customers = useCalendarStore(s => s.customers);
  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  // ── Bucket state ────────────────────────────────────────────────────
  const [bucket, setBucket] = useState<Bucket>('released');
  const [releasedLoads, setReleasedLoads] = useState<Load[]>([]);
  const [allInvoices,   setAllInvoices]   = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // ── Selection + modals ──────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search,   setSearch]   = useState('');
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  const [invoiceModalId,  setInvoiceModalId]  = useState<string | null>(null);
  const [summaryAction,   setSummaryAction]   = useState<null | 'generate' | 'generateSend'>(null);
  const [batchSendOpen,   setBatchSendOpen]   = useState(false);
  const [markPaidBusy,    setMarkPaidBusy]    = useState(false);

  // Clear selection whenever the active bucket changes so a stale id
  // can't get acted on against the wrong list.
  useEffect(() => { setSelected(new Set()); }, [bucket]);

  // ── Data fetch ──────────────────────────────────────────────────────
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [releasedRes, invoicesRes] = await Promise.all([
        railway.listCloseoutQueue('verified', { limit: 200 }),
        railway.listInvoices({ /* fetch all so the tiles can show counts */ }),
      ]);
      setReleasedLoads(releasedRes.loads);
      setAllInvoices(invoicesRes.invoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounting data');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  // ── Bucket stats ────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const sumLoads     = (xs: Load[])    => xs.reduce((s, l) => s + (l.loadPrice ?? 0), 0);
    const sumInvoices  = (xs: Invoice[]) => xs.reduce((s, i) => s + i.total, 0);
    const queued     = allInvoices.filter(i => i.status === 'draft');
    const invoiced   = allInvoices.filter(i => i.status === 'sent');
    const paid       = allInvoices.filter(i => i.status === 'paid');
    const allLive    = allInvoices.filter(i => i.status !== 'void');
    return {
      released: { count: releasedLoads.length, total: sumLoads(releasedLoads) },
      queued:   { count: queued.length,        total: sumInvoices(queued) },
      invoiced: { count: invoiced.length,      total: sumInvoices(invoiced) },
      paid:     { count: paid.length,          total: sumInvoices(paid) },
      all:      { count: allLive.length,       total: sumInvoices(allLive) },
    };
  }, [releasedLoads, allInvoices]);

  // ── Rows for the active bucket + search ─────────────────────────────
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (bucket === 'released') {
      const filtered = q
        ? releasedLoads.filter(l => {
            return (l.broker ?? '').toLowerCase().includes(q)
              || (l.loadNum ?? '').toLowerCase().includes(q)
              || String(l.internalLoadId ?? '').toLowerCase().includes(q);
          })
        : releasedLoads;
      return { kind: 'loads' as const, loads: filtered };
    }
    let base: Invoice[];
    if      (bucket === 'queued')   base = allInvoices.filter(i => i.status === 'draft');
    else if (bucket === 'invoiced') base = allInvoices.filter(i => i.status === 'sent');
    else if (bucket === 'paid')     base = allInvoices.filter(i => i.status === 'paid');
    else                            base = allInvoices.filter(i => i.status !== 'void');
    const filtered = q
      ? base.filter(inv => {
          const broker = (inv.snapshot.brokerName ?? '').toLowerCase();
          return inv.invoiceNumber.toLowerCase().includes(q)
              || broker.includes(q)
              || (inv.snapshot.loadNumber ?? '').toLowerCase().includes(q);
        })
      : base;
    return { kind: 'invoices' as const, invoices: filtered };
  }, [bucket, releasedLoads, allInvoices, search]);

  // ── Selection helpers ───────────────────────────────────────────────
  const selectableIds = useMemo(() => {
    if (rows.kind === 'loads') return rows.loads.map(l => l.loadId ?? l.id);
    if (bucket === 'paid' || bucket === 'all') return [];
    return rows.invoices.map(i => i.id);
  }, [rows, bucket]);
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
  const someSelected = selected.size > 0;
  function toggleId(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(prev => allSelected ? new Set() : new Set(selectableIds));
  }

  // Resolved selected objects (for the action bar + modal previews).
  const selectedLoads = useMemo(
    () => rows.kind === 'loads'
      ? rows.loads.filter(l => selected.has(l.loadId ?? l.id))
      : [],
    [rows, selected],
  );
  const selectedInvoices = useMemo(
    () => rows.kind === 'invoices'
      ? rows.invoices.filter(i => selected.has(i.id))
      : [],
    [rows, selected],
  );

  // ── Actions ─────────────────────────────────────────────────────────
  async function handleMarkPaid() {
    if (selectedInvoices.length === 0 || markPaidBusy) return;
    setMarkPaidBusy(true);
    try {
      // No batch endpoint for mark-paid yet — call sequentially.
      // Small volumes so the wall-clock cost is fine.
      for (const inv of selectedInvoices) {
        try { await railway.markInvoicePaid(inv.id, {}); }
        catch (err) { console.warn('[accounting] markPaid failed for', inv.invoiceNumber, err); }
      }
      await refresh();
      setSelected(new Set());
    } finally {
      setMarkPaidBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DataLoader />
      <ManagementHeader title="Accounting" icon={Receipt} />

      <div className="flex-1 overflow-auto" style={{ background: 'var(--gc-bg)' }}>
        <div className="px-6 py-5 space-y-4">

          {/* Bucket tiles */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {BUCKETS.map(b => {
              const active = bucket === b.key;
              const s = stats[b.key];
              const Icon = b.icon;
              return (
                <button key={b.key}
                  onClick={() => setBucket(b.key)}
                  className="text-left px-4 py-3 rounded-xl transition-all"
                  style={{
                    background: 'var(--gc-surface)',
                    border: active ? `2px solid ${b.tint}` : '1px solid var(--gc-border-light)',
                    boxShadow: active ? '0 4px 12px rgba(26,115,232,0.12)' : 'var(--shadow-1)',
                  }}>
                  <div className="flex items-center gap-2">
                    <Icon size={16} style={{ color: b.tint }} />
                    <span className="text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>{b.label}</span>
                    <span className="ml-auto text-[16px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{s.count.toLocaleString()}</span>
                  </div>
                  <div className="mt-1.5 text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                    {fmtMoney(s.total)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar: search + (bucket-specific actions on right) */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
              <input
                type="text"
                placeholder="Search broker, invoice #, load #…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{ width: 300, background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
              />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex-1" />
            {someSelected && (
              <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                {selected.size} selected
              </span>
            )}
            {/* Action buttons appear when selection has rows + bucket
                supports actions */}
            {bucket === 'released' && someSelected && (
              <>
                <button onClick={() => setSummaryAction('generate')}
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                  <FilePlus size={12} className="inline mr-1.5" /> Generate Invoice
                </button>
                <button onClick={() => setSummaryAction('generateSend')}
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  <Send size={12} className="inline mr-1.5" /> Create &amp; Send
                </button>
              </>
            )}
            {bucket === 'queued' && someSelected && (
              <button onClick={() => setBatchSendOpen(true)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: '#1a73e8', color: '#fff' }}>
                <Send size={12} className="inline mr-1.5" /> Submit {selected.size} invoice{selected.size === 1 ? '' : 's'}
              </button>
            )}
            {bucket === 'invoiced' && someSelected && (
              <button onClick={() => void handleMarkPaid()}
                disabled={markPaidBusy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}>
                {markPaidBusy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Check size={12} className="inline mr-1.5" />}
                Mark {selected.size} paid
              </button>
            )}
          </div>

          {/* Table */}
          <div className="rounded-2xl overflow-hidden"
            style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
              </div>
            ) : error ? (
              <div className="flex items-center justify-center py-16 text-sm" style={{ color: 'var(--gc-text-2)' }}>
                <AlertTriangle size={16} style={{ display: 'inline', marginRight: 6, color: '#dc2626' }} />
                {error}
              </div>
            ) : rows.kind === 'loads' ? (
              <LoadsTable
                loads={rows.loads}
                selected={selected}
                allSelected={allSelected}
                onToggle={toggleId}
                onToggleAll={toggleAll}
                customerById={customerById}
                customers={customers}
                onOpenBroker={(id) => setBrokerProfileId(id)}
              />
            ) : (
              <InvoicesTable
                invoices={rows.invoices}
                bucket={bucket}
                selected={selected}
                allSelected={allSelected}
                onToggle={toggleId}
                onToggleAll={toggleAll}
                customerById={customerById}
                customers={customers}
                onOpenBroker={(id) => setBrokerProfileId(id)}
                onOpenInvoice={(id) => setInvoiceModalId(id)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {brokerProfileId && (
        <BrokerProfileModal initialBrokerId={brokerProfileId}
          onClose={() => { setBrokerProfileId(null); void refresh(); }} />
      )}
      {invoiceModalId && (
        <InvoiceDetailModal invoiceId={invoiceModalId}
          onClose={() => { setInvoiceModalId(null); void refresh(); }} />
      )}
      {summaryAction && (
        <InvoiceSummaryModal
          loads={selectedLoads}
          customerById={customerById}
          action={summaryAction}
          onClose={() => setSummaryAction(null)}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onComplete={() => {
            setSummaryAction(null);
            setSelected(new Set());
            void refresh();
          }}
        />
      )}
      {batchSendOpen && (
        <BatchSendDialog
          invoices={selectedInvoices}
          customerById={customerById}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onClose={() => setBatchSendOpen(false)}
          onComplete={() => { setBatchSendOpen(false); setSelected(new Set()); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Loads table (Released bucket) ───────────────────────────────────────

interface LoadsTableProps {
  loads:        Load[];
  selected:     Set<string>;
  allSelected:  boolean;
  onToggle:     (id: string) => void;
  onToggleAll:  () => void;
  customerById: Map<string, Customer>;
  customers:    Customer[];
  onOpenBroker: (id: string) => void;
}

function LoadsTable({
  loads, selected, allSelected, onToggle, onToggleAll, customerById, customers, onOpenBroker,
}: LoadsTableProps) {
  if (loads.length === 0) {
    return (
      <Empty
        icon={<AlertOctagon size={28} style={{ color: 'var(--gc-text-3)' }} />}
        title="No released loads"
        sub="Loads land here once Closeout marks them verified."
      />
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
          <Th><input type="checkbox" checked={allSelected} onChange={onToggleAll} /></Th>
          <Th>Customer</Th>
          <Th>Order #</Th>
          <Th>Load #</Th>
          <Th align="right">Amount</Th>
          <Th>Schedule</Th>
          <Th>Driver</Th>
          <Th>Invoice method</Th>
        </tr>
      </thead>
      <tbody>
        {loads.map((l) => {
          const id = l.loadId ?? l.id;
          const customer = l.customerId ? customerById.get(l.customerId) : undefined;
          const brokerLabel = displayBrokerName(customer?.name ?? l.broker ?? '', customers) || '—';
          const method = customer?.invoiceMethod ?? 'email';
          const missingEmail = method === 'email' && !customer?.invoiceEmail;
          return (
            <tr key={id}
              className="transition-colors hover:bg-[var(--gc-hover)]"
              style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <Td>
                <input type="checkbox"
                  checked={selected.has(id)}
                  onChange={() => onToggle(id)} />
              </Td>
              <Td>
                <div className="flex items-center gap-1.5">
                  {customer ? (
                    <button onClick={() => onOpenBroker(customer.id)}
                      className="font-medium text-left hover:underline"
                      style={{ color: 'var(--gc-text-1)' }}
                      title="Open broker profile">
                      {brokerLabel}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--gc-text-3)' }}>{brokerLabel}</span>
                  )}
                  {missingEmail && (
                    <button onClick={() => customer && onOpenBroker(customer.id)}
                      className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                      style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
                      title="No invoice email set for this broker">
                      <AlertCircle size={10} /> No email
                    </button>
                  )}
                </div>
              </Td>
              <Td className="tabular-nums">{l.loadNum ?? '—'}</Td>
              <Td className="tabular-nums">{l.internalLoadId ?? '—'}</Td>
              <Td align="right" className="font-semibold tabular-nums">
                {l.loadPrice != null ? fmtMoney(l.loadPrice) : '—'}
              </Td>
              <Td>{fmtDate(l.start)}</Td>
              <Td>{l.driverName ?? '—'}</Td>
              <Td>
                <span className="text-[11px] font-medium uppercase tracking-wider"
                  style={{ color: method === 'portal' ? '#9a3412' : 'var(--gc-text-2)' }}>
                  {method === 'portal' ? 'Portal' : 'Email'}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Invoices table (Queued / Invoiced / Paid / All) ─────────────────────

interface InvoicesTableProps {
  invoices:      Invoice[];
  bucket:        Bucket;
  selected:      Set<string>;
  allSelected:   boolean;
  onToggle:      (id: string) => void;
  onToggleAll:   () => void;
  customerById:  Map<string, Customer>;
  customers:     Customer[];
  onOpenBroker:  (id: string) => void;
  onOpenInvoice: (id: string) => void;
}

function InvoicesTable({
  invoices, bucket, selected, allSelected, onToggle, onToggleAll, customerById, customers, onOpenBroker, onOpenInvoice,
}: InvoicesTableProps) {
  const selectable = bucket === 'queued' || bucket === 'invoiced';
  const showStatus = bucket === 'all';
  if (invoices.length === 0) {
    const map: Record<Bucket, { title: string; sub: string }> = {
      released: { title: 'No released loads',     sub: '' },
      queued:   { title: 'Nothing queued',        sub: 'Generated invoices waiting to be sent show up here.' },
      invoiced: { title: 'Nothing invoiced',      sub: 'Sent invoices show up here until they\'re marked paid.' },
      paid:     { title: 'Nothing paid yet',      sub: 'Paid invoices show up here for record-keeping.' },
      all:      { title: 'No invoices yet',       sub: 'Generate one from the Released bucket.' },
    };
    const m = map[bucket];
    return <Empty icon={<Receipt size={28} style={{ color: 'var(--gc-text-3)' }} />} title={m.title} sub={m.sub} />;
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
          {selectable && (
            <Th><input type="checkbox" checked={allSelected} onChange={onToggleAll} /></Th>
          )}
          <Th>Invoice #</Th>
          <Th>Customer</Th>
          <Th>Load</Th>
          <Th>Issued</Th>
          <Th>Due</Th>
          <Th align="right">Total</Th>
          {showStatus && <Th>Status</Th>}
        </tr>
      </thead>
      <tbody>
        {invoices.map((inv) => {
          const customer = inv.customerId ? customerById.get(inv.customerId) : undefined;
          const brokerName  = customer?.name ?? inv.snapshot.brokerName ?? '';
          const brokerLabel = displayBrokerName(brokerName, customers) || '—';
          const method      = customer?.invoiceMethod ?? 'email';
          const missingEmail = inv.status === 'draft' && method === 'email' && !customer?.invoiceEmail;
          return (
            <tr key={inv.id}
              className="cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
              style={{ borderBottom: '1px solid var(--gc-border-light)' }}
              onClick={() => onOpenInvoice(inv.id)}>
              {selectable && (
                <Td onClickStopProp>
                  <input type="checkbox"
                    checked={selected.has(inv.id)}
                    onChange={() => onToggle(inv.id)}
                    onClick={e => e.stopPropagation()} />
                </Td>
              )}
              <Td><span className="font-semibold tabular-nums" style={{ color: '#1a73e8' }}>#{inv.invoiceNumber}</span></Td>
              <Td onClickStopProp>
                <div className="flex items-center gap-1.5">
                  {customer ? (
                    <button onClick={(e) => { e.stopPropagation(); onOpenBroker(customer.id); }}
                      className="font-medium text-left hover:underline"
                      style={{ color: 'var(--gc-text-1)' }}>
                      {brokerLabel}
                    </button>
                  ) : (
                    <span style={{ color: 'var(--gc-text-3)' }}>{brokerLabel}</span>
                  )}
                  {missingEmail && (
                    <button onClick={(e) => { e.stopPropagation(); customer && onOpenBroker(customer.id); }}
                      className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                      style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
                      title="No invoice email set for this broker">
                      <AlertCircle size={10} /> No email
                    </button>
                  )}
                </div>
              </Td>
              <Td className="tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{inv.snapshot.loadNumber}</Td>
              <Td>{fmtDate(inv.issuedAt)}</Td>
              <Td>{fmtDate(inv.dueAt)}</Td>
              <Td align="right" className="font-semibold tabular-nums">{fmtMoney(inv.total)}</Td>
              {showStatus && <Td><StatusPill status={inv.status} /></Td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Invoice Summary modal (batch generate from loads) ──────────────────

interface InvoiceSummaryModalProps {
  loads:        Load[];
  customerById: Map<string, Customer>;
  action:       'generate' | 'generateSend';
  onOpenBroker: (id: string) => void;
  onClose:      () => void;
  onComplete:   () => void;
}

function InvoiceSummaryModal({
  loads, customerById, action: initialAction, onOpenBroker, onClose, onComplete,
}: InvoiceSummaryModalProps) {
  const [action, setAction]   = useState<'generate' | 'generateSend'>(initialAction);
  const [bccSelf, setBccSelf] = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchGenerateInvoicesResponse | null>(null);

  // Group by broker for the result-summary view + the missing-email
  // pre-flight banner.
  const groups = useMemo(() => {
    const byBroker = new Map<string, { broker: Customer | null; loads: Load[] }>();
    for (const l of loads) {
      const key = l.customerId ?? '__missing__';
      const cur = byBroker.get(key);
      if (cur) cur.loads.push(l);
      else byBroker.set(key, {
        broker: l.customerId ? customerById.get(l.customerId) ?? null : null,
        loads: [l],
      });
    }
    return Array.from(byBroker.values());
  }, [loads, customerById]);

  const totalAmount = loads.reduce((s, l) => s + (l.loadPrice ?? 0), 0);
  const willSend = action === 'generateSend';
  const missingEmail = willSend && groups.some(g => g.broker && (g.broker.invoiceMethod ?? 'email') === 'email' && !g.broker.invoiceEmail);

  async function handleGo() {
    setBusy(true);
    try {
      const loadIds = loads.map(l => l.loadId ?? l.id);
      const res = await railway.batchGenerateInvoices({
        loadIds,
        thenSend: willSend,
        bccSelf,
        attachLoadDocs,
      });
      setResult(res);
    } catch (err) {
      console.error('[invoiceSummary] batchGenerate failed:', err);
      const msg = err instanceof RailwayError && err.status === 503
        ? 'Email isn\'t configured on the server yet (missing RESEND_API_KEY).'
        : 'Batch generate failed. Check console for details.';
      window.alert(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 640, maxWidth: '94vw', maxHeight: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Receipt size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            {result
              ? 'Invoice summary — results'
              : `Invoice summary — ${loads.length} load${loads.length === 1 ? '' : 's'}, ${fmtMoney(totalAmount)}`
            }
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)] disabled:opacity-50">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-3 text-sm overflow-y-auto flex-1">
          {!result && (
            <>
              {missingEmail && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some brokers have no saved AP email — their invoices will be created but skipped at the send step.
                  Open those broker profiles to add an email, or run Generate Invoice only (no send) for now.
                </div>
              )}

              {/* Per-load summary table — mimics Alvys's modal. */}
              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr style={{ background: 'var(--gc-bg)' }}>
                      <Th>Customer</Th>
                      <Th>Load #</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {loads.map(l => {
                      const customer = l.customerId ? customerById.get(l.customerId) : undefined;
                      const brokerName = customer?.name ?? l.broker ?? '—';
                      const noEmail = willSend && customer && (customer.invoiceMethod ?? 'email') === 'email' && !customer.invoiceEmail;
                      return (
                        <tr key={l.loadId ?? l.id} style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                          <Td>
                            <div className="flex items-center gap-1.5">
                              {customer ? (
                                <button onClick={() => onOpenBroker(customer.id)}
                                  className="text-left hover:underline" style={{ color: 'var(--gc-text-1)' }}>
                                  {brokerName}
                                </button>
                              ) : <span style={{ color: 'var(--gc-text-3)' }}>{brokerName}</span>}
                              {noEmail && (
                                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                                  No email
                                </span>
                              )}
                            </div>
                          </Td>
                          <Td className="tabular-nums" style={{ color: 'var(--gc-text-2)' }}>{l.internalLoadId ?? '—'}</Td>
                          <Td align="right" className="tabular-nums font-semibold" style={{ color: '#15803d' }}>
                            {l.loadPrice != null ? fmtMoney(l.loadPrice) : '—'}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {willSend && (
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
              )}
            </>
          )}

          {result && <BatchGenerateResultView result={result} />}
        </div>

        <div className="px-5 py-3 flex items-center justify-between gap-2 shrink-0" style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {!result ? (
            <>
              <button onClick={onClose} disabled={busy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                Clear All
              </button>
              <div className="flex items-center gap-2">
                {/* Allow flipping between the two modes from inside
                    the modal — Alvys shows both as final actions. */}
                {action === 'generateSend' ? (
                  <button onClick={() => setAction('generate')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                    Generate Invoice
                  </button>
                ) : (
                  <button onClick={() => setAction('generateSend')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                    style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                    Create &amp; Send
                  </button>
                )}
                <button onClick={() => void handleGo()} disabled={busy}
                  className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  {busy
                    ? <Loader2 size={12} className="animate-spin inline mr-1.5" />
                    : (willSend ? <Send size={12} className="inline mr-1.5" /> : <FilePlus size={12} className="inline mr-1.5" />)
                  }
                  {willSend ? 'Create & Send' : 'Generate Invoice'}
                </button>
              </div>
            </>
          ) : (
            <button onClick={onComplete}
              className="ml-auto text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BatchGenerateResultView({ result }: { result: BatchGenerateInvoicesResponse }) {
  return (
    <div className="space-y-3">
      {result.created.length > 0 && (
        <ResultStrip
          tone={{ bg: '#dcfce7', fg: '#166534', border: '#86efac' }}
          label={`${result.created.length} invoice${result.created.length === 1 ? '' : 's'} generated`}
        />
      )}
      {result.failed.length > 0 && (
        <div className="space-y-1">
          <ResultStrip
            tone={{ bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' }}
            label={`${result.failed.length} failed`}
          />
          <ul className="text-[11.5px] pl-3 space-y-0.5" style={{ color: '#991b1b' }}>
            {result.failed.map(f => <li key={f.loadId}>• {f.error}</li>)}
          </ul>
        </div>
      )}
      {result.sent && result.sent.length > 0 && (
        <div className="space-y-1.5">
          {result.sent.map((g, i) => {
            const tone =
              g.status === 'sent'             ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: `Sent · ${g.invoiceIds.length}` } :
              g.status === 'skipped_no_email' ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email' } :
                                                { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed' };
            return (
              <div key={i} className="px-3 py-2 rounded-lg flex items-center justify-between gap-3"
                style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                <div className="min-w-0">
                  <div className="font-semibold text-[12.5px] truncate">{g.brokerName}</div>
                  <div className="text-[11.5px] opacity-80 truncate">{g.to ?? '—'}</div>
                  {g.error && <div className="text-[11.5px] opacity-90 mt-0.5">{g.error}</div>}
                </div>
                <div className="text-[12px] font-semibold uppercase tracking-wide shrink-0">{tone.label}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultStrip({ tone, label }: { tone: { bg: string; fg: string; border: string }; label: string }) {
  return (
    <div className="px-3 py-2 rounded-lg text-[12.5px] font-semibold"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
      {label}
    </div>
  );
}

// ─── Batch send dialog (drafts → sent) ───────────────────────────────────

interface BatchSendDialogProps {
  invoices:     Invoice[];
  customerById: Map<string, Customer>;
  onOpenBroker?: (brokerId: string) => void;
  onClose:      () => void;
  onComplete:   () => void;
}

function BatchSendDialog({ invoices, customerById, onOpenBroker, onClose, onComplete }: BatchSendDialogProps) {
  const [bccSelf, setBccSelf]       = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy]             = useState(false);
  const [result, setResult]         = useState<BatchSendInvoicesResponse | null>(null);

  const groups = useMemo(() => {
    const byBroker = new Map<string, { broker: Customer | null; rows: Invoice[] }>();
    for (const inv of invoices) {
      const key = inv.customerId ?? '__missing__';
      const cur = byBroker.get(key);
      if (cur) cur.rows.push(inv);
      else byBroker.set(key, {
        broker: inv.customerId ? customerById.get(inv.customerId) ?? null : null,
        rows:   [inv],
      });
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
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 620, maxWidth: '94vw', maxHeight: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Send size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            {result ? 'Batch send results' : `Send ${invoices.length} invoice${invoices.length === 1 ? '' : 's'} — ${groups.length} broker${groups.length === 1 ? '' : 's'}`}
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
                  Some selected invoices have no broker set. Open them individually to fix.
                </div>
              )}
              {missingEmail && !missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Some brokers have no saved AP email — their invoices will be skipped.
                </div>
              )}

              <div className="space-y-2">
                {groups.map((g, i) => {
                  return (
                    <div key={i} className="px-3 py-2 rounded-lg" style={{ border: '1px solid var(--gc-border-light)' }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          {g.broker ? (
                            onOpenBroker ? (
                              <button onClick={() => onOpenBroker(g.broker!.id)}
                                className="font-semibold text-[13px] truncate hover:underline"
                                style={{ color: '#1a73e8' }}>
                                {g.broker.name}
                              </button>
                            ) : (
                              <div className="font-semibold text-[13px] truncate" style={{ color: 'var(--gc-text-1)' }}>{g.broker.name}</div>
                            )
                          ) : (
                            <div className="font-semibold text-[13px] truncate" style={{ color: '#dc2626' }}>(no broker set)</div>
                          )}
                          <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                            {g.broker?.invoiceEmail ?? (
                              <span style={{ color: '#9a3412' }}>
                                (no AP email — {onOpenBroker && g.broker ? (
                                  <button onClick={() => onOpenBroker(g.broker!.id)} className="underline font-semibold">fix in profile</button>
                                ) : 'set one in profile'})
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-[12px] text-right shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                          {g.rows.length} invoice{g.rows.length === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                  );
                })}
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
                  g.status === 'sent'              ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Sent' } :
                  g.status === 'skipped_no_email'  ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email' } :
                                                     { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed' };
                return (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-[13px] truncate">{g.brokerName}</div>
                        <div className="text-[11.5px] opacity-80 truncate">{g.to ?? '—'}</div>
                        {g.error && <div className="text-[11.5px] opacity-90 mt-0.5">{g.error}</div>}
                      </div>
                      <div className="text-[12px] text-right shrink-0 font-semibold uppercase tracking-wide">{tone.label}</div>
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
              <button onClick={() => void handleSend()} disabled={busy || missingBroker}
                className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: '#1a73e8', color: '#fff' }}>
                {busy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
                Send
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

// ─── Primitives ─────────────────────────────────────────────────────────

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th className="px-4 py-2.5 text-[11px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--gc-text-3)', textAlign: align ?? 'left' }}>
      {children}
    </th>
  );
}

function Td({ children, align, className, style, onClickStopProp }: { children: React.ReactNode; align?: 'right'; className?: string; style?: React.CSSProperties; onClickStopProp?: boolean }) {
  return (
    <td className={`px-4 py-2.5 ${className ?? ''}`}
      style={{ textAlign: align ?? 'left', ...(style ?? {}) }}
      onClick={onClickStopProp ? (e) => e.stopPropagation() : undefined}>
      {children}
    </td>
  );
}

function StatusPill({ status }: { status: InvoiceStatus }) {
  const palette: Record<InvoiceStatus, { bg: string; fg: string; border: string; label: string }> = {
    draft: { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1', label: 'Unsent' },
    sent:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Sent'   },
    paid:  { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Paid'   },
    void:  { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Void'   },
  };
  const p = palette[status];
  return (
    <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full inline-block"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
      {p.label}
    </span>
  );
}

function Empty({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-sm" style={{ color: 'var(--gc-text-3)' }}>
      {icon}
      <div>{title}</div>
      {sub && <div className="text-[12px]">{sub}</div>}
    </div>
  );
}
