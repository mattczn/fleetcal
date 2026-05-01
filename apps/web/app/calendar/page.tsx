'use client';

import AssetSidebar from '@/components/sidebar/AssetSidebar';
import CalendarView from '@/components/calendar';
import WeekView from '@/components/calendar/WeekView';
import CalendarToolbar from '@/components/toolbar/CalendarToolbar';
import EventModal from '@/components/calendar/EventModal';
import BatchNotification from '@/components/calendar/BatchNotification';
import DataLoader from '@/components/DataLoader';
import OnboardingController from '@/components/onboarding/OnboardingController';
import AssistantChat from '@/components/AssistantChat';
import TodaysTray from '@/components/tray/TodaysTray';
import EldSync from '@/components/EldSync';
import RealtimeSync from '@/components/RealtimeSync';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function CalendarPage() {
  const { viewMode } = useCalendarStore();

  return (
    <div className="flex h-full overflow-hidden" style={{ paddingBottom: 64 }}>
      <DataLoader />
      <EldSync />
      <RealtimeSync />
      <AssetSidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <CalendarToolbar />
        {viewMode === 'week' ? <WeekView /> : <CalendarView />}
      </div>
      <EventModal />
      <BatchNotification />
      <OnboardingController />
      <AssistantChat />
      <TodaysTray />
    </div>
  );
}
