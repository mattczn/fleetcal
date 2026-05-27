'use client';

/**
 * /equipment — flat all-reports view across maintenance, inspections,
 * and fuel for every truck + trailer in the org.
 *
 * Maintenance is the primary tab (highest-frequency dispatcher
 * workflow). Filters (driver, equipment, date sort) apply to whatever
 * tab is active. Clicking a row opens a centered overlay panel — the
 * panel itself is transparent so the photos + map "float" on a
 * dimmed backdrop; only the map keeps a solid frame because it
 * needs one to render tiles.
 *
 * Photos open in an in-page lightbox (no new-tab links) so the
 * dispatcher stays in flow while paging through evidence.
 *
 * Tables paginate at 25 rows/page — fleet history grows fast and a
 * 200-row dump was slow to scan + slow to render on bigger orgs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  Package, Wrench, ClipboardCheck, Fuel as FuelIcon,
  Camera, Loader2, MapPin, X, Clock, User, Truck, FileText, ExternalLink, Check, Trash2,
  ChevronLeft, ChevronRight, CalendarDays, List as ListIcon, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import ManagementHeader from '@/components/nav/ManagementHeader';
import type { Driver, Asset } from '@/lib/types';
import type {
  MaintenanceReport, FuelReport, FuelTransaction, MaintenanceReportPhoto,
  MaintenanceActionItem, MaintenanceCategory, MaintenancePriority, MaintenanceActionStatus,
} from '@fleetcal/types';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';
import {
  OpsTable, OpsDate, OpsPill, OpsMuted,
  type OpsColumn, type OpsFilter,
} from '@/components/ui/OpsTable';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { type Period, getPeriodRange, defaultCustomRangeISO } from '@/lib/periodRange';
import { fetchWithRetry } from '@/lib/fetchWithRetry';
import { isActiveOn, dateKeyOf } from '@/lib/lifecycle';
import { useCalendarStore } from '@/store/useCalendarStore';

// ─── Types ────────────────────────────────────────────────────────────

type InspectionRow = {
  id: string;
  driverId: number;
  driverName: string;
  assetId: number | null;
  assetName: string | null;
  trailerId: number | null;
  trailerName: string | null;
  inspectionDate: string;
  hasDefects: boolean;
  defectCount: number;
  itemCount: number;
  photoCount: number;
  durationSeconds: number | null;
  submittedAt: string;
};

type Tab = 'maintenance' | 'inspections' | 'fuel';

// MediaList — every photo for the currently-open report, grouped by
// source (defect item, general, etc.) so the side-panel can show
// captions linking each photo back to where it came from. Built by
// the detail components and passed up via onOpenMedia.
type MediaList = {
  initialIndex: number; // which photo the user clicked
  items: Array<{
    id: string;
    signedUrl: string | null;
    caption: string | null;
    section?: string; // e.g. "Truck Big Red · Tires"
  }>;
};

// What a row knows for the right-side panel. Each tab maps its row
// shape onto this so the panel can render uniformly.
//
// 'fuel' carries BOTH sides of a fuel-up (card transaction + driver
// report) — they're two facets of the same event so the panel
// renders them as one record. Either side may be null:
//   • card-only:   transaction set, report null
//   • driver-only: transaction null, report set
//   • matched:     both set
type PanelData = {
  kind: 'maintenance' | 'inspection' | 'fuel';
  id: string;
  // ID used to fetch the full detail (for inspections — the list
  // doesn't carry the per-item checklist). Maintenance + Fuel already
  // ship complete rows, so this can re-use the list row directly.
} & (
  | { kind: 'maintenance'; report: MaintenanceReport }
  | { kind: 'fuel';        transaction: FuelTransaction | null; report: FuelReport | null }
  | { kind: 'inspection';  row: InspectionRow }
);

// ─── Page ─────────────────────────────────────────────────────────────

export default function EquipmentPage() {
  const searchParams = useSearchParams();
  const initialTab = (() => {
    const t = searchParams?.get('tab');
    return t === 'fuel' || t === 'maintenance' || t === 'inspections' ? t : 'maintenance';
  })();
  const [tab, setTab] = useState<Tab>(initialTab);

  // Page-level filters retired — OpsTable owns its own filter chips
  // now (search + select dropdowns scoped to each tab's data). The
  // driver/equipment server-side filter was forcing a full refetch
  // every time the dispatcher narrowed the working set, which felt
  // sluggish; client-side filtering on the already-loaded 200 rows is
  // instant and matches Motive's UX.

  // Filter dropdown data — fetched once. Used by both the Driver
  // dropdown and the Equipment dropdown (trucks + trailers merged).
  // Wrapped in fetchWithRetry because Railway can take 30-60s to
  // boot after a deploy / restart, and during that window the
  // request rejects with a 502/503. Without retry the page renders
  // with empty state and the user is stuck refreshing the browser.
  const [drivers, setDrivers]   = useState<Driver[]>([]);
  const [assets,   setAssets]   = useState<Asset[]>([]);
  const [trailers, setTrailers] = useState<Array<{ id: number; name: string; trailerNumber?: string; category: string }>>([]);
  const [fixturesLoading, setFixturesLoading] = useState(true);
  const [fixturesError,   setFixturesError]   = useState<string | null>(null);
  const [fixturesReloadKey, setFixturesReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setFixturesLoading(true);
    setFixturesError(null);
    Promise.allSettled([
      fetchWithRetry(() => railway.listDrivers(),  { signal: ctrl.signal, onAttemptFailed: (err, n, willRetry) => {
        if (willRetry) console.warn(`[equipment fixtures] drivers attempt ${n} failed, retrying:`, err);
      }}),
      fetchWithRetry(() => railway.listAssets(),   { signal: ctrl.signal, onAttemptFailed: (err, n, willRetry) => {
        if (willRetry) console.warn(`[equipment fixtures] assets attempt ${n} failed, retrying:`, err);
      }}),
      fetchWithRetry(() => railway.listTrailers(), { signal: ctrl.signal, onAttemptFailed: (err, n, willRetry) => {
        if (willRetry) console.warn(`[equipment fixtures] trailers attempt ${n} failed, retrying:`, err);
      }}),
    ]).then(([d, a, t]) => {
      if (ctrl.signal.aborted) return;
      const failures: string[] = [];
      if (d.status === 'fulfilled') setDrivers(d.value.drivers as Driver[]);
      else                          failures.push('drivers');
      if (a.status === 'fulfilled') setAssets(a.value.assets as Asset[]);
      else                          failures.push('assets');
      if (t.status === 'fulfilled') setTrailers(t.value.trailers as Array<{ id: number; name: string; trailerNumber?: string; category: string }>);
      else                          failures.push('trailers');
      if (failures.length > 0) {
        setFixturesError(`Failed to load ${failures.join(' + ')}. The API may still be starting up.`);
      }
      setFixturesLoading(false);
    });
    return () => ctrl.abort();
  }, [fixturesReloadKey]);
  const retryFixtures = useCallback(() => setFixturesReloadKey(k => k + 1), []);

  const [panel, setPanel] = useState<PanelData | null>(null);

  // Resolver maps for the row tables + detail panels. Everywhere we
  // would otherwise render "Driver #30" / "Asset #37" we now look up
  // the real label by id. Maps are built from the lists we already
  // fetch for the filter dropdowns so there's no extra network cost.
  const driverNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const d of drivers) m.set(d.id, d.name);
    return m;
  }, [drivers]);
  const assetLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of assets) m.set(a.id, `${a.name}${a.unit ? ` #${a.unit}` : ''}`);
    return m;
  }, [assets]);
  const trailerLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of trailers) m.set(t.id, t.trailerNumber ? `#${t.trailerNumber}` : t.name);
    return m;
  }, [trailers]);

  // Media side-panel — opens to the right of the main detail panel
  // when the dispatcher clicks any photo. Shows every photo from the
  // current report in a scrollable column so all uploads are visible
  // at once. Lives at page level so the main panel doesn't need to
  // know about it.
  const [sideMedia, setSideMedia] = useState<MediaList | null>(null);

  // Bump-a-counter to force FuelTabContent's data fetch to re-run.
  // Every mutation inside the open panel (assign / auto-match / link
  // / unlink) calls bumpFuelData() so the table behind the modal
  // reflects the change without needing a full page reload. Cheap —
  // the refetch is two parallel API calls of <=500 rows each.
  const [fuelDataVersion, setFuelDataVersion] = useState(0);
  const bumpFuelData = useCallback(() => setFuelDataVersion(v => v + 1), []);

  return (
    // h-screen (not min-h-screen) so the outer column has a FIXED
    // height equal to the viewport. Without that bound, the flex-1
    // tab-content child can grow past the viewport and the
    // overflow-y-auto on it never kicks in (the body's global
    // overflow:hidden then clips the bottom unreachable). Pages that
    // need to scroll inside a flex-1 child MUST use h-screen here,
    // not min-h-screen.
    //
    // White surface (not the page gray) because the inner tables now
    // float on the surface rather than sitting in cards on a tinted
    // background — feels closer to a real ops dashboard than a
    // glorified settings panel.
    <div className="h-screen flex flex-col" style={{ background: 'var(--gc-surface)' }}>
      <ManagementHeader title="Equipment" icon={Package} />

      {/* Fixtures-load error banner — shown when drivers/assets/
          trailers fail to load after retries. The most common cause
          is Railway mid-restart; the visible Retry button beats the
          user staring at empty dropdowns wondering what to do. */}
      {fixturesError && (
        <div
          className="px-6 py-2.5 flex items-center justify-between gap-3"
          style={{
            background: '#fef2f2',
            borderBottom: '1px solid #fecaca',
            color: '#991b1b',
          }}>
          <div className="text-[13px]">
            <strong>{fixturesError}</strong>
            {' '}If this persists, the API server may be down.
          </div>
          <button
            type="button"
            onClick={retryFixtures}
            disabled={fixturesLoading}
            className="rounded-md text-[12px] font-semibold transition-colors"
            style={{
              background: '#fff',
              color: '#991b1b',
              border: '1px solid #fecaca',
              padding: '5px 12px',
              cursor: fixturesLoading ? 'default' : 'pointer',
              opacity: fixturesLoading ? 0.5 : 1,
            }}>
            {fixturesLoading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {/* Tab bar. Inner content capped at 1400px (matches my-calendar
          fuel.html and the rest of the management surfaces) and
          centered — full-width tables on a 27" monitor read as a
          spreadsheet, not a curated view. */}
      <div className="border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
        <div className="mx-auto w-full px-6 pt-5" style={{ maxWidth: 1400 }}>
          <div className="flex gap-1">
            <TabButton active={tab === 'maintenance'} onClick={() => setTab('maintenance')} icon={<Wrench size={15} />}         label="Maintenance" />
            <TabButton active={tab === 'inspections'} onClick={() => setTab('inspections')} icon={<ClipboardCheck size={15} />} label="Inspections" />
            <TabButton active={tab === 'fuel'}        onClick={() => setTab('fuel')}        icon={<FuelIcon size={15} />}       label="Fuel" />
          </div>
        </div>
      </div>

      {/* Tab content. min-h-0 lets the flex child shrink below its
          natural content height so overflow-y-auto can actually clip
          + scroll. Without min-h-0 the column blows past the viewport
          and gets cut off by body's global overflow:hidden, with no
          way to reach the bottom rows. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full px-6 py-5" style={{ maxWidth: 1400 }}>
        {tab === 'maintenance' && (
          <MaintenanceTabContent
            drivers={drivers}
            assets={assets}
            trailers={trailers}
            driverNameById={driverNameById}
            assetLabelById={assetLabelById}
            trailerLabelById={trailerLabelById}
            panel={panel}
            setPanel={setPanel}
          />
        )}
        {tab === 'inspections' && (
          <InspectionsTabContent
            drivers={drivers}
            assets={assets}
            trailers={trailers}
            onOpen={(r) => setPanel({ kind: 'inspection', id: r.id, row: r })}
            openId={panel?.kind === 'inspection' ? panel.id : null}
          />
        )}
        {tab === 'fuel' && (
          <FuelTabContent
            drivers={drivers}
            assets={assets}
            driverNameById={driverNameById}
            assetLabelById={assetLabelById}
            panel={panel}
            setPanel={setPanel}
            reloadVersion={fuelDataVersion}
          />
        )}
        </div>
      </div>

      {panel && (
        <DetailPanel
          panel={panel}
          drivers={drivers}
          assets={assets}
          driverNameById={driverNameById}
          assetLabelById={assetLabelById}
          trailerLabelById={trailerLabelById}
          sideMedia={sideMedia}
          onFuelMutation={bumpFuelData}
          onClose={() => { setPanel(null); setSideMedia(null); }}
          onOpenMedia={(list) => setSideMedia(list)}
          onCloseSideMedia={() => setSideMedia(null)}
        />
      )}
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors"
      style={{
        color: active ? '#1a73e8' : 'var(--gc-text-2)',
        borderBottom: active ? '2px solid #1a73e8' : '2px solid transparent',
        marginBottom: -1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Shared helpers ─────────────────────────────────────────────────

// Build asset/trailer dropdown options for OpsTable's select filter.
// "asset:123" / "trailer:456" encoding lets one chip drive both
// dimensions; the predicate splits the key back out at filter time.
function buildEquipmentOptions(
  assets: Asset[],
  trailers: Array<{ id: number; name: string; trailerNumber?: string }>,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const a of [...assets].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    out.push({ value: `asset:${a.id}`, label: `Truck ${a.name}${a.unit ? ` #${a.unit}` : ''}` });
  }
  for (const t of [...trailers].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    out.push({ value: `trailer:${t.id}`, label: `Trailer ${t.trailerNumber ? `#${t.trailerNumber}` : t.name}` });
  }
  return out;
}

function buildDriverOptions(drivers: Driver[]): Array<{ value: string; label: string }> {
  // No active-status filter. Rows in the table can reference any
  // driver (current or retired), so the filter chip should let the
  // dispatcher narrow by any of them. Active-only filtering bit us
  // hard when activeTo was set on every driver and the dropdown
  // came back empty.
  return [...drivers]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map(d => ({ value: String(d.id), label: d.name }));
}

// Decode the "asset:123" / "trailer:456" encoding back into a row-
// match check.
function matchesEquipment(filterValue: string, assetId?: number, trailerId?: number): boolean {
  const [kind, idStr] = filterValue.split(':');
  const id = Number(idStr);
  if (kind === 'asset')   return assetId === id;
  if (kind === 'trailer') return trailerId === id;
  return true;
}

// ─── Maintenance ──────────────────────────────────────────────────────

// ─── Maintenance tab content (sub-tabs: Work orders / Driver reports) ──
//
// The Maintenance tab now has two surfaces:
//
//   • Work orders     — proactive ops work. CRUD on maintenance_action_items
//                       (the ops-tracked job: scheduled repairs, PMs,
//                       inspections, etc.). Replaces what the legacy my-
//                       calendar maintenance.html called "Action Queue".
//   • Driver reports  — reactive. The existing maintenance_reports list
//                       (driver-submitted defects). Convert action turns
//                       a report into a work order.

type MaintenanceSubTab = 'work_orders' | 'driver_reports';

function MaintenanceTabContent({
  drivers, assets, trailers, driverNameById, assetLabelById, trailerLabelById,
  panel, setPanel,
}: {
  drivers: Driver[];
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  panel: PanelData | null;
  setPanel: (p: PanelData | null) => void;
}) {
  const [subTab, setSubTab] = useState<MaintenanceSubTab>('work_orders');
  // Modal state for work-order create/edit. `mode` distinguishes:
  //   - 'create'  : blank form, POST on save
  //   - 'edit'    : prefilled from existing item, PATCH on save
  //   - 'convert' : prefilled from a driver report, POST /convert on save
  const [woModal, setWoModal] = useState<
    | { open: true; mode: 'create' }
    | { open: true; mode: 'edit'; item: MaintenanceActionItem }
    | { open: true; mode: 'convert'; report: MaintenanceReport }
    | { open: false }
  >({ open: false });
  // Bump-counter so the Work Orders list re-fetches after any mutation.
  const [woReloadKey, setWoReloadKey] = useState(0);
  const bumpWoReload = useCallback(() => setWoReloadKey(k => k + 1), []);

  // Pending-triage count for the Driver reports sub-tab badge.
  // Lightweight separate fetch so dispatchers see "you have N reports
  // to triage" without having to click into the sub-tab first.
  // Recomputes whenever a convert action fires (via woReloadKey).
  const [pendingReportCount, setPendingReportCount] = useState<number | null>(null);
  useEffect(() => {
    railway.listMaintenanceReports({ limit: 200 })
      .then(r => {
        // "Pending" = needs dispatcher attention. Open reports are the
        // raw inbox; reviewed reports are partially-triaged but not
        // yet acted on. Converted + dismissed are settled.
        const pending = r.reports.filter(rep =>
          rep.status === 'open' || rep.status === 'reviewed',
        ).length;
        setPendingReportCount(pending);
      })
      .catch(() => setPendingReportCount(null));
  }, [woReloadKey]);

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tab strip — pill style, smaller than the top-level tabs.
          Driver reports gets a badge with the pending-triage count
          so the dispatcher sees inbox pressure without clicking. */}
      <div className="flex items-center gap-1">
        {([
          { v: 'work_orders'    as const, label: 'Work orders',    badge: null },
          { v: 'driver_reports' as const, label: 'Driver reports', badge: pendingReportCount && pendingReportCount > 0 ? pendingReportCount : null },
        ]).map(t => {
          const active = subTab === t.v;
          return (
            <button key={t.v}
              type="button"
              onClick={() => setSubTab(t.v)}
              className="flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors"
              style={{
                padding:    '5px 12px',
                background: active ? 'var(--gc-bg)' : 'transparent',
                color:      active ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                border:     `1px solid ${active ? 'var(--gc-border-light)' : 'transparent'}`,
              }}>
              {t.label}
              {t.badge != null && (
                <span
                  className="inline-flex items-center justify-center rounded-full text-[10px] font-bold tabular-nums"
                  style={{
                    background: active ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                    color:      '#fff',
                    minWidth:   18,
                    height:     16,
                    padding:    '0 5px',
                  }}>
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {subTab === 'work_orders' && (
        <WorkOrdersList
          drivers={drivers}
          assets={assets}
          trailers={trailers}
          assetLabelById={assetLabelById}
          trailerLabelById={trailerLabelById}
          reloadKey={woReloadKey}
          pendingReportCount={pendingReportCount}
          onNewClick={() => setWoModal({ open: true, mode: 'create' })}
          onRowClick={(item) => setWoModal({ open: true, mode: 'edit', item })}
          onSwitchToReports={() => setSubTab('driver_reports')}
        />
      )}

      {subTab === 'driver_reports' && (
        <MaintenanceList
          drivers={drivers}
          assets={assets}
          trailers={trailers}
          driverNameById={driverNameById}
          assetLabelById={assetLabelById}
          trailerLabelById={trailerLabelById}
          onOpen={(r) => setPanel({ kind: 'maintenance', id: r.id, report: r })}
          onConvertClick={(r) => setWoModal({ open: true, mode: 'convert', report: r })}
          openId={panel?.kind === 'maintenance' ? panel.id : null}
        />
      )}

      {/* Work-order modal — controlled by the parent so both Work-orders
          rows and "Convert from driver report" both route to the same
          form. */}
      {woModal.open && (
        <WorkOrderModal
          mode={woModal.mode}
          item={woModal.mode === 'edit'    ? woModal.item   : undefined}
          fromReport={woModal.mode === 'convert' ? woModal.report : undefined}
          assets={assets}
          trailers={trailers}
          assetLabelById={assetLabelById}
          trailerLabelById={trailerLabelById}
          onClose={() => setWoModal({ open: false })}
          onSaved={() => {
            setWoModal({ open: false });
            bumpWoReload();
            // If we converted a driver report, also flip its row to
            // 'converted' in the panel state if it's currently open.
            if (woModal.mode === 'convert' && panel?.kind === 'maintenance' && panel.id === woModal.report.id) {
              setPanel(null);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Work orders list ──────────────────────────────────────────────────

function WorkOrdersList({
  drivers, assets, trailers, assetLabelById, trailerLabelById,
  reloadKey, pendingReportCount, onNewClick, onRowClick, onSwitchToReports,
}: {
  drivers: Driver[];
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  reloadKey: number;
  pendingReportCount: number | null;
  onNewClick: () => void;
  onRowClick: (item: MaintenanceActionItem) => void;
  /** Switches the sub-tab to Driver reports. Used by the empty-state
   *  CTA when there are pending reports the dispatcher could convert. */
  onSwitchToReports: () => void;
}) {
  const [items, setItems] = useState<MaintenanceActionItem[]>([]);
  const [loading, setLoading] = useState(true);
  // `drivers` not used here — kept on the prop list for symmetry with
  // MaintenanceList in case future filters need it (e.g. created_by).
  void drivers;

  useEffect(() => {
    setLoading(true);
    railway.listMaintenanceActionItems({ limit: 500 })
      .then(r => setItems(r.actionItems))
      .catch(err => { console.error('[equipment] work orders:', err); setItems([]); })
      .finally(() => setLoading(false));
  }, [reloadKey]);

  const resolvedRows = useMemo(() => items.map(i => {
    const equipLabel = i.assetId
      ? (assetLabelById.get(i.assetId) ?? `Asset #${i.assetId}`)
      : i.trailerId
        ? (trailerLabelById.get(i.trailerId) ?? `Trailer #${i.trailerId}`)
        : '—';
    return { ...i, _equipLabel: equipLabel };
  }), [items, assetLabelById, trailerLabelById]);

  type R = typeof resolvedRows[number];

  const columns: OpsColumn<R>[] = [
    { key: 'scheduledDate', header: 'Date', width: 110, sortable: true,
      sortValue: r => r.scheduledDate ?? r.createdAt,
      render: r => r.scheduledDate
        ? <OpsDate iso={`${r.scheduledDate}T12:00:00`} />
        : <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>unscheduled</span> },
    { key: 'title', header: 'Title', sortable: true,
      render: r => (
        <span>
          {r.outOfService && <OpsPill color="red">OOS</OpsPill>}{r.outOfService && ' '}
          {r.title.length > 70 ? r.title.slice(0, 70) + '…' : r.title}
        </span>
      ) },
    { key: '_equipLabel', header: 'Equipment', sortable: true,
      render: r => r._equipLabel },
    { key: 'category', header: 'Category', width: 110, sortable: true,
      sortValue: r => r.category,
      render: r => <span className="text-[12px] capitalize" style={{ color: 'var(--gc-text-2)' }}>{r.category}</span> },
    { key: 'priority', header: 'Priority', width: 100, sortable: true,
      sortValue: r => ['urgent', 'high', 'normal', 'low'].indexOf(r.priority),
      render: r => {
        const color: 'red' | 'amber' | 'blue' | 'gray' =
          r.priority === 'urgent' ? 'red'   :
          r.priority === 'high'   ? 'amber' :
          r.priority === 'normal' ? 'blue'  :
                                    'gray';
        return <OpsPill color={color}>{r.priority}</OpsPill>;
      } },
    { key: 'status', header: 'Status', width: 110, sortable: true,
      sortValue: r => r.status,
      render: r => {
        const color: 'amber' | 'blue' | 'green' =
          r.status === 'open'        ? 'amber' :
          r.status === 'in_progress' ? 'blue'  :
                                       'green';   // done
        return <OpsPill color={color}>{r.status.replace('_', ' ')}</OpsPill>;
      } },
    { key: 'cost', header: 'Cost', width: 100, align: 'right',
      sortValue: r => r.actualCost ?? r.estimatedCost ?? -1,
      render: r => {
        const v = r.actualCost ?? r.estimatedCost;
        return v != null
          ? <span className="font-mono">${v.toFixed(2)}</span>
          : <OpsMuted />;
      } },
    { key: 'vendor', header: 'Vendor',
      render: r => r.vendor ?? <OpsMuted /> },
  ];

  const filters: OpsFilter<R>[] = [
    { kind: 'search', placeholder: 'Search title, description, vendor…',
      match: (r, q) => r.title.toLowerCase().includes(q)
                    || (r.description ?? '').toLowerCase().includes(q)
                    || (r.vendor ?? '').toLowerCase().includes(q) },
    { kind: 'select', key: 'status', label: 'Status',
      options: [
        { value: 'open',         label: 'Open' },
        { value: 'in_progress',  label: 'In progress' },
        { value: 'done',         label: 'Done' },
      ],
      predicate: (r, v) => r.status === v },
    { kind: 'select', key: 'priority', label: 'Priority',
      options: [
        { value: 'urgent', label: 'Urgent' },
        { value: 'high',   label: 'High' },
        { value: 'normal', label: 'Normal' },
        { value: 'low',    label: 'Low' },
      ],
      predicate: (r, v) => r.priority === v },
    { kind: 'select', key: 'category', label: 'Category',
      options: [
        { value: 'repair',     label: 'Repair' },
        { value: 'pm',         label: 'PM' },
        { value: 'inspection', label: 'Inspection' },
        { value: 'other',      label: 'Other' },
      ],
      predicate: (r, v) => r.category === v },
    { kind: 'select', key: 'equipment', label: 'Equipment',
      options: buildEquipmentOptions(assets, trailers),
      predicate: (r, v) => matchesEquipment(v, r.assetId, r.trailerId) },
  ];

  // First-time / true-empty state: render a friendly CTA instead of
  // the table's "no rows match" message. We can't tell from inside
  // OpsTable whether `0 visible` is "filters narrowed to nothing" vs
  // "carrier has never created one", so we short-circuit here when
  // the raw count is zero. Once they have any item at all, the
  // standard filter-no-match message inside OpsTable takes over.
  if (!loading && items.length === 0) {
    return (
      <div
        className="rounded-lg flex flex-col items-center justify-center text-center"
        style={{
          background: 'var(--gc-surface)',
          border:     '1px solid var(--gc-border-light)',
          padding:    '56px 24px',
        }}>
        <div
          className="rounded-full flex items-center justify-center mb-4"
          style={{ width: 56, height: 56, background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}>
          <Wrench size={24} />
        </div>
        <div className="text-[16px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          No work orders yet
        </div>
        <div className="text-[13px] mt-1.5 max-w-[440px]" style={{ color: 'var(--gc-text-3)' }}>
          Work orders track every repair, PM, and inspection — open, in-progress, or done.
          Create one when you schedule a shop visit, or convert a driver report into one.
        </div>
        <div className="flex items-center gap-2 mt-5">
          <button
            type="button"
            onClick={onNewClick}
            className="rounded-md transition-colors"
            style={{
              background: 'var(--gc-blue)',
              color:      '#fff',
              border:     '1px solid var(--gc-blue)',
              padding:    '8px 16px',
              fontSize:   13,
              fontWeight: 600,
              cursor:     'pointer',
            }}>
            + Create your first work order
          </button>
          {pendingReportCount != null && pendingReportCount > 0 && (
            <button
              type="button"
              onClick={onSwitchToReports}
              className="rounded-md transition-colors"
              style={{
                background: 'var(--gc-surface)',
                color:      'var(--gc-text-2)',
                border:     '1px solid var(--gc-border-light)',
                padding:    '8px 14px',
                fontSize:   13,
                fontWeight: 600,
                cursor:     'pointer',
              }}>
              {pendingReportCount} driver report{pendingReportCount === 1 ? '' : 's'} to triage →
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <OpsTable
      columns={columns}
      data={resolvedRows}
      filters={filters}
      loading={loading}
      rowKey={r => r.id}
      onRowClick={r => onRowClick(r)}
      emptyLabel="No work orders match the current filters."
      defaultSort={{ key: 'scheduledDate', dir: 'desc' }}
      density="comfortable"
      countLabel="work order"
      toolbarRight={
        <button
          type="button"
          onClick={onNewClick}
          className="rounded-md transition-colors"
          style={{
            background: 'var(--gc-blue)',
            color:      '#fff',
            border:     '1px solid var(--gc-blue)',
            padding:    '7px 12px',
            fontSize:   13,
            fontWeight: 600,
            cursor:     'pointer',
          }}>
          + New work order
        </button>
      }
    />
  );
}

// ─── Work order create / edit / convert modal ──────────────────────────
//
// Designed to match the EventModal aesthetic from the calendar:
//   • Truck and Trailer as two separate StyledSelect fields (asset
//     can be a truck XOR a trailer — not both, not neither for
//     creation).
//   • Priority lives as a colored badge in the header (click the
//     chevron to change). In edit mode, status joins it as a
//     second badge. Eliminates the in-form priority/status row.
//   • One date field ("When") for the common case. DOT-style hard
//     deadlines are deferred to Phase 2 where compliance PMs get
//     their own scheduling treatment.
//   • Vendor / Estimated $ / Category collapsed under "More details"
//     in create mode (default-closed); auto-opens in edit mode so
//     the dispatcher can see + edit them. The same row gains
//     Actual $ / Completed by in edit mode.
//
// One form for three flows:
//   create   → POST /v1/maintenance-action-items
//   edit     → PATCH /v1/maintenance-action-items/:id
//   convert  → POST /v1/maintenance-reports/:id/convert

const PRIORITY_STYLES: Record<MaintenancePriority, { bg: string; border: string; fg: string }> = {
  urgent: { bg: '#fee2e2', border: '#fecaca', fg: '#991b1b' },
  high:   { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
  normal: { bg: '#dbeafe', border: '#bfdbfe', fg: '#1e40af' },
  low:    { bg: '#f3f4f6', border: '#e5e7eb', fg: '#4b5563' },
};
const STATUS_STYLES: Record<MaintenanceActionStatus, { bg: string; border: string; fg: string }> = {
  open:        { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
  in_progress: { bg: '#dbeafe', border: '#bfdbfe', fg: '#1e40af' },
  done:        { bg: '#dcfce7', border: '#bbf7d0', fg: '#166534' },
};

function WorkOrderModal({
  mode, item, fromReport, assets, trailers, assetLabelById, trailerLabelById,
  onClose, onSaved,
}: {
  mode: 'create' | 'edit' | 'convert';
  item?: MaintenanceActionItem;
  fromReport?: MaintenanceReport;
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Build initial values from whichever mode we're in.
  const initial = useMemo(() => {
    if (mode === 'edit' && item) {
      return {
        title:         item.title,
        description:   item.description ?? '',
        category:      item.category,
        priority:      item.priority,
        status:        item.status,
        assetId:       item.assetId ?? null,
        trailerId:     item.trailerId ?? null,
        scheduledDate: item.scheduledDate ?? '',
        outOfService:  item.outOfService,
        vendor:        item.vendor ?? '',
        estimatedCost: item.estimatedCost?.toString() ?? '',
        actualCost:    item.actualCost?.toString() ?? '',
        completedBy:   item.completedBy ?? '',
      };
    }
    if (mode === 'convert' && fromReport) {
      const t = fromReport.description.length > 60
        ? fromReport.description.slice(0, 60) + '…'
        : fromReport.description;
      return {
        title:         t,
        description:   fromReport.description,
        category:      'repair' as MaintenanceCategory,
        priority:      'normal' as MaintenancePriority,
        status:        'open' as MaintenanceActionStatus,
        assetId:       fromReport.assetId ?? null,
        trailerId:     fromReport.trailerId ?? null,
        scheduledDate: '',
        outOfService:  false,
        vendor:        '',
        estimatedCost: '',
        actualCost:    '',
        completedBy:   '',
      };
    }
    return {
      title:         '',
      description:   '',
      category:      'repair' as MaintenanceCategory,
      priority:      'normal' as MaintenancePriority,
      status:        'open' as MaintenanceActionStatus,
      assetId:       null as number | null,
      trailerId:     null as number | null,
      scheduledDate: '',
      outOfService:  false,
      vendor:        '',
      estimatedCost: '',
      actualCost:    '',
      completedBy:   '',
    };
  }, [mode, item, fromReport]);

  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [initial]);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);
  // More-details section: closed by default in create + convert,
  // opened in edit (dispatcher's usually here to fill them in).
  const [detailsOpen, setDetailsOpen] = useState(mode === 'edit');

  const today = useMemo(() => dateKeyOf(new Date()), []);

  // Active-asset / active-trailer lists. Includes the currently-
  // assigned one even if retired, so existing assignments don't
  // disappear from the dropdown.
  const truckOptions = useMemo(() => {
    return assets
      .filter(a => isActiveOn(a, today) || a.id === form.assetId)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [assets, form.assetId, today]);
  const trailerOptions = useMemo(() => {
    return trailers
      .filter(t => isActiveOn(t as { activeFrom?: string; activeTo?: string | null }, today) || t.id === form.trailerId)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [trailers, form.trailerId, today]);

  const priorityStyle = PRIORITY_STYLES[form.priority];
  const statusStyle   = STATUS_STYLES[form.status];

  // Selecting a truck clears trailer and vice versa — one work order
  // is on one asset. Either is fine, but not both at once (matches
  // the DB check at the app layer; "general / shop-wide" work with
  // neither is also allowed but rare).
  function setTruck(id: number | null) {
    setForm(f => ({ ...f, assetId: id, trailerId: id ? null : f.trailerId }));
  }
  function setTrailer(id: number | null) {
    setForm(f => ({ ...f, trailerId: id, assetId: id ? null : f.assetId }));
  }

  async function save() {
    if (busy) return;
    if (!form.title.trim()) { setError('Title is required.'); return; }
    if (mode !== 'edit' && !form.assetId && !form.trailerId) {
      setError('Pick a truck or a trailer.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const payload = {
        title:         form.title.trim(),
        description:   form.description.trim() || undefined,
        category:      form.category,
        priority:      form.priority,
        outOfService:  form.outOfService,
        scheduledDate: form.scheduledDate || undefined,
        vendor:        form.vendor.trim() || undefined,
        estimatedCost: form.estimatedCost ? Number(form.estimatedCost) : undefined,
        actualCost:    mode === 'edit' && form.actualCost ? Number(form.actualCost) : undefined,
        completedBy:   mode === 'edit' && form.completedBy.trim() ? form.completedBy.trim() : undefined,
        status:        mode === 'edit' ? form.status : undefined,
        assetId:       form.assetId ?? undefined,
        trailerId:     form.trailerId ?? undefined,
      };
      if (mode === 'edit' && item) {
        await railway.updateMaintenanceActionItem(item.id, payload);
      } else if (mode === 'convert' && fromReport) {
        await railway.convertMaintenanceReport(fromReport.id, payload);
      } else {
        await railway.createMaintenanceActionItem(payload);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message ?? 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteItem() {
    if (mode !== 'edit' || !item) return;
    if (!window.confirm('Delete this work order? This cannot be undone.')) return;
    setBusy(true); setError(null);
    try {
      await railway.deleteMaintenanceActionItem(item.id);
      onSaved();
    } catch (err) {
      setError((err as Error).message ?? 'Delete failed');
      setBusy(false);
    }
  }

  const title =
    mode === 'create'  ? 'New work order'
    : mode === 'convert' ? 'Convert driver report'
    : 'Edit work order';

  // Shared input styles — mirror EventModal's "form input"
  // (1px border var(--gc-border), 8px radius, 7-8px padding,
  // 13-14px text).
  const inputStyle: React.CSSProperties = {
    padding:    '8px 10px',
    border:     '1px solid var(--gc-border)',
    borderRadius: 8,
    background: 'var(--gc-surface)',
    color:      'var(--gc-text-1)',
    fontSize:   13,
    width:      '100%',
    transition: 'border-color 150ms',
  };
  const labelStyle: React.CSSProperties = {
    fontSize:     11,
    fontWeight:   600,
    letterSpacing:'0.06em',
    textTransform:'uppercase',
    color:        'var(--gc-text-3)',
    marginBottom: 6,
    display:      'block',
  };

  const content = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', zIndex: 1100, padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="flex flex-col rounded-2xl overflow-hidden shrink-0"
        style={{
          width:       'min(94vw, 620px)',
          maxHeight:   '92vh',
          background:  'var(--gc-surface)',
          boxShadow:   'var(--shadow-3)',
          // 3px accent bar — color reflects current priority, same
          // pattern as EventModal's status accent.
          borderTop:   `3px solid ${priorityStyle.fg}`,
        }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header — title + priority/status badges + close */}
        <div
          className="flex items-center justify-between gap-3 px-5 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <Wrench size={16} style={{ color: 'var(--gc-text-2)', flexShrink: 0 }} />
            <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {title}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Priority chip (always visible) */}
            <StyledSelect
              value={form.priority}
              onChange={e => setForm(f => ({ ...f, priority: e.target.value as MaintenancePriority }))}
              style={{
                background:     priorityStyle.bg,
                color:          priorityStyle.fg,
                border:         `1px solid ${priorityStyle.border}`,
                borderRadius:   999,
                padding:        '4px 10px',
                fontSize:       11,
                fontWeight:     700,
                letterSpacing:  '0.05em',
                textTransform:  'uppercase',
              }}>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </StyledSelect>
            {/* Status chip (edit mode only) */}
            {mode === 'edit' && (
              <StyledSelect
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as MaintenanceActionStatus }))}
                style={{
                  background:     statusStyle.bg,
                  color:          statusStyle.fg,
                  border:         `1px solid ${statusStyle.border}`,
                  borderRadius:   999,
                  padding:        '4px 10px',
                  fontSize:       11,
                  fontWeight:     700,
                  letterSpacing:  '0.05em',
                  textTransform:  'uppercase',
                }}>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="done">Done</option>
              </StyledSelect>
            )}
            <button
              onClick={onClose}
              type="button"
              className="p-1.5 rounded-full transition-colors"
              style={{ color: 'var(--gc-text-3)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">

          {/* Truck + Trailer — paired in 2-col grid, mutually exclusive */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>Truck</label>
              <StyledSelect
                value={form.assetId == null ? '' : String(form.assetId)}
                onChange={e => setTruck(e.target.value ? Number(e.target.value) : null)}
                style={inputStyle}>
                <option value="">— None —</option>
                {truckOptions.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name}{a.unit ? ` #${a.unit}` : ''}
                  </option>
                ))}
              </StyledSelect>
            </div>
            <div>
              <label style={labelStyle}>Trailer</label>
              <StyledSelect
                value={form.trailerId == null ? '' : String(form.trailerId)}
                onChange={e => setTrailer(e.target.value ? Number(e.target.value) : null)}
                style={inputStyle}>
                <option value="">— None —</option>
                {trailerOptions.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.trailerNumber ? `#${t.trailerNumber}` : t.name}
                  </option>
                ))}
              </StyledSelect>
            </div>
          </div>

          {/* Title */}
          <div>
            <label style={labelStyle}>
              Title <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="What needs to be done?"
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
              onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
            />
          </div>

          {/* Notes */}
          <div>
            <label style={labelStyle}>Notes</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={3}
              placeholder="Details, symptoms, parts needed…"
              style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
              onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
            />
          </div>

          {/* Scheduling section — When + OOS */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle}>When</label>
              <input
                type="date"
                value={form.scheduledDate}
                onChange={e => setForm(f => ({ ...f, scheduledDate: e.target.value }))}
                style={inputStyle}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
              />
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <label
                className="flex items-center gap-2 text-[13px] cursor-pointer"
                style={{ ...inputStyle, padding: '8px 10px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.outOfService}
                  onChange={e => setForm(f => ({ ...f, outOfService: e.target.checked }))}
                />
                <span style={{ color: form.outOfService ? '#991b1b' : 'var(--gc-text-2)' }}>
                  Truck out of service
                </span>
              </label>
            </div>
          </div>

          {/* Convert preview — only in convert mode */}
          {mode === 'convert' && fromReport && (
            <div
              className="rounded-lg px-3 py-2.5"
              style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
              <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                From driver report
              </div>
              <div className="text-[12.5px]" style={{ color: 'var(--gc-text-2)' }}>
                {fromReport.assetId ? (assetLabelById.get(fromReport.assetId) ?? `Asset #${fromReport.assetId}`)
                  : fromReport.trailerId ? `Trailer ${trailerLabelById.get(fromReport.trailerId) ?? `#${fromReport.trailerId}`}`
                  : ''}
                {' · '}
                {new Date(fromReport.reportedAt).toLocaleDateString()}
              </div>
            </div>
          )}

          {/* More details — collapsible */}
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--gc-border-light)' }}>
            <button
              type="button"
              onClick={() => setDetailsOpen(o => !o)}
              className="w-full flex items-center justify-between px-3 py-2 transition-colors"
              style={{ background: detailsOpen ? 'var(--gc-bg)' : 'var(--gc-surface)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-bg)')}
              onMouseLeave={e => (e.currentTarget.style.background = detailsOpen ? 'var(--gc-bg)' : 'var(--gc-surface)')}>
              <span className="text-[12px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                More details {detailsOpen ? '' : '· optional'}
              </span>
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"
                style={{
                  color: 'var(--gc-text-3)',
                  transform: detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 150ms',
                }}>
                <path d="M1.5 3.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {detailsOpen && (
              <div className="px-3 py-3 flex flex-col gap-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Category</label>
                    <StyledSelect
                      value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value as MaintenanceCategory }))}
                      style={inputStyle}>
                      <option value="repair">Repair</option>
                      <option value="pm">PM (preventive)</option>
                      <option value="inspection">Inspection</option>
                      <option value="other">Other</option>
                    </StyledSelect>
                  </div>
                  <div>
                    <label style={labelStyle}>Vendor / shop</label>
                    <input
                      value={form.vendor}
                      onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))}
                      placeholder="NAPA, in-house, …"
                      style={inputStyle}
                      onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                      onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Estimated $</label>
                    <input
                      value={form.estimatedCost}
                      onChange={e => setForm(f => ({ ...f, estimatedCost: e.target.value }))}
                      placeholder="0.00"
                      inputMode="decimal"
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                      onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                      onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
                    />
                  </div>
                  {mode === 'edit' && (
                    <div>
                      <label style={labelStyle}>Actual $</label>
                      <input
                        value={form.actualCost}
                        onChange={e => setForm(f => ({ ...f, actualCost: e.target.value }))}
                        placeholder="0.00"
                        inputMode="decimal"
                        style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
                        onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                        onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
                      />
                    </div>
                  )}
                </div>
                {mode === 'edit' && (
                  <div>
                    <label style={labelStyle}>Completed by</label>
                    <input
                      value={form.completedBy}
                      onChange={e => setForm(f => ({ ...f, completedBy: e.target.value }))}
                      placeholder="Mechanic / shop name"
                      style={inputStyle}
                      onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
                      onBlur={e =>  (e.currentTarget.style.borderColor = 'var(--gc-border)')}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="text-[12px]" style={{ color: '#dc2626' }}>{error}</div>
          )}
        </div>

        {/* Footer — Delete left, Cancel + Save right */}
        <div
          className="flex items-center justify-between gap-2 px-5 py-3 shrink-0"
          style={{ borderTop: '1px solid var(--gc-border)' }}>
          {mode === 'edit' ? (
            <button
              type="button"
              onClick={deleteItem}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md text-[12.5px] font-semibold transition-colors"
              style={{
                background: 'transparent',
                color:      '#dc2626',
                border:     '1px solid transparent',
                padding:    '7px 12px',
                cursor:     busy ? 'default' : 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Trash2 size={13} /> Delete
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md text-[12.5px] font-semibold transition-colors"
              style={{
                background: 'transparent',
                color:      'var(--gc-text-2)',
                border:     '1px solid var(--gc-border)',
                padding:    '7px 14px',
                cursor:     busy ? 'default' : 'pointer',
              }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !form.title.trim()}
              className="rounded-md text-[12.5px] font-semibold transition-colors"
              style={{
                background: (busy || !form.title.trim()) ? 'var(--gc-bg)' : 'var(--gc-blue)',
                color:      (busy || !form.title.trim()) ? 'var(--gc-text-3)' : '#fff',
                border:     `1px solid ${(busy || !form.title.trim()) ? 'var(--gc-border-light)' : 'var(--gc-blue)'}`,
                padding:    '7px 16px',
                cursor:     (busy || !form.title.trim()) ? 'default' : 'pointer',
              }}>
              {busy ? 'Saving…' : mode === 'create' ? 'Create' : mode === 'convert' ? 'Convert' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

function MaintenanceList({
  drivers, assets, trailers, driverNameById, assetLabelById, trailerLabelById, onOpen, onConvertClick, openId,
}: {
  drivers: Driver[];
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  onOpen: (r: MaintenanceReport) => void;
  /** Optional: when present, renders a "Convert to work order" action
   *  on each row. Lifted from the Maintenance tab content wrapper. */
  onConvertClick?: (r: MaintenanceReport) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<MaintenanceReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    railway.listMaintenanceReports({ limit: 200 })
      .then(r => setRows(r.reports))
      .catch(err => { console.error('[equipment] maintenance:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  // Resolved name maps for use in cell renderers — computed once per
  // (rows, namesById) change rather than per cell render.
  const resolvedRows = useMemo(() => rows.map(r => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const embedded = r as any;
    const driverLabel = embedded.driverName as string | undefined
      ?? resolveDriverName(r.driverId, r.submittedBy, driverNameById);
    const equipmentLabel = (embedded.assetName as string | undefined)
      ?? (embedded.trailerName ? `Trailer ${embedded.trailerName}` : undefined)
      ?? resolveEquipmentLabel(r.assetId, r.trailerId, assetLabelById, trailerLabelById);
    return { ...r, _driverLabel: driverLabel, _equipmentLabel: equipmentLabel };
  }), [rows, driverNameById, assetLabelById, trailerLabelById]);

  type R = typeof resolvedRows[number];

  const columns: OpsColumn<R>[] = [
    { key: 'reportedAt', header: 'Date', width: 120, sortable: true,
      render: r => <OpsDate iso={r.reportedAt} /> },
    { key: '_driverLabel', header: 'Driver', sortable: true,
      render: r => r._driverLabel },
    { key: '_equipmentLabel', header: 'Equipment', sortable: true,
      render: r => r._equipmentLabel },
    { key: 'description', header: 'Description', width: '2fr',
      render: r => <span>{r.description.length > 90 ? r.description.slice(0, 90) + '…' : r.description}</span> },
    { key: 'status', header: 'Status', width: 110, sortable: true,
      sortValue: r => r.status,
      render: r => {
        const color: 'amber' | 'blue' | 'gray' | 'green' =
          r.status === 'open'      ? 'amber' :
          r.status === 'reviewed'  ? 'blue'  :
          r.status === 'converted' ? 'green' :
                                     'gray';   // dismissed
        return <OpsPill color={color}>{r.status}</OpsPill>;
      } },
    // Convert action column — only renders the button on
    // not-yet-converted rows. Once converted, the row's status pill
    // already says 'converted' and clicking the action button on it
    // would just trigger an "already converted" 409 from the API.
    ...(onConvertClick ? [{
      key: '_convert',
      header: '',
      width: 100,
      render: (r: R) => r.status === 'converted'
        ? null
        : (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onConvertClick(r); }}
            className="rounded-md text-[11px] font-semibold transition-colors"
            style={{
              background: 'var(--gc-surface)',
              color:      'var(--gc-blue)',
              border:     '1px solid var(--gc-blue-light)',
              padding:    '3px 8px',
              cursor:     'pointer',
            }}>
            Convert →
          </button>
        ),
    }] : []),
  ];

  const filters: OpsFilter<R>[] = [
    { kind: 'search', placeholder: 'Search driver, equipment, description…',
      match: (r, q) => r._driverLabel.toLowerCase().includes(q)
                    || r._equipmentLabel.toLowerCase().includes(q)
                    || r.description.toLowerCase().includes(q) },
    { kind: 'select', key: 'driver',    label: 'Driver',
      options: buildDriverOptions(drivers),
      predicate: (r, v) => String(r.driverId) === v },
    { kind: 'select', key: 'equipment', label: 'Equipment',
      options: buildEquipmentOptions(assets, trailers),
      predicate: (r, v) => matchesEquipment(v, r.assetId, r.trailerId) },
    { kind: 'select', key: 'status',    label: 'Status',
      options: [
        { value: 'open',      label: 'Open' },
        { value: 'reviewed',  label: 'Reviewed' },
        { value: 'converted', label: 'Converted' },
        { value: 'dismissed', label: 'Dismissed' },
      ],
      predicate: (r, v) => r.status === v },
  ];

  return (
    <OpsTable
      columns={columns}
      data={resolvedRows}
      filters={filters}
      loading={loading}
      rowKey={r => r.id}
      onRowClick={r => onOpen(r)}
      activeRowId={openId}
      emptyLabel="No maintenance reports match the current filters."
      defaultSort={{ key: 'reportedAt', dir: 'desc' }}
      density="comfortable"
      countLabel="report"
    />
  );
}

// ─── Inspections ──────────────────────────────────────────────────────

/**
 * InspectionsTabContent — view switcher between the per-truck weekly
 * Calendar and the flat List. Both share the same parent props (driver
 * + asset + trailer fixtures, plus an onOpen callback to surface a row
 * in the right-side detail panel) so the user can flip between them
 * without losing the open record. Calendar is the default because the
 * dispatcher's most common question is "did each truck get inspected
 * today?" which is naturally a coverage grid.
 */
function InspectionsTabContent({
  drivers, assets, trailers, onOpen, openId,
}: {
  drivers: Driver[];
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  onOpen: (r: InspectionRow) => void;
  openId: string | null;
}) {
  const [view, setView] = useState<'calendar' | 'list'>('calendar');

  const toggleBtn = (key: 'calendar' | 'list', icon: React.ReactNode, label: string) => {
    const active = view === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => setView(key)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[12px] font-extrabold uppercase tracking-wider transition-colors"
        style={{
          background: active ? 'var(--gc-blue)' : 'transparent',
          color:      active ? '#fff' : 'var(--gc-text-2)',
          textShadow: active ? '0 1px 1px rgba(0,0,0,0.25)' : undefined,
        }}>
        {icon}{label}
      </button>
    );
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        <div className="flex items-center gap-0.5 p-0.5 rounded-full"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          {toggleBtn('calendar', <CalendarDays size={12} />, 'Week')}
          {toggleBtn('list',     <ListIcon     size={12} />, 'List')}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {view === 'calendar' && (
          <InspectionsCalendar
            assets={assets}
            onOpen={onOpen}
            openId={openId}
          />
        )}
        {view === 'list' && (
          <InspectionsList
            drivers={drivers}
            assets={assets}
            trailers={trailers}
            onOpen={onOpen}
            openId={openId}
          />
        )}
      </div>
    </div>
  );
}

/** Date helpers — day-precision string keys (YYYY-MM-DD). `ymdKey`
 *  pulls the local-tz date off a JS Date for the calendar's own
 *  week-stepping arithmetic; `ymdInTz` formats any UTC ISO timestamp
 *  as a YYYY-MM-DD in a specific IANA timezone, which is how we
 *  decide which day's cell an inspection belongs in.
 *
 *  The latter is the load-bearing piece: the API returns submittedAt
 *  as a UTC ISO string, but a driver submitting at 8:55pm Tuesday
 *  Eastern (= 12:55am Wednesday UTC) needs to land on Tuesday's
 *  column. en-CA's `2026-05-27`-style date format is the cheap way
 *  to get YYYY-MM-DD out of Intl.DateTimeFormat. */
function ymdKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function ymdInTz(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit',
    }).format(new Date(iso));
  } catch {
    // Bad tz (typo / missing in browser's ICU data) — fall back to
    // the JS-local date so the calendar still renders something
    // useful instead of throwing.
    return ymdKey(new Date(iso));
  }
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
/** Saturday of the work week containing `d`. JS uses Sun=0..Sat=6;
 *  the offset back to Saturday is (dow + 1) % 7. */
function weekStartSat(d: Date): Date {
  const dow  = d.getDay();
  const diff = (dow + 1) % 7;
  const out  = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - diff);
  return out;
}
const DAY_LABELS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

/**
 * InspectionsCalendar — Saturday-through-Friday work-week grid of
 * inspection coverage per truck.
 *
 * Each row is one active truck (assets, sorted by sortOrder, retired
 * trucks excluded — they're history). Each column is one weekday.
 *
 * A cell shows the aggregate status of every inspection submitted for
 * that truck on that day:
 *   - empty / em-dash → no inspection submitted
 *   - green           → 1+ inspections, all clear
 *   - red             → 1+ inspections, at least one had defects
 * Multi-inspection days get a small "×N" badge so the count is
 * obvious without hover.
 *
 * Click behavior:
 *   - 1 inspection on the day → opens that report in the right-side
 *     detail panel (same onOpen the list view uses)
 *   - 2+ inspections           → opens an inline popover listing each
 *     submission with its time + defect count; clicking a row in the
 *     popover opens that specific report
 *
 * Fetches `/v1/inspection-reports?from&to` scoped to the visible week
 * (limit 500, way more than any single fleet would hit in a week). Re-
 * fetches when the visible week changes.
 */
function InspectionsCalendar({
  assets, onOpen, openId,
}: {
  assets: Asset[];
  onOpen: (r: InspectionRow) => void;
  openId: string | null;
}) {
  // Org's chosen calendar timezone. Drives ALL day-bucketing — we
  // convert each inspection's submitted_at (a UTC ISO string) to a
  // YYYY-MM-DD in this tz before slotting it into a cell. That makes
  // an 8:55pm Tuesday submission land on Tuesday's cell even if the
  // server's stored inspection_date was off-by-one (the legacy UTC
  // bug) — historical data fixes itself.
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const [anchorDate, setAnchorDate] = useState<Date>(() => new Date());
  const [rows, setRows]             = useState<InspectionRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  // Which (assetId|date) cell currently has its multi-pick popover
  // open. Stored as a composite string so only one popover is open at
  // a time (clicking another cell replaces it).
  const [openCellKey, setOpenCellKey] = useState<string | null>(null);

  // Compute the 7 days of the visible week from `anchorDate`. Pure
  // function of state so it doesn't need its own effect.
  const days = useMemo(() => {
    const sat = weekStartSat(anchorDate);
    return Array.from({ length: 7 }, (_, i) => addDays(sat, i));
  }, [anchorDate]);
  // Fetch window — widened by 1 day on each side. The API filters
  // by submitted_at (UTC), but our visible columns are in org TZ. A
  // submission late Friday-org-tz can land on Saturday UTC; without
  // the buffer it'd fall outside the [from, to) query and never
  // make it into the calendar. Client-side `byAssetDay` then trims
  // anything outside the actual 7 visible days using ymdInTz.
  const fetchFromKey = ymdKey(addDays(days[0], -1));
  const fetchToKey   = ymdKey(addDays(days[6],  2)); // exclusive upper bound — 2d ahead covers the +1 buffer day

  // Today's key for the "highlight today's column" affordance.
  const todayKey = useMemo(() => ymdKey(new Date()), []);

  // Fetch inspections for the visible window. Limit 500 is comfortably
  // above the realistic ceiling for a single Sat-Fri week (a 50-truck
  // fleet doing 2 DVIRs per truck per day = 700/week — at that scale
  // we'd add server-side pagination, but until then this is fine).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    railway.listInspectionReports({ from: fetchFromKey, to: fetchToKey, limit: 500 })
      .then(r => { if (!cancelled) setRows(r.inspections); })
      .catch(err => {
        console.error('[equipment] inspections-calendar:', err);
        if (!cancelled) {
          setRows([]);
          setError(err instanceof Error ? err.message : 'Failed to load inspections');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchFromKey, fetchToKey]);

  // Index inspections by `${assetId}|${date}` for O(1) cell lookup.
  // We derive `date` from submittedAt converted to the org's calendar
  // timezone — NOT from r.inspectionDate. The server's
  // inspection_date column was stamped using UTC for a long stretch,
  // so any submission after the driver's local ~7pm landed a day
  // late. Re-bucketing on submittedAt fixes both new rows and every
  // historical row with no app rebuild or backfill required.
  const byAssetDay = useMemo(() => {
    const m = new Map<string, InspectionRow[]>();
    for (const r of rows) {
      if (r.assetId == null) continue;
      const dayKey = ymdInTz(r.submittedAt, calendarTimezone);
      const k = `${r.assetId}|${dayKey}`;
      const arr = m.get(k);
      if (arr) arr.push(r); else m.set(k, [r]);
    }
    // Sort each bucket newest-first so the popover lists the most
    // recent submission at the top.
    for (const arr of m.values()) arr.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return m;
  }, [rows, calendarTimezone]);

  // Active (non-retired, non-hidden) trucks in dispatcher's preferred
  // order. The "Unassigned" placeholder bucket (used elsewhere in the
  // app as a column for unbooked loads) isn't a real truck — exclude
  // it explicitly the same way AssetsModal does.
  const visibleAssets = useMemo(() => {
    return [...assets]
      .filter(a => !a.activeTo && !a.hidden)
      .filter(a => a.name !== 'Unassigned' && a.type !== 'Unassigned')
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }, [assets]);

  // Header label like "Sat May 23 — Fri May 29, 2026". Year only at
  // the end so the label stays narrow.
  const weekLabel = useMemo(() => {
    const fmt = (d: Date, withYear = false) => {
      const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
      if (withYear) opts.year = 'numeric';
      return d.toLocaleDateString('en-US', opts);
    };
    return `${fmt(days[0])} — ${fmt(days[6], true)}`;
  }, [days]);

  // Aggregate status for one bucket of inspections on a given day.
  function aggregateStatus(list: InspectionRow[] | undefined): 'none' | 'clear' | 'defect' {
    if (!list || list.length === 0) return 'none';
    return list.some(r => r.hasDefects) ? 'defect' : 'clear';
  }

  function handleCellClick(assetId: number, dayKey: string, list: InspectionRow[]) {
    if (list.length === 0) return;
    if (list.length === 1) {
      onOpen(list[0]);
      setOpenCellKey(null);
      return;
    }
    const k = `${assetId}|${dayKey}`;
    setOpenCellKey(prev => prev === k ? null : k);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar — week label + prev/next/today. */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        <button type="button"
          onClick={() => setAnchorDate(d => addDays(d, -7))}
          className="p-1 rounded-lg transition-colors"
          style={{ color: 'var(--gc-text-2)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Previous week">
          <ChevronLeft size={16} />
        </button>
        <button type="button"
          onClick={() => setAnchorDate(d => addDays(d, 7))}
          className="p-1 rounded-lg transition-colors"
          style={{ color: 'var(--gc-text-2)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Next week">
          <ChevronRight size={16} />
        </button>
        <button type="button"
          onClick={() => setAnchorDate(new Date())}
          className="text-[11px] font-extrabold uppercase tracking-wider px-2.5 py-1 rounded-lg transition-colors"
          style={{ color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Jump to this week">
          Today
        </button>
        <div className="text-[13px] font-semibold ml-1" style={{ color: 'var(--gc-text-1)' }}>
          {weekLabel}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          <div className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#16a34a' }} />
            All clear
          </div>
          <div className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#dc2626' }} />
            Defect
          </div>
          {loading && <Loader2 size={11} className="animate-spin" />}
        </div>
      </div>

      {/* Body — sticky header row + one row per truck. Whole grid
          horizontally + vertically scrolls inside its track so the
          toolbar above stays put. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="px-4 py-6 text-[13px]" style={{ color: '#dc2626' }}>
            <AlertCircle size={13} className="inline mr-1" /> {error}
          </div>
        ) : visibleAssets.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            No active trucks to show.
          </div>
        ) : (
          <table className="w-full border-collapse" style={{ minWidth: 720 }}>
            <thead>
              <tr style={{ background: 'var(--gc-bg)' }}>
                <th
                  className="sticky left-0 z-10 text-left text-[11px] font-extrabold uppercase tracking-wider px-3 py-2"
                  style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)', minWidth: 160 }}>
                  Truck
                </th>
                {days.map(d => {
                  const isToday = ymdKey(d) === todayKey;
                  return (
                    <th key={ymdKey(d)}
                      className="text-center text-[12px] font-extrabold uppercase tracking-wider px-2 py-3"
                      style={{
                        color:      isToday ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                        background: isToday ? 'rgba(26,115,232,0.06)' : undefined,
                        borderBottom: '1px solid var(--gc-border-light)',
                        minWidth: 88,
                      }}>
                      <div>{DAY_LABELS[d.getDay() === 6 ? 0 : d.getDay() + 1]}</div>
                      <div className="text-[20px] font-extrabold mt-1" style={{ color: isToday ? 'var(--gc-blue)' : 'var(--gc-text-1)' }}>
                        {d.getDate()}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleAssets.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                  <td className="sticky left-0 z-10 px-3 py-3"
                    style={{ background: 'var(--gc-surface)', borderRight: '1px solid var(--gc-border-light)' }}>
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Colored chip — asset.color as background, white
                          truck inside. Mirrors the calendar's asset
                          color pills so trucks read consistently across
                          the app. */}
                      <div
                        className="flex items-center justify-center flex-shrink-0"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: a.color || 'var(--gc-text-3)',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                        }}>
                        <Truck size={20} color="#fff" strokeWidth={2.5} />
                      </div>
                      <div className="text-[15px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
                        {a.name}
                      </div>
                    </div>
                  </td>
                  {days.map(d => {
                    const dayKey = ymdKey(d);
                    const list   = byAssetDay.get(`${a.id}|${dayKey}`) ?? [];
                    const status = aggregateStatus(list);
                    const isOpenHere = openCellKey === `${a.id}|${dayKey}`;
                    const isToday    = dayKey === todayKey;
                    const isSelected = list.some(r => r.id === openId);
                    return (
                      <td key={dayKey}
                        className="text-center align-middle"
                        style={{
                          padding: 0,
                          background: isToday ? 'rgba(26,115,232,0.04)' : undefined,
                          position: 'relative',
                        }}>
                        <CalendarCell
                          status={status}
                          count={list.length}
                          selected={isSelected}
                          onClick={() => handleCellClick(a.id, dayKey, list)}
                        />
                        {/* Multi-inspection picker popover. Anchored
                            to the cell via absolute positioning so it
                            doesn't reflow the grid. */}
                        {isOpenHere && list.length > 1 && (
                          <InspectionPickerPopover
                            list={list}
                            onPick={r => { onOpen(r); setOpenCellKey(null); }}
                            onClose={() => setOpenCellKey(null)}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** One cell in the inspections grid. Status drives a filled chip:
 *  - clear  → light-green chip with bold green check (Google-y),
 *             tinted #34a853-family
 *  - defect → light-red chip with bold red alert, tinted #ea4335-family
 *  - none   → quiet em-dash so empty days fade into the background
 *
 *  Counts > 1 render as a small circular badge in the top-right corner
 *  of the chip — same visual idiom as iOS app-icon badges. Pure-
 *  presentational; click routing lives in the parent. */
function CalendarCell({
  status, count, selected, onClick,
}: {
  status: 'none' | 'clear' | 'defect';
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  const interactive = status !== 'none';

  // Google palette — chip background is the light tint, icon + badge
  // are the saturated production color. Saturation reads loud at a
  // distance which is the whole point of the coverage grid.
  const palette = status === 'clear'
    ? { chipBg: '#e6f4ea', icon: '#1e8e3e', badgeBg: '#1e8e3e' }
    : status === 'defect'
    ? { chipBg: '#fce8e6', icon: '#d93025', badgeBg: '#d93025' }
    : null;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      className="flex items-center justify-center w-full h-full transition-colors"
      style={{
        minHeight: 60,
        padding:   '8px 6px',
        cursor:    interactive ? 'pointer' : 'default',
        background: selected ? 'var(--gc-blue-light)' : 'transparent',
        border: 'none',
        outline: selected ? '2px solid var(--gc-blue)' : undefined,
        outlineOffset: selected ? '-2px' : undefined,
      }}
      onMouseEnter={e => { if (interactive && !selected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
      title={
        status === 'none'   ? 'No inspection'
      : status === 'clear'  ? (count > 1 ? `${count} inspections — all clear` : 'All clear')
      :                       (count > 1 ? `${count} inspections — defects logged` : 'Defects logged')
      }>
      {status === 'none' ? (
        <span className="text-[18px]" style={{ color: 'var(--gc-text-3)', opacity: 0.5 }}>—</span>
      ) : (
        <div
          className="relative flex items-center justify-center"
          style={{
            width:        40,
            height:       40,
            borderRadius: 12,
            background:   palette!.chipBg,
            boxShadow:    '0 1px 2px rgba(0,0,0,0.06)',
          }}>
          {status === 'clear'
            ? <CheckCircle2 size={22} color={palette!.icon} strokeWidth={2.5} />
            : <AlertCircle  size={22} color={palette!.icon} strokeWidth={2.5} />}
          {count > 1 && (
            <span
              className="absolute flex items-center justify-center text-[10px] font-extrabold"
              style={{
                top:        -4,
                right:      -6,
                minWidth:   18,
                height:     18,
                padding:    '0 4px',
                borderRadius: 9,
                background: palette!.badgeBg,
                color:      '#fff',
                border:     '2px solid var(--gc-surface)',
                boxShadow:  '0 1px 2px rgba(0,0,0,0.18)',
              }}>
              {count}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/** Popover for days that have 2+ inspections — lets the dispatcher
 *  pick which submission to open. Closes on outside click via the
 *  parent's openCellKey state; we just render and emit events. */
function InspectionPickerPopover({
  list, onPick, onClose,
}: {
  list: InspectionRow[];
  onPick: (r: InspectionRow) => void;
  onClose: () => void;
}) {
  // Close on Escape and on click outside (the latter via a
  // backdrop layer so we don't fight the cell's own click handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* Transparent backdrop captures outside-clicks; sits below the
          popover but above everything else so wider page UI doesn't
          eat the click. */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 50, background: 'transparent',
        }}
      />
      <div
        onClick={e => e.stopPropagation()}
        className="rounded-lg shadow-lg"
        style={{
          position: 'absolute',
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 51,
          background: 'var(--gc-surface)',
          border: '1px solid var(--gc-border)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          minWidth: 240,
          marginTop: 4,
          padding: 4,
        }}>
        <div className="text-[10px] font-bold uppercase tracking-wider px-2 py-1.5"
          style={{ color: 'var(--gc-text-3)' }}>
          {list.length} inspections
        </div>
        {list.map(r => {
          const time = new Date(r.submittedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          // Subtitle reads as "Pablo Bernal — 1 defect" or "Julio
          // Bello — All Clear". Item count was technically true info
          // but noisy: dispatchers care about pass/fail, not the
          // raw checklist length.
          const statusText = r.hasDefects
            ? `${r.defectCount} defect${r.defectCount === 1 ? '' : 's'}`
            : 'All Clear';
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onPick(r)}
              className="w-full flex items-center gap-2 text-left px-2 py-2 rounded transition-colors"
              style={{ background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              {r.hasDefects
                ? <AlertCircle size={14} style={{ color: '#d93025', flexShrink: 0 }} />
                : <CheckCircle2 size={14} style={{ color: '#1e8e3e', flexShrink: 0 }} />}
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
                  {r.driverName} — {statusText}
                </div>
                <div className="text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                  {time}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function InspectionsList({
  drivers, assets, trailers, onOpen, openId,
}: {
  drivers: Driver[];
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string; category: string }>;
  onOpen: (r: InspectionRow) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<InspectionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    railway.listInspectionReports({ limit: 200 })
      .then(r => setRows(r.inspections))
      .catch(err => { console.error('[equipment] inspections:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  const columns: OpsColumn<InspectionRow>[] = [
    { key: 'submittedAt', header: 'Date', width: 120, sortable: true,
      render: r => <OpsDate iso={r.submittedAt} /> },
    { key: 'driverName', header: 'Driver', sortable: true,
      render: r => r.driverName },
    { key: 'equipment', header: 'Equipment',
      sortValue: r => equipmentLabel(r.assetName, r.trailerName),
      render: r => equipmentLabel(r.assetName, r.trailerName) },
    { key: 'items', header: 'Items', width: 160,
      render: r => r.hasDefects
        ? <OpsPill color="red">{r.defectCount} defect{r.defectCount === 1 ? '' : 's'}</OpsPill>
        : <span className="text-[12px]" style={{ color: '#16a34a' }}>✓ All clear ({r.itemCount})</span>,
    },
    { key: 'photos', header: 'Photos', width: 90,
      sortValue: r => r.photoCount,
      render: r => r.photoCount > 0
        ? <OpsPill color="blue">{r.photoCount}</OpsPill>
        : <OpsMuted />,
    },
  ];

  const filters: OpsFilter<InspectionRow>[] = [
    { kind: 'search', placeholder: 'Search driver or equipment…',
      match: (r, q) => r.driverName.toLowerCase().includes(q)
                    || (r.assetName ?? '').toLowerCase().includes(q)
                    || (r.trailerName ?? '').toLowerCase().includes(q) },
    { kind: 'select', key: 'driver',    label: 'Driver',
      options: buildDriverOptions(drivers),
      predicate: (r, v) => String(r.driverId) === v },
    { kind: 'select', key: 'equipment', label: 'Equipment',
      options: buildEquipmentOptions(assets, trailers),
      predicate: (r, v) => matchesEquipment(v, r.assetId ?? undefined, r.trailerId ?? undefined) },
    { kind: 'select', key: 'defects',   label: 'Show',
      options: [
        { value: 'with_defects', label: 'With defects' },
        { value: 'all_clear',    label: 'All clear' },
      ],
      predicate: (r, v) => v === 'with_defects' ? r.hasDefects : !r.hasDefects },
  ];

  return (
    <OpsTable
      columns={columns}
      data={rows}
      filters={filters}
      loading={loading}
      rowKey={r => r.id}
      onRowClick={r => onOpen(r)}
      activeRowId={openId}
      emptyLabel="No inspections match the current filters."
      defaultSort={{ key: 'submittedAt', dir: 'desc' }}
      density="comfortable"
      countLabel="inspection"
    />
  );
}

// ─── Fuel tab content — unified table ────────────────────────────────
//
// Modeled on Matt's my-calendar/fuel.html: one table that lists every
// fuel-up, where a matched card-transaction + driver-report pair
// collapses to a single row and stand-alone rows carry a source/
// status badge.
//
// Data shape:
//   • Fetch fuel_reports (driver-submitted) and fuel_transactions
//     (card receipts) in parallel.
//   • For each transaction → one row. If transaction.fuelReportId is
//     set, splice the matching report's data (driver_id → name, asset
//     → unit) into the row so the dispatcher sees the authoritative
//     truck/driver, not the free-text receipt printing.
//   • For each report NOT referenced by any transaction → one row.
//     That's the "Driver only" case (driver filed at the pump but no
//     receipt has arrived yet, or never will because the driver paid
//     out of pocket).
//
// Row click opens the panel for whichever side carries the richer
// info: transaction if present, else the driver report.

// Row classification — drives the Source filter chip + per-row
// badge. Semantics are dispatch-workflow oriented (what needs your
// attention), not data-shape oriented:
//
//   • matched      — transaction has a truck assigned (assetId set).
//                    Spend is attributed; no further dispatcher
//                    action required.
//   • card_only    — transaction exists but no truck assigned. The
//                    Mudflap card swiped, but the dispatcher hasn't
//                    classified it yet (or auto-resolve failed).
//                    Click in → use the dropdowns to assign.
//   • driver_only  — driver report exists but no card transaction
//                    yet (waiting on Mudflap, or driver paid out of
//                    pocket). No action — just visibility.
type FuelRowKind =
  | 'matched'
  | 'card_only'
  | 'driver_only';

type UnifiedFuelRow = {
  id:             string;              // tx.id if present, else report.id
  kind:           FuelRowKind;
  date:           string;              // ISO — sort key + display
  driverLabel:    string;
  assetLabel:     string;
  location:       string | null;
  dieselGallons:  number | null;
  defGallons:     number | null;
  totalCharged:   number | null;
  totalSaved:     number | null;
  // Underlying records — used when the row is clicked open.
  transaction:    FuelTransaction | null;
  report:         FuelReport | null;
};

function FuelTabContent({
  drivers, assets, driverNameById, assetLabelById,
  panel, setPanel, reloadVersion,
}: {
  drivers: Driver[];
  assets: Asset[];
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  panel: PanelData | null;
  setPanel: (p: PanelData | null) => void;
  /** Incrementing counter from the page — when it changes, this
   *  component refetches its data. Used so panel mutations
   *  (assign/auto-match/link/unlink) update the table immediately
   *  without the user having to close + reopen the page. */
  reloadVersion: number;
}) {
  const [transactions, setTransactions] = useState<FuelTransaction[]>([]);
  const [reports, setReports]           = useState<FuelReport[]>([]);
  const [loading, setLoading]           = useState(true);
  // Sweep button transient state: "running" while the request is
  // in flight, then a brief result toast ("Linked 3 new pairs") that
  // auto-dismisses after a few seconds.
  const [sweepBusy,   setSweepBusy]     = useState(false);
  const [sweepResult, setSweepResult]   = useState<{ matched: number; scanned: number } | null>(null);

  // Period selector — scopes both the KPI bar above and the table
  // below to the same date window. Defaults to "This Week" (Sat→Fri)
  // because fuel-up cadence is daily — the dispatcher cares most
  // about the current week's spend. Longer windows are one pill
  // click away.
  const [period, setPeriod]             = useState<Period>('week');
  const initialCustom                   = useMemo(() => defaultCustomRangeISO(), []);
  const [customStart, setCustomStart]   = useState<string>(initialCustom.start);
  const [customEnd,   setCustomEnd]     = useState<string>(initialCustom.end);
  const { start: pStart, end: pEnd } = useMemo(
    () => getPeriodRange(period, { startISO: customStart, endISO: customEnd }),
    [period, customStart, customEnd],
  );

  // Fuel fetch error banner — same cold-start trap as the page-level
  // fixtures fetch. Wrapped in fetchWithRetry so a Railway restart
  // doesn't permanently empty the table.
  const [fuelFetchError, setFuelFetchError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setFuelFetchError(null);
    try {
      // Scope both fetches to the selected period. pEnd from
      // getPeriodRange is midnight-local on the last day, so we
      // bump to end-of-day before serializing — otherwise we'd
      // miss any fuel-up that happened later that same day.
      const fromIso = pStart.toISOString();
      const endOfDay = new Date(pEnd);
      endOfDay.setHours(23, 59, 59, 999);
      const toIso = endOfDay.toISOString();
      // Both calls in parallel. listFuelTransactions takes a date
      // string for transaction_date filtering; listFuelReports takes
      // ISO timestamps for reported_at filtering.
      const fromDate = fromIso.slice(0, 10);
      const toDate   = toIso.slice(0, 10);
      const [tx, fr] = await Promise.all([
        fetchWithRetry(() => railway.listFuelTransactions({ from: fromDate, to: toDate, limit: 500 }), {
          onAttemptFailed: (err, n, willRetry) => {
            if (willRetry) console.warn(`[equipment fuel] tx attempt ${n} failed, retrying:`, err);
          },
        }),
        fetchWithRetry(() => railway.listFuelReports({ from: fromIso, to: toIso, limit: 500 }), {
          onAttemptFailed: (err, n, willRetry) => {
            if (willRetry) console.warn(`[equipment fuel] report attempt ${n} failed, retrying:`, err);
          },
        }),
      ]);
      setTransactions(tx.fuelTransactions);
      setReports(fr.fuelReports);
    } catch (err) {
      console.error('[equipment] fuel unified failed after retries:', err);
      setTransactions([]);
      setReports([]);
      setFuelFetchError('Failed to load fuel data. The API may still be starting up.');
    } finally {
      setLoading(false);
    }
  }, [pStart, pEnd]);
  useEffect(() => { void reload(); }, [reload, reloadVersion]);

  // Fire the on-demand sweep, then reload the table so new matches
  // surface. Result toast auto-dismisses; the server runs the same
  // job every 15 min anyway, the button just shortcuts the wait.
  const runSweep = useCallback(async () => {
    if (sweepBusy) return;
    setSweepBusy(true);
    setSweepResult(null);
    try {
      const r = await railway.runFuelAutoMatchSweep();
      setSweepResult({ matched: r.matched, scanned: r.scanned });
      await reload();
      setTimeout(() => setSweepResult(null), 4000);
    } catch (err) {
      console.error('[fuel auto-match sweep] failed:', err);
      setSweepResult({ matched: -1, scanned: 0 });
      setTimeout(() => setSweepResult(null), 4000);
    } finally {
      setSweepBusy(false);
    }
  }, [sweepBusy, reload]);

  // Build unified rows. Matched transactions splice their paired
  // report so authoritative driver/asset names win over the receipt's
  // free-text values. Reports that aren't referenced by any
  // transaction emit a stand-alone "driver_only" row.
  const rows: UnifiedFuelRow[] = useMemo(() => {
    const reportById = new Map<string, FuelReport>();
    for (const r of reports) reportById.set(r.id, r);

    const out: UnifiedFuelRow[] = [];
    const consumedReportIds = new Set<string>();

    for (const t of transactions) {
      const report = t.fuelReportId ? reportById.get(t.fuelReportId) ?? null : null;
      if (report) consumedReportIds.add(report.id);
      // Matched = the spend is attributed to a truck on the
      // transaction itself. That asset_id can come from:
      //   • ingest auto-resolve (matched_truck → assets.unit)
      //   • the matcher mirroring a linked fuel_report's asset
      //   • the dispatcher picking via the /assign dropdown
      // Either way the dispatcher's work is done — no further action.
      // No truck on the transaction = "card only" needs attention.
      const hasAssignedTruck = t.assetId != null
        || (report?.assetId != null); // matched-report side counts too
      const kind: FuelRowKind = hasAssignedTruck ? 'matched' : 'card_only';

      // Driver/Asset resolution chain — tries every signal we have
      // before falling back to a bare-id placeholder. Order matters:
      //   1. transaction's own driver_id/asset_id resolved → name
      //   2. matched fuel_report's driver_id/asset_id resolved → name
      //   3. embedded driver_name / asset_name from the API join
      //   4. receipt's free-text driver_name / matched_truck
      //      (readable, just not the canonical roster entry)
      //   5. "Driver #N" / "Asset #N" bare-id fallback — only when
      //      none of the above pan out, e.g. the linked driver was
      //      hard-deleted from the org
      //   6. "—" so the cell never renders blank
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reportEmbedded = report as any;
      const resolvedDriverName =
        (t.driverId != null ? driverNameById.get(t.driverId) : undefined)
        ?? (report?.driverId != null ? driverNameById.get(report.driverId) : undefined)
        ?? (reportEmbedded?.driverName as string | undefined);
      const driverLabel: string =
        resolvedDriverName
        ?? t.driverName                                                  // receipt text — readable fallback
        ?? (report?.driverId != null ? `Driver #${report.driverId}` : undefined)
        ?? (t.driverId      != null ? `Driver #${t.driverId}`       : undefined)
        ?? '—';
      const resolvedAssetName =
        (t.assetId != null ? assetLabelById.get(t.assetId) : undefined)
        ?? (report?.assetId != null ? assetLabelById.get(report.assetId) : undefined)
        ?? (reportEmbedded?.assetName as string | undefined);
      const assetLabel: string =
        resolvedAssetName
        ?? (t.matchedTruck ? `#${t.matchedTruck}` : undefined)           // receipt text — readable fallback
        ?? (report?.assetId != null ? `Asset #${report.assetId}` : undefined)
        ?? (t.assetId       != null ? `Asset #${t.assetId}`       : undefined)
        ?? '—';

      out.push({
        id:            t.id,
        kind,
        date:          report?.reportedAt ?? `${t.transactionDate}T12:00:00Z`,
        driverLabel,
        assetLabel,
        location:      t.location ?? null,
        dieselGallons: t.dieselGallons ?? report?.dieselGallons ?? null,
        defGallons:    t.defGallons ?? report?.defGallons ?? null,
        totalCharged:  t.totalCharged ?? null,
        totalSaved:    t.totalSaved ?? null,
        transaction:   t,
        report,
      });
    }

    for (const r of reports) {
      if (consumedReportIds.has(r.id)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const embedded = r as any;
      const driverLabel = embedded.driverName as string | undefined
        ?? resolveDriverName(r.driverId, r.submittedBy, driverNameById);
      const assetLabel = embedded.assetName as string | undefined
        ?? assetLabelById.get(r.assetId)
        ?? `Asset #${r.assetId}`;
      out.push({
        id:            r.id,
        kind:          'driver_only',
        date:          r.reportedAt,
        driverLabel,
        assetLabel,
        location:      null,
        dieselGallons: r.dieselGallons,
        defGallons:    r.defGallons ?? null,
        totalCharged:  null,
        totalSaved:    null,
        transaction:   null,
        report:        r,
      });
    }
    return out;
  }, [transactions, reports, driverNameById, assetLabelById]);

  const counts = useMemo(() => ({
    matched:     rows.filter(r => r.kind === 'matched').length,
    card_only:   rows.filter(r => r.kind === 'card_only').length,
    driver_only: rows.filter(r => r.kind === 'driver_only').length,
  }), [rows]);

  const openId = panel?.kind === 'fuel' ? panel.id : null;

  const columns: OpsColumn<UnifiedFuelRow>[] = [
    { key: 'date',         header: 'Date',       width: 110, sortable: true,
      render: r => <OpsDate iso={r.date} /> },
    { key: 'driverLabel',  header: 'Driver',     sortable: true,
      render: r => r.driverLabel || <OpsMuted /> },
    { key: 'assetLabel',   header: 'Truck',      width: 140, sortable: true,
      render: r => r.assetLabel || <OpsMuted /> },
    { key: 'location',     header: 'Location',   width: '1.4fr',
      render: r => r.location
        ? <span title={r.location}>{r.location}</span>
        : <OpsMuted /> },
    { key: 'dieselGallons', header: 'Diesel gal', width: 110, align: 'right', sortable: true,
      sortValue: r => r.dieselGallons ?? -1,
      render: r => <span className="font-mono">{r.dieselGallons != null ? r.dieselGallons.toFixed(1) : '—'}</span> },
    { key: 'defGallons',   header: 'DEF gal',    width: 90,  align: 'right', sortable: true,
      sortValue: r => r.defGallons ?? -1,
      render: r => <span className="font-mono">{r.defGallons != null && r.defGallons > 0 ? r.defGallons.toFixed(1) : '—'}</span> },
    { key: 'totalCharged', header: 'Total',      width: 100, align: 'right', sortable: true,
      sortValue: r => r.totalCharged ?? -1,
      render: r => <span className="font-mono">{r.totalCharged != null ? `$${r.totalCharged.toFixed(2)}` : '—'}</span> },
    { key: 'source',       header: 'Source',     width: 130,
      sortValue: r => r.kind,
      render: r => <SourceBadge kind={r.kind} transaction={r.transaction} /> },
  ];

  const filters: OpsFilter<UnifiedFuelRow>[] = [
    { kind: 'search', placeholder: 'Search driver, truck, location…',
      match: (r, q) => r.driverLabel.toLowerCase().includes(q)
                    || r.assetLabel.toLowerCase().includes(q)
                    || (r.location ?? '').toLowerCase().includes(q) },
    { kind: 'select', key: 'source', label: 'Source',
      options: [
        { value: 'matched',     label: 'Matched', count: counts.matched },
        { value: 'card_only',   label: 'Card',    count: counts.card_only },
        { value: 'driver_only', label: 'Driver',  count: counts.driver_only },
      ],
      predicate: (r, v) => r.kind === v },
    { kind: 'select', key: 'driver', label: 'Driver',
      options: buildDriverOptions(drivers),
      predicate: (r, v) => {
        const n = Number(v);
        return r.report?.driverId === n || r.transaction?.driverId === n;
      } },
    { kind: 'select', key: 'asset',  label: 'Truck',
      options: [...assets]
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
        .map(a => ({ value: String(a.id), label: `Truck ${a.name}${a.unit ? ` #${a.unit}` : ''}` })),
      predicate: (r, v) => {
        const n = Number(v);
        return r.report?.assetId === n || r.transaction?.assetId === n;
      } },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Period selector — right-aligned like the dashboard so the
          page title (which we don't render here, the tab strip plays
          that role) and the date range sit on opposite sides of the
          visual hierarchy. */}
      <div className="flex justify-end">
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
        />
      </div>
      {fuelFetchError && (
        <div
          className="rounded-lg flex items-center justify-between gap-3 px-4 py-2.5"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
          }}>
          <div className="text-[13px]">
            <strong>{fuelFetchError}</strong>
            {' '}Click retry once it&apos;s back up.
          </div>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="rounded-md text-[12px] font-semibold transition-colors"
            style={{
              background: '#fff',
              color: '#991b1b',
              border: '1px solid #fecaca',
              padding: '5px 12px',
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}>
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      <FuelKpiBar
        transactions={transactions}
        reports={reports}
        assets={assets}
        loading={loading}
      />
      <OpsTable
      columns={columns}
      data={rows}
      filters={filters}
      loading={loading}
      rowKey={r => r.id}
      onRowClick={r => {
        // One panel for both sides. Whatever the row has (transaction,
        // report, or both) gets passed through; the panel renders the
        // single unified view of the fuel-up.
        setPanel({
          kind:        'fuel',
          id:          r.transaction?.id ?? r.report?.id ?? r.id,
          transaction: r.transaction,
          report:      r.report,
        });
      }}
      activeRowId={openId}
      emptyLabel="No fuel activity matches the current filters."
      defaultSort={{ key: 'date', dir: 'desc' }}
      density="compact"
      countLabel="fuel-up"
      toolbarRight={
        <div className="flex items-center gap-2">
          {sweepResult && (
            <span className="text-[12px] font-medium" style={{
              color: sweepResult.matched < 0 ? '#dc2626'
                   : sweepResult.matched > 0 ? '#166534'
                   : 'var(--gc-text-3)',
            }}>
              {sweepResult.matched < 0
                ? 'Sweep failed — try again'
                : sweepResult.matched === 0
                  ? `Scanned ${sweepResult.scanned}, no new matches`
                  : `Linked ${sweepResult.matched} new pair${sweepResult.matched === 1 ? '' : 's'}`}
            </span>
          )}
          <button
            type="button"
            onClick={runSweep}
            disabled={sweepBusy}
            className="rounded-md transition-colors"
            style={{
              background: sweepBusy ? 'var(--gc-bg)' : 'var(--gc-blue)',
              color:      sweepBusy ? 'var(--gc-text-3)' : '#fff',
              border:     `1px solid ${sweepBusy ? 'var(--gc-border-light)' : 'var(--gc-blue)'}`,
              padding:    '7px 12px',
              fontSize:   13,
              fontWeight: 600,
              cursor:     sweepBusy ? 'default' : 'pointer',
            }}
            title="Re-run the matcher across the last 24h of unmatched card transactions. Server also runs this every 15 min automatically.">
            {sweepBusy ? 'Matching…' : 'Run auto-match'}
          </button>
        </div>
      }
    />
    </div>
  );
}

// ─── Fuel KPI bar ───────────────────────────────────────────────────
//
// Sits above the fuel table. Same four numbers + spend-by-truck bar
// list that used to live as a separate "Fuel" view on /dashboard,
// now collocated with the table so the dispatcher sees aggregate
// spend and the line items together.
//
// Driven by the same transactions/reports state the table uses — no
// extra fetch, no separate period picker. Aggregates over whatever
// the table currently shows.

function FuelKpiBar({
  transactions, reports, assets, loading,
}: {
  transactions: FuelTransaction[];
  reports: FuelReport[];
  assets: Asset[];
  loading: boolean;
}) {
  // For attribution: transactions can carry asset_id directly OR
  // resolve through their linked fuel_report. We prefer the direct
  // asset_id (newer flow); fall back to the report's asset_id when
  // only the link is present.
  const reportToAssetId = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) m.set(r.id, r.assetId);
    return m;
  }, [reports]);

  const kpis = useMemo(() => {
    let spend = 0;
    let diesel = 0;
    let def = 0;
    let dieselSpend = 0;
    for (const t of transactions) {
      spend       += t.totalCharged;
      diesel      += t.dieselGallons ?? 0;
      def         += t.defGallons ?? 0;
      dieselSpend += t.dieselTotal ?? (t.dieselDiscountPrice != null && t.dieselGallons != null
        ? t.dieselDiscountPrice * t.dieselGallons
        : 0);
    }
    // Avg $/gal — use diesel-specific spend when we have it (more
    // accurate than total/total-gallons which mixes DEF), else fall
    // back to total ÷ all gallons.
    const totalGallons = diesel + def;
    const avgPerGal = dieselSpend > 0 && diesel > 0
      ? dieselSpend / diesel
      : (totalGallons > 0 ? spend / totalGallons : 0);
    return {
      spend, diesel, def, totalGallons,
      avgPerGal,
      txnCount: transactions.length,
    };
  }, [transactions]);

  // Per-asset breakdown. Resolution chain for each transaction's asset:
  //   1. transaction.assetId (new column)
  //   2. linked fuel_report's asset_id
  //   3. 'unattributed'
  const spendByAsset = useMemo(() => {
    const acc = new Map<number | 'unattributed', { spend: number; gallons: number }>();
    for (const t of transactions) {
      const assetId = t.assetId
        ?? (t.fuelReportId ? reportToAssetId.get(t.fuelReportId) ?? null : null);
      const key: number | 'unattributed' = assetId ?? 'unattributed';
      const cur = acc.get(key) ?? { spend: 0, gallons: 0 };
      cur.spend   += t.totalCharged;
      cur.gallons += (t.dieselGallons ?? 0) + (t.defGallons ?? 0);
      acc.set(key, cur);
    }
    const assetById = new Map<number, Asset>();
    for (const a of assets) assetById.set(a.id, a);
    const rows: Array<{ asset: Asset; spend: number; gallons: number }> = [];
    for (const [key, stats] of acc) {
      if (key === 'unattributed') continue;
      const asset = assetById.get(key);
      if (!asset) continue;
      if (stats.spend === 0 && stats.gallons === 0) continue;
      rows.push({ asset, spend: stats.spend, gallons: stats.gallons });
    }
    rows.sort((a, b) => b.spend - a.spend);
    const unattributed = acc.get('unattributed');
    return {
      rows,
      unattributed: unattributed && (unattributed.spend > 0 || unattributed.gallons > 0)
        ? unattributed
        : null,
    };
  }, [transactions, reportToAssetId, assets]);

  const maxAssetSpend = useMemo(() => {
    return Math.max(
      ...spendByAsset.rows.map(r => r.spend),
      spendByAsset.unattributed?.spend ?? 0,
      1,
    );
  }, [spendByAsset]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (transactions.length === 0) {
    return null; // No fuel data → the table's empty state covers it; no KPI bar shown
  }

  const fmtMoney = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  return (
    <div className="flex flex-col gap-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile
          label="Total fuel spend"
          value={fmtMoney(kpis.spend)}
          unit={`${kpis.txnCount} transaction${kpis.txnCount === 1 ? '' : 's'}`}
        />
        <KpiTile
          label="Diesel gallons"
          value={kpis.diesel > 0 ? kpis.diesel.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—'}
          unit={kpis.diesel > 0 ? 'gal' : undefined}
        />
        <KpiTile
          label="Avg $/gallon"
          value={kpis.avgPerGal > 0 ? `$${kpis.avgPerGal.toFixed(3)}` : '—'}
          unit="diesel only"
        />
        <KpiTile
          label="DEF gallons"
          value={kpis.def > 0 ? kpis.def.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—'}
          unit={kpis.def > 0 ? 'gal' : undefined}
        />
      </div>

      {/* Spend by truck. Rendered inline (not in a card) to stay
          visually flat with the rest of the equipment page. */}
      {(spendByAsset.rows.length > 0 || spendByAsset.unattributed) && (
        <div
          className="rounded-lg px-4 py-3"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          <div className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--gc-text-3)' }}>
            Fuel spend by truck
          </div>
          <div className="flex flex-col gap-2">
            {spendByAsset.rows.map(({ asset, spend, gallons }) => {
              const pct = (spend / maxAssetSpend) * 100;
              const label = asset.unit ? `#${asset.unit} · ${asset.name}` : asset.name;
              return (
                <div key={asset.id} className="flex items-center gap-3">
                  <div
                    className="shrink-0 text-[12.5px] truncate font-medium"
                    style={{ color: 'var(--gc-text-1)', width: 140 }}
                    title={label}>
                    {label}
                  </div>
                  <div className="flex-1 h-4 relative flex items-center">
                    <div className="absolute rounded"
                      style={{
                        width:     `${pct}%`,
                        height:    6,
                        background: asset.color || 'var(--gc-blue)',
                        top:       '50%',
                        transform: 'translateY(-50%)',
                        minWidth:  spend > 0 ? 3 : 0,
                      }} />
                  </div>
                  <div className="text-[12.5px] font-semibold tabular-nums shrink-0 text-right" style={{ color: 'var(--gc-text-1)', minWidth: 72 }}>
                    {fmtMoney(spend)}
                  </div>
                  <div className="text-[11px] tabular-nums shrink-0 text-right" style={{ color: 'var(--gc-text-3)', minWidth: 64 }}>
                    {gallons.toFixed(1)} gal
                  </div>
                </div>
              );
            })}
            {spendByAsset.unattributed && (
              <div className="flex items-center gap-3 pt-2 mt-1"
                style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
                <div
                  className="shrink-0 text-[12.5px] truncate font-medium italic"
                  style={{ color: 'var(--gc-text-3)', width: 140 }}
                  title="Card transactions not linked to a driver or truck — assign them via the panel">
                  Unattributed
                </div>
                <div className="flex-1 h-4 relative flex items-center">
                  <div className="absolute rounded"
                    style={{
                      width:     `${(spendByAsset.unattributed.spend / maxAssetSpend) * 100}%`,
                      height:    6,
                      background: '#9ca3af',
                      top:       '50%',
                      transform: 'translateY(-50%)',
                      minWidth:  3,
                    }} />
                </div>
                <div className="text-[12.5px] font-semibold tabular-nums shrink-0 text-right" style={{ color: 'var(--gc-text-1)', minWidth: 72 }}>
                  {fmtMoney(spendByAsset.unattributed.spend)}
                </div>
                <div className="text-[11px] tabular-nums shrink-0 text-right" style={{ color: 'var(--gc-text-3)', minWidth: 64 }}>
                  {spendByAsset.unattributed.gallons.toFixed(1)} gal
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// One source-of-truth badge per row. Matched = truck is attributed;
// Card = transaction needs attribution; Driver = waiting on receipt.
function SourceBadge({
  kind,
}: {
  kind: FuelRowKind;
  // Kept for backwards-compat with the column-def signature even
  // though we no longer split matched by auto/manual at the badge
  // level (dispatcher cares about "is it attributed?", not "which
  // path got it there"). The granular auto/manual breakdown still
  // shows inside the detail panel via MatchStatusPill.
  transaction?: FuelTransaction | null;
}) {
  if (kind === 'matched')     return <OpsPill color="green">Matched</OpsPill>;
  if (kind === 'card_only')   return <OpsPill color="amber">Card</OpsPill>;
  return <OpsPill color="purple">Driver</OpsPill>;
}

// Granular transaction match-status pill — used inside the open
// transaction detail panel (where the unified table's SourceBadge
// would be too coarse: the panel cares about auto vs manual vs no-
// match-needed, and the confidence score). The unified table
// itself uses SourceBadge instead.
function MatchStatusPill({
  status, confidence,
}: {
  status: FuelTransaction['matchStatus'];
  confidence?: number;
}) {
  const tint =
    status === 'auto_matched'     ? { bg: '#dcfce7', fg: '#166534', label: `Auto${confidence ? ` ${confidence}` : ''}` } :
    status === 'manual_matched'   ? { bg: '#dbeafe', fg: '#1d4ed8', label: 'Manual' } :
    status === 'no_match_needed'  ? { bg: '#f3f4f6', fg: '#4b5563', label: 'No match' } :
                                    { bg: '#fef3c7', fg: '#92400e', label: 'Unmatched' };
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-wider"
      style={{ background: tint.bg, color: tint.fg }}>
      {tint.label}
    </span>
  );
}

// ─── Detail-panel helpers ─────────────────────────────────────────────
// These are used inside the still-bespoke DetailPanel JSX (not the
// list — the list uses OpsMuted/OpsPill from the OpsTable primitive).
// Kept local because the detail panel will eventually want its own
// design pass too; folding these into OpsTable now would couple
// concerns prematurely.

function Muted({ children = '—' }: { children?: React.ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)' }}>{children}</span>;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    open:      { bg: '#fef3c7', fg: '#92400e' },
    reviewed:  { bg: '#dbeafe', fg: '#1e40af' },
    dismissed: { bg: '#f3f4f6', fg: '#374151' },
    converted: { bg: '#d1fae5', fg: '#065f46' },
  };
  const p = map[status] ?? { bg: '#f3f4f6', fg: '#374151' };
  return (
    <span className="inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded"
      style={{ background: p.bg, color: p.fg }}>
      {status.replace('_', ' ')}
    </span>
  );
}

// ─── Centered detail panel ───────────────────────────────────────────
//
// Styled to match MovementDetailPanel from the calendar so the panels
// across the app read as one design language: 780×660 light surface,
// rounded-2xl, dimmed backdrop, header with a colored category dot +
// title + close button, scrollable body with field grid + map +
// photos. Portal to document.body to escape any transformed ancestor
// containing block.

function DetailPanel({
  panel, drivers, assets, driverNameById, assetLabelById, trailerLabelById,
  sideMedia, onFuelMutation, onClose, onOpenMedia, onCloseSideMedia,
}: {
  panel: PanelData;
  drivers: Driver[];
  assets: Asset[];
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  sideMedia: MediaList | null;
  /** Called whenever a panel action mutates fuel data — triggers
   *  the FuelTabContent to refetch so the table behind the modal
   *  reflects the new state without a page reload. */
  onFuelMutation: () => void;
  onClose: () => void;
  onOpenMedia: (list: MediaList) => void;
  onCloseSideMedia: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc closes the media side panel first (one Esc per layer)
        // — keeps the main report panel open so the dispatcher can
        // close the photos without losing their place in the report.
        if (sideMedia) onCloseSideMedia();
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onCloseSideMedia, sideMedia]);

  // Each report type gets its own header dot + title. For fuel,
  // the title reflects what data we actually have for this fuel-up:
  // matched (both sides), card-only, or driver-only.
  const meta = panel.kind === 'maintenance'
    ? { color: '#f59e0b', title: 'Maintenance report' }
    : panel.kind === 'inspection'
    ? { color: '#1a73e8', title: 'Inspection report' }
    : (() => {
        const hasTx     = !!panel.transaction;
        const hasReport = !!panel.report;
        if (hasTx && hasReport) return { color: '#16a34a', title: 'Fuel-up · matched' };
        if (hasTx)              return { color: '#0ea5e9', title: 'Fuel-up · card only' };
        return                       { color: '#8b5cf6', title: 'Fuel-up · driver only' };
      })();

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1000,
        padding: 24,
      }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden shrink-0"
        style={{
          // Inspection panel needs a wider canvas to fit the 5-card
          // KPI strip without crowding. Maintenance/fuel keep using
          // the same outer container so they get the extra room
          // too — none of them suffered at narrower widths anyway.
          width: 'min(96vw, 1000px)',
          height: 'min(92vh, 960px)',
          background: 'var(--gc-surface)',
          boxShadow: 'var(--shadow-3)',
        }}
      >
        {/* Header — mirrors MovementDetailPanel: color dot + title + X */}
        <div className="flex items-center gap-2.5 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>{meta.title}</div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — two-column. TwoColumnBody owns its own internal
            scroll (left media + right text both scroll independently)
            so this wrapper is just a flex container that fills the
            available height between the header and the bottom edge. */}
        <div className="flex-1 flex min-h-0" style={{ background: 'var(--gc-bg)' }}>
          {panel.kind === 'maintenance' && <MaintenanceDetail report={panel.report} driverNameById={driverNameById} assetLabelById={assetLabelById} trailerLabelById={trailerLabelById} onOpenMedia={onOpenMedia} />}
          {panel.kind === 'inspection'  && <InspectionDetail  id={panel.id} onOpenMedia={onOpenMedia} />}
          {panel.kind === 'fuel'        && <FuelDetail
            transaction={panel.transaction}
            report={panel.report}
            drivers={drivers}
            assets={assets}
            driverNameById={driverNameById}
            assetLabelById={assetLabelById}
            onOpenMedia={onOpenMedia}
            onFuelMutation={onFuelMutation}
          />}
        </div>
      </div>

    </div>
  );

  // Media side panel — its own fixed overlay LAYERED ABOVE the main
  // detail panel, centered on screen. Earlier this was rendered as a
  // flex sibling next to the detail panel (520px wide alongside the
  // 920px main panel), but on smaller laptops the combined width
  // pushed the main panel out of center and felt visually
  // unbalanced. As a stacked centered modal it reads cleanly: the
  // backdrop dims the detail panel behind, the media takes the
  // dispatcher's full attention while they're reviewing photos.
  const mediaOverlay = sideMedia ? (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: 'rgba(0,0,0,0.55)',
        zIndex: 1100, // above the detail panel (1000)
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onCloseSideMedia(); }}>
      <MediaSidePanel media={sideMedia} onClose={onCloseSideMedia} />
    </div>
  ) : null;

  // Portal so the fixed overlay isn't clipped by an ancestor's
  // containing block (transforms / filters / contain). Same pattern
  // as MovementDetailPanel.
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      {content}
      {mediaOverlay}
    </>,
    document.body,
  );
}

function MaintenanceDetail({
  report, driverNameById, assetLabelById, trailerLabelById, onOpenMedia,
}: {
  report: MaintenanceReport;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  onOpenMedia: (list: MediaList) => void;
}) {
  const mediaSections: Array<{ label?: string; photos: { id: string; signedUrl: string | null; caption: string | null }[] }> = [];
  if (report.photos && report.photos.length > 0) {
    mediaSections.push({
      photos: report.photos.map((p: MaintenanceReportPhoto) => ({ id: p.id, signedUrl: p.signedUrl ?? null, caption: null })),
    });
  }
  return (
    <TwoColumnBody
      mapLat={report.latitude}
      mapLon={report.longitude}
      mapState={report.state}
      media={mediaSections}
      onOpenMedia={onOpenMedia}
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
        <Field icon={<Clock size={12} />} label="Reported">{new Date(report.reportedAt).toLocaleString()}</Field>
        <Field icon={<User  size={12} />} label="Driver">{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (report as any).driverName as string
          ?? resolveDriverName(report.driverId, report.submittedBy, driverNameById)
        }</Field>
        <Field icon={<Truck size={12} />} label="Equipment">{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (report as any).assetName as string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ?? ((report as any).trailerName ? `Trailer ${(report as any).trailerName}` : undefined)
          ?? resolveEquipmentLabel(report.assetId, report.trailerId, assetLabelById, trailerLabelById)
        }</Field>
        <Field icon={<FileText size={12} />} label="Status"><StatusPill status={report.status} /></Field>
      </div>
      <FieldSection label="Description">
        <p className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>{report.description}</p>
      </FieldSection>
    </TwoColumnBody>
  );
}

function InspectionDetail({
  id, onOpenMedia,
}: {
  id: string;
  onOpenMedia: (list: MediaList) => void;
}) {
  type DetailData = Awaited<ReturnType<typeof railway.getInspectionReport>>['inspection'];
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    railway.getInspectionReport(id)
      .then(r => setData(r.inspection))
      .catch(err => { console.error('[equipment] inspection detail:', err); setData(null); })
      .finally(() => setLoading(false));
  }, [id]);
  if (loading) return <div className="flex-1 flex items-center justify-center"><Loader2 size={22} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} /></div>;
  if (!data)   return <div className="text-sm px-6 py-8" style={{ color: '#dc2626' }}>Could not load report.</div>;

  // Defect bookkeeping. Inspections cover one truck and optionally
  // one trailer; we group per-equipment so the dispatcher can audit
  // "fix everything on Big Red" vs "fix everything on Trailer 5567"
  // without re-reading the item list.
  const truckDefects   = data.items.filter(i => i.status === 'fail');
  const trailerDefects = data.trailerItems.filter(i => i.status === 'fail');
  const totalDefects   = truckDefects.length + trailerDefects.length;
  const totalItems     = data.items.length + data.trailerItems.length;
  const passCount      = totalItems - totalDefects;

  const truckLabel   = data.asset   ? `Truck ${data.asset.name}${data.asset.unit ? ` #${data.asset.unit}` : ''}` : 'Truck';
  const trailerLabel = data.trailer ? `Trailer ${data.trailer.trailer_number ? `#${data.trailer.trailer_number}` : data.trailer.name}` : 'Trailer';

  // Media sections: per-defect photos (in defect order) first, then
  // general photos grouped by which side of the rig they were
  // attached to. Each section has a label so the dispatcher knows
  // which item a given evidence shot belongs to.
  const mediaSections: Array<{ label?: string; photos: { id: string; signedUrl: string | null; caption: string | null }[] }> = [];
  for (const def of truckDefects) {
    const itemPhotos = data.photos.filter(p => p.itemId === def.id);
    if (itemPhotos.length > 0) {
      mediaSections.push({
        label: `${truckLabel} · ${def.label}`,
        photos: itemPhotos.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption ?? def.label })),
      });
    }
  }
  for (const def of trailerDefects) {
    const itemPhotos = data.photos.filter(p => p.itemId === def.id);
    if (itemPhotos.length > 0) {
      mediaSections.push({
        label: `${trailerLabel} · ${def.label}`,
        photos: itemPhotos.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption ?? def.label })),
      });
    }
  }
  const truckGeneral   = data.photos.filter(p => p.itemId == null && p.target === 'truck');
  const trailerGeneral = data.photos.filter(p => p.itemId == null && p.target === 'trailer');
  const orphanGeneral  = data.photos.filter(p => p.itemId == null && p.target == null);
  if (truckGeneral.length > 0)   mediaSections.push({ label: `${truckLabel} · General`,   photos: truckGeneral  .map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })) });
  if (trailerGeneral.length > 0) mediaSections.push({ label: `${trailerLabel} · General`, photos: trailerGeneral.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })) });
  if (orphanGeneral.length > 0)  mediaSections.push({ label: 'General',                    photos: orphanGeneral.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })) });

  const totalPhotos = mediaSections.reduce((n, s) => n + s.photos.length, 0);

  // Flat list of every photo with its section label — used by the
  // lightbox so clicking any tile opens MediaSidePanel pre-scrolled
  // to that exact image.
  const flatItems: MediaList['items'] = [];
  for (const sec of mediaSections) {
    for (const p of sec.photos) flatItems.push({ id: p.id, signedUrl: p.signedUrl, caption: p.caption, section: sec.label });
  }

  const submittedDate = new Date(data.submittedAt);
  // Both asset.name and trailer fields can technically be null on the
  // response — coerce to em-dash so the KPI card never renders an
  // empty cell.
  const truckDisplayName   = data.asset?.name   ?? '—';
  const trailerDisplayName = data.trailer
    ? (data.trailer.trailer_number
        ? `#${data.trailer.trailer_number}`
        : (data.trailer.name ?? '—'))
    : '—';

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: 'var(--gc-bg)' }}>
      {/* Hero band — status pill (red or green chip), driver + date
          + time. Sets the tone at a glance: dispatcher knows what
          they're looking at before reading anything else. */}
      <div className="px-6 pt-5 pb-5" style={{ background: 'var(--gc-surface)', borderBottom: '1px solid var(--gc-border-light)' }}>
        <InspectionStatusBadge defects={totalDefects} passCount={passCount} />
        <div className="mt-3 flex items-center gap-2 text-[14px]" style={{ color: 'var(--gc-text-2)' }}>
          <User size={14} style={{ color: 'var(--gc-text-3)' }} />
          <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{data.signedBy}</span>
          <span style={{ color: 'var(--gc-text-3)' }}>·</span>
          <span>{submittedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>
          <span style={{ color: 'var(--gc-text-3)' }}>·</span>
          <span className="tabular-nums">{submittedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
      </div>

      {/* KPI strip — 5 cards. The dispatcher's first read for "what
          rig, who, how long, how complete" all answered in one row. */}
      <div className="px-6 pt-5 pb-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
        <KpiCard
          icon={<Truck size={14} />}
          label="Truck"
          value={truckDisplayName}
          accent={data.asset ? '#1a73e8' : undefined}
        />
        <KpiCard
          icon={<Package size={14} />}
          label="Trailer"
          value={trailerDisplayName}
          accent={data.trailer ? '#0ea5e9' : undefined}
          muted={!data.trailer}
        />
        <KpiCard
          icon={<Clock size={14} />}
          label="Duration"
          value={data.durationSeconds != null ? fmtDuration(data.durationSeconds) : '—'}
          muted={data.durationSeconds == null}
        />
        <KpiCard
          icon={<ClipboardCheck size={14} />}
          label="Items"
          value={`${passCount}`}
          suffix={
            totalDefects > 0
              ? <span style={{ color: '#d93025', fontWeight: 800 }}> · {totalDefects} failed</span>
              : <span style={{ color: 'var(--gc-text-3)', fontWeight: 500 }}> passed</span>
          }
        />
        <KpiCard
          icon={<User size={14} />}
          label="Signed by"
          value={data.signedBy}
        />
      </div>

      {/* Defects (or all-passed badge) */}
      <div className="px-6 pb-4">
        {data.asset && truckDefects.length > 0 && (
          <EquipmentDefectsSection equipmentLabel={truckLabel} defects={truckDefects} />
        )}
        {data.trailer && trailerDefects.length > 0 && (
          <EquipmentDefectsSection equipmentLabel={trailerLabel} defects={trailerDefects} />
        )}
        {totalDefects === 0 && <AllPassedBadge passCount={passCount} />}
      </div>

      {/* Media gallery — larger tiles than the old left-rail layout
          (~200x200 vs old 96x96), grouped by section so each photo
          stays attributable to the defect / general slot it came
          from. Click a tile to open MediaSidePanel pre-scrolled. */}
      {totalPhotos > 0 && (
        <div className="px-6 pb-4">
          <SectionHeader>Media ({totalPhotos})</SectionHeader>
          {(() => {
            let cursor = 0;
            return (
              <div className="flex flex-col gap-4">
                {mediaSections.map((sec, i) => (
                  <div key={i}>
                    {sec.label && (
                      <div className="text-[11px] font-bold mb-2" style={{ color: 'var(--gc-text-2)' }}>
                        {sec.label}
                      </div>
                    )}
                    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                      {sec.photos.map(p => {
                        const myIdx = cursor++;
                        return p.signedUrl ? (
                          <button
                            key={p.id}
                            onClick={() => onOpenMedia({ initialIndex: myIdx, items: flatItems })}
                            title={p.caption ?? sec.label ?? 'View photo'}
                            className="overflow-hidden rounded-xl transition-transform"
                            style={{
                              padding: 0,
                              border: '1px solid var(--gc-border)',
                              background: 'var(--gc-surface)',
                              cursor: 'pointer',
                              aspectRatio: '1 / 1',
                              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.signedUrl} alt={p.caption ?? ''}
                              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                          </button>
                        ) : (
                          <div key={p.id}
                            className="flex items-center justify-center rounded-xl text-[12px]"
                            style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-3)', aspectRatio: '1 / 1' }}>
                            no preview
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Driver notes — optional free-text field */}
      {data.notes && (
        <div className="px-6 pb-4">
          <SectionHeader>Driver notes</SectionHeader>
          <div className="rounded-xl p-4 text-[13px] whitespace-pre-wrap"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}>
            {data.notes}
          </div>
        </div>
      )}

      {/* Location footer — demoted from "primary block at the top of
          the panel" to a compact summary at the bottom. The map is
          context, not content; the dispatcher rarely needs it to
          process a DVIR but it's still nice to have on hand. */}
      <div className="px-6 pb-6">
        <SectionHeader>Location</SectionHeader>
        {data.locationLat != null && data.locationLon != null ? (
          <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
            <MapBlock lat={data.locationLat} lon={data.locationLon} height={180} />
          </div>
        ) : (
          <div className="rounded-xl py-4 px-4 text-[12px] flex items-center gap-2"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
            <MapPin size={13} /> No GPS attached to this report
          </div>
        )}
      </div>
    </div>
  );
}

/** Status pill at the top of the inspection panel. Solid colored chip
 *  so the dispatcher gets a pass/fail read before parsing anything
 *  else. Green for all-clear, red for defects, with the count baked
 *  into the label. Matches the calendar cell color language. */
function InspectionStatusBadge({ defects, passCount }: { defects: number; passCount: number }) {
  const isClear = defects === 0;
  const bg     = isClear ? '#e6f4ea' : '#fce8e6';
  const fg     = isClear ? '#137333' : '#a50e0e';
  const dotBg  = isClear ? '#1e8e3e' : '#d93025';
  return (
    <div className="inline-flex items-center gap-2 rounded-full"
      style={{ background: bg, padding: '6px 14px 6px 8px' }}>
      <div
        className="rounded-full flex items-center justify-center"
        style={{ width: 24, height: 24, background: dotBg }}>
        {isClear
          ? <Check       size={14} color="#fff" strokeWidth={3} />
          : <AlertCircle size={14} color="#fff" strokeWidth={2.5} />}
      </div>
      <span className="text-[15px] font-extrabold" style={{ color: fg }}>
        {isClear
          ? 'All Clear'
          : `${defects} defect${defects === 1 ? '' : 's'}`}
      </span>
      <span className="text-[12px] font-semibold ml-1" style={{ color: fg, opacity: 0.7 }}>
        / {passCount + defects} items
      </span>
    </div>
  );
}

/** Single KPI tile used in the strip at the top of the inspection
 *  panel. Big bold value, small uppercase label above. `muted` greys
 *  it out for missing data ("no trailer", "no duration"). */
function KpiCard({
  icon, label, value, suffix, accent, muted,
}: {
  icon:    React.ReactNode;
  label:   string;
  value:   string;
  suffix?: React.ReactNode;
  /** Optional colored left-border accent. */
  accent?: string;
  muted?:  boolean;
}) {
  return (
    <div
      className="rounded-xl px-3 py-3"
      style={{
        background:   'var(--gc-surface)',
        border:       '1px solid var(--gc-border-light)',
        borderLeft:   accent ? `3px solid ${accent}` : '1px solid var(--gc-border-light)',
        opacity:      muted ? 0.55 : 1,
        minWidth:     0,
      }}>
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--gc-text-3)' }}>
        {icon}{label}
      </div>
      <div className="text-[16px] font-extrabold truncate" style={{ color: 'var(--gc-text-1)', lineHeight: 1.1 }} title={value}>
        {value}
      </div>
      {suffix && (
        <div className="text-[11px] mt-0.5">{suffix}</div>
      )}
    </div>
  );
}

/** Section title bar — bigger and bolder than the old all-caps tiny
 *  label so the panel reads as a sequence of well-defined cards. */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-extrabold uppercase tracking-wider mb-2.5"
      style={{ color: 'var(--gc-text-3)' }}>
      {children}
    </div>
  );
}

// AllPassedBadge — fills the right column when there are zero
// defects. Same visual weight as the defect cards (so the empty
// state doesn't disappear into whitespace) but green so the
// dispatcher can audit at a glance.
function AllPassedBadge({ passCount }: { passCount: number }) {
  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
      <div
        className="flex items-center gap-3 rounded-lg py-3 px-4"
        style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}
      >
        <div
          className="rounded-full flex items-center justify-center shrink-0"
          style={{ width: 32, height: 32, background: '#16a34a' }}
        >
          <Check size={18} color="#fff" strokeWidth={3} />
        </div>
        <div>
          <div className="text-[13px] font-semibold" style={{ color: '#14532d' }}>All passed</div>
          <div className="text-[11px]" style={{ color: '#166534' }}>{passCount} {passCount === 1 ? 'item' : 'items'} checked, no defects reported.</div>
        </div>
      </div>
    </div>
  );
}

// Renders one equipment's failed checklist items as red cards.
// Photos are no longer inline — they live in the left-column media
// gallery with labels linking back to the item, so the dispatcher
// can read the writeup on the right while scanning evidence on the
// left without losing context.
function EquipmentDefectsSection({
  equipmentLabel, defects,
}: {
  equipmentLabel: string;
  defects: Array<{ id: string; section: string; label: string; status: 'pass'|'fail'|'na'; notes?: string }>;
}) {
  return (
    <FieldSection label={`${equipmentLabel} — Defects (${defects.length})`}>
      <div className="flex flex-col gap-1.5">
        {defects.map(item => (
          <div key={item.id} className="text-[12px] py-2 px-3 rounded-lg" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
            <div style={{ color: '#7f1d1d', fontWeight: 600 }}>{item.label}</div>
            <div className="text-[10px] mt-0.5" style={{ color: '#991b1b' }}>{item.section}</div>
            {item.notes && <div className="text-[12px] mt-1.5" style={{ color: 'var(--gc-text-1)' }}>{item.notes}</div>}
          </div>
        ))}
      </div>
    </FieldSection>
  );
}

// ─── Unified fuel detail ────────────────────────────────────────────
//
// One panel for every fuel-up regardless of source. Accepts:
//   • transaction — card receipt (Mudflap). Authoritative for date /
//     $ / gallons / location text.
//   • report — driver-app submission. Authoritative for driver_id /
//     asset_id / lat-lon (for matched rows).
// At least one is set; both is the matched case.
//
// Source-of-truth priority for each field:
//   date          → transaction.transactionDate ?? report.reportedAt
//   gallons (D)   → transaction.dieselGallons ?? report.dieselGallons
//   gallons (DEF) → transaction.defGallons    ?? report.defGallons
//   $ / total     → transaction only (driver report carries no money)
//   driver        → transaction.driverId (resolved) ?? report.driverId
//   truck         → transaction.assetId (resolved)  ?? report.assetId
//   location text → transaction.location only
//   photos        → report.photos only
//
// Editable fields:
//   • Driver + Truck dropdowns ALWAYS render, but only persist to a
//     transaction (via /assign). When there's no transaction (driver-
//     only row), the dropdowns show the report's driver/asset and are
//     read-only — the driver chose them in the app.

function FuelDetail({
  transaction: initialTx, report, drivers, assets,
  driverNameById, assetLabelById, onOpenMedia, onFuelMutation,
}: {
  transaction: FuelTransaction | null;
  report:      FuelReport | null;
  drivers:     Driver[];
  assets:      Asset[];
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  onOpenMedia: (list: MediaList) => void;
  onFuelMutation: () => void;
}) {
  // Local mutable transaction so /assign + /auto-match actions can
  // refresh the panel without re-fetching the list.
  const [t, setT] = useState<FuelTransaction | null>(initialTx);
  useEffect(() => { setT(initialTx); }, [initialTx]);

  // Pull values from whichever side has them. Transaction first
  // because it's the receipt (machine-generated, no driver typo).
  const dateIso       = t?.transactionDate ?? report?.reportedAt ?? null;
  const dieselGallons = t?.dieselGallons   ?? report?.dieselGallons ?? null;
  const defGallons    = t?.defGallons      ?? report?.defGallons    ?? null;
  const totalCharged  = t?.totalCharged    ?? null;
  const totalSaved    = t?.totalSaved      ?? 0;
  const locationText  = t?.location        ?? null;
  // $/gallon priority:
  //   1. dieselDiscountPrice — Mudflap's actual per-gallon rate after
  //      discount. The number you actually paid for fuel.
  //   2. dieselTotal / dieselGallons — derived diesel-only price if
  //      the discount column is empty but we have a diesel subtotal.
  //   3. totalCharged / dieselGallons — last-resort fallback. ONLY
  //      accurate when the receipt is pure diesel (no DEF, no fees).
  //      Otherwise overstates the per-gallon cost.
  const dieselPpg =
    t?.dieselDiscountPrice
    ?? (t?.dieselTotal && dieselGallons && dieselGallons > 0
        ? t.dieselTotal / dieselGallons
        : null)
    ?? (totalCharged != null && dieselGallons && dieselGallons > 0
        ? totalCharged / dieselGallons
        : null);

  return (
    <div className="flex-1 overflow-auto" style={{ background: 'var(--gc-surface)' }}>
      {/* Header band — date + total. The two facts the dispatcher
          most needs at a glance when triaging fuel spend. */}
      <div className="flex items-baseline justify-between px-5 pt-5 pb-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            Purchase
          </div>
          <div className="text-[20px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
            {dateIso ? new Date(dateIso).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '—'}
          </div>
          {locationText && (
            <div className="text-[13px] mt-0.5" style={{ color: 'var(--gc-text-2)' }}>
              <MapPin size={11} style={{ display: 'inline', marginRight: 4, color: 'var(--gc-text-3)' }} />
              {locationText}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            Total charged
          </div>
          <div className="text-[24px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
            {totalCharged != null ? `$${totalCharged.toFixed(2)}` : <Muted />}
          </div>
          {totalSaved > 0 && (
            <div className="text-[12px] font-medium tabular-nums" style={{ color: '#166534' }}>
              Saved ${totalSaved.toFixed(2)}
            </div>
          )}
        </div>
      </div>

      {/* KPI tiles — diesel gal, diesel $/gal, DEF gal, total.
          The four numbers the dispatcher needs to recall ("how much
          diesel? at what price? DEF? total?") without scanning a
          12-field grid. Missing fields render as '—' so the grid
          stays aligned across every row. */}
      <div className="grid grid-cols-4 gap-3 px-5 pb-4">
        <KpiTile
          label="Diesel"
          value={dieselGallons != null ? dieselGallons.toFixed(1) : '—'}
          unit={dieselGallons != null ? 'gal' : undefined}
        />
        <KpiTile
          label="$/gallon"
          value={dieselPpg != null ? `$${dieselPpg.toFixed(2)}` : '—'}
          unit={t?.dieselRetailPrice != null ? `retail $${t.dieselRetailPrice.toFixed(2)}` : undefined}
        />
        <KpiTile
          label="DEF"
          value={defGallons != null && defGallons > 0 ? defGallons.toFixed(1) : '—'}
          unit={defGallons != null && defGallons > 0 ? 'gal' : undefined}
        />
        <KpiTile
          label="Total"
          value={totalCharged != null ? `$${totalCharged.toFixed(2)}` : '—'}
          unit={t?.paymentLast4 ? `card ${t.paymentLast4}` : undefined}
        />
      </div>

      <div className="h-px mx-5" style={{ background: 'var(--gc-border-light)' }} />

      {/* Assignment + status — both the actionable surface. */}
      <div className="px-5 py-4 grid grid-cols-2 gap-5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Assigned to
          </div>
          {t ? (
            <AssignmentControls
              transaction={t}
              linkedReport={report}
              drivers={drivers}
              assets={assets}
              onChange={setT}
              onFuelMutation={onFuelMutation}
            />
          ) : (
            // No card transaction → no editable assignment. The driver
            // chose driver + truck in the app at filing time; that's
            // authoritative and not something dispatch should override
            // here. Show as read-only so the dispatcher sees what was
            // recorded.
            <ReadOnlyAssignment
              report={report!}
              driverNameById={driverNameById}
              assetLabelById={assetLabelById}
            />
          )}
        </div>
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Match
          </div>
          {t ? (
            <MatchPanel
              transaction={t}
              driverNameById={driverNameById}
              assetLabelById={assetLabelById}
              onChange={setT}
              onFuelMutation={onFuelMutation}
            />
          ) : (
            // Driver-only row — there's no card transaction to match
            // FROM. Surface that explicitly so the dispatcher knows
            // they're waiting on a receipt (or it'll never come).
            <DriverOnlyMatchInfo report={report!} />
          )}
        </div>
      </div>

      {/* Map — only renders when we have PRECISE coordinates from a
          driver report. The Mudflap location text ("Maverik #488 -
          Draper, UT") is too ambiguous for a useful map: Google
          interprets the brand name and shows every nearby location
          rather than zooming to the specific one the driver actually
          used. Text-only locations stay visible in the header — no
          misleading map. */}
      {(() => {
        if (report?.latitude == null || report?.longitude == null) return null;
        const mapQuery = `${report.latitude},${report.longitude}`;
        return (
          <>
            <div className="h-px mx-5" style={{ background: 'var(--gc-border-light)' }} />
            <div className="px-5 py-4">
              <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
                Location (driver GPS)
              </div>
              <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', height: 220 }}>
                <iframe
                  title="Fuel location"
                  src={`https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed`}
                  style={{ width: '100%', height: '100%', border: 0 }}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            </div>
          </>
        );
      })()}

      {/* Receipt photos — driver-side only. Render as a horizontal
          thumbnail strip; click opens the existing media side-panel. */}
      {report?.photos && report.photos.length > 0 && (
        <>
          <div className="h-px mx-5" style={{ background: 'var(--gc-border-light)' }} />
          <div className="px-5 py-4">
            <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
              Driver receipts ({report.photos.length})
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {report.photos.map((p, idx) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onOpenMedia({
                    initialIndex: idx,
                    items: report.photos!.map(ph => ({
                      id: ph.id,
                      signedUrl: ph.signedUrl ?? null,
                      caption: null,
                    })),
                  })}
                  className="shrink-0 rounded overflow-hidden transition-transform hover:scale-[1.02]"
                  style={{ width: 96, height: 96, border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
                  {p.signedUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={p.signedUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <div className="flex items-center justify-center w-full h-full text-[10px]" style={{ color: 'var(--gc-text-3)' }}>No preview</div>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Details footer — secondary fields from both sides. */}
      <div className="h-px mx-5" style={{ background: 'var(--gc-border-light)' }} />
      <div className="px-5 py-4">
        <div className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
          Details
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-[12px]">
          {t && <DetailRow label="Provider">{t.provider}</DetailRow>}
          {t?.driverName && <DetailRow label="Driver on receipt">{t.driverName}</DetailRow>}
          {t?.dieselRetailPrice != null && (
            <DetailRow label="Diesel retail $/gal">${t.dieselRetailPrice.toFixed(4)}</DetailRow>
          )}
          {t?.dieselDiscountPrice != null && (
            <DetailRow label="Diesel Mudflap $/gal">${t.dieselDiscountPrice.toFixed(4)}</DetailRow>
          )}
          {t?.defRetailPrice != null && (
            <DetailRow label="DEF retail $/gal">${t.defRetailPrice.toFixed(4)}</DetailRow>
          )}
          {t?.defDiscountPrice != null && (
            <DetailRow label="DEF Mudflap $/gal">${t.defDiscountPrice.toFixed(4)}</DetailRow>
          )}
          {t && (
            <DetailRow label="Provider txn id">
              <span className="font-mono break-all text-[11px]">{t.providerTransactionId}</span>
            </DetailRow>
          )}
          {report?.state && <DetailRow label="State (driver)">{report.state}</DetailRow>}
          {report?.odometer != null && (
            <DetailRow label="Odometer">{report.odometer.toLocaleString()} mi</DetailRow>
          )}
          {report?.notes && <DetailRow label="Driver notes">{report.notes}</DetailRow>}
          <DetailRow label="Recorded">
            {dateIso ? new Date(dateIso).toLocaleString() : <Muted />}
          </DetailRow>
          {t && (
            <DetailRow label="Created in FleetCal">
              {new Date(t.createdAt).toLocaleString()}
            </DetailRow>
          )}
          {t?.legacyFormResponseId != null && (
            <DetailRow label="Legacy form id">{t.legacyFormResponseId}</DetailRow>
          )}
        </div>
      </div>
    </div>
  );
}

// Read-only driver+truck for driver-only rows. The driver chose these
// in the app at filing time, so they're authoritative — dispatch
// doesn't override here.
function ReadOnlyAssignment({
  report, driverNameById, assetLabelById,
}: {
  report: FuelReport;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embedded = report as any;
  const driverLabel = (embedded.driverName as string | undefined)
    ?? resolveDriverName(report.driverId, report.submittedBy, driverNameById);
  const assetLabel = (embedded.assetName as string | undefined)
    ?? assetLabelById.get(report.assetId)
    ?? `Asset #${report.assetId}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            Driver
          </div>
          <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>{driverLabel}</div>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            Truck
          </div>
          <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>{assetLabel}</div>
        </div>
      </div>
      <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
        Recorded by the driver in the app.
      </div>
    </div>
  );
}

// Match panel for driver-only rows — no card transaction exists yet.
// Surfaces what state the report is in so the dispatcher knows
// whether they're waiting on a receipt.
function DriverOnlyMatchInfo({ report }: { report: FuelReport }) {
  const tint = report.matchStatus === 'matched'
    ? { bg: '#dcfce7', fg: '#166534', label: 'Matched' }
    : report.matchStatus === 'no_transaction'
      ? { bg: '#f3f4f6', fg: '#4b5563', label: 'No receipt expected' }
      : { bg: '#fef3c7', fg: '#92400e', label: 'Awaiting receipt' };
  return (
    <div className="flex flex-col gap-2">
      <span
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-wider self-start"
        style={{ background: tint.bg, color: tint.fg }}>
        {tint.label}
      </span>
      <div className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
        {report.matchStatus === 'pending'
          ? 'Mudflap receipt usually arrives within 30 min of the pump swipe. The next sweep will pair them automatically.'
          : report.matchStatus === 'no_transaction'
            ? 'Marked as a driver-only fuel-up (e.g. paid out of pocket).'
            : 'Linked to its card transaction. Open that side to see receipt details.'}
      </div>
    </div>
  );
}

// ─── New-panel helpers ──────────────────────────────────────────────

function KpiTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div
      className="rounded-lg px-3 py-2.5"
      style={{
        background: 'var(--gc-bg)',
        border: '1px solid var(--gc-border-light)',
      }}>
      <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      <div className="text-[20px] font-semibold tabular-nums mt-0.5" style={{ color: 'var(--gc-text-1)' }}>
        {value}
      </div>
      {unit && (
        <div className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>
          {unit}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      <span className="text-right" style={{ color: 'var(--gc-text-1)' }}>{children}</span>
    </div>
  );
}

// MatchPanel — compact, redesigned match-status surface.
//
//   • Matched: shows the status pill + when it was linked. No action
//     buttons (manual link/unlink moved out of the per-row UI; if the
//     dispatcher needs to override an auto-match, they unset the
//     driver+truck assignment via the dropdowns).
//   • Unmatched: shows the pill + an "Auto-match" button that runs
//     the matcher against just this row and reports back what it
//     found ("Linked to <driver>'s report" or "No match within 3 days").
//
// This replaces the older MatchControls + CandidatePicker UX. The
// candidate-picker was useful when manual report linking was the
// primary workflow; with the new driver_id/asset_id columns on the
// transaction itself, manual linking is rarely needed.

function MatchPanel({
  transaction: t, driverNameById, assetLabelById, onChange, onFuelMutation,
}: {
  transaction: FuelTransaction;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  onChange: (next: FuelTransaction) => void;
  /** Fires after any successful mutation so the table behind the
   *  modal refetches. */
  onFuelMutation: () => void;
}) {
  const [busy, setBusy]       = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  // Picker open/closed. Anchored under the row so the candidate list
  // doesn't push the rest of the panel around.
  const [pickerOpen, setPickerOpen] = useState(false);

  async function runAutoMatch() {
    if (busy) return;
    setBusy(true); setFeedback(null);
    try {
      const r = await railway.autoMatchFuelTransaction(t.id);
      onChange(r.fuelTransaction);
      if (r.result === 'auto_matched') {
        setFeedback(`Matched · ${r.confidence ?? '?'}% confidence`);
        onFuelMutation();
      } else if (r.result === 'already_matched') {
        setFeedback('Already matched');
      } else {
        setFeedback('No matching driver report within 3 days');
      }
      setTimeout(() => setFeedback(null), 5000);
    } catch (err) {
      setFeedback((err as Error).message ?? 'Auto-match failed');
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setBusy(false);
    }
  }

  async function linkToReport(reportId: string) {
    if (busy) return;
    setBusy(true); setFeedback(null);
    try {
      const r = await railway.matchFuelTransaction(t.id, { fuelReportId: reportId });
      onChange(r.fuelTransaction);
      setPickerOpen(false);
      setFeedback('Linked to driver report');
      onFuelMutation();
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback((err as Error).message ?? 'Link failed');
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (busy) return;
    setBusy(true); setFeedback(null);
    try {
      const r = await railway.matchFuelTransaction(t.id, { fuelReportId: null });
      onChange(r.fuelTransaction);
      setFeedback('Unlinked from driver report');
      onFuelMutation();
      setTimeout(() => setFeedback(null), 4000);
    } catch (err) {
      setFeedback((err as Error).message ?? 'Unlink failed');
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <MatchStatusPill status={t.matchStatus} confidence={t.matchConfidence} />
        {t.matchedAt && t.matchStatus !== 'unmatched' && (
          <span className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
            {t.matchStatus === 'auto_matched' ? 'Auto-linked' : 'Linked'} {new Date(t.matchedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {/* Action row — different affordances per state. Unmatched:
          Auto-match + Link manually (picker). Matched: Unlink. */}
      {t.matchStatus === 'unmatched' ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={runAutoMatch}
            disabled={busy}
            className="rounded-md transition-colors"
            style={{
              background: busy ? 'var(--gc-bg)' : 'var(--gc-blue)',
              color:      busy ? 'var(--gc-text-3)' : '#fff',
              border:     `1px solid ${busy ? 'var(--gc-border-light)' : 'var(--gc-blue)'}`,
              padding:    '6px 12px',
              fontSize:   12,
              fontWeight: 600,
              cursor:     busy ? 'default' : 'pointer',
            }}>
            {busy ? 'Matching…' : 'Auto-match'}
          </button>
          <button
            type="button"
            onClick={() => setPickerOpen(o => !o)}
            disabled={busy}
            className="rounded-md transition-colors"
            style={{
              background: 'var(--gc-surface)',
              color:      'var(--gc-text-2)',
              border:     '1px solid var(--gc-border-light)',
              padding:    '6px 12px',
              fontSize:   12,
              fontWeight: 600,
              cursor:     busy ? 'default' : 'pointer',
            }}>
            {pickerOpen ? 'Cancel' : 'Link manually'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={unlink}
          disabled={busy}
          className="rounded-md transition-colors self-start"
          style={{
            background: 'var(--gc-surface)',
            color:      '#dc2626',
            border:     '1px solid #fecaca',
            padding:    '6px 12px',
            fontSize:   12,
            fontWeight: 600,
            cursor:     busy ? 'default' : 'pointer',
          }}>
          {busy ? 'Working…' : 'Unlink driver report'}
        </button>
      )}

      {/* Inline candidate picker — fetches unmatched driver fuel_reports
          within ±3 days of the transaction date. Sorted by gallons
          proximity to the receipt (closest first) so the most likely
          match is on top. */}
      {pickerOpen && t.matchStatus === 'unmatched' && (
        <DriverReportPicker
          transactionDate={t.transactionDate}
          targetGallons={t.dieselGallons}
          driverNameById={driverNameById}
          assetLabelById={assetLabelById}
          busy={busy}
          onPick={linkToReport}
        />
      )}

      {feedback && (
        <div className="text-[11.5px]" style={{ color: 'var(--gc-text-2)' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}

// Lightweight candidate list for manual linking. Pulls unmatched
// fuel_reports within ±3 days of the transaction's purchase date,
// sorted by how close their diesel gallons are to the receipt's
// (closest first, since gallons is the strongest non-id signal).
//
// Rows that are already matched to a different transaction don't
// surface — the listFuelReports endpoint supports matchStatus
// filtering, so we only fetch 'pending' reports.
function DriverReportPicker({
  transactionDate, targetGallons, driverNameById, assetLabelById, busy, onPick,
}: {
  transactionDate: string;
  targetGallons:   number | undefined;
  driverNameById:  Map<number, string>;
  assetLabelById:  Map<number, string>;
  busy:            boolean;
  onPick:          (reportId: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows]       = useState<FuelReport[]>([]);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const fromD = new Date(transactionDate); fromD.setDate(fromD.getDate() - 3);
    const toD   = new Date(transactionDate); toD.setDate(toD.getDate()   + 3);
    railway.listFuelReports({
      from:        fromD.toISOString(),
      to:          toD.toISOString(),
      matchStatus: 'pending',
      limit:       100,
    })
      .then(res => setRows(res.fuelReports))
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [transactionDate]);

  // Sort by gallons-distance from the receipt's target (closest first).
  // Falls back to date-distance when gallons isn't available.
  const sorted = useMemo(() => {
    const target = targetGallons ?? 0;
    return [...rows].sort((a, b) => {
      const da = Math.abs(a.dieselGallons - target);
      const db = Math.abs(b.dieselGallons - target);
      return da - db;
    });
  }, [rows, targetGallons]);

  return (
    <div
      className="rounded-md mt-1"
      style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
      <div className="px-3 py-2 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          Unmatched driver reports near {new Date(transactionDate).toLocaleDateString()}
        </div>
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          ±3 days
        </div>
      </div>
      {loading && (
        <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
          Loading candidates…
        </div>
      )}
      {error && (
        <div className="px-3 py-3 text-[12px]" style={{ color: '#dc2626' }}>{error}</div>
      )}
      {!loading && !error && sorted.length === 0 && (
        <div className="px-3 py-3 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
          No unmatched driver reports in the ±3 day window.
        </div>
      )}
      {sorted.length > 0 && (
        <div className="flex flex-col" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {sorted.map(r => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const embedded = r as any;
            const driverName = embedded.driverName as string | undefined
              ?? driverNameById.get(r.driverId)
              ?? `Driver #${r.driverId}`;
            const assetName  = embedded.assetName as string | undefined
              ?? assetLabelById.get(r.assetId)
              ?? `Asset #${r.assetId}`;
            const galDiff = targetGallons != null ? Math.abs(r.dieselGallons - targetGallons) : null;
            const isClose = galDiff != null && galDiff <= 0.5;
            return (
              <button
                key={r.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(r.id)}
                className="flex items-center gap-3 px-3 py-2 text-left transition-colors disabled:opacity-50"
                style={{
                  borderBottom: '1px solid var(--gc-border-light)',
                  background:   isClose ? '#f0fdf4' : 'transparent',
                  cursor:       busy ? 'default' : 'pointer',
                }}
                onMouseEnter={e => { if (!busy && !isClose) (e.currentTarget as HTMLElement).style.background = 'var(--gc-surface)'; }}
                onMouseLeave={e => { if (!busy && !isClose) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                    {driverName} <span style={{ color: 'var(--gc-text-3)', fontWeight: 400 }}>·</span> {assetName}
                  </div>
                  <div className="text-[11px] mt-0.5 tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                    {new Date(r.reportedAt).toLocaleString()} · {r.dieselGallons.toFixed(1)} gal
                    {galDiff != null && galDiff > 0.001 && ` · Δ${galDiff.toFixed(1)} gal from receipt`}
                    {r.state && ` · ${r.state}`}
                  </div>
                </div>
                <div className="text-[11px] font-bold uppercase tracking-wider shrink-0" style={{ color: 'var(--gc-blue)' }}>
                  Link →
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Assignment controls (driver + truck dropdowns) ─────────────────
//
// Lets the dispatcher attribute a card transaction to a FleetCal
// driver + asset directly, no fuel_report required. The Mudflap
// receipt's driver_name + matched_truck are free text and may not
// resolve automatically (multiple drivers with the same first name,
// receipt prints the nickname, truck unit not yet in FleetCal). This
// is the manual override path.
//
// "Apply to all other transactions from X" — when the dispatcher
// classifies "Kevin" once, they almost always want the same
// classification applied to every other unmatched receipt that
// printed "Kevin". Checkbox toggles that behavior; the server only
// touches rows that don't already have a driver_id (so prior
// intentional overrides aren't blown away).

function AssignmentControls({
  transaction: t, linkedReport, drivers, assets, onChange, onFuelMutation,
}: {
  transaction: FuelTransaction;
  /** Linked driver fuel_report when present. Used as a fallback
   *  source for the initial driver+truck values so the dropdowns
   *  pre-fill correctly even for transactions whose match was
   *  recorded BEFORE we started mirroring driver_id/asset_id onto
   *  the transaction. */
  linkedReport: FuelReport | null;
  drivers: Driver[];
  assets: Asset[];
  onChange: (next: FuelTransaction) => void;
  /** Fires after a successful save so the table behind the modal
   *  refetches and shows the new attribution. */
  onFuelMutation: () => void;
}) {
  // Initial values fall back through:
  //   1. transaction.driverId (explicit set via /assign)
  //   2. linkedReport.driverId (matched-report's driver)
  //   3. null (truly unassigned — dispatcher picks via dropdown)
  // Same for assetId.
  const initialDriver = t.driverId ?? linkedReport?.driverId ?? null;
  const initialAsset  = t.assetId  ?? linkedReport?.assetId  ?? null;
  const [driverId, setDriverId] = useState<number | null>(initialDriver);
  const [assetId,  setAssetId]  = useState<number | null>(initialAsset);
  const [applyToSimilar, setApplyToSimilar] = useState(false);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // Reset local state when the user opens a different transaction OR
  // when the link to a fuel_report changes (e.g. after running auto-
  // match in the same panel session).
  useEffect(() => {
    setDriverId(t.driverId ?? linkedReport?.driverId ?? null);
    setAssetId(t.assetId ?? linkedReport?.assetId ?? null);
    setApplyToSimilar(false);
    setError(null);
    setSavedMessage(null);
  }, [t.id, t.driverId, t.assetId, linkedReport?.id, linkedReport?.driverId, linkedReport?.assetId]);

  // No active-status filter — we've been bitten too many times by
  // it. Some orgs set activeTo on every driver (planned retirements,
  // legacy data migrations), some never set it, and the failure mode
  // is silent: dropdown empty, no error, dispatcher stuck. Better to
  // show every driver/asset in the org and trust the dispatcher to
  // pick the right one. If a driver appears retired on a fuel-up
  // they actually did fuel for, we still want them assignable.
  const driverOptions = useMemo(() => {
    return [...drivers].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [drivers]);
  const assetOptions = useMemo(() => {
    return [...assets].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [assets]);

  // Dirty compares against the *effective* assignment (txn fields +
  // linked-report fallback), so changing the dropdown back to the
  // pre-filled value doesn't mistakenly enable Save.
  const dirty = driverId !== initialDriver || assetId !== initialAsset;

  async function save() {
    if (busy || !dirty) return;
    setBusy(true); setError(null); setSavedMessage(null);
    try {
      const res = await railway.assignFuelTransaction(t.id, {
        driverId,
        assetId,
        applyToSimilar,
      });
      onChange(res.fuelTransaction);
      const extra = res.alsoUpdated && res.alsoUpdated > 0
        ? ` (+ ${res.alsoUpdated} other ${res.alsoUpdated === 1 ? 'transaction' : 'transactions'})`
        : '';
      setSavedMessage(`Saved${extra}`);
      setApplyToSimilar(false);
      onFuelMutation();
      setTimeout(() => setSavedMessage(null), 4000);
    } catch (err) {
      setError((err as Error).message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  // Receipt printed a driver name → offer the bulk-apply checkbox
  // (the operation only makes sense if there's a name to match on).
  const showBulk = !!t.driverName && t.driverName.trim().length > 0 && dirty;

  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            Driver
          </div>
          <select
            value={driverId ?? ''}
            onChange={e => setDriverId(e.target.value ? Number(e.target.value) : null)}
            disabled={busy}
            className="w-full text-[13px] outline-none transition-colors"
            style={{
              padding: '7px 10px',
              border: '1px solid var(--gc-border-light)',
              borderRadius: 6,
              background: 'var(--gc-surface)',
              color: driverId ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
            }}>
            <option value="">— Unassigned —</option>
            {driverOptions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
            Truck
          </div>
          <select
            value={assetId ?? ''}
            onChange={e => setAssetId(e.target.value ? Number(e.target.value) : null)}
            disabled={busy}
            className="w-full text-[13px] outline-none transition-colors"
            style={{
              padding: '7px 10px',
              border: '1px solid var(--gc-border-light)',
              borderRadius: 6,
              background: 'var(--gc-surface)',
              color: assetId ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
            }}>
            <option value="">— Unassigned —</option>
            {assetOptions.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}{a.unit ? ` #${a.unit}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {showBulk && (
        <label className="flex items-start gap-2 text-[12px] cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
          <input
            type="checkbox"
            checked={applyToSimilar}
            onChange={e => setApplyToSimilar(e.target.checked)}
            disabled={busy}
            style={{ marginTop: 2 }}
          />
          <span>
            Also apply to every other unmatched transaction from{' '}
            <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{t.driverName}</span>
            <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              Skips rows that already have a driver assigned (prior overrides are preserved).
            </div>
          </span>
        </label>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md transition-colors"
          style={{
            background: (busy || !dirty) ? 'var(--gc-bg)' : 'var(--gc-blue)',
            color:      (busy || !dirty) ? 'var(--gc-text-3)' : '#fff',
            border:     `1px solid ${(busy || !dirty) ? 'var(--gc-border-light)' : 'var(--gc-blue)'}`,
            padding:    '6px 14px',
            fontSize:   12,
            fontWeight: 600,
            cursor:     (busy || !dirty) ? 'default' : 'pointer',
          }}>
          {busy ? 'Saving…' : 'Save assignment'}
        </button>
        {savedMessage && (
          <span className="text-[12px] font-medium" style={{ color: '#166534' }}>{savedMessage}</span>
        )}
        {error && (
          <span className="text-[12px] font-medium" style={{ color: '#dc2626' }}>{error}</span>
        )}
      </div>
    </div>
  );
}

// ─── Panel helpers ────────────────────────────────────────────────────

// Field — label + value pair, mirrors MovementDetailPanel's helper.
// Used in the grid below the map. Uppercase 10px label, 12px value.
function Field({ icon, label, children, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-0.5${className ? ` ${className}` : ''}`}>
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
        {icon}{label}
      </div>
      <div style={{ color: 'var(--gc-text-1)' }}>{children}</div>
    </div>
  );
}

// FieldSection — top-bordered block under the grid for narrative
// content (description, photos, defect cards). Same vocabulary as
// the movements panel's footer area.
function FieldSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
      <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

// MapBlock — the top section of the panel body. Mirrors the
// MovementDetailPanel layout: fixed 320px height (smaller than the
// movements panel's 420 because our reports have more meta + photos
// to show below). Falls back to a "no GPS" placeholder when the
// report lacks coords.
function MapBlock({ lat, lon, state, height = 320 }: { lat: number | null | undefined; lon: number | null | undefined; state?: string; height?: number }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const hasCoords = lat != null && lon != null;
  useEffect(() => {
    if (!hasCoords || !mapContainer.current) return;
    let cancelled = false;
    loadGoogleMaps().then(google => {
      if (cancelled || !mapContainer.current) return;
      const map = new google.maps.Map(mapContainer.current, {
        center: { lat: lat as number, lng: lon as number },
        zoom: 13, mapId: MAP_ID,
        disableDefaultUI: false, clickableIcons: false,
        gestureHandling: 'greedy',
      });
      new google.maps.marker.AdvancedMarkerElement({
        position: { lat: lat as number, lng: lon as number },
        map,
      });
    });
    return () => { cancelled = true; };
  }, [lat, lon, hasCoords]);
  return (
    <div className="relative shrink-0" style={{ height }}>
      {hasCoords ? (
        <>
          <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
          <a
            href={`https://maps.google.com/?q=${lat},${lon}`}
            target="_blank" rel="noopener noreferrer"
            className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] font-medium rounded-md px-2 py-1"
            style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)', color: 'var(--gc-blue)', textDecoration: 'none' }}
          >
            <ExternalLink size={10} /> Open in Maps
          </a>
          {state && (
            <div className="absolute bottom-2 left-2 text-[10px] font-mono rounded px-1.5 py-0.5"
              style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-3)' }}>
              {(lat as number).toFixed(4)}, {(lon as number).toFixed(4)} · {state}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)' }}>
          <MapPin size={14} style={{ marginRight: 6 }} /> No GPS attached to this report
        </div>
      )}
    </div>
  );
}

// TwoColumnBody — splits the panel body into a fixed-width left
// column (map on top, media below) and a flex-1 right column for
// text. Used by all three detail components so the layout reads the
// same across maintenance / inspection / fuel: dispatcher's eye
// goes top-left for "where", bottom-left for "what evidence", and
// the entire right column for "the writeup".
function TwoColumnBody({
  mapLat, mapLon, mapState, media, onOpenMedia, children, leftWidth = 400,
}: {
  mapLat:   number | null | undefined;
  mapLon:   number | null | undefined;
  mapState?: string;
  /** Sections of media to render in the bottom-left. Each section
   *  has its own sub-label (item name, "General", etc.) so an
   *  inspection's photos stay attributable to which defect they
   *  belong to even though they're all collected here. */
  media: Array<{
    label?: string;
    photos: Array<{ id: string; signedUrl: string | null; caption: string | null }>;
  }>;
  onOpenMedia: (list: MediaList) => void;
  /** Right-column scrollable text content. */
  children: React.ReactNode;
  /** Left column width — defaults to 400 (was 340 when the panel
   *  was 780 wide; 920 - 400 right = 520 right column, healthy text
   *  space). Fuel passes 320 since receipts are usually 1-2 photos
   *  and the right column gets more horizontal density. */
  leftWidth?: number;
}) {
  const totalPhotos = media.reduce((n, sec) => n + sec.photos.length, 0);
  // Flatten every photo (with section label) so clicking any tile
  // can open the side panel pre-scrolled to that exact photo.
  const flatItems: MediaList['items'] = [];
  for (const sec of media) {
    for (const p of sec.photos) {
      flatItems.push({ id: p.id, signedUrl: p.signedUrl, caption: p.caption, section: sec.label });
    }
  }
  // If there's no GPS, give the media column the full left-column
  // height instead of a "No GPS" placeholder eating 280px. With
  // GPS, keep the original split (map on top, media below).
  const hasMap = mapLat != null && mapLon != null;
  return (
    <div className="flex-1 flex min-h-0">
      {/* Left column — map fixed on top (when GPS present), media below */}
      <div
        className="flex flex-col shrink-0"
        style={{ width: leftWidth, borderRight: '1px solid var(--gc-border-light)' }}
      >
        {hasMap && <MapBlock lat={mapLat} lon={mapLon} state={mapState} height={280} />}
        <div
          className="flex-1 overflow-y-auto px-3 py-3"
          style={{
            background: 'var(--gc-surface)',
            borderTop: hasMap ? '1px solid var(--gc-border-light)' : undefined,
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Media {totalPhotos > 0 ? `(${totalPhotos})` : ''}
          </div>
          {totalPhotos === 0 ? (
            <NoMediaPlaceholder />
          ) : (
            <div className="flex flex-col gap-3">
              {(() => {
                // Walk the same order we flattened so each tile knows
                // its index in flatItems and can open the side panel
                // at exactly that photo.
                let cursor = 0;
                return media.map((sec, i) => {
                  if (sec.photos.length === 0) return null;
                  return (
                    <div key={i}>
                      {sec.label && (
                        <div className="text-[10px] font-medium mb-1.5" style={{ color: 'var(--gc-text-2)' }}>
                          {sec.label}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {sec.photos.map(p => {
                          const myIdx = cursor++;
                          return p.signedUrl ? (
                            <button
                              key={p.id}
                              onClick={() => onOpenMedia({ initialIndex: myIdx, items: flatItems })}
                              title={p.caption ?? sec.label ?? 'View photo'}
                              style={{ padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={p.signedUrl} alt={p.caption ?? ''} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--gc-border)' }} />
                            </button>
                          ) : (
                            <div key={p.id} style={{ width: 96, height: 96, borderRadius: 8, background: 'var(--gc-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--gc-text-3)' }}>
                              no preview
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Right column — scrollable text */}
      <div className="flex-1 overflow-y-auto px-4 py-3 min-w-0">
        {children}
      </div>
    </div>
  );
}

// NoMediaPlaceholder — centered icon + label, used when a report
// arrived without any attached photos. Better than blank space.
function NoMediaPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center text-center" style={{ minHeight: 200 }}>
      <div
        className="rounded-full flex items-center justify-center mb-2"
        style={{ width: 48, height: 48, background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}
      >
        <Camera size={22} />
      </div>
      <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>No photos uploaded</div>
    </div>
  );
}

// MediaSidePanel — centered modal that layers above the main detail
// panel. Used to be a flex sibling; now it's an independent overlay
// (see DetailPanel for the wrapping). Click-outside on the overlay
// closes it; Esc handling lives in the parent so Esc closes this
// first before falling through to the detail panel.
function MediaSidePanel({ media, onClose }: { media: MediaList; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the photo the user clicked the moment the panel
  // mounts. Wrapped in a microtask so the layout has settled.
  useEffect(() => {
    if (!containerRef.current) return;
    const target = containerRef.current.querySelector<HTMLElement>(`[data-photo-idx="${media.initialIndex}"]`);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [media.initialIndex]);

  return (
    <div
      onClick={e => e.stopPropagation()}
      className="flex flex-col rounded-2xl overflow-hidden shrink-0"
      style={{ width: 'min(92vw, 720px)', height: 'min(92vh, 900px)', background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--gc-border)' }}>
        <Camera size={14} style={{ color: 'var(--gc-text-2)' }} />
        <div className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          Media ({media.items.length})
        </div>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1.5 rounded-full transition-colors shrink-0"
          style={{ color: 'var(--gc-text-3)' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
        >
          <X size={16} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-4"
        style={{ background: 'var(--gc-bg)' }}
      >
        <div className="flex flex-col gap-4">
          {media.items.map((item, idx) => (
            <div key={item.id} data-photo-idx={idx} className="flex flex-col gap-1.5">
              {item.section && (
                <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
                  {item.section}
                </div>
              )}
              {item.signedUrl ? (
                <a
                  href={item.signedUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open full size in new tab"
                  style={{ display: 'block', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--gc-border)' }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.signedUrl}
                    alt={item.caption ?? ''}
                    style={{ width: '100%', height: 'auto', objectFit: 'cover', display: 'block' }}
                  />
                </a>
              ) : (
                <div className="rounded-lg flex items-center justify-center text-[12px]"
                  style={{ height: 200, background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-3)' }}>
                  Preview unavailable
                </div>
              )}
              {item.caption && (
                <div className="text-[11px]" style={{ color: 'var(--gc-text-2)' }}>{item.caption}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// PhotoGrid + Lightbox removed — replaced by the in-line tile
// rendering inside TwoColumnBody (left column) plus the
// MediaSidePanel that opens to the right of the main panel for
// full-size browsing.

// ─── Helpers ──────────────────────────────────────────────────────────

function equipmentLabel(asset: string | null, trailer: string | null): string {
  if (asset && trailer) return `${asset} + ${trailer}`;
  return asset ?? trailer ?? '—';
}
// Resolve a maintenance report's equipment label (truck OR trailer)
// to the actual asset/trailer name. Falls back to the bare ID when
// the asset has been hard-deleted from the org but the report still
// references it.
function resolveEquipmentLabel(
  assetId: number | undefined,
  trailerId: number | undefined,
  assetLabelById: Map<number, string>,
  trailerLabelById: Map<number, string>,
): string {
  if (assetId)   return assetLabelById.get(assetId)     ?? `Asset #${assetId}`;
  if (trailerId) return `Trailer ${trailerLabelById.get(trailerId) ?? `#${trailerId}`}`;
  return '—';
}
// Resolve the driver's display name. Fuel + maintenance reports
// stored a junk submittedBy ("driver:30") for early bot/script
// flows. Prefer the live drivers list lookup; fall back to
// submittedBy only when the driver is gone (deleted/retired hard).
function resolveDriverName(driverId: number, submittedBy: string, driverNameById: Map<number, string>): string {
  const fromList = driverNameById.get(driverId);
  if (fromList) return fromList;
  // submittedBy looks like "driver:30" or similar junk → fall back to ID
  if (/^driver:\d+$/i.test(submittedBy.trim())) return `Driver #${driverId}`;
  return submittedBy || `Driver #${driverId}`;
}
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
