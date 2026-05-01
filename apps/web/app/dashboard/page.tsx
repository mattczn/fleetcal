'use client';

import DashboardView from '@/components/dashboard/DashboardView';
import EventModal from '@/components/calendar/EventModal';

export default function DashboardPage() {
  return (
    <div className="flex h-full overflow-hidden">
      <DashboardView />
      <EventModal />
    </div>
  );
}
