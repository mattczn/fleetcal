'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, Loader2, RefreshCw, Truck } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { GUTTER_W } from '@/lib/time-utils';
import type { MotiveLocation } from '@/app/api/motive/locations/route';
import VehicleMapPanel from './VehicleMapPanel';
import type { Asset } from '@/lib/types';
import { tzAbbr } from '@/lib/time-utils';
import { isActiveInRange, dateKeyInTz } from '@/lib/lifecycle';

const POLL_MS = 30 * 60_000; // 30 minutes

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours === 1) return '1 hr ago';
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function staleness(locatedAt: string): 'fresh' | 'stale' | 'old' {
  const ageMs = Date.now() - new Date(locatedAt).getTime();
  if (ageMs < 2 * 3600_000) return 'fresh';
  if (ageMs < 8 * 3600_000) return 'stale';
  return 'old';
}

const STALENESS_COLOR = { fresh: '#16a34a', stale: '#b45309', old: '#9ca3af' };

function useMotiveLocations(hasMotiveAssets: boolean) {
  const [locations,    setLocations]    = useState<Record<string, MotiveLocation>>({});
  const [loading,      setLoading]      = useState(false);
  const [lastFetched,  setLastFetched]  = useState<Date | null>(null);
  const [, setTick] = useState(0);

  const fetchFnRef = useRef<(() => Promise<void>) | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startInterval = useCallback((fn: () => Promise<void>) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fn, POLL_MS);
  }, []);

  useEffect(() => {
    if (!hasMotiveAssets) { setLocations({}); setLastFetched(null); return; }

    let cancelled = false;

    const doFetch = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/motive/locations');
        if (!res.ok) return;
        const json = await res.json() as { locations?: MotiveLocation[] };
        if (cancelled) return;
        const map: Record<string, MotiveLocation> = {};
        for (const loc of json.locations ?? []) map[loc.vehicleId] = loc;
        setLocations(map);
        setLastFetched(new Date());
      } catch { /* stale data fine */ }
      finally { if (!cancelled) setLoading(false); }
    };

    fetchFnRef.current = doFetch;
    doFetch();
    startInterval(doFetch);

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [hasMotiveAssets, startInterval]);

  // Tick every 30 s so "X min ago" stays current between fetches
  useEffect(() => {
    if (!lastFetched) return;
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, [lastFetched]);

  const refresh = useCallback(() => {
    if (!fetchFnRef.current) return;
    const fn = fetchFnRef.current;
    fn();
    startInterval(fn);
  }, [startInterval]);

  return { locations, loading, lastFetched, refresh };
}

