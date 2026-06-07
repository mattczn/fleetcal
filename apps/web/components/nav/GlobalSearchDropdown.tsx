'use client';

/**
 * GlobalSearchDropdown — categorized search results rendered under the
 * AppTopBar search input. Five buckets:
 *   - Loads      (server query, debounced)
 *   - Customers  (in-memory: useCalendarStore.customers)
 *   - Trucks     (in-memory: useCalendarStore.assets)
 *   - Trailers   (in-memory: useCalendarStore.trailers)
 *   - Locations  (in-memory: useCalendarStore.savedLocations)
 *
 * Click behavior:
 *   - Load     → router.push(`/loads/${internalLoadId}`)
 *   - others   → useGlobalDirectory().openDirectory(tab, initial*Id)
 *
 * Layout sits absolutely under the input the parent gives via `anchorRef`.
 * Closes on outside click, Escape, or any result selection.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, Container, Building2, MapPin, FileText, Users, Search as SearchIcon, Loader2 } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useGlobalDirectory } from '@/lib/useGlobalDirectory';
import { railway } from '@/lib/railway';
import type { Load } from '@/lib/types';

/** Minimum chars before we run any search. Shorter queries are noisy. */
const MIN_QUERY = 2;
/** Per-category result cap so a flood of matches doesn't dominate the
 *  dropdown. Users refine the query if they want more. */
const PER_CATEGORY_LIMIT = 5;
/** Debounce for the server `searchLoads` call. In-memory categories
 *  don't need it — they're O(N) on small N. */
const LOAD_DEBOUNCE_MS = 250;

interface Props {
  query: string;
  /** Element under which the dropdown anchors. Read once for the
   *  width — height + offset are CSS-driven. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** "See all results" — routes to the full /search page. */
  onSeeAll?: () => void;
}

