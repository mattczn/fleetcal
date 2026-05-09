'use client';

import CloseoutView from '@/components/closeout/CloseoutView';
import EventModal from '@/components/calendar/EventModal';

export default function CloseoutPage() {
  return (
    <div className="flex h-full overflow-hidden">
      <CloseoutView />
      <EventModal />
    </div>
  );
}