export default function CalendarHeader() {
  const { assets: allAssets, resourceWidth: rw, activeCategoryFilter, showUnassigned, unassignedAssetId, calendarTimezone, currentDate, viewMode } = useCalendarStore();
  const unassignedAsset = showUnassigned && unassignedAssetId !== null ? allAssets.find(a => a.id === unassignedAssetId) ?? null : null;
  // Date range that matches the calendar grid below — same logic +
  // same org-tz interpretation, so header chips align with columns.
  const viewRange = (() => {
    const todayKey = dateKeyInTz(currentDate, calendarTimezone);
    if (viewMode === 'week') {
      const anchor = new Date(`${todayKey}T12:00:00`);
      const dow = anchor.getDay();
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const mon = new Date(anchor); mon.setDate(anchor.getDate() + mondayOffset);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { start: fmt(mon), end: fmt(sun) };
    }
    return { start: todayKey, end: todayKey };
  })();
  const visibleAssets = [
    ...(unassignedAsset ? [unassignedAsset] : []),
    ...allAssets.filter(a =>
      !a.hidden
      && a.id !== unassignedAssetId
      && (activeCategoryFilter === null || a.type === activeCategoryFilter)
      && isActiveInRange(a, viewRange.start, viewRange.end)
    ),
  ];

  const hasMotiveAssets = visibleAssets.some(a => !!a.motiveVehicleId);
  const { locations, loading, lastFetched, refresh } = useMotiveLocations(hasMotiveAssets);

  const [mapPanel, setMapPanel] = useState<{ asset: Asset; location: MotiveLocation } | null>(null);

  return (
    <div
      data-tour="calendar-header"
      className="sticky top-0 z-20 flex select-none"
      style={{ background: 'var(--gc-surface)', borderBottom: '1px solid var(--gc-border)' }}
    >
      {/* Corner — refresh button + timezone label */}
      <div
        className="sticky left-0 z-30 flex flex-col items-end justify-between px-3 py-2"
        style={{
          width: GUTTER_W,
          minWidth: GUTTER_W,
          background: 'var(--gc-surface)',
          borderRight: '1px solid var(--gc-border-light)',
        }}
      >
        {/* Refresh button — only when Motive is active */}
        {hasMotiveAssets ? (
          <button
            onClick={refresh}
            disabled={loading}
            title="Refresh locations"
            className="p-1 rounded-full transition-colors disabled:opacity-40"
            style={{ color: 'var(--gc-text-3)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-blue)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}
          >
            {loading
              ? <Loader2 size={11} className="animate-spin" />
              : <RefreshCw size={11} />
            }
          </button>
        ) : (
          <div />
        )}

        {/* Timezone label */}
        <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          {tzAbbr(calendarTimezone)}
        </span>
      </div>

      {visibleAssets.map((asset) => {
        const loc = asset.motiveVehicleId ? locations[asset.motiveVehicleId] : undefined;
        const age = loc ? staleness(loc.locatedAt) : null;

        return (
          <div
            key={asset.id}
            className="flex flex-col items-center justify-center px-2 overflow-hidden"
            style={{
              width: rw,
              minWidth: rw,
              paddingTop: 8,
              paddingBottom: loc ? 6 : 8,
              gap: 4,
              borderRight: '1px solid var(--gc-border-light)',
            }}
          >
            {/* Icon + stacked name/unit — centered, icon height matches text block */}
            <div className="flex items-center gap-2 min-w-0 max-w-full">
              <Truck size={28} style={{ color: asset.color, flexShrink: 0 }} />
              <div className="flex flex-col min-w-0" style={{ gap: 1 }}>
                <span
                  className="text-[13px] font-semibold truncate leading-tight"
                  style={{ color: 'var(--gc-text-1)' }}
                >
                  {asset.name}
                </span>
                <span
                  className="text-[11px] font-medium truncate leading-tight"
                  style={{ color: 'var(--gc-text-3)' }}
                >
                  {asset.unit ? `#${asset.unit}` : asset.type}
                </span>
              </div>
              {/* Triage/compress button + SmartAssignDrawer removed
                  for now. Store state (triageMode, smartAssignEventId)
                  + the drawer component are preserved so we can
                  re-enable by uncommenting in CalendarHeader +
                  calendar/index.tsx. */}
            </div>

            {loc && age ? (
              <button
                className="flex flex-col items-center w-full rounded transition-colors"
                style={{ gap: 1, marginTop: 3, padding: '2px 4px', background: 'transparent' }}
                title="View on map"
                onClick={() => setMapPanel({ asset, location: loc })}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <div
                  className="flex items-center gap-0.5"
                  style={{ maxWidth: '100%' }}
                >
                  <MapPin size={9} style={{ color: STALENESS_COLOR[age], flexShrink: 0 }} />
                  <span className="text-[10px] font-medium truncate leading-none" style={{ color: STALENESS_COLOR[age] }}>
                    {loc.description}
                  </span>
                </div>
                <span className="text-[9px] leading-none" style={{ color: 'var(--gc-text-3)' }}>
                  {relativeTime(new Date(loc.locatedAt))}
                </span>
              </button>
            ) : asset.motiveVehicleId ? (
              // Reserve space so header height is consistent when Motive IDs exist
              <div style={{ height: 28 }} />
            ) : hasMotiveAssets ? (
              <div className="flex items-center justify-center" style={{ marginTop: 3, height: 28 }}>
                <span className="text-[10px] font-medium leading-none" style={{ color: '#16a34a' }}>
                  No ELD
                </span>
              </div>
            ) : null}
          </div>
        );
      })}

      {mapPanel && (
        <VehicleMapPanel
          asset={mapPanel.asset}
          location={mapPanel.location}
          onClose={() => setMapPanel(null)}
        />
      )}
    </div>
  );
}
