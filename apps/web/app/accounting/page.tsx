'use client';

/**
 * /accounting — billing pipeline.
 *
 * Workflow split (vs /closeout):
 *   - /closeout    = "is this paperwork correct?"  POD verification.
 *   - /accounting  = "let's bill and get paid."    Billing pipeline.
 *
 * Visual style mirrors /closeout: sortable + filterable column headers,
 * copyable cells, doc badges, columns show/hide menu, paginated table.
 * Same primitives are imported from queue/QueueTablePrimitives so the
 * two queues stay in lockstep.
 *
 * Buckets:
 *   Released  — verified loads with no active invoice  (bill these)
 *   Queued    — invoices drafted but unsent             (send these)
 *   Invoiced  — sent invoices awaiting payment          (collect)
 *   Paid      — closed out
 *   All       — every billable artifact (except voids)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Receipt, Loader2, AlertCircle, Search, X, Send, Check, FilePlus,
  AlertOctagon, Inbox, CircleCheckBig, CheckCircle2, Layers, Eye, Star, RefreshCw,
} from 'lucide-react';
import { useAuth, useUser } from '@clerk/nextjs';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import EventModal from '@/components/calendar/EventModal';
import { railway, RailwayError } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import InternalNotesModal from '@/components/closeout/InternalNotesModal';
import {
  Th, Td, DocBadge, RequiredDocBadge, AccessorialsCell, CopyableCell, CopyableLoadNum, NotesButton,
  moneyFmt, fmtShortDate, daysSince,
} from '@/components/queue/QueueTablePrimitives';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import type {
  Invoice, InvoiceStatus, Customer, LoadSummary,
  BatchGenerateInvoicesResponse, BatchSendInvoicesResponse,
} from '@fleetcal/types';

// ─── Buckets ────────────────────────────────────────────────────────────

type Bucket = 'released' | 'queued' | 'invoiced' | 'paid' | 'all';

const BUCKETS: Array<{ key: Bucket; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; tint: string; subtitle: string }> = [
  { key: 'released', label: 'Released',  icon: AlertOctagon,    tint: '#1a73e8', subtitle: 'Paperwork verified · ready to invoice' },
  { key: 'queued',   label: 'Queued',    icon: Inbox,           tint: '#9333ea', subtitle: 'Invoice generated · waiting to be sent' },
  { key: 'invoiced', label: 'Invoiced',  icon: CircleCheckBig,  tint: '#1d4ed8', subtitle: 'Invoice sent · awaiting payment'       },
  { key: 'paid',     label: 'Paid',      icon: CheckCircle2,    tint: '#16a34a', subtitle: 'Payment received'                       },
  { key: 'all',      label: 'All',       icon: Layers,          tint: '#5f6368', subtitle: 'All released loads'                     },
];

// ─── Columns ────────────────────────────────────────────────────────────

type ColKey =
  | 'internalId' | 'invoiceNum' | 'loadNum' | 'customer' | 'driver' | 'truck' | 'title'
  | 'rate' | 'accessorials' | 'total'
  | 'docs'
  | 'age' | 'pickupAt' | 'deliveryAt' | 'released' | 'issued' | 'due'
  | 'method' | 'sendTo' | 'status'
  | 'flags' | 'view';

// Default column widths in px. Passed to OpsColumn.width so the
// dispatcher gets a sensible starting layout. OpsTable persists user
// hide/show + order per persistKey; widths aren't user-resizable
// yet (deferred from v1 of the port).
const DEFAULT_COL_WIDTHS: Record<ColKey, number> = {
  age:           80,
  pickupAt:     100,
  deliveryAt:   100,
  released:     100,
  issued:       100,
  due:          100,
  internalId:   110,
  invoiceNum:   120,
  loadNum:      120,
  driver:       140,
  truck:         80,
  title:        280,
  customer:     170,
  method:       100,
  sendTo:       220,
  rate:         110,
  accessorials: 130,
  total:        120,
  docs:         240,
  status:       110,
  // flags now carries 3 controls (star + notes + view/docs) so it
  // needs more horizontal room than the original star-only cell.
  flags:        150,
  view:          80,
};

// Per-bucket column visibility. Omits columns entirely (rather than
// hiding) so they don't show up in the Columns picker on the wrong
// bucket. Released has no invoice yet, so invoice-specific cols
// vanish; Invoiced/Paid have sent already, so Send-to vanishes.
// The View / Docs button is rendered inline inside the flags cell
// now, so the legacy `view` key no longer corresponds to a real
// column — nothing to omit there.
const COLS_OMITTED_PER_BUCKET: Record<Bucket, Set<ColKey>> = {
  released: new Set(['invoiceNum', 'issued', 'due', 'status']),
  queued:   new Set(['status']),
  invoiced: new Set(['status', 'sendTo']),
  paid:     new Set(['status', 'sendTo']),
  all:      new Set(['sendTo']),
};

const PAGE_SIZE = 50;

// ─── Page ───────────────────────────────────────────────────────────────

import RequireCap from '@/components/auth/RequireCap';

export default function AccountingPage() {
  return (
    <RequireCap cap="accounting.access" module="accounting">
      <AccountingPageInner />
    </RequireCap>
  );
}

function AccountingPageInner() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const customers = useCalendarStore(s => s.customers);
  // Assets from the calendar store — used to resolve pickupAssetId to a
  // truck display string in the Truck column. The store hydrates on
  // app start so it's reliably populated by the time Billing renders.
  const assets = useCalendarStore(s => s.assets);
  const assetNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of assets) {
      const label = `${a.name ?? ''}${a.unit ? ` #${a.unit}` : ''}`.trim();
      if (label) m.set(a.id, label);
    }
    return m;
  }, [assets]);
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const [bucket, setBucket] = useState<Bucket>('released');

  // Source data — single call to /v1/reports/loads returns load-shaped
  // rows (one per loadId). No relay-leg dedup needed; the server has
  // already joined events back into their parent load. Invoices come
  // from the dedicated /v1/invoices endpoint and are matched by loadId.
  const [loads,       setLoads]       = useState<LoadSummary[]>([]);
  const [allInvoices, setAllInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // UI state — sort, filters, pagination, and column visibility now
  // live inside OpsTable. We mirror the selection set externally so
  // the bulk-action handlers can reach into it from outside the
  // table's bulkActions slot (e.g. the BatchSendDialog needs to map
  // invoice ids → loads for broker resolution).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Bumping this versioned key remounts OpsTable on bucket change so
  // its internal selection set + sort/filter reset cleanly.
  const [tableResetKey, setTableResetKey] = useState(0);
  const [search, setSearch] = useState('');
  // Collapses the bucket tiles' detail rows ($ value + subtitle) once
  // the user scrolls down inside the table. Hysteresis on the
  // thresholds (40 px to collapse / 8 px to expand) avoids flicker
  // when the operator noodles near the top. Mirrors the Paperwork
  // page so both surfaces feel the same.
  const [tilesCompact, setTilesCompact] = useState(false);

  // Sibling modals
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  // Single modal for inspecting an invoice — shows the PDF + actions
  // side-by-side. Opened from the View button on each row.
  const [invoiceModalId,  setInvoiceModalId]  = useState<string | null>(null);
  // Released-bucket peek: shows what docs would land in the eventual
  // invoice packet (rate con + POD/BOL/lumper/scale/etc.) so the
  // dispatcher can spot-check paperwork BEFORE clicking Generate.
  // Keyed by loadId (not invoiceId — released loads have no invoice
  // yet). null = closed.
  const [docsPreviewLoad, setDocsPreviewLoad] = useState<LoadSummary | null>(null);
  const [summaryAction,   setSummaryAction]   = useState<null | 'generate' | 'generateSend'>(null);
  const [batchSendOpen,   setBatchSendOpen]   = useState(false);
  const [batchResendOpen, setBatchResendOpen] = useState(false);
  const [notesTarget,     setNotesTarget]     = useState<LoadSummary | null>(null);
  const [markPaidBusy,    setMarkPaidBusy]    = useState(false);

  // Reset selection on bucket change so a stale id can't get acted on
  // against the wrong list. Sort / filter / pagination resets are
  // handled by OpsTable via the tableResetKey remount.
  useEffect(() => {
    setSelectedIds([]);
    setTableResetKey(k => k + 1);
  }, [bucket]);

  // ── Data fetch ──────────────────────────────────────────────────────
  //
  // One server call fetches every load in billing_status ∈ {verified,
  // invoiced, paid} — that's the entire accounting universe. The
  // server already returns one row per load (relays collapsed into
  // legs[]), so there's nothing to dedup client-side. 5000 limit is
  // ample for a year's worth of loads at any reasonable fleet size;
  // we log a warning if we hit the ceiling so the operator catches
  // it before totals start drifting.
  const BUCKET_LIMIT = 5000;
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [loadsRes, invoicesRes] = await Promise.all([
        railway.listLoadSummaries({
          billingStatus: 'verified,invoiced,paid',
          limit:         String(BUCKET_LIMIT),
        }),
        railway.listInvoices({}),
      ]);
      if (loadsRes.loads.length >= BUCKET_LIMIT || loadsRes.total > BUCKET_LIMIT) {
        console.warn(`[accounting] /reports/loads returned ${loadsRes.loads.length} of ${loadsRes.total} — totals may be undercounting; bump BUCKET_LIMIT`);
      }
      setLoads(loadsRes.loads);
      setAllInvoices(invoicesRes.invoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounting data');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn]);

  // Re-sync the table whenever a load is edited via EventModal anywhere
  // in the app. The store bumps loadEditTick after each successful
  // railway.updateLoad; without this, picking a customer in the modal
  // and saving would leave the accounting row showing the stale broker
  // text + the wrong findCustomerForLoad fallback.
  const loadEditTick = useCalendarStore(s => s.loadEditTick);
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    // Skip the initial render — the mount-effect above already fetched.
    if (loadEditTick === 0) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEditTick]);

  // ── Build rows per bucket ───────────────────────────────────────────
  //
  // A row marries a LoadSummary with its active invoice (when one
  // exists). The /reports/loads endpoint returns one entry per load
  // (relays already collapsed into legs[]) so there's no client-side
  // dedup work to do. Buckets are computed by partitioning on
  // billingStatus + the matched invoice's status.

  interface Row {
    load:     LoadSummary;
    invoice?: Invoice;
    customer?: Customer;
  }

  const invoiceByLoadId = useMemo(() => {
    const m = new Map<string, Invoice>();
    for (const inv of allInvoices) {
      if (inv.status === 'void') continue;
      // Most-recent non-void wins (active invoice).
      const cur = m.get(inv.loadId);
      if (!cur || inv.issuedAt > cur.issuedAt) m.set(inv.loadId, inv);
    }
    return m;
  }, [allInvoices]);

  // Resolve customer for a load. Prefer the explicit customerId; if
  // not set (legacy loads), fall back to a fuzzy name+aliases match.
  // Genericized so it works against either Load or LoadSummary.
  function findCustomerForLoad(l: { customerId?: string; broker?: string }): Customer | undefined {
    if (l.customerId) return customerById.get(l.customerId);
    if (!l.broker)    return undefined;
    return customers.find(c => c.name === l.broker || (c.aliases ?? []).includes(l.broker ?? ''));
  }

  /** Calendar event id for the load — the pickup leg's eventId.
   *  Used to open the load in EventModal (which keys on events). */
  function pickupEventId(l: LoadSummary): string | undefined {
    return l.legs.find(g => g.relayRole === 'pickup' || !g.relayRole)?.eventId
        ?? l.legs[0]?.eventId;
  }

  const allRowsRaw: Row[] = useMemo(() => loads.map(l => ({
    load:     l,
    invoice:  invoiceByLoadId.get(l.loadId),
    customer: findCustomerForLoad(l),
  })), [loads, invoiceByLoadId, customerById, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bucket partition. Released = verified loads not yet invoiced.
  // Queued / Invoiced both share billingStatus='invoiced' but split
  // on the matched invoice's status (draft vs sent). Paid = paid.
  const releasedRows = useMemo(
    () => allRowsRaw.filter(r => r.load.billingStatus === 'verified'),
    [allRowsRaw],
  );
  const queuedRows = useMemo(
    () => allRowsRaw.filter(r => r.load.billingStatus === 'invoiced' && r.invoice?.status === 'draft'),
    [allRowsRaw],
  );
  const invoicedRows = useMemo(
    () => allRowsRaw.filter(r => r.load.billingStatus === 'invoiced' && r.invoice?.status === 'sent'),
    [allRowsRaw],
  );
  const paidRows = useMemo(
    () => allRowsRaw.filter(r => r.load.billingStatus === 'paid'),
    [allRowsRaw],
  );
  // "All" excludes loads still in `verified` (those live in Released).
  // Mirrors the prior behaviour which only summed queued+invoiced+paid.
  const allRows = useMemo(
    () => [...queuedRows, ...invoicedRows, ...paidRows],
    [queuedRows, invoicedRows, paidRows],
  );

  const rowsForBucket: Row[] = bucket === 'released' ? releasedRows
                              : bucket === 'queued'   ? queuedRows
                              : bucket === 'invoiced' ? invoicedRows
                              : bucket === 'paid'     ? paidRows
                                                      : allRows;

  // ── Bucket stats (count + $ — uses raw bucket counts, not filtered) ─
  const stats = useMemo(() => {
    // For Released, sum total_billable (linehaul + accessorials) so the
    // bucket header reflects what the invoices WILL bill, not just
    // linehaul. For invoiced/paid, prefer the invoice's snapshot total
    // (immutable, broker-facing), falling back to total_billable if the
    // invoice somehow lacks it.
    const sumLoadsRows   = (rs: Row[]) => rs.reduce((s, r) => s + (r.load.totalBillable ?? r.load.loadPrice ?? 0), 0);
    const sumInvoiceRows = (rs: Row[]) => rs.reduce((s, r) => s + (r.invoice?.total ?? r.load.totalBillable ?? r.load.loadPrice ?? 0), 0);
    return {
      released: { count: releasedRows.length, total: sumLoadsRows(releasedRows) },
      queued:   { count: queuedRows.length,   total: sumInvoiceRows(queuedRows) },
      invoiced: { count: invoicedRows.length, total: sumInvoiceRows(invoicedRows) },
      paid:     { count: paidRows.length,     total: sumInvoiceRows(paidRows) },
      all:      { count: allRows.length,      total: sumInvoiceRows(allRows) },
    };
  }, [releasedRows, queuedRows, invoicedRows, paidRows, allRows]);

  // Client-side search runs across the bucket's rows before OpsTable
  // applies its own filters/sort/pagination. The OpsTable filter
  // chips handle Customer / Method / Status / Released / Issued / Due
  // — the search box on the toolbar handles the broader keyword scan
  // across invoice #, load #, customer name, title, internal id.
  const searchedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rowsForBucket;
    return rowsForBucket.filter(r =>
         (r.invoice?.invoiceNumber ?? '').toLowerCase().includes(q)
      || (r.load.loadNum ?? '').toLowerCase().includes(q)
      || (r.customer?.name ?? r.load.broker ?? '').toLowerCase().includes(q)
      || (r.load.title ?? '').toLowerCase().includes(q)
      || String(r.load.internalLoadId ?? '').includes(q),
    );
  }, [rowsForBucket, search]);

  // Selection lookups — mirror what the bulk-action handlers need.
  // selectedIds holds the rowKey for each selected row; we resolve
  // them back to load/invoice arrays here.
  const canSelect = bucket === 'released' || bucket === 'queued' || bucket === 'invoiced';
  const selectedLoads = useMemo(() => {
    if (bucket !== 'released') return [];
    const set = new Set(selectedIds);
    return rowsForBucket.filter(r => set.has(r.load.loadId)).map(r => r.load);
  }, [bucket, rowsForBucket, selectedIds]);
  const selectedInvoices = useMemo(() => {
    if (bucket !== 'queued' && bucket !== 'invoiced') return [];
    const set = new Set(selectedIds);
    return rowsForBucket.filter(r => r.invoice && set.has(r.invoice.id)).map(r => r.invoice!);
  }, [bucket, rowsForBucket, selectedIds]);

  async function handleMarkPaid() {
    if (selectedInvoices.length === 0 || markPaidBusy) return;
    setMarkPaidBusy(true);
    try {
      for (const inv of selectedInvoices) {
        try { await railway.markInvoicePaid(inv.id, {}); }
        catch (err) { console.warn('[accounting] markPaid failed for', inv.invoiceNumber, err); }
      }
      await refresh();
      setSelectedIds([]);
      setTableResetKey(k => k + 1);
    } finally {
      setMarkPaidBusy(false);
    }
  }

  // Regenerate selected draft invoices. Server-side endpoint is atomic
  // void+create — call sites only deal with successes/failures per row.
  // Sent or paid invoices are filtered out client-side; the server
  // would 409 on them anyway, but filtering avoids the noise.
  const [regenBusy, setRegenBusy] = useState(false);
  async function handleRegenerateSelected() {
    if (regenBusy) return;
    const drafts = selectedInvoices.filter(inv => inv.status === 'draft');
    if (drafts.length === 0) return;
    setRegenBusy(true);
    const failed: string[] = [];
    try {
      for (const inv of drafts) {
        try { await railway.regenerateInvoice(inv.id); }
        catch (err) {
          console.warn('[accounting] regenerate failed for', inv.invoiceNumber, err);
          failed.push(inv.invoiceNumber);
        }
      }
      await refresh();
      setSelectedIds([]);
      setTableResetKey(k => k + 1);
      if (failed.length > 0) {
        alert(`Regenerated ${drafts.length - failed.length} of ${drafts.length} invoices. Failed: ${failed.join(', ')}`);
      }
    } finally {
      setRegenBusy(false);
    }
  }

  const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;

  // In-place patch on the locally-cached loads array. Used to avoid
  // a full refresh() round-trip for lightweight mutations (priority
  // star, internal-note add) — those land via Supabase realtime in
  // the next natural refresh cycle anyway, so the local optimistic
  // update is a free win on perceived latency.
  const patchLoadInState = useCallback((loadId: string, patch: Partial<LoadSummary>) => {
    setLoads(prev => prev.map(l => l.loadId === loadId ? { ...l, ...patch } : l));
  }, []);

  // ── OpsTable column config ──────────────────────────────────────────
  // One OpsColumn per visible column. Closures capture state setters
  // so each cell can wire its own action handlers. Per-bucket col
  // omission filters the array AFTER build so the visibility picker
  // never shows columns that don't make sense for the active bucket.
  const tableColumns = useMemo<OpsColumn<Row>[]>(() => {
    const all: OpsColumn<Row>[] = [];

    // Far-left utility cell: priority star, internal-notes button, and
    // the row's primary action (View invoice / View docs). Merged into
    // a single column so all three sit inline with each other —
    // visually anchored to the row's left edge where the eye lands
    // first. The action button is rendered with whitespace-nowrap so
    // a "Docs" or "View" label can't wrap when the cell is tight.
    all.push({
      key: 'flags', header: '', width: DEFAULT_COL_WIDTHS.flags,
      pinned: 'left', alwaysVisible: true, pickerLabel: 'Star / notes / view',
      render: r => {
        const notesCount = (r.load.internalNotes ?? []).length;
        return (
          <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <PriorityToggle load={r.load} actorName={actorName}
              onAfter={(nextPriority) => patchLoadInState(r.load.loadId, { pickupPriority: nextPriority })} />
            <NotesButton count={notesCount} onOpen={() => setNotesTarget(r.load)} />
            {r.invoice ? (
              <button onClick={() => setInvoiceModalId(r.invoice!.id)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                title="View invoice — PDF + actions">
                <Eye size={11} /> View
              </button>
            ) : (
              <button onClick={() => setDocsPreviewLoad(r.load)}
                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                title="Preview the docs that will be attached to the invoice packet">
                <Eye size={11} /> Docs
              </button>
            )}
          </div>
        );
      },
    });

    all.push({
      key: 'internalId', header: 'ID / Inv #', width: DEFAULT_COL_WIDTHS.internalId,
      sortable: true,
      sortValue: r => r.load.internalLoadId ?? 0,
      render: r => r.load.internalLoadId != null
        ? <CopyableCell value={String(r.load.internalLoadId)} displayValue={String(r.load.internalLoadId)} title="Copy ID / invoice #" />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    all.push({
      key: 'invoiceNum', header: 'Invoice #', width: DEFAULT_COL_WIDTHS.invoiceNum,
      sortable: true,
      sortValue: r => r.invoice?.invoiceNumber ?? '',
      render: r => r.invoice
        ? <CopyableCell value={r.invoice.invoiceNumber} displayValue={`#${r.invoice.invoiceNumber}`} title="Copy invoice #" />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    all.push({
      key: 'loadNum', header: 'Load #', width: DEFAULT_COL_WIDTHS.loadNum,
      sortable: true,
      sortValue: r => r.load.loadNum ?? '',
      render: r => r.load.loadNum
        ? <CopyableLoadNum value={r.load.loadNum} />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    all.push({
      key: 'customer', header: 'Customer', width: DEFAULT_COL_WIDTHS.customer,
      sortable: true,
      sortValue: r => r.customer?.name ?? r.load.broker ?? '',
      render: r => {
        const cust = displayBrokerName(r.customer?.name ?? r.load.broker ?? '', customers);
        const method = r.customer?.invoiceMethod ?? 'email';
        const missingEmail = method === 'email' && !r.customer?.invoiceEmail && (bucket === 'released' || r.invoice?.status === 'draft');
        return (
          <div className="flex items-center gap-1.5">
            {r.customer ? (
              <button onClick={(e) => { e.stopPropagation(); setBrokerProfileId(r.customer!.id); }}
                className="text-left hover:underline truncate"
                style={{ color: 'var(--gc-blue)' }}>{cust}</button>
            ) : (
              <span className="truncate" style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                {cust || '—'}
              </span>
            )}
            {missingEmail ? (
              <button onClick={(e) => { e.stopPropagation(); r.customer && setBrokerProfileId(r.customer.id); }}
                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
                title="No invoice email set"><AlertCircle size={9} /> No email</button>
            ) : null}
          </div>
        );
      },
    });

    all.push({
      key: 'driver', header: 'Driver(s)', width: DEFAULT_COL_WIDTHS.driver,
      sortable: true,
      sortValue: r => r.load.pickupDriverName ?? '',
      render: r => {
        const pickup = r.load.pickupDriverName;
        const delivery = r.load.deliveryDriverName;
        const drivers: string[] = [];
        if (pickup) drivers.push(pickup);
        if (delivery && delivery !== pickup) drivers.push(delivery);
        if (drivers.length === 0) return <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>;
        if (drivers.length === 1) return <span>{drivers[0]}</span>;
        return (
          <div>
            <div className="text-[12.5px]">{drivers[0]}</div>
            <div className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>+ {drivers[1]}</div>
          </div>
        );
      },
    });

    all.push({
      key: 'truck', header: 'Truck', width: DEFAULT_COL_WIDTHS.truck,
      sortable: true,
      sortValue: r => assetNameById.get(r.load.pickupAssetId) ?? '',
      render: r => {
        const pickup = assetNameById.get(r.load.pickupAssetId);
        const delivery = assetNameById.get(r.load.deliveryAssetId);
        if (!pickup && !delivery) return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        if (!delivery || pickup === delivery) {
          return <span className="font-semibold tabular-nums">{pickup ?? '—'}</span>;
        }
        return (
          <div>
            <div className="text-[12.5px] font-semibold tabular-nums">{pickup ?? '—'}</div>
            <div className="text-[10.5px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>+ {delivery}</div>
          </div>
        );
      },
    });

    all.push({
      key: 'rate', header: 'Linehaul', width: DEFAULT_COL_WIDTHS.rate,
      align: 'right', sortable: true,
      sortValue: r => r.load.loadPrice ?? 0,
      render: r => (
        <span className="tabular-nums">
          {r.load.loadPrice != null ? moneyFmt.format(r.load.loadPrice) : '—'}
        </span>
      ),
    });

    all.push({
      key: 'accessorials', header: 'Accessorials', width: DEFAULT_COL_WIDTHS.accessorials,
      align: 'right', sortable: true,
      sortValue: r => (r.load.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0),
      render: r => <AccessorialsCell items={r.load.accessorials} />,
    });

    all.push({
      key: 'total', header: 'Total', width: DEFAULT_COL_WIDTHS.total,
      align: 'right', sortable: true,
      // Prefer the invoice snapshot total (immutable, broker-facing)
      // for invoiced/paid; for Released-bucket rows (no invoice yet),
      // use the server-computed total_billable. Either way we avoid
      // recomputing the math client-side — it's the trigger's job now.
      sortValue: r => r.invoice?.total ?? r.load.totalBillable ?? (r.load.loadPrice ?? 0),
      render: r => {
        const tot = r.invoice
          ? r.invoice.total
          : r.load.totalBillable ?? r.load.loadPrice ?? null;
        return (
          <span className="font-extrabold tabular-nums">
            {tot != null ? moneyFmt.format(tot) : '—'}
          </span>
        );
      },
    });

    all.push({
      key: 'docs', header: 'Docs', width: DEFAULT_COL_WIDTHS.docs,
      render: r => {
        const counts = r.load.documentCounts ?? {};
        const rcCount  = Math.max(counts.rate_con ?? 0, r.load.rateConPdf ? 1 : 0);
        const podCount = counts.pod ?? 0;
        // Lumper / Scale are conditionally required — only when the
        // load has a matching accessorial line item. Mirrors the
        // Paperwork docs column + the ReviewQueue verification chips.
        const accs = r.load.accessorials ?? [];
        const needsLumper = accs.some(a => a.category === 'lumper');
        const needsScale  = accs.some(a => a.category === 'scale_ticket');
        const lumperCount = counts.lumper ?? 0;
        const scaleCount  = counts.scale  ?? 0;
        return (
          <div className="flex flex-wrap gap-1">
            <RequiredDocBadge
              label="RC"
              present={rcCount > 0}
              count={rcCount}
              missingTitle="No rate confirmation uploaded"
            />
            {!r.load.isTonu && (
              <RequiredDocBadge
                label="POD"
                present={podCount > 0}
                count={podCount}
                missingTitle="No POD uploaded"
              />
            )}
            {needsLumper && (
              <RequiredDocBadge
                label="Lumper"
                present={lumperCount > 0}
                count={lumperCount}
                missingTitle="No lumper receipt uploaded"
              />
            )}
            {needsScale && (
              <RequiredDocBadge
                label="Scale"
                present={scaleCount > 0}
                count={scaleCount}
                missingTitle="No scale ticket uploaded"
              />
            )}
            {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol}          />}
            {/* Lumper / Scale fall back to plain DocBadge only when the
                load has NO matching accessorial but the doc is on file. */}
            {!needsLumper && lumperCount > 0 && <DocBadge label="Lumper"  count={lumperCount}       />}
            {!needsScale  && scaleCount  > 0 && <DocBadge label="Scale"   count={scaleCount}        />}
            {(counts.receipt      ?? 0) > 0 && <DocBadge label="Receipt" count={counts.receipt}      />}
            {(counts.driver_sheet ?? 0) > 0 && <DocBadge label="Driver"  count={counts.driver_sheet} />}
            {(counts.invoice      ?? 0) > 0 && <DocBadge label="Invoice" count={counts.invoice}      />}
          </div>
        );
      },
    });

    all.push({
      key: 'age', header: 'Age', width: DEFAULT_COL_WIDTHS.age,
      sortable: true,
      // deliveryAt is already the actual delivery (for relays the
      // server resolves to the delivery leg's end). No leg lookup
      // needed any more.
      sortValue: r => daysSince(r.load.deliveryAt),
      render: r => {
        const a = daysSince(r.load.deliveryAt);
        return (
          <span style={{ background: ageBg(a), color: ageFg(a), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
            {a === 0 ? 'today' : a === 1 ? '1 day' : `${a}d`}
          </span>
        );
      },
    });

    all.push({
      key: 'released', header: 'Released', width: DEFAULT_COL_WIDTHS.released,
      sortable: true,
      sortValue: r => r.load.verifiedAt ?? '',
      render: r => r.load.verifiedAt ? fmtShortDate(r.load.verifiedAt) : '—',
    });

    all.push({
      key: 'issued', header: 'Issued', width: DEFAULT_COL_WIDTHS.issued,
      sortable: true,
      sortValue: r => r.invoice?.issuedAt ?? '',
      render: r => r.invoice?.issuedAt ? fmtShortDate(r.invoice.issuedAt) : '—',
    });

    all.push({
      key: 'due', header: 'Due', width: DEFAULT_COL_WIDTHS.due,
      sortable: true,
      sortValue: r => r.invoice?.dueAt ?? '',
      render: r => r.invoice?.dueAt ? fmtShortDate(r.invoice.dueAt) : '—',
    });

    // Pickup / Delivery — load-level dates, opt-in via the column
    // picker. Distinct from Released/Issued/Due (which are billing-
    // lifecycle timestamps) — these answer "when did the freight
    // actually move." Defaults hidden so the table stays narrow for
    // accounting's primary workflow; bookkeepers reconciling against
    // a pickup-week or delivery-week close can flip them on.
    // r.load.deliveryAt is already resolved server-side to the
    // delivery leg's end for relays (same source as the Age column).
    all.push({
      key: 'pickupAt', header: 'Pickup', width: DEFAULT_COL_WIDTHS.pickupAt,
      sortable: true, defaultHidden: true,
      sortValue: r => r.load.pickupAt ?? '',
      render: r => r.load.pickupAt ? fmtShortDate(r.load.pickupAt) : '—',
    });

    all.push({
      key: 'deliveryAt', header: 'Delivery', width: DEFAULT_COL_WIDTHS.deliveryAt,
      sortable: true, defaultHidden: true,
      sortValue: r => r.load.deliveryAt ?? '',
      render: r => r.load.deliveryAt ? fmtShortDate(r.load.deliveryAt) : '—',
    });

    all.push({
      key: 'title', header: 'Title', width: DEFAULT_COL_WIDTHS.title,
      sortable: true,
      sortValue: r => r.load.title ?? '',
      render: r => (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); void openLoadInModal(r.load); }}
          className="text-left font-semibold hover:underline truncate"
          style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
          title="Open load details">{r.load.title ?? `#${r.load.internalLoadId}`}</button>
      ),
    });

    all.push({
      key: 'method', header: 'Method', width: DEFAULT_COL_WIDTHS.method,
      sortable: true,
      sortValue: r => r.customer?.invoiceMethod ?? 'email',
      render: r => {
        const m = r.customer?.invoiceMethod ?? 'email';
        return (
          <span className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: m === 'portal' ? '#9a3412' : 'var(--gc-text-2)' }}>
            {m === 'portal' ? 'Portal' : 'Email'}
          </span>
        );
      },
    });

    all.push({
      key: 'sendTo', header: 'Send to', width: DEFAULT_COL_WIDTHS.sendTo,
      sortable: true,
      sortValue: r => r.customer?.invoiceEmail ?? '',
      render: r => {
        const m = r.customer?.invoiceMethod ?? 'email';
        if (m === 'portal') return <span className="text-[11.5px] italic" style={{ color: 'var(--gc-text-3)' }}>Portal — manual</span>;
        if (!r.customer?.invoiceEmail) return (
          <button onClick={(e) => { e.stopPropagation(); r.customer && setBrokerProfileId(r.customer.id); }}
            className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
            style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
            title="No invoice email — click to fix"><AlertCircle size={10} /> No email</button>
        );
        return <span className="text-[12px] tabular-nums truncate inline-block"
          style={{ color: 'var(--gc-text-1)', maxWidth: '100%' }}
          title={r.customer.invoiceEmail}>{r.customer.invoiceEmail}</span>;
      },
    });

    all.push({
      key: 'status', header: 'Status', width: DEFAULT_COL_WIDTHS.status,
      sortable: true,
      sortValue: r => r.invoice?.status ?? '',
      render: r => r.invoice
        ? <StatusPill status={r.invoice.status} />
        : <span style={{ color: 'var(--gc-text-3)' }}>—</span>,
    });

    // View column used to be pinned right; it now lives next to the
    // flags column (above) so the dispatcher's most-common action
    // sits where the eye lands first.

    // Strip columns that don't apply to the active bucket so the
    // picker doesn't expose useless toggles. e.g. Released has no
    // invoice yet → no invoice #, Issued, Due, View, or Status.
    const omit = COLS_OMITTED_PER_BUCKET[bucket];
    return all.filter(c => !omit.has(c.key as ColKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, bucket, actorName, assetNameById, patchLoadInState]);

  // OpsTable filters — Customer / Method / Status multi-selects plus
  // Released / Issued / Due date-range chips. Options come from the
  // current bucket's rows so users only see values that actually
  // exist there.
  const tableFilters = useMemo<OpsFilter<Row>[]>(() => {
    const customerOpts = Array.from(new Set(
      rowsForBucket.map(r => r.customer?.name ?? r.load.broker ?? '').filter(Boolean),
    )).sort().map(v => ({ value: v, label: v }));
    // Driver / Truck options scoped to the current bucket so the
    // dropdown only ever lists values that actually appear in the
    // visible loads. Mirrors the Paperwork filter pattern.
    const driverOpts = Array.from(new Set(
      rowsForBucket.flatMap(r => [r.load.pickupDriverName ?? '', r.load.deliveryDriverName ?? '']).filter(Boolean),
    )).sort().map(v => ({ value: v, label: v }));
    const truckOpts = Array.from(new Set(
      rowsForBucket.flatMap(r => [
        assetNameById.get(r.load.pickupAssetId) ?? '',
        assetNameById.get(r.load.deliveryAssetId) ?? '',
      ]).filter(Boolean),
    )).sort().map(v => ({ value: v, label: v }));

    // Accessorial filter — operator-centric presets mirror Paperwork.
    const accessorialOpts = [
      { value: '__any',        label: 'Has any accessorial' },
      { value: '__pending',    label: 'Has pending accessorial' },
      { value: '__none',       label: 'No accessorials' },
      { value: 'detention',    label: 'Detention' },
      { value: 'lumper',       label: 'Lumper' },
      { value: 'layover',      label: 'Layover' },
      { value: 'scale_ticket', label: 'Scale' },
      { value: 'extra_stop',   label: 'Extra stop' },
      { value: 'other',        label: 'Other' },
    ];
    const filters: OpsFilter<Row>[] = [
      { kind: 'select', key: 'customer', label: 'Customer',
        options: customerOpts,
        predicate: (r, v) => (r.customer?.name ?? r.load.broker ?? '') === v },
      { kind: 'select', key: 'driver', label: 'Driver',
        options: driverOpts,
        // Match either leg's driver — relays carry two drivers so the
        // user expects either name to surface the load.
        predicate: (r, v) => (r.load.pickupDriverName ?? '') === v
          || (r.load.deliveryDriverName ?? '') === v },
      { kind: 'select', key: 'truck', label: 'Truck',
        options: truckOpts,
        predicate: (r, v) => (assetNameById.get(r.load.pickupAssetId) ?? '') === v
          || (assetNameById.get(r.load.deliveryAssetId) ?? '') === v },
      { kind: 'select', key: 'method',   label: 'Method',
        options: [
          { value: 'email',  label: 'Email'  },
          { value: 'portal', label: 'Portal' },
        ],
        predicate: (r, v) => (r.customer?.invoiceMethod ?? 'email') === v },
      { kind: 'select', key: 'accessorial', label: 'Accessorial',
        options: accessorialOpts,
        predicate: (r, v) => {
          const accs = r.load.accessorials ?? [];
          if (v === '__any')     return accs.length > 0;
          if (v === '__pending') return accs.some(a => a.status !== 'approved' && a.status !== 'denied');
          if (v === '__none')    return accs.length === 0;
          return accs.some(a => a.category === v);
        } },
    ];
    // Status only meaningful on All bucket — other buckets are
    // already filtered to one status (Queued = draft, Invoiced = sent,
    // Paid = paid).
    if (bucket === 'all') {
      filters.push({
        kind: 'select', key: 'status', label: 'Status',
        options: [
          { value: 'draft', label: 'Unsent' },
          { value: 'sent',  label: 'Sent'   },
          { value: 'paid',  label: 'Paid'   },
        ],
        predicate: (r, v) => (r.invoice?.status ?? '') === v,
      });
    }
    // Released-date range only useful on buckets that have loads (all
    // of them). Issued / Due only on buckets that have invoices.
    filters.push({ kind: 'date-range', key: 'released', label: 'Released',
      getDate: r => r.load.verifiedAt ?? null });
    // Pickup / Delivery — load-level dates, available on every bucket
    // since every row has them. Distinct from Released (billing-
    // lifecycle): these answer "when did the freight actually move"
    // for reconciling against a pickup-week or delivery-week close.
    filters.push({ kind: 'date-range', key: 'pickup', label: 'Pickup',
      getDate: r => r.load.pickupAt ?? null });
    filters.push({ kind: 'date-range', key: 'delivery', label: 'Delivery',
      getDate: r => r.load.deliveryAt ?? null });
    if (bucket !== 'released') {
      filters.push({ kind: 'date-range', key: 'issued', label: 'Issued',
        getDate: r => r.invoice?.issuedAt ?? null });
      filters.push({ kind: 'date-range', key: 'due', label: 'Due',
        getDate: r => r.invoice?.dueAt ?? null });
    }
    return filters;
  }, [rowsForBucket, bucket, assetNameById]);

  // Row id for selection — bucket-specific (loadId on released,
  // invoice.id elsewhere with the loadId as the fallback).
  const rowKey = useCallback((r: Row) => {
    return bucket === 'released' ? r.load.loadId : (r.invoice?.id ?? r.load.loadId);
  }, [bucket]);

  // Open a load in the EventModal. EventModal keys on event id (legs),
  // so we resolve the pickup leg's eventId and merge the load's legs
  // into the calendar store if they aren't already there. Mirrors the
  // closeout page's openLoadInModal — same fetch-on-demand fallback.
  async function openLoadInModal(load: LoadSummary) {
    const eventId = pickupEventId(load);
    if (!eventId) return;
    const storeEvents = useCalendarStore.getState().events;
    const inStore = storeEvents.some(e => e.id === eventId);
    if (!inStore) {
      try {
        const { loads: legs } = await railway.getLoad(load.loadId);
        mergeEvents(legs);
      } catch (err) {
        console.error('[accounting] failed to load legs for modal:', err);
      }
    }
    openEditModal(eventId);
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <AppShell title="Billing" icon={Receipt} noPageScroll>
      <DataLoader />

      {/* The content area is a fixed-height flex column so the table
          can claim the remaining space and scroll INSIDE its own box.
          Outer page padding lives here; the table itself has no margin. */}
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">
        <div className="w-full min-h-0 flex-1 flex flex-col gap-4">

          {/* Purpose hint */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            Billing pipeline. Loads land in <strong>Released</strong> once Paperwork marks them verified.
            Generate invoices, track delivery, mark paid.
          </div>

          {/* Bucket tiles — full padding + value + subtitle on lg+ at
              the top of the page; collapse to a one-row icon + label +
              count once the user scrolls past 40 px inside the table
              (or on narrow screens). Mirrors the Paperwork bucket
              behaviour so the two surfaces feel the same. */}
          <div className={`grid ${tilesCompact ? 'gap-2' : 'gap-2 lg:gap-3'}`} style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {BUCKETS.map(b => {
              const active = bucket === b.key;
              const s = stats[b.key];
              const Icon = b.icon;
              return (
                <button key={b.key}
                  onClick={() => setBucket(b.key)}
                  className={`text-left rounded-xl transition-all ${
                    tilesCompact ? 'px-3 py-2' : 'px-3 lg:px-4 py-2 lg:py-3'
                  }`}
                  style={{
                    background: 'var(--gc-surface)',
                    border: active ? `2px solid ${b.tint}` : '1px solid var(--gc-border-light)',
                    boxShadow: active ? '0 4px 12px rgba(26,115,232,0.12)' : 'var(--shadow-1)',
                  }}>
                  <div className="flex items-center gap-2">
                    <Icon size={16} style={{ color: b.tint }} />
                    <span className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--gc-text-2)' }}>{b.label}</span>
                    <span className="ml-auto text-[15px] lg:text-[16px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{s.count.toLocaleString()}</span>
                  </div>
                  <div
                    className={`${tilesCompact ? 'hidden' : 'hidden lg:block'} mt-1.5 text-[12px] tabular-nums transition-all`}
                    style={{ color: 'var(--gc-text-3)' }}
                  >
                    {moneyFmt.format(s.total)}
                  </div>
                  <div
                    className={`${tilesCompact ? 'hidden' : 'hidden lg:block'} mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold transition-all`}
                    style={{ color: 'var(--gc-text-3)' }}
                  >
                    {b.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar — search + Refresh. Column picker + filter chips
              + bulk-action buttons all live INSIDE OpsTable below
              (the bulk-actions slot in particular replaces the
              chip row when rows are selected). */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder="Search customer, invoice #, load #, title…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{ width: 320, background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex-1" />
            <button onClick={() => void refresh()}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
              Refresh
            </button>
          </div>

          {/* Table — OpsTable owns sort, filter chips, column picker,
              selection, and built-in 50-row pagination. Per-bucket
              persistKey means each bucket remembers its own visible-
              column + order preferences. */}
          {error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 flex">
              <OpsTable<Row>
                key={`accounting-${bucket}-${tableResetKey}`}
                data={searchedRows}
                columns={tableColumns}
                filters={tableFilters}
                rowKey={rowKey}
                loading={loading}
                priorityKey={r => !!r.load.pickupPriority}
                columnPicker
                columnReorder
                persistKey={`accounting-${bucket}`}
                selectable={canSelect}
                onSelectionChange={setSelectedIds}
                pageSize={PAGE_SIZE}
                fillHeight
                onScrollChange={({ scrollTop }) => {
                  if (scrollTop > 40 && !tilesCompact) setTilesCompact(true);
                  else if (scrollTop < 8 && tilesCompact) setTilesCompact(false);
                }}
                emptyLabel={search.trim() !== ''
                  ? `No rows match "${search.trim()}".`
                  : 'No loads in this bucket.'}
                bulkActions={!canSelect ? undefined : ({ clearSelection }) => (
                  <div className="flex items-center gap-2">
                    {bucket === 'released' && (
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
                    {bucket === 'queued' && (
                      <>
                        <button onClick={() => void handleRegenerateSelected()} disabled={regenBusy}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                          style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                          {regenBusy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <RefreshCw size={12} className="inline mr-1.5" />}
                          Regenerate {selectedIds.length}
                        </button>
                        <button onClick={() => setBatchSendOpen(true)}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                          style={{ background: '#1a73e8', color: '#fff' }}>
                          <Send size={12} className="inline mr-1.5" /> Submit {selectedIds.length} invoice{selectedIds.length === 1 ? '' : 's'}
                        </button>
                      </>
                    )}
                    {bucket === 'invoiced' && (
                      <>
                        <button onClick={() => setBatchResendOpen(true)}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                          style={{ background: 'var(--gc-surface)', color: '#1a73e8', border: '1px solid #bfdbfe' }}>
                          <Send size={12} className="inline mr-1.5" /> Resend {selectedIds.length}
                        </button>
                        <button onClick={() => void handleMarkPaid()} disabled={markPaidBusy}
                          className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                          style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}>
                          {markPaidBusy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Check size={12} className="inline mr-1.5" />}
                          Mark {selectedIds.length} paid
                        </button>
                      </>
                    )}
                    {/* clearSelection is handled by OpsTable's own
                        "Clear" button to the right; no need to wire
                        anything extra. */}
                    {void clearSelection}
                  </div>
                )}
              />
            </div>
          )}
        </div>
      </div>

      {/* Sibling modals */}
      <EventModal />
      {brokerProfileId && (
        // No refresh() on close — the modal mutates customers via the
        // calendar store, and our row cells read the live customer from
        // that store, so a customer rename / email change re-renders
        // the right cells automatically without a server round-trip.
        // Refetching loads + invoices was flashing the whole table for
        // no data delta. The toolbar's Refresh button still works for
        // explicit reload.
        <BrokerProfileModal initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)} />
      )}
      {invoiceModalId && (
        <InvoiceDetailModal invoiceId={invoiceModalId}
          onClose={() => { setInvoiceModalId(null); void refresh(); }} />
      )}
      {docsPreviewLoad && (
        <LoadDocsPreviewModal
          load={docsPreviewLoad}
          onClose={() => setDocsPreviewLoad(null)}
          // After Save selection writes loads.invoice_doc_ids, refresh
          // the parent so the next open seeds from the freshly-saved
          // selection (the table reads invoiceDocIds off LoadSummary).
          onSaved={() => { setDocsPreviewLoad(null); void refresh(); }}
        />
      )}
      {summaryAction && (
        <InvoiceSummaryModal
          loads={selectedLoads}
          customerById={customerById}
          action={summaryAction}
          onClose={() => setSummaryAction(null)}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onComplete={() => { setSummaryAction(null); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh(); }} />
      )}
      {batchSendOpen && (
        <BatchSendDialog
          // Pre-resolve broker per invoice via the same load-based
          // lookup the table uses — so a stale invoice (drafted before
          // the broker was set) groups under the load's CURRENT broker
          // rather than under "(no broker set)".
          rows={(() => {
            const byInvId = new Map(rowsForBucket.map(r => [r.invoice?.id, r.load] as const));
            return selectedInvoices.map(inv => {
              const load = byInvId.get(inv.id);
              const broker = load ? findCustomerForLoad(load) ?? null : null;
              return { invoice: inv, broker };
            });
          })()}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onClose={() => setBatchSendOpen(false)}
          onComplete={() => { setBatchSendOpen(false); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh(); }} />
      )}
      {batchResendOpen && (
        // Same dialog as send, just hits the resend endpoint. Mode flag
        // switches title + button label + the underlying API call.
        <BatchSendDialog
          rows={(() => {
            const byInvId = new Map(rowsForBucket.map(r => [r.invoice?.id, r.load] as const));
            return selectedInvoices.map(inv => {
              const load = byInvId.get(inv.id);
              const broker = load ? findCustomerForLoad(load) ?? null : null;
              return { invoice: inv, broker };
            });
          })()}
          mode="resend"
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onClose={() => setBatchResendOpen(false)}
          onComplete={() => { setBatchResendOpen(false); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh(); }} />
      )}
      {notesTarget && (
        <InternalNotesModal load={notesTarget} actorName={actorName}
          onClose={() => setNotesTarget(null)}
          onSaved={(newNote) => {
            // Optimistic local append — avoid a full refresh round-trip.
            // The modal's optimistic write call ensures the server has
            // already accepted; a realtime echo will reconcile via the
            // store on the next natural refresh.
            if (newNote && notesTarget) {
              patchLoadInState(notesTarget.loadId, {
                internalNotes: [...(notesTarget.internalNotes ?? []), newNote],
              });
            }
            setNotesTarget(null);
          }} />
      )}
    </AppShell>
  );
}

// ─── PriorityToggle ─────────────────────────────────────────────────────
//
// Same toggle behavior /closeout uses — clicking flips the load's
// priority flag via the closeout PATCH endpoint. The row gets the
// yellow band + left border via the page's <tr> styling on next
// render after refresh().

function PriorityToggle({
  load, actorName, onAfter,
}: {
  /** LoadSummary's pickup-leg priority is the load's priority. */
  load:     { loadId: string; pickupPriority?: boolean };
  actorName?: string;
  /** Receives the NEW priority value once the server confirms the
   *  write. Used to optimistically patch the page's local row state
   *  without a full table refresh. */
  onAfter:  (nextPriority: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const on = !!load.pickupPriority;
  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const targetId = load.loadId;
      // Suppress the realtime echo of this load-level write so the
      // dispatcher doing the toggle doesn't get "updated by another
      // dispatcher" pop on themselves.
      useCalendarStore.getState().markLoadSelfWrite(targetId);
      await railway.updateLoadCloseout(targetId, {
        action: on ? 'clear_priority' : 'set_priority',
        actorName,
      });
      onAfter(!on);
    } catch (err) {
      console.error('[accounting] priority toggle failed:', err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={handleClick} disabled={busy}
      className="rounded-full p-1 transition-colors"
      title={on ? 'Clear priority' : 'Mark priority'}
      style={{
        background: on ? '#fef3c7' : 'transparent',
        border:     `1px solid ${on ? '#eab308' : 'var(--gc-border)'}`,
        color:      on ? '#854d0e' : 'var(--gc-text-3)',
      }}>
      <Star size={11} fill={on ? '#eab308' : 'none'} />
    </button>
  );
}

// (Relay dedupe removed — the /reports/loads endpoint already
// returns one row per load. legs[] carries both relay legs for
// detail consumers; the page no longer cares.)

// ─── Age color helpers (mirror closeout) ────────────────────────────────

function ageBg(days: number): string {
  if (days <= 1) return '#dcfce7';
  if (days <= 3) return '#fef3c7';
  if (days <= 7) return '#fed7aa';
  return '#fee2e2';
}
function ageFg(days: number): string {
  if (days <= 1) return '#15803d';
  if (days <= 3) return '#92400e';
  if (days <= 7) return '#9a3412';
  return '#991b1b';
}

// (BucketEmpty removed — OpsTable owns its own empty-state messaging
// via the emptyLabel prop on the consumer.)

// ─── Status pill ────────────────────────────────────────────────────────

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

// ─── Invoice Summary modal (batch generate from loads) ──────────────────
// Identical to the previous implementation — preserved here.

interface InvoiceSummaryModalProps {
  loads:        LoadSummary[];
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

  // Batch-generate summary uses total_billable (linehaul + accessorials)
  // so the "$X total" in the header matches what the invoices will bill.
  const totalAmount = loads.reduce((s, l) => s + (l.totalBillable ?? l.loadPrice ?? 0), 0);
  const willSend = action === 'generateSend';
  const missingEmail = willSend && loads.some(l => {
    const c = l.customerId ? customerById.get(l.customerId) : undefined;
    return c && (c.invoiceMethod ?? 'email') === 'email' && !c.invoiceEmail;
  });
  const hasPortal = willSend && loads.some(l => {
    const c = l.customerId ? customerById.get(l.customerId) : undefined;
    return c?.invoiceMethod === 'portal';
  });

  async function handleGo() {
    setBusy(true);
    try {
      const loadIds = loads.map(l => l.loadId);
      const res = await railway.batchGenerateInvoices({ loadIds, thenSend: willSend, bccSelf, attachLoadDocs });
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
              : `Invoice summary — ${loads.length} load${loads.length === 1 ? '' : 's'}, ${moneyFmt.format(totalAmount)}`
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
                  {/* Wrap message in a single span so it's one flex item.
                      Bare text nodes inside flex containers get split into
                      per-node flex items, which mangles emphasis tags
                      (the inline elements become vertically-centered
                      boxes that don't sit on the text baseline). */}
                  <span>Some customers have no saved AP email — their invoices will be created but skipped at the send step.</span>
                </div>
              )}
              {hasPortal && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    Portal customers won't get an email — their invoices flip to <strong>Sent</strong> so you can upload the packet to the portal yourself. Turn on <em>Bcc me a copy</em> to get the packet emailed to yourself.
                  </span>
                </div>
              )}

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
                      // Resolve the customer with the SAME name-fallback
                      // the server uses in buildSnapshot — exact
                      // case-insensitive match on name or alias when
                      // the FK is missing. Without this, the preview
                      // lied to the dispatcher: the row showed the
                      // broker name but no email, even though the
                      // server-side path would happily resolve and
                      // invoice the customer correctly (and backfill
                      // loads.customer_id on the way through).
                      const customer = (() => {
                        if (l.customerId) return customerById.get(l.customerId);
                        const broker = l.broker?.trim();
                        if (!broker) return undefined;
                        const lower = broker.toLowerCase();
                        const matches = Array.from(customerById.values()).filter(c =>
                          c.name.toLowerCase() === lower ||
                          (c.aliases ?? []).some(a => a.toLowerCase() === lower),
                        );
                        return matches.length === 1 ? matches[0] : undefined;
                      })();
                      const brokerName = customer?.name ?? l.broker ?? '—';
                      // Resolve where this invoice is actually heading
                      // so the dispatcher can sanity-check the
                      // destination before clicking Send. Email customers
                      // show the AP address (or a red "no email" badge
                      // when missing); portal customers show their
                      // portal label; loads with no customer record fall
                      // back to a muted "—".
                      const method = customer?.invoiceMethod ?? 'email';
                      const noEmail = customer && method === 'email' && !customer.invoiceEmail;
                      let destination: { label: string; tone: 'normal' | 'missing' | 'portal' } | null = null;
                      if (customer) {
                        if (method === 'portal') {
                          destination = { label: `Portal: ${customer.invoicePortal ?? '(no portal saved)'}`, tone: 'portal' };
                        } else if (customer.invoiceEmail) {
                          destination = { label: customer.invoiceEmail, tone: 'normal' };
                        } else {
                          destination = { label: 'No email saved', tone: 'missing' };
                        }
                      }
                      return (
                        <tr key={l.loadId} style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                          <Td>
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-1.5">
                                {customer ? (
                                  <button onClick={() => onOpenBroker(customer.id)}
                                    className="text-left hover:underline" style={{ color: 'var(--gc-text-1)' }}>
                                    {brokerName}
                                  </button>
                                ) : <span style={{ color: 'var(--gc-text-3)' }}>{brokerName}</span>}
                                {willSend && noEmail && (
                                  <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full"
                                    style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>No email</span>
                                )}
                              </div>
                              {destination && (
                                <div className="text-[11px] truncate"
                                  style={{
                                    color: destination.tone === 'missing' ? '#991b1b'
                                         : destination.tone === 'portal'  ? '#1d4ed8'
                                         : 'var(--gc-text-3)',
                                  }}
                                  title={destination.label}>
                                  {destination.label}
                                </div>
                              )}
                            </div>
                          </Td>
                          <Td className="tabular-nums">
                            {/* Show both numbers so the dispatcher can
                                cross-reference either when talking to the
                                broker (loadNum from the rate con) or with
                                accounting / internal notes (the sequential
                                org-internal #). loadNum on top, internal
                                muted below; when loadNum is missing the
                                internal becomes primary so we never show
                                "— / #10838". */}
                            {l.loadNum ? (
                              <div className="flex flex-col gap-0.5">
                                <span style={{ color: 'var(--gc-text-1)' }}>{l.loadNum}</span>
                                <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                                  #{l.internalLoadId}
                                </span>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--gc-text-1)' }}>#{l.internalLoadId}</span>
                            )}
                          </Td>
                          <Td align="right" className="tabular-nums font-semibold">
                            {/* Total billable — what the broker will actually be invoiced. */}
                            <span style={{ color: '#15803d' }}>{
                              (l.totalBillable ?? l.loadPrice) != null
                                ? moneyFmt.format(l.totalBillable ?? l.loadPrice!)
                                : '—'
                            }</span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Total row — sums every row's billable amount.
                      `totalAmount` is computed in the parent (same
                      value that drives the header "$X,XXX" total),
                      surfacing it here lets the dispatcher cross-check
                      the math without scrolling back up to the
                      title bar. */}
                  <tfoot>
                    <tr style={{ background: 'var(--gc-bg)', borderTop: '2px solid var(--gc-border-light)' }}>
                      <Td>
                        <span className="text-[11px] font-extrabold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
                          Total
                        </span>
                      </Td>
                      <Td className="tabular-nums">
                        <span style={{ color: 'var(--gc-text-3)' }}>
                          {loads.length} {loads.length === 1 ? 'load' : 'loads'}
                        </span>
                      </Td>
                      <Td align="right" className="tabular-nums font-extrabold">
                        <span style={{ color: '#15803d' }}>{moneyFmt.format(totalAmount)}</span>
                      </Td>
                    </tr>
                  </tfoot>
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
        <ResultStrip tone={{ bg: '#dcfce7', fg: '#166534', border: '#86efac' }}
          label={`${result.created.length} invoice${result.created.length === 1 ? '' : 's'} generated`} />
      )}
      {result.failed.length > 0 && (
        <div className="space-y-1">
          <ResultStrip tone={{ bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' }} label={`${result.failed.length} failed`} />
          <ul className="text-[11.5px] pl-3 space-y-0.5" style={{ color: '#991b1b' }}>
            {result.failed.map(f => <li key={f.loadId}>• {f.error}</li>)}
          </ul>
        </div>
      )}
      {result.sent && result.sent.length > 0 && (
        <div className="space-y-1.5">
          {result.sent.map((g, i) => {
            const tone =
              g.status === 'sent'                ? { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: `Sent · ${g.invoiceIds.length}` } :
              g.status === 'sent_portal'         ? { bg: '#dbeafe', fg: '#1e40af', border: '#bfdbfe', label: 'Portal — marked sent' } :
              g.status === 'skipped_no_email'    ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no AP email' } :
              g.status === 'skipped_no_customer' ? { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa', label: 'Skipped — no customer' } :
                                                   { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'Failed' };
            return (
              <div key={i} className="px-3 py-2 rounded-lg flex items-center justify-between gap-3"
                style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-[12.5px] truncate">{g.brokerName}</span>
                    {g.loadNumber && (
                      <span className="text-[11px] font-mono tabular-nums opacity-70 shrink-0">
                        #{g.loadNumber}
                      </span>
                    )}
                  </div>
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

/**
 * Released-bucket invoice-packet picker. Two-pane layout: a left
 * sidebar listing every doc on the load with checkboxes (Include in
 * invoice) and a right-side viewer that previews the doc the user
 * just clicked. Saves to load_documents.included_in_invoice per-doc
 * via PATCH /v1/documents/:id — the same source of truth the
 * ReviewQueue uses. Rate cons aren't toggleable; the server picks
 * the most recent rate-con automatically via loads.rate_con_pdf.
 *
 * Initial selection mirrors apps/api/src/lib/invoicePacket.ts:
 *   - per-doc d.includedInInvoice wins when non-null
 *   - for NULL docs, the heuristic is newest-per-kind among
 *     PACKET_KINDS_ORDER (matches the server's resolveDefault)
 *
 * Pending toggles live in `pendingChanges` so Save only writes the
 * docs the user actually changed — leaving NULL on untouched docs
 * so the heuristic remains the source of truth for them.
 */
const ACCOUNTING_PACKET_KINDS: readonly string[] = ['pod', 'bol', 'lumper', 'scale', 'receipt', 'driver_sheet'];
const ACCOUNTING_KIND_LABEL: Record<string, string> = {
  rate_con: 'Rate Con', pod: 'POD', bol: 'BOL', lumper: 'Lumper',
  scale: 'Scale', receipt: 'Receipt', driver_sheet: 'Driver Sheet',
  invoice: 'Invoice', other: 'Other',
};
const ACCOUNTING_KIND_TINT: Record<string, { bg: string; fg: string }> = {
  rate_con: { bg: '#f5f3ff', fg: '#7c3aed' },
  pod:      { bg: '#dcfce7', fg: '#166534' },
  bol:      { bg: '#fef3c7', fg: '#854d0e' },
  lumper:   { bg: '#fce7f3', fg: '#9f1239' },
  scale:    { bg: '#dbeafe', fg: '#1e40af' },
  receipt:  { bg: '#fee2e2', fg: '#991b1b' },
  driver_sheet: { bg: '#fed7aa', fg: '#9a3412' },
  other:    { bg: 'var(--gc-bg)', fg: 'var(--gc-text-3)' },
};
const RATE_CON_ACTIVE_ID = '__rate_con__';

function LoadDocsPreviewModal({ load, onClose, onSaved }: {
  load: LoadSummary;
  onClose: () => void;
  /** Fired after Save selection persists. Parent refreshes the
   *  table so the next open seeds from the new invoiceDocIds. When
   *  omitted, save just calls onClose (legacy behaviour). */
  onSaved?: () => void;
}) {
  type LoadDoc = import('@fleetcal/types').DocumentSummary;
  const [docs, setDocs]               = useState<LoadDoc[] | null>(null);
  const [error, setError]             = useState<string | null>(null);
  // Active = the doc the user is currently viewing. Special sentinel
  // RATE_CON_ACTIVE_ID means "show the rate con" since rate cons
  // aren't always backed by a load_documents row.
  const [activeId, setActiveId]       = useState<string | null>(null);
  const [activeUrl, setActiveUrl]     = useState<string | null>(null);
  const [urlLoading, setUrlLoading]   = useState(false);
  const [urlError, setUrlError]       = useState<string | null>(null);
  // Per-doc pending toggles — only the docs the user actually flipped.
  // Lets Save target exactly those rows via per-doc PATCH instead of
  // re-stamping the whole load (which would lose the NULL=heuristic
  // distinction for untouched docs).
  const [pendingChanges, setPendingChanges] = useState<Record<string, boolean>>({});
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);

  const hasRateCon = !!load.rateConPdf;

  useEffect(() => {
    let cancelled = false;
    void import('@/lib/db').then(({ fetchLoadDocuments }) =>
      fetchLoadDocuments(load.loadId, '').then(d => {
        if (!cancelled) setDocs(d);
      }).catch(err => {
        if (!cancelled) setError((err as Error)?.message ?? 'fetch failed');
      }),
    );
    return () => { cancelled = true; };
  }, [load.loadId]);

  // Derived effective include state.
  //   1. Pending toggle wins (the user just clicked it).
  //   2. Else d.includedInInvoice when not null (server-stored choice).
  //   3. Else newest-per-kind heuristic among PACKET_KINDS — same
  //      rule the server's resolveDefaultPacketDocs runs.
  const heuristicIncluded: Set<string> = useMemo(() => {
    if (!docs) return new Set();
    const byKind = new Map<string, LoadDoc>();
    const sorted = [...docs].sort((a, b) =>
      (b.uploadedAt ?? '').localeCompare(a.uploadedAt ?? ''),
    );
    for (const d of sorted) {
      if (ACCOUNTING_PACKET_KINDS.includes(d.kind) && !byKind.has(d.kind)) {
        byKind.set(d.kind, d);
      }
    }
    return new Set(Array.from(byKind.values()).map(d => d.id));
  }, [docs]);
  const effectiveInclude = (d: LoadDoc): boolean => {
    if (Object.prototype.hasOwnProperty.call(pendingChanges, d.id)) {
      return pendingChanges[d.id];
    }
    if (d.includedInInvoice === true)  return true;
    if (d.includedInInvoice === false) return false;
    return heuristicIncluded.has(d.id);
  };
  const included: Set<string> = useMemo(() => {
    const s = new Set<string>();
    for (const d of (docs ?? [])) if (effectiveInclude(d)) s.add(d.id);
    return s;
    // effectiveInclude reads pendingChanges + heuristicIncluded via
    // closure; both are listed inputs to the derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, pendingChanges, heuristicIncluded]);

  // Default the viewer to the rate con (or the first uploaded doc).
  useEffect(() => {
    if (activeId || !docs) return;
    if (hasRateCon) setActiveId(RATE_CON_ACTIVE_ID);
    else if (docs.length > 0) setActiveId(docs[0].id);
  }, [docs, hasRateCon, activeId]);

  // Resolve signed URL for whatever's active. Rate con goes through
  // a separate endpoint (loads.rate_con_pdf may live in legacy form);
  // regular docs use the per-doc signer.
  useEffect(() => {
    if (!activeId) { setActiveUrl(null); return; }
    let cancelled = false;
    setUrlLoading(true);
    setUrlError(null);
    setActiveUrl(null);
    const run = async () => {
      try {
        if (activeId === RATE_CON_ACTIVE_ID) {
          const { url } = await railway.getRateConUrl(load.loadId);
          if (!cancelled) setActiveUrl(url);
        } else {
          const { getLoadDocumentSignedUrl } = await import('@/lib/db');
          const url = await getLoadDocumentSignedUrl(activeId);
          if (!cancelled) setActiveUrl(url ?? null);
        }
      } catch (err) {
        if (!cancelled) setUrlError((err as Error)?.message ?? 'load failed');
      } finally {
        if (!cancelled) setUrlLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [activeId, load.loadId]);

  // Per-doc PATCH for every flipped row. Skip when nothing pending
  // so an accidental click-Save click doesn't write no-ops.
  async function handleSave() {
    const entries = Object.entries(pendingChanges);
    if (entries.length === 0 || saving) { onClose(); return; }
    setSaving(true);
    setSaveError(null);
    try {
      useCalendarStore.getState().markLoadSelfWrite(load.loadId);
      await Promise.all(entries.map(([id, val]) =>
        railway.updateDocumentInvoiceInclude(id, val)
      ));
      // Clear local overrides so the next render reads from server.
      setPendingChanges({});
      if (onSaved) onSaved(); else onClose();
    } catch (err) {
      setSaveError((err as Error)?.message ?? 'save failed');
      setSaving(false);
    }
  }

  // Toggle drops the pending entry when the new value matches the
  // doc's persisted (or heuristic) value — so a flip-back doesn't
  // leave a no-op in the dirty bucket and force a redundant save.
  const toggle = (id: string) => {
    if (!docs) return;
    const doc = docs.find(d => d.id === id);
    if (!doc) return;
    const persisted: boolean = doc.includedInInvoice === true  ? true
                              : doc.includedInInvoice === false ? false
                              : heuristicIncluded.has(id);
    const nextVal = !included.has(id);
    setPendingChanges(prev => {
      const copy = { ...prev };
      if (persisted === nextVal) delete copy[id];
      else                       copy[id] = nextVal;
      return copy;
    });
  };
  const dirtyCount = Object.keys(pendingChanges).length;

  const tintFor = (k: string) => ACCOUNTING_KIND_TINT[k] ?? ACCOUNTING_KIND_TINT.other;
  const nonRateConDocs = (docs ?? []).filter(d => d.kind !== 'rate_con');
  const includedSupportingCount = included
    ? nonRateConDocs.filter(d => included.has(d.id)).length
    : 0;
  const totalAttached = (hasRateCon ? 1 : 0) + includedSupportingCount;

  // Render the active doc — `<img>` for image MIME types, `<iframe>`
  // otherwise (PDFs render natively in every modern browser; for
  // anything else the iframe falls back to the browser's default
  // viewer or the download prompt).
  function renderViewer() {
    if (!activeId) {
      return (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
          Pick a doc on the left to preview.
        </div>
      );
    }
    if (urlLoading) {
      return (
        <div className="flex items-center justify-center h-full text-[13px] gap-2" style={{ color: 'var(--gc-text-3)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading preview…
        </div>
      );
    }
    if (urlError || !activeUrl) {
      return (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: '#991b1b' }}>
          {urlError ?? "Couldn't load preview."}
        </div>
      );
    }
    const activeDoc = nonRateConDocs.find(d => d.id === activeId);
    const isImage =
      activeId !== RATE_CON_ACTIVE_ID &&
      activeDoc?.mimeType?.startsWith('image/');
    if (isImage) {
      return (
        <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--gc-bg)' }}>
          <img src={activeUrl} alt={activeDoc?.fileName ?? 'doc'}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        </div>
      );
    }
    return (
      <iframe
        src={activeUrl}
        title={activeId === RATE_CON_ACTIVE_ID ? 'Rate confirmation' : activeDoc?.fileName ?? 'doc'}
        style={{ width: '100%', height: '100%', border: 'none', background: 'var(--gc-bg)' }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ width: 1100, maxWidth: '96vw', height: '88vh', background: 'var(--gc-surface)', boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Eye size={16} style={{ color: '#1a73e8' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Invoice packet
            {load.loadNum && <span className="ml-1" style={{ color: 'var(--gc-text-3)' }}>· #{load.loadNum}</span>}
          </div>
          <span className="text-[11px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ml-1"
            style={{ background: '#dbeafe', color: '#1e40af' }}>
            {totalAttached} attached
          </span>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)]">
            <X size={14} />
          </button>
        </div>

        {/* Two-pane body */}
        <div className="flex-1 flex min-h-0">
          {/* Left: doc list + checkboxes */}
          <div className="shrink-0 flex flex-col" style={{ width: 320, borderRight: '1px solid var(--gc-border-light)' }}>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {!docs && !error && (
                <div className="text-[12.5px] flex items-center gap-2" style={{ color: 'var(--gc-text-3)' }}>
                  <Loader2 size={13} className="animate-spin" /> Loading docs…
                </div>
              )}
              {error && (
                <div className="text-[12px] flex items-start gap-2 px-2 py-2 rounded-lg"
                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                  <AlertCircle size={12} style={{ marginTop: 1 }} /> {error}
                </div>
              )}
              {docs && !error && (
                <ul className="space-y-1">
                  {hasRateCon && (() => {
                    const tint = tintFor('rate_con');
                    const active = activeId === RATE_CON_ACTIVE_ID;
                    return (
                      <li>
                        <button type="button" onClick={() => setActiveId(RATE_CON_ACTIVE_ID)}
                          className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left transition-colors"
                          style={{
                            background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
                            border: active ? '1px solid var(--gc-blue)' : '1px solid transparent',
                          }}>
                          {/* Rate con isn't user-toggleable — always
                              auto-included via loads.rate_con_pdf.
                              Use a non-interactive checkmark so the
                              row visually balances with the doc rows
                              below. */}
                          <span className="flex items-center justify-center shrink-0"
                            style={{ width: 14, height: 14, borderRadius: 3, background: '#86efac', color: '#166534' }}
                            title="Rate con is always attached">
                            <Check size={10} />
                          </span>
                          <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                            style={{ background: tint.bg, color: tint.fg }}>
                            Rate Con
                          </span>
                          <span className="flex-1 truncate text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                            Rate confirmation
                          </span>
                        </button>
                      </li>
                    );
                  })()}
                  {nonRateConDocs.map(d => {
                    const tint = tintFor(d.kind);
                    const isIncluded = included.has(d.id);
                    const active = activeId === d.id;
                    return (
                      <li key={d.id}>
                        <div className="flex items-center gap-2 px-2 py-2 rounded-lg transition-colors"
                          style={{
                            background: active ? 'rgba(26,115,232,0.10)' : 'transparent',
                            border: active ? '1px solid var(--gc-blue)' : '1px solid transparent',
                          }}>
                          <input type="checkbox" checked={isIncluded}
                            onChange={() => toggle(d.id)}
                            disabled={!docs}
                            style={{ width: 14, height: 14, accentColor: 'var(--gc-blue)', cursor: 'pointer' }}
                            title={isIncluded ? 'Included in invoice packet' : 'Skipped'}
                            onClick={e => e.stopPropagation()} />
                          <button type="button" onClick={() => setActiveId(d.id)}
                            className="flex-1 flex items-center gap-2 min-w-0 text-left">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                              style={{ background: tint.bg, color: tint.fg }}>
                              {ACCOUNTING_KIND_LABEL[d.kind] ?? d.kind}
                            </span>
                            <span className="flex-1 truncate text-[12.5px]"
                              style={{ color: isIncluded ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}
                              title={d.fileName}>
                              {d.fileName}
                            </span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                  {!hasRateCon && nonRateConDocs.length === 0 && (
                    <li className="text-[12.5px] italic px-2 py-3" style={{ color: 'var(--gc-text-3)' }}>
                      No docs on this load yet.
                    </li>
                  )}
                </ul>
              )}
            </div>
            {/* Warnings — same gaps the original peek modal surfaced. */}
            {(!hasRateCon || (docs && includedSupportingCount === 0)) && (
              <div className="px-3 py-2 text-[11.5px] shrink-0"
                style={{ background: '#fff7ed', color: '#9a3412', borderTop: '1px solid #fed7aa' }}>
                {!hasRateCon
                  ? 'No rate confirmation on file.'
                  : 'No supporting docs selected — customers usually expect at least a POD.'}
              </div>
            )}
          </div>

          {/* Right: viewer */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {renderViewer()}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 flex items-center gap-2 shrink-0"
          style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          {saveError && (
            <div className="text-[11.5px] flex items-center gap-1.5" style={{ color: '#991b1b' }}>
              <AlertCircle size={11} /> {saveError}
            </div>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={saving}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
            style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
            Cancel
          </button>
          <button onClick={() => void handleSave()} disabled={saving || dirtyCount === 0}
            className="text-[12px] font-semibold px-4 py-1.5 rounded-lg disabled:opacity-60"
            style={{ background: '#1a73e8', color: '#fff' }}
            title={dirtyCount === 0 ? 'Nothing to save' : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}>
            {saving ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : null}
            {saving
              ? 'Saving…'
              : dirtyCount === 0
                ? 'Save selection'
                : `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
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

// ─── Batch send dialog ──────────────────────────────────────────────────

interface BatchSendDialogProps {
  /** Each invoice pre-paired with the broker the table currently shows
   *  for it. The parent resolves this via findCustomerForLoad — falling
   *  back to load.broker name match when the invoice's frozen
   *  customer_id is null. Lets a stale invoice still group + send to
   *  the broker that's currently set on the load, instead of the modal
   *  saying "(no broker set)" when the table clearly shows one. */
  rows:         Array<{ invoice: Invoice; broker: Customer | null }>;
  /** 'send' = draft → sent (default). 'resend' = re-send already-sent
   *  invoices (refreshes sent_at, status stays sent). Drives endpoint
   *  selection + button/title copy. */
  mode?:        'send' | 'resend';
  onOpenBroker?: (brokerId: string) => void;
  onClose:      () => void;
  onComplete:   () => void;
}

function BatchSendDialog({ rows, mode = 'send', onOpenBroker, onClose, onComplete }: BatchSendDialogProps) {
  const [bccSelf, setBccSelf]       = useState(true);
  const [attachLoadDocs, setAttach] = useState(true);
  const [busy, setBusy]             = useState(false);
  const [result, setResult]         = useState<BatchSendInvoicesResponse | null>(null);

  const invoices = useMemo(() => rows.map(r => r.invoice), [rows]);

  const groups = useMemo(() => {
    const byBroker = new Map<string, { broker: Customer | null; rows: Invoice[] }>();
    for (const { invoice, broker } of rows) {
      const key = broker?.id ?? '__missing__';
      const cur = byBroker.get(key);
      if (cur) cur.rows.push(invoice);
      else byBroker.set(key, { broker, rows: [invoice] });
    }
    return Array.from(byBroker.values());
  }, [rows]);

  const missingBroker = groups.some(g => !g.broker);
  // "Missing email" only counts brokers in email mode. Portal-mode
  // brokers correctly have no AP email — they're not skipped, they
  // get flipped to sent via sent_method='portal'.
  const missingEmail  = groups.some(g =>
    g.broker && (g.broker.invoiceMethod ?? 'email') === 'email' && !g.broker.invoiceEmail,
  );
  const hasPortal     = groups.some(g => g.broker?.invoiceMethod === 'portal');

  async function handleSend() {
    setBusy(true);
    try {
      // Same shape both ways — the response type is identical so we
      // can reuse the result-rendering block. Endpoint switches on
      // mode; resend hits batch-resend (status='sent' invoices),
      // default hits batch-send (status='draft' invoices).
      const res = mode === 'resend'
        ? await railway.batchResendInvoices({ invoiceIds: invoices.map(i => i.id), bccSelf, attachLoadDocs })
        : await railway.batchSendInvoices({ invoiceIds: invoices.map(i => i.id), bccSelf, attachLoadDocs });
      setResult(res);
    } catch (err) {
      console.error(`[batch${mode === 'resend' ? 'Resend' : 'Send'}] failed:`, err);
      window.alert(`Batch ${mode === 'resend' ? 're' : ''}send failed. Check console for details.`);
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
            {result
              ? (mode === 'resend' ? 'Batch resend results' : 'Batch send results')
              : `${mode === 'resend' ? 'Resend' : 'Send'} ${invoices.length} invoice${invoices.length === 1 ? '' : 's'} — ${groups.length} customer${groups.length === 1 ? '' : 's'}`}
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
              {hasPortal && !missingBroker && (
                <div className="px-3 py-2 rounded-lg flex items-start gap-2 text-[12px]"
                  style={{ background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe' }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  Portal brokers won't get an email — their invoices flip to <strong>Sent</strong> so you can upload the packet to the portal yourself. Turn on <em>Bcc me a copy</em> to get the packet emailed to yourself.
                </div>
              )}

              <div className="space-y-2">
                {groups.map((g, i) => (
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
                          <div className="font-semibold text-[13px] truncate" style={{ color: '#dc2626' }}>(no customer set)</div>
                        )}
                        <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                          {(() => {
                            // Portal brokers: show the portal label
                            // (or a generic note) in blue — they're
                            // not "missing AP email", they just don't
                            // get one.
                            if (g.broker?.invoiceMethod === 'portal') {
                              const portal = g.broker.invoicePortal?.trim();
                              return (
                                <span style={{ color: '#1e40af' }}>
                                  Portal{portal ? `: ${portal}` : ' — marked sent, upload manually'}
                                </span>
                              );
                            }
                            if (g.broker?.invoiceEmail) return g.broker.invoiceEmail;
                            return (
                              <span style={{ color: '#9a3412' }}>
                                (no AP email — {onOpenBroker && g.broker ? (
                                  <button onClick={() => onOpenBroker(g.broker!.id)} className="underline font-semibold">fix in profile</button>
                                ) : 'set one in profile'})
                              </span>
                            );
                          })()}
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
                {mode === 'resend' ? 'Resend' : 'Send'}
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
