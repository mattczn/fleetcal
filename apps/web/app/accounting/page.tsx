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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Receipt, Loader2, AlertCircle, Search, X, Send, Check, FilePlus,
  AlertOctagon, Inbox, CircleCheckBig, CheckCircle2, Layers, Eye, Star, RefreshCw, Info,
} from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import { useRouter } from 'next/navigation';
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
  FastTooltip,
  moneyFmt, fmtShortDate, daysSince,
} from '@/components/queue/QueueTablePrimitives';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import type {
  Invoice, InvoiceStatus, Customer, LoadSummary,
  BatchGenerateInvoicesResponse, BatchSendInvoicesResponse,
} from '@fleetcal/types';

// ─── Buckets ────────────────────────────────────────────────────────────

type Bucket = 'released' | 'queued' | 'invoiced' | 'paid' | 'all';

const BUCKETS: Array<{ key: Bucket; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; tint: string; subtitle: string; formula: React.ReactNode }> = [
  { key: 'released', label: 'Released',  icon: AlertOctagon,    tint: '#1a73e8', subtitle: 'Paperwork verified · ready to invoice',
    formula: <>Loads with <code>billing_status = verified</code> and no invoice yet. $ = sum of <strong>Total Billable</strong> (linehaul + billable accessorials) per load.</> },
  { key: 'queued',   label: 'Queued',    icon: Inbox,           tint: '#9333ea', subtitle: 'Invoice generated · waiting to be sent',
    formula: <>Loads with <code>billing_status = invoiced</code> whose invoice is still in <code>draft</code>. $ = sum of the invoice <strong>Total</strong> (snapshot at draft time); falls back to load Total Billable if the snapshot is missing.</> },
  { key: 'invoiced', label: 'Invoiced',  icon: CircleCheckBig,  tint: '#1d4ed8', subtitle: 'Invoice sent · awaiting payment',
    formula: <>Loads with <code>billing_status = invoiced</code> whose invoice is in <code>sent</code>. $ = sum of the invoice <strong>Total</strong> snapshot.</> },
  { key: 'paid',     label: 'Paid',      icon: CheckCircle2,    tint: '#16a34a', subtitle: 'Payment received',
    formula: <>Loads with <code>billing_status = paid</code>. $ = sum of the invoice <strong>Total</strong> at the time payment was recorded.</> },
  { key: 'all',      label: 'All',       icon: Layers,          tint: '#5f6368', subtitle: 'All released loads',
    formula: <>Union of Queued + Invoiced + Paid (excludes Released — those don&rsquo;t have an invoice yet). $ = sum of invoice <strong>Total</strong> per row.</> },
];

// ─── Columns ────────────────────────────────────────────────────────────

type ColKey =
  | 'internalId' | 'loadNum' | 'customer' | 'driver' | 'truck' | 'title'
  | 'rate' | 'accessorials' | 'total'
  | 'stops' | 'miles' | 'rpm'
  | 'docs'
  | 'age' | 'pickupAt' | 'deliveryAt' | 'released' | 'issued' | 'due' | 'paidAt'
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
  paidAt:       100,
  internalId:   110,
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
  stops:         70,
  miles:         80,
  rpm:           80,
  docs:         240,
  status:       110,
  // flags carries 3 controls (star + notes + Invoice/Docs button).
  // The "Invoice" label is wider than the original "View"/"Docs" so
  // the cell needs ~170 to keep the rightmost chip from clipping at
  // the column boundary.
  flags:        170,
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
  // Per the operator's spec:
  //   Method + Send to  → Released and Queued only (pre-send buckets)
  //   Issued + Due      → Queued / Invoiced / Paid (have an invoice)
  //   Paid              → Paid bucket only
  // status is the invoice's draft/sent/paid/void pill — only useful in
  // the catch-all "all" view where mixed statuses appear.
  released: new Set(['issued', 'due', 'paidAt', 'status']),
  queued:   new Set(['paidAt', 'status']),
  invoiced: new Set(['method', 'sendTo', 'paidAt', 'status']),
  paid:     new Set(['method', 'sendTo', 'status']),
  all:      new Set(['method', 'sendTo', 'paidAt']),
};

const PAGE_SIZE = 50;

