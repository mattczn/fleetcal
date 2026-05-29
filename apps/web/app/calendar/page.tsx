'use client';

import AppSidebar from '@/components/nav/AppSidebar';
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

  // Calendar now uses the same left-rail nav (AppSidebar) as every
  // other management page; the truck list moved off the left rail
  // and onto the toolbar's new Truck icon (TruckFleetPanel slide-
  // over from the right). One nav system everywhere, with the calendar
  // keeping its own custom top toolbar for view modes + the More menu.
  return (
    <div className="flex h-full overflow-hidden" style={{ paddingBottom: 48 }}>
      <DataLoader />
      <EldSync />
      <RealtimeSync />
      <AppSidebar />
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
