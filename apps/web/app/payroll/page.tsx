'use client';

import PayrollView from '@/components/payroll/PayrollView';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';

export default function PayrollPage() {
  return (
    <RequireCap cap="payroll.access" module="payroll">
      <div className="flex h-full overflow-hidden">
        <PayrollView />
        <EventModal />
      </div>
    </RequireCap>
  );
}
