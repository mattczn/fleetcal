'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, X, Download, FileSpreadsheet, Loader2, Settings, Filter, Calendar, Users, Truck, User, Eye, ChevronUp, ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { CalendarEvent } from '@/lib/types';
import DatePicker from '@/components/calendar/DatePicker';
import CopyChip from '@/components/ui/CopyChip';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import DriversModal from '@/components/sidebar/DriversModal';
import AssetsModal from '@/components/sidebar/AssetsModal';

// ── Column catalog ────────────────────────────────────────────────────────────

interface ColumnDef {
  id:    string;
  label: string;
  /** Raw value — used for sorting, column-filter distinct values, and export. */
  get:   (load: CalendarEvent, ctx: ColumnCtx) => string | number;
  align?: 'right';
  /** Skip thousands-separator formatting (e.g. ID columns). */
  noFormat?: boolean;
}

interface ColumnCtx {
  customers: { id: string; name: string; shortName?: string; aliases: string[] }[];
  drivers:   { name: string }[];
  assets:    { id: number; name: string; unit?: string }[];
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled', assigned: 'Assigned', dispatched: 'Dispatched', en_route: 'En Route',
  picked_up: 'Picked Up', delivered: 'Delivered', cancelled: 'Cancelled', tonu: 'TONU', problem: 'Problem',
};

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function billableAccessorials(load: CalendarEvent): number {
  return (load.accessorials ?? []).reduce((sum, a) => sum + (a.billable ? (a.amount ?? 0) : 0), 0);
}

/** Total revenue billable to the broker for this load: rate-con price plus
 *  every accessorial marked as billable. NOT a sum of all accessorials —
 *  internal ones (driver per-diem, lumper reimbursements, etc.) are
 *  excluded by design. */
function billableTotal(load: CalendarEvent): number {
  return (load.loadPrice ?? 0) + billableAccessorials(load);
}

/** Build an ISO timestamp at the start of a calendar day in the user's
 *  local timezone, so date filters compare correctly against UTC-stored
 *  events (an event picked up at 8pm local on May 8 has a UTC start of
 *  May 9 — if we sent the raw "2026-05-09" string without tz, the API
 *  would treat it as UTC midnight and INCLUDE that event). */
function localStartOfDayIso(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T00:00:00`).toISOString();
}
function localEndOfDayIso(yyyymmdd: string): string {
  return new Date(`${yyyymmdd}T23:59:59.999`).toISOString();
}

/** YYYY-MM-DD in the user's local timezone. We use this for comparisons
 *  against the date strings the user picked in the date pickers — date
 *  math on raw ISO timestamps would shift across timezones. */
function localDateOf(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso.slice(0, 10);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function refStr(load: CalendarEvent): string {
  return (load.refNums ?? []).map(r => r.label ? `${r.label}: ${r.value}` : r.value).join(' | ');
}

function firstStop(load: CalendarEvent, type: 'pickup' | 'delivery'): string {
  const stops = load.stops ?? [];
  const stop = type === 'pickup'
    ? (stops.find(s => s.type === 'pickup') ?? stops[0])
    : ([...stops].reverse().find(s => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook') ?? stops[stops.length - 1]);
  if (!stop) return '';
  return stop.facilityName ?? stop.city ?? stop.address ?? '';
}

const COLUMNS: ColumnDef[] = [
  { id: 'pickupDate',   label: 'Pickup Date', get: (l) => fmtDate(l.start) },
  { id: 'loadNum',      label: 'Load #',      get: (l) => l.loadNum ?? '' },
  { id: 'internalId',   label: 'Internal ID', get: (l) => l.internalLoadId ?? '', noFormat: true },
  { id: 'customer',     label: 'Customer',    get: (l, ctx) => {
    const c = ctx.customers.find(c => c.id === l.customerId)
           ?? (l.broker ? ctx.customers.find(c => c.name === l.broker || c.aliases.includes(l.broker!)) : undefined);
    return (c?.shortName?.trim() || c?.name) ?? l.broker ?? '';
  } },
  { id: 'title',        label: 'Title',       get: (l) => l.title ?? '' },
  { id: 'driver',       label: 'Driver',      get: (l) => l.driverName ?? '' },
  { id: 'asset',        label: 'Asset',       get: (l, ctx) => {
    const a = ctx.assets.find(x => x.id === l.assetId);
    return a ? (a.unit ? `${a.name} #${a.unit}` : a.name) : '';
  }},
  { id: 'trailerType',  label: 'Trailer Type', get: (l) => l.trailerType ?? '' },
  { id: 'status',       label: 'Status',      get: (l) => STATUS_LABEL[l.status ?? 'scheduled'] ?? l.status ?? '' },
  { id: 'priority',     label: 'Priority',    get: (l) => l.priority ? 'Yes' : '' },
  { id: 'pickup',       label: 'Pickup',      get: (l) => firstStop(l, 'pickup') },
  { id: 'delivery',     label: 'Delivery',    get: (l) => firstStop(l, 'delivery') },
  { id: 'commodity',    label: 'Commodity',   get: (l) => l.commodity ?? '' },
  { id: 'weight',       label: 'Weight (lbs)', align: 'right', get: (l) => l.weight ?? '' },
  { id: 'loadPrice',    label: 'Load Price', align: 'right',   get: (l) => l.loadPrice ?? '' },
  { id: 'accessorials', label: 'Accessorials', align: 'right', get: (l) => billableAccessorials(l) || '' },
  { id: 'total',        label: 'Total',       align: 'right',  get: (l) => billableTotal(l) || '' },
  { id: 'driverPay',    label: 'Driver Pay', align: 'right',   get: (l) => l.driverPay ?? '' },
  { id: 'refNums',      label: 'References',  get: (l) => refStr(l) },
  { id: 'dispatcher',   label: 'Dispatcher',  get: (l) => l.dispatcher ?? '' },
  { id: 'notes',        label: 'Notes',       get: (l) => l.notes ?? '' },
];