export default function GlobalSearchDropdown({ query, anchorRef, onClose, onSeeAll }: Props) {
  const router = useRouter();
  const directory = useGlobalDirectory();
  const { customers, drivers, assets, trailers, savedLocations, unassignedAssetId } = useCalendarStore();

  // ── Server-side load search ────────────────────────────────────────
  const [loads,        setLoads]        = useState<Load[]>([]);
  const [loadsLoading, setLoadsLoading] = useState(false);

  useEffect(() => {
    if (query.trim().length < MIN_QUERY) {
      setLoads([]);
      setLoadsLoading(false);
      return;
    }
    let cancelled = false;
    setLoadsLoading(true);
    const t = setTimeout(() => {
      railway.searchLoads(query.trim(), 20)
        .then(res => {
          if (cancelled) return;
          // The endpoint may return both legs of a relay. Dedupe by
          // loadId so each load surfaces once in the dropdown. For
          // relays we prefer the pickup leg (earlier `start`) so the
          // displayed date is the actual pickup, not the delivery.
          const byKey = new Map<string, Load>();
          for (const l of res.loads ?? []) {
            const key = l.loadId ?? l.id;
            const existing = byKey.get(key);
            if (!existing || new Date(l.start).getTime() < new Date(existing.start).getTime()) {
              byKey.set(key, l);
            }
          }
          // Sort by absolute distance from "now" so the closest load —
          // past or future — surfaces first. A load 2 days out beats
          // one 6 days back, etc. Server already sorted newest first,
          // but for global search "closest in time" is more useful
          // than "newest pickup".
          const now = Date.now();
          const sorted = [...byKey.values()].sort((a, b) => {
            const da = Math.abs(new Date(a.start).getTime() - now);
            const db = Math.abs(new Date(b.start).getTime() - now);
            return da - db;
          });
          setLoads(sorted.slice(0, PER_CATEGORY_LIMIT));
        })
        .catch(err => {
          if (cancelled) return;
          console.error('[GlobalSearch] searchLoads failed:', err);
          setLoads([]);
        })
        .finally(() => { if (!cancelled) setLoadsLoading(false); });
    }, LOAD_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  // ── In-memory category matchers ────────────────────────────────────
  // Case-insensitive substring match across each entity's surface
  // fields. Cheap on the small N (≤ a few hundred per category for
  // the orgs we ship to in MVP). Sort: prefix matches first, then
  // substring, alphabetical tiebreak.
  const q = query.trim().toLowerCase();

  function rankAndCap<T>(items: T[], pickHaystack: (t: T) => string[]): T[] {
    if (!q) return [];
    type Scored = { item: T; score: number; primary: string };
    const scored: Scored[] = [];
    for (const item of items) {
      const fields = pickHaystack(item).map(s => s.toLowerCase()).filter(Boolean);
      if (fields.length === 0) continue;
      let best = -1;
      for (const f of fields) {
        if (f === q)              { best = Math.max(best, 4); continue; }
        if (f.startsWith(q))      { best = Math.max(best, 3); continue; }
        if (f.includes(' ' + q))  { best = Math.max(best, 2); continue; } // word boundary
        if (f.includes(q))        { best = Math.max(best, 1); continue; }
      }
      if (best > 0) scored.push({ item, score: best, primary: fields[0] });
    }
    scored.sort((a, b) => b.score - a.score || a.primary.localeCompare(b.primary));
    return scored.slice(0, PER_CATEGORY_LIMIT).map(s => s.item);
  }

  const matchedCustomers = useMemo(() => rankAndCap(customers, (c) => [
    c.name,
    ...(c.aliases ?? []),
    c.shortName ?? '',
    c.mcNum ?? '',
  ]), [customers, q]);

  const matchedDrivers = useMemo(() => rankAndCap(drivers, (d) => [
    d.name,
    d.firstName ?? '',
    d.lastName ?? '',
    d.phone ?? '',
    d.email ?? '',
    d.licenseNumber ?? '',
    d.notes ?? '',
  ]), [drivers, q]);

  const matchedTrucks = useMemo(() => rankAndCap(
    assets.filter(a => a.id !== unassignedAssetId),
    (a) => [
      a.name,
      a.unit ?? '',
      a.truck ?? '',
      a.make ?? '',
      a.model ?? '',
      a.vin ?? '',
      a.licensePlate ?? '',
      a.notes ?? '',
    ],
  ), [assets, unassignedAssetId, q]);

  const matchedTrailers = useMemo(() => rankAndCap(trailers, (t) => [
    t.name,
    t.trailerNumber ?? '',
    t.make ?? '',
    t.model ?? '',
    t.vin ?? '',
    t.licensePlate ?? '',
    t.category ?? '',
    t.notes ?? '',
  ]), [trailers, q]);

  const matchedLocations = useMemo(() => rankAndCap(savedLocations, (l) => [
    l.name,
    l.address ?? '',
  ]), [savedLocations, q]);

  // ── Click handlers ─────────────────────────────────────────────────
  const handleClickLoad = (load: Load) => {
    if (load.internalLoadId == null) return;
    onClose();
    router.push(`/loads/${load.internalLoadId}`);
  };
  const handleClickCustomer = (id: string) => {
    onClose();
    directory?.openDirectory({ tab: 'customers', initialBrokerId: id });
  };
  const handleClickDriver = (id: number) => {
    onClose();
    directory?.openDirectory({ tab: 'drivers', initialDriverId: id });
  };
  const handleClickTruck = (id: number) => {
    onClose();
    directory?.openDirectory({ tab: 'trucks', initialAssetId: id });
  };
  const handleClickTrailer = (id: number) => {
    onClose();
    directory?.openDirectory({ tab: 'trailers', initialTrailerId: id });
  };
  const handleClickLocation = (id: string) => {
    onClose();
    directory?.openDirectory({ tab: 'locations', initialLocationId: id });
  };

  // ── Dismiss handlers ───────────────────────────────────────────────
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // clicking the input is not "outside"
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const totalHits =
    loads.length +
    matchedCustomers.length +
    matchedDrivers.length +
    matchedTrucks.length +
    matchedTrailers.length +
    matchedLocations.length;

  const showLoading = loadsLoading && totalHits === 0;
  const showEmpty   = !showLoading && totalHits === 0 && q.length >= MIN_QUERY;

  return (
    <div
      ref={panelRef}
      className="absolute right-0 rounded-xl overflow-hidden"
      style={{
        top: 'calc(100% + 6px)',
        width: 380,
        maxHeight: 480,
        background: 'var(--gc-surface)',
        border: '1px solid var(--gc-border-light)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
      }}>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {showLoading && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm"
            style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" />
            Searching…
          </div>
        )}

        {showEmpty && (
          <div className="px-4 py-6 text-sm text-center"
            style={{ color: 'var(--gc-text-3)' }}>
            No matches.
          </div>
        )}

        <Section title="Loads" icon={FileText} loading={loadsLoading && loads.length === 0}>
          {loads.map(load => (
            <ResultRow key={load.loadId ?? load.id}
              primary={loadPrimary(load)}
              secondary={loadSecondary(load)}
              onClick={() => handleClickLoad(load)} />
          ))}
        </Section>

        <Section title="Customers" icon={Building2}>
          {matchedCustomers.map(c => (
            <ResultRow key={c.id}
              primary={c.name}
              secondary={c.mcNum ? `MC ${c.mcNum}` : (c.aliases?.[0] ?? '')}
              onClick={() => handleClickCustomer(c.id)} />
          ))}
        </Section>

        <Section title="Drivers" icon={Users}>
          {matchedDrivers.map(d => (
            <ResultRow key={d.id}
              primary={d.name}
              secondary={[d.phone, d.licenseNumber && `CDL ${d.licenseNumber}`].filter(Boolean).join(' · ')}
              onClick={() => handleClickDriver(d.id)} />
          ))}
        </Section>

        <Section title="Trucks" icon={Truck}>
          {matchedTrucks.map(a => (
            <ResultRow key={a.id}
              primary={a.name}
              secondary={[a.unit && `#${a.unit}`, [a.make, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
              onClick={() => handleClickTruck(a.id)} />
          ))}
        </Section>

        <Section title="Trailers" icon={Container}>
          {matchedTrailers.map(t => (
            <ResultRow key={t.id}
              primary={t.name}
              secondary={[t.trailerNumber && `#${t.trailerNumber}`, t.category].filter(Boolean).join(' · ')}
              onClick={() => handleClickTrailer(t.id)} />
          ))}
        </Section>

        <Section title="Locations" icon={MapPin}>
          {matchedLocations.map(l => (
            <ResultRow key={l.id}
              primary={l.name}
              secondary={l.address ?? ''}
              onClick={() => handleClickLocation(l.id)} />
          ))}
        </Section>
      </div>

      {!showLoading && q.length >= MIN_QUERY && onSeeAll && (
        <button
          type="button"
          onClick={onSeeAll}
          className="shrink-0 w-full px-3 py-2 flex items-center justify-between gap-1.5 text-[11.5px] font-semibold transition-colors"
          style={{
            borderTop: '1px solid var(--gc-border-light)',
            background: 'var(--gc-bg)',
            color: 'var(--gc-blue)',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-bg)')}>
          <span className="flex items-center gap-1.5">
            <SearchIcon size={11} />
            See all results for &ldquo;{q}&rdquo;
          </span>
          <kbd className="font-mono text-[10px] tabular-nums"
            style={{
              padding: '1px 6px',
              border: '1px solid var(--gc-border-light)',
              borderRadius: 4,
              color: 'var(--gc-text-3)',
              background: 'var(--gc-surface)',
            }}>
            ↵
          </kbd>
        </button>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function Section({ title, icon: Icon, children, loading }: {
  title: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  children: React.ReactNode;
  loading?: boolean;
}) {
  // Only render the section if there's at least one child or it's
  // actively loading (so the user sees "Loads — Searching…" while
  // the server call is in flight).
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  if (!hasChildren && !loading) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-widest"
        style={{ color: 'var(--gc-text-3)' }}>
        <Icon size={11} />
        {title}
        {loading && <Loader2 size={10} className="animate-spin" style={{ marginLeft: 4 }} />}
      </div>
      {hasChildren && (
        <div>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Load row formatters ────────────────────────────────────────────────

/** Primary line for a load row: "#LOAD123 · INT45678" — the broker's
 *  load # plus our internal id, both visible so dispatchers can match
 *  whichever number they have on hand. Falls back gracefully when one
 *  side is missing. */
function loadPrimary(load: Load): string {
  const parts: string[] = [];
  if (load.loadNum)              parts.push(`#${load.loadNum}`);
  if (load.internalLoadId != null) parts.push(String(load.internalLoadId));
  return parts.join(' · ') || '(no #)';
}

/** Secondary line: pickup-date · customer · price. Each segment is
 *  optional; omitted entirely if missing rather than rendering an
 *  empty placeholder. */
function loadSecondary(load: Load): string {
  const date = fmtPickupDate(load.start);
  const price = load.loadPrice != null
    ? `$${load.loadPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';
  return [date, load.broker, price].filter(Boolean).join(' · ');
}

/** "2026-06-08T08:00" → "Jun 8" (this year) or "Jun 8, 2025" (cross-year).
 *  Empty string for unparseable input. */
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

function ResultRow({ primary, secondary, onClick }: {
  primary: string;
  secondary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-2 flex flex-col"
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 6 }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
        {primary || '(unnamed)'}
      </span>
      {secondary && (
        <span className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
          {secondary}
        </span>
      )}
    </button>
  );
}
