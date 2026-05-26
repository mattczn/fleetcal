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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  Package, Wrench, ClipboardCheck, Fuel as FuelIcon, AlertTriangle,
  Camera, Loader2, MapPin, X, Clock, User, Truck, FileText, ExternalLink, Activity, Check,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import ManagementHeader from '@/components/nav/ManagementHeader';
import type { Driver, Asset } from '@/lib/types';
import type { MaintenanceReport, FuelReport, FuelTransaction, MaintenanceReportPhoto, FuelReportPhoto } from '@fleetcal/types';
import { loadGoogleMaps, MAP_ID } from '@/lib/googleMaps';

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
type SortDir = 'desc' | 'asc';

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

// Combined equipment picker — same list covers trucks + trailers. The
// caller resolves the type+id from the selected value so the server
// query filters by asset_id or trailer_id correctly.
type EquipmentSelection = { kind: 'asset' | 'trailer'; id: number } | null;

// What a row knows for the right-side panel. Each tab maps its row
// shape onto this so the panel can render uniformly.
type PanelData = {
  kind: 'maintenance' | 'inspection' | 'fuel' | 'fuel_transaction';
  id: string;
  // ID used to fetch the full detail (for inspections — the list
  // doesn't carry the per-item checklist). Maintenance + Fuel already
  // ship complete rows, so this can re-use the list row directly.
} & (
  | { kind: 'maintenance';      report: MaintenanceReport }
  | { kind: 'fuel';             report: FuelReport }
  | { kind: 'fuel_transaction'; transaction: FuelTransaction }
  | { kind: 'inspection';       row: InspectionRow }
);

// ─── Page ─────────────────────────────────────────────────────────────

