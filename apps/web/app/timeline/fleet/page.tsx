'use client';

/**
 * /timeline/fleet — weekly revenue comparison across all trucks.
 *
 * One row per visible asset for the selected week (Sat → Fri).
 * Columns: Revenue, Loads, Miles, Driver Pay, RPM, Margin. Sortable.
 * Bulk re-link button at the top so the dispatcher can refresh
 * load-to-movement attribution across the whole fleet for the
 * selected week in one click before reading the table.
 *
 * Click a truck name → jump to /timeline?assetId=X for that truck's
 * per-day breakdown.
 *
 * DataLoader MUST mount outside RequireCap — see the comment in
 * apps/web/store/useCalendarStore.ts on the orgModules seed (we
 * learned this the hard way).
 */

import { Suspense } from 'react';
import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import FleetWeekView from '@/components/timeline/FleetWeekView';
import EventModal from '@/components/calendar/EventModal';

function FleetWeekPageInner() {
  return (
    <RequireCap cap="loads.view" module="performance">
      <DataLoader />
      <FleetWeekView />
      <EventModal />
    </RequireCap>
  );
}

export default function FleetWeekPage() {
  return (
    <Suspense fallback={null}>
      <FleetWeekPageInner />
    </Suspense>
  );
}
