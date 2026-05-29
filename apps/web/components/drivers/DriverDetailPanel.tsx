'use client';

/**
 * DriverDetailPanel — slide-over for one driver's period detail.
 *
 * Opens from a DriversView row click. Renders the same KPI summary
 * the table row shows but big, plus drill-down lists:
 *   • Loads in the period — load #, broker, miles, POD status
 *   • Inspections — date + has-defects badge
 *
 * Strict drop-from-page model: the panel doesn't mutate anything; it's
 * a focused read of data already on the parent's hand. Closing fires
 * onClose, parent unmounts.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X, Truck, ClipboardCheck, Fuel as FuelIcon, Wrench, MapPin, FileCheck2 } from 'lucide-react';
import type { LoadSummary } from '@fleetcal/types';
import { useCalendarStore } from '@/store/useCalendarStore';
import type { DriverScorecardRow } from './DriversView';

interface Props {
  /** The aggregated row for the selected driver. Undefined while the
   *  parent's rows recompute (e.g. period change with stale openId). */
  row: DriverScorecardRow | undefined;
  /** Pre-filtered to this driver's loads. Parent does the filter so
   *  the panel doesn't need to know about period/driver-id matching. */
  loads: LoadSummary[];
  /** Pre-filtered inspections. Same shape as the parent's flat list. */
  inspections: Array<{ id: string; submittedAt: string; hasDefects: boolean; inspectionDate: string }>;
  /** Display string for the period (e.g. "2026-05-01 → 2026-05-31"). */
  period: string;
  onClose: () => void;
}