const DEFAULT_VISIBLE = ['pickupDate', 'loadNum', 'customer', 'driver', 'asset', 'status', 'loadPrice', 'accessorials', 'total', 'driverPay'];

// ── Multi-select dropdown ─────────────────────────────────────────────────────

interface MultiSelectProps<T> {
  label:    string;
  options:  T[];
  optionId: (o: T) => string;
  optionLabel: (o: T) => string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  width?:   number;
}

function MultiSelect<T>({ label, options, optionId, optionLabel, selected, onChange, width = 220, icon }: MultiSelectProps<T> & { icon?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef   = useRef<HTMLDivElement>(null);

  // Position the popup relative to the trigger button (fixed, body-portaled).
  useLayoutEffect(() => {
    if (!open) { setCoords(null); return; }
    const compute = () => {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    compute();
    const onScroll = () => compute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Close on outside click (covers both the trigger and the portaled popup).
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filtered = search
    ? options.filter(o => optionLabel(o).toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const summary = selected.size === 0
    ? `All ${label.toLowerCase()}`
    : selected.size === 1
      ? optionLabel(options.find(o => optionId(o) === [...selected][0])!) ?? '1 selected'
      : `${selected.size} selected`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          fontSize: 14, padding: '9px 12px', borderRadius: 8,
          border: `1px solid ${open ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
          background: 'var(--gc-surface)',
          color: 'var(--gc-text-1)', cursor: 'pointer', textAlign: 'left',
          boxShadow: open ? '0 0 0 3px rgba(26,115,232,0.15)' : 'none',
          transition: 'border-color 120ms, box-shadow 120ms',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          {icon}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected.size === 0 ? 'var(--gc-text-3)' : 'var(--gc-text-1)' }}>
            {summary}
          </span>
        </span>
        <ChevronDown size={14} style={{ color: 'var(--gc-text-3)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>
      {open && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popupRef}
          style={{
            position: 'fixed', top: coords.top, left: coords.left, width: coords.width,
            zIndex: 9999,
            background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
            borderRadius: 8, boxShadow: 'var(--shadow-3)', maxHeight: 360,
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--gc-border-light)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: 'var(--gc-bg)', borderRadius: 6 }}>
              <Search size={13} style={{ color: 'var(--gc-text-3)' }} />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                style={{ flex: 1, fontSize: 13, border: 'none', background: 'transparent', outline: 'none', color: 'var(--gc-text-1)' }}
              />
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 14, fontSize: 13, color: 'var(--gc-text-3)', textAlign: 'center' }}>
                No matches
              </div>
            ) : filtered.map(o => {
              const id = optionId(o);
              const checked = selected.has(id);
              return (
                <label key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px',
                  fontSize: 13, cursor: 'pointer',
                  background: checked ? 'var(--gc-blue-light)' : 'transparent',
                  color: 'var(--gc-text-1)',
                }}
                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {optionLabel(o)}
                  </span>
                </label>
              );
            })}
          </div>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => { onChange(new Set()); }}
              style={{
                padding: '10px 14px', fontSize: 12, fontWeight: 600, color: 'var(--gc-text-3)',
                background: 'var(--gc-bg)', border: 'none', borderTop: '1px solid var(--gc-border-light)',
                cursor: 'pointer', textAlign: 'left',
              }}>
              Clear selection
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Main report component ─────────────────────────────────────────────────────

interface Props {
  /** YYYY-MM-DD — initial pickup-from. Re-syncs when prop changes. */
  defaultFrom?: string;
  /** YYYY-MM-DD — initial pickup-to. Re-syncs when prop changes. */
  defaultTo?: string;
}

export default function LoadsReport({ defaultFrom, defaultTo }: Props = {}) {
  const { customers, drivers, assets, openEditModal, dbReady } = useCalendarStore();
  const [brokerProfileId,  setBrokerProfileId]  = useState<string | null>(null);
  const [driverModalId,    setDriverModalId]    = useState<number | null>(null);
  const [assetModalId,     setAssetModalId]     = useState<number | null>(null);

  // Date range — defaults to props (dashboard period) or last 30 days
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(today.getDate() - 30);
  const fmtDateInput = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => defaultFrom ?? fmtDateInput(monthAgo));
  const [to,   setTo]   = useState(() => defaultTo   ?? fmtDateInput(today));

  // When the dashboard period changes, re-seed the date range. Manual edits
  // by the user are preserved until the parent prop changes again.
  useEffect(() => {
    if (defaultFrom) setFrom(defaultFrom);
    if (defaultTo)   setTo(defaultTo);
  }, [defaultFrom, defaultTo]);

  // Multi-select filters (all = empty set)
  const [selectedCustomers, setSelectedCustomers] = useState<Set<string>>(new Set());
  const [selectedDrivers,   setSelectedDrivers]   = useState<Set<string>>(new Set());
  const [selectedAssets,    setSelectedAssets]    = useState<Set<string>>(new Set());

  // Results
  const [loads,     setLoads]     = useState<CalendarEvent[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // Column visibility
  const [visible, setVisible] = useState<Set<string>>(() => new Set(DEFAULT_VISIBLE));
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  // Column display order (drag-and-drop reorderable). Default = COLUMNS order.
  const [columnOrder, setColumnOrder] = useState<string[]>(() => COLUMNS.map(c => c.id));
  const [draggedColId, setDraggedColId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Per-column filter (Excel-style): column id → set of EXCLUDED display values.
  // A row passes if for every keyed column its cell display value is not in
  // the excluded set. Empty/absent map = no filter for that column.
  const [columnFilters, setColumnFilters] = useState<Record<string, Set<string>>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);
  const [filterCoords,  setFilterCoords]  = useState<{ top: number; left: number } | null>(null);
  const [colFilterSearch, setColFilterSearch] = useState('');
  const filterPopupRef = useRef<HTMLDivElement>(null);

  // Sort: click a column header to toggle asc → desc → off.
  const [sortKey, setSortKey] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);

  // Pagination — display only. CSV/Excel exports always include the full
  // filtered set across pages.
  const [pageSize, setPageSize] = useState<50 | 100 | 200>(50);
  const [page,     setPage]     = useState(0);

  // Refs for the columns-picker dropdown (used to detect outside clicks).
  const columnsBtnRef    = useRef<HTMLButtonElement>(null);
  const columnsPanelRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem('loadsReport.columns');
      if (stored) setVisible(new Set(JSON.parse(stored)));
    } catch { /* ignore */ }
    try {
      const storedOrder = localStorage.getItem('loadsReport.columnOrder');
      if (storedOrder) {
        const known = new Set(COLUMNS.map(c => c.id));
        const arr = (JSON.parse(storedOrder) as string[]).filter(id => known.has(id));
        const missing = COLUMNS.filter(c => !arr.includes(c.id)).map(c => c.id);
        setColumnOrder([...arr, ...missing]);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('loadsReport.columns', JSON.stringify([...visible]));
  }, [visible]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('loadsReport.columnOrder', JSON.stringify(columnOrder));
  }, [columnOrder]);

  // Distinct driver names from the loaded events as the picker options.
  // (Drivers table ids don't always match driverName text, so name-based
  // multi-select is the most reliable and matches what users actually see.)
  const driverOptions = useMemo(() => {
    const names = new Set<string>();
    drivers.forEach(d => { if (d.name) names.add(d.name); });
    return [...names].sort().map(name => ({ name }));
  }, [drivers]);

  const ctx = useMemo<ColumnCtx>(() => ({ customers, drivers: driverOptions, assets }), [customers, driverOptions, assets]);

  const run = async () => {
    if (!from || !to || from > to) {
      setError('Pick a valid date range');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Send ISO timestamps in the user's local timezone. Without the
      // offset, the backend treats "2026-05-09T00:00" as UTC midnight,
      // which is 5pm May 8 in MT — so MT-evening pickups bled into the
      // next day's report. ISO-with-offset closes that gap.
      const { loads: fetched } = await railway.listLoads({
        from: localStartOfDayIso(from),
        to:   localEndOfDayIso(to),
      });
      setLoads(fetched);
    } catch (err) {
      console.error('LoadsReport.run:', err);
      setError(err instanceof Error ? err.message : 'Failed to load report');
      setLoads([]);
    } finally {
      setLoading(false);
    }
  };

  // Auto-run whenever the date range changes (mount + dashboard-period sync).
  // Edits to from/to via the DatePickers trigger this too — same as clicking Run.
  // Wait for `dbReady` so the Clerk token provider is wired before the first
  // call (otherwise the auto-run on mount fires unauthenticated and 401s).
  useEffect(() => {
    if (!dbReady) return;
    if (!from || !to || from > to) return;
    void run();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, dbReady]);

  // Apply client-side multi-select filters.
  // For customers: match on customerId FK first, then fall back to broker
  // text matching the selected customer's name (older loads have no FK).
  const selectedCustomerNames = useMemo(() => {
    const names = new Set<string>();
    for (const id of selectedCustomers) {
      const c = customers.find(x => x.id === id);
      if (c) names.add(c.name);
    }
    return names;
  }, [selectedCustomers, customers]);

  // Collapse relay legs into ONE row per load. The API returns one event
  // per leg, and a relay has two events sharing a loadId — without this
  // dedupe step every metric in the report doubled for relays (load
  // price summed twice, accessorials summed twice, etc.).
  //
  // The PICKUP leg represents the load: it carries the real pickup date,
  // the pickup-side stops, and the originating driver. The delivery leg
  // is discarded for reporting purposes; its data still lives on the
  // load itself (which the API echoes onto both legs identically).
  const dedupedLoads = useMemo(() => {
    if (!loads) return [];
    const byLoad = new Map<string, CalendarEvent>();
    for (const ev of loads) {
      // Group by loadId when available; fall back to event id for
      // legacy rows missing the join.
      const key = ev.loadId ?? ev.id;
      const existing = byLoad.get(key);
      if (!existing) {
        byLoad.set(key, ev);
        continue;
      }
      // Prefer pickup leg. relayRole 'pickup' wins; absence of
      // relayRole (single-leg load) also wins over a 'delivery' leg
      // for safety.
      const evIsPickup       = ev.relayRole === 'pickup' || !ev.relayRole;
      const existingIsPickup = existing.relayRole === 'pickup' || !existing.relayRole;
      if (evIsPickup && !existingIsPickup) {
        byLoad.set(key, ev);
      }
    }
    return [...byLoad.values()];
  }, [loads]);

  // Apply the user-selected pickup-date range in their LOCAL timezone.
  // The API filter is intentionally "overlap" (so the calendar view
  // sees in-progress loads), but the report wants strictly "picked up
  // between from and to". Filtering on the deduped pickup leg's start,
  // converted to a local YYYY-MM-DD string, prevents tz drift and
  // satisfies the "May 9 means May 9 my time" expectation.
  const pickupRangeLoads = useMemo(() => {
    if (!from || !to) return dedupedLoads;
    return dedupedLoads.filter(ev => {
      const localDate = localDateOf(ev.start);
      return localDate >= from && localDate <= to;
    });
  }, [dedupedLoads, from, to]);

  const topRows = useMemo(() => {
    return pickupRangeLoads.filter(load => {
      if (selectedCustomers.size > 0) {
        const fkMatch   = !!load.customerId && selectedCustomers.has(load.customerId);
        const nameMatch = !!load.broker     && selectedCustomerNames.has(load.broker);
        if (!fkMatch && !nameMatch) return false;
      }
      if (selectedDrivers.size > 0 && !selectedDrivers.has(load.driverName ?? '')) return false;
      if (selectedAssets.size  > 0 && !selectedAssets.has(String(load.assetId))) return false;
      return true;
    });
  }, [pickupRangeLoads, selectedCustomers, selectedCustomerNames, selectedDrivers, selectedAssets]);

  // Columns in user's chosen order (drag-and-drop in the picker).
  const orderedColumns = useMemo(
    () => columnOrder.map(id => COLUMNS.find(c => c.id === id)).filter((c): c is ColumnDef => !!c),
    [columnOrder],
  );
  const visibleColumns = orderedColumns.filter(c => visible.has(c.id));

  const moveColumn = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setColumnOrder(prev => {
      const fromIdx = prev.indexOf(fromId);
      const toIdx   = prev.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, fromId);
      return next;
    });
  };

  // Display value for a cell — same formatting the table renders, used for
  // both the visible table and the column-filter distinct-value list.
  const fmt$ = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const cellDisplay = (col: ColumnDef, load: CalendarEvent): string => {
    const v = col.get(load, ctx);
    if (v === '' || v == null) return '';
    if (typeof v === 'number') {
      if (col.noFormat) return String(v);
      const isMoney = col.id === 'loadPrice' || col.id === 'driverPay' || col.id === 'accessorials';
      return isMoney && v > 0 ? fmt$(v) : v.toLocaleString();
    }
    return String(v);
  };

  // Apply column filters (post top-level filters)
  const rows = useMemo(() => {
    const activeKeys = Object.keys(columnFilters).filter(k => columnFilters[k]?.size);
    if (activeKeys.length === 0) return topRows;
    return topRows.filter(load => {
      for (const colId of activeKeys) {
        const col = COLUMNS.find(c => c.id === colId);
        if (!col) continue;
        if (columnFilters[colId].has(cellDisplay(col, load))) return false;
      }
      return true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topRows, columnFilters, ctx]);

  // Display-only sort. Exports use unsorted `rows` so CSV/Excel stays raw.
  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const col = COLUMNS.find(c => c.id === sortKey.col);
    if (!col) return rows;
    const dir = sortKey.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.get(a, ctx);
      const bv = col.get(b, ctx);
      const aEmpty = av === '' || av == null;
      const bEmpty = bv === '' || bv == null;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;            // empties always at the bottom
      if (bEmpty) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, ctx]);

  const cycleSort = (colId: string) => {
    setSortKey(prev => {
      if (!prev || prev.col !== colId) return { col: colId, dir: 'asc' };
      if (prev.dir === 'asc') return { col: colId, dir: 'desc' };
      return null;
    });
  };

  // Reset to page 0 whenever the visible-row set or sort changes.
  useEffect(() => { setPage(0); }, [topRows, columnFilters, sortKey, pageSize]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = sortedRows.slice(safePage * pageSize, (safePage + 1) * pageSize);

  // Totals (numeric columns only) — based on the filtered rows.
  // Each row is now one load (post-dedupe), so summing loadPrice gives
  // a true revenue total instead of double-counting relays. The "total"
  // column sums loadPrice + billable accessorials and is the headline
  // billable number to compare against accounting.
  const totals = useMemo(() => {
    const sums: Record<string, number> = {};
    for (const col of visibleColumns) {
      if (
        col.id === 'loadPrice' ||
        col.id === 'driverPay' ||
        col.id === 'accessorials' ||
        col.id === 'total' ||
        col.id === 'weight'
      ) {
        sums[col.id] = rows.reduce((acc, r) => acc + (Number(col.get(r, ctx)) || 0), 0);
      }
    }
    return sums;
  }, [rows, visibleColumns, ctx]);

  // Distinct values for the currently-open column-filter popup, computed
  // from topRows so excluded values are still visible/uncheckable.
  const distinctForOpenCol = useMemo(() => {
    if (!openFilterCol) return [] as Array<{ value: string; count: number }>;
    const col = COLUMNS.find(c => c.id === openFilterCol);
    if (!col) return [];
    const counts = new Map<string, number>();
    for (const load of topRows) {
      const display = cellDisplay(col, load);
      counts.set(display, (counts.get(display) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFilterCol, topRows, ctx]);

  // Close column filter popup on outside click
  useEffect(() => {
    if (!openFilterCol) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (filterPopupRef.current?.contains(t)) return;
      // Allow clicking the same header to toggle close — handled there.
      const headerEl = (e.target as HTMLElement)?.closest?.('[data-col-header]');
      if (headerEl?.getAttribute('data-col-header') === openFilterCol) return;
      setOpenFilterCol(null);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [openFilterCol]);

  // Close columns-picker on outside click (clicking the trigger toggles).
  useEffect(() => {
    if (!showColumnPicker) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (columnsBtnRef.current?.contains(t)) return;
      if (columnsPanelRef.current?.contains(t)) return;
      setShowColumnPicker(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showColumnPicker]);

  const toggleColFilterValue = (colId: string, value: string) => {
    setColumnFilters(prev => {
      const next = { ...prev };
      const set = new Set(next[colId] ?? []);
      if (set.has(value)) set.delete(value); else set.add(value);
      if (set.size === 0) delete next[colId];
      else next[colId] = set;
      return next;
    });
  };

  const clearColumnFilter = (colId: string) => {
    setColumnFilters(prev => {
      if (!prev[colId]) return prev;
      const next = { ...prev };
      delete next[colId];
      return next;
    });
  };

  const openColFilter = (col: ColumnDef, headerEl: HTMLElement) => {
    if (openFilterCol === col.id) { setOpenFilterCol(null); return; }
    const r = headerEl.getBoundingClientRect();
    setFilterCoords({ top: r.bottom + 4, left: r.left });
    setColFilterSearch('');
    setOpenFilterCol(col.id);
  };

  // ── Export helpers ──────────────────────────────────────────────────────────

  const dateStamp = `${from}_to_${to}`;

  const exportData = (format: 'csv' | 'xls') => {
    const headers = visibleColumns.map(c => c.label);
    const data = rows.map(r => visibleColumns.map(c => c.get(r, ctx)));

    if (format === 'csv') {
      const esc = (v: string | number) => {
        const s = String(v);
        return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const content = [headers, ...data].map(row => row.map(esc).join(',')).join('\r\n');
      trigger(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' }), `loads-report-${dateStamp}.csv`);
    } else {
      import('xlsx').then(XLSX => {
        const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
        ws['!freeze'] = { xSplit: 0, ySplit: 1 };
        ws['!cols'] = headers.map((h, ci) => {
          const maxLen = Math.max(h.length, ...data.map(r => String(r[ci] ?? '').length));
          return { wch: Math.min(maxLen + 2, 42) };
        });
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Loads');
        XLSX.writeFile(wb, `loads-report-${dateStamp}.xlsx`);
      });
    }
  };

  const trigger = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const labelStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--gc-text-3)',
  };

  return (
    <div style={{ marginTop: 32, marginBottom: 16, background: 'var(--gc-surface)', borderRadius: 14, border: '1px solid var(--gc-border)' }}>
      <div style={{ padding: '20px 28px', borderBottom: '1px solid var(--gc-border-light)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: '#e8f0fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Filter size={16} style={{ color: '#1a73e8' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--gc-text-1)' }}>Custom Loads Report</div>
            <div style={{ fontSize: 13, color: 'var(--gc-text-3)', marginTop: 2 }}>
              Filter loads by customer, driver, asset, and date range — then export the columns you need.
            </div>
          </div>
        </div>
      </div>

      {/* Filter row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '20px 28px', alignItems: 'flex-end', background: 'var(--gc-bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Pickup From</label>
          <DatePicker value={from} onChange={setFrom} headerColor="#1a73e8" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Pickup To</label>
          <DatePicker value={to} onChange={setTo} headerColor="#1a73e8" min={from} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Customer</label>
          <MultiSelect
            label="customers"
            options={customers}
            optionId={c => c.id}
            optionLabel={c => c.name}
            selected={selectedCustomers}
            onChange={setSelectedCustomers}
            width={240}
            icon={<Users size={13} style={{ color: 'var(--gc-text-3)' }} />}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Driver</label>
          <MultiSelect
            label="drivers"
            options={driverOptions}
            optionId={d => d.name}
            optionLabel={d => d.name}
            selected={selectedDrivers}
            onChange={setSelectedDrivers}
            width={220}
            icon={<User size={13} style={{ color: 'var(--gc-text-3)' }} />}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Asset</label>
          <MultiSelect
            label="assets"
            options={assets.filter(a => !a.hidden)}
            optionId={a => String(a.id)}
            optionLabel={a => a.unit ? `${a.name} #${a.unit}` : a.name}
            selected={selectedAssets}
            onChange={setSelectedAssets}
            width={220}
            icon={<Truck size={13} style={{ color: 'var(--gc-text-3)' }} />}
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 14, fontWeight: 700, padding: '10px 20px', borderRadius: 8,
            border: 'none', background: '#1a73e8', color: '#fff', cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
            boxShadow: '0 1px 2px rgba(26,115,232,0.25)',
          }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Filter size={14} />}
          Run Report
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '10px 20px', fontSize: 12, color: '#b91c1c', background: '#fef2f2', borderTop: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {/* Results */}
      {loads !== null && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: '1px solid var(--gc-border-light)' }}>
            <div style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>
              <strong style={{ color: 'var(--gc-text-1)' }}>{rows.length}</strong>
              {' load'}{rows.length === 1 ? '' : 's'}
              {totals.loadPrice ? <> · Revenue <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.loadPrice)}</strong></> : null}
              {totals.accessorials ? <> · Accessorials <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.accessorials)}</strong></> : null}
              {totals.total ? <> · Total <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.total)}</strong></> : null}
              {totals.driverPay ? <> · Driver Pay <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.driverPay)}</strong></> : null}
            </div>
            <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
              <button
                ref={columnsBtnRef}
                type="button"
                onClick={() => setShowColumnPicker(p => !p)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Settings size={12} />
                Columns ({visible.size})
              </button>
              <button
                type="button"
                onClick={() => exportData('csv')}
                disabled={rows.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? 0.4 : 1 }}
                onMouseEnter={e => { if (rows.length) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Download size={12} />
                CSV
              </button>
              <button
                type="button"
                onClick={() => exportData('xls')}
                disabled={rows.length === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? 0.4 : 1 }}
                onMouseEnter={e => { if (rows.length) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <FileSpreadsheet size={12} />
                Excel
              </button>

              {showColumnPicker && (
                <div ref={columnsPanelRef} style={{
                  position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 30,
                  background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                  borderRadius: 8, boxShadow: 'var(--shadow-3)', width: 240, maxHeight: 360, overflowY: 'auto',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>Columns · drag to reorder</span>
                    <button
                      type="button"
                      onClick={() => setShowColumnPicker(false)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--gc-text-3)' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {orderedColumns.map(col => {
                    const isDragging = draggedColId === col.id;
                    const isTarget   = dropTargetId === col.id && draggedColId && draggedColId !== col.id;
                    return (
                      <div
                        key={col.id}
                        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (draggedColId && draggedColId !== col.id) setDropTargetId(col.id); }}
                        onDragLeave={() => { if (dropTargetId === col.id) setDropTargetId(null); }}
                        onDrop={e => { e.preventDefault(); if (draggedColId) moveColumn(draggedColId, col.id); setDraggedColId(null); setDropTargetId(null); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 12px', fontSize: 13, color: 'var(--gc-text-1)',
                          opacity: isDragging ? 0.4 : 1,
                          borderTop: isTarget ? '2px solid #1a73e8' : '2px solid transparent',
                          background: isTarget ? 'var(--gc-blue-light)' : 'transparent',
                        }}
                        onMouseEnter={e => { if (!isTarget && !isDragging) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                        onMouseLeave={e => { if (!isTarget) e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span
                          draggable
                          onDragStart={e => { setDraggedColId(col.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', col.id); }}
                          onDragEnd={() => { setDraggedColId(null); setDropTargetId(null); }}
                          title="Drag to reorder"
                          style={{ cursor: 'grab', display: 'flex', color: 'var(--gc-text-3)', userSelect: 'none' }}
                        >
                          <GripVertical size={12} />
                        </span>
                        <input
                          type="checkbox"
                          checked={visible.has(col.id)}
                          onChange={() => {
                            const next = new Set(visible);
                            if (next.has(col.id)) next.delete(col.id); else next.add(col.id);
                            setVisible(next);
                          }}
                          style={{ cursor: 'pointer' }}
                        />
                        <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => {
                          const next = new Set(visible);
                          if (next.has(col.id)) next.delete(col.id); else next.add(col.id);
                          setVisible(next);
                        }}>
                          {col.label}
                        </span>
                      </div>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--gc-border-light)' }}>
                    <button
                      type="button"
                      onClick={() => setVisible(new Set(COLUMNS.map(c => c.id)))}
                      style={{ flex: 1, fontSize: 11, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisible(new Set(DEFAULT_VISIBLE))}
                      style={{ flex: 1, fontSize: 11, padding: '5px 8px', borderRadius: 5, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                      Defaults
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Table */}
          {rows.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 13, color: 'var(--gc-text-3)' }}>
              No loads match these filters.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'linear-gradient(180deg, #eef4fc 0%, #e4ecf7 100%)' }}>
                    <th style={{
                      padding: '12px 14px', fontSize: 10, fontWeight: 800,
                      textTransform: 'uppercase', letterSpacing: '0.06em',
                      color: '#1558d6', textAlign: 'left',
                      borderBottom: '2px solid #c5d8fd',
                      whiteSpace: 'nowrap', width: 1,
                    }}>
                      View
                    </th>
                    {visibleColumns.map(col => {
                      const isFiltered = !!columnFilters[col.id]?.size;
                      const isOpen = openFilterCol === col.id;
                      const sortDir = sortKey?.col === col.id ? sortKey.dir : null;
                      const isActive = isFiltered || sortDir;
                      return (
                        <th
                          key={col.id}
                          data-col-header={col.id}
                          onClick={() => cycleSort(col.id)}
                          title={`Click to sort${isFiltered ? ' · filter active' : ''}`}
                          style={{
                            textAlign: col.align === 'right' ? 'right' : 'left',
                            padding: '12px 14px', fontWeight: 800, fontSize: 10,
                            textTransform: 'uppercase', letterSpacing: '0.06em',
                            color: isActive ? '#1558d6' : '#3c4858',
                            borderBottom: `2px solid ${isActive ? '#1a73e8' : '#c5d8fd'}`,
                            background: isOpen
                              ? 'rgba(26,115,232,0.14)'
                              : (isActive ? 'rgba(26,115,232,0.06)' : 'transparent'),
                            whiteSpace: 'nowrap', cursor: 'pointer',
                            userSelect: 'none',
                            transition: 'background 100ms, color 100ms',
                          }}
                          onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = 'rgba(26,115,232,0.10)'; }}
                          onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = isActive ? 'rgba(26,115,232,0.06)' : 'transparent'; }}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }}>
                            {col.label}
                            {sortDir && (
                              sortDir === 'asc'
                                ? <ChevronUp size={11} style={{ color: '#1a73e8' }} />
                                : <ChevronDown size={11} style={{ color: '#1a73e8' }} />
                            )}
                            <button
                              type="button"
                              data-filter-trigger
                              onClick={e => {
                                e.stopPropagation();
                                const th = (e.currentTarget as HTMLElement).closest('th');
                                if (th instanceof HTMLElement) openColFilter(col, th);
                              }}
                              title="Filter values"
                              style={{
                                display: 'inline-flex', alignItems: 'center',
                                padding: 2, borderRadius: 3,
                                border: 'none', background: 'transparent',
                                cursor: 'pointer', color: isFiltered ? '#1a73e8' : '#5f6c80',
                                opacity: isFiltered ? 1 : 0.5,
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(26,115,232,0.18)'; e.currentTarget.style.opacity = '1'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.opacity = isFiltered ? '1' : '0.5'; }}
                            >
                              <Filter size={10} />
                            </button>
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(load => {
                    // Match by FK first, then fall back to canonical name + alias match
                    const customer =
                      customers.find(c => c.id === load.customerId) ??
                      (load.broker ? customers.find(c => c.name === load.broker || c.aliases.includes(load.broker!)) : undefined);
                    return (
                      <tr key={load.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        <td style={{ padding: '10px 12px', textAlign: 'left', whiteSpace: 'nowrap' }}>
                          <button
                            type="button"
                            onClick={() => openEditModal(load.id)}
                            title="Open load"
                            style={{
                              fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5,
                              border: '1px solid var(--gc-border)', background: 'transparent',
                              color: 'var(--gc-text-2)', cursor: 'pointer',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-blue)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
                          >
                            View
                          </button>
                        </td>
                        {visibleColumns.map(col => {
                          const display = cellDisplay(col, load);
                          let inner: React.ReactNode = display || <span style={{ color: 'var(--gc-text-3)' }}>—</span>;

                          if (col.id === 'loadNum' && load.loadNum) {
                            inner = <CopyChip value={load.loadNum} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-1)' }} />;
                          } else if (col.id === 'internalId' && load.internalLoadId != null) {
                            inner = <CopyChip value={String(load.internalLoadId)} style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-1)' }} />;
                          } else if (col.id === 'customer' && customer) {
                            inner = (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); setBrokerProfileId(customer.id); }}
                                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}
                                onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                              >
                                {customer.shortName?.trim() || customer.name}
                              </button>
                            );
                          } else if (col.id === 'driver') {
                            // Match by driver_id FK first so renames don't break the link;
                            // fall back to name match for legacy rows missing the id.
                            const driverRec =
                              (load.driverId != null ? drivers.find(d => d.id === load.driverId) : undefined) ??
                              (load.driverName ? drivers.find(d => d.name === load.driverName) : undefined);
                            if (driverRec) {
                              // Always render the CURRENT driver name — if the dispatcher
                              // updates first/last on the record, the report reflects it.
                              const fullName = `${driverRec.firstName ?? ''} ${driverRec.lastName ?? ''}`.trim() || driverRec.name;
                              inner = (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); setDriverModalId(driverRec.id); }}
                                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}
                                  onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                  onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                >
                                  {fullName}
                                </button>
                              );
                            } else if (load.driverName) {
                              // No matching record — still show the stored name so the
                              // cell isn't blank.
                              inner = load.driverName;
                            }
                          } else if (col.id === 'asset') {
                            const a = assets.find(x => x.id === load.assetId);
                            if (a) {
                              inner = (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); setAssetModalId(a.id); }}
                                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}
                                  onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                                  onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}
                                >
                                  {a.unit ? `${a.name} #${a.unit}` : a.name}
                                </button>
                              );
                            }
                          }

                          return (
                            <td
                              key={col.id}
                              style={{
                                padding: '10px 12px',
                                textAlign: col.align === 'right' ? 'right' : 'left',
                                color: 'var(--gc-text-1)',
                                maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}
                              title={display}
                            >
                              {inner}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination footer — only when there are rows */}
          {rows.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 20px', borderTop: '1px solid var(--gc-border-light)',
              fontSize: 12, color: 'var(--gc-text-2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>Rows per page</span>
                <select
                  value={pageSize}
                  onChange={e => setPageSize(Number(e.target.value) as 50 | 100 | 200)}
                  style={{
                    fontSize: 12, padding: '4px 8px', borderRadius: 6,
                    border: '1px solid var(--gc-border)', background: 'var(--gc-surface)',
                    color: 'var(--gc-text-1)', cursor: 'pointer',
                  }}
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                </select>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>
                  {rows.length === 0
                    ? '0 rows'
                    : <>
                        <strong style={{ color: 'var(--gc-text-1)' }}>{safePage * pageSize + 1}</strong>
                        {'–'}
                        <strong style={{ color: 'var(--gc-text-1)' }}>{Math.min((safePage + 1) * pageSize, rows.length)}</strong>
                        {' of '}
                        <strong style={{ color: 'var(--gc-text-1)' }}>{rows.length}</strong>
                      </>}
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 28, height: 28, borderRadius: 6,
                      border: '1px solid var(--gc-border)', background: 'transparent',
                      color: 'var(--gc-text-2)',
                      cursor: safePage === 0 ? 'default' : 'pointer',
                      opacity: safePage === 0 ? 0.4 : 1,
                    }}
                    onMouseEnter={e => { if (safePage > 0) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    title="Previous page"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 8px', minWidth: 70, justifyContent: 'center' }}>
                    Page <strong style={{ color: 'var(--gc-text-1)', margin: '0 4px' }}>{safePage + 1}</strong> / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 28, height: 28, borderRadius: 6,
                      border: '1px solid var(--gc-border)', background: 'transparent',
                      color: 'var(--gc-text-2)',
                      cursor: safePage >= totalPages - 1 ? 'default' : 'pointer',
                      opacity: safePage >= totalPages - 1 ? 0.4 : 1,
                    }}
                    onMouseEnter={e => { if (safePage < totalPages - 1) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    title="Next page"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Customer profile modal — opened from a customer-cell click */}
      {brokerProfileId && (
        <BrokerProfileModal
          initialBrokerId={brokerProfileId}
          onClose={() => setBrokerProfileId(null)}
        />
      )}
      {driverModalId !== null && (
        <DriversModal
          initialDriverId={driverModalId}
          onClose={() => setDriverModalId(null)}
        />
      )}
      {assetModalId !== null && (
        <AssetsModal
          initialAssetId={assetModalId}
          onClose={() => setAssetModalId(null)}
        />
      )}

      {/* Column-filter popup (portal) */}
      {openFilterCol && filterCoords && typeof document !== 'undefined' && createPortal(
        (() => {
          const colDef = COLUMNS.find(c => c.id === openFilterCol);
          if (!colDef) return null;
          const excluded = columnFilters[openFilterCol] ?? new Set<string>();
          const search = colFilterSearch.toLowerCase();
          const items = search
            ? distinctForOpenCol.filter(d => d.value.toLowerCase().includes(search))
            : distinctForOpenCol;
          return (
            <div
              ref={filterPopupRef}
              style={{
                position: 'fixed', top: filterCoords.top, left: filterCoords.left,
                zIndex: 9999, width: 260, maxHeight: 380,
                background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
                borderRadius: 8, boxShadow: 'var(--shadow-3)',
                display: 'flex', flexDirection: 'column',
              }}
            >
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--gc-border-light)' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--gc-text-3)', marginBottom: 6 }}>
                  Filter · {colDef.label}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--gc-bg)', borderRadius: 6 }}>
                  <Search size={12} style={{ color: 'var(--gc-text-3)' }} />
                  <input
                    autoFocus
                    value={colFilterSearch}
                    onChange={e => setColFilterSearch(e.target.value)}
                    placeholder="Search values…"
                    style={{ flex: 1, fontSize: 12, border: 'none', background: 'transparent', outline: 'none', color: 'var(--gc-text-1)' }}
                  />
                </div>
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {items.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, color: 'var(--gc-text-3)', textAlign: 'center' }}>No values</div>
                ) : items.map(({ value, count }) => {
                  const checked = !excluded.has(value);
                  const display = value === '' ? <em style={{ color: 'var(--gc-text-3)' }}>(empty)</em> : value;
                  return (
                    <label key={value} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                      fontSize: 13, cursor: 'pointer', color: 'var(--gc-text-1)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleColFilterValue(openFilterCol, value)}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {display}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>{count}</span>
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--gc-border-light)' }}>
                <button
                  type="button"
                  onClick={() => clearColumnFilter(openFilterCol)}
                  disabled={excluded.size === 0}
                  style={{
                    flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 8px', borderRadius: 5,
                    border: '1px solid var(--gc-border)', background: 'transparent',
                    color: excluded.size === 0 ? 'var(--gc-text-3)' : 'var(--gc-text-2)',
                    cursor: excluded.size === 0 ? 'default' : 'pointer',
                  }}
                >
                  Show all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Hide all currently visible values (matching the search)
                    setColumnFilters(prev => {
                      const next = { ...prev };
                      const set = new Set(next[openFilterCol] ?? []);
                      for (const it of items) set.add(it.value);
                      next[openFilterCol] = set;
                      return next;
                    });
                  }}
                  style={{
                    flex: 1, fontSize: 11, fontWeight: 600, padding: '6px 8px', borderRadius: 5,
                    border: '1px solid var(--gc-border)', background: 'transparent',
                    color: 'var(--gc-text-2)', cursor: 'pointer',
                  }}
                >
                  Hide all{search ? ' shown' : ''}
                </button>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {/* Initial empty state — illustrative placeholder */}
      {loads === null && !error && (
        <div style={{ padding: '60px 28px 72px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 18 }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'linear-gradient(135deg, #e8f0fe 0%, #c2dafe 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <FileSpreadsheet size={32} style={{ color: '#1a73e8' }} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--gc-text-1)' }}>
              No report yet
            </div>
            <div style={{ fontSize: 14, color: 'var(--gc-text-2)', marginTop: 6, maxWidth: 460 }}>
              Set a date range and pick any customer, driver, or asset filters above. The matching loads show up here, ready to export.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 24, marginTop: 8, fontSize: 12, color: 'var(--gc-text-3)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Calendar size={13} /> Any date range
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Download size={13} /> CSV / Excel export
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