// ─── Tab-lifetime cache ─────────────────────────────────────────────────
//
// Survives mount/unmount within the same browser tab. Navigating away
// to Dispatch or Paperwork and back to Billing reads from here, so the
// table paints instantly with last-seen rows while a silent refresh
// pulls fresh data underneath. Keyed by orgId so an org switch can't
// serve stale cross-org data. Cleared on full page reload — that's the
// escape hatch for "give me guaranteed-fresh."
interface AccountingCache {
  orgId:     string | null;
  loads:     LoadSummary[] | null;
  invoices:  Invoice[] | null;
  /** Set of billing_status values currently held in `loads`. The
   *  prioritized-fetch path may only have fetched one slice; this
   *  lets bucket switches detect when they need to pull more. */
  loadedBilling: Set<string>;
  fetchedAt: number;
}
const accountingCache: AccountingCache = {
  orgId: null, loads: null, invoices: null,
  loadedBilling: new Set(), fetchedAt: 0,
};

/** Bucket → minimum API params needed to render that bucket.
 *  `inv === null` means no invoice query needed (Released has no
 *  invoices; All-bucket pulls every status so passes through). */
function fetchSliceForBucket(b: Bucket): { billing: string; inv: string | null } {
  if (b === 'released') return { billing: 'verified', inv: null };
  if (b === 'queued')   return { billing: 'invoiced', inv: 'draft' };
  if (b === 'invoiced') return { billing: 'invoiced', inv: 'sent'  };
  if (b === 'paid')     return { billing: 'paid',     inv: 'paid'  };
  return { billing: 'verified,invoiced,paid', inv: null };
}

/** Merge incoming rows on top of existing, dedup by id. Used after
 *  per-bucket fetches so multiple slices accumulate into one array. */
function mergeById<T>(prev: T[], incoming: T[], idOf: (x: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of prev) m.set(idOf(x), x);
  for (const x of incoming) m.set(idOf(x), x);
  return Array.from(m.values());
}

// ─── Page ───────────────────────────────────────────────────────────────

import RequireCap from '@/components/auth/RequireCap';
import { LoadDocsPreviewModal } from '@/components/closeout/LoadDocsPreviewModal';
import { InvoiceSummaryModal, BatchSendDialog } from '@/components/invoicing/BatchInvoiceModals';

export default function AccountingPage() {
  return (
    <RequireCap cap="accounting.access" module="accounting">
      <AccountingPageInner />
    </RequireCap>
  );
}

