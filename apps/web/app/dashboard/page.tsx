'use client';

import DashboardView from '@/components/dashboard/DashboardView';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';

export default function DashboardPage() {
  // See PayrollPage comment — drop the flex wrapper so AppShell can
  // expand to the full viewport.
  return (
    <RequireCap cap="dashboard.access">
      <DashboardView />
      <EventModal />
    </RequireCap>
  );
}
