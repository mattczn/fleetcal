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
import AppShell from '@/components/nav/AppShell';
import { PeriodSelector } from '@/components/ui/PeriodSelector';
import { OpsTable, type OpsColumn } from '@/components/ui/OpsTable';
import { type Period, getPeriodRange, defaultCustomRangeISO } from '@/lib/periodRange';
import DriverDetailPanel from './DriverDetailPanel';
import InspectionScorecardSection from './InspectionScorecardSection';
import type { Driver } from '@/lib/types';
import type {
  LoadSummary, FuelReport, MaintenanceReport,
  DriverSafetyScoreRow, DriverSafetyFleetSummary,
} from '@fleetcal/types';

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
  // Safety (30d rolling — INDEPENDENT of the page period, so this
  // number stays stable when a dispatcher widens/narrows the period
  // selector). Populated from /v1/driver-safety-scoring; null when
  // the driver doesn't appear in that endpoint's response.
  safetyScore:      number | null;
  safetyEvents:     number;             // raw total across ALL severity levels
  safetyModerateEvents: number;
  safetySevereEvents: number;
  /** moderate + severe — what the score actually reflects (low is
   *  weight 0). Shown in the Events column so the number matches what
   *  affects the score. */
  safetyCountedEvents: number;
  safetyMiles30d:   number;
  safetyPrevScore:  number | null;
  safetyFlagged:    boolean;
}

// Default period: "This week" (Saturday → Friday, matches the rest
// of the app). Dispatchers look at the scorecard most often as a
// "how's the team doing right now" snapshot, so the current week
// is the natural starting view — they can widen to 30d / month
// from the period selector when they need to see further back.
const DEFAULT_PERIOD: Period = 'week';

