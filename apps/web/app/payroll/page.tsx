'use client';

import PayrollView from '@/components/payroll/PayrollView';
import EventModal from '@/components/calendar/EventModal';
import RequireCap from '@/components/auth/RequireCap';

export default function PayrollPage() {
  // PayrollView renders the AppShell (sidebar + topbar + body) so it
  // already owns the full layout. The page wrapper used to be a flex
  // row from the old shell-less era; with AppShell that wrapping
  // made the shell shrink to its content width (every flex child
  // sizes to content unless told otherwise). Just rendering the view
  // + the portal modal directly lets AppShell take the viewport.
  return (
    <RequireCap cap="payroll.access" module="payroll">
      <PayrollView />
      <EventModal />
    </RequireCap>
  );
}
