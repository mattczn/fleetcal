'use client';

import BillingView from '@/components/billing/BillingView';
import EventModal from '@/components/calendar/EventModal';

export default function BillingPage() {
  return (
    <div className="flex h-full overflow-hidden">
      <BillingView />
      <EventModal />
    </div>
  );
}
