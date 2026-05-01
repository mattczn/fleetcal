'use client';

import PayrollView from '@/components/payroll/PayrollView';
import EventModal from '@/components/calendar/EventModal';

export default function PayrollPage() {
  return (
    <div className="flex h-full overflow-hidden">
      <PayrollView />
      <EventModal />
    </div>
  );
}
