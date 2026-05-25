'use client';

/**
 * /equipment — flat all-reports view across maintenance, inspections,
 * and fuel for every truck + trailer in the org. Three top tabs; each
 * is a sortable list of reports across all equipment with a single
 * column for the asset name. Click a row to expand into a detail
 * panel underneath.
 *
 * Designed for the DOT-style "show me every report you have" workflow
 * (audits, compliance reviews) rather than the per-asset drilldown
 * the calendar's AssetDetailModal provides. The two views are
 * complementary — calendar is for "what is this truck doing right
 * now?", Equipment is for "what's the history of every truck?".
 */

import { useEffect, useState } from 'react';
import { Package, Wrench, ClipboardCheck, Fuel as FuelIcon, AlertTriangle, Camera, Loader2, ChevronRight, MapPin } from 'lucide-react';
import { railway } from '@/lib/railway';
import ManagementHeader from '@/components/nav/ManagementHeader';

// ─── Types from the API ───────────────────────────────────────────────

type InspectionRow = {
  id: string;
  driverName: string;
  assetName: string | null;
  trailerName: string | null;
  inspectionDate: string;
  hasDefects: boolean;
  defectCount: number;
  itemCount: number;
  photoCount: number;
  durationSeconds: number | null;
  submittedAt: string;
};

type MaintenanceRow = {
  id: string;
  submittedBy: string;
  description: string;
  reportedAt: string;
  status: string;
  // either asset or trailer is populated; the API attaches a short
  // name on response
  asset?:   { name: string; unit?: string | null } | null;
  trailer?: { name: string; trailerNumber?: string | null } | null;
  photos?:  Array<{ id: string }>;
};

type FuelRow = {
  id: string;
  driverName: string;
  asset?: { name: string; unit?: string | null } | null;
  reportedAt: string;
  state: string;
  dieselGallons: number;
  defGallons?: number | null;
  odometer?: number | null;
  photos?: Array<{ id: string }>;
};

type Tab = 'maintenance' | 'inspections' | 'fuel';

// ─── Page ─────────────────────────────────────────────────────────────

export default function EquipmentPage() {
  const [tab, setTab] = useState<Tab>('inspections');

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Equipment" icon={Package} />

      {/* Tab bar */}
      <div className="px-6 pt-5 border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
        <div className="flex gap-1">
          <TabButton active={tab === 'inspections'} onClick={() => setTab('inspections')} icon={<ClipboardCheck size={15} />} label="Inspections" />
          <TabButton active={tab === 'maintenance'} onClick={() => setTab('maintenance')} icon={<Wrench size={15} />}         label="Maintenance" />
          <TabButton active={tab === 'fuel'}        onClick={() => setTab('fuel')}        icon={<FuelIcon size={15} />}       label="Fuel" />
        </div>
      </div>

      <div className="flex-1 px-6 py-5">
        {tab === 'inspections' && <InspectionsList />}
        {tab === 'maintenance' && <MaintenanceList />}
        {tab === 'fuel'        && <FuelList />}
      </div>
    </div>
  );
}

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

// ─── Inspections ──────────────────────────────────────────────────────

