/**
 * /maintenance — ops surface for driver reports + tracked work.
 *
 * Two buckets at the top: Reports · Action Items. Each bucket has its
 * own table; selecting a row opens a side panel for detail + actions.
 *
 *   Reports        — driver-submitted issues. Triage status (open /
 *                    reviewed / dismissed / converted). The primary
 *                    action is "Save as Action Item" (converts the
 *                    report and creates a tracked work order).
 *   Action Items   — ops's tracked work. Priority, schedule, OOS
 *                    toggle, status pipeline (open → in_progress →
 *                    done). Items come from a report OR ad-hoc.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  Wrench, AlertOctagon, ClipboardList, X, Loader2, Search, Plus, Truck, Container,
} from 'lucide-react';
import DataLoader from '@/components/DataLoader';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import {
  Th, Td, PaginationFooter,
} from '@/components/queue/QueueTablePrimitives';
import type {
  MaintenanceReport, MaintenanceReportStatus,
  MaintenanceActionItem, MaintenanceCategory, MaintenancePriority, MaintenanceActionStatus,
  CreateMaintenanceActionItemRequest,
  ConvertMaintenanceReportRequest,
  UpdateMaintenanceActionItemRequest,
} from '@fleetcal/types';

type Bucket = 'reports' | 'action-items';
const PAGE_SIZE = 50;

const CATEGORIES: MaintenanceCategory[] = ['repair', 'pm', 'inspection', 'other'];
const PRIORITIES: MaintenancePriority[] = ['urgent', 'high', 'normal', 'low'];
const ACTION_STATUSES: MaintenanceActionStatus[] = ['open', 'in_progress', 'done'];

// ── Page ────────────────────────────────────────────────────────────────

export default function MaintenancePage() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const drivers  = useCalendarStore(s => s.drivers);
  const assets   = useCalendarStore(s => s.assets);
  const trailers = useCalendarStore(s => s.trailers);

  const [bucket, setBucket] = useState<Bucket>('reports');

  // ── Reports state ─────────────────────────────────────────────────────
  const [reports,        setReports]        = useState<MaintenanceReport[]>([]);
  const [reportsTotal,   setReportsTotal]   = useState(0);
  const [reportsPage,    setReportsPage]    = useState(0);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsStatus,  setReportsStatus]  = useState<MaintenanceReportStatus | 'all'>('open');
  const [openReport,     setOpenReport]     = useState<MaintenanceReport | null>(null);
  const [convertingFrom, setConvertingFrom] = useState<MaintenanceReport | null>(null);

  // ── Action items state ────────────────────────────────────────────────
  const [actionItems,    setActionItems]    = useState<MaintenanceActionItem[]>([]);
  const [actionTotal,    setActionTotal]    = useState(0);
  const [actionPage,     setActionPage]     = useState(0);
  const [actionLoading,  setActionLoading]  = useState(false);
  const [actionStatus,   setActionStatus]   = useState<MaintenanceActionStatus | 'all'>('open');
  const [oosOnly,        setOosOnly]        = useState(false);
  const [openItem,       setOpenItem]       = useState<MaintenanceActionItem | null>(null);
  const [creatingItem,   setCreatingItem]   = useState(false);

  const [search, setSearch] = useState('');
  const [error,  setError]  = useState<string | null>(null);

  // ── Lookups ───────────────────────────────────────────────────────────
  const driverById  = useMemo(() => new Map(drivers .map(d => [d.id, d.name])), [drivers]);
  const assetById   = useMemo(() => new Map(assets  .map(a => [a.id, { name: a.name, unit: a.unit }])), [assets]);
  const trailerById = useMemo(() => new Map(trailers.map(t => [t.id, { name: t.name, num: t.trailerNumber }])), [trailers]);

  // ── Fetchers ──────────────────────────────────────────────────────────

  const refreshReports = async () => {
    if (!authLoaded || !isSignedIn) return;
    setReportsLoading(true);
    setError(null);
    try {
      const res = await railway.listMaintenanceReports({
        status: reportsStatus === 'all' ? undefined : reportsStatus,
        limit:  PAGE_SIZE,
        offset: reportsPage * PAGE_SIZE,
      });
      setReports(res.reports);
      setReportsTotal(res.total);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load reports');
    } finally {
      setReportsLoading(false);
    }
  };

  const refreshActionItems = async () => {
    if (!authLoaded || !isSignedIn) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await railway.listMaintenanceActionItems({
        status:       actionStatus === 'all' ? undefined : actionStatus,
        outOfService: oosOnly ? true : undefined,
        limit:  PAGE_SIZE,
        offset: actionPage * PAGE_SIZE,
      });
      setActionItems(res.actionItems);
      setActionTotal(res.total);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load action items');
    } finally {
      setActionLoading(false);
    }
  };

  useEffect(() => { void refreshReports();      /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [authLoaded, isSignedIn, reportsStatus, reportsPage]);
  useEffect(() => { void refreshActionItems();  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [authLoaded, isSignedIn, actionStatus, oosOnly, actionPage]);
  useEffect(() => { setReportsPage(0); }, [reportsStatus]);
  useEffect(() => { setActionPage(0);  }, [actionStatus, oosOnly]);

  // Client-side search narrows what's on the current page.
  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(r => {
      const driverName = driverById.get(r.driverId) ?? '';
      const target =
        r.assetId   != null ? formatAssetLabel(assetById.get(r.assetId)) :
        r.trailerId != null ? formatTrailerLabel(trailerById.get(r.trailerId)) :
        '';
      return [driverName, target, r.description, r.state ?? ''].join(' ').toLowerCase().includes(q);
    });
  }, [reports, search, driverById, assetById, trailerById]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return actionItems;
    return actionItems.filter(i => {
      const target =
        i.assetId   != null ? formatAssetLabel(assetById.get(i.assetId)) :
        i.trailerId != null ? formatTrailerLabel(trailerById.get(i.trailerId)) :
        '';
      return [i.title, i.description ?? '', target, i.category, i.priority].join(' ').toLowerCase().includes(q);
    });
  }, [actionItems, search, assetById, trailerById]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <DataLoader />
      <ManagementHeader title="Maintenance" icon={Wrench} />

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-6">
        <div className="mx-auto space-y-4" style={{ width: '95vw' }}>

          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            Driver-submitted issues land in <strong>Reports</strong>. Convert a report
            into an <strong>Action Item</strong> to triage, prioritize, and schedule the fix.
          </div>

          {/* Bucket tiles */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            <BucketTile
              active={bucket === 'reports'}
              tint="#c2410c"
              icon={ClipboardList}
              label="Reports"
              count={reportsTotal}
              subtitle="From drivers"
              onClick={() => setBucket('reports')}
            />
            <BucketTile
              active={bucket === 'action-items'}
              tint="#1a73e8"
              icon={Wrench}
              label="Action Items"
              count={actionTotal}
              subtitle="Tracked work"
              onClick={() => setBucket('action-items')}
            />
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: search ? 'var(--gc-blue)' : 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder={bucket === 'reports' ? 'Search description, driver, asset…' : 'Search title, asset…'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{ width: 320, background: 'var(--gc-surface)', border: `1px solid ${search ? 'var(--gc-blue)' : 'var(--gc-border)'}`, color: 'var(--gc-text-1)' }} />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="flex-1" />

            {bucket === 'reports' ? (
              <select
                value={reportsStatus}
                onChange={e => setReportsStatus(e.target.value as MaintenanceReportStatus | 'all')}
                className="text-[12px] font-medium px-3 py-1.5 rounded-lg outline-none"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="reviewed">Reviewed</option>
                <option value="converted">Converted</option>
                <option value="dismissed">Dismissed</option>
              </select>
            ) : (
              <>
                <select
                  value={actionStatus}
                  onChange={e => setActionStatus(e.target.value as MaintenanceActionStatus | 'all')}
                  className="text-[12px] font-medium px-3 py-1.5 rounded-lg outline-none"
                  style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}>
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </select>
                <label className="flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg cursor-pointer"
                  style={{ border: `1px solid ${oosOnly ? '#c62828' : 'var(--gc-border)'}`, background: oosOnly ? '#fff5f5' : 'var(--gc-surface)', color: oosOnly ? '#c62828' : 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={oosOnly} onChange={e => setOosOnly(e.target.checked)} style={{ accentColor: '#c62828' }} />
                  OOS only
                </label>
                <button onClick={() => setCreatingItem(true)}
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  <Plus size={12} /> New Action Item
                </button>
              </>
            )}
          </div>

          {/* Error banner */}
          {error && (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          )}

          {/* Table */}
          {bucket === 'reports' ? (
            <ReportsTable
              loading={reportsLoading}
              rows={filteredReports}
              total={reportsTotal}
              page={reportsPage}
              onPage={setReportsPage}
              driverById={driverById}
              assetById={assetById}
              trailerById={trailerById}
              onSelect={setOpenReport}
              onConvert={(r) => setConvertingFrom(r)}
            />
          ) : (
            <ActionItemsTable
              loading={actionLoading}
              rows={filteredItems}
              total={actionTotal}
              page={actionPage}
              onPage={setActionPage}
              assetById={assetById}
              trailerById={trailerById}
              onSelect={setOpenItem}
            />
          )}
        </div>
      </div>

      {/* Report detail side panel */}
      {openReport && (
        <ReportDetailPanel
          report={openReport}
          driverName={driverById.get(openReport.driverId) ?? `Driver #${openReport.driverId}`}
          targetLabel={
            openReport.assetId   != null ? formatAssetLabel(assetById.get(openReport.assetId)) :
            openReport.trailerId != null ? formatTrailerLabel(trailerById.get(openReport.trailerId)) :
            '—'
          }
          onClose={() => setOpenReport(null)}
          onChanged={async () => { setOpenReport(null); await refreshReports(); }}
          onConvert={() => { const r = openReport; setOpenReport(null); setConvertingFrom(r); }}
        />
      )}

      {/* Convert / create action item modal (handles both flows) */}
      {convertingFrom && (
        <ActionItemModal
          mode="convert"
          fromReport={convertingFrom}
          assetLabel={
            convertingFrom.assetId   != null ? formatAssetLabel(assetById.get(convertingFrom.assetId)) :
            convertingFrom.trailerId != null ? formatTrailerLabel(trailerById.get(convertingFrom.trailerId)) :
            '—'
          }
          onClose={() => setConvertingFrom(null)}
          onSaved={async () => {
            setConvertingFrom(null);
            await Promise.all([refreshReports(), refreshActionItems()]);
          }}
        />
      )}
      {creatingItem && (
        <ActionItemModal
          mode="create"
          assets={assets}
          trailers={trailers}
          onClose={() => setCreatingItem(false)}
          onSaved={async () => { setCreatingItem(false); await refreshActionItems(); }}
        />
      )}
      {openItem && (
        <ActionItemEditPanel
          item={openItem}
          assetLabel={
            openItem.assetId   != null ? formatAssetLabel(assetById.get(openItem.assetId)) :
            openItem.trailerId != null ? formatTrailerLabel(trailerById.get(openItem.trailerId)) :
            '—'
          }
          onClose={() => setOpenItem(null)}
          onSaved={async () => { setOpenItem(null); await refreshActionItems(); }}
          onDeleted={async () => { setOpenItem(null); await refreshActionItems(); }}
        />
      )}
    </div>
  );
}

