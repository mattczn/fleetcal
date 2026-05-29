'use client';

import CloseoutView from '@/components/closeout/CloseoutView';
import EventModal from '@/components/calendar/EventModal';
import DataLoader from '@/components/DataLoader';
import RequireCap from '@/components/auth/RequireCap';

export default function CloseoutPage() {
  // CloseoutView owns the AppShell layout. The old flex wrapper made
  // the shell shrink to content width (see PayrollPage for the long
  // version of this).
  return (
    <RequireCap cap="closeout.access" module="closeout">
      {/* DataLoader hydrates the calendar store with customers, dispatchers,
          saved locations, etc. Without it a hard refresh of /closeout leaves
          the customers list empty, which breaks the customer-link lookup
          (matchedCustomer never resolves) and the EventModal can't render
          its full reference data. */}
      <DataLoader />
      <CloseoutView />
      <EventModal />
    </RequireCap>
  );
}