function InspectionsList() {
  const [rows, setRows] = useState<InspectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [defectsOnly, setDefectsOnly] = useState(false);

  useEffect(() => {
    setLoading(true);
    railway.listInspectionReports({ defectsOnly, limit: 200 })
      .then((r) => setRows(r.inspections))
      .catch((err) => { console.error('[equipment] inspections list:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, [defectsOnly]);

  return (
    <div>
      <FilterBar>
        <FilterToggle
          checked={defectsOnly}
          onChange={setDefectsOnly}
          label="Defects only"
        />
        <RowCount n={rows.length} loading={loading} singular="inspection" plural="inspections" />
      </FilterBar>

      <TableShell
        loading={loading}
        empty={rows.length === 0}
        emptyLabel={defectsOnly ? 'No inspections with defects.' : 'No inspections filed yet.'}
        headers={['Date', 'Driver', 'Equipment', 'Items', 'Photos', '']}
      >
        {rows.map(r => {
          const isOpen = expanded === r.id;
          return (
            <div key={r.id}>
              <Row onClick={() => setExpanded(isOpen ? null : r.id)} isOpen={isOpen}>
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
                <Cell>
                  <ChevronRight size={14} style={{ color: 'var(--gc-text-3)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
                </Cell>
              </Row>
              {isOpen && <InspectionDetail id={r.id} />}
            </div>
          );
        })}
      </TableShell>
    </div>
  );
}

function InspectionDetail({ id }: { id: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof railway.getInspectionReport>>['inspection'] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    railway.getInspectionReport(id)
      .then(r => setData(r.inspection))
      .catch(err => { console.error('[equipment] inspection detail:', err); setData(null); })
      .finally(() => setLoading(false));
  }, [id]);
  if (loading) return <DetailSpinner />;
  if (!data) return <DetailError />;
  const allItems = [...data.items, ...data.trailerItems];
  const defects = allItems.filter(i => i.status === 'fail');
  const naCount = allItems.filter(i => i.status === 'na').length;
  return (
    <DetailShell>
      <div className="grid grid-cols-3 gap-4 mb-4 text-xs">
        <MetaCell label="Signed by"   value={data.signedBy} />
        <MetaCell label="Submitted"   value={new Date(data.submittedAt).toLocaleString()} />
        <MetaCell label="Duration"    value={data.durationSeconds != null ? fmtDuration(data.durationSeconds) : '—'} />
        <MetaCell label="Truck"       value={data.asset    ? `${data.asset.name}${data.asset.unit ? ` #${data.asset.unit}` : ''}` : '—'} />
        <MetaCell label="Trailer"     value={data.trailer  ? `${data.trailer.name}${data.trailer.trailer_number ? ` #${data.trailer.trailer_number}` : ''}` : '—'} />
        <MetaCell label="Location"    value={data.locationLat != null && data.locationLon != null
          ? <a href={`https://maps.google.com/?q=${data.locationLat},${data.locationLon}`} target="_blank" rel="noreferrer" style={{ color: '#1a73e8', textDecoration: 'underline' }}>
              <MapPin size={11} style={{ display: 'inline', marginRight: 3 }} />
              {data.locationLat.toFixed(4)}, {data.locationLon.toFixed(4)}
            </a>
          : '—'} />
      </div>

      {/* Defects first — that's what dispatch is here for */}
      {defects.length > 0 && (
        <DetailSection title={`Defects (${defects.length})`} accent="#dc2626">
          {defects.map(item => (
            <div key={item.id} className="text-sm py-2 px-3 mb-1 rounded" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
              <div style={{ color: '#7f1d1d', fontWeight: 600 }}>{item.label}</div>
              <div className="text-xs mt-0.5" style={{ color: '#991b1b' }}>{item.section}</div>
              {item.notes && <div className="text-sm mt-1.5" style={{ color: '#374151' }}>{item.notes}</div>}
              {/* Photos attached to this item */}
              <PhotoStrip photos={data.photos.filter(p => p.itemId === item.id)} />
            </div>
          ))}
        </DetailSection>
      )}

      {/* Notes */}
      {data.notes && (
        <DetailSection title="Driver notes">
          <div className="text-sm whitespace-pre-wrap" style={{ color: 'var(--gc-text-2)' }}>{data.notes}</div>
        </DetailSection>
      )}

      {/* General photos (not attached to a specific item) */}
      {(() => {
        const general = data.photos.filter(p => p.itemId == null);
        if (general.length === 0) return null;
        return (
          <DetailSection title={`General photos (${general.length})`}>
            <PhotoStrip photos={general} />
          </DetailSection>
        );
      })()}

      {/* All-clear summary so the dispatcher knows what was checked */}
      <DetailSection title={`Checklist summary — ${allItems.length - defects.length - naCount} passed, ${naCount} N/A`}>
        <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
          {allItems.length === 0
            ? 'No items submitted.'
            : `Every item except the defects above passed inspection. Driver inspected ${data.items.length} truck items${data.trailerItems.length > 0 ? ` + ${data.trailerItems.length} trailer items` : ''}.`}
        </div>
      </DetailSection>
    </DetailShell>
  );
}

// ─── Maintenance ──────────────────────────────────────────────────────

function MaintenanceList() {
  const [rows, setRows] = useState<MaintenanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    railway.listMaintenanceReports({ limit: 200 })
      .then((r) => setRows((r.reports ?? []) as unknown as MaintenanceRow[]))
      .catch((err) => { console.error('[equipment] maintenance list:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <FilterBar>
        <RowCount n={rows.length} loading={loading} singular="report" plural="reports" />
      </FilterBar>
      <TableShell
        loading={loading}
        empty={rows.length === 0}
        emptyLabel="No maintenance reports filed yet."
        headers={['Date', 'Driver', 'Equipment', 'Description', 'Status', '']}
      >
        {rows.map(r => {
          const isOpen = expanded === r.id;
          return (
            <div key={r.id}>
              <Row onClick={() => setExpanded(isOpen ? null : r.id)} isOpen={isOpen}>
                <Cell><DateCell iso={r.reportedAt} /></Cell>
                <Cell>{r.submittedBy}</Cell>
                <Cell>{equipmentLabel(
                  r.asset   ? `${r.asset.name}${r.asset.unit ? ` #${r.asset.unit}` : ''}` : null,
                  r.trailer ? `${r.trailer.name}${r.trailer.trailerNumber ? ` #${r.trailer.trailerNumber}` : ''}` : null,
                )}</Cell>
                <Cell>
                  <span className="text-sm" style={{ color: 'var(--gc-text-1)' }}>
                    {r.description.length > 60 ? r.description.slice(0, 60) + '…' : r.description}
                  </span>
                </Cell>
                <Cell><StatusPill status={r.status} /></Cell>
                <Cell>
                  <ChevronRight size={14} style={{ color: 'var(--gc-text-3)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
                </Cell>
              </Row>
              {isOpen && (
                <DetailShell>
                  <div className="text-sm whitespace-pre-wrap mb-3" style={{ color: 'var(--gc-text-1)' }}>{r.description}</div>
                  {r.photos && r.photos.length > 0 && (
                    <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                      {r.photos.length} photo{r.photos.length === 1 ? '' : 's'} attached — open in the dedicated Maintenance page for full viewer.
                    </div>
                  )}
                </DetailShell>
              )}
            </div>
          );
        })}
      </TableShell>
    </div>
  );
}

// ─── Fuel ─────────────────────────────────────────────────────────────

function FuelList() {
  const [rows, setRows] = useState<FuelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    railway.listFuelReports({ limit: 200 })
      .then((r) => setRows((r.fuelReports ?? []) as unknown as FuelRow[]))
      .catch((err) => { console.error('[equipment] fuel list:', err); setRows([]); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <FilterBar>
        <RowCount n={rows.length} loading={loading} singular="report" plural="reports" />
      </FilterBar>
      <TableShell
        loading={loading}
        empty={rows.length === 0}
        emptyLabel="No fuel reports filed yet."
        headers={['Date', 'Driver', 'Equipment', 'State', 'Diesel (gal)', '']}
      >
        {rows.map(r => {
          const isOpen = expanded === r.id;
          return (
            <div key={r.id}>
              <Row onClick={() => setExpanded(isOpen ? null : r.id)} isOpen={isOpen}>
                <Cell><DateCell iso={r.reportedAt} /></Cell>
                <Cell>{r.driverName}</Cell>
                <Cell>{r.asset ? `${r.asset.name}${r.asset.unit ? ` #${r.asset.unit}` : ''}` : '—'}</Cell>
                <Cell>{r.state}</Cell>
                <Cell><span className="font-mono">{r.dieselGallons.toFixed(1)}</span></Cell>
                <Cell>
                  <ChevronRight size={14} style={{ color: 'var(--gc-text-3)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
                </Cell>
              </Row>
              {isOpen && (
                <DetailShell>
                  <div className="grid grid-cols-3 gap-4 text-xs">
                    <MetaCell label="Diesel"   value={`${r.dieselGallons.toFixed(2)} gal`} />
                    <MetaCell label="DEF"      value={r.defGallons != null ? `${r.defGallons.toFixed(2)} gal` : '—'} />
                    <MetaCell label="Odometer" value={r.odometer != null ? `${r.odometer.toLocaleString()} mi` : '—'} />
                  </div>
                  {r.photos && r.photos.length > 0 && (
                    <div className="text-xs mt-3" style={{ color: 'var(--gc-text-3)' }}>
                      {r.photos.length} receipt photo{r.photos.length === 1 ? '' : 's'} attached — open in the dedicated Fuel page for full viewer.
                    </div>
                  )}
                </DetailShell>
              )}
            </div>
          );
        })}
      </TableShell>
    </div>
  );
}

// ─── Shared shell components ──────────────────────────────────────────

function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3 flex-wrap">{children}</div>
  );
}
function FilterToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-1.5 text-sm cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
function RowCount({ n, loading, singular, plural }: { n: number; loading: boolean; singular: string; plural: string }) {
  if (loading) return <span className="text-xs ml-auto" style={{ color: 'var(--gc-text-3)' }}>Loading…</span>;
  return <span className="text-xs ml-auto" style={{ color: 'var(--gc-text-3)' }}>{n} {n === 1 ? singular : plural}</span>;
}
function TableShell({ loading, empty, emptyLabel, headers, children }: {
  loading: boolean; empty: boolean; emptyLabel: string; headers: string[]; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg overflow-hidden border" style={{ background: 'var(--gc-panel-bg)', borderColor: 'var(--gc-border)' }}>
      <div className="grid items-center text-[10px] font-bold uppercase tracking-wider px-4 py-2 border-b"
        style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', borderColor: 'var(--gc-border)', color: 'var(--gc-text-3)' }}>
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
  );
}
function Row({ onClick, isOpen, children }: { onClick: () => void; isOpen: boolean; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className="grid items-center px-4 py-2.5 border-b cursor-pointer transition-colors"
      style={{
        gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
        borderColor: 'var(--gc-border-light)',
        background: isOpen ? 'var(--gc-blue-light)' : 'transparent',
      }}
      onMouseEnter={e => { if (!isOpen) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!isOpen) e.currentTarget.style.background = 'transparent'; }}
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
      {icon}
      {children}
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
function DetailShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-4 border-b" style={{ background: 'var(--gc-bg)', borderColor: 'var(--gc-border-light)' }}>
      {children}
    </div>
  );
}
function DetailSection({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: accent ?? 'var(--gc-text-3)' }}>{title}</div>
      {children}
    </div>
  );
}
function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-sm" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </div>
  );
}
function PhotoStrip({ photos }: { photos: Array<{ id: string; signedUrl: string | null; caption: string | null }> }) {
  if (photos.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {photos.map(p => (
        p.signedUrl ? (
          <a key={p.id} href={p.signedUrl} target="_blank" rel="noreferrer" title={p.caption ?? 'Open photo'}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.signedUrl} alt={p.caption ?? ''} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--gc-border)' }} />
          </a>
        ) : (
          <div key={p.id} style={{ width: 80, height: 80, borderRadius: 6, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#9ca3af' }}>
            no preview
          </div>
        )
      ))}
    </div>
  );
}
function DetailSpinner() {
  return <DetailShell><div className="flex items-center justify-center py-6"><Loader2 size={16} className="animate-spin" /></div></DetailShell>;
}
function DetailError() {
  return <DetailShell><div className="text-sm" style={{ color: '#dc2626' }}>Could not load report detail.</div></DetailShell>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function equipmentLabel(asset: string | null, trailer: string | null): string {
  if (asset && trailer) return `${asset} + ${trailer}`;
  return asset ?? trailer ?? '—';
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