// ── Bucket tile ─────────────────────────────────────────────────────────

function BucketTile({
  active, tint, icon: Icon, label, count, subtitle, onClick,
}: {
  active: boolean; tint: string; icon: typeof Wrench; label: string;
  count: number; subtitle: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="text-left px-4 py-3 rounded-xl transition-all"
      style={{
        background: 'var(--gc-surface)',
        border:     active ? `2px solid ${tint}` : '1px solid var(--gc-border-light)',
        boxShadow:  active ? '0 4px 12px rgba(26,115,232,0.12)' : 'var(--shadow-1)',
      }}>
      <div className="flex items-center gap-2">
        <Icon size={16} style={{ color: tint }} />
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>{label}</span>
        <span className="ml-auto text-[16px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{count.toLocaleString()}</span>
      </div>
      <div className="mt-0.5 text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
        {subtitle}
      </div>
    </button>
  );
}

// ── Reports table ──────────────────────────────────────────────────────

function ReportsTable({
  loading, rows, total, page, onPage,
  driverById, assetById, trailerById,
  onSelect, onConvert,
}: {
  loading: boolean;
  rows: MaintenanceReport[];
  total: number;
  page: number;
  onPage: (n: number) => void;
  driverById: Map<number, string>;
  assetById:  Map<number, { name: string; unit?: string }>;
  trailerById: Map<number, { name: string; num?: string }>;
  onSelect: (r: MaintenanceReport) => void;
  onConvert: (r: MaintenanceReport) => void;
}) {
  if (loading) return <Spinner />;
  if (rows.length === 0) return <Empty kind="reports" />;
  return (
    <div className="rounded-2xl overflow-x-auto" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'max-content' }} className="text-[12.5px]">
        <thead>
          <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
            <Th>Reported</Th>
            <Th>Driver</Th>
            <Th>Asset / Trailer</Th>
            <Th>Description</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const driverName = driverById.get(r.driverId) ?? `Driver #${r.driverId}`;
            const target =
              r.assetId   != null ? formatAssetLabel(assetById.get(r.assetId)) :
              r.trailerId != null ? formatTrailerLabel(trailerById.get(r.trailerId)) :
              '—';
            const targetIsAsset = r.assetId != null;
            const date = new Date(r.reportedAt);
            return (
              <tr key={r.id}
                onClick={() => onSelect(r)}
                style={{ borderBottom: '1px solid var(--gc-border-light)', cursor: 'pointer' }}
                className="hover:bg-[var(--gc-hover)]">
                <Td><span style={{ whiteSpace: 'nowrap' }}>{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></Td>
                <Td>{driverName}</Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    {targetIsAsset
                      ? <Truck size={12} style={{ color: 'var(--gc-text-3)' }} />
                      : <Container size={12} style={{ color: 'var(--gc-text-3)' }} />}
                    {target}
                  </span>
                </Td>
                <Td>
                  <span className="truncate inline-block" style={{ maxWidth: 360 }}>{r.description}</span>
                  {r.photos && r.photos.length > 0 && (
                    <span className="ml-2 inline-block px-1.5 py-0.5 rounded-lg text-[10px] font-bold"
                      style={{ background: '#e0e7ff', color: '#3730a3' }}>
                      📷 {r.photos.length}
                    </span>
                  )}
                </Td>
                <Td><ReportStatusChip status={r.status} /></Td>
                <Td align="right" onClick={e => e.stopPropagation()}>
                  {r.status !== 'converted' && r.status !== 'dismissed' && (
                    <button onClick={() => onConvert(r)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-lg"
                      style={{ background: '#1a73e8', color: '#fff' }}>
                      Save as Action Item
                    </button>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total > PAGE_SIZE && (
        <PaginationFooter page={page} pageSize={PAGE_SIZE} total={total}
          onPrev={() => onPage(Math.max(0, page - 1))}
          onNext={() => onPage(page + 1)} />
      )}
    </div>
  );
}

// ── Action items table ─────────────────────────────────────────────────

function ActionItemsTable({
  loading, rows, total, page, onPage,
  assetById, trailerById,
  onSelect,
}: {
  loading: boolean;
  rows: MaintenanceActionItem[];
  total: number;
  page: number;
  onPage: (n: number) => void;
  assetById:  Map<number, { name: string; unit?: string }>;
  trailerById: Map<number, { name: string; num?: string }>;
  onSelect: (i: MaintenanceActionItem) => void;
}) {
  if (loading) return <Spinner />;
  if (rows.length === 0) return <Empty kind="action-items" />;
  return (
    <div className="rounded-2xl overflow-x-auto" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
      <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'max-content' }} className="text-[12.5px]">
        <thead>
          <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
            <Th>Title</Th>
            <Th>Asset / Trailer</Th>
            <Th>Category</Th>
            <Th>Priority</Th>
            <Th>Status</Th>
            <Th>OOS</Th>
            <Th>Scheduled</Th>
            <Th>Due</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(i => {
            const target =
              i.assetId   != null ? formatAssetLabel(assetById.get(i.assetId)) :
              i.trailerId != null ? formatTrailerLabel(trailerById.get(i.trailerId)) :
              '—';
            const targetIsAsset = i.assetId != null;
            return (
              <tr key={i.id}
                onClick={() => onSelect(i)}
                style={{
                  borderBottom: '1px solid var(--gc-border-light)',
                  cursor: 'pointer',
                  background: i.outOfService && i.status !== 'done' ? '#fff5f5' : undefined,
                  borderLeft: i.outOfService && i.status !== 'done' ? '3px solid #c62828' : '3px solid transparent',
                }}
                className="hover:bg-[var(--gc-hover)]">
                <Td>
                  <span className="font-semibold">{i.title}</span>
                  {i.reportId && (
                    <span className="ml-2 inline-block px-1.5 py-0.5 rounded-lg text-[9px] font-bold"
                      style={{ background: '#fff7ed', color: '#c2410c' }}>
                      from report
                    </span>
                  )}
                </Td>
                <Td>
                  <span className="inline-flex items-center gap-1.5">
                    {targetIsAsset
                      ? <Truck size={12} style={{ color: 'var(--gc-text-3)' }} />
                      : <Container size={12} style={{ color: 'var(--gc-text-3)' }} />}
                    {target}
                  </span>
                </Td>
                <Td><CategoryChip category={i.category} /></Td>
                <Td><PriorityChip priority={i.priority} /></Td>
                <Td><ActionStatusChip status={i.status} /></Td>
                <Td>{i.outOfService
                  ? <span style={{ background: '#fee2e2', color: '#c62828', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>OOS</span>
                  : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                </Td>
                <Td>{i.scheduledDate ?? <span style={{ color: 'var(--gc-text-3)' }}>—</span>}</Td>
                <Td>{i.dueDate ?? <span style={{ color: 'var(--gc-text-3)' }}>—</span>}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {total > PAGE_SIZE && (
        <PaginationFooter page={page} pageSize={PAGE_SIZE} total={total}
          onPrev={() => onPage(Math.max(0, page - 1))}
          onNext={() => onPage(page + 1)} />
      )}
    </div>
  );
}

// ── Report detail panel ────────────────────────────────────────────────

function ReportDetailPanel({
  report, driverName, targetLabel,
  onClose, onChanged, onConvert,
}: {
  report: MaintenanceReport;
  driverName: string;
  targetLabel: string;
  onClose: () => void;
  onChanged: () => void;
  onConvert: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function setStatus(next: 'reviewed' | 'dismissed') {
    if (busy) return;
    setBusy(true);
    try {
      await railway.updateMaintenanceReport(report.id, { status: next });
      onChanged();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'rgba(0,0,0,0.25)' }} onClick={onClose}>
      <div className="h-full overflow-y-auto" style={{ width: 'min(560px, 90vw)', background: 'var(--gc-surface)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2">
            <ClipboardList size={16} style={{ color: '#c2410c' }} />
            <span className="text-[14px] font-semibold">Driver Report</span>
            <ReportStatusChip status={report.status} />
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[var(--gc-hover)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <Row label="Driver" value={driverName} />
          <Row label={report.assetId != null ? 'Truck' : 'Trailer'} value={targetLabel} />
          <Row label="Reported" value={new Date(report.reportedAt).toLocaleString()} />
          {report.state && <Row label="State" value={report.state} />}

          <div>
            <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>Description</div>
            <div className="text-[13.5px] whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>{report.description}</div>
          </div>

          {report.photos && report.photos.length > 0 && (
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>Photos</div>
              <div className="grid grid-cols-3 gap-2">
                {report.photos.map(p => (
                  p.signedUrl ? (
                    <a key={p.id} href={p.signedUrl} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.signedUrl} alt={p.fileName} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8, border: '1px solid var(--gc-border-light)' }} />
                    </a>
                  ) : (
                    <div key={p.id} style={{ background: '#f1f3f4', width: '100%', aspectRatio: '1', borderRadius: 8 }} />
                  )
                ))}
              </div>
            </div>
          )}

          {report.actionItemId && (
            <div className="rounded-lg p-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <div className="text-[11px] font-bold" style={{ color: '#15803d' }}>This report has an action item.</div>
            </div>
          )}
        </div>

        {report.status !== 'converted' && report.status !== 'dismissed' && (
          <div className="px-5 py-4 flex gap-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button onClick={onConvert} disabled={busy}
              className="flex-1 px-4 py-2 rounded-lg text-[13px] font-semibold"
              style={{ background: '#1a73e8', color: '#fff', opacity: busy ? 0.6 : 1 }}>
              Save as Action Item
            </button>
            {report.status === 'open' && (
              <button onClick={() => void setStatus('reviewed')} disabled={busy}
                className="px-4 py-2 rounded-lg text-[13px] font-medium"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}>
                Mark Reviewed
              </button>
            )}
            <button onClick={() => void setStatus('dismissed')} disabled={busy}
              className="px-4 py-2 rounded-lg text-[13px] font-medium"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: '#991b1b' }}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Action item edit panel ─────────────────────────────────────────────

function ActionItemEditPanel({
  item, assetLabel, onClose, onSaved, onDeleted,
}: {
  item: MaintenanceActionItem;
  assetLabel: string;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title:          item.title,
    description:    item.description ?? '',
    category:       item.category,
    priority:       item.priority,
    status:         item.status,
    outOfService:   item.outOfService,
    scheduledDate:  item.scheduledDate ?? '',
    dueDate:        item.dueDate ?? '',
    vendor:         item.vendor ?? '',
    estimatedCost:  item.estimatedCost?.toString() ?? '',
    actualCost:     item.actualCost?.toString() ?? '',
  });

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const body: UpdateMaintenanceActionItemRequest = {
        title:          form.title,
        description:    form.description || null,
        category:       form.category,
        priority:       form.priority,
        status:         form.status,
        outOfService:   form.outOfService,
        scheduledDate:  form.scheduledDate || null,
        dueDate:        form.dueDate || null,
        vendor:         form.vendor || null,
        estimatedCost:  form.estimatedCost === '' ? null : Number(form.estimatedCost),
        actualCost:     form.actualCost    === '' ? null : Number(form.actualCost),
      };
      await railway.updateMaintenanceActionItem(item.id, body);
      onSaved();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm('Delete this action item?')) return;
    setBusy(true);
    try {
      await railway.deleteMaintenanceActionItem(item.id);
      onDeleted();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: 'rgba(0,0,0,0.25)' }} onClick={onClose}>
      <div className="h-full overflow-y-auto" style={{ width: 'min(560px, 90vw)', background: 'var(--gc-surface)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="flex items-center gap-2">
            <Wrench size={16} style={{ color: '#1a73e8' }} />
            <span className="text-[14px] font-semibold">Action Item</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[var(--gc-hover)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <FieldRow label={item.assetId != null ? 'Truck' : 'Trailer'} readOnlyValue={assetLabel} />
          <Field label="Title">
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
              style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
          </Field>
          <Field label="Description">
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
              style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)', resize: 'vertical' }} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category"><Select value={form.category} onChange={v => setForm({ ...form, category: v as MaintenanceCategory })} options={CATEGORIES} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={v => setForm({ ...form, priority: v as MaintenancePriority })} options={PRIORITIES} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status"><Select value={form.status} onChange={v => setForm({ ...form, status: v as MaintenanceActionStatus })} options={ACTION_STATUSES} labels={{ in_progress: 'In progress' }} /></Field>
            <Field label="Out of service">
              <label className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-[13px]"
                style={{ background: '#f8f9fa', border: `1px solid ${form.outOfService ? '#c62828' : 'var(--gc-border)'}`, color: form.outOfService ? '#c62828' : 'var(--gc-text-1)' }}>
                <input type="checkbox" checked={form.outOfService} onChange={e => setForm({ ...form, outOfService: e.target.checked })} />
                {form.outOfService ? 'OOS' : 'In service'}
              </label>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scheduled date">
              <input type="date" value={form.scheduledDate} onChange={e => setForm({ ...form, scheduledDate: e.target.value })}
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
            <Field label="Due date">
              <input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })}
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
          </div>
          <Field label="Vendor">
            <input value={form.vendor} onChange={e => setForm({ ...form, vendor: e.target.value })}
              className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
              style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estimated cost">
              <input value={form.estimatedCost} onChange={e => setForm({ ...form, estimatedCost: e.target.value.replace(/[^0-9.]/g, '') })}
                placeholder="0"
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none tabular-nums"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
            <Field label="Actual cost">
              <input value={form.actualCost} onChange={e => setForm({ ...form, actualCost: e.target.value.replace(/[^0-9.]/g, '') })}
                placeholder="0"
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none tabular-nums"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
          </div>
        </div>

        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button onClick={save} disabled={busy}
            className="flex-1 px-4 py-2 rounded-lg text-[13px] font-semibold"
            style={{ background: '#1a73e8', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            Save
          </button>
          <button onClick={del} disabled={busy}
            className="px-4 py-2 rounded-lg text-[13px] font-medium"
            style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: '#991b1b' }}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Action item modal (convert + create) ───────────────────────────────

function ActionItemModal({
  mode, fromReport, assetLabel, assets, trailers, onClose, onSaved,
}: {
  mode: 'convert' | 'create';
  fromReport?: MaintenanceReport;
  assetLabel?: string;
  assets?: Array<{ id: number; name: string; unit?: string; hidden?: boolean }>;
  trailers?: Array<{ id: number; name: string; trailerNumber?: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [targetKind, setTargetKind] = useState<'asset' | 'trailer'>('asset');
  const [form, setForm] = useState({
    assetId:        fromReport?.assetId ?? null as number | null,
    trailerId:      fromReport?.trailerId ?? null as number | null,
    title:          '',
    description:    fromReport?.description ?? '',
    category:       'repair' as MaintenanceCategory,
    priority:       'normal' as MaintenancePriority,
    outOfService:   false,
    scheduledDate:  '',
    dueDate:        '',
    vendor:         '',
    estimatedCost:  '',
  });
  // For convert mode, the asset/trailer is locked from the report.
  useEffect(() => {
    if (fromReport) {
      if (fromReport.assetId != null) setTargetKind('asset');
      if (fromReport.trailerId != null) setTargetKind('trailer');
    }
  }, [fromReport]);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'convert' && fromReport) {
        const body: ConvertMaintenanceReportRequest = {
          title:         form.title.trim() || undefined,
          description:   form.description || undefined,
          category:      form.category,
          priority:      form.priority,
          outOfService:  form.outOfService,
          scheduledDate: form.scheduledDate || undefined,
          dueDate:       form.dueDate       || undefined,
        };
        await railway.convertMaintenanceReport(fromReport.id, body);
      } else {
        const body: CreateMaintenanceActionItemRequest = {
          assetId:       targetKind === 'asset'   ? (form.assetId   ?? undefined) : undefined,
          trailerId:     targetKind === 'trailer' ? (form.trailerId ?? undefined) : undefined,
          title:         form.title.trim(),
          description:   form.description || undefined,
          category:      form.category,
          priority:      form.priority,
          outOfService:  form.outOfService,
          scheduledDate: form.scheduledDate || undefined,
          dueDate:       form.dueDate       || undefined,
          vendor:        form.vendor        || undefined,
          estimatedCost: form.estimatedCost === '' ? undefined : Number(form.estimatedCost),
        };
        if (!body.title) { alert('Title required'); return; }
        if (!body.assetId && !body.trailerId) { alert('Pick a truck or trailer'); return; }
        await railway.createMaintenanceActionItem(body);
      }
      onSaved();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.3)' }} onClick={onClose}>
      <div className="rounded-2xl" style={{ width: 'min(560px, 92vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--gc-surface)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <span className="text-[14px] font-semibold">
            {mode === 'convert' ? 'Save as Action Item' : 'New Action Item'}
          </span>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[var(--gc-hover)]"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {mode === 'convert' ? (
            <FieldRow label={fromReport?.assetId != null ? 'Truck' : 'Trailer'} readOnlyValue={assetLabel ?? '—'} />
          ) : (
            <>
              <div className="flex gap-2">
                {(['asset', 'trailer'] as const).map(k => (
                  <button key={k}
                    onClick={() => setTargetKind(k)}
                    className="flex-1 py-2 rounded-lg text-[13px] font-semibold"
                    style={{
                      background: targetKind === k ? '#1a73e8' : 'var(--gc-surface)',
                      color:      targetKind === k ? '#fff' : 'var(--gc-text-1)',
                      border:     `1px solid ${targetKind === k ? '#1a73e8' : 'var(--gc-border)'}`,
                    }}>
                    {k === 'asset' ? 'Truck' : 'Trailer'}
                  </button>
                ))}
              </div>
              <Field label={targetKind === 'asset' ? 'Truck' : 'Trailer'}>
                <select
                  value={targetKind === 'asset' ? (form.assetId ?? '') : (form.trailerId ?? '')}
                  onChange={e => {
                    const id = e.target.value === '' ? null : Number(e.target.value);
                    setForm(targetKind === 'asset' ? { ...form, assetId: id, trailerId: null } : { ...form, trailerId: id, assetId: null });
                  }}
                  className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                  style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }}>
                  <option value="">Select…</option>
                  {targetKind === 'asset'
                    ? (assets ?? []).filter(a => !a.hidden).map(a =>
                        <option key={a.id} value={a.id}>{formatAssetLabel({ name: a.name, unit: a.unit })}</option>)
                    : (trailers ?? []).map(t =>
                        <option key={t.id} value={t.id}>{formatTrailerLabel({ name: t.name, num: t.trailerNumber })}</option>)
                  }
                </select>
              </Field>
            </>
          )}
          <Field label="Title">
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              placeholder={mode === 'convert' ? 'Auto-generated from description' : 'Brief work order title'}
              className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
              style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
          </Field>
          <Field label="Description">
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              rows={4}
              className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
              style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)', resize: 'vertical' }} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category"><Select value={form.category} onChange={v => setForm({ ...form, category: v as MaintenanceCategory })} options={CATEGORIES} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={v => setForm({ ...form, priority: v as MaintenancePriority })} options={PRIORITIES} /></Field>
          </div>
          <Field label="Out of service">
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-[13px]"
              style={{ background: '#f8f9fa', border: `1px solid ${form.outOfService ? '#c62828' : 'var(--gc-border)'}`, color: form.outOfService ? '#c62828' : 'var(--gc-text-1)' }}>
              <input type="checkbox" checked={form.outOfService} onChange={e => setForm({ ...form, outOfService: e.target.checked })} />
              {form.outOfService ? 'Mark out of service' : 'In service'}
            </label>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scheduled date">
              <input type="date" value={form.scheduledDate} onChange={e => setForm({ ...form, scheduledDate: e.target.value })}
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
            <Field label="Due date">
              <input type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })}
                className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
            </Field>
          </div>
          {mode === 'create' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor">
                <input value={form.vendor} onChange={e => setForm({ ...form, vendor: e.target.value })}
                  className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
                  style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
              </Field>
              <Field label="Estimated cost">
                <input value={form.estimatedCost} onChange={e => setForm({ ...form, estimatedCost: e.target.value.replace(/[^0-9.]/g, '') })}
                  placeholder="0"
                  className="w-full text-[13px] px-3 py-2 rounded-lg outline-none tabular-nums"
                  style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }} />
              </Field>
            </div>
          )}
        </div>
        <div className="px-5 py-4 flex gap-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button onClick={save} disabled={busy}
            className="flex-1 px-4 py-2 rounded-lg text-[13px] font-semibold"
            style={{ background: '#1a73e8', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : (mode === 'convert' ? 'Save as Action Item' : 'Create')}
          </button>
          <button onClick={onClose}
            className="px-4 py-2 rounded-lg text-[13px] font-medium"
            style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Small bits ─────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      {children}
    </div>
  );
}

