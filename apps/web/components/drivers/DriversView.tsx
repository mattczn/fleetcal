'use client';

/**
 * DriversView — the scorecard roster.
 *
 * Layout: ManagementHeader → period selector → OpsTable of drivers.
 * Clicking a row opens DriverDetailPanel on the right for drill-down.
 *
 * Each row's metrics are computed client-side from a single batch of
 * period-scoped fetches. The Row interface below is the only thing
 * the table renderers know about — keeps the cell render logic
 * decoupled from the (much messier) aggregation pipeline.
 */

import { useEffect, useMemo, useState } from 'react';
import { Gauge, Loader2 } from 'lucide-react';
import { railway } from '@/lib/railway';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import { OpsTable, type OpsColumn } from '@/components/ui/OpsTable';
import { type Period, getPeriodRange, defaultCustomRangeISO } from '@/lib/periodRange';
import DriverDetailPanel from './DriverDetailPanel';
import type { Driver } from '@/lib/types';
import type { LoadSummary, FuelReport, MaintenanceReport } from '@fleetcal/types';

// ── Row shape ─────────────────────────────────────────────────────────
//
// One row per driver who had activity in the period. Counts are raw;
// rates (compliance %, on-time %) are computed up front so cell
// renderers don't have to do div-by-zero gymnastics.

export interface DriverScorecardRow {
  driverId: number;
  driverName: string;
  // Loads
  loads: number;            // pickup-leg starts in window
  miles: number;            // sum of totalLoadedMiles
  loadIds: string[];        // for drill-down + POD computation
  // Inspections
  inspections: number;
  inspectionsWithDefects: number;
  // Compliance % = days the driver submitted an inspection / days the
  // driver was on a load. Capped at 100%; surfaces 0% only if the
  // driver had loads but no inspections (the actionable signal).
  inspectionCompliancePct: number | null;
  // Fuel + maintenance
  fuelReports: number;
  maintenanceReports: number;
  // POD-on-time: % of delivered loads where POD arrived within 24h
  // of delivery. null when there were no deliveries in the window.
  podOnTimePct: number | null;
  podOnTimeOf: number;      // count of completed deliveries in window
  // Stop check-ins: % of stops with arrivedAt populated
  stopCheckInPct: number | null;
  stopCheckInOf: number;
  // Trailer-on-load: % of loads where a trailer was reported
  trailerReportedPct: number | null;
}

// Default period: "This week" (Saturday → Friday, matches the rest
// of the app). Dispatchers look at the scorecard most often as a
// "how's the team doing right now" snapshot, so the current week
// is the natural starting view — they can widen to 30d / month
// from the period selector when they need to see further back.
const DEFAULT_PERIOD: Period = 'week';

