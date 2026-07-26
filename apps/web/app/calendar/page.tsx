'use client';

import { Suspense } from 'react';
import AssetSidebar from '@/components/sidebar/AssetSidebar';
import CalendarView from '@/components/calendar';
import CalendarSkeleton from '@/components/calendar/CalendarSkeleton';
import WeekView from '@/components/calendar/WeekView';
import CalendarToolbar from '@/components/toolbar/CalendarToolbar';
import EventModal from '@/components/calendar/EventModal';
import BatchNotification from '@/components/calendar/BatchNotification';
import DataLoader from '@/components/DataLoader';
import CalendarDeepLink from '@/components/calendar/CalendarDeepLink';
import EmptyFleetState from '@/components/calendar/EmptyFleetState';
import EldSync from '@/components/EldSync';
import RealtimeSync from '@/components/RealtimeSync';
import { useCalendarStore } from '@/store/useCalendarStore';

// TodaysTray + TodaysTraySkeleton mounts removed 2026-06-05. The
// bottom-of-screen tray was leaving an empty 48px reservation that
// the founder decided isn't earning its space anywhere right now.
// Component files are kept on disk (apps/web/components/tray/) for
// a future reimplementation — to bring it back, re-add the two
// imports + the `{dbReady ? <TodaysTray /> : <TodaysTraySkeleton />}`
// mount and restore `paddingBottom: 48` on the root div so the
// fixed tray header doesn't overlap the grid.

export default function CalendarPage() {
  const { viewMode, dbReady } = useCalendarStore();
  const assets = useCalendarStore(s => s.assets);

  // A brand-new org has nothing to render a grid for. Show the
  // first-truck prompt instead of an empty week of columns — the
  // demo-fleet tour that used to cover this case is gone (see
  // DataLoader). The virtual "Unassigned" column isn't a truck, so an
  // org holding only that one still counts as empty.
  const hasNoTrucks = assets.every(a => a.type === 'Unassigned' || a.name === 'Unassigned');

  // Calendar layout — one left rail (AssetSidebar, which now carries
  // the cross-page nav links at the bottom via PageNavSection) +
  // the grid. AppSidebar isn't mounted here: stacking two rails on
  // the calendar burned too much horizontal room and duplicated the
  // "where am I going" affordance the AssetSidebar's bottom nav now
  // covers natively.
  return (
    <div className="flex h-full overflow-hidden">
      <DataLoader />
      <EldSync />
      <RealtimeSync />
      <AssetSidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <CalendarToolbar />
        {!dbReady
          ? <CalendarSkeleton />
          : hasNoTrucks
            ? <EmptyFleetState />
            : viewMode === 'week' ? <WeekView /> : <CalendarView />}
      </div>
      <EventModal />
      <BatchNotification />
      {/* OnboardingController unmounted 2026-07-26 — it drove the
          demo-fleet tour (TourOverlay → ReadyScreen → SetupWizard) for
          asset-less orgs. Onboarding is a scheduled call now; new orgs
          get EmptyFleetState above instead. Files kept on disk under
          components/onboarding/ — re-add this mount plus the demo
          branch in DataLoader to bring it back. */}
      {/* Opens ?event=…&date=… deep links (Gmail extension "open in
          FleetCal"). Suspense boundary required for useSearchParams. */}
      <Suspense fallback={null}><CalendarDeepLink /></Suspense>
    </div>
  );
}
