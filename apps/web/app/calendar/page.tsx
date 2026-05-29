'use client';

import AppSidebar from '@/components/nav/AppSidebar';
import AssetSidebar from '@/components/sidebar/AssetSidebar';
import CalendarView from '@/components/calendar';
import CalendarSkeleton from '@/components/calendar/CalendarSkeleton';
import WeekView from '@/components/calendar/WeekView';
import CalendarToolbar from '@/components/toolbar/CalendarToolbar';
import EventModal from '@/components/calendar/EventModal';
import BatchNotification from '@/components/calendar/BatchNotification';
import DataLoader from '@/components/DataLoader';
import OnboardingController from '@/components/onboarding/OnboardingController';
import AssistantChat from '@/components/AssistantChat';
import TodaysTray from '@/components/tray/TodaysTray';
import TodaysTraySkeleton from '@/components/tray/TodaysTraySkeleton';
import EldSync from '@/components/EldSync';
import RealtimeSync from '@/components/RealtimeSync';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function CalendarPage() {
  const { viewMode, dbReady } = useCalendarStore();

  // Calendar layout — two left rails + the grid + optional right tray:
  //   • AppSidebar — primary nav rail (same as every other page). Lets
  //     the user jump to Dashboard / Closeout / Payroll / etc. without
  //     hunting through the More menu.
  //   • AssetSidebar — calendar-specific tools: New Load button, mini
  //     calendar date picker, asset category filter, truck list
  //     (drag-to-reorder), drivers/assets modal launchers. This is the
  //     dispatcher's day-to-day surface.
  //   • TruckFleetPanel (mounted by CalendarToolbar) — optional right
  //     slide-over for truck edit/hide actions when the dispatcher
  //     doesn't want to use the left rail.
  return (
    <div className="flex h-full overflow-hidden" style={{ paddingBottom: 48 }}>
      <DataLoader />
      <EldSync />
      <RealtimeSync />
      <AppSidebar />
      <AssetSidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <CalendarToolbar />
        {!dbReady ? <CalendarSkeleton /> : viewMode === 'week' ? <WeekView /> : <CalendarView />}
      </div>
      <EventModal />
      <BatchNotification />
      <OnboardingController />
      <AssistantChat />
      {dbReady ? <TodaysTray /> : <TodaysTraySkeleton />}
    </div>
  );
}
