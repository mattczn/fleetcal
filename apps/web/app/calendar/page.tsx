'use client';

import AssetSidebar from '@/components/sidebar/AssetSidebar';
import CalendarView from '@/components/calendar';
import CalendarSkeleton from '@/components/calendar/CalendarSkeleton';
import WeekView from '@/components/calendar/WeekView';
import CalendarToolbar from '@/components/toolbar/CalendarToolbar';
import EventModal from '@/components/calendar/EventModal';
import BatchNotification from '@/components/calendar/BatchNotification';
import DataLoader from '@/components/DataLoader';
import OnboardingController from '@/components/onboarding/OnboardingController';
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
        {!dbReady ? <CalendarSkeleton /> : viewMode === 'week' ? <WeekView /> : <CalendarView />}
      </div>
      <EventModal />
      <BatchNotification />
      <OnboardingController />
    </div>
  );
}
