'use client';

import { useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, Download, FileSpreadsheet, Loader2, Filter, Calendar, Users, Truck, User } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { LoadSummary } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import DatePicker from '@/components/calendar/DatePicker';
import CopyChip from '@/components/ui/CopyChip';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import DriversModal from '@/components/sidebar/DriversModal';
import AssetsModal from '@/components/sidebar/AssetsModal';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';

// ── Column catalog ────────────────────────────────────────────────────────────

interface ColumnDef {
  id:    string;
  label: string;
  /** Raw value — used for sorting and export. */
  get:   (load: LoadSummary, ctx: ColumnCtx) => string | number;
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

function billableAccessorials(load: LoadSummary): number {
  return (load.accessorials ?? []).reduce((sum, a) => sum + (a.billable ? (a.amount ?? 0) : 0), 0);
}

/** Total revenue billable to the broker for this load: linehaul plus
 *  every accessorial marked as billable. NOT a sum of all accessorials —
 *  internal ones (driver per-diem, lumper reimbursements, etc.) are
 *  excluded by design.
 *
 *  Prefers the server-computed total_billable (loads_compute_total_billable
 *  trigger) and falls back to the inline math for any legacy row that
 *  somehow lacks it. The trigger uses identical billable/amount filtering
 *  to billableAccessorials() above, so the two paths produce the same
 *  number. */
function billableTotal(load: LoadSummary): number {
  return load.totalBillable ?? (load.loadPrice ?? 0) + billableAccessorials(load);
}

/** Build a NAIVE org-local cutoff string ("YYYY-MM-DDTHH:mm:ss.SSS",
 *  no Z, no offset). The /v1/reports/loads endpoint string-compares
 *  pickupFrom/To against pickupAt, and pickupAt is stored as a naive
 *  org-local string itself ("2026-05-30T01:00:00"). The lexicographic
 *  comparison only matches the user's intuition when both sides live
 *  in the same TZ semantics — i.e. naive on both ends. */
function orgStartOfDayNaive(yyyymmdd: string): string {
  return `${yyyymmdd}T00:00:00.000`;
}
function orgEndOfDayNaive(yyyymmdd: string): string {
  return `${yyyymmdd}T23:59:59.999`;
}

function refStr(load: LoadSummary): string {
  return (load.refNums ?? []).map(r => r.label ? `${r.label}: ${r.value}` : r.value).join(' | ');
}

function firstStop(load: LoadSummary, type: 'pickup' | 'delivery'): string {
  const stops = load.stops ?? [];
  const stop = type === 'pickup'
    ? (stops.find(s => s.type === 'pickup') ?? stops[0])
    : ([...stops].reverse().find(s => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook') ?? stops[stops.length - 1]);
  if (!stop) return '';
  return stop.facilityName ?? stop.city ?? stop.address ?? '';
}

const COLUMNS: ColumnDef[] = [
  { id: 'pickupDate',   label: 'Pickup Date', get: (l) => fmtDate(l.pickupAt) },
  { id: 'deliveryDate', label: 'Delivery Date', get: (l) => fmtDate(l.deliveryAt) },
  { id: 'loadNum',      label: 'Load #',      get: (l) => l.loadNum ?? '' },
  { id: 'internalId',   label: 'Internal ID', get: (l) => l.internalLoadId ?? '', noFormat: true },
  { id: 'customer',     label: 'Customer',    get: (l, ctx) => {
    const c = ctx.customers.find(c => c.id === l.customerId)
           ?? (l.broker ? ctx.customers.find(c => c.name === l.broker || c.aliases.includes(l.broker!)) : undefined);
    return (c?.shortName?.trim() || c?.name) ?? l.broker ?? '';
  } },
  // Title is derived from pickup → delivery cities. A load doesn't have
  // a single "title" — historically the event title was a leg name like
  // "Pickup at XYZ", which doesn't make sense at the load level.
  { id: 'title',        label: 'Title',       get: (l) => {
    const pickup = l.stops.find(s => s.type === 'pickup') ?? l.stops[0];
    const delivery = [...l.stops].reverse().find(s => s.type === 'delivery' || s.type === 'drop' || s.type === 'drop_hook') ?? l.stops[l.stops.length - 1];
    const a = pickup?.city ?? pickup?.facilityName ?? '';
    const b = delivery?.city ?? delivery?.facilityName ?? '';
    return a && b ? `${a} → ${b}` : (a || b || '');
  } },
  { id: 'driver',       label: 'Driver',      get: (l) => {
    // Pickup leg's driver is the headline name. For relays, both legs'
    // drivers are exposed below as separate columns.
    if (!l.isRelay) return l.pickupDriverName ?? '';
    const a = l.pickupDriverName ?? '';
    const b = l.deliveryDriverName ?? '';
    return a && b && a !== b ? `${a} → ${b}` : a || b;
  } },
  { id: 'pickupDriver', label: 'Pickup Driver', get: (l) => l.pickupDriverName ?? '' },
  { id: 'deliveryDriver', label: 'Delivery Driver', get: (l) => l.deliveryDriverName ?? '' },
  { id: 'asset',        label: 'Truck',       get: (l, ctx) => {
    const a = ctx.assets.find(x => x.id === l.pickupAssetId);
    return a ? (a.unit ? `${a.name} #${a.unit}` : a.name) : '';
  }},
  { id: 'trailerType',  label: 'Equipment Type', get: (l) => l.trailerType ?? '' },
  { id: 'isRelay',      label: 'Relay',       get: (l) => l.isRelay ? 'Yes' : '' },
  { id: 'status',       label: 'Status',      get: (l) => STATUS_LABEL[l.pickupStatus ?? 'scheduled'] ?? l.pickupStatus ?? '' },
  { id: 'deliveryStatus', label: 'Delivery Status', get: (l) => STATUS_LABEL[l.deliveryStatus ?? 'scheduled'] ?? l.deliveryStatus ?? '' },
  { id: 'priority',     label: 'Priority',    get: (l) => l.pickupPriority ? 'Yes' : '' },
  { id: 'pickup',       label: 'Pickup',      get: (l) => firstStop(l, 'pickup') },
  { id: 'delivery',     label: 'Delivery',    get: (l) => firstStop(l, 'delivery') },
  { id: 'commodity',    label: 'Commodity',   get: (l) => l.commodity ?? '' },
  { id: 'weight',       label: 'Weight (lbs)', align: 'right', get: (l) => l.weight ?? '' },
  { id: 'miles',        label: 'Miles', align: 'right',        get: (l) => l.totalLoadedMiles ?? '' },
  { id: 'loadPrice',    label: 'Linehaul',   align: 'right',   get: (l) => l.loadPrice ?? '' },
  { id: 'accessorials', label: 'Accessorials', align: 'right', get: (l) => billableAccessorials(l) || '' },
  { id: 'total',        label: 'Total',       align: 'right',  get: (l) => billableTotal(l) || '' },
  { id: 'driverPay',    label: 'Driver Pay', align: 'right',   get: (l) => l.totalDriverPay ?? '' },
  { id: 'refNums',      label: 'References',  get: (l) => refStr(l) },
  { id: 'dispatcher',   label: 'Dispatcher',  get: (l) => l.dispatcher ?? '' },
  { id: 'billingStatus', label: 'Billing',    get: (l) => l.billingStatus ?? '' },
  { id: 'notes',        label: 'Notes',       get: (l) => l.notes ?? '' },
];

const DEFAULT_VISIBLE = ['pickupDate', 'loadNum', 'customer', 'driver', 'asset', 'status', 'loadPrice', 'accessorials', 'total', 'driverPay'];
const DEFAULT_VISIBLE_SET = new Set(DEFAULT_VISIBLE);

// Default per-column widths. Same Motive-style sensible-default pattern
// /accounting and /closeout use — OpsTable honors col.width and the user
// can hide/reorder via the column picker.
const COL_WIDTHS: Record<string, number> = {
  pickupDate:     110,
  deliveryDate:   110,
  loadNum:        130,
  internalId:     110,
  customer:       180,
  title:          240,
  driver:         160,
  pickupDriver:   150,
  deliveryDriver: 150,
  asset:          120,
  trailerType:    140,
  isRelay:        80,
  status:         120,
  deliveryStatus: 130,
  priority:       80,
  pickup:         200,
  delivery:       200,
  commodity:      140,
  weight:         110,
  miles:          90,
  loadPrice:      110,
  accessorials:   120,
  total:          120,
  driverPay:      110,
  refNums:        220,
  dispatcher:     140,
  billingStatus:  110,
  notes:          240,
};

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

function MultiSelect<T>({ label, options, optionId, optionLabel, selected, onChange, width = 220, icon }: MultiSelectProps<T> & { icon?: ReactNode }) {
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

// One-time migration from the report's pre-OpsTable localStorage keys to
// the OpsTable persistKey shape. Old keys stored VISIBLE column ids;
// OpsTable stores HIDDEN ones. Migrates once per browser, then leaves
// OpsTable in charge.
function migrateLegacyColumnPrefs(allColumnIds: string[]) {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage.getItem('loadsReport:migrated:v1')) return;

    const oldVisible = window.localStorage.getItem('loadsReport.columns');
    if (oldVisible && !window.localStorage.getItem('loadsReport:hidden')) {
      const visible = JSON.parse(oldVisible) as string[];
      const hidden  = allColumnIds.filter(id => !visible.includes(id));
      window.localStorage.setItem('loadsReport:hidden', JSON.stringify(hidden));
    }

    const oldOrder = window.localStorage.getItem('loadsReport.columnOrder');
    if (oldOrder && !window.localStorage.getItem('loadsReport:order')) {
      window.localStorage.setItem('loadsReport:order', oldOrder);
    }

    window.localStorage.setItem('loadsReport:migrated:v1', '1');
  } catch { /* ignore — non-critical */ }
}

export default function LoadsReport({ defaultFrom, defaultTo }: Props = {}) {
  const router = useRouter();
  const { customers, drivers, assets, openEditModal, dbReady } = useCalendarStore();
  const { can } = usePermissions();
  // Hide the Driver Pay column entirely for users without
  // loads.view_driver_pay. The role matrix excludes Dispatcher and
  // Maintenance from this cap, so they never see what we paid
  // drivers in this report.
  const canViewDriverPay = can('loads.view_driver_pay');
  const [brokerProfileId,  setBrokerProfileId]  = useState<string | null>(null);
  const [driverModalId,    setDriverModalId]    = useState<number | null>(null);
  const [assetModalId,     setAssetModalId]     = useState<number | null>(null);

  // Date range — defaults to props (dashboard period) or last 30 days
  const today = new Date();
  const monthAgo = new Date(today); monthAgo.setDate(today.getDate() - 30);
  const fmtDateInput = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => defaultFrom ?? fmtDateInput(monthAgo));
  const [to,   setTo]   = useState(() => defaultTo   ?? fmtDateInput(today));

  // Which date column drives the range filter. Pickup is the ops view;
  // delivery is what accounting cares about (e.g. invoices issued after
  // the load delivered). Persisted in localStorage so the user's
  // preferred mode sticks across visits.
  type DateMode = 'pickup' | 'delivery';
  const [dateMode, setDateMode] = useState<DateMode>('pickup');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('loads-report-date-mode');
      if (stored === 'pickup' || stored === 'delivery') setDateMode(stored);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('loads-report-date-mode', dateMode); }
    catch { /* ignore */ }
  }, [dateMode]);

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

  // Results — LoadSummary[], one row per load. The server collapses
  // relay legs into a single row with pickup-side fields elevated, so
  // there's no client-side dedupe needed anymore.
  const [loads,     setLoads]     = useState<LoadSummary[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // One-time pref migration from the pre-OpsTable storage shape.
  useEffect(() => {
    migrateLegacyColumnPrefs(COLUMNS.map(c => c.id));
  }, []);

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
      // Naive cutoffs ("YYYY-MM-DDTHH:mm:ss") since the server's
      // pickupAt/deliveryAt columns are naive org-local strings and
      // the filter is a lexicographic compare. See orgStartOfDayNaive
      // above for the why.
      const fromIso = orgStartOfDayNaive(from);
      const toIso   = orgEndOfDayNaive(to);
      const query: Record<string, string> = dateMode === 'delivery'
        ? { deliveryFrom: fromIso, deliveryTo: toIso }
        : { pickupFrom:   fromIso, pickupTo:   toIso };
      const { loads: fetched } = await railway.listLoadSummaries(query);
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
  }, [from, to, dbReady, dateMode]);

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

  // Top-level dropdown filters layered on top of the server's
  // pickup-date filter. Server already returns one row per load with
  // pickup-side fields elevated, so we just filter against
  // pickup-side / load-level fields here. Driver matches against
  // EITHER the pickup or delivery driver so a relay still surfaces
  // when either of its drivers is selected.
  const filteredRows = useMemo(() => {
    if (!loads) return [];
    return loads.filter(load => {
      if (selectedCustomers.size > 0) {
        const fkMatch   = !!load.customerId && selectedCustomers.has(load.customerId);
        const nameMatch = !!load.broker     && selectedCustomerNames.has(load.broker);
        if (!fkMatch && !nameMatch) return false;
      }
      if (selectedDrivers.size > 0) {
        const pickupHit   = !!load.pickupDriverName   && selectedDrivers.has(load.pickupDriverName);
        const deliveryHit = !!load.deliveryDriverName && selectedDrivers.has(load.deliveryDriverName);
        if (!pickupHit && !deliveryHit) return false;
      }
      if (selectedAssets.size > 0) {
        const pickupAsset   = String(load.pickupAssetId);
        const deliveryAsset = String(load.deliveryAssetId);
        if (!selectedAssets.has(pickupAsset) && !selectedAssets.has(deliveryAsset)) return false;
      }
      return true;
    });
  }, [loads, selectedCustomers, selectedCustomerNames, selectedDrivers, selectedAssets]);

  // Columns the user can pick / sort / etc. Driver Pay is stripped for
  // users without the perm so they can't toggle it back on either.
  const availableColumns = useMemo(
    () => canViewDriverPay ? COLUMNS : COLUMNS.filter(c => c.id !== 'driverPay'),
    [canViewDriverPay],
  );

  // Money formatter shared between cells and the stats line.
  const fmt$ = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Stable display string the cell would render (same formatting rules
  // we use in the OpsColumn render below). Used by export only.
  const cellDisplay = (col: ColumnDef, load: LoadSummary): string => {
    const v = col.get(load, ctx);
    if (v === '' || v == null) return '';
    if (typeof v === 'number') {
      if (col.noFormat) return String(v);
      const isMoney = col.id === 'loadPrice' || col.id === 'driverPay' || col.id === 'accessorials' || col.id === 'total';
      return isMoney && v > 0 ? fmt$(v) : v.toLocaleString();
    }
    return String(v);
  };

  // Totals (numeric columns only) — based on the filteredRows set so
  // the headline numbers reflect the dropdown filters above. OpsTable's
  // internal search filter narrows what's VISIBLE in the table but
  // doesn't move the topline aggregates around. Matches /accounting's
  // bucket-tile convention.
  const totals = useMemo(() => {
    const sums = { loadPrice: 0, driverPay: 0, accessorials: 0, total: 0, weight: 0 };
    for (const r of filteredRows) {
      sums.loadPrice    += r.loadPrice ?? 0;
      sums.driverPay    += r.totalDriverPay ?? 0;
      sums.accessorials += billableAccessorials(r);
      sums.total        += billableTotal(r);
      sums.weight       += r.weight ?? 0;
    }
    return sums;
  }, [filteredRows]);

  // ── OpsTable column adapter ────────────────────────────────────────
  const tableColumns = useMemo<OpsColumn<LoadSummary>[]>(() => {
    const cols: OpsColumn<LoadSummary>[] = [];

    for (const c of availableColumns) {
      cols.push({
        key: c.id,
        header: c.label,
        width: COL_WIDTHS[c.id] ?? 140,
        align: c.align === 'right' ? 'right' : 'left',
        sortable: true,
        sortValue: (load) => {
          const v = c.get(load, ctx);
          if (v == null || v === '') return '';
          return v;
        },
        defaultHidden: !DEFAULT_VISIBLE_SET.has(c.id),
        pickerLabel: c.label,
        render: (load) => {
          const display = cellDisplay(c, load);

          if (c.id === 'loadNum' && load.loadNum) {
            return <CopyChip value={load.loadNum} style={{ fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)' }} />;
          }
          if (c.id === 'internalId' && load.internalLoadId != null) {
            return <CopyChip value={String(load.internalLoadId)} style={{ fontSize: 13, fontWeight: 600, color: 'var(--gc-text-1)' }} />;
          }
          if (c.id === 'customer') {
            const customer =
              customers.find(x => x.id === load.customerId) ??
              (load.broker ? customers.find(x => x.name === load.broker || x.aliases.includes(load.broker!)) : undefined);
            if (customer) {
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setBrokerProfileId(customer.id); }}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {customer.shortName?.trim() || customer.name}
                </button>
              );
            }
          }
          if (c.id === 'driver') {
            // Resolve the pickup driver by ID first so renames flow through;
            // fall back to a name match for legacy rows missing the FK.
            const driverRec =
              (load.pickupDriverId != null ? drivers.find(d => d.id === load.pickupDriverId) : undefined) ??
              (load.pickupDriverName ? drivers.find(d => d.name === load.pickupDriverName) : undefined);
            if (driverRec) {
              const fullName = `${driverRec.firstName ?? ''} ${driverRec.lastName ?? ''}`.trim() || driverRec.name;
              const relaySuffix = load.isRelay && load.deliveryDriverName && load.deliveryDriverName !== fullName
                ? ` → ${load.deliveryDriverName}` : '';
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDriverModalId(driverRec.id); }}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                  title={load.isRelay ? `Relay — pickup: ${fullName}${load.deliveryDriverName ? `, delivery: ${load.deliveryDriverName}` : ''}` : undefined}
                >
                  {fullName}{relaySuffix}
                </button>
              );
            }
            return load.pickupDriverName || <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
          }
          if (c.id === 'asset') {
            const a = assets.find(x => x.id === load.pickupAssetId);
            if (a) {
              return (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setAssetModalId(a.id); }}
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {a.unit ? `${a.name} #${a.unit}` : a.name}
                </button>
              );
            }
          }

          return display || <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        },
      });
    }

    // Pinned-right action column — mirrors /accounting + /closeout's
    // "always-reachable utility column" convention.
    cols.push({
      key: '__view',
      header: '',
      width: 80,
      pinned: 'right',
      alwaysVisible: true,
      render: (load) => {
        const eventId = load.legs[0]?.eventId ?? load.loadId;
        return (
          <button
            type="button"
            onClick={() => openEditModal(eventId)}
            title="Open load"
            style={{
              fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 5,
              border: '1px solid var(--gc-border)', background: 'transparent',
              color: 'var(--gc-text-2)', cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-blue)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}
          >
            View
          </button>
        );
      },
    });

    return cols;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableColumns, ctx, customers, drivers, assets, openEditModal]);

  // In-table search — narrows what's visible without changing the
  // headline totals above. Searches across the high-value text fields:
  // load #, internal id, broker, driver names, asset name, ref nums,
  // cities. Stop facility/city values bubble up through firstStop().
  const tableFilters = useMemo<OpsFilter<LoadSummary>[]>(() => [{
    kind: 'search',
    placeholder: 'Search load #, broker, driver, city…',
    width: 320,
    match: (load, q) => {
      const haystack = [
        load.loadNum,
        load.internalLoadId != null ? String(load.internalLoadId) : '',
        load.broker,
        load.pickupDriverName,
        load.deliveryDriverName,
        load.commodity,
        firstStop(load, 'pickup'),
        firstStop(load, 'delivery'),
        refStr(load),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    },
  }], []);

  // ── Export helpers ──────────────────────────────────────────────────────────

  const dateStamp = `${from}_to_${to}`;

  // Export the full filteredRows set (NOT the search-narrowed table) so
  // the export matches the report filters the user set up top, regardless
  // of what they're scanning inside the table. Visibility is taken from
  // OpsTable's persisted state so the user gets the columns they actually
  // see in the table. Mirrors the dispatcher's mental model: "give me
  // what's on screen, expanded to every row that matched my filters."
  const getVisibleColumns = (): ColumnDef[] => {
    let hidden = new Set<string>();
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('loadsReport:hidden') : null;
      if (raw) hidden = new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    let order = availableColumns.map(c => c.id);
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('loadsReport:order') : null;
      if (raw) {
        const persisted = JSON.parse(raw) as string[];
        const known = new Set(availableColumns.map(c => c.id));
        const valid = persisted.filter(id => known.has(id));
        const missing = order.filter(id => !valid.includes(id));
        order = [...valid, ...missing];
      }
    } catch { /* ignore */ }
    const byId = new Map(availableColumns.map(c => [c.id, c]));
    return order
      .filter(id => !hidden.has(id))
      .map(id => byId.get(id))
      .filter((c): c is ColumnDef => !!c);
  };

  const exportData = (format: 'csv' | 'xls') => {
    const cols = getVisibleColumns();
    const headers = cols.map(c => c.label);
    const data = filteredRows.map(r => cols.map(c => c.get(r, ctx)));

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

  const hasExportable = filteredRows.length > 0;

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
        {/* Filter-by toggle — picks which date column drives the range.
            Pickup is the ops view; delivery is what accounting wants when
            asking "what hit the books this week?" */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>Filter By</label>
          <div role="radiogroup" style={{
            display: 'inline-flex',
            alignItems: 'stretch',
            border: '1px solid var(--gc-border)',
            borderRadius: 8,
            overflow: 'hidden',
            // Match DatePicker's computed height: padding '10px 13px' on
            // fontSize 15 (~38px content) + 1px border each side.
            height: 40,
            background: 'var(--gc-surface)',
          }}>
            {(['pickup', 'delivery'] as const).map(mode => {
              const active = dateMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setDateMode(mode)}
                  style={{
                    padding: '0 16px',
                    fontSize: 14, fontWeight: 600,
                    background: active ? '#1a73e8' : 'transparent',
                    color: active ? '#fff' : 'var(--gc-text-2)',
                    border: 'none',
                    cursor: 'pointer',
                    transition: 'background-color 80ms ease',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                >
                  {mode === 'pickup' ? 'Pickup' : 'Delivery'}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>{dateMode === 'pickup' ? 'Pickup From' : 'Delivery From'}</label>
          <DatePicker value={from} onChange={setFrom} headerColor="#1a73e8" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={labelStyle}>{dateMode === 'pickup' ? 'Pickup To' : 'Delivery To'}</label>
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
          <label style={labelStyle}>Truck</label>
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
        <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--gc-border-light)' }}>
          {/* Stats + export buttons */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--gc-text-2)' }}>
              <strong style={{ color: 'var(--gc-text-1)' }}>{filteredRows.length}</strong>
              {' load'}{filteredRows.length === 1 ? '' : 's'}
              {totals.loadPrice ? <> · Linehaul <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.loadPrice)}</strong></> : null}
              {totals.accessorials ? <> · Accessorials <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.accessorials)}</strong></> : null}
              {totals.total ? <> · Total <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.total)}</strong></> : null}
              {totals.driverPay ? <> · Driver Pay <strong style={{ color: 'var(--gc-text-1)' }}>{fmt$(totals.driverPay)}</strong></> : null}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => exportData('csv')}
                disabled={!hasExportable}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: !hasExportable ? 'default' : 'pointer', opacity: !hasExportable ? 0.4 : 1 }}
                onMouseEnter={e => { if (hasExportable) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Download size={12} />
                CSV
              </button>
              <button
                type="button"
                onClick={() => exportData('xls')}
                disabled={!hasExportable}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: !hasExportable ? 'default' : 'pointer', opacity: !hasExportable ? 0.4 : 1 }}
                onMouseEnter={e => { if (hasExportable) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <FileSpreadsheet size={12} />
                Excel
              </button>
            </div>
          </div>

          {/* OpsTable owns search chip, sorted headers, column picker
              (visibility + drag-to-reorder), and pagination. Persistence
              is keyed at "loadsReport" so the user's hide/show + order +
              sort survive across visits — identical convention to the
              accounting + closeout tables. */}
          <OpsTable<LoadSummary>
            columns={tableColumns}
            filters={tableFilters}
            data={filteredRows}
            loading={loading}
            rowKey={(load) => load.loadId}
            onRowDoubleClick={(load) => {
              if (load.internalLoadId != null) router.push(`/loads/${load.internalLoadId}`);
            }}
            emptyLabel="No loads match these filters."
            density="comfortable"
            pageSize={50}
            defaultSort={{ key: 'pickupDate', dir: 'desc' }}
            columnPicker
            columnReorder
            persistKey="loadsReport"
            countLabel="load"
          />
        </div>
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
