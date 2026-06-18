'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileSpreadsheet, Loader2, Filter, Calendar, Star } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { LoadSummary } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useUser } from '@clerk/nextjs';
import DatePicker from '@/components/calendar/DatePicker';
import CopyChip from '@/components/ui/CopyChip';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import DriversModal from '@/components/sidebar/DriversModal';
import AssetsModal from '@/components/sidebar/AssetsModal';
import InternalNotesModal from '@/components/closeout/InternalNotesModal';
import { OpsTable, type OpsColumn, type OpsFilter } from '@/components/ui/OpsTable';
import {
  AccessorialsCell, DocBadge, RequiredDocBadge, NotesButton, FastTooltip,
} from '@/components/queue/QueueTablePrimitives';

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
  // Title — the load's event-shaped headline (e.g. "Pickup at XYZ →
  // Delivery at ABC"). Rendered as a clickable link in tableColumns
  // below that opens the load modal, matching the way load titles work
  // everywhere else in the app.
  { id: 'title',        label: 'Title',       get: (l) => l.title ?? '' },
  { id: 'driver',       label: 'Driver',      get: (l) => {
    // Pickup leg's driver is the headline name. For relays, both legs'
    // drivers are exposed below as separate columns.
    if (!l.isRelay) return l.pickupDriverName ?? '';
    const a = l.pickupDriverName ?? '';
    const b = l.deliveryDriverName ?? '';
    return a && b && a !== b ? `${a} → ${b}` : a || b;
  } },
  { id: 'asset',        label: 'Truck',       get: (l, ctx) => {
    const a = ctx.assets.find(x => x.id === l.pickupAssetId);
    return a ? (a.unit ? `${a.name} #${a.unit}` : a.name) : '';
  }},
  { id: 'trailerType',  label: 'Equipment Type', get: (l) => l.trailerType ?? '' },
  { id: 'status',       label: 'Status',      get: (l) => STATUS_LABEL[l.pickupStatus ?? 'scheduled'] ?? l.pickupStatus ?? '' },
  { id: 'pickup',       label: 'Pickup City', get: (l) => firstStop(l, 'pickup') },
  { id: 'delivery',     label: 'Delivery City', get: (l) => firstStop(l, 'delivery') },
  { id: 'stops',        label: 'Stops', align: 'right',        get: (l) => l.stops?.length ?? '' },
  // Docs column — same docBadge cluster the billing/paperwork tables render.
  // For sort + export we surface a flat summary string of "RC 1 · POD 2 …".
  // The visual badge cluster is built in tableColumns below.
  { id: 'docs',         label: 'Docs',        get: (l) => {
    const c = l.documentCounts ?? {};
    const rc = Math.max(c.rate_con ?? 0, l.rateConPdf ? 1 : 0);
    const parts: string[] = [];
    if (rc > 0) parts.push(`RC ${rc}`);
    if ((c.pod ?? 0) > 0) parts.push(`POD ${c.pod}`);
    if ((c.bol ?? 0) > 0) parts.push(`BOL ${c.bol}`);
    if ((c.lumper ?? 0) > 0) parts.push(`Lumper ${c.lumper}`);
    if ((c.scale ?? 0) > 0) parts.push(`Scale ${c.scale}`);
    if ((c.receipt ?? 0) > 0) parts.push(`Receipt ${c.receipt}`);
    if ((c.driver_sheet ?? 0) > 0) parts.push(`Driver ${c.driver_sheet}`);
    return parts.join(' · ');
  } },
  { id: 'commodity',    label: 'Commodity',   get: (l) => l.commodity ?? '' },
  { id: 'weight',       label: 'Weight (lbs)', align: 'right', get: (l) => l.weight ?? '' },
  { id: 'miles',        label: 'Miles', align: 'right',        get: (l) => l.totalLoadedMiles ?? '' },
  { id: 'loadPrice',    label: 'Linehaul',   align: 'right',   get: (l) => l.loadPrice ?? '' },
  { id: 'accessorials', label: 'Accessorials', align: 'right', get: (l) => billableAccessorials(l) || '' },
  { id: 'total',        label: 'Total',       align: 'right',  get: (l) => billableTotal(l) || '' },
  // Rate per mile from linehaul ÷ total loaded miles. Linehaul is the
  // right numerator here, not Total Billable — accessorials are
  // distance-independent (lumpers, detention) so folding them in would
  // distort the per-mile rate against comparable loads. Returns '' when
  // either side is missing or zero so empty cells stay empty.
  { id: 'rpm',          label: 'RPM', align: 'right',          get: (l) => {
    const m = l.totalLoadedMiles ?? 0;
    const p = l.loadPrice ?? 0;
    return (m > 0 && p > 0) ? p / m : '';
  } },
  { id: 'driverPay',    label: 'Driver Pay', align: 'right',   get: (l) => l.totalDriverPay ?? '' },
  { id: 'dispatcher',   label: 'Dispatcher',  get: (l) => l.dispatcher ?? '' },
  { id: 'billingStatus', label: 'Billing',    get: (l) => l.billingStatus ?? '' },
];

