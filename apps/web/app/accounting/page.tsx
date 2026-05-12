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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Receipt, Loader2, AlertTriangle, AlertCircle, Search, X, Send, Check, FilePlus,
  AlertOctagon, Inbox, CircleCheckBig, CheckCircle2, Layers, Star, Eye,
} from 'lucide-react';
import { useAuth, useUser } from '@clerk/nextjs';
import ManagementHeader from '@/components/nav/ManagementHeader';
import DataLoader from '@/components/DataLoader';
import EventModal from '@/components/calendar/EventModal';
import { railway, RailwayError } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import InternalNotesModal from '@/components/closeout/InternalNotesModal';
import {
  Th, Td, DocBadge, CopyableCell, CopyableLoadNum, PaginationFooter,
  MenuTh, HeaderMenu, ColumnsMenu, NotesButton,
  moneyFmt, fmtShortDate, daysSince,
  type QueueSortState, type QueueFilterState,
} from '@/components/queue/QueueTablePrimitives';
import type {
  Invoice, InvoiceStatus, Customer, Load,
  BatchGenerateInvoicesResponse, BatchSendInvoicesResponse,
} from '@fleetcal/types';
// CalendarEvent is an app-side alias of Load (legacy naming).
type CalendarEvent = Load;

// ─── Buckets ────────────────────────────────────────────────────────────

type Bucket = 'released' | 'queued' | 'invoiced' | 'paid' | 'all';

const BUCKETS: Array<{ key: Bucket; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; tint: string; subtitle: string }> = [
  { key: 'released', label: 'Released',  icon: AlertOctagon,    tint: '#1a73e8', subtitle: 'Ready to invoice' },
  { key: 'queued',   label: 'Queued',    icon: Inbox,           tint: '#9333ea', subtitle: 'Drafts, unsent'   },
  { key: 'invoiced', label: 'Invoiced',  icon: CircleCheckBig,  tint: '#1d4ed8', subtitle: 'Awaiting payment' },
  { key: 'paid',     label: 'Paid',      icon: CheckCircle2,    tint: '#16a34a', subtitle: 'Closed out'       },
  { key: 'all',      label: 'All',       icon: Layers,          tint: '#5f6368', subtitle: 'Everything'       },
];

// ─── Columns ────────────────────────────────────────────────────────────

type ColKey =
  | 'invoiceNum' | 'loadNum' | 'customer' | 'title'
  | 'rate' | 'accessorials' | 'total'
  | 'docs' | 'priority' | 'notes'
  | 'age' | 'released' | 'issued' | 'due' | 'method' | 'sendTo' | 'status' | 'view';

interface ColumnDef {
  key:        ColKey;
  label:      string;
  align:      'left' | 'right';
  /** Filterable columns surface a multi-select dropdown in the
   *  header menu. Non-filterable columns only get sort. */
  filterable: boolean;
  /** Toggleable columns appear in the Columns menu and can be
   *  hidden. Always-on columns (none right now) would set false. */
  toggleable: boolean;
}

// Column order = render order in the table. The columns menu shows
// the same order so the user's mental model matches what's on screen.
// Priority sits next to Notes — they're both row-level metadata you
// scan for, not part of the bill itself.
const COLUMNS: ColumnDef[] = [
  { key: 'age',          label: 'Age',           align: 'left',  filterable: false, toggleable: true },
  { key: 'released',     label: 'Released',      align: 'left',  filterable: false, toggleable: true },
  { key: 'issued',       label: 'Issued',        align: 'left',  filterable: false, toggleable: true },
  { key: 'due',          label: 'Due',           align: 'left',  filterable: false, toggleable: true },
  { key: 'invoiceNum',   label: 'Invoice #',     align: 'left',  filterable: false, toggleable: true },
  { key: 'loadNum',      label: 'Load #',        align: 'left',  filterable: false, toggleable: true },
  { key: 'title',        label: 'Title',         align: 'left',  filterable: false, toggleable: true },
  { key: 'customer',     label: 'Customer',      align: 'left',  filterable: true,  toggleable: true },
  { key: 'method',       label: 'Method',        align: 'left',  filterable: true,  toggleable: true },
  // Send-to surfaces the actual email + missing-email state so the
  // user can verify before clicking Send. Hidden on Invoiced / Paid
  // (the send already happened) and on All (mixed bag).
  { key: 'sendTo',       label: 'Send to',       align: 'left',  filterable: false, toggleable: true },
  { key: 'rate',         label: 'Rate',          align: 'right', filterable: false, toggleable: true },
  { key: 'accessorials', label: 'Accessorials',  align: 'right', filterable: false, toggleable: true },
  { key: 'total',        label: 'Total',         align: 'right', filterable: false, toggleable: true },
  { key: 'docs',         label: 'Docs',          align: 'left',  filterable: false, toggleable: true },
  { key: 'priority',     label: 'P',             align: 'left',  filterable: true,  toggleable: true },
  { key: 'notes',        label: 'Notes',         align: 'left',  filterable: false, toggleable: true },
  { key: 'status',       label: 'Status',        align: 'left',  filterable: true,  toggleable: true },
  // View opens a PDF-only popup of the packet. No sort / no filter.
  // Hidden on Released — no invoice exists yet there.
  { key: 'view',         label: '',              align: 'left',  filterable: false, toggleable: false },
];

