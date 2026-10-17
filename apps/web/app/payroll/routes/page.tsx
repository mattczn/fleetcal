'use client';

import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';
import PayRoutesView from '@/components/payroll/PayRoutesView';
import EventModal from '@/components/calendar/EventModal';

export default function PayRoutesPage() {
  return (
    <RequireCap cap="payroll.access" module="payroll">
      <DataLoader />
      <PayRoutesView />
      <EventModal />
    </RequireCap>
  );
}