export default function EquipmentPage() {
  const searchParams = useSearchParams();
  const initialTab = (() => {
    const t = searchParams?.get('tab');
    return t === 'fuel' || t === 'maintenance' || t === 'inspections' ? t : 'maintenance';
  })();
  const [tab, setTab] = useState<Tab>(initialTab);

  // Filter state, shared across tabs so toggling tabs doesn't reset
  // the dispatcher's working set.
  const [driverId, setDriverId]     = useState<number | null>(null);
  const [equipment, setEquipment]   = useState<EquipmentSelection>(null);
  const [sortDir, setSortDir]       = useState<SortDir>('desc');

  // Filter dropdown data — fetched once. Used by both the Driver
  // dropdown and the Equipment dropdown (trucks + trailers merged).
  const [drivers, setDrivers]   = useState<Driver[]>([]);
  const [assets,   setAssets]   = useState<Asset[]>([]);
  const [trailers, setTrailers] = useState<Array<{ id: number; name: string; trailerNumber?: string; category: string }>>([]);

  useEffect(() => {
    Promise.allSettled([
      railway.listDrivers(),
      railway.listAssets(),
      railway.listTrailers(),
    ]).then(([d, a, t]) => {
      if (d.status === 'fulfilled') setDrivers(d.value.drivers as Driver[]);
      if (a.status === 'fulfilled') setAssets(a.value.assets as Asset[]);
      if (t.status === 'fulfilled') setTrailers(t.value.trailers as Array<{ id: number; name: string; trailerNumber?: string; category: string }>);
    });
  }, []);

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

  return (
    // h-screen (not min-h-screen) so the outer column has a FIXED
    // height equal to the viewport. Without that bound, the flex-1
    // tab-content child can grow past the viewport and the
    // overflow-y-auto on it never kicks in (the body's global
    // overflow:hidden then clips the bottom unreachable). Pages that
    // need to scroll inside a flex-1 child MUST use h-screen here,
    // not min-h-screen.
    <div className="h-screen flex flex-col" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Equipment" icon={Package} />

      {/* Tab bar */}
      <div className="px-6 pt-5 border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
        <div className="flex gap-1">
          <TabButton active={tab === 'maintenance'} onClick={() => setTab('maintenance')} icon={<Wrench size={15} />}         label="Maintenance" />
          <TabButton active={tab === 'inspections'} onClick={() => setTab('inspections')} icon={<ClipboardCheck size={15} />} label="Inspections" />
          <TabButton active={tab === 'fuel'}        onClick={() => setTab('fuel')}        icon={<FuelIcon size={15} />}       label="Fuel" />
        </div>
      </div>

      {/* Filters — common to all tabs */}
      <div className="px-6 pt-4 pb-3 flex items-center gap-3 flex-wrap border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
        <DriverFilter drivers={drivers} value={driverId} onChange={setDriverId} />
        <EquipmentFilter assets={assets} trailers={trailers} value={equipment} onChange={setEquipment} />
        <SortToggle dir={sortDir} onChange={setSortDir} />
        <div className="flex-1" />
        {(driverId != null || equipment != null) && (
          <button
            onClick={() => { setDriverId(null); setEquipment(null); }}
            className="text-xs font-semibold transition-colors"
            style={{ color: '#1a73e8' }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Tab content. min-h-0 lets the flex child shrink below its
          natural content height so overflow-y-auto can actually clip
          + scroll. Without min-h-0 the column blows past the viewport
          and gets cut off by body's global overflow:hidden, with no
          way to reach the bottom rows. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {tab === 'maintenance' && (
          <MaintenanceList
            driverId={driverId}
            equipment={equipment}
            sortDir={sortDir}
            driverNameById={driverNameById}
            assetLabelById={assetLabelById}
            trailerLabelById={trailerLabelById}
            onOpen={(r) => setPanel({ kind: 'maintenance', id: r.id, report: r })}
            openId={panel?.kind === 'maintenance' ? panel.id : null}
          />
        )}
        {tab === 'inspections' && (
          <InspectionsList
            driverId={driverId}
            equipment={equipment}
            sortDir={sortDir}
            onOpen={(r) => setPanel({ kind: 'inspection', id: r.id, row: r })}
            openId={panel?.kind === 'inspection' ? panel.id : null}
          />
        )}
        {tab === 'fuel' && (
          <FuelTabContent
            driverId={driverId}
            equipment={equipment}
            sortDir={sortDir}
            driverNameById={driverNameById}
            assetLabelById={assetLabelById}
            panel={panel}
            setPanel={setPanel}
          />
        )}
      </div>

      {panel && (
        <DetailPanel
          panel={panel}
          driverNameById={driverNameById}
          assetLabelById={assetLabelById}
          trailerLabelById={trailerLabelById}
          sideMedia={sideMedia}
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

// ─── Filters ──────────────────────────────────────────────────────────

function DriverFilter({ drivers, value, onChange }: { drivers: Driver[]; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <FilterDropdown label="Driver">
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
        className="text-sm rounded px-2 py-1.5 outline-none"
        style={{ background: 'var(--gc-panel-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', minWidth: 160 }}
      >
        <option value="">All drivers</option>
        {drivers
          .filter(d => !d.activeTo) // hide retired
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          .map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
      </select>
    </FilterDropdown>
  );
}

function EquipmentFilter({
  assets, trailers, value, onChange,
}: {
  assets: Asset[];
  trailers: Array<{ id: number; name: string; trailerNumber?: string }>;
  value: EquipmentSelection;
  onChange: (v: EquipmentSelection) => void;
}) {
  // Encode selection as "asset:123" / "trailer:456" so a single
  // <select> drives both filter dimensions.
  const selectedValue = value ? `${value.kind}:${value.id}` : '';
  return (
    <FilterDropdown label="Equipment">
      <select
        value={selectedValue}
        onChange={e => {
          const raw = e.target.value;
          if (!raw) return onChange(null);
          const [kind, idStr] = raw.split(':');
          if (kind !== 'asset' && kind !== 'trailer') return onChange(null);
          onChange({ kind: kind as 'asset' | 'trailer', id: Number(idStr) });
        }}
        className="text-sm rounded px-2 py-1.5 outline-none"
        style={{ background: 'var(--gc-panel-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', minWidth: 200 }}
      >
        <option value="">All equipment</option>
        <optgroup label="Trucks">
          {assets
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .map(a => (
              <option key={`asset:${a.id}`} value={`asset:${a.id}`}>
                Truck {a.name}{a.unit ? ` #${a.unit}` : ''}
              </option>
            ))}
        </optgroup>
        <optgroup label="Trailers">
          {trailers
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .map(t => (
              <option key={`trailer:${t.id}`} value={`trailer:${t.id}`}>
                Trailer {t.trailerNumber ? `#${t.trailerNumber}` : t.name}
              </option>
            ))}
        </optgroup>
      </select>
    </FilterDropdown>
  );
}

function SortToggle({ dir, onChange }: { dir: SortDir; onChange: (d: SortDir) => void }) {
  return (
    <FilterDropdown label="Sort">
      <button
        onClick={() => onChange(dir === 'desc' ? 'asc' : 'desc')}
        className="text-sm rounded px-2 py-1.5 outline-none"
        style={{ background: 'var(--gc-panel-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}
      >
        Date {dir === 'desc' ? '↓ newest' : '↑ oldest'}
      </button>
    </FilterDropdown>
  );
}

function FilterDropdown({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      {children}
    </div>
  );
}

// ─── Maintenance ──────────────────────────────────────────────────────

const PAGE_SIZE = 25;

function MaintenanceList({
  driverId, equipment, sortDir, driverNameById, assetLabelById, trailerLabelById, onOpen, openId,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  onOpen: (r: MaintenanceReport) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<MaintenanceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Reset to first page whenever filters change so the dispatcher
  // doesn't end up looking at an empty page 4.
  useEffect(() => { setPage(0); }, [driverId, equipment, sortDir]);

  useEffect(() => {
    setLoading(true);
    railway.listMaintenanceReports({
      limit: 200,
      driverId: driverId ?? undefined,
      assetId:   equipment?.kind === 'asset'   ? equipment.id : undefined,
      trailerId: equipment?.kind === 'trailer' ? equipment.id : undefined,
    })
      .then(r => setRows(r.reports))
      .catch(err => { console.error('[equipment] maintenance:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, [driverId, equipment]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => sortDir === 'desc'
      ? b.reportedAt.localeCompare(a.reportedAt)
      : a.reportedAt.localeCompare(b.reportedAt));
    return copy;
  }, [rows, sortDir]);
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <TableShell
      loading={loading}
      empty={sorted.length === 0}
      emptyLabel="No maintenance reports match the current filters."
      headers={['Date', 'Driver', 'Equipment', 'Description', 'Status']}
      count={sorted.length}
      page={page} pageSize={PAGE_SIZE} onPageChange={setPage}
    >
      {pageRows.map(r => {
        // Prefer API-embedded names (see comment in FuelList).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const embedded = r as any;
        const driverLabel = embedded.driverName as string | undefined
          ?? resolveDriverName(r.driverId, r.submittedBy, driverNameById);
        const equipmentLabel = (embedded.assetName as string | undefined)
          ?? (embedded.trailerName ? `Trailer ${embedded.trailerName}` : undefined)
          ?? resolveEquipmentLabel(r.assetId, r.trailerId, assetLabelById, trailerLabelById);
        return (
          <Row key={r.id} onClick={() => onOpen(r)} active={openId === r.id}>
            <Cell><DateCell iso={r.reportedAt} /></Cell>
            <Cell>{driverLabel}</Cell>
            <Cell>{equipmentLabel}</Cell>
            <Cell>
              <span style={{ color: 'var(--gc-text-1)' }}>
                {r.description.length > 70 ? r.description.slice(0, 70) + '…' : r.description}
              </span>
            </Cell>
            <Cell><StatusPill status={r.status} /></Cell>
          </Row>
        );
      })}
    </TableShell>
  );
}

// ─── Inspections ──────────────────────────────────────────────────────

function InspectionsList({
  driverId, equipment, sortDir, onOpen, openId,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  onOpen: (r: InspectionRow) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<InspectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [defectsOnly, setDefectsOnly] = useState(false);
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [driverId, equipment, sortDir, defectsOnly]);

  useEffect(() => {
    setLoading(true);
    railway.listInspectionReports({
      limit: 200,
      defectsOnly,
      driverId: driverId ?? undefined,
      assetId:   equipment?.kind === 'asset'   ? equipment.id : undefined,
      trailerId: equipment?.kind === 'trailer' ? equipment.id : undefined,
    })
      .then(r => setRows(r.inspections))
      .catch(err => { console.error('[equipment] inspections:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, [driverId, equipment, defectsOnly]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => sortDir === 'desc'
      ? b.submittedAt.localeCompare(a.submittedAt)
      : a.submittedAt.localeCompare(b.submittedAt));
    return copy;
  }, [rows, sortDir]);
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
          <input type="checkbox" checked={defectsOnly} onChange={e => setDefectsOnly(e.target.checked)} />
          Defects only
        </label>
      </div>
      <TableShell
        loading={loading}
        empty={sorted.length === 0}
        emptyLabel={defectsOnly ? 'No inspections with defects match the current filters.' : 'No inspections match the current filters.'}
        headers={['Date', 'Driver', 'Equipment', 'Items', 'Photos']}
        count={sorted.length}
        page={page} pageSize={PAGE_SIZE} onPageChange={setPage}
      >
        {pageRows.map(r => (
          <Row key={r.id} onClick={() => onOpen(r)} active={openId === r.id}>
            <Cell><DateCell iso={r.submittedAt} /></Cell>
            <Cell>{r.driverName}</Cell>
            <Cell>{equipmentLabel(r.assetName, r.trailerName)}</Cell>
            <Cell>
              {r.hasDefects ? (
                <Badge color="red" icon={<AlertTriangle size={11} />}>
                  {r.defectCount} defect{r.defectCount === 1 ? '' : 's'}
                </Badge>
              ) : (
                <span className="text-xs" style={{ color: '#16a34a' }}>✓ All clear ({r.itemCount})</span>
              )}
            </Cell>
            <Cell>
              {r.photoCount > 0 ? (
                <Badge color="blue" icon={<Camera size={11} />}>{r.photoCount}</Badge>
              ) : (
                <span className="text-xs" style={{ color: 'var(--gc-text-3)' }}>—</span>
              )}
            </Cell>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

// ─── Fuel ─────────────────────────────────────────────────────────────

function FuelList({
  driverId, equipment, sortDir, driverNameById, assetLabelById, onOpen, openId,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  onOpen: (r: FuelReport) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<FuelReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [driverId, equipment, sortDir]);

  useEffect(() => {
    setLoading(true);
    railway.listFuelReports({
      limit: 200,
      driverId: driverId ?? undefined,
      assetId:   equipment?.kind === 'asset' ? equipment.id : undefined,
      // fuel-reports endpoint doesn't filter by trailerId — fuel ups
      // are always on a truck. When a trailer filter is active, just
      // show empty (no fuel rows belong to trailers).
    })
      .then(r => setRows(equipment?.kind === 'trailer' ? [] : r.fuelReports))
      .catch(err => { console.error('[equipment] fuel:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, [driverId, equipment]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => sortDir === 'desc'
      ? b.reportedAt.localeCompare(a.reportedAt)
      : a.reportedAt.localeCompare(b.reportedAt));
    return copy;
  }, [rows, sortDir]);
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <TableShell
      loading={loading}
      empty={sorted.length === 0}
      emptyLabel={equipment?.kind === 'trailer' ? 'Fuel reports are always on trucks — switch the equipment filter.' : 'No fuel reports match the current filters.'}
      headers={['Date', 'Driver', 'Equipment', 'State', 'Diesel (gal)']}
      count={sorted.length}
      page={page} pageSize={PAGE_SIZE} onPageChange={setPage}
    >
      {pageRows.map(r => {
        // Prefer the names the API joined into the response —
        // they're authoritative and don't depend on a separate
        // /v1/drivers + /v1/assets fetch having completed yet.
        // Fall back to the page-level maps (for cached responses)
        // then to the bare ID as final resort.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const embedded = r as any;
        const driverLabel = embedded.driverName as string | undefined
          ?? resolveDriverName(r.driverId, r.submittedBy, driverNameById);
        const assetLabel  = embedded.assetName as string | undefined
          ?? assetLabelById.get(r.assetId)
          ?? `Asset #${r.assetId}`;
        return (
          <Row key={r.id} onClick={() => onOpen(r)} active={openId === r.id}>
            <Cell><DateCell iso={r.reportedAt} /></Cell>
            <Cell>{driverLabel}</Cell>
            <Cell>{assetLabel}</Cell>
            <Cell>{r.state}</Cell>
            <Cell><span className="font-mono">{r.dieselGallons.toFixed(1)}</span></Cell>
          </Row>
        );
      })}
    </TableShell>
  );
}

// ─── Fuel tab content (sub-tab toggle wrapping FuelList + FuelTransactionsList) ───
//
// The Fuel tab has two complementary data sources:
//   • Driver reports — submitted via the driver app at the pump
//   • Card transactions — ingested from Mudflap receipt emails
//
// A sub-tab toggle here lets the dispatcher flip between them without
// leaving the Fuel surface. Both columns share the existing global
// filters (driver + equipment + sort) so flipping tabs feels like
// just a different lens on the same data set.

type FuelSubTab = 'reports' | 'transactions';

function FuelTabContent({
  driverId, equipment, sortDir, driverNameById, assetLabelById,
  panel, setPanel,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  panel: PanelData | null;
  setPanel: (p: PanelData | null) => void;
}) {
  const [subTab, setSubTab] = useState<FuelSubTab>('reports');
  return (
    <div className="flex flex-col" style={{ gap: 12 }}>
      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        <SubTabButton active={subTab === 'reports'}      onClick={() => setSubTab('reports')}      label="Driver Reports" />
        <SubTabButton active={subTab === 'transactions'} onClick={() => setSubTab('transactions')} label="Card Transactions" />
      </div>

      {subTab === 'reports' ? (
        <FuelList
          driverId={driverId}
          equipment={equipment}
          sortDir={sortDir}
          driverNameById={driverNameById}
          assetLabelById={assetLabelById}
          onOpen={(r) => setPanel({ kind: 'fuel', id: r.id, report: r })}
          openId={panel?.kind === 'fuel' ? panel.id : null}
        />
      ) : (
        <FuelTransactionsList
          sortDir={sortDir}
          onOpen={(t) => setPanel({ kind: 'fuel_transaction', id: t.id, transaction: t })}
          openId={panel?.kind === 'fuel_transaction' ? panel.id : null}
        />
      )}
    </div>
  );
}

function SubTabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 text-[12px] font-semibold transition-colors"
      style={{
        color: active ? '#1a73e8' : 'var(--gc-text-3)',
        borderBottom: active ? '2px solid #1a73e8' : '2px solid transparent',
        marginBottom: -1,
      }}>
      {label}
    </button>
  );
}

// ─── Card transactions list ──────────────────────────────────────────
//
// Read-only listing of fuel_transactions ingested from Mudflap.
// Columns mirror the receipt: date, driver name (as printed on the
// receipt, not the driver_id lookup), location/station, diesel gal,
// total $, and a match-status pill showing whether the row is paired
// with a driver-submitted fuel_report.
//
// The global driver / equipment filters don't apply here — card
// transactions don't carry our driver_id or asset_id fields (the
// receipt only has free-text driver_name and no truck unit number).
// Filtering happens via the match-status dropdown at the top of the
// list instead.

function FuelTransactionsList({
  sortDir, onOpen, openId,
}: {
  sortDir: SortDir;
  onOpen: (t: FuelTransaction) => void;
  openId: string | null;
}) {
  const [rows, setRows]       = useState<FuelTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(0);
  const [matchFilter, setMatchFilter] =
    useState<'all' | 'unmatched' | 'auto_matched' | 'manual_matched' | 'no_match_needed'>('all');

  useEffect(() => { setPage(0); }, [matchFilter, sortDir]);

  useEffect(() => {
    setLoading(true);
    railway.listFuelTransactions({
      matchStatus: matchFilter === 'all' ? undefined : matchFilter,
      limit:       500,
    })
      .then(r => setRows(r.fuelTransactions))
      .catch(err => { console.error('[equipment] fuel-tx:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, [matchFilter]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => sortDir === 'desc'
      ? b.transactionDate.localeCompare(a.transactionDate)
      : a.transactionDate.localeCompare(b.transactionDate));
    return copy;
  }, [rows, sortDir]);
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {/* Match-status filter — feels at home above the table.
          Defaults to All so the dispatcher sees everything; if they
          want a working queue, they pick Unmatched. */}
      <div className="flex items-center gap-2 text-[12px]">
        <span style={{ color: 'var(--gc-text-3)' }}>Match:</span>
        {([
          { v: 'all',             label: 'All' },
          { v: 'unmatched',       label: 'Unmatched' },
          { v: 'auto_matched',    label: 'Auto' },
          { v: 'manual_matched',  label: 'Manual' },
          { v: 'no_match_needed', label: 'No match' },
        ] as const).map(opt => (
          <button key={opt.v}
            onClick={() => setMatchFilter(opt.v)}
            className="px-2 py-1 rounded transition-colors"
            style={{
              border: '1px solid var(--gc-border)',
              background: matchFilter === opt.v ? '#1a73e8' : 'var(--gc-surface)',
              color:      matchFilter === opt.v ? '#fff'   : 'var(--gc-text-2)',
              fontWeight: 600,
            }}>
            {opt.label}
          </button>
        ))}
      </div>

      <TableShell
        loading={loading}
        empty={sorted.length === 0}
        emptyLabel={
          matchFilter === 'unmatched'
            ? 'Everything is matched — no card transactions waiting for a driver report.'
            : 'No card transactions in this filter.'
        }
        headers={['Date', 'Driver (on receipt)', 'Location', 'Diesel (gal)', 'Total', 'Match']}
        count={sorted.length}
        page={page} pageSize={PAGE_SIZE} onPageChange={setPage}
      >
        {pageRows.map(t => (
          <Row key={t.id} onClick={() => onOpen(t)} active={openId === t.id}>
            <Cell><DateCell iso={t.transactionDate} /></Cell>
            <Cell>{t.driverName ?? <Muted>—</Muted>}</Cell>
            <Cell>{t.location ?? <Muted>—</Muted>}</Cell>
            <Cell><span className="font-mono">{t.dieselGallons != null ? t.dieselGallons.toFixed(1) : '—'}</span></Cell>
            <Cell><span className="font-mono">{`$${t.totalCharged.toFixed(2)}`}</span></Cell>
            <Cell><MatchStatusPill status={t.matchStatus} confidence={t.matchConfidence} /></Cell>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)' }}>{children}</span>;
}

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

// ─── Centered detail panel ───────────────────────────────────────────
//
// Styled to match MovementDetailPanel from the calendar so the panels
// across the app read as one design language: 780×660 light surface,
// rounded-2xl, dimmed backdrop, header with a colored category dot +
// title + close button, scrollable body with field grid + map +
// photos. Portal to document.body to escape any transformed ancestor
// containing block.

function DetailPanel({
  panel, driverNameById, assetLabelById, trailerLabelById,
  sideMedia, onClose, onOpenMedia, onCloseSideMedia,
}: {
  panel: PanelData;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  trailerLabelById: Map<number, string>;
  sideMedia: MediaList | null;
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

  // Each report type gets its own header dot + title — gives the
  // dispatcher a one-glance signal of what kind of report they
  // opened. Colors match the tab icons.
  const meta = panel.kind === 'maintenance'
    ? { color: '#f59e0b', title: 'Maintenance report' }
    : panel.kind === 'inspection'
    ? { color: '#1a73e8', title: 'Inspection report' }
    : panel.kind === 'fuel_transaction'
    ? { color: '#0ea5e9', title: 'Card transaction (Mudflap)' }
    : { color: '#16a34a', title: 'Fuel report' };

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: 'rgba(0,0,0,0.45)',
        zIndex: 1000,
        // When the side media panel is open, render it as a flex
        // SIBLING of the main panel so they sit side-by-side and
        // both are centered as a group. The earlier rendering had
        // the media panel as a separate fixed overlay which is why
        // it ended up unattached in the corner of the viewport.
        gap: sideMedia ? 12 : 0,
        // Padding so the two-panel combo (920 + 12 + 520 = 1452px)
        // doesn't pin to the screen edges on common widths.
        padding: 24,
      }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="relative flex flex-col rounded-2xl overflow-hidden shrink-0"
        style={{ width: 920, height: 720, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
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
          {panel.kind === 'maintenance'      && <MaintenanceDetail      report={panel.report}      driverNameById={driverNameById} assetLabelById={assetLabelById} trailerLabelById={trailerLabelById} onOpenMedia={onOpenMedia} />}
          {panel.kind === 'inspection'       && <InspectionDetail       id={panel.id}                                                                                                              onOpenMedia={onOpenMedia} />}
          {panel.kind === 'fuel'             && <FuelDetail             report={panel.report}      driverNameById={driverNameById} assetLabelById={assetLabelById}                                       onOpenMedia={onOpenMedia} />}
          {panel.kind === 'fuel_transaction' && <FuelTransactionDetail  transaction={panel.transaction}                                                                                              />}
        </div>
      </div>

      {/* Side media panel — flex sibling of the main panel so they
          sit attached side-by-side. Same surface + height as main
          so the visual reads as one paired modal. */}
      {sideMedia && (
        <MediaSidePanel
          media={sideMedia}
          onClose={onCloseSideMedia}
        />
      )}
    </div>
  );

  // Portal so the fixed overlay isn't clipped by an ancestor's
  // containing block (transforms / filters / contain). Same pattern
  // as MovementDetailPanel.
  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
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
  if (loading) return <div className="flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} /></div>;
  if (!data)   return <div className="text-sm px-4 py-6" style={{ color: '#dc2626' }}>Could not load report.</div>;

  // Split defects + general photos by the equipment they belong to.
  // Inspections cover one truck and possibly one trailer at the same
  // time; the dispatcher needs to see at a glance which physical
  // piece each defect is on. Keeps the audit/maintenance triage
  // workflow clean — "fix everything on Trailer #5567" vs. "fix
  // everything on Truck Big Red" without re-reading each item.
  const truckDefects   = data.items.filter(i => i.status === 'fail');
  const trailerDefects = data.trailerItems.filter(i => i.status === 'fail');
  const totalDefects   = truckDefects.length + trailerDefects.length;
  const passCount      = data.items.length + data.trailerItems.length - totalDefects;

  const truckLabel   = data.asset   ? `Truck ${data.asset.name}${data.asset.unit ? ` #${data.asset.unit}` : ''}` : 'Truck';
  const trailerLabel = data.trailer ? `Trailer ${data.trailer.trailer_number ? `#${data.trailer.trailer_number}` : data.trailer.name}` : 'Trailer';

  // Build the media sections for the left-column gallery. Order
  // matches the right-column reading order so a dispatcher scanning
  // the right can scan the left in lockstep:
  //   per-defect photos (in defect-row order), then general photos.
  const mediaSections: Array<{ label?: string; photos: { id: string; signedUrl: string | null; caption: string | null }[] }> = [];
  // Truck per-defect photos
  for (const def of truckDefects) {
    const itemPhotos = data.photos.filter(p => p.itemId === def.id);
    if (itemPhotos.length > 0) {
      mediaSections.push({
        label: `${truckLabel} · ${def.label}`,
        photos: itemPhotos.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption ?? def.label })),
      });
    }
  }
  // Trailer per-defect photos
  for (const def of trailerDefects) {
    const itemPhotos = data.photos.filter(p => p.itemId === def.id);
    if (itemPhotos.length > 0) {
      mediaSections.push({
        label: `${trailerLabel} · ${def.label}`,
        photos: itemPhotos.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption ?? def.label })),
      });
    }
  }
  // General (non-item) photos grouped by target.
  const truckGeneral   = data.photos.filter(p => p.itemId == null && p.target === 'truck');
  const trailerGeneral = data.photos.filter(p => p.itemId == null && p.target === 'trailer');
  const orphanGeneral  = data.photos.filter(p => p.itemId == null && p.target == null);
  if (truckGeneral.length > 0) {
    mediaSections.push({
      label: `${truckLabel} · General`,
      photos: truckGeneral.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })),
    });
  }
  if (trailerGeneral.length > 0) {
    mediaSections.push({
      label: `${trailerLabel} · General`,
      photos: trailerGeneral.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })),
    });
  }
  if (orphanGeneral.length > 0) {
    mediaSections.push({
      label: 'General',
      photos: orphanGeneral.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption })),
    });
  }

  return (
    <TwoColumnBody
      mapLat={data.locationLat}
      mapLon={data.locationLon}
      media={mediaSections}
      onOpenMedia={onOpenMedia}
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
        <Field icon={<Clock size={12} />} label="Submitted">{new Date(data.submittedAt).toLocaleString()}</Field>
        <Field icon={<User  size={12} />} label="Signed by">{data.signedBy}</Field>
        <Field icon={<Clock size={12} />} label="Duration">{data.durationSeconds != null ? fmtDuration(data.durationSeconds) : '—'}</Field>
        <Field icon={<Truck size={12} />} label="Items">{passCount} passed · {totalDefects} failed</Field>
        <Field icon={<Truck size={12} />} label="Truck">
          {data.asset ? `${data.asset.name}${data.asset.unit ? ` #${data.asset.unit}` : ''}` : '—'}
        </Field>
        <Field icon={<Truck size={12} />} label="Trailer">
          {data.trailer ? `${data.trailer.name}${data.trailer.trailer_number ? ` #${data.trailer.trailer_number}` : ''}` : '—'}
        </Field>
      </div>

      {data.asset && truckDefects.length > 0 && (
        <EquipmentDefectsSection equipmentLabel={truckLabel} defects={truckDefects} />
      )}
      {data.trailer && trailerDefects.length > 0 && (
        <EquipmentDefectsSection equipmentLabel={trailerLabel} defects={trailerDefects} />
      )}
      {totalDefects === 0 && <AllPassedBadge passCount={passCount} />}

      {data.notes && (
        <FieldSection label="Driver notes">
          <p className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>{data.notes}</p>
        </FieldSection>
      )}
    </TwoColumnBody>
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

function FuelDetail({
  report, driverNameById, assetLabelById, onOpenMedia,
}: {
  report: FuelReport;
  driverNameById: Map<number, string>;
  assetLabelById: Map<number, string>;
  onOpenMedia: (list: MediaList) => void;
}) {
  const mediaSections: Array<{ label?: string; photos: { id: string; signedUrl: string | null; caption: string | null }[] }> = [];
  if (report.photos && report.photos.length > 0) {
    mediaSections.push({
      label: 'Receipts',
      photos: report.photos.map((p: FuelReportPhoto) => ({ id: p.id, signedUrl: p.signedUrl ?? null, caption: null })),
    });
  }
  return (
    <TwoColumnBody
      mapLat={report.latitude}
      mapLon={report.longitude}
      mapState={report.state}
      media={mediaSections}
      onOpenMedia={onOpenMedia}
      // Narrower media column for fuel — receipts are typically
      // one or two photos. Gives the meta grid the wider right
      // column it needs to keep numbers (diesel, odometer) on one
      // line and the asset name un-truncated.
      leftWidth={320}
    >
      {/* 3-col grid uses the wider right column. Fuel has no defect
          cards / notes so the meta is everything the dispatcher sees;
          giving each field more horizontal room keeps numbers
          (diesel, odometer) on one line. */}
      <div className="grid grid-cols-3 gap-x-5 gap-y-3 text-[12px]">
        <Field icon={<Clock size={12} />} label="Reported">{new Date(report.reportedAt).toLocaleString()}</Field>
        <Field icon={<User  size={12} />} label="Driver">{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (report as any).driverName as string
          ?? resolveDriverName(report.driverId, report.submittedBy, driverNameById)
        }</Field>
        <Field icon={<Truck size={12} />} label="Asset">{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (report as any).assetName as string
          ?? assetLabelById.get(report.assetId)
          ?? `Asset #${report.assetId}`
        }</Field>
        <Field icon={<MapPin size={12} />} label="State">{report.state}</Field>
        <Field icon={<FuelIcon size={12} />} label="Diesel">{report.dieselGallons.toFixed(2)} gal</Field>
        <Field icon={<FuelIcon size={12} />} label="DEF">{report.defGallons != null ? `${report.defGallons.toFixed(2)} gal` : '—'}</Field>
        <Field icon={<Activity size={12} />} label="Odometer">{report.odometer != null ? `${report.odometer.toLocaleString()} mi` : '—'}</Field>
      </div>
    </TwoColumnBody>
  );
}

// ─── Fuel transaction detail ────────────────────────────────────────
//
// Simpler than the other detail panels — no map (no GPS on the
// receipt), no photos, no defect cards. Just the fields we ingested
// from the email + the match status. The two-column TwoColumnBody
// would feel empty here, so we use a single-column scroll body.

function FuelTransactionDetail({ transaction: initial }: { transaction: FuelTransaction }) {
  // Local mutable copy of the transaction so manual link / unlink
  // / no-match actions can refresh the displayed match status without
  // re-fetching the whole list. Falls back to the prop when the user
  // opens a different transaction.
  const [t, setT] = useState<FuelTransaction>(initial);
  useEffect(() => { setT(initial); }, [initial]);

  return (
    <div className="flex-1 overflow-auto px-5 py-4" style={{ background: 'var(--gc-bg)' }}>
      <div className="grid grid-cols-3 gap-x-5 gap-y-3 text-[12px]" style={{ maxWidth: 720 }}>
        <Field icon={<Clock size={12} />} label="Purchase date">{new Date(t.transactionDate).toLocaleDateString()}</Field>
        <Field icon={<User  size={12} />} label="Driver (on receipt)">{t.driverName ?? <Muted>—</Muted>}</Field>
        <Field icon={<FuelIcon size={12} />} label="Provider">{t.provider}</Field>

        <Field icon={<Package size={12} />} label="Location" className="col-span-3">{t.location ?? <Muted>—</Muted>}</Field>

        <Field icon={<FuelIcon size={12} />} label="Diesel gallons">{t.dieselGallons != null ? t.dieselGallons.toFixed(3) : <Muted>—</Muted>}</Field>
        <Field icon={<FuelIcon size={12} />} label="Diesel retail $/gal">{t.dieselRetailPrice != null ? `$${t.dieselRetailPrice.toFixed(4)}` : <Muted>—</Muted>}</Field>
        <Field icon={<FuelIcon size={12} />} label="Diesel Mudflap $/gal">{t.dieselDiscountPrice != null ? `$${t.dieselDiscountPrice.toFixed(4)}` : <Muted>—</Muted>}</Field>

        <Field icon={<FuelIcon size={12} />} label="DEF gallons">{t.defGallons != null ? t.defGallons.toFixed(3) : <Muted>—</Muted>}</Field>
        <Field icon={<FuelIcon size={12} />} label="DEF retail $/gal">{t.defRetailPrice != null ? `$${t.defRetailPrice.toFixed(4)}` : <Muted>—</Muted>}</Field>
        <Field icon={<FuelIcon size={12} />} label="DEF Mudflap $/gal">{t.defDiscountPrice != null ? `$${t.defDiscountPrice.toFixed(4)}` : <Muted>—</Muted>}</Field>

        <Field icon={<Clock size={12} />} label="Total charged"><span className="font-mono">{`$${t.totalCharged.toFixed(2)}`}</span></Field>
        <Field icon={<Clock size={12} />} label="Saved"><span className="font-mono">{`$${(t.totalSaved ?? 0).toFixed(2)}`}</span></Field>
        <Field icon={<Clock size={12} />} label="Payment last 4">{t.paymentLast4 ?? <Muted>—</Muted>}</Field>
      </div>

      <FieldSection label="Match status">
        <div className="flex items-center gap-2 text-[12px]">
          <MatchStatusPill status={t.matchStatus} confidence={t.matchConfidence} />
          {t.matchedAt && (
            <span style={{ color: 'var(--gc-text-3)' }}>
              {t.matchStatus === 'auto_matched' ? 'Auto-linked' : 'Linked'} {new Date(t.matchedAt).toLocaleString()}
            </span>
          )}
        </div>
        {t.matchNotes && (
          <div className="text-[11px] mt-2" style={{ color: 'var(--gc-text-3)' }}>{t.matchNotes}</div>
        )}

        {/* Match controls — render different affordances based on state. */}
        <MatchControls transaction={t} onChange={setT} />
      </FieldSection>

      <FieldSection label="Provenance">
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-[11px]">
          <Field icon={<FuelIcon size={11} />} label="Provider txn id"><span className="font-mono break-all">{t.providerTransactionId}</span></Field>
          <Field icon={<Clock size={11} />} label="Created in FleetCal">{new Date(t.createdAt).toLocaleString()}</Field>
          {t.legacyFormResponseId != null && (
            <Field icon={<FuelIcon size={11} />} label="Legacy form id">{t.legacyFormResponseId}</Field>
          )}
        </div>
      </FieldSection>
    </div>
  );
}

// ─── Match controls (link / unlink / no-match) ───────────────────────
//
// Behaviour:
//   • If the transaction is already linked to a fuel_report: show a
//     summary of the linked report + an Unlink button.
//   • If unmatched: show a "Find driver report to link" button that
//     opens a candidate list (fuel_reports within ±3 days of the
//     transaction date). Each candidate has a Link button. Also offers
//     "Mark as no driver report needed" for cases where dispatch
//     confirms there's no app submission to pair with.

function MatchControls({
  transaction: t,
  onChange,
}: {
  transaction: FuelTransaction;
  onChange: (next: FuelTransaction) => void;
}) {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function callMatch(fuelReportId: string | null, notes?: string) {
    setBusy(true); setError(null);
    try {
      const res = await railway.matchFuelTransaction(t.id, { fuelReportId, matchNotes: notes });
      onChange(res.fuelTransaction);
    } catch (err) {
      setError((err as Error).message ?? 'failed');
    } finally {
      setBusy(false);
    }
  }

  if (t.fuelReportId) {
    return (
      <div className="mt-3">
        <LinkedReportRow reportId={t.fuelReportId} />
        <div className="flex items-center gap-2 mt-2">
          <button
            disabled={busy}
            onClick={() => void callMatch(null)}
            className="text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors disabled:opacity-50"
            style={{ background: 'var(--gc-surface)', color: '#dc2626', border: '1px solid #fecaca' }}
          >
            Unlink
          </button>
        </div>
        {error && <div className="text-[11px] mt-2" style={{ color: '#dc2626' }}>{error}</div>}
      </div>
    );
  }

  // Unmatched. Show candidate finder.
  return (
    <div className="mt-3 flex flex-col gap-2">
      <CandidatePicker
        transactionDate={t.transactionDate}
        targetGallons={t.dieselGallons}
        busy={busy}
        onPick={(reportId) => void callMatch(reportId)}
      />
      <button
        disabled={busy}
        onClick={() => {
          // Mark no-match-needed. The server treats this as 'no_match_needed'
          // when fuelReportId is null AND matchNotes mentions skip — we use
          // the matchNotes field as the signal here. (The API can be
          // extended later with an explicit field if we want fancier UX.)
          // For now we just leave the row "unlinked" but in a more
          // intentional state — see API: PATCH /match with null reports.
          // To mark 'no_match_needed', we pass null + a sentinel note.
          void callMatch(null, 'no driver report exists');
        }}
        className="text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors disabled:opacity-50 self-start"
        style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}
      >
        Mark as no driver report needed
      </button>
      {error && <div className="text-[11px]" style={{ color: '#dc2626' }}>{error}</div>}
    </div>
  );
}

// Renders the linked driver report inline. Best-effort fetch — if it
// fails (deleted report, etc.) we just show the id so the dispatcher
// can investigate.
function LinkedReportRow({ reportId }: { reportId: string }) {
  const [report, setReport] = useState<FuelReport | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Use listFuelReports filtered by no specific arg — easiest path
    // since there's no /v1/fuel-reports/:id endpoint exposed yet. The
    // report carries driverId/assetId; we'll show them as-is.
    railway.listFuelReports({ limit: 500 })
      .then(r => {
        if (cancelled) return;
        const found = r.fuelReports.find(x => x.id === reportId);
        setReport(found ?? null);
      })
      .catch(err => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [reportId]);
  if (error) {
    return <div className="text-[11px] mt-2" style={{ color: 'var(--gc-text-3)' }}>Linked: <span className="font-mono">{reportId}</span> (couldn&apos;t fetch details: {error})</div>;
  }
  if (!report) {
    return <div className="text-[11px] mt-2" style={{ color: 'var(--gc-text-3)' }}>Loading linked report…</div>;
  }
  return (
    <div className="rounded p-2.5 mt-2" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <div className="text-[11px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
        Linked driver report
      </div>
      <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-2)' }}>
        Reported {new Date(report.reportedAt).toLocaleString()} · {report.dieselGallons.toFixed(1)} diesel gal{report.state ? ` · ${report.state}` : ''}
      </div>
      <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
        Driver #{report.driverId} · Asset #{report.assetId}
      </div>
    </div>
  );
}

// Loads pending fuel_reports within ±3 days of the transaction date
// and renders them as a list with a Link button on each. Sorts by
// gallons-closeness to targetGallons so the most likely match is at
// the top.
function CandidatePicker({
  transactionDate, targetGallons, busy, onPick,
}: {
  transactionDate: string;
  targetGallons:   number | null | undefined;
  busy:            boolean;
  onPick:          (reportId: string) => void;
}) {
  const [open,    setOpen]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows,    setRows]    = useState<FuelReport[]>([]);
  const [error,   setError]   = useState<string | null>(null);

  async function loadCandidates() {
    setLoading(true); setError(null);
    try {
      const fromD = new Date(transactionDate); fromD.setDate(fromD.getDate() - 3);
      const toD   = new Date(transactionDate); toD.setDate(toD.getDate()   + 3);
      const res = await railway.listFuelReports({
        from: fromD.toISOString(),
        to:   toD.toISOString(),
        // Show ALL reports in the window — not just pending — because
        // the dispatcher might be re-linking a manual one. The API
        // allows reassigning even if the report is currently matched
        // to a different transaction.
        limit: 200,
      });
      setRows(res.fuelReports);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); void loadCandidates(); }}
        className="text-[11px] font-semibold px-2.5 py-1.5 rounded transition-colors self-start"
        style={{ background: '#1a73e8', color: '#fff' }}
      >
        Find driver report to link
      </button>
    );
  }

  // Sort by gallons-distance from target (closest first) — that's the
  // signal the matcher cares about most when names don't help.
  const sorted = [...rows].sort((a, b) => {
    if (targetGallons == null) return 0;
    const da = Math.abs(a.dieselGallons - targetGallons);
    const db = Math.abs(b.dieselGallons - targetGallons);
    return da - db;
  });

  return (
    <div className="rounded p-2.5" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          Driver reports near {new Date(transactionDate).toLocaleDateString()}
        </div>
        <button onClick={() => setOpen(false)} className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Close</button>
      </div>
      {loading && <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Loading candidates…</div>}
      {error && <div className="text-[11px]" style={{ color: '#dc2626' }}>{error}</div>}
      {!loading && !error && sorted.length === 0 && (
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          No driver fuel reports in the ±3 day window.
        </div>
      )}
      <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
        {sorted.map(r => {
          const diff = targetGallons != null ? Math.abs(r.dieselGallons - targetGallons) : null;
          const close = diff != null && diff <= 0.5;
          return (
            <div key={r.id} className="flex items-center gap-2 rounded px-2 py-1.5"
              style={{ background: close ? '#dcfce7' : 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
              <div className="flex-1 min-w-0 text-[11px]">
                <div style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>
                  Driver #{r.driverId} · Asset #{r.assetId}
                </div>
                <div style={{ color: 'var(--gc-text-3)' }}>
                  {new Date(r.reportedAt).toLocaleString()} · {r.dieselGallons.toFixed(1)} gal
                  {diff != null && diff > 0.001 && ` (${diff > 0 ? '±' : ''}${diff.toFixed(1)} from receipt)`}
                  {r.matchStatus === 'matched' && ' · already linked'}
                </div>
              </div>
              <button
                disabled={busy}
                onClick={() => onPick(r.id)}
                className="text-[10.5px] font-semibold px-2 py-1 rounded transition-colors disabled:opacity-50"
                style={{ background: '#1a73e8', color: '#fff' }}
              >
                Link
              </button>
            </div>
          );
        })}
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

// MediaSidePanel — rendered as a flex SIBLING of the main detail
// panel inside the same overlay container, so the two sit attached
// side-by-side, centered together as a paired modal. NOT
// position: fixed (the parent is fixed; this is just a flex child).
// Esc handling lives in the parent DetailPanel so it can decide
// whether Esc closes the side panel first or the whole modal.
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
      style={{ width: 520, height: 720, background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)' }}
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

// ─── Table primitives ────────────────────────────────────────────────

function TableShell({
  loading, empty, emptyLabel, headers, count, children,
  page, pageSize, onPageChange,
}: {
  loading: boolean; empty: boolean; emptyLabel: string; headers: string[]; count: number; children: React.ReactNode;
  page: number; pageSize: number; onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const from = count === 0 ? 0 : page * pageSize + 1;
  const to   = Math.min(count, (page + 1) * pageSize);
  return (
    <div>
      <div className="flex items-center justify-between mb-2 text-xs" style={{ color: 'var(--gc-text-3)' }}>
        <span>{loading ? 'Loading…' : `${count} ${count === 1 ? 'report' : 'reports'}`}</span>
        {!loading && !empty && totalPages > 1 && (
          <span>Showing {from}–{to}</span>
        )}
      </div>
      <div className="rounded-lg overflow-hidden border" style={{ background: 'var(--gc-panel-bg)', borderColor: 'var(--gc-border)' }}>
        <div className="grid items-center text-[10px] font-bold uppercase tracking-wider px-4 py-2 border-b"
          style={{ gridTemplateColumns: `repeat(${headers.length}, minmax(0, 1fr))`, borderColor: 'var(--gc-border)', color: 'var(--gc-text-3)' }}>
          {headers.map((h, i) => <span key={i}>{h}</span>)}
        </div>
        {loading ? (
          <div className="py-16 flex items-center justify-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : empty ? (
          <div className="py-16 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>{emptyLabel}</div>
        ) : children}
      </div>
      {!loading && !empty && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-3">
          <button
            onClick={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0}
            className="text-sm font-semibold px-3 py-1.5 rounded transition-colors"
            style={{
              background: page === 0 ? 'transparent' : 'var(--gc-panel-bg)',
              color: page === 0 ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
              border: '1px solid var(--gc-border)',
              cursor: page === 0 ? 'default' : 'pointer',
              opacity: page === 0 ? 0.5 : 1,
            }}
          >‹ Previous</button>
          <span className="text-xs px-2" style={{ color: 'var(--gc-text-3)' }}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="text-sm font-semibold px-3 py-1.5 rounded transition-colors"
            style={{
              background: page >= totalPages - 1 ? 'transparent' : 'var(--gc-panel-bg)',
              color: page >= totalPages - 1 ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
              border: '1px solid var(--gc-border)',
              cursor: page >= totalPages - 1 ? 'default' : 'pointer',
              opacity: page >= totalPages - 1 ? 0.5 : 1,
            }}
          >Next ›</button>
        </div>
      )}
    </div>
  );
}

function Row({ onClick, active, cols = 5, children }: { onClick: () => void; active: boolean; cols?: number; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className="grid items-center px-4 py-2.5 border-b cursor-pointer transition-colors"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        borderColor: 'var(--gc-border-light)',
        background: active ? 'var(--gc-blue-light)' : 'transparent',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {children}
    </div>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return <div className="text-sm truncate pr-2" style={{ color: 'var(--gc-text-1)' }}>{children}</div>;
}

function DateCell({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <div>
      <div>{d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
    </div>
  );
}

function Badge({ color, icon, children }: { color: 'red' | 'blue' | 'green'; icon?: React.ReactNode; children: React.ReactNode }) {
  const palette = color === 'red'   ? { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' }
              : color === 'green' ? { bg: '#f0fdf4', fg: '#166534', border: '#bbf7d0' }
              :                     { bg: '#eff6ff', fg: '#1e40af', border: '#bfdbfe' };
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}` }}>
      {icon}{children}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    open:        { bg: '#fef3c7', fg: '#92400e' },
    in_progress: { bg: '#dbeafe', fg: '#1e40af' },
    done:        { bg: '#d1fae5', fg: '#065f46' },
  };
  const p = map[status] ?? { bg: '#f3f4f6', fg: '#374151' };
  return <span className="inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded" style={{ background: p.bg, color: p.fg }}>{status.replace('_', ' ')}</span>;
}

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
