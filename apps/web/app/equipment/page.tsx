'use client';

/**
 * /equipment — flat all-reports view across maintenance, inspections,
 * and fuel for every truck + trailer in the org.
 *
 * Maintenance is the primary tab (highest-frequency dispatcher
 * workflow). Filters (driver, equipment, date sort) apply to whatever
 * tab is active. Clicking a row pops a right-side slide-over panel
 * with the full detail — photos, GPS map when present, and any
 * type-specific fields. The slide-over replaced the earlier inline
 * expand because expanding nested under a row meant the dispatcher
 * couldn't see both the row AND the photos at the same time on
 * smaller monitors.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Package, Wrench, ClipboardCheck, Fuel as FuelIcon, AlertTriangle,
  Camera, Loader2, MapPin, X,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import ManagementHeader from '@/components/nav/ManagementHeader';
import type { Driver, Asset } from '@/lib/types';
import type { MaintenanceReport, FuelReport, MaintenanceReportPhoto, FuelReportPhoto } from '@fleetcal/types';
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

// Combined equipment picker — same list covers trucks + trailers. The
// caller resolves the type+id from the selected value so the server
// query filters by asset_id or trailer_id correctly.
type EquipmentSelection = { kind: 'asset' | 'trailer'; id: number } | null;

// What a row knows for the right-side panel. Each tab maps its row
// shape onto this so the panel can render uniformly.
type PanelData = {
  kind: 'maintenance' | 'inspection' | 'fuel';
  id: string;
  // ID used to fetch the full detail (for inspections — the list
  // doesn't carry the per-item checklist). Maintenance + Fuel already
  // ship complete rows, so this can re-use the list row directly.
} & (
  | { kind: 'maintenance'; report: MaintenanceReport }
  | { kind: 'fuel';        report: FuelReport }
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

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--gc-bg)' }}>
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

      <div className="flex-1 px-6 py-5">
        {tab === 'maintenance' && (
          <MaintenanceList
            driverId={driverId}
            equipment={equipment}
            sortDir={sortDir}
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
          <FuelList
            driverId={driverId}
            equipment={equipment}
            sortDir={sortDir}
            onOpen={(r) => setPanel({ kind: 'fuel', id: r.id, report: r })}
            openId={panel?.kind === 'fuel' ? panel.id : null}
          />
        )}
      </div>

      {panel && <DetailPanel panel={panel} onClose={() => setPanel(null)} />}
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

function MaintenanceList({
  driverId, equipment, sortDir, onOpen, openId,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  onOpen: (r: MaintenanceReport) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<MaintenanceReport[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <TableShell
      loading={loading}
      empty={sorted.length === 0}
      emptyLabel="No maintenance reports match the current filters."
      headers={['Date', 'Driver', 'Equipment', 'Description', 'Status']}
      count={sorted.length}
    >
      {sorted.map(r => (
        <Row key={r.id} onClick={() => onOpen(r)} active={openId === r.id}>
          <Cell><DateCell iso={r.reportedAt} /></Cell>
          <Cell>{r.submittedBy}</Cell>
          <Cell>{equipmentLabelFromReport(r)}</Cell>
          <Cell>
            <span style={{ color: 'var(--gc-text-1)' }}>
              {r.description.length > 70 ? r.description.slice(0, 70) + '…' : r.description}
            </span>
          </Cell>
          <Cell><StatusPill status={r.status} /></Cell>
        </Row>
      ))}
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
      >
        {sorted.map(r => (
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
  driverId, equipment, sortDir, onOpen, openId,
}: {
  driverId: number | null;
  equipment: EquipmentSelection;
  sortDir: SortDir;
  onOpen: (r: FuelReport) => void;
  openId: string | null;
}) {
  const [rows, setRows] = useState<FuelReport[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <TableShell
      loading={loading}
      empty={sorted.length === 0}
      emptyLabel={equipment?.kind === 'trailer' ? 'Fuel reports are always on trucks — switch the equipment filter.' : 'No fuel reports match the current filters.'}
      headers={['Date', 'Driver', 'Equipment', 'State', 'Diesel (gal)']}
      count={sorted.length}
    >
      {sorted.map(r => (
        <Row key={r.id} onClick={() => onOpen(r)} active={openId === r.id}>
          <Cell><DateCell iso={r.reportedAt} /></Cell>
          <Cell>{r.submittedBy}</Cell>
          <Cell>{r.assetId ? `Asset #${r.assetId}` : '—'}</Cell>
          <Cell>{r.state}</Cell>
          <Cell><span className="font-mono">{r.dieselGallons.toFixed(1)}</span></Cell>
        </Row>
      ))}
    </TableShell>
  );
}

// ─── Slide-over detail panel ─────────────────────────────────────────

function DetailPanel({ panel, onClose }: { panel: PanelData; onClose: () => void }) {
  return (
    <>
      {/* Backdrop — click to dismiss. Subtle dim so the underlying
          table is still readable. */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 80,
        }}
      />
      {/* Panel — fixed right, fills full height. Width sized to hold
          a 2-col photo grid + the static map. */}
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(520px, 100vw)', zIndex: 81,
          background: 'var(--gc-panel-bg)', color: 'var(--gc-text-1)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div className="flex items-center px-5 py-4 border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
          <span className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
            {panel.kind === 'maintenance' ? 'Maintenance report'
             : panel.kind === 'inspection' ? 'Inspection report'
             : 'Fuel report'}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} aria-label="Close" className="p-1 rounded transition-colors"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {panel.kind === 'maintenance'  && <MaintenanceDetail report={panel.report} />}
          {panel.kind === 'inspection'   && <InspectionDetail id={panel.id} />}
          {panel.kind === 'fuel'         && <FuelDetail report={panel.report} />}
        </div>
      </div>
    </>
  );
}