const COL_BY_KEY: Record<ColKey, ColumnDef> = COLUMNS.reduce((m, c) => { m[c.key] = c; return m; }, {} as Record<ColKey, ColumnDef>);

// Per-bucket column visibility. Hides what doesn't make sense.
const COLS_HIDDEN_PER_BUCKET: Record<Bucket, Set<ColKey>> = {
  released: new Set(['invoiceNum', 'issued', 'due', 'view']),
  queued:   new Set(['status']),
  // Send-to is only useful before the invoice ships. Once it's
  // Invoiced or Paid, the email has been verified at send time —
  // hide by default to keep the row uncluttered.
  invoiced: new Set(['status', 'sendTo']),
  paid:     new Set(['status', 'sendTo']),
  all:      new Set(['sendTo']),
};

// Default column visibility (user can override and we persist).
const DEFAULT_VISIBLE: Record<ColKey, boolean> = Object.fromEntries(
  COLUMNS.map(c => [c.key, true]),
) as Record<ColKey, boolean>;

const COLS_STORAGE_KEY = 'accounting-cols-v1';
const PAGE_SIZE = 50;

// ─── Page ───────────────────────────────────────────────────────────────

export default function AccountingPage() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const customers = useCalendarStore(s => s.customers);
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  const customerById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of customers) m.set(c.id, c);
    return m;
  }, [customers]);

  const [bucket, setBucket] = useState<Bucket>('released');

  // Source data
  const [verifiedLoads,  setVerifiedLoads]  = useState<CalendarEvent[]>([]);
  const [invoicedLoads,  setInvoicedLoads]  = useState<CalendarEvent[]>([]);
  const [paidLoads,      setPaidLoads]      = useState<CalendarEvent[]>([]);
  const [docCounts,      setDocCounts]      = useState<Record<string, Record<string, number>>>({});
  const [allInvoices,    setAllInvoices]    = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // UI state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search,   setSearch]   = useState('');
  const [sort,     setSort]     = useState<QueueSortState>({ key: null, dir: 'asc' });
  const [filters,  setFilters]  = useState<QueueFilterState>({});
  const [page,     setPage]     = useState(0);

  // Column visibility (persisted)
  const [visibleCols, setVisibleCols] = useState<Record<ColKey, boolean>>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE;
    try {
      const stored = window.localStorage.getItem(COLS_STORAGE_KEY);
      if (!stored) return DEFAULT_VISIBLE;
      const parsed = JSON.parse(stored) as Partial<Record<ColKey, boolean>>;
      return { ...DEFAULT_VISIBLE, ...parsed };
    } catch { return DEFAULT_VISIBLE; }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(visibleCols));
  }, [visibleCols]);

  // Header popover state
  const [openHeaderCol, setOpenHeaderCol] = useState<ColKey | null>(null);
  const headerRefs = useRef<Partial<Record<ColKey, HTMLTableCellElement | null>>>({});
  const headerMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openHeaderCol) return;
    function handler(e: MouseEvent) {
      const anchor = headerRefs.current[openHeaderCol!];
      if (
        headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)
        && anchor && !anchor.contains(e.target as Node)
      ) {
        setOpenHeaderCol(null);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openHeaderCol]);

  // Sibling modals
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  // Single modal for inspecting an invoice — shows the PDF + actions
  // side-by-side. Opened from the View button on each row.
  const [invoiceModalId,  setInvoiceModalId]  = useState<string | null>(null);
  const [summaryAction,   setSummaryAction]   = useState<null | 'generate' | 'generateSend'>(null);
  const [batchSendOpen,   setBatchSendOpen]   = useState(false);
  const [notesTarget,     setNotesTarget]     = useState<Load | null>(null);
  const [markPaidBusy,    setMarkPaidBusy]    = useState(false);

  // Reset filters/sort/pagination/selection on bucket change so a
  // stale id can't get acted on against the wrong list.
  useEffect(() => {
    setSelected(new Set());
    setSort({ key: null, dir: 'asc' });
    setFilters({});
    setPage(0);
  }, [bucket]);

  // ── Data fetch ──────────────────────────────────────────────────────
  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [verifiedRes, invoicedRes, paidRes, invoicesRes] = await Promise.all([
        railway.listCloseoutQueue('verified', { limit: 500 }),
        railway.listCloseoutQueue('invoiced', { limit: 500 }),
        railway.listCloseoutQueue('paid',     { limit: 500 }),
        railway.listInvoices({}),
      ]);
      setVerifiedLoads(verifiedRes.loads as CalendarEvent[]);
      setInvoicedLoads(invoicedRes.loads as CalendarEvent[]);
      setPaidLoads(paidRes.loads as CalendarEvent[]);
      setDocCounts({ ...verifiedRes.docCounts, ...invoicedRes.docCounts, ...paidRes.docCounts });
      setAllInvoices(invoicesRes.invoices);

      // Merge into the calendar store so the EventModal can find the
      // load when the user clicks a title.
      mergeEvents([...verifiedRes.loads, ...invoicedRes.loads, ...paidRes.loads] as CalendarEvent[]);
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

  // ── Build rows per bucket ───────────────────────────────────────────
  //
  // A row marries a load with its active invoice (when one exists).
  // The closeout queue returns Load[] keyed by billing_status; we
  // overlay invoices by loadId to figure out which slice goes into
  // Queued vs Invoiced (both share billing_status='invoiced').

  interface Row {
    load:     Load;
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

  // Closeout queue returns both legs of a relay as separate events.
  // Dedupe by loadId so a relay shows up as ONE accounting row (we
  // keep the pickup leg; deliveryEnd lookup below pulls in the
  // delivery-leg end for the Age calculation).
  const dedupedVerifiedLoads  = useMemo(() => dedupedLoads(verifiedLoads),  [verifiedLoads]);
  const dedupedInvoicedLoads  = useMemo(() => dedupedLoads(invoicedLoads),  [invoicedLoads]);
  const dedupedPaidLoads      = useMemo(() => dedupedLoads(paidLoads),      [paidLoads]);

  // Map of loadId → delivery-leg end. For non-relay loads this is
  // just the load's own end; for relays the leg flagged
  // relayRole='delivery' wins.
  const deliveryEndByLoadId = useMemo(() => {
    const m = new Map<string, string>();
    const all = [...verifiedLoads, ...invoicedLoads, ...paidLoads];
    for (const l of all) {
      const key = l.loadId ?? l.id;
      if (!m.has(key)) m.set(key, l.end);
    }
    for (const l of all) {
      if (l.relayRole === 'delivery') {
        const key = l.loadId ?? l.id;
        m.set(key, l.end);
      }
    }
    return m;
  }, [verifiedLoads, invoicedLoads, paidLoads]);

  // Resolve customer for a load. Prefer the explicit customerId; if
  // not set (legacy loads), fall back to a fuzzy name+aliases match.
  // Same lookup CloseoutView uses.
  function findCustomerForLoad(l: Load): Customer | undefined {
    if (l.customerId) return customerById.get(l.customerId);
    if (!l.broker)    return undefined;
    return customers.find(c => c.name === l.broker || (c.aliases ?? []).includes(l.broker ?? ''));
  }

  const releasedRows: Row[] = useMemo(() => dedupedVerifiedLoads.map(l => ({
    load: l,
    customer: findCustomerForLoad(l),
  })), [dedupedVerifiedLoads, customerById, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const queuedRows: Row[] = useMemo(() => {
    return dedupedInvoicedLoads
      .map(l => {
        const inv = l.loadId ? invoiceByLoadId.get(l.loadId) : undefined;
        return { load: l, invoice: inv, customer: findCustomerForLoad(l) };
      })
      .filter(r => r.invoice && r.invoice.status === 'draft');
  }, [dedupedInvoicedLoads, invoiceByLoadId, customerById, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const invoicedRows: Row[] = useMemo(() => {
    return dedupedInvoicedLoads
      .map(l => {
        const inv = l.loadId ? invoiceByLoadId.get(l.loadId) : undefined;
        return { load: l, invoice: inv, customer: findCustomerForLoad(l) };
      })
      .filter(r => r.invoice && r.invoice.status === 'sent');
  }, [dedupedInvoicedLoads, invoiceByLoadId, customerById, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const paidRows: Row[] = useMemo(() => dedupedPaidLoads.map(l => ({
    load: l,
    invoice: l.loadId ? invoiceByLoadId.get(l.loadId) : undefined,
    customer: findCustomerForLoad(l),
  })), [dedupedPaidLoads, invoiceByLoadId, customerById, customers]); // eslint-disable-line react-hooks/exhaustive-deps

  const allRows: Row[] = useMemo(() => [...queuedRows, ...invoicedRows, ...paidRows], [queuedRows, invoicedRows, paidRows]);

  const rowsForBucket: Row[] = bucket === 'released' ? releasedRows
                              : bucket === 'queued'   ? queuedRows
                              : bucket === 'invoiced' ? invoicedRows
                              : bucket === 'paid'     ? paidRows
                                                      : allRows;

  // ── Bucket stats (count + $ — uses raw bucket counts, not filtered) ─
  const stats = useMemo(() => {
    const sumLoadsRows    = (rs: Row[]) => rs.reduce((s, r) => s + (r.load.loadPrice ?? 0), 0);
    const sumInvoiceRows  = (rs: Row[]) => rs.reduce((s, r) => s + (r.invoice?.total ?? r.load.loadPrice ?? 0), 0);
    return {
      released: { count: releasedRows.length, total: sumLoadsRows(releasedRows) },
      queued:   { count: queuedRows.length,   total: sumInvoiceRows(queuedRows) },
      invoiced: { count: invoicedRows.length, total: sumInvoiceRows(invoicedRows) },
      paid:     { count: paidRows.length,     total: sumInvoiceRows(paidRows) },
      all:      { count: allRows.length,      total: sumInvoiceRows(allRows) },
    };
  }, [releasedRows, queuedRows, invoicedRows, paidRows, allRows]);

  // ── Projection helpers (one place that knows how to read each col) ──
  function projectCol(r: Row, col: ColKey): { sortValue: string | number; filterValue?: string; display?: string } {
    switch (col) {
      case 'invoiceNum':   return { sortValue: r.invoice?.invoiceNumber ?? '' };
      case 'loadNum':      return { sortValue: r.load.loadNum ?? '' };
      case 'customer': {
        const name = r.customer?.name ?? r.load.broker ?? '';
        return { sortValue: name, filterValue: name || '— (no broker)' };
      }
      case 'title':        return { sortValue: r.load.title ?? '' };
      case 'rate':         return { sortValue: r.load.loadPrice ?? 0 };
      case 'accessorials': return { sortValue: (r.load.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0) };
      case 'total':        return { sortValue: r.invoice?.total ?? (r.load.loadPrice ?? 0) };
      case 'docs':         return { sortValue: 0 };
      case 'priority':     return { sortValue: r.load.priority ? 1 : 0, filterValue: r.load.priority ? 'Priority' : 'Normal' };
      case 'notes':        return { sortValue: (r.load.internalNotes ?? []).length };
      case 'age': {
        // Days since delivery. For relays we want the DELIVERY leg's
        // end (the actual hand-off date), not the pickup leg's end —
        // resolved via deliveryEndByLoadId.
        const key = r.load.loadId ?? r.load.id;
        const deliveryEnd = deliveryEndByLoadId.get(key) ?? r.load.end;
        return { sortValue: daysSince(deliveryEnd) };
      }
      case 'released':     return { sortValue: r.load.verifiedAt ?? '' };
      case 'issued':       return { sortValue: r.invoice?.issuedAt ?? '' };
      case 'due':          return { sortValue: r.invoice?.dueAt ?? '' };
      case 'method': {
        const m = r.customer?.invoiceMethod ?? 'email';
        return { sortValue: m, filterValue: m === 'portal' ? 'Portal' : 'Email' };
      }
      case 'sendTo':       return { sortValue: r.customer?.invoiceEmail ?? '' };
      case 'status':       return { sortValue: r.invoice?.status ?? '', filterValue: r.invoice?.status ?? '—' };
      case 'view':         return { sortValue: 0 };
    }
  }

  // ── Filter + search + sort ──────────────────────────────────────────
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rowsForBucket.filter(r => {
      if (q) {
        const matches =
             (r.invoice?.invoiceNumber ?? '').toLowerCase().includes(q)
          || (r.load.loadNum ?? '').toLowerCase().includes(q)
          || (r.customer?.name ?? r.load.broker ?? '').toLowerCase().includes(q)
          || (r.load.title ?? '').toLowerCase().includes(q)
          || String(r.load.internalLoadId ?? '').includes(q);
        if (!matches) return false;
      }
      for (const [col, vals] of Object.entries(filters)) {
        if (!vals || vals.length === 0) continue;
        const def = COL_BY_KEY[col as ColKey];
        if (!def?.filterable) continue;
        const proj = projectCol(r, col as ColKey);
        if (!proj.filterValue) return false;
        if (!vals.includes(proj.filterValue)) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsForBucket, search, filters]);

  const sortedRows = useMemo(() => {
    if (!sort.key) return filteredRows;
    const key = sort.key as ColKey;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const av = projectCol(a, key).sortValue;
      const bv = projectCol(b, key).sortValue;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, sort.key, sort.dir]);

  const total = sortedRows.length;
  const paged = useMemo(() => sortedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [sortedRows, page]);

  // ── Per-column filter options (computed from the unfiltered bucket) ─
  const filterOptions = useMemo(() => {
    const opts: Partial<Record<ColKey, string[]>> = {};
    for (const def of COLUMNS) {
      if (!def.filterable) continue;
      const set = new Set<string>();
      for (const r of rowsForBucket) {
        const v = projectCol(r, def.key).filterValue;
        if (v) set.add(v);
      }
      opts[def.key] = Array.from(set).sort();
    }
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsForBucket]);

  // ── Visible columns for this bucket (intersect persisted + per-bucket hidden) ──
  const visibleColsForBucket = useMemo(() => {
    const hidden = COLS_HIDDEN_PER_BUCKET[bucket];
    const out: Record<ColKey, boolean> = { ...visibleCols };
    for (const k of hidden) out[k] = false;
    return out;
  }, [bucket, visibleCols]);

  const orderedVisibleColumns = useMemo(() =>
    COLUMNS.filter(c => visibleColsForBucket[c.key]),
    [visibleColsForBucket],
  );

  // ── Selection (only on buckets where actions are available) ─────────
  const canSelect = bucket === 'released' || bucket === 'queued' || bucket === 'invoiced';
  const selectableIds = useMemo(() => {
    if (!canSelect) return [];
    return paged.map(r => bucket === 'released' ? (r.load.loadId ?? r.load.id) : r.invoice!.id);
  }, [canSelect, paged, bucket]);
  const allSelected  = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
  const someSelected = selected.size > 0;
  function toggleId(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(prev => allSelected ? new Set() : new Set([...prev, ...selectableIds]));
  }

  const selectedLoads = useMemo(() =>
    bucket === 'released'
      ? paged.filter(r => selected.has(r.load.loadId ?? r.load.id)).map(r => r.load)
      : [],
    [bucket, paged, selected]);
  const selectedInvoices = useMemo(() =>
    (bucket === 'queued' || bucket === 'invoiced')
      ? paged.filter(r => r.invoice && selected.has(r.invoice.id)).map(r => r.invoice!)
      : [],
    [bucket, paged, selected]);

  async function handleMarkPaid() {
    if (selectedInvoices.length === 0 || markPaidBusy) return;
    setMarkPaidBusy(true);
    try {
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

  function toggleFilterValue(col: ColKey, val: string) {
    setFilters(prev => {
      const cur = prev[col] ?? [];
      const next = cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val];
      return { ...prev, [col]: next };
    });
  }
  function clearColFilter(col: ColKey) {
    setFilters(prev => ({ ...prev, [col]: [] }));
  }
  function setColFilterAll(col: ColKey, options: string[]) {
    setFilters(prev => ({ ...prev, [col]: [...options] }));
  }

  const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <DataLoader />
      <ManagementHeader title="Accounting" icon={Receipt} />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1600px] mx-auto space-y-4">

          {/* Purpose hint */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            Billing pipeline. Loads land in <strong>Released</strong> once Closeout marks them verified.
            Generate invoices, track delivery, mark paid.
          </div>

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
                    {moneyFmt.format(s.total)}
                  </div>
                  <div className="mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                    {b.subtitle}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder="Search broker, invoice #, load #, title…"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0); }}
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
            {someSelected && (
              <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>{selected.size} selected</span>
            )}
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
              <button onClick={() => void handleMarkPaid()} disabled={markPaidBusy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
                style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}>
                {markPaidBusy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Check size={12} className="inline mr-1.5" />}
                Mark {selected.size} paid
              </button>
            )}
            <ColumnsMenu
              columns={COLUMNS.filter(c => c.toggleable && !COLS_HIDDEN_PER_BUCKET[bucket].has(c.key))}
              visible={visibleCols as Record<string, boolean>}
              onToggle={(k) => setVisibleCols(v => ({ ...v, [k as ColKey]: !v[k as ColKey] }))} />
            <button onClick={() => void refresh()}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
              Refresh
            </button>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : total === 0 ? (
            <BucketEmpty bucket={bucket} hasFilters={search.trim() !== '' || Object.values(filters).some(v => v && v.length > 0)} />
          ) : (
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
              <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    {canSelect && (
                      <Th>
                        <input type="checkbox" checked={allSelected} onChange={toggleAll}
                          style={{ accentColor: '#1a73e8' }} />
                      </Th>
                    )}
                    {orderedVisibleColumns.map(c => (
                      <MenuTh key={c.key}
                        col={c.key}
                        label={c.label}
                        align={c.align}
                        sort={sort}
                        selectedCount={(filters[c.key] ?? []).length}
                        setHeaderRef={el => { headerRefs.current[c.key] = el; }}
                        onClick={() => setOpenHeaderCol(p => p === c.key ? null : c.key)} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paged.map((r) => {
                    const load = r.load;
                    const inv  = r.invoice;
                    const id   = bucket === 'released' ? (load.loadId ?? load.id) : (inv?.id ?? load.id);
                    const customer = r.customer;
                    const cust = displayBrokerName(customer?.name ?? load.broker ?? '', customers);
                    const method = customer?.invoiceMethod ?? 'email';
                    const missingEmail = method === 'email' && !customer?.invoiceEmail && (bucket === 'released' || inv?.status === 'draft');
                    const counts = docCounts[load.loadId ?? load.id] ?? {};
                    const hasRC = !!load.rateConPdf;
                    const accSum = (load.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
                    const accCount = (load.accessorials ?? []).length;
                    const notesCount = (load.internalNotes ?? []).length;
                    // Age = days since delivery (delivery-leg end for relays).
                    const deliveryEnd = deliveryEndByLoadId.get(load.loadId ?? load.id) ?? load.end;
                    const age = daysSince(deliveryEnd);
                    return (
                      <tr key={id}
                        style={{
                          borderBottom: '1px solid var(--gc-border-light)',
                          background: load.priority ? '#fefce8' : undefined,
                          borderLeft: load.priority ? '3px solid #eab308' : '3px solid transparent',
                        }}
                        className="hover:bg-[var(--gc-hover)]">
                        {canSelect && (
                          <Td>
                            <input type="checkbox" checked={selected.has(id)} onChange={() => toggleId(id)}
                              style={{ accentColor: '#1a73e8' }} />
                          </Td>
                        )}
                        {orderedVisibleColumns.map(c => {
                          switch (c.key) {
                            case 'priority':
                              // Outline star at all times (column stays visually consistent),
                              // filled yellow when the load is flagged priority.
                              return <Td key={c.key}>
                                <Star size={14}
                                  fill={load.priority ? '#eab308' : 'none'}
                                  stroke={load.priority ? '#eab308' : 'var(--gc-text-3)'}
                                  style={{ color: load.priority ? '#eab308' : 'var(--gc-text-3)' }} />
                              </Td>;
                            case 'age':
                              return <Td key={c.key}>
                                <span style={{ background: ageBg(age), color: ageFg(age), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                                  {age === 0 ? 'today' : age === 1 ? '1 day' : `${age}d`}
                                </span>
                              </Td>;
                            case 'released':
                              return <Td key={c.key}>{load.verifiedAt ? fmtShortDate(load.verifiedAt) : '—'}</Td>;
                            case 'issued':
                              return <Td key={c.key}>{inv?.issuedAt ? fmtShortDate(inv.issuedAt) : '—'}</Td>;
                            case 'due':
                              return <Td key={c.key}>{inv?.dueAt ? fmtShortDate(inv.dueAt) : '—'}</Td>;
                            case 'invoiceNum':
                              // Click-to-copy, same pattern as Load #.
                              // To inspect the invoice (PDF + actions),
                              // use the View button on this row.
                              return <Td key={c.key}>
                                {inv
                                  ? <CopyableCell value={inv.invoiceNumber} displayValue={`#${inv.invoiceNumber}`} title="Copy invoice #" />
                                  : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </Td>;
                            case 'loadNum':
                              return <Td key={c.key}>
                                {load.loadNum
                                  ? <CopyableLoadNum value={load.loadNum} />
                                  : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </Td>;
                            case 'title':
                              return <Td key={c.key}>
                                <button type="button"
                                  onClick={e => { e.stopPropagation(); openEditModal(load.id); }}
                                  className="text-left font-semibold hover:underline truncate max-w-[220px]"
                                  style={{ color: 'var(--gc-blue)' }}
                                  title="Open load details">
                                  {load.title}
                                </button>
                              </Td>;
                            case 'customer':
                              return <Td key={c.key}>
                                <div className="flex items-center gap-1.5">
                                  {customer ? (
                                    <button onClick={e => { e.stopPropagation(); setBrokerProfileId(customer.id); }}
                                      className="text-left hover:underline truncate max-w-[180px]"
                                      style={{ color: 'var(--gc-blue)' }}>
                                      {cust}
                                    </button>
                                  ) : (
                                    <span className="truncate max-w-[180px]" style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
                                      {cust || '—'}
                                    </span>
                                  )}
                                  {missingEmail && (
                                    <button onClick={e => { e.stopPropagation(); customer && setBrokerProfileId(customer.id); }}
                                      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                                      style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
                                      title="No invoice email set">
                                      <AlertCircle size={9} /> No email
                                    </button>
                                  )}
                                </div>
                              </Td>;
                            case 'method':
                              return <Td key={c.key}>
                                <span className="text-[11px] font-semibold uppercase tracking-wider"
                                  style={{ color: method === 'portal' ? '#9a3412' : 'var(--gc-text-2)' }}>
                                  {method === 'portal' ? 'Portal' : 'Email'}
                                </span>
                              </Td>;
                            case 'sendTo': {
                              // Portal brokers: no email, surface that.
                              // Email brokers with no saved address get a
                              // clickable warning chip; otherwise show
                              // the email itself.
                              if (method === 'portal') {
                                return <Td key={c.key}>
                                  <span className="text-[11.5px] italic" style={{ color: 'var(--gc-text-3)' }}>
                                    Portal — manual
                                  </span>
                                </Td>;
                              }
                              if (!customer?.invoiceEmail) {
                                return <Td key={c.key} onClick={e => e.stopPropagation()}>
                                  <button onClick={() => customer && setBrokerProfileId(customer.id)}
                                    className="inline-flex items-center gap-1 text-[10.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                                    style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}
                                    title="No invoice email — click to fix">
                                    <AlertCircle size={10} /> No email
                                  </button>
                                </Td>;
                              }
                              return <Td key={c.key}>
                                <span className="text-[12px] tabular-nums truncate inline-block max-w-[220px]"
                                  style={{ color: 'var(--gc-text-1)' }}
                                  title={customer.invoiceEmail}>
                                  {customer.invoiceEmail}
                                </span>
                              </Td>;
                            }
                            case 'view':
                              // Opens the combined modal — PDF packet
                              // on one side, Actions sidebar on the
                              // other. Single canonical "look at this
                              // invoice" surface.
                              return <Td key={c.key} onClick={e => e.stopPropagation()}>
                                {inv ? (
                                  <button onClick={() => setInvoiceModalId(inv.id)}
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors"
                                    style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
                                    title="View invoice — PDF + actions">
                                    <Eye size={11} /> View
                                  </button>
                                ) : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </Td>;
                            case 'rate':
                              return <Td key={c.key} align="right" className="font-semibold tabular-nums">
                                {load.loadPrice != null ? moneyFmt.format(load.loadPrice) : '—'}
                              </Td>;
                            case 'accessorials':
                              return <Td key={c.key} align="right" className="tabular-nums">
                                {accCount === 0
                                  ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                                  : <span title={`${accCount} accessorial${accCount === 1 ? '' : 's'}`}>{moneyFmt.format(accSum)}</span>
                                }
                              </Td>;
                            case 'total':
                              return <Td key={c.key} align="right" className="font-bold tabular-nums">
                                {inv ? moneyFmt.format(inv.total)
                                     : load.loadPrice != null ? moneyFmt.format(load.loadPrice + accSum)
                                     : '—'}
                              </Td>;
                            case 'docs':
                              return <Td key={c.key}>
                                <div className="flex flex-wrap gap-1">
                                  {(hasRC || (counts.rate_con ?? 0) > 0) && <DocBadge label="RC"      count={Math.max(counts.rate_con ?? 0, hasRC ? 1 : 0)} />}
                                  {(counts.pod     ?? 0) > 0 && <DocBadge label="POD"     count={counts.pod}     />}
                                  {(counts.bol     ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol}     />}
                                  {(counts.lumper  ?? 0) > 0 && <DocBadge label="Lumper"  count={counts.lumper}  />}
                                  {(counts.scale   ?? 0) > 0 && <DocBadge label="Scale"   count={counts.scale}   />}
                                  {(counts.invoice ?? 0) > 0 && <DocBadge label="Invoice" count={counts.invoice} />}
                                  {(!hasRC && Object.keys(counts).length === 0) && <span className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>—</span>}
                                </div>
                              </Td>;
                            case 'notes':
                              return <Td key={c.key}>
                                <NotesButton count={notesCount} onOpen={() => setNotesTarget(load)} />
                              </Td>;
                            case 'status':
                              return <Td key={c.key}>
                                {inv ? <StatusPill status={inv.status} />
                                     : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                              </Td>;
                            default:
                              return <Td key={c.key}>—</Td>;
                          }
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {total > PAGE_SIZE && (
                <PaginationFooter page={page} pageSize={PAGE_SIZE} total={total}
                  onPrev={() => setPage(Math.max(0, page - 1))}
                  onNext={() => setPage(page + 1)} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Column header popover */}
      {openHeaderCol && (
        <HeaderMenu
          ref={headerMenuRef}
          col={openHeaderCol}
          anchorEl={headerRefs.current[openHeaderCol] ?? null}
          sort={sort}
          filterable={COL_BY_KEY[openHeaderCol].filterable}
          selected={filters[openHeaderCol] ?? []}
          options={filterOptions[openHeaderCol] ?? []}
          onSort={(dir) => {
            if (dir === null) setSort({ key: null, dir: 'asc' });
            else setSort({ key: openHeaderCol, dir });
          }}
          onToggleValue={(val) => toggleFilterValue(openHeaderCol, val)}
          onClearFilter={() => clearColFilter(openHeaderCol)}
          onSelectAll={() => setColFilterAll(openHeaderCol, filterOptions[openHeaderCol] ?? [])}
          onClose={() => setOpenHeaderCol(null)} />
      )}

      {/* Sibling modals */}
      <EventModal />
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
          onComplete={() => { setSummaryAction(null); setSelected(new Set()); void refresh(); }} />
      )}
      {batchSendOpen && (
        <BatchSendDialog
          invoices={selectedInvoices}
          customerById={customerById}
          onOpenBroker={(id) => setBrokerProfileId(id)}
          onClose={() => setBatchSendOpen(false)}
          onComplete={() => { setBatchSendOpen(false); setSelected(new Set()); void refresh(); }} />
      )}
      {notesTarget && (
        <InternalNotesModal load={notesTarget} actorName={actorName}
          onClose={() => setNotesTarget(null)}
          onSaved={async () => { setNotesTarget(null); await refresh(); }} />
      )}
    </div>
  );
}

// ─── Relay dedupe ───────────────────────────────────────────────────────
//
// Closeout queue returns both legs of a relay as separate events.
// Accounting treats a relay as ONE billable thing, so we collapse the
// pair into a single row (pickup leg wins).
function dedupedLoads(loads: Load[]): Load[] {
  const groups = new Map<string, Load[]>();
  for (const l of loads) {
    const key = l.loadId ?? l.id;
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }
  const out: Load[] = [];
  for (const arr of groups.values()) {
    const pickup = arr.find(l => l.relayRole === 'pickup');
    out.push(pickup ?? arr[0]);
  }
  return out;
}

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

// ─── Bucket empty state ─────────────────────────────────────────────────

function BucketEmpty({ bucket, hasFilters }: { bucket: Bucket; hasFilters: boolean }) {
  if (hasFilters) {
    return (
      <div className="rounded-2xl py-16 text-center" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', color: 'var(--gc-text-3)' }}>
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>No matches</div>
        <div className="text-sm">Filters hide every row on this page.</div>
      </div>
    );
  }
  const messages: Record<Bucket, { title: string; sub: string }> = {
    released: { title: 'Nothing released yet',   sub: 'Loads land here once Closeout marks them verified.' },
    queued:   { title: 'Nothing queued',         sub: 'Generated invoices waiting to be sent show up here.' },
    invoiced: { title: 'Nothing invoiced',       sub: 'Sent invoices show up here until they\'re marked paid.' },
    paid:     { title: 'Nothing paid yet',       sub: 'Paid invoices show up here for record-keeping.' },
    all:      { title: 'No invoices yet',        sub: 'Generate one from the Released bucket.' },
  };
  const m = messages[bucket];
  return (
    <div className="rounded-2xl py-16 text-center" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)', color: 'var(--gc-text-3)' }}>
      <Receipt size={28} className="mx-auto mb-3" style={{ color: 'var(--gc-text-3)' }} />
      <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>{m.title}</div>
      <div className="text-sm">{m.sub}</div>
    </div>
  );
}

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

  const totalAmount = loads.reduce((s, l) => s + (l.loadPrice ?? 0), 0);
  const willSend = action === 'generateSend';
  const missingEmail = willSend && loads.some(l => {
    const c = l.customerId ? customerById.get(l.customerId) : undefined;
    return c && (c.invoiceMethod ?? 'email') === 'email' && !c.invoiceEmail;
  });

  async function handleGo() {
    setBusy(true);
    try {
      const loadIds = loads.map(l => l.loadId ?? l.id);
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
                  Some brokers have no saved AP email — their invoices will be created but skipped at the send step.
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
                                  style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>No email</span>
                              )}
                            </div>
                          </Td>
                          <Td className="tabular-nums">{l.internalLoadId ?? '—'}</Td>
                          <Td align="right" className="tabular-nums font-semibold">
                            <span style={{ color: '#15803d' }}>{l.loadPrice != null ? moneyFmt.format(l.loadPrice) : '—'}</span>
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

// ─── Batch send dialog ──────────────────────────────────────────────────

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
        invoiceIds: invoices.map(i => i.id), bccSelf, attachLoadDocs,
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
