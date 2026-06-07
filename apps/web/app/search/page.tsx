'use client';

/**
 * /search — full results page for the global search bar.
 *
 * Same six buckets as the dropdown (Loads, Customers, Drivers,
 * Trucks, Trailers, Locations), no per-category cap. Category tab
 * strip at the top lets the user focus on one bucket at a time
 * ("All" is the default). The current query lives in `?q=…` so URL
 * bar + back/forward + sharing all just work.
 *
 * Click behavior matches the dropdown:
 *   - Load     → router.push(`/loads/${internalLoadId}`)
 *   - Customer/Driver/Truck/Trailer/Location → openDirectory via
 *     GlobalDirectoryContext (DirectoryModal mounts at AppShell).
 *
 * The page sources entities from useCalendarStore (already hydrated
 * by the app shell on mount) and loads from /v1/loads/search with
 * the server cap (50). For workloads that genuinely overflow that
 * cap, the search bar refinement is the right answer — anything
 * heavier (paged loads search across all history) would be a
 * separate feature.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Search as SearchIcon, FileText, Building2, Users, Truck, Container, MapPin, Loader2,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useGlobalDirectory } from '@/lib/useGlobalDirectory';
import { railway } from '@/lib/railway';
import type { Load } from '@/lib/types';

/** Server caps responses at 50; ask for that so a focused query can
 *  show the full set instead of a slice. */
const LOAD_LIMIT = 50;

type Category = 'all' | 'loads' | 'customers' | 'drivers' | 'trucks' | 'trailers' | 'locations';

const CATEGORY_META: Record<Exclude<Category, 'all'>, { label: string; icon: typeof FileText }> = {
  loads:     { label: 'Loads',     icon: FileText },
  customers: { label: 'Customers', icon: Building2 },
  drivers:   { label: 'Drivers',   icon: Users },
  trucks:    { label: 'Trucks',    icon: Truck },
  trailers:  { label: 'Trailers',  icon: Container },
  locations: { label: 'Locations', icon: MapPin },
};

export default function SearchPage() {
  return (
    <AppShell title="Search" icon={SearchIcon}>
      {/* Suspense required by Next 16: useSearchParams() suspends on
          the very first render until the URL is resolved. */}
      <Suspense fallback={<div className="flex-1" />}>
        <SearchBody />
      </Suspense>
    </AppShell>
  );
}