export default function DriversView() {
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [customRange, setCustomRange] = useState(defaultCustomRangeISO());
  // getPeriodRange returns Date objects; serialize to YYYY-MM-DD for
  // the API filters (and for our compliance-day computation below).
  const range = useMemo(() => {
    const r = getPeriodRange(period, { startISO: customRange.start, endISO: customRange.end });
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmt(r.start), end: fmt(r.end) };
  }, [period, customRange]);

  // Active driver focused in the right-side detail panel.
  const [openDriverId, setOpenDriverId] = useState<number | null>(null);

  // ── Data fetch — 4 parallel calls scoped to the period. ──────────
  // Driver list is unscoped (it's the universe of who exists, not
  // who was active); the active-in-window filter happens at the row
  // build below.
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loads, setLoads] = useState<LoadSummary[]>([]);
  const [inspections, setInspections] = useState<Array<{ driverId: number; submittedAt: string; hasDefects: boolean; inspectionDate: string }>>([]);
  const [fuels, setFuels] = useState<FuelReport[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      railway.listDrivers(),
      // Pickup ∈ window. Server filters by pickup-leg start.
      railway.listLoadSummaries({
        pickupFrom: range.start,
        pickupTo:   range.end,
        limit:      '5000',
      }),
      railway.listInspectionReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }),
      railway.listFuelReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }),
      railway.listMaintenanceReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }),
    ])
      .then(([driverRes, loadRes, inspRes, fuelRes, maintRes]) => {
        if (cancelled) return;
        setDrivers(driverRes.drivers);
        setLoads(loadRes.loads);
        setInspections(inspRes.inspections.map(r => ({
          driverId:       r.driverId,
          submittedAt:    r.submittedAt,
          hasDefects:     r.hasDefects,
          inspectionDate: r.inspectionDate,
        })));
        setFuels(fuelRes.fuelReports);
        setMaintenance(maintRes.reports);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[drivers] data fetch failed:', err);
        setError((err as Error).message ?? 'Failed to load driver data');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range.start, range.end]);

  // ── Aggregation — one pass per driver. ──────────────────────────
  //
  // Pre-bucket the source data by driverId so each driver row is an
  // O(1) lookup rather than five filters per row. Drivers with no
  // activity in the period are dropped (see scope decision in the
  // page-level comment).
  const rows: DriverScorecardRow[] = useMemo(() => {
    const driverById = new Map(drivers.map(d => [d.id, d]));

    // Bucket loads by their pickup-leg driver. Relays have two legs;
    // both drivers get credit for "loads delivered" (each handled
    // one leg's worth of work). We also need a flat list of loads
    // per driver for POD-on-time computation.
    const loadsByDriver = new Map<number, LoadSummary[]>();
    const milesByDriver = new Map<number, number>();
    for (const l of loads) {
      for (const leg of l.legs) {
        if (leg.driverId == null) continue;
        if (!loadsByDriver.has(leg.driverId)) loadsByDriver.set(leg.driverId, []);
        loadsByDriver.get(leg.driverId)!.push(l);
        // Add this leg's loaded miles to the driver's total. Each
        // driver only gets credit for THEIR leg, not the whole load.
        const m = leg.loadedMiles ?? 0;
        milesByDriver.set(leg.driverId, (milesByDriver.get(leg.driverId) ?? 0) + m);
      }
    }

    const inspectionsByDriver = new Map<number, typeof inspections>();
    for (const r of inspections) {
      if (!inspectionsByDriver.has(r.driverId)) inspectionsByDriver.set(r.driverId, []);
      inspectionsByDriver.get(r.driverId)!.push(r);
    }

    const fuelCountByDriver = new Map<number, number>();
    for (const r of fuels) {
      if (r.driverId == null) continue;
      fuelCountByDriver.set(r.driverId, (fuelCountByDriver.get(r.driverId) ?? 0) + 1);
    }

    const maintCountByDriver = new Map<number, number>();
    for (const r of maintenance) {
      if (r.driverId == null) continue;
      maintCountByDriver.set(r.driverId, (maintCountByDriver.get(r.driverId) ?? 0) + 1);
    }

    // Driver ids that touched ANYTHING in the period. The union is
    // what we render — pre-decided in the scoping question.
    const activeIds = new Set<number>([
      ...loadsByDriver.keys(),
      ...inspectionsByDriver.keys(),
      ...fuelCountByDriver.keys(),
      ...maintCountByDriver.keys(),
    ]);

    const out: DriverScorecardRow[] = [];
    for (const driverId of activeIds) {
      const driver = driverById.get(driverId);
      if (!driver) continue; // soft-deleted or filtered
      const driverLoads = loadsByDriver.get(driverId) ?? [];
      const driverInsps = inspectionsByDriver.get(driverId) ?? [];

      // Inspection compliance = days an inspection was submitted
      // ÷ days the driver had a load SCHEDULED. We walk each load
      // pickup-day → delivery-day inclusive (the period of time the
      // driver is responsible for the truck), but skip cancelled
      // loads — those don't count as "scheduled" for compliance
      // purposes. Per-day distinct so a 3-day OTR run with one
      // inspection counts as 1/3, not 1/many.
      const inspDays = new Set(driverInsps.map(r => r.inspectionDate));
      const loadDays = new Set<string>();
      for (const l of driverLoads) {
        if (l.pickupStatus === 'cancelled') continue;
        const startDay = l.pickupAt.slice(0, 10);
        const endDay   = l.deliveryAt.slice(0, 10);
        // Walk inclusive. Most loads are 1-3 days; even an OTR run
        // is bounded — no need to bail.
        let d = startDay;
        while (d <= endDay) {
          loadDays.add(d);
          const nx = new Date(`${d}T00:00:00`);
          nx.setDate(nx.getDate() + 1);
          d = nx.toISOString().slice(0, 10);
          if (d > endDay) break; // belt-and-braces
        }
      }
      const inspectionCompliancePct = loadDays.size === 0
        ? null
        : Math.round((inspDays.size / loadDays.size) * 100);

      // POD on-time = % of delivered loads whose POD doc was
      // uploaded within 24 hours of deliveryAt. Server-side
      // podUploadedAt = max(uploaded_at) for kind='pod' on this
      // load. Eligible denominator: only loads whose delivery is in
      // the past (we can't grade on-time-ness for future deliveries).
      // Missing podUploadedAt counts AGAINST the driver — uploading
      // late or not at all both fail the metric.
      let podOnTimeNum = 0, podOnTimeOf = 0;
      const nowMs = Date.now();
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      for (const l of driverLoads) {
        if (l.pickupStatus === 'cancelled' || l.isTonu) continue;
        const deliveredMs = new Date(`${l.deliveryAt}Z`).getTime();
        if (!Number.isFinite(deliveredMs) || deliveredMs > nowMs) continue;
        podOnTimeOf++;
        if (!l.podUploadedAt) continue;
        const uploadedMs = new Date(l.podUploadedAt).getTime();
        if (!Number.isFinite(uploadedMs)) continue;
        if (uploadedMs - deliveredMs <= TWENTY_FOUR_HOURS) podOnTimeNum++;
      }
      const podOnTimePct = podOnTimeOf === 0 ? null
        : Math.round((podOnTimeNum / podOnTimeOf) * 100);

      // Stop check-ins: legs[].stops[].arrivedAt populated / total.
      let stopCheckInNum = 0, stopCheckInOf = 0;
      for (const l of driverLoads) {
        for (const leg of l.legs) {
          if (leg.driverId !== driverId) continue;
          for (const s of leg.stops) {
            stopCheckInOf++;
            if (s.arrivedAt) stopCheckInNum++;
          }
        }
      }
      const stopCheckInPct = stopCheckInOf === 0 ? null
        : Math.round((stopCheckInNum / stopCheckInOf) * 100);

      // Trailer reported: loads where THIS driver's leg has trailerId.
      let trailerNum = 0, trailerOf = 0;
      for (const l of driverLoads) {
        for (const leg of l.legs) {
          if (leg.driverId !== driverId) continue;
          trailerOf++;
          if (leg.trailerId != null) trailerNum++;
        }
      }
      const trailerReportedPct = trailerOf === 0 ? null
        : Math.round((trailerNum / trailerOf) * 100);

      const insWithDefects = driverInsps.filter(r => r.hasDefects).length;

      out.push({
        driverId,
        driverName: driver.name,
        loads: driverLoads.length,
        miles: Math.round(milesByDriver.get(driverId) ?? 0),
        loadIds: driverLoads.map(l => l.loadId),
        inspections: driverInsps.length,
        inspectionsWithDefects: insWithDefects,
        inspectionCompliancePct,
        fuelReports: fuelCountByDriver.get(driverId) ?? 0,
        maintenanceReports: maintCountByDriver.get(driverId) ?? 0,
        podOnTimePct,
        podOnTimeOf,
        stopCheckInPct,
        stopCheckInOf,
        trailerReportedPct,
      });
    }

    // Default sort: most-loads first. The table is also sortable so
    // dispatchers can re-rank by inspection compliance or POD on time.
    out.sort((a, b) => b.loads - a.loads);
    return out;
  }, [drivers, loads, inspections, fuels, maintenance]);

  // ── Columns ─────────────────────────────────────────────────────
  // Every numeric / percent column is centered (both header AND cell)
  // so the column reads as a single visual line down the table. The
  // Driver name column stays left-aligned — long names need a left
  // anchor or they look unmoored.
  const columns = useMemo<OpsColumn<DriverScorecardRow>[]>(() => [
    {
      key: 'driverName', header: 'Driver', width: 200,
      pinned: 'left', alwaysVisible: true, sortable: true,
      sortValue: r => r.driverName,
      render: r => (
        <span className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>
          {r.driverName}
        </span>
      ),
    },
    {
      key: 'loads', header: 'Loads', width: 80, align: 'center',
      sortable: true,
      render: r => (
        <span className="font-semibold tabular-nums">{r.loads}</span>
      ),
    },
    {
      // Miles = sum of pickup-leg loaded_miles for THIS driver's legs
      // (so each driver of a relay only gets credit for their share,
      // not the full load). Deadhead miles are NOT included.
      key: 'miles', header: 'Loaded Miles', width: 110, align: 'center',
      sortable: true,
      render: r => (
        <span className="tabular-nums">{r.miles.toLocaleString()}</span>
      ),
    },
    {
      key: 'inspections', header: 'Inspections', width: 110, align: 'center',
      sortable: true,
      render: r => (
        <div>
          <div className="tabular-nums font-semibold">{r.inspections}</div>
          {r.inspectionsWithDefects > 0 && (
            <div className="text-[10.5px] tabular-nums" style={{ color: '#b06000' }}>
              {r.inspectionsWithDefects} w/ defects
            </div>
          )}
        </div>
      ),
    },
    {
      // Inspection % = days an inspection was submitted ÷ days the
      // driver had a (non-cancelled) load scheduled, in the period.
      key: 'inspectionCompliancePct', header: 'Insp %', width: 90, align: 'center',
      sortable: true,
      sortValue: r => r.inspectionCompliancePct ?? -1,
      render: r => <PctCell value={r.inspectionCompliancePct} thresholds={{ ok: 90, warn: 70 }} />,
    },
    {
      // POD % = delivered loads where the POD was uploaded within
      // 24 hours of deliveryAt ÷ delivered loads in the period.
      // Cancelled + TONU loads excluded from the denominator.
      key: 'podOnTimePct', header: 'POD %', width: 90, align: 'center',
      sortable: true,
      sortValue: r => r.podOnTimePct ?? -1,
      render: r => <PctCell value={r.podOnTimePct} thresholds={{ ok: 90, warn: 70 }} suffix={r.podOnTimeOf > 0 ? `/${r.podOnTimeOf}` : undefined} />,
    },
    {
      // Stops % = stops the driver checked into (arrivedAt populated)
      // ÷ all stops on this driver's legs.
      key: 'stopCheckInPct', header: 'Stops %', width: 95, align: 'center',
      sortable: true,
      sortValue: r => r.stopCheckInPct ?? -1,
      render: r => <PctCell value={r.stopCheckInPct} thresholds={{ ok: 90, warn: 70 }} suffix={r.stopCheckInOf > 0 ? `/${r.stopCheckInOf}` : undefined} />,
    },
    {
      // Trailer % = legs where a trailerId was set ÷ all of this
      // driver's legs. Reports the driver-reported trailer rate.
      key: 'trailerReportedPct', header: 'Trailer %', width: 95, align: 'center',
      sortable: true,
      sortValue: r => r.trailerReportedPct ?? -1,
      render: r => <PctCell value={r.trailerReportedPct} thresholds={{ ok: 95, warn: 80 }} />,
    },
    {
      // Fuel = count of fuel reports the driver submitted in the period.
      key: 'fuelReports', header: 'Fuel', width: 70, align: 'center',
      sortable: true,
      render: r => <span className="tabular-nums">{r.fuelReports}</span>,
    },
    {
      // Maintenance = count of maintenance reports the driver
      // submitted in the period.
      key: 'maintenanceReports', header: 'Maint', width: 70, align: 'center',
      sortable: true,
      render: r => <span className="tabular-nums">{r.maintenanceReports}</span>,
    },
  ], []);

  const periodLabel = period === 'custom'
    ? `${customRange.start} → ${customRange.end}`
    : `${range.start} → ${range.end}`;

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--gc-surface)' }}>
      <ManagementHeader title="Drivers" icon={Gauge} />
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="mx-auto w-full px-6 py-5 flex flex-col gap-4 flex-1 min-h-0" style={{ maxWidth: 1600 }}>
          {/* Period strip */}
          <div className="flex items-center gap-3 flex-wrap">
            <PeriodSelector
              period={period}
              onPeriodChange={setPeriod}
              customStart={customRange.start}
              customEnd={customRange.end}
              onCustomStartChange={s => setCustomRange(r => ({ ...r, start: s }))}
              onCustomEndChange={e => setCustomRange(r => ({ ...r, end: e }))}
              showRangeLabel={false}
            />
            <div className="flex-1" />
            <div className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {periodLabel} · {rows.length} {rows.length === 1 ? 'driver' : 'drivers'} active
            </div>
          </div>

          {/* Body */}
          {error ? (
            <div className="rounded-xl p-4 text-[13px]"
              style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={20} className="animate-spin mr-2" />
              <span className="text-[13px]">Loading driver data…</span>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex">
              <OpsTable<DriverScorecardRow>
                data={rows}
                columns={columns}
                rowKey={r => String(r.driverId)}
                loading={loading}
                onRowClick={r => setOpenDriverId(r.driverId)}
                activeRowId={openDriverId != null ? String(openDriverId) : null}
                emptyLabel="No driver activity in this period."
                pageSize={50}
                fillHeight
                columnPicker
                columnReorder
                persistKey="drivers-scorecard"
                countLabel="driver"
              />
            </div>
          )}
        </div>
      </div>

      {openDriverId != null && (
        <DriverDetailPanel
          row={rows.find(r => r.driverId === openDriverId)}
          loads={loads.filter(l => l.legs.some(g => g.driverId === openDriverId))}
          inspections={inspections.filter(r => r.driverId === openDriverId)}
          period={periodLabel}
          onClose={() => setOpenDriverId(null)}
        />
      )}
    </div>
  );
}

// ── Cell helper ──────────────────────────────────────────────────────

/** Percent cell with a color step based on threshold tiers. null
 *  → em-dash (the driver had no eligible activity for the metric). */
function PctCell({
  value, thresholds, suffix,
}: {
  value: number | null;
  thresholds: { ok: number; warn: number };
  suffix?: string;
}) {
  if (value == null) {
    return <span style={{ color: 'var(--gc-text-3)' }}>—</span>;
  }
  const color =
    value >= thresholds.ok   ? '#137333' :     // green
    value >= thresholds.warn ? '#b06000' :     // amber
                               '#c5221f';      // red
  return (
    <span className="font-semibold tabular-nums" style={{ color }}>
      {value}%{suffix && <span className="font-normal" style={{ color: 'var(--gc-text-3)' }}> {suffix}</span>}
    </span>
  );
}