function FieldRow({ label, readOnlyValue }: { label: string; readOnlyValue: string }) {
  return (
    <Field label={label}>
      <div className="text-[13px] px-3 py-2 rounded-lg" style={{ background: '#f1f3f4', color: 'var(--gc-text-2)' }}>{readOnlyValue}</div>
    </Field>
  );
}

function Select<T extends string>({ value, onChange, options, labels }: { value: T; onChange: (v: T) => void; options: readonly T[]; labels?: Partial<Record<T, string>> }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value as T)}
      className="w-full text-[13px] px-3 py-2 rounded-lg outline-none"
      style={{ background: '#f8f9fa', border: '1px solid var(--gc-border)' }}>
      {options.map(o => <option key={o} value={o}>{labels?.[o] ?? o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
    </select>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
      <Loader2 size={20} className="animate-spin" />
    </div>
  );
}

function Empty({ kind }: { kind: 'reports' | 'action-items' }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: 'var(--gc-text-3)' }}>
      {kind === 'reports'
        ? <ClipboardList size={28} style={{ color: '#9aa0a6', marginBottom: 12 }} />
        : <Wrench size={28} style={{ color: '#9aa0a6', marginBottom: 12 }} />}
      <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
        {kind === 'reports' ? 'No reports yet' : 'No action items'}
      </div>
      <div className="text-sm">
        {kind === 'reports' ? 'Drivers submit from the mobile app.' : 'Convert a report or create one manually.'}
      </div>
    </div>
  );
}

