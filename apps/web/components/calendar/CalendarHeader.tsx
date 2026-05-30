'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin, Loader2, RefreshCw, Truck, Activity } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { GUTTER_W } from '@/lib/time-utils';
import type { MotiveLocation } from '@/app/api/motive/locations/route';
import AssetDetailModal from './AssetDetailModal';
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
  const { assets: allAssets, resourceWidth: rw, activeCategoryFilter, showUnassigned, unassignedAssetId, calendarTimezone, currentDate, viewMode, calendarMode, setCalendarMode, movementsLoading, movementsError, fetchMovements } = useCalendarStore();
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

  const [detailPanel, setDetailPanel] = useState<{ asset: Asset; location: MotiveLocation | null } | null>(null);

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
        {/* Top stack: refresh + movements toggle */}
        <div className="flex flex-col items-end gap-1">
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
          ) : null}

          {hasMotiveAssets && (
            <button
              onClick={() => setCalendarMode(calendarMode === 'loads' ? 'movements' : 'loads')}
              title={calendarMode === 'movements' ? 'Showing Motive movements (click for loads)' : 'Showing loads (click for movements)'}
              className="p-1 rounded-full transition-colors"
              style={{
                color: calendarMode === 'movements' ? 'var(--gc-blue)' : 'var(--gc-text-3)',
                background: calendarMode === 'movements' ? 'var(--gc-blue-light)' : 'transparent',
              }}
              onMouseEnter={e => {
                if (calendarMode !== 'movements') e.currentTarget.style.background = 'var(--gc-hover)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = calendarMode === 'movements' ? 'var(--gc-blue-light)' : 'transparent';
              }}
            >
              {calendarMode === 'movements' && movementsLoading
                ? <Loader2 size={11} className="animate-spin" />
                : <Activity size={11} />
              }
            </button>
          )}
          {/* Movements error indicator — silent failures used to leave
              the calendar blank with no signal. Now a red dot appears
              next to the toggle when the fetch failed and a Retry
              button restarts the fetch without a full page refresh. */}
          {calendarMode === 'movements' && movementsError ? (
            <button
              onClick={() => fetchMovements(viewRange.start, viewRange.end)}
              title={`Movements failed to load: ${movementsError} — click to retry`}
              className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded flex items-center gap-1"
              style={{ background: '#fce8e6', color: '#c5221f' }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#c5221f' }} />
              Retry
            </button>
          ) : null}
        </div>

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
            {/* Icon + name/unit — responsive layout driven by column
                width (rw). At ≥130px we use the original horizontal
                layout (icon on the left, name + unit stacked to the
                right). Below 130px the icon drops above the name so
                the name gets the full column width — even a long
                "Freightliner" stays on one line at typical narrow
                widths. Unit number hides entirely under ~90px since
                neither line fits cleanly below a 5-char name.
                Clickable to open the asset detail modal. */}
            {(() => {
              const isVertical  = rw < 130;
              const showUnit    = rw >= 90;
              const iconSize    = isVertical ? 18 : 28;
              const unitLabel   = asset.unit ? `#${asset.unit}` : asset.type;
              return (
                <button
                  className={
                    isVertical
                      ? "flex flex-col items-center gap-0.5 min-w-0 max-w-full rounded px-1.5 py-1 transition-colors"
                      : "flex items-center gap-2 min-w-0 max-w-full rounded px-1.5 py-1 transition-colors"
                  }
                  onClick={() => setDetailPanel({ asset, location: loc ?? null })}
                  title={`${asset.name}${asset.unit ? ` · #${asset.unit}` : ""} — View location + movement history`}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <Truck size={iconSize} style={{ color: asset.color, flexShrink: 0 }} />
                  <div
                    className={
                      isVertical
                        ? "flex flex-col items-center min-w-0 max-w-full text-center"
                        : "flex flex-col min-w-0 text-left"
                    }
                    style={{ gap: 1 }}
                  >
                    <span
                      className="text-[13px] font-semibold truncate leading-tight"
                      style={{ color: 'var(--gc-text-1)', maxWidth: '100%' }}
                    >
                      {asset.name}
                    </span>
                    {showUnit && (
                      <span
                        className="text-[11px] font-medium truncate leading-tight"
                        style={{ color: 'var(--gc-text-3)', maxWidth: '100%' }}
                      >
                        {unitLabel}
                      </span>
                    )}
                  </div>
                </button>
              );
            })()}

            {loc && age ? (
              <button
                className="flex flex-col items-center w-full rounded transition-colors"
                style={{ gap: 1, marginTop: 3, padding: '2px 4px', background: 'transparent' }}
                title="View location + movement history"
                onClick={() => setDetailPanel({ asset, location: loc })}
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

      {detailPanel && (
        <AssetDetailModal
          asset={detailPanel.asset}
          location={detailPanel.location}
          onClose={() => setDetailPanel(null)}
        />
      )}
    </div>
  );
}
