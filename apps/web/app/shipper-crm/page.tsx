'use client';

/**
 * /shipper-crm — the carrier's own shipper / receiver / warehouse outreach
 * board. Every facility we've hauled to or from, deduped by location and
 * ranked by how often we run there, so the busiest partners sit at the top
 * ready to be called. List on the left, map on the right, and clicking a
 * facility opens a drawer with its loads + a reach-out tracker.
 *
 * Admin-only (shipperCrm.access) and behind the shipper_crm module — see
 * the RequireCap wrapper at the bottom.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Warehouse, Search, MapPin, List as ListIcon, Columns2,
  Loader2, Phone,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import {
  FACILITY_STATUS_LABEL,
  type Facility, type FacilityRole, type FacilityStatus,
} from '@fleetcal/types';
import FacilityMap from './FacilityMap';
import FacilityDetail from './FacilityDetail';

type RoleFilter   = 'all' | 'shipper' | 'receiver';
type StatusFilter = 'all' | 'untouched' | FacilityStatus;
type SortBy       = 'visits' | 'loads' | 'recent' | 'name';
type View         = 'split' | 'list' | 'map';

const SORT_LABEL: Record<SortBy, string> = {
  visits: 'Most visited', loads: 'Most loads', recent: 'Most recent', name: 'A–Z',
};

const ROLE_DOT: Record<FacilityRole, string> = {
  shipper: '#1a73e8', receiver: '#188038', both: '#8430ce', stop: '#80868b',
};

const STATUS_PILL: Record<FacilityStatus, { bg: string; fg: string }> = {
  prospect:       { bg: '#f1f3f4', fg: '#5f6368' },
  contacted:      { bg: '#e8f0fe', fg: '#1558d6' },
  in_talks:       { bg: '#fef7e0', fg: '#b06000' },
  active:         { bg: '#e6f4ea', fg: '#137333' },
  not_now:        { bg: '#f1f3f4', fg: '#80868b' },
  do_not_contact: { bg: '#fce8e6', fg: '#c5221f' },
};

function fmtDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function statusOf(f: Facility): FacilityStatus {
  return f.outreach?.status ?? 'prospect';
}

function ShipperCrmInner() {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [summary, setSummary] = useState<{ facilityCount: number; visitCount: number; pickupFacilities: number; deliveryFacilities: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('visits');
  const [showInternal, setShowInternal] = useState(false);
  const [view, setView] = useState<View>('split');
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await railway.listFacilities();
      setFacilities(res.facilities);
      setSummary(res.summary);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load facilities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const onUpdated = useCallback((f: Facility) => {
    setFacilities((prev) => prev.map((x) => (x.geoKey === f.geoKey ? f : x)));
  }, []);

  const filtered = useMemo(() => {
    let list = facilities.filter((f) => {
      // Internal-looking rows (own yard / relay) hidden by default — unless
      // the user has already engaged one, in which case it stays visible.
      if (f.internalGuess && !showInternal && !f.outreach) return false;
      // A facility the user explicitly hid stays out unless they reopen it
      // via the internal toggle.
      if (f.outreach?.hidden && !showInternal) return false;
      if (role === 'shipper'  && !(f.role === 'shipper'  || f.role === 'both')) return false;
      if (role === 'receiver' && !(f.role === 'receiver' || f.role === 'both')) return false;
      if (statusFilter === 'untouched' && f.outreach) return false;
      if (statusFilter !== 'all' && statusFilter !== 'untouched' && statusOf(f) !== statusFilter) return false;
      if (term) {
        const hay = `${f.name ?? ''} ${f.city ?? ''} ${f.state ?? ''} ${f.address ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sortBy === 'loads')  return b.stats.loadCount - a.stats.loadCount;
      if (sortBy === 'name')   return (a.name ?? 'zzz').localeCompare(b.name ?? 'zzz');
      if (sortBy === 'recent') return (b.stats.lastSeen ?? '').localeCompare(a.stats.lastSeen ?? '');
      return b.stats.visitCount - a.stats.visitCount;
    });
    return list;
  }, [facilities, role, statusFilter, term, sortBy, showInternal]);

  const rightSlot = (
    <div className="flex items-center gap-1 rounded-lg border overflow-hidden" style={{ borderColor: 'var(--gc-border)', height: 32 }}>
      {([['split', Columns2], ['list', ListIcon], ['map', MapPin]] as const).map(([v, Icon]) => (
        <button key={v} onClick={() => setView(v)}
          className="grid place-items-center" style={{
            width: 38, height: '100%',
            background: view === v ? '#1a73e8' : 'transparent',
            color: view === v ? '#fff' : 'var(--gc-text-3)',
          }} title={v === 'split' ? 'List + map' : v === 'list' ? 'List only' : 'Map only'}>
          <Icon size={15} />
        </button>
      ))}
    </div>
  );

  const selectedFacility = selected ? facilities.find((f) => f.geoKey === selected) ?? null : null;
  const showList = view !== 'map';
  const showMap  = view !== 'list';

  return (
    <AppShell title="Shipper CRM" icon={Warehouse} rightSlot={rightSlot} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0" style={{ padding: '16px 20px', gap: 12 }}>

        {/* subtitle */}
        <div style={{ flex: 'none', fontSize: 12.5, color: 'var(--gc-text-3)' }}>
          {summary ? (
            <>
              <b style={{ color: 'var(--gc-text-2)' }}>{summary.facilityCount.toLocaleString()}</b> shippers, receivers &amp; warehouses hauled to or from ·{' '}
              {summary.pickupFacilities.toLocaleString()} ship · {summary.deliveryFacilities.toLocaleString()} receive ·{' '}
              ranked by how often you run there
            </>
          ) : 'Every shipper, receiver & warehouse you\'ve hauled to or from — ranked by how often you run there.'}
        </div>

        {/* toolbar */}
        <div className="flex items-center flex-wrap gap-2" style={{ flex: 'none' }}>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--gc-text-3)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, city, state"
              style={{ height: 34, paddingLeft: 30, paddingRight: 12, width: 230, border: '1px solid var(--gc-border)', borderRadius: 8, fontSize: 12.5, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none' }} />
          </div>

          {/* role segmented */}
          <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--gc-border)', height: 34 }}>
            {([['all', 'All'], ['shipper', 'Shippers'], ['receiver', 'Receivers']] as const).map(([v, label]) => (
              <button key={v} onClick={() => setRole(v)}
                style={{ padding: '0 12px', fontSize: 12, fontWeight: 700, background: role === v ? '#1a73e8' : 'transparent', color: role === v ? '#fff' : 'var(--gc-text-3)' }}>
                {label}
              </button>
            ))}
          </div>

          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            style={selectStyle}>
            <option value="all">Any status</option>
            <option value="untouched">Not contacted</option>
            {(Object.keys(FACILITY_STATUS_LABEL) as FacilityStatus[]).map((v) => (
              <option key={v} value={v}>{FACILITY_STATUS_LABEL[v]}</option>
            ))}
          </select>

          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} style={selectStyle}>
            {(Object.keys(SORT_LABEL) as SortBy[]).map((v) => <option key={v} value={v}>{SORT_LABEL[v]}</option>)}
          </select>

          <label className="flex items-center gap-1.5" style={{ fontSize: 12, fontWeight: 600, color: 'var(--gc-text-3)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} style={{ width: 14, height: 14, cursor: 'pointer' }} />
            Show yards / relays
          </label>

          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-3)' }}>
            {filtered.length.toLocaleString()} shown
          </span>
        </div>

        {err && (
          <div style={{ flex: 'none', borderRadius: 10, background: '#fce8e6', border: '1px solid #f6c9c4', color: '#c5221f', fontSize: 13, padding: 12 }}>{err}</div>
        )}

        {/* body */}
        <div className="flex-1 min-h-0 flex gap-12" style={{ gap: 12 }}>
          {showList && (
            <div className="flex flex-col min-h-0" style={{ flex: view === 'list' ? 1 : 'none', width: view === 'list' ? 'auto' : 440, maxWidth: '100%', background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', borderRadius: 14, overflow: 'hidden' }}>
              {/* list header */}
              <div style={{ display: 'grid', gridTemplateColumns: LIST_GRID, gap: 10, alignItems: 'center', height: 34, padding: '0 14px', flex: 'none', borderBottom: '1px solid var(--gc-border-light)', fontSize: 10.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--gc-text-3)' }}>
                <span>#</span>
                <span>Facility</span>
                <span style={{ textAlign: 'right' }}>Loads</span>
                <span style={{ textAlign: 'right' }}>Last</span>
                <span>Status</span>
              </div>
              {/* list body */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center gap-2" style={{ padding: 20, fontSize: 12.5, color: 'var(--gc-text-3)' }}>
                    <Loader2 size={14} className="animate-spin" /> Loading facilities…
                  </div>
                ) : filtered.length === 0 ? (
                  <div style={{ padding: 20, fontSize: 13, color: 'var(--gc-text-3)' }}>No facilities match these filters.</div>
                ) : filtered.map((f, i) => {
                  const sel = f.geoKey === selected;
                  const stt = statusOf(f);
                  const pill = STATUS_PILL[stt];
                  const touched = !!f.outreach;
                  return (
                    <div key={f.geoKey} onClick={() => setSelected(f.geoKey)}
                      className="cursor-pointer"
                      style={{ display: 'grid', gridTemplateColumns: LIST_GRID, gap: 10, alignItems: 'center', minHeight: 52, padding: '7px 14px', borderBottom: '1px solid #f1f3f4', background: sel ? 'var(--gc-blue-light, #e8f0fe)' : undefined, boxShadow: sel ? 'inset 3px 0 0 #1a73e8' : undefined }}
                      onMouseOver={(e) => { if (!sel) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseOut={(e) => { e.currentTarget.style.background = sel ? 'var(--gc-blue-light, #e8f0fe)' : 'transparent'; }}>
                      <span className="tabular-nums" style={{ fontSize: 12, fontWeight: 700, color: 'var(--gc-text-3)' }}>{i + 1}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span style={{ width: 8, height: 8, borderRadius: 999, background: ROLE_DOT[f.role], flex: 'none' }} />
                          <span className="truncate" style={{ fontSize: 13, fontWeight: 700, color: 'var(--gc-text-1)' }}>
                            {f.name || 'Unnamed facility'}
                          </span>
                        </div>
                        <div className="truncate" style={{ fontSize: 11, color: 'var(--gc-text-3)', marginTop: 1 }}>
                          {[f.city, f.state].filter(Boolean).join(', ') || '—'}
                          {f.stats.visitCount ? ` · ${f.stats.visitCount.toLocaleString()} visits` : ''}
                        </div>
                      </div>
                      <span className="tabular-nums" style={{ textAlign: 'right', fontSize: 15, fontWeight: 800, color: 'var(--gc-text-1)' }}>
                        {f.stats.loadCount.toLocaleString()}
                      </span>
                      <span className="tabular-nums" style={{ textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
                        {fmtDate(f.stats.lastSeen)}
                      </span>
                      <span className="flex items-center gap-1" style={{ minWidth: 0 }}>
                        {touched ? (
                          <span className="truncate" style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: pill.bg, color: pill.fg }}>
                            {FACILITY_STATUS_LABEL[stt]}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--gc-text-3)', fontStyle: 'italic' }}>—</span>
                        )}
                        {f.outreach?.callAttempts ? (
                          <span className="inline-flex items-center gap-0.5" style={{ fontSize: 10, fontWeight: 700, color: 'var(--gc-text-3)' }} title={`${f.outreach.callAttempts} call(s) logged`}>
                            <Phone size={9} />{f.outreach.callAttempts}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showMap && (
            <div className="flex-1 min-h-0">
              <FacilityMap facilities={filtered} selectedGeoKey={selected} onSelect={setSelected} />
            </div>
          )}
        </div>
      </div>

      {selectedFacility && (
        <FacilityDetail
          key={selectedFacility.geoKey}
          facility={selectedFacility}
          onClose={() => setSelected(null)}
          onUpdated={onUpdated}
        />
      )}
    </AppShell>
  );
}

const LIST_GRID = '22px minmax(0,1fr) 52px 48px 96px';

const selectStyle: React.CSSProperties = {
  height: 34, padding: '0 10px', border: '1px solid var(--gc-border)', borderRadius: 8,
  fontSize: 12, fontWeight: 700, color: 'var(--gc-text-2)', background: 'var(--gc-surface)', outline: 'none', cursor: 'pointer',
};

export default function ShipperCrmPage() {
  return (
    <RequireCap cap="shipperCrm.access" module="shipper_crm">
      <ShipperCrmInner />
    </RequireCap>
  );
}