function AccountingPageInner() {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn, orgId } = useAuth();
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

  // Tracks which billing_status slices are present in `loads`. Synced
  // with accountingCache.loadedBilling on every successful fetch so
  // bucket-switch can detect missing data without hitting the server
  // when the cache already has it.
  const loadedBilling = useRef<Set<string>>(new Set());
  // True once a full-universe refresh has succeeded. Stops the
  // bucket-switch effect from re-fetching per-bucket slices we've
  // already pulled via the "load everything" path.
  const everythingLoaded = useRef(false);

  /** Per-bucket prioritized fetch. Cold-start path — pulls only what
   *  the active bucket needs (small payload, fast paint), then kicks
   *  off a background full refresh. Falls back to the cache fetchedAt
   *  if the API errors so we don't blank the operator's last-good. */
  async function primeBucket(b: Bucket) {
    if (!orgId) return;
    setError(null);
    const slice = fetchSliceForBucket(b);
    try {
      const [loadsRes, invoicesRes] = await Promise.all([
        railway.listLoadSummaries({
          billingStatus: slice.billing,
          limit:         String(BUCKET_LIMIT),
        }),
        slice.inv === null && b !== 'all'
          ? Promise.resolve({ invoices: [] as Invoice[] })
          : railway.listInvoices(slice.inv ? { status: slice.inv } : {}),
      ]);
      // Merge into existing arrays so multiple primeBucket calls
      // accumulate (user nav: released → queued → invoiced pulls one
      // slice each and they all stick around for instant switches).
      setLoads(prev => mergeById(prev, loadsRes.loads, (l) => l.loadId));
      setAllInvoices(prev => mergeById(prev, invoicesRes.invoices, (i) => i.id));
      slice.billing.split(',').forEach(s => loadedBilling.current.add(s));
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounting data');
      setLoading(false);
    }
  }

  /** Full-universe refresh. Used for: explicit Refresh button,
   *  post-mutation re-sync via loadEditTick, and background expansion
   *  after a prioritized first paint. Writes through to the tab-lifetime
   *  cache so the next mount is instant.
   *
   *  The loading skeleton ONLY ever shows on the very first paint
   *  (when there are zero rows in state). After that, every refresh
   *  swaps data underneath without flashing the table. */
  async function refresh(opts?: { silent?: boolean }) {
    void opts;
    if (!orgId) return;
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
      loadedBilling.current = new Set(['verified', 'invoiced', 'paid']);
      everythingLoaded.current = true;
      // Persist to the module cache so the next mount paints instantly.
      accountingCache.orgId = orgId;
      accountingCache.loads = loadsRes.loads;
      accountingCache.invoices = invoicesRes.invoices;
      accountingCache.loadedBilling = new Set(['verified', 'invoiced', 'paid']);
      accountingCache.fetchedAt = Date.now();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounting data');
    } finally {
      setLoading(false);
    }
  }

  // Mount: hydrate from cache → paint instantly → background refresh.
  // Cold start: prioritized fetch of the active bucket → background
  // refresh expands to the full universe. Either way, the table never
  // sits on the "Loading…" skeleton longer than one bucket's worth of
  // rows takes to come over the wire.
  useEffect(() => {
    if (!authLoaded || !isSignedIn || !orgId) return;

    // Cache hit for this org — paint from memory immediately, then
    // silently sync fresh data underneath.
    if (accountingCache.orgId === orgId &&
        accountingCache.loads && accountingCache.invoices) {
      setLoads(accountingCache.loads);
      setAllInvoices(accountingCache.invoices);
      loadedBilling.current = new Set(accountingCache.loadedBilling);
      everythingLoaded.current = accountingCache.loadedBilling.size >= 3;
      setLoading(false);
      void refresh({ silent: true });
      return;
    }

    // Cold start: prime the selected bucket so the user gets rows ASAP,
    // then expand to the full universe in the background. Buckets
    // switched to before that finishes hit the per-bucket fetch effect
    // below.
    void primeBucket(bucket).then(() => {
      if (!everythingLoaded.current) void refresh({ silent: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoaded, isSignedIn, orgId]);

  // Bucket switch: if we don't yet have this bucket's billing_status
  // slice in memory (cold-started on a different bucket and the user
  // jumped before the full background refresh finished), kick off a
  // targeted fetch for just this bucket's slice. No-op once the full
  // refresh has populated everything.
  useEffect(() => {
    if (!authLoaded || !isSignedIn || !orgId) return;
    if (everythingLoaded.current) return;
    const needed = fetchSliceForBucket(bucket).billing.split(',');
    const missing = needed.some(s => !loadedBilling.current.has(s));
    if (missing) void primeBucket(bucket);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket]);

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
    // Background re-sync — keep the table interactive while data lands.
    // Rows shift between buckets fluidly instead of blanking out.
    void refresh({ silent: true });
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
  const canSelect = bucket === 'released' || bucket === 'queued' || bucket === 'invoiced' || bucket === 'paid';
  const selectedLoads = useMemo(() => {
    if (bucket !== 'released') return [];
    const set = new Set(selectedIds);
    return rowsForBucket.filter(r => set.has(r.load.loadId)).map(r => r.load);
  }, [bucket, rowsForBucket, selectedIds]);
  const selectedInvoices = useMemo(() => {
    // Released bucket has no invoice yet, so no selectedInvoices.
    // All four other buckets carry an active invoice per row.
    if (bucket === 'released') return [];
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
      // Silent re-sync: rows slide from Invoiced into Paid without
      // the table blanking out under the operator.
      await refresh({ silent: true });
      setSelectedIds([]);
      setTableResetKey(k => k + 1);
    } finally {
      setMarkPaidBusy(false);
    }
  }

  // Bulk reverse mark-paid. Confirms once, then walks the selection
  // serially so a partial failure (e.g. server-side 409 on a void
  // invoice that slipped into the selection) stops cleanly with the
  // remaining rows still selected. Each successful reversal rolls
  // loads.billing_status from 'paid' to 'invoiced' server-side; the
  // silent refresh brings the row back into the Invoiced bucket.
  const [unmarkPaidBusy, setUnmarkPaidBusy] = useState(false);
  // Holds the invoices the user just clicked "Unmark paid" on while
  // the styled ConfirmDialog asks them to confirm. We can't use a
  // bool because the confirm body needs the count + a stable list
  // even if the selection mutates between click and confirm.
  const [unmarkPaidConfirm, setUnmarkPaidConfirm] = useState<Invoice[] | null>(null);

  /** Opens the styled ConfirmDialog. The actual API calls live in
   *  `runUnmarkPaidBulk` and only fire on confirm. */
  function handleUnmarkPaidBulk() {
    if (selectedInvoices.length === 0 || unmarkPaidBusy) return;
    const paidOnes = selectedInvoices.filter(inv => inv.status === 'paid');
    if (paidOnes.length === 0) return;
    setUnmarkPaidConfirm(paidOnes);
  }

  async function runUnmarkPaidBulk(paidOnes: Invoice[]) {
    setUnmarkPaidConfirm(null);
    if (paidOnes.length === 0 || unmarkPaidBusy) return;
    setUnmarkPaidBusy(true);
    const failed: string[] = [];
    try {
      for (const inv of paidOnes) {
        try { await railway.unmarkInvoicePaid(inv.id, {}); }
        catch (err) {
          console.warn('[accounting] unmarkPaid failed for', inv.invoiceNumber, err);
          failed.push(inv.invoiceNumber);
        }
      }
      await refresh({ silent: true });
      setSelectedIds([]);
      setTableResetKey(k => k + 1);
      if (failed.length > 0) {
        // Partial-failure case — surface via setError so it appears
        // in the in-page error band rather than another native popup.
        setError(`Unmarked ${paidOnes.length - failed.length} of ${paidOnes.length}. Failed: ${failed.join(', ')}`);
      }
    } finally {
      setUnmarkPaidBusy(false);
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
      // Silent re-sync — the row stays put in Queued (regen doesn't
      // change status) but the invoice number/issuedAt update in place.
      await refresh({ silent: true });
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
              <FastTooltip text="View invoice packet">
                <button onClick={() => setInvoiceModalId(r.invoice!.id)}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                  style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                  <Eye size={11} /> Invoice
                </button>
              </FastTooltip>
            ) : (
              <FastTooltip text="View docs selected to be included in the invoice">
                <button onClick={() => setDocsPreviewLoad(r.load)}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors whitespace-nowrap"
                  style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                  <Eye size={11} /> Docs
                </button>
              </FastTooltip>
            )}
          </div>
        );
      },
    });

    // Single ID column — internalLoadId and invoiceNumber are the same
    // value across our org (invoice # is derived from internal_load_id).
    // Showing both was redundant ("10761" + "#10761" side by side); the
    // operator just wants one identifier. We surface the invoice # form
    // ("#10761") once an invoice exists so the visual cues whether the
    // row has billed yet — Released loads (no invoice) render plain
    // "10761". Copy value stays unprefixed for both so the clipboard
    // payload is paste-clean into broker portals.
    all.push({
      key: 'internalId', header: 'ID / Inv #', width: DEFAULT_COL_WIDTHS.internalId,
      sortable: true,
      // Sort by the numeric load ID — invoiceNumber tracks it 1:1, so
      // either ordering is equivalent and the load ID stays sortable
      // even for Released-bucket rows that have no invoice yet.
      sortValue: r => r.load.internalLoadId ?? 0,
      render: r => {
        if (r.load.internalLoadId == null) {
          return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        }
        const id = String(r.load.internalLoadId);
        // Prefer the actual invoice number when an invoice exists —
        // gracefully handles the rare case where a custom invoice #
        // was set via createInvoice({ invoiceNumber }). Bare digits;
        // no `#` prefix — operator just wants the number.
        const invNum = r.invoice?.invoiceNumber;
        const display = invNum ?? id;
        const copy    = display;
        return <CopyableCell value={copy} displayValue={display}
          title={invNum ? 'Copy invoice #' : 'Copy load ID'} />;
      },
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

    // Stops / Miles / RPM — same shape as Paperwork. LoadSummary already
    // carries the deduped stop list and an aggregate totalLoadedMiles
    // across legs, so no client-side math beyond RPM division.
    all.push({
      key: 'stops', header: 'Stops', width: DEFAULT_COL_WIDTHS.stops,
      align: 'right', sortable: true,
      sortValue: r => (r.load.stops ?? []).length,
      render: r => {
        const n = (r.load.stops ?? []).length;
        return n === 0
          ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
          : <span className="tabular-nums">{n}</span>;
      },
    });

    all.push({
      key: 'miles', header: 'Miles', width: DEFAULT_COL_WIDTHS.miles,
      align: 'right', sortable: true,
      // totalLoadedMiles sums both legs for relays; falls back to the
      // pickup leg's miles when the aggregate isn't available.
      sortValue: r => r.load.totalLoadedMiles ?? r.load.pickupLoadedMiles ?? 0,
      render: r => {
        const m = r.load.totalLoadedMiles ?? r.load.pickupLoadedMiles ?? null;
        return m != null && m > 0
          ? <span className="tabular-nums">{Math.round(m).toLocaleString()}</span>
          : <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
      },
    });

    all.push({
      key: 'rpm', header: 'RPM', width: DEFAULT_COL_WIDTHS.rpm,
      align: 'right', sortable: true,
      // Linehaul ÷ loaded miles. Colour band mirrors Paperwork:
      // <$1.75 red, $1.75–$2.25 amber, ≥$2.25 green. Tonu / 0-mile /
      // missing-price rows fall to the bottom on sort.
      sortValue: r => {
        const m = r.load.totalLoadedMiles ?? r.load.pickupLoadedMiles ?? 0;
        return m > 0 && r.load.loadPrice != null ? r.load.loadPrice / m : 0;
      },
      render: r => {
        const m = r.load.totalLoadedMiles ?? r.load.pickupLoadedMiles ?? 0;
        if (m <= 0 || r.load.loadPrice == null) {
          return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        }
        const rpm = r.load.loadPrice / m;
        const fg = rpm >= 2.25 ? '#15803d'
                 : rpm >= 1.75 ? '#92400e'
                 :               '#991b1b';
        return (
          <span className="tabular-nums font-semibold" style={{ color: fg }}>
            ${rpm.toFixed(2)}
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
      headerTooltip: 'Days since delivery. Loads without a delivery date sort last.',
      // deliveryAt is already the actual delivery (for relays the
      // server resolves to the delivery leg's end). Loads with no
      // deliveryAt fall back to the verifiedAt (release) date so
      // we never silently sort them as "0d today" alongside fresh
      // deliveries — that bug made the column look randomized.
      // Priority-pinned rows still sit above the sort (OpsTable's
      // pinning is global), so the operator sees stars at the top
      // regardless of age ordering.
      sortValue: r => {
        const iso = r.load.deliveryAt || r.load.verifiedAt;
        // Unranked rows (no delivery, no release) push to the bottom
        // so they don't masquerade as today's fresh loads. -1 sorts
        // below any non-negative daysSince result for both directions.
        if (!iso) return -1;
        return daysSince(iso);
      },
      render: r => {
        const iso = r.load.deliveryAt || r.load.verifiedAt;
        if (!iso) {
          return <span style={{ color: 'var(--gc-text-3)' }} title="No delivery date">—</span>;
        }
        const a = daysSince(iso);
        const tooltip = r.load.deliveryAt
          ? `Delivered ${fmtShortDate(r.load.deliveryAt)} — ${a === 0 ? 'today' : a === 1 ? '1 day ago' : `${a} days ago`}`
          : `No delivery date — using release date ${fmtShortDate(iso)}`;
        return (
          <span title={tooltip}
            style={{ background: ageBg(a), color: ageFg(a), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
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

    // Paid date — when the dispatcher marked the invoice paid. Shown
    // by default in the Paid bucket (primary date there) and on the
    // All bucket (helpful when scanning paid-vs-not in one list).
    // Omitted entirely from Released/Queued/Invoiced — those rows
    // have no paidAt yet, so a column of em-dashes is just noise.
    all.push({
      key: 'paidAt', header: 'Paid', width: DEFAULT_COL_WIDTHS.paidAt,
      sortable: true,
      sortValue: r => r.invoice?.paidAt ?? '',
      render: r => r.invoice?.paidAt ? fmtShortDate(r.invoice.paidAt) : '—',
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
    const filtered = all.filter(c => !omit.has(c.key as ColKey));

    // Default column order — drives the table's seed layout. Operator
    // reorders are persisted by OpsTable via the per-bucket persistKey,
    // so this only affects the first time a user lands on a bucket
    // (and any newly-added column, which OpsTable's mergeOrder slots
    // adjacent to its declared neighbour).
    const BILLING_ORDER: string[] = [
      'flags',
      'age', 'loadNum', 'title', 'customer',
      'rate', 'accessorials', 'total', 'docs',
      'driver', 'truck',
      'internalId',
      'pickupAt', 'deliveryAt', 'released',
      'stops', 'miles', 'rpm',
      'method', 'sendTo',
      'issued', 'due', 'paidAt',
      'status',
    ];
    const rank = (k: string) => {
      const i = BILLING_ORDER.indexOf(k);
      return i === -1 ? BILLING_ORDER.length : i;
    };
    return [...filtered].sort((a, b) => rank(a.key) - rank(b.key));
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
                    <Tooltip content={b.formula} placement="bottom">
                      <Info size={11} style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help' }} />
                    </Tooltip>
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
                onRowDoubleClick={r => {
                  // Jump to the full load page. LoadSummary always has
                  // internalLoadId — guard belt-and-braces.
                  if (r.load.internalLoadId != null) router.push(`/loads/${r.load.internalLoadId}`);
                }}
                /* loading is gated on "table is empty" — once any row
                   has rendered, never paint the skeleton again. Prevents
                   the table-blank flash on View / Refresh / mutations. */
                loading={loading && loads.length === 0}
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
                    {bucket === 'paid' && (
                      <button onClick={() => void handleUnmarkPaidBulk()} disabled={unmarkPaidBusy}
                        className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                        style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}
                        title="Reverse payment — selected loads return to the Invoiced bucket">
                        {unmarkPaidBusy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <X size={12} className="inline mr-1.5" />}
                        Unmark {selectedIds.length} paid
                      </button>
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
        // No refresh() on close — Edit/void/regen inside the modal flow
        // through the realtime echo (loadEditTick) which patches affected
        // rows in place. Refetching the whole loads list was flashing the
        // entire table for what is almost always a no-op delta. The
        // toolbar's Refresh button is still available for explicit reload.
        <InvoiceDetailModal invoiceId={invoiceModalId}
          onClose={() => setInvoiceModalId(null)} />
      )}
      {docsPreviewLoad && (
        <LoadDocsPreviewModal
          load={docsPreviewLoad}
          onClose={() => setDocsPreviewLoad(null)}
          // Patch the row in place instead of a full refresh. The modal
          // hands back the new included-doc IDs after Save persists; we
          // drop them straight onto LoadSummary.invoiceDocIds so the
          // table reads the saved selection on the next open without a
          // server round-trip.
          onSaved={(nextIncludedIds) => {
            patchLoadInState(docsPreviewLoad.loadId, {
              invoiceDocIds: nextIncludedIds,
            });
            setDocsPreviewLoad(null);
          }}
        />
      )}
      {summaryAction && (
        <InvoiceSummaryModal
          loads={selectedLoads}
          customerById={customerById}
          action={summaryAction}
          onClose={() => setSummaryAction(null)}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onComplete={() => { setSummaryAction(null); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh({ silent: true }); }} />
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
          onComplete={() => { setBatchSendOpen(false); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh({ silent: true }); }} />
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
          onComplete={() => { setBatchResendOpen(false); setSelectedIds([]); setTableResetKey(k => k + 1); void refresh({ silent: true }); }} />
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

      {/* Styled confirm for bulk unmark-paid — replaces the browser
          native window.confirm so the prompt doesn't look like a 1998
          alert. Lives at the bottom of the modal stack on z=260 so it
          floats above the InvoiceDetailModal if the user somehow
          triggered both. */}
      {unmarkPaidConfirm && (
        <ConfirmDialog
          title={`Unmark ${unmarkPaidConfirm.length} invoice${unmarkPaidConfirm.length === 1 ? '' : 's'} as paid?`}
          message={`They'll return to the Invoiced bucket and loads.billing_status rolls back from 'paid' to 'invoiced'. Use this for payment reversals (bounced check, wrong invoice marked).`}
          confirmLabel={`Unmark ${unmarkPaidConfirm.length} paid`}
          cancelLabel="Cancel"
          destructive
          onConfirm={() => { const list = unmarkPaidConfirm; void runUnmarkPaidBulk(list); }}
          onCancel={() => setUnmarkPaidConfirm(null)} />
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
  const tooltip = on
    ? 'Priority — click to clear'
    : 'Mark this load as priority';
  return (
    <FastTooltip text={tooltip}>
      <button onClick={handleClick} disabled={busy}
        className="rounded-full p-1 transition-colors"
        style={{
          background: on ? '#fef3c7' : 'transparent',
          border:     `1px solid ${on ? '#eab308' : 'var(--gc-border)'}`,
          color:      on ? '#854d0e' : 'var(--gc-text-3)',
        }}>
        <Star size={11} fill={on ? '#eab308' : 'none'} />
      </button>
    </FastTooltip>
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