const DEFAULT_VISIBLE = [
  'pickupDate', 'deliveryDate', 'loadNum', 'customer', 'driver', 'asset',
  'status', 'docs', 'stops', 'miles', 'loadPrice', 'accessorials', 'total', 'rpm', 'driverPay',
];
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
  asset:          120,
  trailerType:    140,
  status:         120,
  pickup:         200,
  delivery:       200,
  stops:          80,
  docs:           260,
  commodity:      140,
  weight:         110,
  miles:          90,
  loadPrice:      110,
  accessorials:   140,
  total:          120,
  rpm:            90,
  driverPay:      110,
  dispatcher:     140,
  billingStatus:  110,
};

// ── Inline priority star toggle ───────────────────────────────────────────────
// Same UX as accounting/closeout: clicking flips loads.pickupPriority via the
// closeout PATCH endpoint, then patches the local row so the star repaints
// immediately. Inline because it's tightly coupled to our local row-patch
// helper; extracting to a shared module would require threading the patcher
// in as a prop, which doesn't pay back yet.

function PriorityToggle({
  load, actorName, onAfter,
}: {
  load:      { loadId: string; pickupPriority?: boolean };
  actorName?: string;
  onAfter:   (nextPriority: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const on = !!load.pickupPriority;
  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      useCalendarStore.getState().markLoadSelfWrite(load.loadId);
      await railway.updateLoadCloseout(load.loadId, {
        action: on ? 'clear_priority' : 'set_priority',
        actorName,
      });
      onAfter(!on);
    } catch (err) {
      console.error('[loads report] priority toggle failed:', err);
    } finally {
      setBusy(false);
    }
  }
  const tooltip = on ? 'Priority — click to clear' : 'Mark this load as priority';
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

// ── Legacy MultiSelect removed ───────────────────────────────────────────────
// Customer / Driver / Truck filters now live as OpsTable filter chips below
// the date row, matching billing/paperwork. The hand-rolled MultiSelect
// component used to live here (~210 lines) — deleted along with the parent
// state buckets (selectedCustomers/Drivers/Assets).


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
  const { user } = useUser();
  const { customers, drivers, assets, openEditModal, dbReady } = useCalendarStore();
  const { can } = usePermissions();
  // Hide the Driver Pay column entirely for users without
  // loads.view_driver_pay. The role matrix excludes Dispatcher and
  // Maintenance from this cap, so they never see what we paid
  // drivers in this report.
  const canViewDriverPay = can('loads.view_driver_pay');
  const actorName = user?.fullName ?? user?.username ?? undefined;
  const [brokerProfileId,  setBrokerProfileId]  = useState<string | null>(null);
  const [driverModalId,    setDriverModalId]    = useState<number | null>(null);
  const [assetModalId,     setAssetModalId]     = useState<number | null>(null);
  // Internal notes modal — opened from the row's notes pill in the
  // sticky utility column. Matches the accounting page's wiring.
  const [notesTarget,      setNotesTarget]      = useState<LoadSummary | null>(null);

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

  // Local row patcher — used by inline mutations (priority toggle,
  // internal-note save) so the table updates instantly without a
  // full server refetch. Mirrors the accounting page's pattern.
  const patchLoadInState = (loadId: string, patch: Partial<LoadSummary>) => {
    setLoads(prev => prev?.map(l => l.loadId === loadId ? { ...l, ...patch } : l) ?? prev);
  };

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

  // Distinct driver names from the active driver list — feeds the
  // OpsTable Driver filter chip's options.
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

  // Customer / Driver / Truck filters now live as OpsTable filter chips
  // INSIDE the table (matches accounting + closeout). filteredRows is just
  // the date-range-scoped server result; the chips refine display further
  // without affecting the headline totals strip.
  const filteredRows = useMemo(() => loads ?? [], [loads]);

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
      const isMoney = col.id === 'loadPrice' || col.id === 'driverPay' || col.id === 'accessorials' || col.id === 'total' || col.id === 'rpm';
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

    // Left-pinned utility column FIRST in the array so it visually
    // anchors the row's leading edge (sticky position is CSS;
    // visual order follows the array). Star toggles priority via
    // the closeout PATCH; notes opens InternalNotesModal.
    cols.push({
      key: '__utility',
      header: '',
      width: 86,
      pinned: 'left',
      alwaysVisible: true,
      pickerLabel: 'Star / notes',
      render: (load) => {
        const notesCount = (load.internalNotes ?? []).length;
        return (
          <div className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <PriorityToggle
              load={load}
              actorName={actorName}
              onAfter={(nextPriority) => patchLoadInState(load.loadId, { pickupPriority: nextPriority })}
            />
            <NotesButton count={notesCount} onOpen={() => setNotesTarget(load)} />
          </div>
        );
      },
    });

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
          // Title — clickable link that opens the load modal. Same
          // affordance as customer / driver / asset cells: looks like
          // text but acts like a button.
          if (c.id === 'title' && load.title) {
            const eventId = load.legs[0]?.eventId ?? load.loadId;
            return (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openEditModal(eventId); }}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--gc-blue)', cursor: 'pointer', textAlign: 'left', fontSize: 13 }}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                title={load.title}
              >
                {load.title}
              </button>
            );
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
          // Accessorials — render the same chip + hover-list as
          // billing/paperwork (component lives in queue primitives).
          // Sort + export still get the numeric billable total via the
          // ColumnDef.get above.
          if (c.id === 'accessorials') {
            return <AccessorialsCell items={load.accessorials} />;
          }
          // Docs — same DocBadge / RequiredDocBadge cluster
          // /accounting + /closeout render. Required: rate-con +
          // POD (unless TONU) + Lumper / Scale when an accessorial
          // demands one. Optional badges only appear when the doc
          // is on file.
          if (c.id === 'docs') {
            const counts = load.documentCounts ?? {};
            const rcCount  = Math.max(counts.rate_con ?? 0, load.rateConPdf ? 1 : 0);
            const podCount = counts.pod ?? 0;
            const accs = load.accessorials ?? [];
            const needsLumper = accs.some(a => a.category === 'lumper');
            const needsScale  = accs.some(a => a.category === 'scale_ticket');
            const lumperCount = counts.lumper ?? 0;
            const scaleCount  = counts.scale  ?? 0;
            return (
              <div className="flex flex-wrap gap-1">
                <RequiredDocBadge label="RC"  present={rcCount > 0}  count={rcCount}  missingTitle="No rate confirmation uploaded" />
                {!load.isTonu && (
                  <RequiredDocBadge label="POD" present={podCount > 0} count={podCount} missingTitle="No POD uploaded" />
                )}
                {needsLumper && (
                  <RequiredDocBadge label="Lumper" present={lumperCount > 0} count={lumperCount} missingTitle="No lumper receipt uploaded" />
                )}
                {needsScale && (
                  <RequiredDocBadge label="Scale" present={scaleCount > 0} count={scaleCount} missingTitle="No scale ticket uploaded" />
                )}
                {(counts.bol          ?? 0) > 0 && <DocBadge label="BOL"     count={counts.bol}          />}
                {!needsLumper && lumperCount > 0 && <DocBadge label="Lumper"  count={lumperCount}        />}
                {!needsScale  && scaleCount  > 0 && <DocBadge label="Scale"   count={scaleCount}         />}
                {(counts.receipt      ?? 0) > 0 && <DocBadge label="Receipt" count={counts.receipt}      />}
                {(counts.driver_sheet ?? 0) > 0 && <DocBadge label="Driver"  count={counts.driver_sheet} />}
                {(counts.invoice      ?? 0) > 0 && <DocBadge label="Invoice" count={counts.invoice}      />}
              </div>
            );
          }

          return display || <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
        },
      });
    }

    return cols;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableColumns, ctx, customers, drivers, assets, openEditModal, actorName]);

  // OpsTable filter chips. Narrow what's visible WITHOUT changing the
  // headline totals above — same convention as /accounting and /closeout
  // (the bucket-tile $ stays at the bucket level; chips refine the table
  // view). Adding more later (e.g. equipment type, dispatcher) is just
  // another entry here.
  const tableFilters = useMemo<OpsFilter<LoadSummary>[]>(() => [
    {
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
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Status',
      pluralLabel: 'statuses',
      options: [
        { value: 'scheduled',  label: 'Scheduled' },
        { value: 'assigned',   label: 'Assigned' },
        { value: 'dispatched', label: 'Dispatched' },
        { value: 'en_route',   label: 'En Route' },
        { value: 'picked_up',  label: 'Picked Up' },
        { value: 'delivered',  label: 'Delivered' },
        { value: 'cancelled',  label: 'Cancelled' },
        { value: 'tonu',       label: 'TONU' },
        { value: 'problem',    label: 'Problem' },
      ],
      // Pickup-leg status is the load's headline status. Relays get the
      // delivery side filtered through the Delivery Status column when
      // the user wants that finer cut.
      predicate: (load, v) => load.pickupStatus === v,
    },
    {
      kind: 'select',
      key: 'billing',
      label: 'Billing',
      options: [
        { value: 'pending',   label: 'Pending' },
        { value: 'verified',  label: 'Verified' },
        { value: 'invoiced',  label: 'Invoiced' },
        { value: 'paid',      label: 'Paid' },
        { value: 'on_hold',   label: 'On Hold' },
      ],
      // Loads with no billingStatus set default to pending (matches the
      // way /accounting buckets unflagged rows).
      predicate: (load, v) => (load.billingStatus ?? 'pending') === v,
    },
    {
      kind: 'select',
      key: 'customer',
      label: 'Customer',
      options: customers
        .map(c => ({ value: c.name, label: c.shortName?.trim() || c.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      // Match by FK-resolved customer name first, then fall back to the
      // load's broker string for legacy rows that never got a
      // customer_id stamped on them.
      predicate: (load, v) => {
        const c = customers.find(x => x.id === load.customerId);
        const name = c?.name ?? load.broker ?? '';
        return name === v;
      },
    },
    {
      kind: 'select',
      key: 'driver',
      label: 'Driver',
      options: driverOptions.map(d => ({ value: d.name, label: d.name })),
      // Match either leg's driver so a relay surfaces under either name.
      predicate: (load, v) =>
        load.pickupDriverName === v || load.deliveryDriverName === v,
    },
    {
      kind: 'select',
      key: 'truck',
      label: 'Truck',
      options: assets
        .filter(a => !a.hidden)
        .map(a => ({ value: String(a.id), label: a.unit ? `${a.name} #${a.unit}` : a.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      predicate: (load, v) =>
        String(load.pickupAssetId) === v || String(load.deliveryAssetId) === v,
    },
    {
      kind: 'select',
      key: 'accessorial',
      label: 'Accessorial',
      options: [
        { value: '__any',        label: 'Has any accessorial' },
        { value: '__pending',    label: 'Has pending accessorial' },
        { value: '__none',       label: 'No accessorials' },
        { value: 'detention',    label: 'Detention' },
        { value: 'lumper',       label: 'Lumper' },
        { value: 'layover',      label: 'Layover' },
        { value: 'scale_ticket', label: 'Scale' },
        { value: 'extra_stop',   label: 'Extra stop' },
        { value: 'other',        label: 'Other' },
      ],
      // Mirrors /accounting's preset list. `__any` / `__pending` /
      // `__none` are aggregate filters; everything else matches
      // accessorial.category exactly.
      predicate: (load, v) => {
        const accs = load.accessorials ?? [];
        if (v === '__any')     return accs.length > 0;
        if (v === '__pending') return accs.some(a => a.status !== 'approved' && a.status !== 'denied');
        if (v === '__none')    return accs.length === 0;
        return accs.some(a => a.category === v);
      },
    },
    {
      kind: 'select',
      key: 'priority',
      label: 'Priority',
      options: [
        { value: 'yes', label: 'Priority only' },
        { value: 'no',  label: 'Non-priority' },
      ],
      predicate: (load, v) => (!!load.pickupPriority) === (v === 'yes'),
    },
  ], [customers, driverOptions, assets]);

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
    <div style={{ marginTop: 32, marginBottom: 16, background: 'var(--gc-surface)', borderRadius: 14, border: '1px solid var(--gc-border)', minWidth: 0, overflow: 'hidden' }}>
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
        {/* Customer / Driver / Truck filters moved into the OpsTable's
            filter chip row to match billing/paperwork. The date pickers
            stay up here because they drive the server fetch — chip
            selections only refine display of the already-loaded set. */}
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
        // minWidth: 0 + overflow: hidden so the OpsTable card's own
        // overflowX: 'auto' actually handles horizontal scroll instead
        // of letting the row push the whole card wider than the
        // dashboard tab. Mirrors how /accounting + /closeout keep the
        // scrollbar contained inside the card.
        <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--gc-border-light)', minWidth: 0, overflow: 'hidden' }}>
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

      {/* Internal notes modal — opened from the row's notes pill in
          the sticky utility column. On save, patches the row's
          internalNotes locally so the count chip updates immediately. */}
      {notesTarget && (
        <InternalNotesModal
          load={notesTarget}
          actorName={actorName}
          onClose={() => setNotesTarget(null)}
          onSaved={(newNote) => {
            if (newNote && notesTarget) {
              patchLoadInState(notesTarget.loadId, {
                internalNotes: [...(notesTarget.internalNotes ?? []), newNote],
              });
              setNotesTarget({
                ...notesTarget,
                internalNotes: [...(notesTarget.internalNotes ?? []), newNote],
              });
            }
          }}
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