function SearchBody() {
  const router    = useRouter();
  const params    = useSearchParams();
  const directory = useGlobalDirectory();
  const q         = (params.get('q') ?? '').trim();
  const initialCategory = (params.get('cat') as Category) || 'all';
  const [category, setCategory] = useState<Category>(initialCategory);

  // Keep ?cat= in sync with the chosen tab so a refresh lands the
  // user on the same view. We mutate via replaceState rather than
  // router.replace to avoid Next.js doing a full data-revalidation
  // round trip on every tab click.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (category === 'all') url.searchParams.delete('cat');
    else                    url.searchParams.set('cat', category);
    window.history.replaceState(window.history.state, '', url.toString());
  }, [category]);

  // ── Store-backed in-memory categories ─────────────────────────────
  const { customers, drivers, assets, trailers, savedLocations, unassignedAssetId } = useCalendarStore();

  // ── Server-side load search ───────────────────────────────────────
  const [loads,        setLoads]        = useState<Load[]>([]);
  const [loadsLoading, setLoadsLoading] = useState(false);
  useEffect(() => {
    if (q.length < 2) {
      setLoads([]);
      setLoadsLoading(false);
      return;
    }
    let cancelled = false;
    setLoadsLoading(true);
    railway.searchLoads(q, LOAD_LIMIT)
      .then(res => {
        if (cancelled) return;
        // Dedupe relays by loadId, prefer pickup leg.
        const byKey = new Map<string, Load>();
        for (const l of res.loads ?? []) {
          const key = l.loadId ?? l.id;
          const existing = byKey.get(key);
          if (!existing || new Date(l.start).getTime() < new Date(existing.start).getTime()) {
            byKey.set(key, l);
          }
        }
        const now = Date.now();
        const sorted = [...byKey.values()].sort((a, b) => {
          const da = Math.abs(new Date(a.start).getTime() - now);
          const db = Math.abs(new Date(b.start).getTime() - now);
          return da - db;
        });
        setLoads(sorted);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[SearchPage] searchLoads failed:', err);
        setLoads([]);
      })
      .finally(() => { if (!cancelled) setLoadsLoading(false); });
    return () => { cancelled = true; };
  }, [q]);

  // ── In-memory matchers (unbounded — full match set) ───────────────
  const ql = q.toLowerCase();
  function rank<T>(items: T[], haystacks: (t: T) => string[]): T[] {
    if (!ql) return [];
    type Scored = { item: T; score: number; primary: string };
    const scored: Scored[] = [];
    for (const item of items) {
      const fields = haystacks(item).map(s => s.toLowerCase()).filter(Boolean);
      if (fields.length === 0) continue;
      let best = -1;
      for (const f of fields) {
        if (f === ql)              { best = Math.max(best, 4); continue; }
        if (f.startsWith(ql))      { best = Math.max(best, 3); continue; }
        if (f.includes(' ' + ql))  { best = Math.max(best, 2); continue; }
        if (f.includes(ql))        { best = Math.max(best, 1); continue; }
      }
      if (best > 0) scored.push({ item, score: best, primary: fields[0] });
    }
    scored.sort((a, b) => b.score - a.score || a.primary.localeCompare(b.primary));
    return scored.map(s => s.item);
  }

  const matchedCustomers = useMemo(() => rank(customers, (c) => [
    c.name, ...(c.aliases ?? []), c.shortName ?? '', c.mcNum ?? '',
  ]), [customers, ql]);
  const matchedDrivers = useMemo(() => rank(drivers, (d) => [
    d.name, d.firstName ?? '', d.lastName ?? '', d.phone ?? '', d.email ?? '', d.licenseNumber ?? '', d.notes ?? '',
  ]), [drivers, ql]);
  const matchedTrucks = useMemo(() => rank(
    assets.filter(a => a.id !== unassignedAssetId),
    (a) => [
      a.name, a.unit ?? '', a.truck ?? '', a.make ?? '', a.model ?? '',
      a.vin ?? '', a.licensePlate ?? '', a.notes ?? '',
    ],
  ), [assets, unassignedAssetId, ql]);
  const matchedTrailers = useMemo(() => rank(trailers, (t) => [
    t.name, t.trailerNumber ?? '', t.make ?? '', t.model ?? '',
    t.vin ?? '', t.licensePlate ?? '', t.category ?? '', t.notes ?? '',
  ]), [trailers, ql]);
  const matchedLocations = useMemo(() => rank(savedLocations, (l) => [
    l.name, l.address ?? '',
  ]), [savedLocations, ql]);

  const counts: Record<Exclude<Category, 'all'>, number> = {
    loads:     loads.length,
    customers: matchedCustomers.length,
    drivers:   matchedDrivers.length,
    trucks:    matchedTrucks.length,
    trailers:  matchedTrailers.length,
    locations: matchedLocations.length,
  };
  const totalHits = Object.values(counts).reduce((a, b) => a + b, 0);

  // ── Click handlers ────────────────────────────────────────────────
  const goLoad     = (l: Load) => l.internalLoadId != null && router.push(`/loads/${l.internalLoadId}`);
  const goCustomer = (id: string) => directory?.openDirectory({ tab: 'customers', initialBrokerId: id });
  const goDriver   = (id: number) => directory?.openDirectory({ tab: 'drivers',   initialDriverId: id });
  const goTruck    = (id: number) => directory?.openDirectory({ tab: 'trucks',    initialAssetId: id });
  const goTrailer  = (id: number) => directory?.openDirectory({ tab: 'trailers',  initialTrailerId: id });
  const goLocation = (id: string) => directory?.openDirectory({ tab: 'locations', initialLocationId: id });

  // ── Empty state for no query ──────────────────────────────────────
  if (q.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-20"
        style={{ color: 'var(--gc-text-3)' }}>
        <SearchIcon size={32} style={{ marginBottom: 12 }} />
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-2)' }}>
          Start typing in the search bar above
        </div>
        <div className="text-sm">Loads, customers, drivers, trucks, trailers, locations — all in one place.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Category strip — All + 6 entity tabs. Counts mirror what's
          actually in the list below, so when the dropdown's "top 5"
          is hiding a long tail this surface makes that count visible. */}
      <div className="shrink-0 px-6 pt-4 pb-3 flex items-center gap-1 flex-wrap"
        style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
        <CategoryTab
          label="All"
          count={totalHits}
          active={category === 'all'}
          onClick={() => setCategory('all')}
        />
        {(Object.keys(CATEGORY_META) as (keyof typeof CATEGORY_META)[]).map((c) => {
          const meta = CATEGORY_META[c];
          return (
            <CategoryTab
              key={c}
              label={meta.label}
              icon={meta.icon}
              count={counts[c]}
              active={category === c}
              onClick={() => setCategory(c)}
            />
          );
        })}
      </div>

      {/* Results body — scrollable. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4"
        style={{ background: 'var(--gc-bg)' }}>
        {totalHits === 0 && !loadsLoading && (
          <div className="text-center py-16 text-sm" style={{ color: 'var(--gc-text-3)' }}>
            No matches for <strong>“{q}”</strong>.
          </div>
        )}

        {(category === 'all' || category === 'loads') && (
          <Section title="Loads" icon={FileText} count={counts.loads} loading={loadsLoading && loads.length === 0}>
            {loads.map(load => (
              <Row key={load.loadId ?? load.id}
                primary={loadPrimary(load)}
                secondary={loadSecondary(load)}
                onClick={() => goLoad(load)} />
            ))}
          </Section>
        )}

        {(category === 'all' || category === 'customers') && (
          <Section title="Customers" icon={Building2} count={counts.customers}>
            {matchedCustomers.map(c => (
              <Row key={c.id}
                primary={c.name}
                secondary={c.mcNum ? `MC ${c.mcNum}` : (c.aliases?.[0] ?? '')}
                onClick={() => goCustomer(c.id)} />
            ))}
          </Section>
        )}

        {(category === 'all' || category === 'drivers') && (
          <Section title="Drivers" icon={Users} count={counts.drivers}>
            {matchedDrivers.map(d => (
              <Row key={d.id}
                primary={d.name}
                secondary={[d.phone, d.licenseNumber && `CDL ${d.licenseNumber}`].filter(Boolean).join(' · ')}
                onClick={() => goDriver(d.id)} />
            ))}
          </Section>
        )}

        {(category === 'all' || category === 'trucks') && (
          <Section title="Trucks" icon={Truck} count={counts.trucks}>
            {matchedTrucks.map(a => (
              <Row key={a.id}
                primary={a.name}
                secondary={[a.unit && `#${a.unit}`, [a.make, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
                onClick={() => goTruck(a.id)} />
            ))}
          </Section>
        )}

        {(category === 'all' || category === 'trailers') && (
          <Section title="Trailers" icon={Container} count={counts.trailers}>
            {matchedTrailers.map(t => (
              <Row key={t.id}
                primary={t.name}
                secondary={[t.trailerNumber && `#${t.trailerNumber}`, t.category].filter(Boolean).join(' · ')}
                onClick={() => goTrailer(t.id)} />
            ))}
          </Section>
        )}

        {(category === 'all' || category === 'locations') && (
          <Section title="Locations" icon={MapPin} count={counts.locations}>
            {matchedLocations.map(l => (
              <Row key={l.id}
                primary={l.name}
                secondary={l.address ?? ''}
                onClick={() => goLocation(l.id)} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function CategoryTab({ label, count, active, onClick, icon: Icon }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors"
      style={{
        background: active ? 'var(--gc-blue-light)' : 'transparent',
        color:      active ? 'var(--gc-blue)' : 'var(--gc-text-2)',
        border: 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      {Icon && <Icon size={13} />}
      {label}
      <span className="rounded-full px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums"
        style={{
          background: active ? 'var(--gc-blue)' : 'var(--gc-hover)',
          color:      active ? '#fff' : 'var(--gc-text-3)',
          minWidth: 22,
          textAlign: 'center',
        }}>
        {count}
      </span>
    </button>
  );
}

function Section({ title, icon: Icon, count, loading, children }: {
  title: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  count: number;
  loading?: boolean;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  if (!hasChildren && !loading) return null;
  return (
    <section className="mb-6">
      <div className="flex items-center gap-2 mb-2 px-1">
        <Icon size={14} style={{ color: 'var(--gc-text-3)' }} />
        <span className="text-[11px] font-bold uppercase tracking-widest"
          style={{ color: 'var(--gc-text-3)' }}>
          {title}
        </span>
        <span className="text-[11px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
          {count}
        </span>
        {loading && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
      </div>
      <div className="rounded-xl overflow-hidden"
        style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
        {children}
      </div>
    </section>
  );
}

function Row({ primary, secondary, onClick }: {
  primary: string;
  secondary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex flex-col"
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--gc-border-light)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
        {primary || '(unnamed)'}
      </span>
      {secondary && (
        <span className="text-[12px] truncate" style={{ color: 'var(--gc-text-3)' }}>
          {secondary}
        </span>
      )}
    </button>
  );
}

// ── Load formatters — duplicated from GlobalSearchDropdown for now;
//   if a third surface needs them we'll lift into a shared module. ─

function loadPrimary(load: Load): string {
  const parts: string[] = [];
  if (load.loadNum)                parts.push(`#${load.loadNum}`);
  if (load.internalLoadId != null) parts.push(String(load.internalLoadId));
  return parts.join(' · ') || '(no #)';
}

function loadSecondary(load: Load): string {
  const date = fmtPickupDate(load.start);
  const price = load.loadPrice != null
    ? `$${load.loadPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';
  return [date, load.broker, price].filter(Boolean).join(' · ');
}

function fmtPickupDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const thisYear = new Date().getFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  d.getFullYear() === thisYear ? undefined : 'numeric',
  });
}
