'use client';

import CloseoutView from '@/components/closeout/CloseoutView';
import EventModal from '@/components/calendar/EventModal';
import DataLoader from '@/components/DataLoader';

export default function CloseoutPage() {
  return (
    <div className="flex h-full overflow-hidden">
      {/* DataLoader hydrates the calendar store with customers, dispatchers,
          saved locations, etc. Without it a hard refresh of /closeout leaves
          the customers list empty, which breaks the customer-link lookup
          (matchedCustomer never resolves) and the EventModal can't render
          its full reference data. */}
      <DataLoader />
      <CloseoutView />
      <EventModal />
    </div>
  );
}