function MaintenanceDetail({ report }: { report: MaintenanceReport }) {
  return (
    <>
      <MetaGrid items={[
        { label: 'Reported',   value: new Date(report.reportedAt).toLocaleString() },
        { label: 'Driver',     value: report.submittedBy },
        { label: 'Equipment',  value: equipmentLabelFromReport(report) },
        { label: 'Status',     value: <StatusPill status={report.status} /> },
      ]} />
      <Section title="Description">
        <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>{report.description}</p>
      </Section>
      {report.photos && report.photos.length > 0 && (
        <Section title={`Photos (${report.photos.length})`}>
          <PhotoGrid photos={report.photos.map((p: MaintenanceReportPhoto) => ({ id: p.id, signedUrl: p.signedUrl ?? null, caption: null }))} />
        </Section>
      )}
      {report.latitude != null && report.longitude != null
        ? <Section title="Location"><MiniMap lat={report.latitude} lon={report.longitude} state={report.state} /></Section>
        : <Section title="Location"><NoLocation /></Section>}
    </>
  );
}

function InspectionDetail({ id }: { id: string }) {
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
  if (loading) return <div className="flex items-center justify-center py-10"><Loader2 size={20} className="animate-spin" /></div>;
  if (!data)   return <div className="text-sm" style={{ color: '#dc2626' }}>Could not load report.</div>;
  const allItems = [...data.items, ...data.trailerItems];
  const defects = allItems.filter(i => i.status === 'fail');
  return (
    <>
      <MetaGrid items={[
        { label: 'Submitted', value: new Date(data.submittedAt).toLocaleString() },
        { label: 'Signed by', value: data.signedBy },
        { label: 'Truck',     value: data.asset   ? `${data.asset.name}${data.asset.unit ? ` #${data.asset.unit}` : ''}` : '—' },
        { label: 'Trailer',   value: data.trailer ? `${data.trailer.name}${data.trailer.trailer_number ? ` #${data.trailer.trailer_number}` : ''}` : '—' },
        { label: 'Duration',  value: data.durationSeconds != null ? fmtDuration(data.durationSeconds) : '—' },
        { label: 'Items',     value: `${allItems.length - defects.length} passed · ${defects.length} failed` },
      ]} />

      {defects.length > 0 && (
        <Section title={`Defects (${defects.length})`} accent="#dc2626">
          {defects.map(item => (
            <div key={item.id} className="text-sm py-2 px-3 mb-1.5 rounded" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
              <div style={{ color: '#7f1d1d', fontWeight: 600 }}>{item.label}</div>
              <div className="text-xs mt-0.5" style={{ color: '#991b1b' }}>{item.section}</div>
              {item.notes && <div className="text-sm mt-1.5" style={{ color: '#374151' }}>{item.notes}</div>}
              <PhotoGrid photos={data.photos.filter(p => p.itemId === item.id).map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption }))} compact />
            </div>
          ))}
        </Section>
      )}

      {data.notes && (
        <Section title="Driver notes">
          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>{data.notes}</p>
        </Section>
      )}

      {(() => {
        const general = data.photos.filter(p => p.itemId == null);
        if (general.length === 0) return null;
        return (
          <Section title={`General photos (${general.length})`}>
            <PhotoGrid photos={general.map(p => ({ id: p.id, signedUrl: p.signedUrl, caption: p.caption }))} />
          </Section>
        );
      })()}

      {data.locationLat != null && data.locationLon != null
        ? <Section title="Location"><MiniMap lat={data.locationLat} lon={data.locationLon} /></Section>
        : <Section title="Location"><NoLocation /></Section>}
    </>
  );
}