// ── Module-level cache ──────────────────────────────────────────────
//
// The page fetches 6 endpoints on every mount. Without a cache the
// dispatcher sees a full spinner each time they open /drivers, even if
// they just closed a driver detail modal 5 seconds ago. Cache below
// keeps the last result per period-range so re-opens use stale data
// immediately while a background refetch runs. Fresh data replaces
// stale as soon as it arrives — no spinner blink.
//
// TTL: 60s for period data, 5min for the 30-day safety score. The
// safety window is fixed 30d so it doesn't shift when the period
// selector moves — cache it independently to survive period toggles.
interface CachedPeriodData {
  drivers: Driver[];
  loads: LoadSummary[];
  inspections: Array<{ id: string; driverId: number; submittedAt: string; hasDefects: boolean; inspectionDate: string }>;
  fuels: FuelReport[];
  maintenance: MaintenanceReport[];
  cachedAt: number;
}
interface CachedSafety {
  byDriver: Map<number, DriverSafetyScoreRow>;
  fleet: DriverSafetyFleetSummary | null;
  cachedAt: number;
}
const PERIOD_TTL_MS = 60 * 1000;
const SAFETY_TTL_MS = 5 * 60 * 1000;
const periodCache = new Map<string, CachedPeriodData>();
let safetyCache: CachedSafety | null = null;

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
  // Seed from cache so the first render already has data when the
  // dispatcher opens/re-opens the page within the TTL window.
  const cacheKey = `${range.start}|${range.end}`;
  const seededPeriod = periodCache.get(cacheKey);
  const [drivers, setDrivers] = useState<Driver[]>(seededPeriod?.drivers ?? []);
  const [loads, setLoads] = useState<LoadSummary[]>(seededPeriod?.loads ?? []);
  const [inspections, setInspections] = useState<Array<{ id: string; driverId: number; submittedAt: string; hasDefects: boolean; inspectionDate: string }>>(seededPeriod?.inspections ?? []);
  const [fuels, setFuels] = useState<FuelReport[]>(seededPeriod?.fuels ?? []);
  const [maintenance, setMaintenance] = useState<MaintenanceReport[]>(seededPeriod?.maintenance ?? []);
  const [safetyByDriver, setSafetyByDriver] = useState<Map<number, DriverSafetyScoreRow>>(safetyCache?.byDriver ?? new Map());
  const [safetyFleet, setSafetyFleet] = useState<DriverSafetyFleetSummary | null>(safetyCache?.fleet ?? null);
  // Only show the full-screen loading state when we truly have NO data
  // to render — with cache-seeded state, this is false on the second
  // open within TTL and the user sees stale rows while the refetch runs.
  const [loading, setLoading] = useState(!seededPeriod);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cachedPeriod = periodCache.get(cacheKey);
    const periodStale = !cachedPeriod || (Date.now() - cachedPeriod.cachedAt) > PERIOD_TTL_MS;
    const safetyStale = !safetyCache || (Date.now() - safetyCache.cachedAt) > SAFETY_TTL_MS;

    // Nothing to refetch — cache is fresh on both axes.
    if (!periodStale && !safetyStale) {
      setLoading(false);
      return;
    }

    // Only flash the spinner when we have absolutely no data. Otherwise
    // the fetch runs silently under the current rows.
    if (drivers.length === 0) setLoading(true);
    setError(null);

    Promise.all([
      // Period-scoped queries — skipped when the cache is fresh so we
      // never re-hit the API when just changing tabs.
      periodStale ? railway.listDrivers() : Promise.resolve({ drivers: cachedPeriod!.drivers }),
      periodStale ? railway.listLoadSummaries({
        pickupFrom: range.start,
        pickupTo:   range.end,
        limit:      '5000',
      }) : Promise.resolve({ loads: cachedPeriod!.loads }),
      periodStale ? railway.listInspectionReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }) : Promise.resolve({ inspections: cachedPeriod!.inspections.map(r => ({ ...r })) }),
      periodStale ? railway.listFuelReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }) : Promise.resolve({ fuelReports: cachedPeriod!.fuels }),
      periodStale ? railway.listMaintenanceReports({
        from:  range.start,
        to:    range.end,
        limit: 2000,
      }) : Promise.resolve({ reports: cachedPeriod!.maintenance }),
      // Safety scoring — always 30-day rolling per product spec. Fetched
      // alongside the period-scoped queries but doesn't move when the
      // period selector changes. Failures don't fail the whole page;
      // the safety columns just render blanks.
      safetyStale
        ? railway.getDriverSafetyScoring(30).catch(err => {
            console.warn('[drivers] safety scoring failed:', err);
            return null;
          })
        : Promise.resolve({ drivers: Array.from(safetyCache!.byDriver.values()), fleet: safetyCache!.fleet }),
    ])
      .then(([driverRes, loadRes, inspRes, fuelRes, maintRes, safetyRes]) => {
        if (cancelled) return;
        const nextInspections = inspRes.inspections.map(r => ({
          id:             r.id,
          driverId:       r.driverId,
          submittedAt:    r.submittedAt,
          hasDefects:     r.hasDefects,
          inspectionDate: r.inspectionDate,
        }));
        setDrivers(driverRes.drivers);
        setLoads(loadRes.loads);
        setInspections(nextInspections);
        setFuels(fuelRes.fuelReports);
        setMaintenance(maintRes.reports);
        if (safetyRes) {
          const byDriver = new Map(safetyRes.drivers.map(r => [r.driverId, r]));
          setSafetyByDriver(byDriver);
          setSafetyFleet(safetyRes.fleet);
          if (safetyStale) {
            safetyCache = { byDriver, fleet: safetyRes.fleet, cachedAt: Date.now() };
          }
        } else if (safetyStale) {
          // Preserve prior cache on a network failure — better a
          // slightly stale score than a blank one.
          setSafetyByDriver(safetyCache?.byDriver ?? new Map());
          setSafetyFleet(safetyCache?.fleet ?? null);
        }
        // Write cache only when we actually refetched — reusing cached
        // data doesn't count as a refresh.
        if (periodStale) {
          periodCache.set(cacheKey, {
            drivers:     driverRes.drivers,
            loads:       loadRes.loads,
            inspections: nextInspections,
            fuels:       fuelRes.fuelReports,
            maintenance: maintRes.reports,
            cachedAt:    Date.now(),
          });
        }
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

      const safety = safetyByDriver.get(driverId);
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
        // Safety — 30d rolling from /v1/driver-safety-scoring. Score
        // stays visible even for drivers with no activity in the
        // page's period so a dispatcher can spot bad drivers who
        // "didn't drive much recently".
        safetyScore:          safety?.safetyScore ?? null,
        safetyEvents:         safety?.totalEvents ?? 0,
        safetyModerateEvents: safety?.moderateEvents ?? 0,
        safetySevereEvents:   safety?.severeEvents ?? 0,
        safetyCountedEvents:  (safety?.moderateEvents ?? 0) + (safety?.severeEvents ?? 0),
        safetyMiles30d:       safety?.milesDriven ?? 0,
        safetyPrevScore:      safety?.prevSafetyScore ?? null,
        safetyFlagged:        safety?.flagged ?? false,
      });
    }

    // Default sort: most-loads first. The table is also sortable so
    // dispatchers can re-rank by inspection compliance or POD on time.
    out.sort((a, b) => b.loads - a.loads);
    return out;
  }, [drivers, loads, inspections, fuels, maintenance, safetyByDriver]);

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
      headerTooltip:
        'Count of legs assigned to this driver whose pickup falls inside the period. Relay loads count each leg separately.',
      render: r => (
        <span className="font-semibold tabular-nums">{r.loads}</span>
      ),
    },
    {
      key: 'miles', header: 'Loaded Miles', width: 110, align: 'center',
      sortable: true,
      headerTooltip:
        'Sum of loadedMiles for this driver\'s legs only. Excludes deadhead. On relays, each driver gets only their leg.',
      render: r => (
        <span className="tabular-nums">{r.miles.toLocaleString()}</span>
      ),
    },
    {
      key: 'inspections', header: 'Inspections', width: 110, align: 'center',
      sortable: true,
      headerTooltip:
        'Count of DVIRs submitted in the period. Sub-line counts how many of those flagged defects.',
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
      key: 'inspectionCompliancePct', header: 'Insp %', width: 90, align: 'center',
      sortable: true,
      sortValue: r => r.inspectionCompliancePct ?? -1,
      headerTooltip:
        'Days the driver submitted an inspection ÷ days they had a non-cancelled load scheduled (pickup-day through delivery-day inclusive).',
      render: r => <PctCell value={r.inspectionCompliancePct} thresholds={{ ok: 90, warn: 70 }} />,
    },
    {
      key: 'podOnTimePct', header: 'POD %', width: 90, align: 'center',
      sortable: true,
      sortValue: r => r.podOnTimePct ?? -1,
      headerTooltip:
        'Delivered loads where a POD doc was uploaded within 24h of deliveryAt ÷ delivered loads in the period. Cancelled + TONU loads excluded.',
      render: r => <PctCell value={r.podOnTimePct} thresholds={{ ok: 90, warn: 70 }} suffix={r.podOnTimeOf > 0 ? `/${r.podOnTimeOf}` : undefined} />,
    },
    {
      key: 'stopCheckInPct', header: 'Stops %', width: 95, align: 'center',
      sortable: true,
      sortValue: r => r.stopCheckInPct ?? -1,
      headerTooltip:
        'Stops on this driver\'s legs where arrivedAt was populated (driver checked in) ÷ all of their stops.',
      render: r => <PctCell value={r.stopCheckInPct} thresholds={{ ok: 90, warn: 70 }} suffix={r.stopCheckInOf > 0 ? `/${r.stopCheckInOf}` : undefined} />,
    },
    {
      key: 'trailerReportedPct', header: 'Trailer %', width: 95, align: 'center',
      sortable: true,
      sortValue: r => r.trailerReportedPct ?? -1,
      headerTooltip:
        'Driver\'s legs where a trailerId was set ÷ all of their legs in the period. How often the driver self-reported their trailer.',
      render: r => <PctCell value={r.trailerReportedPct} thresholds={{ ok: 95, warn: 80 }} />,
    },
    {
      key: 'fuelReports', header: 'Fuel', width: 70, align: 'center',
      sortable: true,
      headerTooltip:
        'Count of fuel reports submitted by this driver in the period.',
      render: r => <span className="tabular-nums">{r.fuelReports}</span>,
    },
    {
      key: 'maintenanceReports', header: 'Maint', width: 70, align: 'center',
      sortable: true,
      headerTooltip:
        'Count of maintenance reports submitted by this driver in the period.',
      render: r => <span className="tabular-nums">{r.maintenanceReports}</span>,
    },
    {
      key: 'safetyScore', header: 'Safety', width: 90, align: 'center',
      sortable: true,
      // Nulls (no miles) sort BELOW zero so the "not driving" bucket
      // doesn't rank alongside dangerous drivers.
      sortValue: r => r.safetyScore ?? -1,
      headerTooltip:
        'Safety score over the trailing 30 days — INDEPENDENT of the period selector above. Miles-normalized penalty from Motive safety events, weighted so severe events dominate the score. Fleet median lands at 80.',
      render: r => <SafetyScoreCell row={r} />,
    },
    {
      key: 'safetyCountedEvents', header: 'Events', width: 80, align: 'center',
      sortable: true,
      sortValue: r => r.safetyCountedEvents,
      headerTooltip:
        'Moderate + severe Motive safety events attributed to this driver in the trailing 30 days. Low-severity events are ignored — they don\'t affect the score, so they don\'t clutter the count.',
      render: r => (
        <div>
          <div className="tabular-nums font-semibold">{r.safetyCountedEvents}</div>
          {r.safetySevereEvents > 0 && (
            <div className="text-[10.5px] tabular-nums" style={{ color: '#dc2626' }}>
              {r.safetySevereEvents} severe
            </div>
          )}
        </div>
      ),
    },
  ], []);

  const periodLabel = period === 'custom'
    ? `${customRange.start} → ${customRange.end}`
    : `${range.start} → ${range.end}`;

  return (
    <AppShell title="Drivers" icon={Gauge}>
      <div className="flex-1 min-h-0 flex flex-col" style={{ background: 'var(--gc-surface)' }}>
        <div className="w-full px-6 py-5 flex flex-col gap-4 flex-1 min-h-0">
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

          {/* Dual-score chart — inspection + safety per active driver
              in the period. First thing dispatchers see so problem
              drivers surface immediately. */}
          {!loading && rows.length > 0 && (
            <DriverScoresChart
              rows={rows}
              fleet={safetyFleet}
              onRowClick={setOpenDriverId}
            />
          )}

          {/* Inspection scorecard — the compact per-driver bonus view
              that used to live in Equipment. Monthly picker + own
              cache (5min TTL) so it doesn't re-fetch on every open. */}
          {!loading && (
            <InspectionScorecardSection />
          )}

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
    </AppShell>
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

/** Safety-score cell — same threshold philosophy as PctCell but with
 *  a trend arrow next to the number and a flag icon before it when
 *  the row was auto-flagged. Null → em-dash + subtle "no miles" hint. */
export function SafetyScoreCell({ row }: {
  row: {
    safetyScore: number | null;
    safetyPrevScore: number | null;
    safetyFlagged: boolean;
    safetyMiles30d: number;
  };
}) {
  if (row.safetyScore == null) {
    return (
      <span style={{ color: 'var(--gc-text-3)' }}>
        —
        <span className="text-[10px] block" style={{ marginTop: -2 }}>no miles</span>
      </span>
    );
  }
  const color =
    row.safetyScore >= 85 ? '#137333' :
    row.safetyScore >= 70 ? '#b06000' :
                            '#c5221f';
  const delta = row.safetyPrevScore != null ? row.safetyScore - row.safetyPrevScore : 0;
  const trendArrow = delta > 2 ? '↑' : delta < -2 ? '↓' : '';
  const trendColor = delta > 2 ? '#137333' : delta < -2 ? '#c5221f' : 'var(--gc-text-3)';
  return (
    <span className="font-semibold tabular-nums inline-flex items-center gap-1" style={{ color }}>
      {row.safetyFlagged && <span title="Auto-flagged for review" style={{ color: '#c5221f' }}>⚠</span>}
      {row.safetyScore}
      {trendArrow && <span style={{ color: trendColor, fontSize: 11 }}>{trendArrow}</span>}
    </span>
  );
}

// ── Dual bar chart — inspection + safety per driver ─────────────────

const INSPECTION_COLOR = '#137333'; // green
const SAFETY_COLOR     = '#7c3aed'; // purple

/** Two horizontal bars per driver — inspection compliance % and safety
 *  score. Both 0–100 axis. Fleet median tick rendered on the safety bar
 *  so a dispatcher can see who's below the middle at a glance. Only
 *  active-in-period drivers are shown (loads OR inspections in the
 *  window). Sorted by min(insp, safety) ascending — the worst-of-two
 *  surfaces at the top so problem drivers can't hide behind a strong
 *  score on the other dimension.  Truncated at 25 rows so a big fleet
 *  doesn't blow out the header — full ranking is in the table below. */
export function DriverScoresChart({
  rows, fleet, onRowClick,
}: {
  rows: DriverScorecardRow[];
  fleet: DriverSafetyFleetSummary | null;
  onRowClick: (driverId: number) => void;
}) {
  const active = rows
    .filter(r => r.loads > 0 || r.inspections > 0)
    .filter(r => r.safetyScore != null || r.inspectionCompliancePct != null)
    // worst-of-two ascending; nulls sink
    .sort((a, b) => {
      const aMin = Math.min(a.safetyScore ?? 100, a.inspectionCompliancePct ?? 100);
      const bMin = Math.min(b.safetyScore ?? 100, b.inspectionCompliancePct ?? 100);
      return aMin - bMin;
    });
  if (active.length === 0) return null;
  const shown = active.slice(0, 25);
  const median = fleet?.fleetMedian;

  return (
    <div
      style={{
        border: '1px solid var(--gc-border-light)',
        borderRadius: 10,
        background: 'var(--gc-surface)',
        padding: '14px 16px',
        marginBottom: 14,
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <div>
          <div className="font-semibold" style={{ fontSize: 14, color: 'var(--gc-text-1)' }}>
            Driver scores
          </div>
          <div style={{ fontSize: 12, color: 'var(--gc-text-3)', marginTop: 2 }}>
            <span style={{ color: INSPECTION_COLOR, fontWeight: 600 }}>Inspection</span>{' '}
            based on the selected period · {' '}
            <span style={{ color: SAFETY_COLOR, fontWeight: 600 }}>Safety</span>{' '}
            trailing 30 days, median-anchored at 80.
          </div>
          {fleet && (
            <div style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 2 }}>
              {fleet.driverCount} drivers · {fleet.fleetEvents} events ·{' '}
              {Math.round(fleet.fleetMiles).toLocaleString()} mi
              {median != null && ` · fleet median ${median}`}
              {fleet.medianIsFallback && (
                <span title="Fewer than 3 drivers with ≥500mi this window — using a hardcoded reference median. Score is less precise until more drivers accrue miles.">
                  {' '}(calibrating…)
                </span>
              )}
            </div>
          )}
        </div>
        {rows.some(r => r.safetyFlagged) && (
          <div style={{ fontSize: 12, color: '#c5221f', display: 'flex', alignItems: 'center', gap: 4 }}>
            ⚠ {rows.filter(r => r.safetyFlagged).length} flagged
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map(r => (
          <button
            key={r.driverId}
            type="button"
            onClick={() => onRowClick(r.driverId)}
            style={{
              display: 'grid',
              gridTemplateColumns: '160px 1fr 60px',
              alignItems: 'center',
              gap: 10,
              padding: '4px 6px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              borderRadius: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-bg)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--gc-text-1)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {r.safetyFlagged && <span style={{ color: '#c5221f', marginRight: 4 }}>⚠</span>}
              {r.driverName}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <ScoreBar
                label="Insp"
                value={r.inspectionCompliancePct}
                color={INSPECTION_COLOR}
              />
              <ScoreBar
                label="Safety"
                value={r.safetyScore}
                color={SAFETY_COLOR}
                median={median}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'right' }}>
              <span
                className="tabular-nums font-semibold"
                style={{ fontSize: 12, color: INSPECTION_COLOR }}
              >
                {r.inspectionCompliancePct ?? '—'}
              </span>
              <span
                className="tabular-nums font-semibold"
                style={{ fontSize: 12, color: SAFETY_COLOR }}
              >
                {r.safetyScore ?? '—'}
              </span>
            </div>
          </button>
        ))}
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--gc-text-3)', marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {median != null && (
          <span>Vertical mark on the safety bar = fleet median ({median}).</span>
        )}
        <span>
          Worst-of-two sorted first; showing {shown.length}
          {active.length > shown.length && ` of ${active.length}`} active driver{active.length === 1 ? '' : 's'} in the period.
        </span>
      </div>
    </div>
  );
}

function ScoreBar({
  label, value, color, median,
}: {
  label: string;
  value: number | null;
  color: string;
  /** Optional fleet-median tick, rendered as a subtle vertical line. */
  median?: number | null;
}) {
  const width = value ?? 0;
  const isMissing = value == null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontSize: 9.5,
          color: 'var(--gc-text-3)',
          minWidth: 30,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {label}
      </span>
      <div
        style={{
          position: 'relative',
          height: 10, borderRadius: 3,
          background: 'var(--gc-bg)',
          border: '1px solid var(--gc-border-light)',
          overflow: 'hidden',
          flex: 1,
        }}
      >
        {!isMissing && (
          <div
            style={{
              position: 'absolute', inset: 0,
              width: `${width}%`,
              background: color,
              transition: 'width 200ms',
            }}
          />
        )}
        {median != null && (
          <div
            aria-hidden
            title={`Fleet median ${median}`}
            style={{
              position: 'absolute',
              top: -2, bottom: -2,
              left: `${median}%`,
              width: 2,
              background: 'var(--gc-text-2)',
              opacity: 0.55,
            }}
          />
        )}
      </div>
    </div>
  );
}