// ── Status / category / priority chips ─────────────────────────────────

function ReportStatusChip({ status }: { status: MaintenanceReportStatus }) {
  const p =
    status === 'open'      ? { bg: '#fef3c7', fg: '#92400e', border: '#fde68a', label: 'Open'      } :
    status === 'reviewed'  ? { bg: '#dbeafe', fg: '#1e40af', border: '#bfdbfe', label: 'Reviewed'  } :
    status === 'converted' ? { bg: '#dcfce7', fg: '#15803d', border: '#86efac', label: 'Converted' } :
                             { bg: '#f3f4f6', fg: '#4b5563', border: '#d1d5db', label: 'Dismissed' };
  return <span className="inline-block px-2 py-0.5 rounded-lg text-[10.5px] font-bold" style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>{p.label}</span>;
}
function ActionStatusChip({ status }: { status: MaintenanceActionStatus }) {
  const p =
    status === 'open'        ? { bg: '#fef3c7', fg: '#92400e', label: 'Open' } :
    status === 'in_progress' ? { bg: '#dbeafe', fg: '#1e40af', label: 'In progress' } :
                               { bg: '#dcfce7', fg: '#15803d', label: 'Done' };
  return <span className="inline-block px-2 py-0.5 rounded-lg text-[10.5px] font-bold" style={{ background: p.bg, color: p.fg }}>{p.label}</span>;
}
function PriorityChip({ priority }: { priority: MaintenancePriority }) {
  const p =
    priority === 'urgent' ? { bg: '#fee2e2', fg: '#991b1b', label: 'Urgent' } :
    priority === 'high'   ? { bg: '#ffedd5', fg: '#c2410c', label: 'High'   } :
    priority === 'normal' ? { bg: '#f1f5f9', fg: '#475569', label: 'Normal' } :
                            { bg: '#f3f4f6', fg: '#9ca3af', label: 'Low'    };
  return <span className="inline-block px-2 py-0.5 rounded-lg text-[10.5px] font-bold" style={{ background: p.bg, color: p.fg }}>{p.label}</span>;
}
function CategoryChip({ category }: { category: MaintenanceCategory }) {
  const label = category.charAt(0).toUpperCase() + category.slice(1);
  return <span className="inline-block px-2 py-0.5 rounded-lg text-[10.5px] font-bold" style={{ background: '#f1f5f9', color: '#475569' }}>{label}</span>;
}

// ── Formatters ─────────────────────────────────────────────────────────

function formatAssetLabel(a?: { name: string; unit?: string }): string {
  if (!a) return '—';
  if (a.unit) return `#${a.unit}${a.name ? ` · ${a.name}` : ''}`;
  return a.name;
}
function formatTrailerLabel(t?: { name: string; num?: string }): string {
  if (!t) return '—';
  if (t.num) return `#${t.num}${t.name ? ` · ${t.name}` : ''}`;
  return t.name;
}
