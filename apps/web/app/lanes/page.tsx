'use client';

import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import PayRoutesView from '@/components/payroll/PayRoutesView';
import EventModal from '@/components/calendar/EventModal';

export default function LanesPage() {
  return (
    <RequireCap cap="loads.view_price">
      <DataLoader />
      <PayRoutesView />
      <EventModal />
    </RequireCap>
  );
}
