/**
 * /fuel — driver-reported fuel transactions.
 *
 * Phase 1 view: just a table of every driver-submitted fuel-up, with
 * the small summary tiles at the top (count + total diesel + total
 * DEF). When Phase 2 lands, the `transaction_id` / `match_status`
 * columns get matched against the fuel_transactions table and we
 * extend this page with reconciliation tools.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Fuel, Loader2, X, Search, MapPin as MapPinIcon } from 'lucide-react';
import DataLoader from '@/components/DataLoader';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import {
  Th, Td, PaginationFooter, DriverFilterDropdown, AssetFilterDropdown,
} from '@/components/queue/QueueTablePrimitives';
import type { FuelReport } from '@fleetcal/types';

const PAGE_SIZE = 50;

// ── Period filter ───────────────────────────────────────────────────────

const PERIODS: { value: string; label: string; days?: number }[] = [
  { value: '7',   label: 'Last 7 days',   days: 7   },
  { value: '14',  label: 'Last 14 days',  days: 14  },
  { value: '30',  label: 'Last 30 days',  days: 30  },
  { value: '60',  label: 'Last 60 days',  days: 60  },
  { value: '90',  label: 'Last 90 days',  days: 90  },
  { value: '365', label: 'Last year',     days: 365 },
  { value: 'all', label: 'All time'                 },
];

function periodFromIso(period: string): string | undefined {
  const p = PERIODS.find(x => x.value === period);
  if (!p?.days) return undefined;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - p.days);
  return d.toISOString();
}

// ── Formatters ──────────────────────────────────────────────────────────

const intFmt    = new Intl.NumberFormat('en-US');
const gallonFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Page ────────────────────────────────────────────────────────────────

import RequireCap from '@/components/auth/RequireCap';

export default function FuelPage() {
  return (
    <RequireCap cap="fuel.access" module="fuel">
      <FuelPageInner />
    </RequireCap>
  );
}

function FuelPageInner() {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const drivers = useCalendarStore(s => s.drivers);
  const assets  = useCalendarStore(s => s.assets);

  // Pre-seed the asset filter from ?asset=<name> in the URL so the
  // asset profile panel can deep-link to a filtered view.
  const initialAssetFilter = (() => {
    const a = searchParams?.get('asset');
    return a ? [a] : [];
  })();
  const [period,        setPeriod]         = useState<string>('30');
  const [search,        setSearch]         = useState<string>('');
  const [driverFilter,  setDriverFilter]   = useState<string[]>([]);  // driver names
  const [assetFilter,   setAssetFilter]    = useState<string[]>(initialAssetFilter);
  const [page,          setPage]           = useState(0);

  const [reports,       setReports]        = useState<FuelReport[]>([]);
  const [total,         setTotal]          = useState(0);
  const [loading,       setLoading]        = useState(false);
  const [error,         setError]          = useState<string | null>(null);

  // Reset page when filters change so the user doesn't end up on an
  // out-of-bounds page after narrowing the result set.
  useEffect(() => { setPage(0); }, [period, search, driverFilter, assetFilter]);

  // Fetch the current page.
  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const from = periodFromIso(period);
    void (async () => {
      try {
        const res = await railway.listFuelReports({
          from,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (cancelled) return;
        setReports(res.fuelReports);
        setTotal(res.total);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message ?? 'Failed to load fuel reports');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoaded, isSignedIn, period, page]);

  // Apply client-side filters (search + driver + asset) on top of the
  // server's date-range filter. Server pagination still works because
  // the search input only narrows what's already on the page.
  const driverById = useMemo(() => new Map(drivers.map(d => [d.id, d.name])), [drivers]);
  const assetById  = useMemo(() => new Map(assets .map(a => [a.id, { name: a.name, unit: a.unit }])), [assets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const driverSet = new Set(driverFilter);
    const assetSet  = new Set(assetFilter);
    return reports.filter(r => {
      const driverName = driverById.get(r.driverId) ?? '';
      const asset      = assetById.get(r.assetId);
      const assetLabel = asset ? formatAssetLabel(asset.name, asset.unit) : '';
      if (driverSet.size > 0 && !driverSet.has(driverName)) return false;
      if (assetSet.size  > 0 && !assetSet.has(assetLabel))  return false;
      if (!q) return true;
      const hay = [
        driverName,
        assetLabel,
        r.state,
        String(r.dieselGallons),
        r.odometer != null ? String(r.odometer) : '',
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [reports, search, driverFilter, assetFilter, driverById, assetById]);

  const stats = useMemo(() => {
    let dieselTotal = 0;
    let defTotal    = 0;
    for (const r of filtered) {
      dieselTotal += Number(r.dieselGallons) || 0;
      defTotal    += Number(r.defGallons ?? 0) || 0;
    }
    return { count: filtered.length, diesel: dieselTotal, def: defTotal };
  }, [filtered]);

  const driverOptions = useMemo(
    () => Array.from(new Set(drivers.map(d => d.name))).sort(),
    [drivers],
  );
  const assetOptions = useMemo(
    () => Array.from(new Set(assets.filter(a => !a.hidden).map(a => formatAssetLabel(a.name, a.unit)))).sort(),
    [assets],
  );

  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <DataLoader />
      <ManagementHeader title="Fuel" icon={Fuel} />

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-6">
        <div className="mx-auto space-y-4" style={{ width: '95vw' }}>

          {/* Purpose hint */}
          <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
            Driver-submitted fuel purchases. Reconciliation against card-provider transactions ships in Phase 2.
          </div>

          {/* Summary tiles */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            <Tile label="Reports"      value={intFmt.format(stats.count)} subtitle={periodLabel(period)} />
            <Tile label="Diesel"       value={`${gallonFmt.format(stats.diesel)} gal`} subtitle="Total" />
            <Tile label="DEF"          value={`${gallonFmt.format(stats.def)} gal`}    subtitle="Total" />
            <Tile label="Avg / Report" value={stats.count > 0 ? `${gallonFmt.format(stats.diesel / stats.count)} gal` : '—'} subtitle="Diesel" />
            <Tile label="Drivers"      value={intFmt.format(new Set(filtered.map(r => r.driverId)).size)} subtitle="Submitting" />
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: search ? 'var(--gc-blue)' : 'var(--gc-text-3)' }} />
              <input type="text"
                placeholder="Search driver, asset, state…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="text-[13px] pl-8 pr-7 py-1.5 rounded-lg outline-none"
                style={{
                  width: 320,
                  background: 'var(--gc-surface)',
                  border: `1px solid ${search ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                  color: 'var(--gc-text-1)',
                }} />
              {search && (
                <button onClick={() => setSearch('')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--gc-hover)]">
                  <X size={12} />
                </button>
              )}
            </div>

            <div className="flex-1" />

            <DriverFilterDropdown
              options={driverOptions}
              selected={driverFilter}
              onChange={setDriverFilter}
            />
            <AssetFilterDropdown
              options={assetOptions}
              selected={assetFilter}
              onChange={setAssetFilter}
            />
            <select
              value={period}
              onChange={e => setPeriod(e.target.value)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg outline-none"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}>
              {PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState period={period} />
          ) : (
            <div className="rounded-2xl overflow-x-auto"
              style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
              <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: 'max-content' }} className="text-[12.5px]">
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <Th>Reported</Th>
                    <Th>Driver</Th>
                    <Th>Asset</Th>
                    <Th>State</Th>
                    <Th>Location</Th>
                    <Th align="right">Diesel</Th>
                    <Th align="right">DEF</Th>
                    <Th align="right">Odometer</Th>
                    <Th>Match</Th>
                    <Th>Receipt</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const driverName = driverById.get(r.driverId) ?? `Driver #${r.driverId}`;
                    const asset = assetById.get(r.assetId);
                    const assetLabel = asset ? formatAssetLabel(asset.name, asset.unit) : `Asset #${r.assetId}`;
                    return (
                      <tr key={r.id} className="hover:bg-[var(--gc-hover)]"
                        style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                        <Td><span style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.reportedAt)}</span></Td>
                        <Td>{driverName}</Td>
                        <Td>{assetLabel}</Td>
                        <Td>
                          <span style={{ background: '#e8f0fe', color: '#1a73e8', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                            {r.state}
                          </span>
                        </Td>
                        <Td>
                          {r.latitude != null && r.longitude != null ? (
                            <a
                              href={`https://www.google.com/maps?q=${r.latitude},${r.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[12px] hover:underline"
                              style={{ color: 'var(--gc-blue)' }}
                              title={`${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}`}>
                              <MapPinIcon size={12} /> Map
                            </a>
                          ) : (
                            <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                          )}
                        </Td>
                        <Td align="right" className="tabular-nums font-semibold">{gallonFmt.format(Number(r.dieselGallons))}</Td>
                        <Td align="right" className="tabular-nums">
                          {r.defGallons != null && r.defGallons > 0
                            ? gallonFmt.format(Number(r.defGallons))
                            : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                        </Td>
                        <Td align="right" className="tabular-nums">
                          {r.odometer != null ? intFmt.format(r.odometer) : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                        </Td>
                        <Td><MatchStatusChip status={r.matchStatus} /></Td>
                        <Td>
                          {r.photos && r.photos.length > 0 ? (
                            <div className="flex items-center gap-1.5">
                              {r.photos[0].signedUrl ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <a href={r.photos[0].signedUrl} target="_blank" rel="noopener noreferrer">
                                  <img src={r.photos[0].signedUrl} alt={r.photos[0].fileName}
                                    style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--gc-border-light)' }} />
                                </a>
                              ) : (
                                <span style={{ width: 32, height: 32, borderRadius: 6, background: '#f1f3f4' }} />
                              )}
                              {r.photos.length > 1 && (
                                <span className="text-[11px] font-semibold" style={{ color: 'var(--gc-text-2)' }}>
                                  +{r.photos.length - 1}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {total > PAGE_SIZE && (
                <PaginationFooter
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onPrev={() => setPage(Math.max(0, page - 1))}
                  onNext={() => setPage(page + 1)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

function Tile({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="px-4 py-3 rounded-xl" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)' }}>
      <div className="text-[10.5px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </div>
      <div className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
        {value}
      </div>
      {subtitle && (
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function MatchStatusChip({ status }: { status: FuelReport['matchStatus'] }) {
  const palette =
    status === 'matched'        ? { bg: '#dcfce7', fg: '#15803d', border: '#86efac', label: 'Matched' } :
    status === 'no_transaction' ? { bg: '#f3f4f6', fg: '#4b5563', border: '#d1d5db', label: 'No txn'  } :
                                  { bg: '#fef3c7', fg: '#92400e', border: '#fde68a', label: 'Pending' };
  return (
    <span className="inline-block px-2 py-0.5 rounded-lg text-[10.5px] font-bold"
      style={{ background: palette.bg, color: palette.fg, border: `1px solid ${palette.border}` }}>
      {palette.label}
    </span>
  );
}

function EmptyState({ period }: { period: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: 'var(--gc-text-3)' }}>
      <Fuel size={28} style={{ color: '#9aa0a6', marginBottom: 12 }} />
      <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>No fuel reports yet</div>
      <div className="text-sm">{periodLabel(period)} · Drivers submit from the mobile app.</div>
    </div>
  );
}

function formatAssetLabel(name: string, unit?: string): string {
  if (unit) return `#${unit}${name ? ` · ${name}` : ''}`;
  return name;
}

function periodLabel(period: string): string {
  return PERIODS.find(p => p.value === period)?.label ?? '';
}
