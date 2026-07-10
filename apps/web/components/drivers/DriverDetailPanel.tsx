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

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X, Truck, ClipboardCheck, Fuel as FuelIcon, Wrench, MapPin, FileCheck2, ShieldAlert } from 'lucide-react';
import type { LoadSummary, PerformanceEventRow } from '@fleetcal/types';
import { railway } from '@/lib/railway';
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

          {/* Safety — 30d rolling snapshot from the safety scoring
              endpoint. Score + events sit on `row` already; this block
              re-frames them so a dispatcher can see the driver's safety
              picture without having to interpret the tiny table cell. */}
          <Section title="Safety · trailing 30 days" emptyText="No safety data — driver has no ELD miles in the last 30 days.">
            {row.safetyMiles30d > 0 && (
              <div
                style={{
                  border: '1px solid var(--gc-border-light)',
                  borderRadius: 10,
                  padding: 14,
                  background: 'var(--gc-surface)',
                  display: 'flex',
                  gap: 20,
                  alignItems: 'center',
                }}
              >
                <SafetyScoreBadge
                  score={row.safetyScore}
                  prevScore={row.safetyPrevScore}
                  flagged={row.safetyFlagged}
                />
                <div className="flex-1 flex flex-col gap-1" style={{ fontSize: 12.5, color: 'var(--gc-text-2)' }}>
                  <div>
                    <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                      {row.safetyEvents}
                    </span>{' '}
                    total event{row.safetyEvents === 1 ? '' : 's'}
                    {row.safetySevereEvents > 0 && (
                      <>
                        {' · '}
                        <span className="font-semibold" style={{ color: '#c5221f' }}>
                          {row.safetySevereEvents} severe
                        </span>
                      </>
                    )}
                  </div>
                  <div className="tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                    {row.safetyMiles30d.toLocaleString()} mi driven
                  </div>
                  {row.safetyFlagged && (
                    <div style={{ color: '#c5221f', fontSize: 11.5, marginTop: 2 }}>
                      <ShieldAlert size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
                      Auto-flagged for coaching — score below 60 with multiple events and enough miles to matter.
                    </div>
                  )}
                </div>
              </div>
            )}
            {/* Event list — the actual events feeding the score. Same
                attribution as scoring (notified > assigned), accepted
                disputes excluded. */}
            <SafetyEventsList driverId={row.driverId} />
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

/** Actual list of safety events attributed to this driver in the last
 *  30 days. Same attribution the safety score uses, accepted disputes
 *  excluded — so this list is exactly what fed the score. Fetched on
 *  driver-open, cached at the RQ layer would be nice but this file
 *  isn't a RQ consumer yet; fresh fetch per open. */
function SafetyEventsList({ driverId }: { driverId: number }) {
  const [events, setEvents] = useState<PerformanceEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    // 720h = 30 days — matches the safety score window. Trailing zero
    // shows what's actually in scope for the current score.
    railway.listDriverSafetyEvents(driverId, 720)
      .then(r => { if (!cancelled) { setEvents(r.events); setLoading(false); } })
      .catch(e => { if (!cancelled) { setErr((e as Error).message ?? 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [driverId]);

  if (loading) {
    return (
      <div style={{ padding: 20, fontSize: 12.5, color: 'var(--gc-text-3)', textAlign: 'center' }}>
        Loading events…
      </div>
    );
  }
  if (err) {
    return (
      <div style={{ padding: 12, fontSize: 12.5, color: '#c5221f' }}>
        Couldn&rsquo;t load events: {err}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div
        style={{
          padding: 20, fontSize: 12.5, color: 'var(--gc-text-3)', textAlign: 'center',
          border: '1px dashed var(--gc-border-light)', borderRadius: 10,
          marginTop: 12,
        }}
      >
        No safety events in the last 30 days.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4,
        color: 'var(--gc-text-3)', textTransform: 'uppercase',
        marginBottom: 4, paddingLeft: 4,
      }}>
        Events feeding the score · {events.length}
      </div>
      {events.map(e => (
        <div
          key={e.id}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 10,
            alignItems: 'center',
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid var(--gc-border-light)',
            background: 'var(--gc-surface)',
          }}
        >
          <SeverityDot level={e.severity_level} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {eventTypeLabel(e.event_type)}
              {e.severity_display ? ` · ${e.severity_display}` : ''}
              {e.dispute_status === 'pending' && (
                <span style={{
                  marginLeft: 6, padding: '1px 5px', borderRadius: 3,
                  fontSize: 9.5, fontWeight: 700, letterSpacing: 0.3,
                  color: '#991b1b', background: '#fee2e2',
                }}>DISPUTED</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--gc-text-2)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {e.asset_name ?? e.vehicle_number ?? `Vehicle ${e.vehicle_id ?? ''}`}
              {e.location_label ? ` · ${e.location_label}` : ''}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--gc-text-3)', whiteSpace: 'nowrap' }}>
            {fmtEventTime(e.event_time)}
          </div>
        </div>
      ))}
    </div>
  );
}

function SeverityDot({ level }: { level: PerformanceEventRow['severity_level'] }) {
  const color =
    level === 'severe'   ? '#c5221f' :
    level === 'moderate' ? '#b06000' :
                           '#3b82f6';
  return (
    <span
      aria-hidden
      title={level ?? 'unknown severity'}
      style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: 4,
        background: color,
      }}
    />
  );
}

function eventTypeLabel(t: string): string {
  switch (t) {
    case 'hard_accel':   return 'Hard acceleration';
    case 'hard_brake':   return 'Hard brake';
    case 'hard_corner':  return 'Hard cornering';
    case 'tailgating':   return 'Tailgating';
    case 'cell_phone':   return 'Phone use';
    case 'distraction':  return 'Distraction';
    case 'drowsiness':   return 'Drowsiness';
    case 'seatbelt':     return 'Seatbelt violation';
    default:             return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

function fmtEventTime(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    timeZone: 'America/Denver',
    month:    'short',
    day:      'numeric',
    hour:     'numeric',
    minute:   '2-digit',
  });
}

function SafetyScoreBadge({
  score, prevScore, flagged,
}: {
  score: number | null;
  prevScore: number | null;
  flagged: boolean;
}) {
  if (score == null) {
    return (
      <div style={{ fontSize: 32, color: 'var(--gc-text-3)', minWidth: 80, textAlign: 'center' }}>
        —
      </div>
    );
  }
  const color =
    score >= 85 ? '#137333' :
    score >= 70 ? '#b06000' :
                  '#c5221f';
  const delta = prevScore != null ? score - prevScore : 0;
  return (
    <div style={{ minWidth: 80, textAlign: 'center' }}>
      <div className="tabular-nums" style={{ fontSize: 34, fontWeight: 800, color, lineHeight: 1 }}>
        {score}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 }}>
        Safety score
      </div>
      {prevScore != null && Math.abs(delta) >= 3 && (
        <div style={{ fontSize: 11, color: delta > 0 ? '#137333' : '#c5221f', marginTop: 3 }}>
          {delta > 0 ? '↑' : '↓'} {Math.abs(delta)} vs prev 30d
        </div>
      )}
      {flagged && (
        <div style={{ fontSize: 9.5, fontWeight: 700, color: '#c5221f', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 }}>
          Flagged
        </div>
      )}
    </div>
  );
}

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
