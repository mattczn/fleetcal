'use client';

import DashboardView from '@/components/dashboard/DashboardView';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';

export default function DashboardPage() {
  return (
    <RequireCap cap="dashboard.access">
      <div className="flex h-full overflow-hidden">
        <DashboardView />
        <EventModal />
      </div>
    </RequireCap>
  );
}