function FuelDetail({ report }: { report: FuelReport }) {
  return (
    <>
      <MetaGrid items={[
        { label: 'Reported',  value: new Date(report.reportedAt).toLocaleString() },
        { label: 'Driver',    value: report.submittedBy },
        { label: 'State',     value: report.state },
        { label: 'Diesel',    value: `${report.dieselGallons.toFixed(2)} gal` },
        { label: 'DEF',       value: report.defGallons != null ? `${report.defGallons.toFixed(2)} gal` : '—' },
        { label: 'Odometer',  value: report.odometer != null ? `${report.odometer.toLocaleString()} mi` : '—' },
      ]} />
      {report.photos && report.photos.length > 0 && (
        <Section title={`Receipts (${report.photos.length})`}>
          <PhotoGrid photos={report.photos.map((p: FuelReportPhoto) => ({ id: p.id, signedUrl: p.signedUrl ?? null, caption: null }))} />
        </Section>
      )}
      {report.latitude != null && report.longitude != null
        ? <Section title="Location"><MiniMap lat={report.latitude} lon={report.longitude} state={report.state} /></Section>
        : <Section title="Location"><NoLocation /></Section>}
    </>
  );
}

// ─── Panel helpers ────────────────────────────────────────────────────

function Section({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: accent ?? 'var(--gc-text-3)' }}>{title}</div>
      {children}
    </div>
  );
}

function MetaGrid({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 mb-5">
      {items.map(it => (
        <div key={it.label}>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>{it.label}</div>
          <div className="text-sm" style={{ color: 'var(--gc-text-1)' }}>{it.value}</div>
        </div>
      ))}
    </div>
  );
}

function PhotoGrid({ photos, compact = false }: { photos: { id: string; signedUrl: string | null; caption: string | null }[]; compact?: boolean }) {
  if (photos.length === 0) return null;
  const sz = compact ? 70 : 110;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {photos.map(p => (
        p.signedUrl ? (
          <a key={p.id} href={p.signedUrl} target="_blank" rel="noreferrer" title={p.caption ?? 'Open photo'}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.signedUrl} alt={p.caption ?? ''} style={{ width: sz, height: sz, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--gc-border)' }} />
          </a>
        ) : (
          <div key={p.id} style={{ width: sz, height: sz, borderRadius: 8, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#9ca3af' }}>
            no preview
          </div>
        )
      ))}
    </div>
  );
}

function NoLocation() {
  return (
    <div className="text-xs flex items-center gap-1.5 py-3 px-3 rounded" style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}>
      <MapPin size={12} /> No GPS attached to this report
    </div>
  );
}

// ─── Static-ish Google Map (one marker) ───────────────────────────────
//
// Uses the JS API singleton already loaded by other panels (Movements,
// RouteMapPanel). A new map instance per panel open is cheap.
//
function MiniMap({ lat, lon, state }: { lat: number; lon: number; state?: string }) {
  const ref = useState<HTMLDivElement | null>(null);
  const [el, setEl] = ref;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!el) return;
    let cancelled = false;
    loadGoogleMaps().then(() => {
      if (cancelled || !el) return;
      const map = new google.maps.Map(el, {
        center: { lat, lng: lon },
        zoom:   13,
        disableDefaultUI: true,
        zoomControl:      true,
        mapId: MAP_ID,
      });
      new google.maps.marker.AdvancedMarkerElement({
        position: { lat, lng: lon },
        map,
      });
    }).catch((err) => {
      console.warn('[equipment] map load failed:', err);
      if (!cancelled) setError('Map unavailable — check NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
    });
    return () => { cancelled = true; };
  }, [el, lat, lon]);
  return (
    <div>
      <div
        ref={setEl}
        style={{ width: '100%', height: 220, borderRadius: 10, background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', overflow: 'hidden' }}
      />
      <div className="flex items-center justify-between mt-2 text-xs">
        <a
          href={`https://maps.google.com/?q=${lat},${lon}`}
          target="_blank" rel="noreferrer"
          style={{ color: '#1a73e8', fontWeight: 600 }}
        >
          Open in Google Maps
        </a>
        <span style={{ color: 'var(--gc-text-3)' }}>{lat.toFixed(4)}, {lon.toFixed(4)}{state ? ` · ${state}` : ''}</span>
      </div>
      {error && <div className="text-xs mt-1" style={{ color: '#dc2626' }}>{error}</div>}
    </div>
  );
}

// ─── Table primitives ────────────────────────────────────────────────

function TableShell({ loading, empty, emptyLabel, headers, count, children }: {
  loading: boolean; empty: boolean; emptyLabel: string; headers: string[]; count: number; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs mb-2" style={{ color: 'var(--gc-text-3)' }}>
        {loading ? 'Loading…' : `${count} ${count === 1 ? 'report' : 'reports'}`}
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
function equipmentLabelFromReport(r: MaintenanceReport): string {
  if (r.assetId)   return `Asset #${r.assetId}`;
  if (r.trailerId) return `Trailer #${r.trailerId}`;
  return '—';
}
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