export default function DriverDetailPanel({ row, loads, inspections, period, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const openEditModal = useCalendarStore(s => s.openEditModal);
  // Esc to close — same convention as the rest of the modal stack.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!row) return null;

  // Open the load's event modal IN PLACE — the drivers page mounts
  // EventModal at the route level (mirrors the accounting page), so
  // openEditModal pops it right over this surface without a route
  // change. The modal's own form-init effect will refetch the event
  // by id if the local cache is cold, so a load from outside the
  // hydrated window still opens correctly.
  const openLoad = (loadId: string) => {
    openEditModal(loadId);
  };

  // For now inspections still hand off to the equipment page (the
  // InspectionDetail render is tightly coupled to that page's media
  // sidebar). The ?inspection=<id> deep link there pops the panel on
  // mount; we keep this hop until we extract the detail to a shared
  // modal component.
  const openInspection = (inspectionId: string) => {
    router.push(`/equipment?tab=inspections&inspection=${encodeURIComponent(inspectionId)}`);
  };

  const content = (
    <div
      ref={overlayRef}
      className="fixed inset-0 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.4)', zIndex: 1000 }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}>
      <div
        className="flex flex-col"
        style={{
          width: 'min(95vw, 640px)',
          background: 'var(--gc-surface)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.18)',
        }}
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid var(--gc-border)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[18px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {row.driverName}
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {period}
            </div>
          </div>
          <button onClick={onClose}
            className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* KPI grid — big, scannable. Six cells in a 3-column grid. */}
          <div className="grid grid-cols-3 gap-3">
            <Kpi icon={<Truck size={14} />}          label="Loads"     value={String(row.loads)}     muted={row.loads === 0} />
            <Kpi icon={<MapPin size={14} />}         label="Miles"     value={row.miles.toLocaleString()} muted={row.miles === 0} />
            <Kpi icon={<ClipboardCheck size={14} />} label="Insp"      value={String(row.inspections)}
                 suffix={row.inspectionsWithDefects > 0 ? `· ${row.inspectionsWithDefects} defects` : undefined}
                 suffixTone="amber"
                 muted={row.inspections === 0} />
            <Kpi icon={<ClipboardCheck size={14} />} label="Insp %"    value={pct(row.inspectionCompliancePct)} thresholds={{ ok: 90, warn: 70 }} pctValue={row.inspectionCompliancePct} />
            <Kpi icon={<FileCheck2 size={14} />}     label="POD %"     value={pct(row.podOnTimePct)} thresholds={{ ok: 90, warn: 70 }} pctValue={row.podOnTimePct}
                 suffix={row.podOnTimeOf > 0 ? `of ${row.podOnTimeOf}` : undefined} />
            <Kpi icon={<MapPin size={14} />}         label="Stops %"   value={pct(row.stopCheckInPct)} thresholds={{ ok: 90, warn: 70 }} pctValue={row.stopCheckInPct}
                 suffix={row.stopCheckInOf > 0 ? `of ${row.stopCheckInOf}` : undefined} />
            <Kpi icon={<Truck size={14} />}          label="Trailer %" value={pct(row.trailerReportedPct)} thresholds={{ ok: 95, warn: 80 }} pctValue={row.trailerReportedPct} />
            <Kpi icon={<FuelIcon size={14} />}       label="Fuel"      value={String(row.fuelReports)}        muted={row.fuelReports === 0} />
            <Kpi icon={<Wrench size={14} />}         label="Maint"     value={String(row.maintenanceReports)} muted={row.maintenanceReports === 0} />
          </div>

          {/* Loads list */}
          <Section title={`Loads (${loads.length})`} emptyText="No loads in this period.">
            {loads.length > 0 && (
              <div className="flex flex-col rounded-lg overflow-hidden"
                style={{ border: '1px solid var(--gc-border-light)' }}>
                {loads.slice(0, 50).map((l, i) => {
                  const podCount = l.documentCounts?.pod ?? 0;
                  return (
                    <button
                      key={l.loadId}
                      type="button"
                      onClick={() => openLoad(l.loadId)}
                      title="Open this load on the calendar"
                      className="flex items-center gap-3 px-3 py-2.5 text-[13px] text-left w-full transition-colors"
                      style={{
                        borderTop: i === 0 ? 'none' : '1px solid var(--gc-border-light)',
                        background: 'var(--gc-surface)',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
                      <span className="font-semibold tabular-nums hover:underline" style={{ color: 'var(--gc-blue)', minWidth: 64 }}>
                        {l.loadNum ? `#${l.loadNum}` : `#${l.internalLoadId}`}
                      </span>
                      <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                        {l.broker ?? '—'}
                      </span>
                      <span className="text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)', minWidth: 70, textAlign: 'right' }}>
                        {l.totalLoadedMiles != null ? `${Math.round(l.totalLoadedMiles)} mi` : '—'}
                      </span>
                      <span
                        className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded shrink-0"
                        style={{
                          background: podCount > 0 ? '#dcfce7' : '#fef3c7',
                          color:      podCount > 0 ? '#166534' : '#92400e',
                        }}>
                        {podCount > 0 ? 'POD' : 'no POD'}
                      </span>
                    </button>
                  );
                })}
                {loads.length > 50 && (
                  <div className="px-3 py-2 text-[11.5px] text-center"
                    style={{ color: 'var(--gc-text-3)', background: 'var(--gc-bg)', borderTop: '1px solid var(--gc-border-light)' }}>
                    + {loads.length - 50} more — scroll truncated for performance.
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Inspections list */}
          <Section title={`Inspections (${inspections.length})`} emptyText="No inspections submitted in this period.">
            {inspections.length > 0 && (
              <div className="flex flex-col rounded-lg overflow-hidden"
                style={{ border: '1px solid var(--gc-border-light)' }}>
                {[...inspections]
                  .sort((a, b) => b.inspectionDate.localeCompare(a.inspectionDate))
                  .slice(0, 50)
                  .map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openInspection(r.id)}
                    title="Open this DVIR on the equipment page"
                    className="flex items-center gap-3 px-3 py-2.5 text-[13px] text-left w-full transition-colors"
                    style={{
                      borderTop: i === 0 ? 'none' : '1px solid var(--gc-border-light)',
                      background: 'var(--gc-surface)',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}>
                    <span className="font-semibold tabular-nums hover:underline" style={{ color: 'var(--gc-blue)', minWidth: 100 }}>
                      {r.inspectionDate}
                    </span>
                    <span className="flex-1" style={{ color: 'var(--gc-text-3)' }}>
                      {new Date(r.submittedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </span>
                    {r.hasDefects ? (
                      <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                        style={{ background: '#fce8e6', color: '#c5221f' }}>
                        defects
                      </span>
                    ) : (
                      <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                        style={{ background: '#e6f4ea', color: '#137333' }}>
                        clear
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

// ── Helpers ──────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v == null ? '—' : `${v}%`;
}

function Kpi({
  icon, label, value, suffix, suffixTone, muted, thresholds, pctValue,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  suffix?: string;
  /** Tone for the suffix line. amber = warning-ish (e.g. defect count). */
  suffixTone?: 'amber' | 'muted';
  muted?: boolean;
  /** When set, the value gets a green/amber/red color step based on the
   *  numeric percentage falling into the threshold tiers. */
  thresholds?: { ok: number; warn: number };
  pctValue?: number | null;
}) {
  let valueColor = muted ? 'var(--gc-text-3)' : 'var(--gc-text-1)';
  if (thresholds && pctValue != null) {
    valueColor =
      pctValue >= thresholds.ok   ? '#137333' :
      pctValue >= thresholds.warn ? '#b06000' :
                                    '#c5221f';
  }
  const suffixColor =
    suffixTone === 'amber' ? '#b06000' :
                             'var(--gc-text-3)';
  return (
    <div
      className="rounded-lg px-3 py-2.5"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border-light)',
        minWidth:   0,
      }}>
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider mb-1"
        style={{ color: 'var(--gc-text-3)' }}>
        {icon}{label}
      </div>
      <div className="text-[18px] font-bold tabular-nums truncate" style={{ color: valueColor, lineHeight: 1.1 }}>
        {value}
      </div>
      {suffix && (
        <div className="text-[11px] mt-0.5 truncate" style={{ color: suffixColor }}>
          {suffix}
        </div>
      )}
    </div>
  );
}

function Section({
  title, children, emptyText,
}: {
  title: string;
  children: React.ReactNode;
  emptyText: string;
}) {
  const empty = !children || (Array.isArray(children) && children.length === 0);
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider mb-2"
        style={{ color: 'var(--gc-text-3)' }}>
        {title}
      </div>
      {empty ? (
        <div className="text-[12.5px] rounded-lg py-3 px-3"
          style={{ background: 'var(--gc-bg)', border: '1px dashed var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
          {emptyText}
        </div>
      ) : children}
    </div>
  );
}
